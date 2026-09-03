import type { QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createPgPmsInboxReplyPort,
  type PmsInboxReplyCommandClient,
  type PmsInboxReplyCommandPool,
} from "./pmsInboxReplyCommand.js";
import type { PmsInboxEmailReplyRouteReadPort } from "./pmsInbox.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";
const MEDIA = "66666666-6666-4666-8666-666666666666";
const MESSAGE = "77777777-7777-4777-8777-777777777777";
const IDEMPOTENCY = "88888888-8888-4888-8888-888888888888";
const EVENT = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-09-03T09:00:00.000Z");

type Call = { text: string; values?: readonly unknown[] };
type FakeOptions = {
  actorScope?: boolean;
  entitlement?: boolean;
  thread?: Partial<ThreadRow> | null;
  connectionReady?: boolean;
  attachment?: Partial<AttachmentRow> | null;
  failAt?: string;
};

type ThreadRow = {
  version: string;
  source: string;
  sourceThreadId: string;
  deliveryChannel: "ota" | "email";
  providerChannel: string | null;
  guestEmail: string | null;
  attentionState: "needs_attention" | "follow_up" | "done";
};

type AttachmentRow = {
  mediaId: string;
  propertyId: string;
  resourceProduct: string;
  resourceType: string;
  resourceId: string;
  purpose: string;
  visibility: string;
  storageKind: string;
  storageKey: string;
  lifecycleStatus: string;
  contentType: string;
  sizeBytes: string;
  originalFilename: string;
  retainedUntil: string;
  attachmentState: string;
  deletedAt: null;
};

class FakeDatabase {
  readonly calls: Call[] = [];
  releases = 0;
  replay: QueryResultRow | null = null;

  constructor(readonly options: FakeOptions = {}) {}

  readonly pool: PmsInboxReplyCommandPool = {
    connect: async () => this.client,
  };

  readonly client: PmsInboxReplyCommandClient = {
    query: async <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
      this.calls.push({ text, values });
      if (this.options.failAt && text.includes(this.options.failAt))
        throw new Error("database leak");
      return this.result(text, values) as { rows: T[]; rowCount: number };
    },
    release: () => {
      this.releases += 1;
    },
  };

  private result(text: string, values?: readonly unknown[]) {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return ok([]);
    if (text.includes("FROM hotel_catalog.properties property"))
      return this.options.actorScope === false ? ok([]) : ok([{ displayName: "Front Desk" }]);
    if (text.includes("FROM identity.product_entitlements"))
      return this.options.entitlement === false
        ? ok([])
        : ok([{ status: "active", startsAt: null, expiresAt: null }]);
    if (text.includes("FROM platform.idempotency_keys"))
      return this.replay ? ok([this.replay]) : ok([]);
    if (text.includes("INSERT INTO platform.idempotency_keys"))
      return this.replay ? ok([]) : ok([{ id: IDEMPOTENCY }]);
    if (text.includes("FROM pms.message_threads")) {
      if (this.options.thread === null) return ok([]);
      return ok([
        {
          version: "4",
          source: "channex",
          sourceThreadId: "provider-thread",
          deliveryChannel: "ota",
          providerChannel: "booking.com",
          guestEmail: "guest@example.com",
          attentionState: "done",
          ...this.options.thread,
        },
      ]);
    }
    if (text.includes("FROM pms.channel_connections"))
      return this.options.connectionReady === false ? ok([]) : ok([{ "?column?": 1 }]);
    if (text.includes("FROM platform.media_objects") && text.includes("FOR UPDATE")) {
      if (this.options.attachment === null) return ok([]);
      return ok([
        {
          mediaId: MEDIA,
          propertyId: PROPERTY,
          resourceProduct: "pms",
          resourceType: "message_thread",
          resourceId: THREAD,
          purpose: "pms.messaging.attachment",
          visibility: "private",
          storageKind: "vayada_managed",
          storageKey: "private/inbox/file.pdf",
          lifecycleStatus: "staged",
          contentType: "application/pdf",
          sizeBytes: "1024",
          originalFilename: "guest-document.pdf",
          retainedUntil: "2026-09-03T10:00:00.000Z",
          attachmentState: "orphan",
          deletedAt: null,
          ...this.options.attachment,
        },
      ]);
    }
    if (text.includes("INSERT INTO pms.messages")) return ok([{ id: MESSAGE }]);
    if (text.includes("UPDATE pms.message_threads")) return ok([{ version: "5" }]);
    if (text.includes("UPDATE platform.media_objects")) return ok([{}]);
    if (text.includes("INSERT INTO pms.message_attachments")) return ok([{}]);
    if (text.includes("INSERT INTO platform.domain_events")) return ok([{ id: EVENT }]);
    if (text.includes("INSERT INTO platform.product_audit_events")) return ok([{}]);
    if (text.includes("INSERT INTO platform.outbox_events")) return ok([{}]);
    if (text.includes("UPDATE platform.idempotency_keys")) {
      this.replay = {
        id: IDEMPOTENCY,
        status: "completed",
        requestFingerprintHash: String(
          this.call("INSERT INTO platform.idempotency_keys").values![2],
        ),
        responseStatusCode: Number(values![1]),
        responseBodyHash: String(values![2]),
        idempotencyMetadata: { result: JSON.parse(String(values![7])) },
      };
      return ok([{}]);
    }
    throw new Error(`Unhandled SQL: ${text}`);
  }

  call(fragment: string): Call {
    const match = this.calls.find((call) => call.text.includes(fragment));
    if (!match) throw new Error(`Missing SQL call: ${fragment}`);
    return match;
  }
}

