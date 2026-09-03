import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createPgPmsInboxMarkReadPort,
  type PmsInboxMarkReadCommandClient,
  type PmsInboxMarkReadCommandPool,
} from "./pmsInboxMarkReadCommand.js";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const THREAD = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION = "33333333-3333-4333-8333-333333333333";
const ACTOR = "44444444-4444-4444-8444-444444444444";
const MEMBERSHIP = "55555555-5555-4555-8555-555555555555";
const BOUNDARY = "66666666-6666-4666-8666-666666666666";
const IDEMPOTENCY = "77777777-7777-4777-8777-777777777777";
const EVENT = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-09-03T09:00:00.000Z");

type Call = { text: string; values?: readonly unknown[] };
type FakeOptions = {
  actorScope?: boolean;
  entitlement?: boolean;
  thread?: boolean;
  boundary?: boolean;
  markedReadCount?: number;
  unreadCount?: number;
  failAt?: string;
};

class FakeDatabase {
  readonly calls: Call[] = [];
  releases = 0;
  replay: QueryResultRow | null = null;

  constructor(readonly options: FakeOptions = {}) {}

  readonly pool: PmsInboxMarkReadCommandPool = {
    connect: async () => this.client,
  };

  readonly client: PmsInboxMarkReadCommandClient = {
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
      return this.options.actorScope === false ? ok([]) : ok([{ "?column?": 1 }]);
    if (text.includes("FROM identity.product_entitlements"))
      return this.options.entitlement === false
        ? ok([])
        : ok([{ status: "active", startsAt: null, expiresAt: null }]);
    if (text.includes("FROM platform.idempotency_keys"))
      return this.replay ? ok([this.replay]) : ok([]);
    if (text.includes("INSERT INTO platform.idempotency_keys"))
      return this.replay ? ok([]) : ok([{ id: IDEMPOTENCY }]);
    if (text.includes("FROM pms.message_threads thread"))
      return this.options.thread === false
        ? ok([])
        : ok([
            {
              boundaryExists: this.options.boundary !== false,
              candidateMessageIds: this.options.boundary === false ? [] : [BOUNDARY],
            },
          ]);
    if (text.includes("SELECT 1 FROM pms.message_threads")) return ok([{ "?column?": 1 }]);
    if (text.includes("UPDATE pms.messages")) return count(this.options.markedReadCount ?? 2);
    if (text.includes("UPDATE pms.message_threads thread"))
      return ok([{ unreadCount: String(this.options.unreadCount ?? 1) }]);
    if (text.includes("INSERT INTO platform.domain_events")) return ok([{ id: EVENT }]);
    if (text.includes("INSERT INTO platform.product_audit_events")) return ok([]);
    if (text.includes("UPDATE platform.idempotency_keys")) {
      this.replay = {
        status: "completed",
        requestFingerprintHash: String(
          this.call("INSERT INTO platform.idempotency_keys").values![2],
        ),
        responseStatusCode: Number(values![1]),
        responseBodyHash: String(values![2]),
        idempotencyMetadata: { result: JSON.parse(String(values![7])) },
      };
      return count(1);
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

function count(rowCount: number) {
  return { rows: [], rowCount };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    propertyId: PROPERTY,
    threadId: THREAD,
    organizationId: ORGANIZATION,
    actorUserId: ACTOR,
    actorMembershipId: MEMBERSHIP,
    idempotencyKey: "opaque-read-key",
    readThroughMessageId: BOUNDARY,
    audit: {
      requestId: "request-123",
      correlationId: "correlation-123",
      requestedAt: NOW.toISOString(),
    },
    ...overrides,
  };
}

function port(database: FakeDatabase) {
  return createPgPmsInboxMarkReadPort({
    connectionString: "",
    pool: database.pool,
    now: () => NOW,
  });
}

describe("PostgreSQL PMS Inbox mark-read command", () => {
  it("marks only the property-scoped inbound message boundary and records evidence", async () => {
    const database = new FakeDatabase();

    await expect(port(database).markRead(command())).resolves.toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        readThroughMessageId: BOUNDARY,
        unreadCount: 1,
      },
    });

    expect(database.calls[0]?.text).toBe("BEGIN");
    expect(database.calls.at(-1)?.text).toBe("COMMIT");
    expect(database.releases).toBe(1);
    expect(
      database.calls.findIndex((call) => call.text.includes("hotel_catalog.properties")),
    ).toBeLessThan(database.calls.findIndex((call) => call.text.includes("idempotency_keys")));
    const boundary = database.call("FROM pms.message_threads thread");
    expect(boundary.text).toContain(
      "message.property_id = thread.property_id AND message.thread_id = thread.id",
    );
    expect(boundary.text).toContain("message.id = $3::uuid AND message.direction = 'inbound'");
    expect(boundary.text).toContain("array_agg(candidate.id ORDER BY candidate.sent_at");
    expect(boundary.values).toEqual([PROPERTY, THREAD, BOUNDARY]);
    const update = database.call("UPDATE pms.messages");
    expect(update.text).toContain("direction = 'inbound' AND read_at IS NULL");
    expect(update.text).toContain("id = ANY($3::uuid[])");
    expect(update.values).toEqual([PROPERTY, THREAD, [BOUNDARY], NOW]);
    expect(database.call("UPDATE pms.message_threads thread").text).toContain(
      "direction = 'inbound' AND read_at IS NULL",
    );
    expect(database.call("INSERT INTO platform.domain_events").text).toContain(
      "pms.inbox.thread.marked_read",
    );
    expect(database.call("INSERT INTO platform.product_audit_events").text).toContain(
      "pms.inbox.thread.mark_read",
    );
    const evidence = database.calls
      .filter((call) =>
        ["idempotency_keys", "domain_events", "product_audit_events"].some((table) =>
          call.text.includes(table),
        ),
      )
      .flatMap((call) => call.values ?? [])
      .map(String)
      .join(" ");
    expect(evidence).not.toContain("opaque-read-key");
  });

