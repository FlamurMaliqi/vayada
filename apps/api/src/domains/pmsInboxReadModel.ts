import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  PmsInboxAttachment,
  PmsInboxEmailReplyRoute,
  PmsInboxEmailReplyRouteReadPort,
  PmsInboxReadPort,
  PmsInboxReplyRoute,
  PmsInboxThreadSummary,
  PmsInboxTimelineItem,
} from "./pmsInbox.js";
import { resolvePmsInboxEmailReplyRoutes } from "./pmsInboxEmailReplyRoutes.js";
import {
  decodePmsInboxListCursor,
  encodePmsInboxListCursor,
  pmsInboxListFilterFingerprint,
} from "./pmsInboxListCursor.js";
import {
  decodePmsInboxTimelineCursor,
  encodePmsInboxTimelineCursor,
  pmsInboxTimelineFingerprint,
} from "./pmsInboxTimelineCursor.js";

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
  providerActionAvailable: boolean;
};

type TimelineRow = {
  id: string;
  kind: "internal_note" | "message";
  occurredAt: string;
  direction: "inbound" | "outbound" | null;
  senderType: "guest" | "property_user" | "channel" | "system" | null;
  senderName: string | null;
  text: string;
  readAt: Date | string | null;
  deliveryState: "queued" | "retrying" | "sent" | "held" | "failed" | null;
  deliveryChannel: "ota" | "email" | null;
  deliveryReasonCode: string | null;
  providerAcknowledgedAt: Date | string | null;
  authorMembershipId: string | null;
  authorDisplayName: string | null;
};

type AttachmentRow = {
  id: string;
  messageId: string;
  available: boolean;
  mediaId: string | null;
  filename: string | null;
  contentType: string | null;
  size: string | number | null;
};

const ACTIVITY =
  "GREATEST(COALESCE(thread.last_message_at, thread.created_at), COALESCE(thread.last_internal_note_at, thread.created_at))";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const THREAD_COLUMNS = `thread.id::text, thread.version::text, thread.attention_state AS "attentionState",
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
                  AND connection.messaging_app_installed) AS "otaConnectionReady",
        COALESCE((thread.source = 'channex' AND thread.delivery_channel = 'ota'
          AND lower(BTRIM(thread.provider_channel)) IN ('booking.com', 'booking_com', 'bookingcom')
          AND BTRIM(thread.source_thread_id) <> ''), FALSE) AS "providerActionAvailable"`;

const THREAD_FROM = `FROM pms.message_threads thread
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
  ) last_message ON TRUE`;