function ok(rows: QueryResultRow[]) {
  return { rows, rowCount: rows.length };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: PROPERTY,
    threadId: THREAD,
    organizationId: ORGANIZATION,
    actorUserId: ACTOR,
    actorMembershipId: MEMBERSHIP,
    idempotencyKey: "opaque-reply-key",
    expectedThreadVersion: 4,
    text: "  Your room is ready.  ",
    attachmentMediaIds: [MEDIA],
    audit: {
      requestId: "request-123",
      correlationId: "correlation-123",
      requestedAt: NOW.toISOString(),
    },
    ...overrides,
  };
}

function port(database: FakeDatabase, emailRoute = readyEmail()) {
  const resolveReplyRoutes = vi.fn(
    async ({
      propertyId,
      threads,
    }: Parameters<PmsInboxEmailReplyRouteReadPort["resolveReplyRoutes"]>[0]) =>
      threads.map(({ threadId }) => ({ propertyId, threadId, route: emailRoute })),
  );
  return {
    reply: createPgPmsInboxReplyPort({
      connectionString: "",
      pool: database.pool,
      now: () => NOW,
      emailReplyRoutes: { resolveReplyRoutes },
    }),
    resolveReplyRoutes,
  };
}

function readyEmail() {
  return { state: "ready", channel: "email", providerChannel: null, reasonCode: null } as const;
}

