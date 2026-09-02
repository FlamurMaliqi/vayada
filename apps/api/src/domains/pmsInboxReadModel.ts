import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  PmsInboxEmailReplyRoute,
  PmsInboxEmailReplyRouteReadPort,
  PmsInboxReadPort,
  PmsInboxReplyRoute,
  PmsInboxThreadSummary,
} from "./pmsInbox.js";
import { resolvePmsInboxEmailReplyRoutes } from "./pmsInboxEmailReplyRoutes.js";
import {
  decodePmsInboxListCursor,
  encodePmsInboxListCursor,
  pmsInboxListFilterFingerprint,
} from "./pmsInboxListCursor.js";

export type PmsInboxReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  end?(): Promise<void>;
};

type ThreadRow = {
  id: string;
  version: string;
  attentionState: PmsInboxThreadSummary["attentionState"];
  followUpAt: Date | string | null;
  assignedMembershipId: string | null;
  assignedDisplayName: string | null;
  deliveryChannel: PmsInboxThreadSummary["channel"];
  providerChannel: string | null;
  guestDisplayName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  replyEmail: string | null;
  conversationContextState: PmsInboxThreadSummary["conversationContext"]["state"];
  bookingId: string | null;
  bookingReference: string | null;
  sourceReference: string | null;
  inquiryArrivalDate: string | null;
  inquiryDepartureDate: string | null;
  unreadCount: number;
  activityAt: Date | string;
  lastMessagePreview: string | null;
  lastMessageAt: Date | string | null;
  lastMessageHasAttachments: boolean;
  otaConnectionReady: boolean;
};

export type PmsInboxListReadPort = Pick<PmsInboxReadPort, "listThreads" | "unreadCount" | "close">;

const ACTIVITY =
  "GREATEST(COALESCE(thread.last_message_at, thread.created_at), COALESCE(thread.last_internal_note_at, thread.created_at))";