export function createPgPmsInboxReadPort(config: {
  connectionString: string;
  emailReplyRoutes: PmsInboxEmailReplyRouteReadPort;
  attachmentMediaAccessEnabled: boolean;
  pool?: PmsInboxReadPool;
  max?: number;
}): PmsInboxReadPort {
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
        `SELECT ${THREAD_COLUMNS}
         ${THREAD_FROM}
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

    async getThread(input) {
      if (!UUID.test(input.threadId))
        return {
          ok: false,
          error: { code: "thread_not_found", message: "Inbox thread was not found." },
        };
      const fingerprint = pmsInboxTimelineFingerprint(input.propertyId, input.threadId);
      const cursor = input.before
        ? decodePmsInboxTimelineCursor(input.before, fingerprint)
        : undefined;
      if (input.before && !cursor)
        return {
          ok: false,
          error: { code: "invalid_cursor", message: "Inbox timeline cursor is invalid." },
        };

      const threadResult = await pool.query<ThreadRow>(
        `SELECT ${THREAD_COLUMNS}
         ${THREAD_FROM}
         WHERE thread.property_id = $1::uuid AND thread.id = $3::uuid`,
        [input.propertyId, input.canReadGuestContact, input.threadId],
      );
      const threadRow = threadResult.rows[0];
      if (!threadRow)
        return {
          ok: false,
          error: { code: "thread_not_found", message: "Inbox thread was not found." },
        };

      const values: unknown[] = [input.propertyId, input.threadId];
      const before = cursor
        ? (() => {
            values.push(cursor.occurredAt, cursor.kind, cursor.id);
            return `WHERE ("occurredAtValue" < $3::timestamptz
              OR ("occurredAtValue" = $3::timestamptz AND (kind < $4
                OR (kind = $4 AND id < $5::uuid))))`;
          })()
        : "";
      values.push(input.messageLimit + 1);
      const timelineResult = await pool.query<TimelineRow>(
        `WITH timeline AS (
           SELECT message.id, 'message'::text AS kind, message.sent_at AS "occurredAtValue",
                  message.direction, message.sender_type AS "senderType",
                  COALESCE(NULLIF(BTRIM(message.sender_display_name), ''),
                           NULLIF(BTRIM(sender.name), ''), sender.email) AS "senderName",
                  message.body AS text, message.read_at AS "readAt",
                  COALESCE(message.delivery_state,
                    CASE WHEN message.direction = 'outbound'
                                AND timeline_thread.source IN ('channex', 'migration')
                      THEN 'sent' END) AS "deliveryState",
                  COALESCE(message.delivery_channel,
                    CASE WHEN message.direction = 'outbound'
                                AND timeline_thread.source IN ('channex', 'migration')
                      THEN timeline_thread.delivery_channel END) AS "deliveryChannel",
                  message.delivery_reason_code AS "deliveryReasonCode",
                  message.latest_provider_receipt_at AS "providerAcknowledgedAt",
                  NULL::uuid AS "authorMembershipId", NULL::text AS "authorDisplayName"
           FROM pms.messages message
           JOIN pms.message_threads timeline_thread
             ON timeline_thread.id = message.thread_id
            AND timeline_thread.property_id = message.property_id
           LEFT JOIN identity.users sender ON sender.id = message.sender_user_id
           WHERE message.property_id = $1::uuid AND message.thread_id = $2::uuid
           UNION ALL
           SELECT note.id, 'internal_note'::text, note.created_at,
                  NULL::text, NULL::text, NULL::text, note.body, NULL::timestamptz,
                  NULL::text, NULL::text, NULL::text, NULL::timestamptz,
                  note.author_membership_id, note.author_display_name
           FROM pms.message_internal_notes note
           WHERE note.property_id = $1::uuid AND note.thread_id = $2::uuid
         )
         SELECT id::text, kind,
                to_char("occurredAtValue" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
                direction, "senderType", "senderName", text, "readAt", "deliveryState",
                "deliveryChannel", "deliveryReasonCode", "providerAcknowledgedAt",
                "authorMembershipId"::text, "authorDisplayName"
         FROM timeline ${before}
         ORDER BY "occurredAtValue" DESC, kind DESC, id DESC LIMIT $${values.length}`,
        values,
      );
      const rows = timelineResult.rows.slice(0, input.messageLimit);
      const oldestRow = rows.at(-1);
      const messageIds = rows.filter((row) => row.kind === "message").map((row) => row.id);
      const attachments = messageIds.length
        ? await readAttachments(
            pool,
            input.propertyId,
            input.threadId,
            messageIds,
            config.attachmentMediaAccessEnabled,
          )
        : new Map<string, PmsInboxAttachment[]>();
      const emailRoutes = await resolvePmsInboxEmailReplyRoutes(
        config.emailReplyRoutes,
        input.propertyId,
        threadRow.deliveryChannel === "email"
          ? [{ threadId: threadRow.id, guestEmail: threadRow.replyEmail }]
          : [],
      );

      return {
        ok: true,
        value: {
          propertyId: input.propertyId,
          thread: toSummary(threadRow, emailRoutes.get(threadRow.id)),
          availableProviderActions:
            threadRow.providerActionAvailable && threadRow.otaConnectionReady
              ? (["booking_com_no_reply_needed"] as const)
              : [],
          timeline: [...rows].reverse().map((row) => ({
            propertyId: input.propertyId,
            threadId: input.threadId,
            item: toTimelineItem(row, attachments.get(row.id) ?? []),
          })),
          previousCursor:
            timelineResult.rows.length > input.messageLimit && oldestRow
              ? encodePmsInboxTimelineCursor(fingerprint, oldestRow)
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

async function readAttachments(
  pool: PmsInboxReadPool,
  propertyId: string,
  threadId: string,
  messageIds: readonly string[],
  accessEnabled: boolean,
): Promise<Map<string, PmsInboxAttachment[]>> {
  const result = await pool.query<AttachmentRow>(
    `SELECT attachment.id::text, attachment.message_id::text AS "messageId",
            (media.id IS NOT NULL
              AND COALESCE(NULLIF(BTRIM(attachment.filename), ''), media.original_filename) IS NOT NULL
              AND COALESCE(NULLIF(BTRIM(attachment.content_type), ''), media.content_type) IS NOT NULL
              AND COALESCE(attachment.size_bytes::bigint, media.size_bytes)
                    BETWEEN 0 AND 9007199254740991) AS available,
            media.id::text AS "mediaId",
            COALESCE(NULLIF(BTRIM(attachment.filename), ''), media.original_filename) AS filename,
            COALESCE(NULLIF(BTRIM(attachment.content_type), ''), media.content_type) AS "contentType",
            COALESCE(attachment.size_bytes::bigint, media.size_bytes)::text AS size
     FROM pms.message_attachments attachment
     JOIN pms.messages message
       ON message.id = attachment.message_id AND message.property_id = attachment.property_id
     LEFT JOIN platform.media_objects media
       ON media.id = attachment.platform_media_object_id
      AND media.property_id = attachment.property_id
      AND media.visibility = 'private' AND media.purpose = 'pms.messaging.attachment'
      AND media.resource_product = 'pms'
      AND ((media.resource_type = 'message_thread' AND media.resource_id = message.thread_id::text)
        OR (media.resource_type = 'message_attachment' AND media.resource_id = attachment.id::text))
      AND media.lifecycle_status = 'active' AND media.storage_kind = 'vayada_managed'
      AND media.storage_key LIKE 'private/%' AND media.deleted_at IS NULL
     WHERE attachment.property_id = $1::uuid AND message.thread_id = $2::uuid
       AND attachment.message_id = ANY($3::uuid[])
     ORDER BY attachment.created_at, attachment.id`,
    [propertyId, threadId, messageIds],
  );
  const byMessage = new Map<string, PmsInboxAttachment[]>();
  for (const row of result.rows) {
    const size = row.size === null ? null : Number(row.size);
    const attachment: PmsInboxAttachment =
      accessEnabled &&
      row.available &&
      row.mediaId &&
      row.filename &&
      row.contentType &&
      Number.isSafeInteger(size)
        ? {
            id: row.id,
            availability: "available",
            mediaId: row.mediaId,
            filename: row.filename,
            contentType: row.contentType,
            size: size!,
            accessPath: `/api/media/pms/properties/${propertyId}/messaging/threads/${threadId}/attachments/${row.id}`,
          }
        : {
            id: row.id,
            availability: "unavailable",
            mediaId: null,
            filename: row.filename,
            contentType: row.contentType,
            size: Number.isSafeInteger(size) ? size : null,
            accessPath: null,
          };
    byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), attachment]);
  }
  return byMessage;
}

function toTimelineItem(row: TimelineRow, attachments: PmsInboxAttachment[]): PmsInboxTimelineItem {
  if (row.kind === "internal_note")
    return {
      kind: "internal_note",
      note: {
        id: row.id,
        author: {
          membershipId: required(row.authorMembershipId),
          displayName: required(row.authorDisplayName),
        },
        text: row.text,
        occurredAt: instant(row.occurredAt)!,
      },
    };
  return {
    kind: "message",
    message: {
      id: row.id,
      direction: required(row.direction),
      sender: { type: required(row.senderType), name: row.senderName },
      text: row.text || null,
      occurredAt: instant(row.occurredAt)!,
      readAt: instant(row.readAt),
      attachments,
      delivery:
        row.direction === "inbound"
          ? null
          : {
              state: required(row.deliveryState),
              channel: row.deliveryChannel,
              reasonCode: row.deliveryReasonCode,
              providerAcknowledgedAt: instant(row.providerAcknowledgedAt),
            },
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

function required<T extends string>(value: T | null): T {
  if (!value) throw new Error("Incomplete PMS Inbox read model row");
  return value;
}
