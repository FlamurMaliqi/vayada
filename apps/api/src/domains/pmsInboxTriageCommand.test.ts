import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { PmsInboxTriagePort } from "./pmsInbox.js";
import {
  createPgPmsInboxTriagePort,
  type PmsInboxTriageCommandClient,
  type PmsInboxTriageCommandPool,
} from "./pmsInboxTriageCommand.js";

const PROPERTY = "13730000-0000-4000-8000-000000000001";
const THREAD = "13730000-0000-4000-8000-000000000002";
const ORGANIZATION = "13730000-0000-4000-8000-000000000003";
const ACTOR = "13730000-0000-4000-8000-000000000004";
const MEMBERSHIP = "13730000-0000-4000-8000-000000000005";
const IDEMPOTENCY = "13730000-0000-4000-8000-000000000006";
const EVENT = "13730000-0000-4000-8000-000000000007";
const JOB = "13730000-0000-4000-8000-000000000008";
const NOW = new Date("2026-09-03T09:00:00.000Z");
const FOLLOW_UP_AT = "2026-09-03T10:00:00.000Z";

type TriageInput = Parameters<PmsInboxTriagePort["transition"]>[0];
type Call = { text: string; values?: readonly unknown[] };
type FakeOptions = {
  actorScope?: boolean;
  entitlement?: boolean;
  thread?: boolean;
  version?: number;
  attentionState?: "needs_attention" | "follow_up" | "done";
  failAt?: string;
};

class FakeDatabase {
  readonly calls: Call[] = [];
  releases = 0;
  replay: QueryResultRow | null = null;

  constructor(readonly options: FakeOptions = {}) {}

  readonly pool: PmsInboxTriageCommandPool = {
    connect: async () => this.client,
  };

  readonly client: PmsInboxTriageCommandClient = {
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
    if (text.includes("FROM pms.message_threads"))
      return this.options.thread === false
        ? ok([])
        : ok([
            {
              version: this.options.version ?? 4,
              attentionState: this.options.attentionState ?? "needs_attention",
            },
          ]);
    if (text.includes("INSERT INTO platform.domain_events")) return ok([{ id: EVENT }]);
    if (text.includes("INSERT INTO platform.jobs")) return ok([{ id: JOB }]);
    if (text.includes("UPDATE pms.message_threads"))
      return ok([{ version: Number(values![7]) + 1 }]);
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

  count(fragment: string): number {
    return this.calls.filter((call) => call.text.includes(fragment)).length;
  }
}

function ok(rows: QueryResultRow[]) {
  return { rows, rowCount: rows.length };
}

function count(rowCount: number) {
  return { rows: [], rowCount };
}

function command(overrides: Partial<TriageInput> = {}): TriageInput {
  return {
    propertyId: PROPERTY,
    threadId: THREAD,
    organizationId: ORGANIZATION,
    actorUserId: ACTOR,
    actorMembershipId: MEMBERSHIP,
    action: "done",
    idempotencyKey: "opaque-triage-key",
    expectedThreadVersion: 4,
    followUpAt: null,
    audit: {
      requestId: "request-1373",
      correlationId: "correlation-1373",
      requestedAt: NOW.toISOString(),
    },
    ...overrides,
  };
}

function port(database: FakeDatabase, now: () => Date = () => NOW) {
  return createPgPmsInboxTriagePort({ connectionString: "", pool: database.pool, now });
}

describe("PostgreSQL PMS Inbox triage command", () => {
  it.each([
    ["done", "done", null, "pms.inbox.thread.mark_done"],
    ["follow_up", "follow_up", FOLLOW_UP_AT, "pms.inbox.thread.follow_up"],
    ["reopen", "needs_attention", null, "pms.inbox.thread.reopen"],
  ] as const)(
    "persists %s with monotonic version and complete evidence",
    async (action, expectedState, followUpAt, operation) => {
      const database = new FakeDatabase({
        attentionState: action === "reopen" ? "done" : "needs_attention",
      });

      await expect(port(database).transition(command({ action, followUpAt }))).resolves.toEqual({
        ok: true,
        value: {
          propertyId: PROPERTY,
          threadId: THREAD,
          attentionState: expectedState,
          followUpAt,
          threadVersion: 5,
        },
      });

      expect(database.calls[0]?.text).toBe("BEGIN");
      expect(database.calls.at(-1)?.text).toBe("COMMIT");
      expect(database.releases).toBe(1);
      expect(
        database.calls.findIndex((call) => call.text.includes("hotel_catalog.properties")),
      ).toBeLessThan(database.calls.findIndex((call) => call.text.includes("idempotency_keys")));
      expect(database.call("INSERT INTO platform.idempotency_keys").values?.[0]).toBe(operation);
      const update = database.call("UPDATE pms.message_threads");
      expect(update.text).toContain("follow_up_job_id = CASE WHEN $3 = 'follow_up'");
      expect(update.text).toContain("done_reason = CASE WHEN $3 = 'done'");
      expect(update.text).toContain("version = version + 1");
      expect(update.values).toEqual([
        PROPERTY,
        THREAD,
        expectedState,
        followUpAt,
        MEMBERSHIP,
        action === "follow_up" ? JOB : null,
        NOW,
        4,
      ]);
      expect(database.count("INSERT INTO platform.domain_events")).toBe(1);
      expect(database.count("INSERT INTO platform.product_audit_events")).toBe(1);
      expect(database.count("INSERT INTO platform.jobs")).toBe(action === "follow_up" ? 1 : 0);
      if (action === "follow_up") {
        const job = database.call("INSERT INTO platform.jobs");
        expect(job.text).toContain("run_after");
        expect(job.values?.[1]).toBe("pms.inbox.follow-up.release");
        expect(job.values?.[2]).toBe(EVENT);
        expect(job.values?.[3]).toBe(FOLLOW_UP_AT);
      }
      const evidence = database.calls
        .filter((call) =>
          ["idempotency_keys", "domain_events", "jobs", "product_audit_events"].some((table) =>
            call.text.includes(table),
          ),
        )
        .flatMap((call) => call.values ?? [])
        .map(String)
        .join(" ");
      expect(evidence).not.toContain("opaque-triage-key");
    },
  );

  it("replays a follow-up after its due time and rejects changed same-key input", async () => {
    const database = new FakeDatabase();
    let clock = NOW;
    const triage = port(database, () => clock);
    const input = command({ action: "follow_up", followUpAt: FOLLOW_UP_AT });
    const first = await triage.transition(input);
    clock = new Date("2026-09-03T11:00:00.000Z");

    await expect(triage.transition(input)).resolves.toEqual(first);
    expect(database.count("INSERT INTO platform.jobs")).toBe(1);
    expect(database.count("UPDATE pms.message_threads")).toBe(1);
    await expect(
      triage.transition(command({ action: "follow_up", followUpAt: "2026-09-03T12:00:00.000Z" })),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "idempotency_conflict",
        message: "Idempotency key was already used for a different Inbox triage command.",
      },
    });
  });