  it("replays one result and rejects reuse with a different boundary", async () => {
    const database = new FakeDatabase();
    const read = port(database);
    const first = await read.markRead(command());
    const messageUpdates = () =>
      database.calls.filter((call) => call.text.includes("UPDATE pms.messages"));

    await expect(read.markRead(command())).resolves.toEqual(first);
    expect(messageUpdates()).toHaveLength(1);
    await expect(
      read.markRead(command({ readThroughMessageId: "99999999-9999-4999-8999-999999999999" })),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "idempotency_conflict",
        message: "Idempotency key was already used for a different mark-read command.",
      },
    });
    expect(messageUpdates()).toHaveLength(1);
  });

  it("stores missing-thread and invalid-boundary results without changing unread state", async () => {
    for (const [options, expected] of [
      [{ thread: false }, { code: "thread_not_found", message: "Inbox thread was not found." }],
      [
        { boundary: false },
        {
          code: "validation_failed",
          message: "Read-through message must be an inbound message in this thread.",
        },
      ],
    ] as const) {
      const database = new FakeDatabase(options);
      await expect(port(database).markRead(command())).resolves.toEqual({
        ok: false,
        error: expected,
      });
      expect(database.calls.some((call) => call.text.includes("UPDATE pms.messages"))).toBe(false);
      expect(database.calls.some((call) => call.text.includes("domain_events"))).toBe(false);
      expect(database.calls.at(-1)?.text).toBe("COMMIT");
    }
  });

  it("checks active actor scope before idempotency and sanitizes transaction failures", async () => {
    for (const options of [{ actorScope: false }, { entitlement: false }]) {
      const database = new FakeDatabase(options);
      await expect(port(database).markRead(command())).rejects.toThrow(
        "PMS Inbox mark-read command failed",
      );
      expect(database.calls.some((call) => call.text.includes("idempotency_keys"))).toBe(false);
      expect(database.calls.at(-1)?.text).toBe("ROLLBACK");
      expect(database.releases).toBe(1);
    }

    const failed = new FakeDatabase({ failAt: "INSERT INTO platform.domain_events" });
    await expect(port(failed).markRead(command())).rejects.toThrow(
      "PMS Inbox mark-read command failed",
    );
    expect(failed.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects malformed commands before opening a transaction", async () => {
    const database = new FakeDatabase();
    const read = port(database);
    for (const invalid of [
      { propertyId: "not-a-uuid" },
      { threadId: "not-a-uuid" },
      { readThroughMessageId: "not-a-uuid" },
      { idempotencyKey: " " },
      { audit: { requestId: "r", correlationId: "c", requestedAt: "not-an-instant" } },
    ])
      await expect(read.markRead(command(invalid))).resolves.toEqual({
        ok: false,
        error: { code: "validation_failed", message: "Mark-read payload is invalid." },
      });
    expect(database.calls).toHaveLength(0);
  });
});
