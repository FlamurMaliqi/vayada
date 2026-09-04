import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPgPmsInboxReadPort, type PmsInboxReadPool } from "./pmsInboxReadModel.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const THREAD = "33333333-3333-4333-8333-333333333333";

const row = {
  id: THREAD,
  version: "4",
  attentionState: "needs_attention",
  followUpAt: null,
  assignedMembershipId: ACTOR,
  assignedDisplayName: "Front Desk",
  deliveryChannel: "ota",
  providerChannel: "booking.com",
  guestDisplayName: "Ada Lovelace",
  guestEmail: "ada@example.com",
  guestPhone: "+123",
  replyEmail: "ada@example.com",
  conversationContextState: "linked",
  bookingId: "44444444-4444-4444-8444-444444444444",
  bookingReference: "VAY-BOOKING",
  sourceReference: "provider-booking",
  inquiryArrivalDate: null,
  inquiryDepartureDate: null,
  inquiryAdults: null,
  inquiryChildren: null,
  linkedCheckIn: "2026-09-10",
  linkedCheckOut: "2026-09-12",
  linkedNights: 2,
  linkedAdults: 2,
  linkedChildren: 0,
  linkedRoomCount: 1,
  linkedRoomName: "Suite",
  linkedRoomNumber: "101",
  linkedStatus: "confirmed",
  unreadCount: 2,
  activityAt: "2026-09-02T08:00:00.000123Z",
  lastMessagePreview: "Can I arrive early?",
  lastMessageAt: new Date("2026-09-02T08:00:00.000Z"),
  lastMessageHasAttachments: true,
  otaConnectionReady: true,
} as const;

function input(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: PROPERTY,
    actorMembershipId: ACTOR,
    canReadGuestContact: true,
    limit: 1,
    ...overrides,
  };
}

function recordingPool(handler: (sql: string) => { rows: QueryResultRow[]; rowCount: number }): {
  pool: PmsInboxReadPool;
  calls: Array<[string, readonly unknown[] | undefined]>;
} {
  const calls: Array<[string, readonly unknown[] | undefined]> = [];
  return {
    calls,
    pool: {
      async query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
        calls.push([sql, values]);
        const result = handler(sql);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      },
    },
  };
}

describe("PostgreSQL PMS Inbox list read model", () => {
  it("maps a property-scoped page and binds filters without exposing search in its cursor", async () => {
    let rows: QueryResultRow[] = [row, { ...row, id: "55555555-5555-4555-8555-555555555555" }];
    const { pool, calls } = recordingPool((sql) =>
      sql.includes("count(*) FILTER")
        ? { rows: [{ threadCount: 2, messageCount: 5 }], rowCount: 1 }
        : { rows, rowCount: rows.length },
    );
    const emailRoute = {
      state: "ready",
      channel: "email",
      providerChannel: null,
      reasonCode: null,
    } as const;
    const read = createPgPmsInboxReadPort({
      connectionString: "",
      attachmentMediaAccessEnabled: true,
      pool,
      emailReplyRoutes: {
        async resolveReplyRoutes({ propertyId, threads }) {
          return threads.map(({ threadId }) => ({ propertyId, threadId, route: emailRoute }));
        },
      },
    });
    const filters = {
      attentionState: "needs_attention",
      unread: true,
      channel: "ota",
      assignee: "me",
      search: "Ada",
    } as const;
    const result = await read.listThreads(input(filters));

    expect(result).toMatchObject({
      ok: true,
      value: {
        propertyId: PROPERTY,
        items: [
          {
            propertyId: PROPERTY,
            thread: {
              id: THREAD,
              version: 4,
              guest: { email: "ada@example.com", phone: "+123" },
              replyRoute: { state: "ready", channel: "ota" },
            },
          },
        ],
        nextCursor: expect.any(String),
      },
    });
    const [sql, values] = calls[0]!;
    expect(sql).toContain("thread.property_id = $1::uuid");
    expect(sql).toContain("thread.assigned_to_membership_id::text");
    expect(sql).toContain("CASE WHEN $2::boolean");
    expect(sql).toContain(
      "COALESCE(NULLIF(BTRIM(thread.guest_display_name), ''), guest.display_name",
    );
    expect(sql).not.toContain("Ada");
    expect(values).toEqual(expect.arrayContaining([PROPERTY, ACTOR, "Ada", 2]));
    const cursor = (result as { ok: true; value: { nextCursor: string } }).value.nextCursor;
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    expect(decoded).toContain(".000123Z");
    expect(decoded).not.toContain("Ada");
    await expect(read.listThreads(input({ ...filters, cursor }))).resolves.toMatchObject({
      ok: true,
    });
    expect(calls[1]![1]).toEqual(expect.arrayContaining(["2026-09-02T08:00:00.000123Z"]));
    const callCount = calls.length;
    await expect(read.listThreads(input({ search: "Grace", cursor }))).resolves.toEqual({
      ok: false,
      error: { code: "invalid_cursor", message: "Inbox cursor does not match its filters." },
    });
    expect(calls).toHaveLength(callCount);
    await expect(read.unreadCount(PROPERTY)).resolves.toEqual({
      propertyId: PROPERTY,
      threadCount: 2,
      messageCount: 5,
    });
    expect(calls.at(-1)![0]).toContain("WHERE property_id = $1::uuid");

    rows = [{ ...row, deliveryChannel: "email", providerChannel: null }];
    await expect(read.listThreads(input({ limit: 25 }))).resolves.toMatchObject({
      ok: true,
      value: { items: [{ thread: { replyRoute: emailRoute } }] },
    });
  });

  it("lists only property-scoped direct bookings eligible for a new Inbox thread", async () => {
    const bookingId = "66666666-6666-4666-8666-666666666666";
    const { pool, calls } = recordingPool((sql) => {
      if (!sql.includes("FROM booking.guest_bookings booking")) {
        throw new Error("Unexpected query");
      }
      return {
        rows: [
          {
            guestBookingId: bookingId,
            bookingReference: "VAY-DIRECT",
            status: "confirmed",
            guestDisplayName: "Grace Hopper",
            checkIn: "2026-10-01",
            checkOut: "2026-10-03",
          },
        ],
        rowCount: 1,
      };
    });
    const read = createPgPmsInboxReadPort({
      connectionString: "",
      attachmentMediaAccessEnabled: true,
      pool,
      emailReplyRoutes: {
        async resolveReplyRoutes() {
          return [];
        },
      },
    });

    await expect(read.listDirectBookings?.(PROPERTY)).resolves.toEqual({
      propertyId: PROPERTY,
      items: [
        {
          propertyId: PROPERTY,
          guestBookingId: bookingId,
          bookingReference: "VAY-DIRECT",
          source: "direct_booking",
          status: "confirmed",
          primaryGuest: { displayName: "Grace Hopper" },
          stay: { checkIn: "2026-10-01", checkOut: "2026-10-03" },
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toContain("booking.property_id = $1::uuid");
    expect(calls[0]?.[0]).toContain("booking.booking_channel = 'direct'");
    expect(calls[0]?.[0]).toContain(
      "booking.lifecycle_status IN ('confirmed', 'canceled', 'completed', 'no_show')",
    );
    expect(calls[0]?.[1]).toEqual([PROPERTY]);
  });
});
