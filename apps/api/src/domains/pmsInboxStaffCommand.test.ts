import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import type { PmsInboxStaffCommandPort } from "./pmsInbox.js";
import {
  createPgPmsInboxStaffCommandPort,
  type PmsInboxStaffCommandClient,
  type PmsInboxStaffCommandPool,
} from "./pmsInboxStaffCommand.js";

const PROPERTY = "13735000-0000-4000-8000-000000000001";
const THREAD = "13735000-0000-4000-8000-000000000002";
const ORGANIZATION = "13735000-0000-4000-8000-000000000003";
const ACTOR = "13735000-0000-4000-8000-000000000004";
const MEMBERSHIP = "13735000-0000-4000-8000-000000000005";
const ASSIGNEE = "13735000-0000-4000-8000-000000000006";
const IDEMPOTENCY = "13735000-0000-4000-8000-000000000007";
const EVENT = "13735000-0000-4000-8000-000000000008";
const NOTE = "13735000-0000-4000-8000-000000000009";
const NOW = new Date("2026-09-03T09:00:00.000Z");

type AssignInput = Parameters<PmsInboxStaffCommandPort["assign"]>[0];
type NoteInput = Parameters<PmsInboxStaffCommandPort["addNote"]>[0];
type Call = { text: string; values?: readonly unknown[] };
type FakeOptions = {
  actorScope?: boolean;
  entitlement?: boolean;
  assignee?: boolean;
  thread?: boolean;
  version?: number;
  failAt?: string;
  commitGate?: Promise<void>;
  onCommitStarted?: () => void;
};

class FakeDatabase {
  readonly calls: Call[] = [];
  releases = 0;
  releasedBeforeCommit = false;
  private commitCompleted = false;

  constructor(readonly options: FakeOptions = {}) {}

  readonly pool: PmsInboxStaffCommandPool = { connect: async () => this.client };
  readonly client: PmsInboxStaffCommandClient = {
    query: async <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
      this.calls.push({ text, values });
      if (this.options.failAt && text.includes(this.options.failAt))
        throw new Error("database leak");
      if (text === "COMMIT" && this.options.commitGate) {
        this.options.onCommitStarted?.();
        await this.options.commitGate;
        this.commitCompleted = true;
      }
      return this.result(text, values) as { rows: T[]; rowCount: number };
    },
    release: () => {
      if (this.options.commitGate && !this.commitCompleted) this.releasedBeforeCommit = true;
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
    if (text.includes("FROM platform.idempotency_keys")) return ok([]);
    if (text.includes("INSERT INTO platform.idempotency_keys")) return ok([{ id: IDEMPOTENCY }]);
    if (text.includes("FROM identity.organization_memberships membership"))
      return this.options.assignee === false
        ? ok([])
        : ok([{ membershipId: ASSIGNEE, displayName: "Night Manager" }]);
    if (text.includes("FROM pms.message_threads"))
      return this.options.thread === false
        ? ok([])
        : ok([{ version: this.options.version ?? 4, assignedToMembershipId: null }]);
    if (text.includes("INSERT INTO pms.message_internal_notes")) return ok([{ id: NOTE }]);
    if (text.includes("UPDATE pms.message_threads"))
      return ok([{ version: Number(values?.at(-1)) + 1 }]);
    if (text.includes("INSERT INTO platform.domain_events")) return ok([{ id: EVENT }]);
    if (text.includes("INSERT INTO platform.product_audit_events")) return ok([]);
    if (text.includes("UPDATE platform.idempotency_keys")) return count(1);
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

function assignment(overrides: Partial<AssignInput> = {}): AssignInput {
  return {
    propertyId: PROPERTY,
    threadId: THREAD,
    organizationId: ORGANIZATION,
    actorUserId: ACTOR,
    actorMembershipId: MEMBERSHIP,
    idempotencyKey: "opaque-assignment-key",
    expectedThreadVersion: 4,
    assigneeMembershipId: ASSIGNEE,
    audit: {
      requestId: "request-staff",
      correlationId: "correlation-staff",
      requestedAt: NOW.toISOString(),
    },
    ...overrides,
  };
}

function note(overrides: Partial<NoteInput> = {}): NoteInput {
  return {
    propertyId: PROPERTY,
    threadId: THREAD,
    organizationId: ORGANIZATION,
    actorUserId: ACTOR,
    actorMembershipId: MEMBERSHIP,
    idempotencyKey: "opaque-note-key",
    expectedThreadVersion: 4,
    text: "  Private guest preference.  ",
    audit: {
      requestId: "request-staff",
      correlationId: "correlation-staff",
      requestedAt: NOW.toISOString(),
    },
    ...overrides,
  };
}

function port(database: FakeDatabase) {
  return createPgPmsInboxStaffCommandPort({
    connectionString: "",
    pool: database.pool,
    now: () => NOW,
  });
}

describe("PostgreSQL PMS Inbox staff commands", () => {
  it("assigns only an eligible property member and records non-content evidence", async () => {
    const database = new FakeDatabase();
    await expect(port(database).assign(assignment())).resolves.toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        assignedTo: { membershipId: ASSIGNEE, displayName: "Night Manager" },
        threadVersion: 5,
      },
    });

    const eligibility = database.call("FROM identity.organization_memberships membership");
    expect(eligibility.text).toContain("assignment.property_id = $1::uuid");
    expect(eligibility.values).toEqual([PROPERTY, ASSIGNEE]);
    expect(database.call("UPDATE pms.message_threads").values).toEqual([
      PROPERTY,
      THREAD,
      ASSIGNEE,
      NOW,
      4,
    ]);
    expect(database.calls.at(-1)?.text).toBe("COMMIT");
    expect(database.releases).toBe(1);
  });