  it("stores semantic failures without creating transition evidence", async () => {
    for (const [options, input, expected] of [
      [
        {},
        command({ action: "follow_up", followUpAt: NOW.toISOString() }),
        { code: "validation_failed", message: "Follow-up time must be in the future." },
      ],
      [
        { thread: false },
        command(),
        { code: "thread_not_found", message: "Inbox thread was not found." },
      ],
      [
        { version: 7 },
        command(),
        {
          code: "thread_version_conflict",
          message: "The conversation changed. Refresh and try again.",
          currentVersion: 7,
        },
      ],
    ] as const) {
      const database = new FakeDatabase(options);
      await expect(port(database).transition(input)).resolves.toEqual({
        ok: false,
        error: expected,
      });
      expect(database.count("INSERT INTO platform.jobs")).toBe(0);
      expect(database.count("INSERT INTO platform.domain_events")).toBe(0);
      expect(database.count("UPDATE pms.message_threads")).toBe(0);
      expect(database.calls.at(-1)?.text).toBe("COMMIT");
    }
  });

  it("checks actor scope before idempotency and sanitizes transaction failures", async () => {
    for (const options of [{ actorScope: false }, { entitlement: false }]) {
      const database = new FakeDatabase(options);
      await expect(port(database).transition(command())).rejects.toThrow(
        "PMS Inbox triage command failed",
      );
      expect(database.count("idempotency_keys")).toBe(0);
      expect(database.calls.at(-1)?.text).toBe("ROLLBACK");
      expect(database.releases).toBe(1);
    }

    const failed = new FakeDatabase({ failAt: "INSERT INTO platform.product_audit_events" });
    await expect(port(failed).transition(command())).rejects.toThrow(
      "PMS Inbox triage command failed",
    );
    expect(failed.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects malformed commands before opening a transaction", async () => {
    const database = new FakeDatabase();
    const triage = port(database);
    for (const invalid of [
      { propertyId: "not-a-uuid" },
      { threadId: "not-a-uuid" },
      { expectedThreadVersion: 0 },
      { idempotencyKey: " " },
      { action: "done" as const, followUpAt: FOLLOW_UP_AT },
      { action: "follow_up" as const, followUpAt: null },
      { action: "follow_up" as const, followUpAt: "not-an-instant" },
      { audit: { requestId: "r", correlationId: "c", requestedAt: "not-an-instant" } },
    ])
      await expect(triage.transition(command(invalid))).resolves.toEqual({
        ok: false,
        error: { code: "validation_failed", message: "Inbox triage payload is invalid." },
      });
    expect(database.calls).toHaveLength(0);
  });
});
