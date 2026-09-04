import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPgPmsInboxReadPort, type PmsInboxReadPool } from "./pmsInboxReadModel.js";
import {
  decodePmsInboxTimelineCursor,
  encodePmsInboxTimelineCursor,
  pmsInboxTimelineFingerprint,
} from "./pmsInboxTimelineCursor.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const THREAD = "33333333-3333-4333-8333-333333333333";
const MESSAGE = "55555555-5555-4555-8555-555555555555";
const NOTE = "66666666-6666-4666-8666-666666666666";
const MEDIA = "77777777-7777-4777-8777-777777777777";

const thread = {
  id: THREAD,
  version: "4",
  attentionState: "needs_attention",
  followUpAt: null,
  assignedMembershipId: null,
  assignedDisplayName: null,
  deliveryChannel: "ota",
  providerChannel: "booking.com",
  guestDisplayName: "Ada Lovelace",
  guestEmail: null,
  guestPhone: null,
  replyEmail: "ada@example.com",
  conversationContextState: "unlinked",
  bookingId: null,
  bookingReference: null,
  sourceReference: "provider-thread",
  inquiryArrivalDate: null,
  inquiryDepartureDate: null,
  unreadCount: 1,
  activityAt: "2026-09-02T08:00:00.000300Z",
  lastMessagePreview: "Sent",
  lastMessageAt: new Date("2026-09-02T08:00:00.000Z"),
  lastMessageHasAttachments: true,
  otaConnectionReady: true,
  providerActionAvailable: true,
} as const;

const timeline = [
  {
    id: MESSAGE,
    kind: "message",
    occurredAt: "2026-09-02T08:00:00.000300Z",
    direction: "outbound",
    senderType: "property_user",
    senderName: "Front Desk",
    text: "Sent",
    readAt: null,
    deliveryState: "sent",
    deliveryChannel: "ota",
    deliveryReasonCode: null,
    providerAcknowledgedAt: new Date("2026-09-02T08:00:01.000Z"),
    authorMembershipId: null,
    authorDisplayName: null,
  },
  {
    id: NOTE,
    kind: "internal_note",
    occurredAt: "2026-09-02T08:00:00.000200Z",
    direction: null,
    senderType: null,
    senderName: null,
    text: "Prepare late arrival.",
    readAt: null,
    deliveryState: null,
    deliveryChannel: null,
    deliveryReasonCode: null,
    providerAcknowledgedAt: null,
    authorMembershipId: "22222222-2222-4222-8222-222222222222",
    authorDisplayName: "Night Desk",
  },
  {
    id: "88888888-8888-4888-8888-888888888888",
    kind: "message",
    occurredAt: "2026-09-02T08:00:00.000100Z",
    direction: "inbound",
    senderType: "guest",
    senderName: "Ada Lovelace",
    text: "Older",
    readAt: null,
    deliveryState: null,
    deliveryChannel: null,
    deliveryReasonCode: null,
    providerAcknowledgedAt: null,
    authorMembershipId: null,
    authorDisplayName: null,
  },
] as const;

function recordingPool(options: { threadRows?: QueryResultRow[] } = {}) {
  const calls: Array<[string, readonly unknown[] | undefined]> = [];
  const pool: PmsInboxReadPool = {
    async query<T extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
      calls.push([sql, values]);
      const rows = sql.includes("WITH timeline")
        ? timeline
        : sql
              .trimStart()
              .startsWith('SELECT attachment.id::text, attachment.message_id::text AS "messageId"')
          ? [
              {
                id: "99999999-9999-4999-8999-999999999999",
                messageId: MESSAGE,
                available: true,
                mediaId: MEDIA,
                filename: "guide.pdf",
                contentType: "application/pdf",
                size: "2048",
              },
              {
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                messageId: MESSAGE,
                available: false,
                mediaId: null,
                filename: null,
                contentType: null,
                size: null,
              },
            ]
          : (options.threadRows ?? [thread]);
      return { rows: rows as T[], rowCount: rows.length };
    },
  };
  return { pool, calls };
}