export function createPgPmsInboxListReadPort(config: {
  connectionString: string;
  emailReplyRoutes: PmsInboxEmailReplyRouteReadPort;
  pool?: PmsInboxReadPool;
  max?: number;
}): PmsInboxListReadPort {
  if (!config.pool && !config.connectionString.trim())
    throw new Error("PMS Inbox read model connectionString must not be empty");
  const ownsPool = !config.pool;
  const pool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async listThreads(input) {
      const fingerprint = pmsInboxListFilterFingerprint(input);
      const cursor = input.cursor ? decodePmsInboxListCursor(input.cursor, fingerprint) : undefined;
      if (input.cursor && !cursor)
        return {
          ok: false,
          error: { code: "invalid_cursor", message: "Inbox cursor does not match its filters." },
        };

      const values: unknown[] = [input.propertyId, input.canReadGuestContact];
      const where = ["thread.property_id = $1::uuid"];
      const add = (condition: string, value: unknown) => {
        values.push(value);
        where.push(condition.replaceAll("?", `$${values.length}`));
      };
      if (input.attentionState) add("thread.attention_state = ?", input.attentionState);
      if (input.unread !== undefined)
        where.push(`thread.unread_count ${input.unread ? ">" : "="} 0`);
      if (input.channel) add("thread.delivery_channel = ?", input.channel);
      if (input.assignee === "unassigned") where.push("thread.assigned_to_membership_id IS NULL");
      else if (input.assignee)
        add(
          "thread.assigned_to_membership_id::text = ?",
          input.assignee === "me" ? input.actorMembershipId : input.assignee,
        );
      if (input.search) {
        add(
          `(position(lower(?) in lower(COALESCE(NULLIF(BTRIM(thread.guest_display_name), ''), guest.display_name, ''))) > 0
            OR position(lower(?) in lower(COALESCE(booking.public_reference, ''))) > 0
            OR position(lower(?) in lower(COALESCE(thread.source_booking_id, thread.source_thread_id, ''))) > 0
            OR EXISTS (SELECT 1 FROM pms.messages message
                       WHERE message.property_id = thread.property_id AND message.thread_id = thread.id
                         AND position(lower(?) in lower(message.body)) > 0)
            OR EXISTS (SELECT 1 FROM pms.message_internal_notes note
                       WHERE note.property_id = thread.property_id AND note.thread_id = thread.id
                         AND position(lower(?) in lower(note.body)) > 0))`,
          input.search,
        );
      }
      if (cursor) {
        values.push(cursor.activityAt, cursor.id);
        const activityAt = `$${values.length - 1}`;
        const id = `$${values.length}`;
        where.push(
          `(${ACTIVITY} < ${activityAt}::timestamptz OR (${ACTIVITY} = ${activityAt}::timestamptz AND thread.id < ${id}::uuid))`,
        );
      }
      values.push(input.limit + 1);

      const result = await pool.query<ThreadRow>(
        `SELECT thread.id::text, thread.version::text, thread.attention_state AS "attentionState",
                thread.follow_up_at AS "followUpAt",
                thread.assigned_to_membership_id::text AS "assignedMembershipId",
                COALESCE(NULLIF(BTRIM(assigned_user.name), ''), assigned_user.email) AS "assignedDisplayName",
                thread.delivery_channel AS "deliveryChannel", thread.provider_channel AS "providerChannel",
                COALESCE(NULLIF(BTRIM(thread.guest_display_name), ''), guest.display_name) AS "guestDisplayName",
                CASE WHEN $2::boolean THEN COALESCE(NULLIF(BTRIM(thread.guest_email), ''), guest.email) END AS "guestEmail",
                CASE WHEN $2::boolean THEN guest.phone END AS "guestPhone",
                COALESCE(NULLIF(BTRIM(thread.guest_email), ''), guest.email) AS "replyEmail",
                thread.conversation_context_state AS "conversationContextState",
                thread.guest_booking_id::text AS "bookingId", booking.public_reference AS "bookingReference",
                COALESCE(thread.source_booking_id, thread.source_thread_id) AS "sourceReference",
                thread.inquiry_arrival_date::text AS "inquiryArrivalDate",
                thread.inquiry_departure_date::text AS "inquiryDepartureDate",
                thread.unread_count AS "unreadCount",
                to_char(${ACTIVITY} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "activityAt",
                thread.last_message_preview AS "lastMessagePreview", thread.last_message_at AS "lastMessageAt",
                COALESCE(last_message.has_attachments, FALSE) AS "lastMessageHasAttachments",
                EXISTS (SELECT 1 FROM pms.channel_connections connection
                        WHERE connection.property_id = thread.property_id AND connection.provider = 'channex'
                          AND connection.connection_status IN ('connected', 'degraded')
                          AND connection.messaging_app_installed) AS "otaConnectionReady"
         FROM pms.message_threads thread
         LEFT JOIN booking.guest_bookings booking
           ON booking.id = thread.guest_booking_id AND booking.property_id = thread.property_id
         LEFT JOIN LATERAL (
           SELECT NULLIF(BTRIM(CONCAT_WS(' ', booking_guest.first_name, booking_guest.last_name)), '') AS display_name,
                  NULLIF(BTRIM(booking_guest.email), '') AS email, NULLIF(BTRIM(booking_guest.phone), '') AS phone
           FROM booking.booking_guests booking_guest WHERE booking_guest.guest_booking_id = booking.id
           ORDER BY CASE booking_guest.guest_role WHEN 'booker' THEN 0 WHEN 'primary_guest' THEN 1 ELSE 2 END,
                    booking_guest.created_at, booking_guest.id LIMIT 1
         ) guest ON TRUE
         LEFT JOIN identity.organization_memberships assigned_membership
           ON assigned_membership.id = thread.assigned_to_membership_id
         LEFT JOIN identity.users assigned_user ON assigned_user.id = assigned_membership.user_id
         LEFT JOIN LATERAL (
           SELECT EXISTS (SELECT 1 FROM pms.message_attachments attachment
                          WHERE attachment.property_id = message.property_id AND attachment.message_id = message.id)
                    AS has_attachments
           FROM pms.messages message
           WHERE message.property_id = thread.property_id AND message.thread_id = thread.id
           ORDER BY message.sent_at DESC, message.id DESC LIMIT 1
         ) last_message ON TRUE
         WHERE ${where.join(" AND ")}
         ORDER BY ${ACTIVITY} DESC, thread.id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = result.rows.slice(0, input.limit);
      const emailRoutes = await resolvePmsInboxEmailReplyRoutes(
        config.emailReplyRoutes,
        input.propertyId,
        rows
          .filter((row) => row.deliveryChannel === "email")
          .map((row) => ({ threadId: row.id, guestEmail: row.replyEmail })),
      );
      return {
        ok: true,
        value: {
          propertyId: input.propertyId,
          items: rows.map((row) => ({
            propertyId: input.propertyId,
            thread: toSummary(row, emailRoutes.get(row.id)),
          })),
          nextCursor:
            result.rows.length > input.limit && rows.at(-1)
              ? encodePmsInboxListCursor(fingerprint, rows.at(-1)!)
              : null,
        },
      };
    },

    async unreadCount(propertyId) {
      const result = await pool.query<{ threadCount: number; messageCount: number }>(
        `SELECT count(*) FILTER (WHERE unread_count > 0)::int AS "threadCount",
                COALESCE(sum(unread_count), 0)::int AS "messageCount"
         FROM pms.message_threads WHERE property_id = $1::uuid`,
        [propertyId],
      );
      const count = result.rows[0];
      if (!count) throw new Error("PMS Inbox unread query returned no row");
      return { propertyId, ...count };
    },

    async close() {
      if (ownsPool) await pool.end?.();
    },
  };
}

function toSummary(row: ThreadRow, emailRoute?: PmsInboxEmailReplyRoute): PmsInboxThreadSummary {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("Invalid Inbox thread version");
  const assignedTo = row.assignedMembershipId
    ? { membershipId: row.assignedMembershipId, displayName: required(row.assignedDisplayName) }
    : null;
  const guest = {
    displayName: row.guestDisplayName,
    ...(row.guestEmail ? { email: row.guestEmail } : {}),
    ...(row.guestPhone ? { phone: row.guestPhone } : {}),
  };
  const conversationContext =
    row.conversationContextState === "linked"
      ? {
          state: "linked" as const,
          bookingId: required(row.bookingId),
          reference: required(row.bookingReference),
        }
      : row.conversationContextState === "inquiry"
        ? {
            state: "inquiry" as const,
            bookingId: null,
            sourceReference: required(row.sourceReference),
            arrivalDate: row.inquiryArrivalDate,
            departureDate: row.inquiryDepartureDate,
          }
        : { state: "unlinked" as const, bookingId: null, sourceReference: row.sourceReference };
  return {
    id: row.id,
    version,
    attentionState: row.attentionState,
    followUpAt: instant(row.followUpAt),
    assignedTo,
    channel: row.deliveryChannel,
    providerChannel: row.providerChannel,
    guest,
    conversationContext,
    unreadCount: row.unreadCount,
    activityAt: instant(row.activityAt)!,
    lastMessage: {
      preview: row.lastMessagePreview,
      at: instant(row.lastMessageAt),
      hasAttachments: row.lastMessageHasAttachments,
    },
    replyRoute: replyRoute(row, emailRoute),
  };
}

function replyRoute(row: ThreadRow, emailRoute?: PmsInboxEmailReplyRoute): PmsInboxReplyRoute {
  if (row.deliveryChannel === "ota") {
    if (!row.providerChannel)
      return {
        state: "held",
        channel: null,
        providerChannel: null,
        reasonCode: "provider_conversation_unavailable",
      };
    return row.otaConnectionReady
      ? { state: "ready", channel: "ota", providerChannel: row.providerChannel, reasonCode: null }
      : {
          state: "held",
          channel: null,
          providerChannel: row.providerChannel,
          reasonCode: "channel_connection_inactive",
        };
  }
  if (!emailRoute) throw new Error("PMS Inbox email reply route is unavailable");
  return emailRoute;
}

function instant(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function required(value: string | null): string {
  if (!value) throw new Error("Incomplete PMS Inbox read model row");
  return value;
}