describe("PostgreSQL PMS Inbox manual replies", () => {
  it("atomically accepts, audits, and queues a property-scoped OTA reply", async () => {
    const database = new FakeDatabase();
    const { reply, resolveReplyRoutes } = port(database);

    await expect(reply.reply(command())).resolves.toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        messageId: MESSAGE,
        threadVersion: 5,
        delivery: {
          state: "queued",
          channel: "ota",
          reasonCode: null,
          providerAcknowledgedAt: null,
        },
        acceptedAt: NOW.toISOString(),
      },
    });

    expect(resolveReplyRoutes).not.toHaveBeenCalled();
    expect(database.calls[0]?.text).toBe("BEGIN");
    expect(database.calls.at(-1)?.text).toBe("COMMIT");
    expect(database.releases).toBe(1);
    const threadLookup = database.call("FROM pms.message_threads").text;
    expect(threadLookup).toContain("thread.property_id = $1::uuid AND thread.id = $2::uuid");
    expect(threadLookup).toContain("guest_booking.property_id = thread.property_id");
    expect(threadLookup).toContain("CASE WHEN thread.guest_booking_id IS NOT NULL");
    expect(threadLookup).toContain("THEN current_guest.email");
    expect(threadLookup).toContain("FOR UPDATE OF thread");
    expect(database.call("UPDATE pms.message_threads").text).toContain("version = $3::bigint");
    expect(database.call("FROM platform.media_objects").text).toContain("property_id = $2::uuid");
    expect(database.call("FROM platform.media_objects").text).toContain(
      "resource_id = $3::uuid::text",
    );
    expect(database.call("FROM platform.media_objects").values).toEqual([
      [MEDIA],
      PROPERTY,
      THREAD,
    ]);
    expect(database.call("UPDATE platform.media_objects").text).toContain(
      "resource_id = $5::uuid::text",
    );
    expect(database.call("INSERT INTO pms.messages").values).toEqual(
      expect.arrayContaining([PROPERTY, THREAD, ACTOR, "Front Desk", "Your room is ready."]),
    );
    expect(database.call("INSERT INTO platform.outbox_events").values).toContain(
      `pms.guest-message.deliver:message:${MESSAGE}:manual-send:v1`,
    );
    expect(database.calls.some((call) => call.text.includes("message_delivery_attempts"))).toBe(
      false,
    );

    const evidence = database.calls
      .filter((call) =>
        [
          "platform.idempotency_keys",
          "platform.domain_events",
          "platform.product_audit_events",
          "platform.outbox_events",
        ].some((table) => call.text.includes(table)),
      )
      .flatMap((call) => call.values ?? [])
      .map(String)
      .join(" ");
    expect(evidence).not.toContain("Your room is ready");
    expect(evidence).not.toContain("guest-document.pdf");
    expect(evidence).not.toContain("guest@example.com");
    expect(evidence).not.toContain("opaque-reply-key");
    expect(
      database.calls.filter((call) => call.text.includes("product_audit_events")),
    ).toHaveLength(2);
  });

  it("replays the original result without repeating any mutation", async () => {
    const database = new FakeDatabase({ thread: { attentionState: "needs_attention" } });
    const { reply } = port(database);
    const first = await reply.reply(command({ text: "Hello", attachmentMediaIds: [] }));
    const mutationCount = database.calls.filter((call) => call.text.startsWith("INSERT")).length;

    await expect(reply.reply(command({ text: "Hello", attachmentMediaIds: [] }))).resolves.toEqual(
      first,
    );
    expect(database.calls.filter((call) => call.text.startsWith("INSERT"))).toHaveLength(
      mutationCount,
    );
    expect(
      database.calls.filter((call) => call.text.includes("UPDATE pms.message_threads")),
    ).toHaveLength(1);

    await expect(
      reply.reply(command({ text: "Different", attachmentMediaIds: [] })),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "idempotency_conflict",
        message: "Idempotency key was already used for a different reply.",
      },
    });
    expect(
      database.calls.filter((call) => call.text.includes("UPDATE pms.message_threads")),
    ).toHaveLength(1);
  });

  it("stores stale-version and missing-thread outcomes without creating a send", async () => {
    for (const [options, expected] of [
      [
        { thread: { version: "7" } },
        {
          code: "thread_version_conflict",
          message: "The conversation changed. Refresh and try again.",
          currentVersion: 7,
        },
      ],
      [{ thread: null }, { code: "thread_not_found", message: "Inbox thread was not found." }],
    ] as const) {
      const database = new FakeDatabase(options);
      const { reply } = port(database);
      await expect(reply.reply(command({ attachmentMediaIds: [] }))).resolves.toEqual({
        ok: false,
        error: expected,
      });
      expect(database.calls.some((call) => call.text.includes("INSERT INTO pms.messages"))).toBe(
        false,
      );
      expect(database.calls.some((call) => call.text.includes("platform.outbox_events"))).toBe(
        false,
      );
      expect(database.calls.at(-1)?.text).toBe("COMMIT");
    }
  });

  it("persists a held OTA reply without an outbox row or delivery attempt", async () => {
    const database = new FakeDatabase({ connectionReady: false });
    const { reply } = port(database);

    await expect(reply.reply(command({ attachmentMediaIds: [] }))).resolves.toMatchObject({
      ok: true,
      value: {
        delivery: {
          state: "held",
          channel: null,
          reasonCode: "channel_connection_inactive",
        },
      },
    });
    expect(database.call("INSERT INTO pms.messages").values).toEqual(
      expect.arrayContaining(["held", "channel_connection_inactive"]),
    );
    expect(database.calls.some((call) => call.text.includes("platform.outbox_events"))).toBe(false);
    expect(database.calls.some((call) => call.text.includes("message_delivery_attempts"))).toBe(
      false,
    );
    expect(database.call("INSERT INTO platform.product_audit_events").values).toContain(
      "pms.inbox.reply.held",
    );
  });

  it("uses the exact email projection and fails closed when it is incomplete", async () => {
    const database = new FakeDatabase({
      thread: { source: "manual", deliveryChannel: "email", providerChannel: null },
    });
    const { reply, resolveReplyRoutes } = port(database);
    await expect(reply.reply(command({ attachmentMediaIds: [] }))).resolves.toMatchObject({
      ok: true,
      value: { delivery: { state: "queued", channel: "email" } },
    });
    expect(resolveReplyRoutes).toHaveBeenCalledWith({
      propertyId: PROPERTY,
      threads: [{ threadId: THREAD, guestEmail: "guest@example.com" }],
    });
    expect(database.calls.some((call) => call.text.includes("pms.channel_connections"))).toBe(
      false,
    );

    const broken = new FakeDatabase({
      thread: { source: "manual", deliveryChannel: "email", providerChannel: null },
    });
    const brokenReply = createPgPmsInboxReplyPort({
      connectionString: "",
      pool: broken.pool,
      now: () => NOW,
      emailReplyRoutes: {
        async resolveReplyRoutes() {
          return [];
        },
      },
    });
    await expect(brokenReply.reply(command({ attachmentMediaIds: [] }))).rejects.toThrow(
      "PMS Inbox reply command failed",
    );
    expect(broken.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(broken.releases).toBe(1);
  });

  it("rejects wrong-scope, expired, unsupported, and oversized attachment media", async () => {
    const cases: Array<[Partial<AttachmentRow> | null, string]> = [
      [{ propertyId: ORGANIZATION }, "validation_failed"],
      [{ resourceId: ORGANIZATION }, "validation_failed"],
      [{ lifecycleStatus: "active", attachmentState: "claimed" }, "validation_failed"],
      [{ retainedUntil: NOW.toISOString() }, "validation_failed"],
      [{ contentType: "text/html" }, "unsupported_attachment_type"],
      [{ sizeBytes: String(25 * 1024 * 1024 + 1) }, "attachment_too_large"],
      [null, "validation_failed"],
    ];
    for (const [attachment, code] of cases) {
      const database = new FakeDatabase({ attachment });
      const { reply } = port(database);
      await expect(reply.reply(command())).resolves.toMatchObject({ ok: false, error: { code } });
      expect(database.calls.some((call) => call.text.includes("INSERT INTO pms.messages"))).toBe(
        false,
      );
      expect(
        database.calls.some((call) => call.text.includes("UPDATE platform.media_objects")),
      ).toBe(false);
      expect(database.calls.at(-1)?.text).toBe("COMMIT");
    }
  });

  it("applies the attachment limit for the resolved provider route", async () => {
    const cases = [
      ["booking.com", 8 * 1024 * 1024, true],
      ["booking_com", 8 * 1024 * 1024 + 1, false],
      ["expedia", 10 * 1024 * 1024, true],
      ["expedia.com", 10 * 1024 * 1024 + 1, false],
      ["airbnb", 25 * 1024 * 1024, true],
      ["airbnb", 25 * 1024 * 1024 + 1, false],
    ] as const;

    for (const [providerChannel, sizeBytes, accepted] of cases) {
      const database = new FakeDatabase({
        thread: { providerChannel },
        attachment: { sizeBytes: String(sizeBytes) },
      });
      const result = await port(database).reply.reply(command());
      expect(result.ok).toBe(accepted);
      if (!accepted)
        expect(result).toEqual({
          ok: false,
          error: {
            code: "attachment_too_large",
            message: "One or more attachments are too large.",
          },
        });
    }
  });

  it("checks active actor scope before idempotency and sanitizes transaction failures", async () => {
    const unavailable = new FakeDatabase({ actorScope: false });
    await expect(port(unavailable).reply.reply(command())).rejects.toThrow(
      "PMS Inbox reply command failed",
    );
    expect(unavailable.calls.some((call) => call.text.includes("idempotency_keys"))).toBe(false);
    expect(unavailable.calls.at(-1)?.text).toBe("ROLLBACK");

    const failed = new FakeDatabase({ failAt: "INSERT INTO platform.domain_events" });
    await expect(port(failed).reply.reply(command())).rejects.toThrow(
      "PMS Inbox reply command failed",
    );
    expect(failed.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(failed.releases).toBe(1);
  });

  it("defensively rejects malformed commands before opening a transaction", async () => {
    const database = new FakeDatabase();
    const { reply } = port(database);
    for (const invalid of [
      { propertyId: "not-a-uuid" },
      { expectedThreadVersion: 0 },
      { text: null, attachmentMediaIds: [] },
      { attachmentMediaIds: [MEDIA, MEDIA] },
      { audit: { requestId: "r", correlationId: "c", requestedAt: "not-an-instant" } },
    ])
      await expect(reply.reply(command(invalid))).resolves.toMatchObject({
        ok: false,
        error: { code: "validation_failed" },
      });
    expect(database.calls).toHaveLength(0);
  });
});