  it("stores the note once while excluding its text and raw key from evidence", async () => {
    const database = new FakeDatabase();
    await expect(port(database).addNote(note())).resolves.toMatchObject({
      ok: true,
      value: {
        note: {
          id: NOTE,
          author: { membershipId: MEMBERSHIP, displayName: "Front Desk" },
          text: "Private guest preference.",
          occurredAt: NOW.toISOString(),
        },
        threadVersion: 5,
      },
    });

    expect(database.call("INSERT INTO pms.message_internal_notes").values).toEqual([
      PROPERTY,
      THREAD,
      MEMBERSHIP,
      "Front Desk",
      "Private guest preference.",
      NOW,
    ]);
    const evidence = database.calls
      .filter((call) =>
        ["idempotency_keys", "domain_events", "product_audit_events"].some((table) =>
          call.text.includes(table),
        ),
      )
      .flatMap((call) => call.values ?? [])
      .map(String)
      .join(" ");
    expect(evidence).not.toContain("Private guest preference.");
    expect(evidence).not.toContain("opaque-note-key");
    expect(database.call("UPDATE platform.idempotency_keys").values?.[7]).toContain(
      '"resultReference"',
    );
  });

  it("keeps the pooled client until commit finishes", async () => {
    let finishCommit!: () => void;
    let reportCommitStarted!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      finishCommit = resolve;
    });
    const commitStarted = new Promise<void>((resolve) => {
      reportCommitStarted = resolve;
    });
    const database = new FakeDatabase({ commitGate, onCommitStarted: reportCommitStarted });

    const result = port(database).addNote(note());
    await commitStarted;
    expect(database.releases).toBe(0);
    finishCommit();
    await expect(result).resolves.toMatchObject({ ok: true });
    expect(database.releasedBeforeCommit).toBe(false);
    expect(database.releases).toBe(1);
  });

  it("stores expected failures before creating event or audit evidence", async () => {
    for (const [database, execute, expected] of [
      [
        new FakeDatabase({ assignee: false }),
        (db: FakeDatabase) => port(db).assign(assignment()),
        "validation_failed",
      ],
      [
        new FakeDatabase({ thread: false }),
        (db: FakeDatabase) => port(db).addNote(note()),
        "thread_not_found",
      ],
      [
        new FakeDatabase({ version: 8 }),
        (db: FakeDatabase) => port(db).assign(assignment()),
        "thread_version_conflict",
      ],
    ] as const) {
      await expect(execute(database)).resolves.toMatchObject({
        ok: false,
        error: { code: expected },
      });
      expect(database.count("INSERT INTO platform.domain_events")).toBe(0);
      expect(database.count("INSERT INTO platform.product_audit_events")).toBe(0);
      expect(database.count("UPDATE pms.message_threads")).toBe(0);
      expect(database.calls.at(-1)?.text).toBe("COMMIT");
    }
  });

  it("checks actor scope before idempotency and sanitizes transaction failures", async () => {
    for (const options of [{ actorScope: false }, { entitlement: false }]) {
      const database = new FakeDatabase(options);
      await expect(port(database).assign(assignment())).rejects.toThrow(
        "PMS Inbox assignment command failed",
      );
      expect(database.count("idempotency_keys")).toBe(0);
      expect(database.calls.at(-1)?.text).toBe("ROLLBACK");
    }
    const failed = new FakeDatabase({ failAt: "INSERT INTO platform.domain_events" });
    await expect(port(failed).addNote(note())).rejects.toThrow(
      "PMS Inbox internal-note command failed",
    );
    expect(failed.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects malformed commands before opening a transaction", async () => {
    const database = new FakeDatabase();
    const commands = port(database);
    for (const invalid of [
      { propertyId: "not-a-uuid" },
      { expectedThreadVersion: 0 },
      { assigneeMembershipId: "not-a-uuid" },
      { idempotencyKey: " " },
    ])
      await expect(commands.assign(assignment(invalid))).resolves.toMatchObject({
        ok: false,
        error: { code: "validation_failed" },
      });
    for (const invalid of [{ text: " " }, { text: "x".repeat(20_001) }])
      await expect(commands.addNote(note(invalid))).resolves.toMatchObject({
        ok: false,
        error: { code: "validation_failed" },
      });
    expect(database.calls).toHaveLength(0);
  });
});