function createRead(pool: PmsInboxReadPool, attachmentMediaAccessEnabled = true) {
  return createPgPmsInboxReadPort({
    connectionString: "",
    attachmentMediaAccessEnabled,
    pool,
    emailReplyRoutes: {
      async resolveReplyRoutes() {
        return [];
      },
    },
  });
}

describe("PostgreSQL PMS Inbox thread detail read model", () => {
  it("returns a property-scoped chronological page with safe attachments and cursor", async () => {
    const { pool, calls } = recordingPool();
    const read = createRead(pool);
    const result = await read.getThread({
      propertyId: PROPERTY,
      threadId: THREAD,
      canReadGuestContact: false,
      messageLimit: 2,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        propertyId: PROPERTY,
        thread: { id: THREAD, guest: { displayName: "Ada Lovelace" } },
        availableProviderActions: ["booking_com_no_reply_needed"],
        timeline: [
          { item: { kind: "internal_note", note: { text: "Prepare late arrival." } } },
          {
            item: {
              kind: "message",
              message: {
                id: MESSAGE,
                delivery: { state: "sent", channel: "ota" },
                attachments: [
                  {
                    availability: "available",
                    mediaId: MEDIA,
                    accessPath: `/api/media/pms/properties/${PROPERTY}/messaging/threads/${THREAD}/attachments/99999999-9999-4999-8999-999999999999`,
                  },
                  { availability: "unavailable", mediaId: null, accessPath: null },
                ],
              },
            },
          },
        ],
        previousCursor: expect.any(String),
      },
    });
    expect(JSON.stringify(result)).not.toContain("ada@example.com");
    expect(calls).toHaveLength(3);
    for (const [sql, values] of calls) {
      expect(sql).toContain("property_id");
      expect(values).toContain(PROPERTY);
      expect(sql).not.toContain("source_url");
    }
    expect(calls[1]![0]).toContain('ORDER BY "occurredAtValue" DESC, kind DESC, id DESC');
    expect(calls[1]![0]).toContain("timeline_thread.source IN ('channex', 'migration')");
    expect(calls[1]![0]).toContain(
      'message.latest_provider_receipt_at AS "providerAcknowledgedAt"',
    );
    expect(calls[1]![0]).not.toContain("THEN message.sent_at END");
    expect(calls[2]![0]).toContain("media.resource_id = message.thread_id::text");
    expect(calls[2]![0]).toContain("media.resource_id = attachment.id::text");
    expect(calls[2]![1]).toEqual([PROPERTY, THREAD, [MESSAGE]]);

    if (!result.ok || !result.value.previousCursor) throw new Error("Expected detail cursor");
    const decoded = Buffer.from(result.value.previousCursor, "base64url").toString("utf8");
    expect(decoded).toContain("2026-09-02T08:00:00.000200Z");
    const replay = await read.getThread({
      propertyId: PROPERTY,
      threadId: THREAD,
      canReadGuestContact: false,
      messageLimit: 2,
      before: result.value.previousCursor,
    });
    expect(replay.ok).toBe(true);
    expect(calls[4]![1]).toEqual([
      PROPERTY,
      THREAD,
      "2026-09-02T08:00:00.000200Z",
      "internal_note",
      NOTE,
      3,
    ]);
  });

  it("rejects malformed or cross-thread cursors before reading", async () => {
    const { pool, calls } = recordingPool();
    const read = createRead(pool);
    const first = await read.getThread({
      propertyId: PROPERTY,
      threadId: THREAD,
      canReadGuestContact: true,
      messageLimit: 2,
    });
    if (!first.ok || !first.value.previousCursor) throw new Error("Expected detail cursor");
    const callCount = calls.length;

    for (const before of [first.value.previousCursor, "not-a-cursor"]) {
      await expect(
        read.getThread({
          propertyId: PROPERTY,
          threadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          canReadGuestContact: true,
          messageLimit: 2,
          before,
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: "invalid_cursor", message: "Inbox timeline cursor is invalid." },
      });
    }
    expect(calls).toHaveLength(callCount);
  });

  it("returns not found without querying timeline or email routing", async () => {
    const { pool, calls } = recordingPool({ threadRows: [] });
    const emailCalls: unknown[] = [];
    const read = createPgPmsInboxReadPort({
      connectionString: "",
      attachmentMediaAccessEnabled: true,
      pool,
      emailReplyRoutes: {
        async resolveReplyRoutes(input) {
          emailCalls.push(input);
          return [];
        },
      },
    });
    await expect(
      read.getThread({
        propertyId: PROPERTY,
        threadId: THREAD,
        canReadGuestContact: true,
        messageLimit: 25,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "thread_not_found", message: "Inbox thread was not found." },
    });
    expect(calls).toHaveLength(1);
    await expect(
      read.getThread({
        propertyId: PROPERTY,
        threadId: "opaque-provider-thread-id",
        canReadGuestContact: true,
        messageLimit: 25,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "thread_not_found", message: "Inbox thread was not found." },
    });
    expect(calls).toHaveLength(1);
    expect(emailCalls).toEqual([]);
  });

  it("accepts target-supported UUIDv7 thread and cursor identifiers", async () => {
    const v7Thread = "33333333-3333-7333-8333-333333333333";
    const v7Message = "55555555-5555-7555-8555-555555555555";
    const { pool, calls } = recordingPool();
    const read = createRead(pool);

    await expect(
      read.getThread({
        propertyId: PROPERTY,
        threadId: v7Thread,
        canReadGuestContact: false,
        messageLimit: 2,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(calls[0]![1]).toEqual([PROPERTY, false, v7Thread]);

    const fingerprint = pmsInboxTimelineFingerprint(PROPERTY, v7Thread);
    const cursor = encodePmsInboxTimelineCursor(fingerprint, {
      occurredAt: "2026-09-02T08:00:00.000300Z",
      kind: "message",
      id: v7Message,
    });
    expect(decodePmsInboxTimelineCursor(cursor, fingerprint)).toEqual({
      occurredAt: "2026-09-02T08:00:00.000300Z",
      kind: "message",
      id: v7Message,
    });
  });

  it.each([
    ["2026-09-02T08:00:00Z", "2026-09-02T08:00:00.000000Z"],
    ["2026-09-02T08:00:00.1Z", "2026-09-02T08:00:00.100000Z"],
    ["2026-09-02T08:00:00.123Z", "2026-09-02T08:00:00.123000Z"],
    ["2026-09-02T08:00:00.123456Z", "2026-09-02T08:00:00.123456Z"],
  ])("normalizes timeline cursor timestamp precision from %s", (occurredAt, expected) => {
    const fingerprint = pmsInboxTimelineFingerprint(PROPERTY, THREAD);
    const cursor = encodePmsInboxTimelineCursor(fingerprint, {
      occurredAt,
      kind: "message",
      id: MESSAGE,
    });
    expect(decodePmsInboxTimelineCursor(cursor, fingerprint)?.occurredAt).toBe(expected);
  });

  it("rejects unsupported timeline cursor timestamps before encoding", () => {
    const fingerprint = pmsInboxTimelineFingerprint(PROPERTY, THREAD);
    expect(() =>
      encodePmsInboxTimelineCursor(fingerprint, {
        occurredAt: "2026-09-02T08:00:00.1234567Z",
        kind: "message",
        id: MESSAGE,
      }),
    ).toThrow("PMS Inbox timeline cursor timestamp is invalid");
  });

  it("does not advertise attachment paths when protected media serving is disabled", async () => {
    const { pool } = recordingPool();
    const result = await createRead(pool, false).getThread({
      propertyId: PROPERTY,
      threadId: THREAD,
      canReadGuestContact: false,
      messageLimit: 2,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        timeline: [
          { item: { kind: "internal_note" } },
          {
            item: {
              kind: "message",
              message: {
                attachments: [
                  { availability: "unavailable", mediaId: null, accessPath: null },
                  { availability: "unavailable", mediaId: null, accessPath: null },
                ],
              },
            },
          },
        ],
      },
    });
  });
});
