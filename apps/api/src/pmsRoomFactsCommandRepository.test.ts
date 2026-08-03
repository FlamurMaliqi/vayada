import { createHash } from "node:crypto";

import {
  parseDraftRoomId,
  parseRoomTypeFacts,
  serializeCreateRoomTypeFactsFingerprint,
  type CreateRoomTypeFactsCommand,
  type CreateRoomTypeFactsResult,
  type RoomFactsVocabularyValidationPort,
  type RoomTypeFacts,
  type SafeDeleteRoomTypeCommand,
  type UpdateRoomTypeFactsCommand,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  createPgPmsRoomFactsCommandRepository,
  type PmsRoomFactsCommandClient,
  type PmsRoomFactsCommandPool,
} from "./domains/pmsRoomFactsCommandRepository.js";

const organizationId = "f6852000-0000-4000-8000-000000000001";
const propertyId = "f6853000-0000-4000-8000-000000000001";
const actorUserId = "f6851000-0000-4000-8000-000000000001";
const roomTypeId = "f6855000-0000-4000-8000-000000000001";
const createdRoomTypeId = "f6855000-0000-4000-8000-000000000002";
const idempotencyId = "f6859000-0000-4000-8000-000000000001";
const acceptedAt = new Date("2026-08-03T10:00:00.000Z");
const draftRoomId = requiredDraftRoomId("draft-room-1");

const facts = requiredRoomTypeFacts({
  name: "Garden Suite",
  description: "Private garden suite with a courtyard view",
  category: "suite",
  occupancy: { maxGuests: 4, maxAdults: 3, maxChildren: 2 },
  beds: [
    { type: "king", quantity: 1 },
    { type: "sofa_bed", quantity: 1 },
  ],
  bedrooms: 1,
  bathrooms: 1,
  bathroomType: "private",
  size: { value: 42, unit: "sqm" },
});

describe("PMS room facts command repository", () => {
  it("authorizes before idempotency and admits the canonical front_desk relationship", async () => {
    const command = createCommand();
    const stored = nameConflictResult();
    const denied = fakeDatabase({
      authorized: false,
      idempotency: completedIdempotency(command, stored),
    });

    const deniedResult = await createRepository(denied).createRoomTypeFacts(command);

    expect(deniedResult).toEqual({ ok: false, error: { code: "setup_scope_unavailable" } });
    expect(denied.sql()).not.toContain("FROM platform.idempotency_keys");
    expect(denied.sql()).not.toContain("INSERT INTO platform.idempotency_keys");
    expect(denied.sql()).not.toContain("platform.product_audit_events");
    expect(denied.commands).toEqual(["BEGIN", "ROLLBACK"]);

    const admitted = fakeDatabase({ idempotency: completedIdempotency(command, stored) });
    const replay = await createRepository(admitted).createRoomTypeFacts(command);

    expect(replay).toEqual(stored);
    const authorization = admitted.calls.find(({ text }) => text.includes("SELECT property.id"));
    expect(authorization?.text).toContain("'front_desk'");
    expect(admitted.sql().indexOf("SELECT property.id")).toBeLessThan(
      admitted.sql().indexOf("FROM platform.idempotency_keys"),
    );
    expect(admitted.sql()).not.toContain("INSERT INTO platform.idempotency_keys");
    expect(admitted.sql()).not.toContain("platform.product_audit_events");
  });

  it("exactly replays completed results and fails closed for fingerprint, body-hash, and in-progress conflicts", async () => {
    const command = createCommand();
    const stored = nameConflictResult();
    const exact = fakeDatabase({ idempotency: completedIdempotency(command, stored) });
    const changedFingerprint = fakeDatabase({
      idempotency: {
        ...completedIdempotency(command, stored),
        requestFingerprintHash: "0".repeat(64),
      },
    });
    const changedBody = fakeDatabase({
      idempotency: {
        ...completedIdempotency(command, stored),
        responseBodyHash: "f".repeat(64),
      },
    });
    const inProgress = fakeDatabase({
      idempotency: {
        ...completedIdempotency(command, stored),
        status: "in_progress",
        responseStatusCode: null,
        responseBodyHash: null,
        idempotencyMetadata: { attempt: 1 },
      },
    });

    await expect(createRepository(exact).createRoomTypeFacts(command)).resolves.toEqual(stored);
    await expect(
      createRepository(changedFingerprint).createRoomTypeFacts(command),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
    await expect(createRepository(changedBody).createRoomTypeFacts(command)).resolves.toEqual({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });
    await expect(createRepository(inProgress).createRoomTypeFacts(command)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    for (const target of [exact, changedFingerprint, changedBody, inProgress]) {
      expect(target.sql()).not.toContain("INSERT INTO platform.product_audit_events");
      expect(target.sql()).not.toContain("SET status = 'completed'");
      expect(target.commands.at(-1)).toBe("ROLLBACK");
    }
  });

  it("recovers a completed replay or reports in-progress after losing the reservation race", async () => {
    const command = createCommand();
    const stored = nameConflictResult();
    const recovered = fakeDatabase({
      reservationAvailable: false,
      idempotencyReads: [undefined, completedIdempotency(command, stored)],
    });
    const unresolved = fakeDatabase({
      reservationAvailable: false,
      idempotencyReads: [undefined, undefined],
    });

    await expect(createRepository(recovered).createRoomTypeFacts(command)).resolves.toEqual(stored);
    await expect(createRepository(unresolved).createRoomTypeFacts(command)).resolves.toEqual({
      ok: false,
      error: { code: "command_in_progress" },
    });
    for (const target of [recovered, unresolved]) {
      expect(target.sql()).toContain("INSERT INTO platform.idempotency_keys");
      expect(target.sql()).not.toContain("INSERT INTO platform.product_audit_events");
      expect(target.sql()).not.toContain("SET status = 'completed'");
      expect(target.commands.at(-1)).toBe("ROLLBACK");
    }
  });

  it("gives a durable draft binding precedence over vocabulary validation and creation", async () => {
    const target = fakeDatabase({
      binding: { roomTypeId, currentRevision: "7" },
    });
    const vocabularyValidator = allowVocabulary();

    const result = await createRepository(target, vocabularyValidator).createRoomTypeFacts(
      createCommand(),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "draft_room_binding_conflict", roomTypeId, currentRevision: 7 },
    });
    expect(vocabularyValidator.validateRoomFactsVocabulary).not.toHaveBeenCalled();
    expect(target.sql()).not.toContain("lower(name) = lower($2)");
    expect(target.sql()).not.toContain("INSERT INTO pms.room_types");
    expect(target.auditPayload()).toEqual({
      draftRoomId,
      roomTypeId,
      expectedRevision: 0,
      outcome: "draft_room_binding_conflict",
      currentRevision: 7,
    });
    expect(target.didCompleteIdempotency()).toBe(true);
    expect(target.commands.at(-1)).toBe("COMMIT");
  });

  it("validates PMS vocabulary before name checks and completes the deterministic rejection", async () => {
    const target = fakeDatabase();
    const vocabularyValidator: RoomFactsVocabularyValidationPort = {
      validateRoomFactsVocabulary: vi.fn(async ({ category, bedTypeKeys }) => ({
        ok: false as const,
        error: {
          code: "unsupported_room_fact_keys" as const,
          unsupportedCategoryKeys: category ? [category] : [],
          unsupportedBedTypeKeys: bedTypeKeys.slice(1),
        },
      })),
    };

    const result = await createRepository(target, vocabularyValidator).createRoomTypeFacts(
      createCommand(),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "unsupported_room_fact_keys",
        unsupportedCategoryKeys: ["suite"],
        unsupportedBedTypeKeys: ["sofa_bed"],
      },
    });
    expect(vocabularyValidator.validateRoomFactsVocabulary).toHaveBeenCalledWith({
      category: "suite",
      bedTypeKeys: ["king", "sofa_bed"],
    });
    expect(target.sql()).not.toContain("lower(name) = lower($2)");
    expect(target.sql()).not.toContain("INSERT INTO pms.room_types");
    expect(target.didAudit()).toBe(true);
    expect(target.didCompleteIdempotency()).toBe(true);
    expect(target.completionStatus()).toBe(422);
  });

  it("handles create name conflicts and creates facts-only rows at revision one", async () => {
    const conflict = fakeDatabase({ nameConflict: true });
    const created = fakeDatabase();

    await expect(createRepository(conflict).createRoomTypeFacts(createCommand())).resolves.toEqual({
      ok: false,
      error: { code: "room_type_name_conflict" },
    });
    expect(conflict.sql()).not.toContain("INSERT INTO pms.room_types");
    expect(conflict.didAudit()).toBe(true);
    expect(conflict.didCompleteIdempotency()).toBe(true);

    const result = await createRepository(created).createRoomTypeFacts(createCommand());
    expect(result).toMatchObject({
      ok: true,
      response: {
        outcome: "created",
        roomType: {
          roomTypeId: createdRoomTypeId,
          roomFactsRevision: 1,
          lifecycle: "active",
        },
        draftRoomBinding: { propertyId, draftRoomId, roomTypeId: createdRoomTypeId },
      },
    });
    const insert = created.calls.find(({ text }) => text.includes("INSERT INTO pms.room_types"));
    expect(insert?.text).toContain("base_rate_amount");
    expect(insert?.text).toContain("currency");
    expect(normalizeSql(insert?.text ?? "")).toContain("$7::jsonb, NULL, NULL, TRUE");
    expect(insert?.text).not.toContain("pms.rooms");
    expect(insert?.text).not.toContain("rate_plans");
    expect(insert?.text).not.toContain("inventory_days");
  });

  it("checks update revision before vocabulary/name and reports active-name conflicts", async () => {
    const revisionConflict = fakeDatabase({ lockedRoom: roomRow({ roomFactsRevision: 4 }) });
    const revisionVocabulary = allowVocabulary();

    await expect(
      createRepository(revisionConflict, revisionVocabulary).updateRoomTypeFacts(
        updateCommand({ expectedRevision: 3 }),
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "room_facts_revision_conflict", currentRevision: 4 },
    });
    expect(revisionVocabulary.validateRoomFactsVocabulary).not.toHaveBeenCalled();
    expect(revisionConflict.sql()).not.toContain("lower(name) = lower($2)");

    const nameConflict = fakeDatabase({
      lockedRoom: roomRow({ roomFactsRevision: 3 }),
      nameConflict: true,
    });
    await expect(
      createRepository(nameConflict).updateRoomTypeFacts(updateCommand({ expectedRevision: 3 })),
    ).resolves.toEqual({ ok: false, error: { code: "room_type_name_conflict" } });
    expect(nameConflict.sql()).not.toContain("SET name = $4");
    expect(nameConflict.didAudit()).toBe(true);
    expect(nameConflict.didCompleteIdempotency()).toBe(true);
  });

  it("updates only owned fact keys, increments once, and redacts full room facts from audit", async () => {
    const updatedFacts: RoomTypeFacts = { ...facts, name: "Courtyard Suite" };
    const target = fakeDatabase({
      lockedRoom: roomRow({ roomFactsRevision: 3 }),
      updateRow: roomRow({
        roomFactsRevision: 4,
        name: updatedFacts.name,
        updatedAt: acceptedAt.toISOString(),
      }),
    });

    const result = await createRepository(target).updateRoomTypeFacts(
      updateCommand({ expectedRevision: 3, facts: updatedFacts }),
    );

    expect(result).toMatchObject({
      ok: true,
      response: {
        outcome: "updated",
        roomType: { roomFactsRevision: 4, facts: { name: "Courtyard Suite" } },
      },
    });
    const update = target.calls.find(({ text }) => text.includes("SET name = $4"));
    expect(update?.text).toContain("occupancy_limits = occupancy_limits || $7::jsonb");
    expect(update?.text).toContain("room_attributes = room_attributes || $8::jsonb");
    expect(update?.text).toContain("room_facts_revision = room_facts_revision + 1");
    expect(target.auditPayload()).toEqual({
      roomTypeId,
      expectedRevision: 3,
      outcome: "updated",
      resultingRevision: 4,
    });
    const auditCall = target.auditCall();
    expect(JSON.stringify(auditCall?.values)).not.toContain(updatedFacts.description);
    expect(JSON.stringify(auditCall?.values)).not.toContain(updatedFacts.name);
    expect(JSON.stringify(auditCall?.values)).not.toContain("sofa_bed");
    expect(JSON.stringify(auditCall?.values)).not.toContain(updateCommand().idempotencyKey);
    expect(auditCall?.text).toContain("'{}'::jsonb");
  });

  it("rolls back reference-check-unavailable without audit or idempotency completion", async () => {
    const target = fakeDatabase({
      lockedRoom: roomRow({ roomFactsRevision: 2 }),
      inboundForeignKeys: expectedInboundForeignKeys().slice(0, -1),
    });

    const result = await createRepository(target).safeDeleteRoomType(
      safeDeleteCommand({ expectedRevision: 2 }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "room_type_delete_blocked",
        currentRevision: 2,
        blockers: [{ code: "reference_check_unavailable" }],
      },
    });
    expect(target.sql()).not.toContain("LOCK TABLE");
    expect(target.sql()).not.toContain("INSERT INTO platform.product_audit_events");
    expect(target.sql()).not.toContain("SET status = 'completed'");
    expect(target.sql()).not.toContain("active = FALSE");
    expect(target.commands.at(-1)).toBe("ROLLBACK");
    expect(target.commands).not.toContain("COMMIT");
  });

  it("maps database reference-scan failures but surfaces invariant failures", async () => {
    const databaseFailure = Object.assign(new Error("lock not available"), { code: "55P03" });
    const unavailable = fakeDatabase({
      lockedRoom: roomRow({ roomFactsRevision: 2 }),
      deleteReferenceError: databaseFailure,
    });

    await expect(
      createRepository(unavailable).safeDeleteRoomType(safeDeleteCommand({ expectedRevision: 2 })),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "room_type_delete_blocked",
        currentRevision: 2,
        blockers: [{ code: "reference_check_unavailable" }],
      },
    });
    expect(unavailable.sql()).toContain("SET LOCAL lock_timeout = '2s'");
    expect(unavailable.sql()).toContain("SET LOCAL statement_timeout = '5s'");
    expect(unavailable.commands.at(-1)).toBe("ROLLBACK");

    const invariant = fakeDatabase({
      lockedRoom: roomRow({ roomFactsRevision: 2 }),
      deleteReferenceCounts: {
        publishedReferenceCount: "invalid",
        bookingReferenceCount: 0,
        assignedPhysicalUnitCount: 0,
        verifiedPhysicalUnitCount: 0,
        rateReferenceCount: 0,
        calendarReferenceCount: 0,
        roomBlockReferenceCount: 0,
        channelReferenceCount: 0,
        otherOperationalReferenceCount: 0,
      },
    });
    await expect(
      createRepository(invariant).safeDeleteRoomType(safeDeleteCommand({ expectedRevision: 2 })),
    ).rejects.toThrow("database reference count is invalid");
    expect(invariant.commands.at(-1)).toBe("ROLLBACK");
  });

  it("completes and audits deterministic delete blockers in canonical order", async () => {
    const target = fakeDatabase({
      lockedRoom: roomRow({ roomFactsRevision: 2 }),
      deleteReferenceCounts: {
        publishedReferenceCount: "2",
        bookingReferenceCount: "0",
        assignedPhysicalUnitCount: "1",
        verifiedPhysicalUnitCount: "3",
        rateReferenceCount: "4",
        calendarReferenceCount: "0",
        roomBlockReferenceCount: "0",
        channelReferenceCount: "5",
        otherOperationalReferenceCount: "6",
      },
    });

    const result = await createRepository(target).safeDeleteRoomType(
      safeDeleteCommand({ expectedRevision: 2 }),
    );

    const blockers = [
      { code: "published_reference", affectedCount: 2 },
      { code: "assigned_physical_unit", affectedCount: 1 },
      { code: "verified_physical_unit", affectedCount: 3 },
      { code: "rate_plan_or_rule", affectedCount: 4 },
      { code: "channel_mapping", affectedCount: 5 },
      { code: "other_operational_reference", affectedCount: 6 },
    ];
    expect(result).toEqual({
      ok: false,
      error: {
        code: "room_type_delete_blocked",
        currentRevision: 2,
        blockers,
      },
    });
    expect(target.didAudit()).toBe(true);
    expect(target.didCompleteIdempotency()).toBe(true);
    expect(target.completionStatus()).toBe(409);
    expect(target.auditPayload()).toEqual({
      roomTypeId,
      expectedRevision: 2,
      outcome: "room_type_delete_blocked",
      currentRevision: 2,
      blockers,
    });
    const referenceScan = target.calls.find(({ text }) =>
      text.includes('AS "publishedReferenceCount"'),
    );
    expect(target.sql()).toContain("distribution.active_public_booking_revision");
    expect(referenceScan?.text).toContain("publication.status = 'succeeded'");
    expect(referenceScan?.text).toContain("publication.status IN ('pending', 'unknown')");
    expect(referenceScan?.text).toContain("quote.status = 'active'");
    expect(referenceScan?.text).toContain("quote.expires_at > $3::timestamptz");
    expect(referenceScan?.text).toContain("quote.status = 'converted'");
    const lockTables = target.calls.find(({ text }) => /^LOCK TABLE\s/.test(text))?.text;
    expect(lockTables).toBeDefined();
    const lockSql = lockTables ?? "";
    expect(lockSql).toContain("pms.recurring_pricing_source_room_values");
    expect(lockSql).toContain("pms.non_refundable_rate_plan_source_rooms");
    expect(lockSql).toContain("pms.recurring_pricing_materialized_rows");
    expect(lockSql).toContain("IN SHARE ROW EXCLUSIVE MODE");
    expect(lockSql.indexOf("pms.non_refundable_rate_plan_source_rooms")).toBeLessThan(
      lockSql.indexOf("pms.recurring_pricing_materialized_rows"),
    );
    expect(lockSql.indexOf("pms.recurring_pricing_materialized_rows")).toBeLessThan(
      lockSql.indexOf("pms.recurring_pricing_source_room_values"),
    );
    expect(referenceScan?.text).toContain("FROM pms.recurring_pricing_source_room_values");
    expect(referenceScan?.text).toContain("FROM pms.non_refundable_rate_plan_source_rooms");
    expect(referenceScan?.text).toContain("FROM pms.recurring_pricing_materialized_rows");
    expect(referenceScan?.values).toEqual([propertyId, roomTypeId, acceptedAt.toISOString()]);
    expect(target.sql()).not.toContain("active = FALSE");
    expect(target.commands.at(-1)).toBe("COMMIT");
  });
});

type RecordedQuery = { text: string; values: readonly unknown[] };
type IdempotencyRow = {
  id: string;
  status: string;
  requestFingerprintHash: string;
  responseStatusCode: number | null;
  responseBodyHash: string | null;
  idempotencyMetadata: unknown;
  expiresAt: string;
};
type DraftBindingRow = { roomTypeId: string; currentRevision: number | string };
type RoomRow = {
  propertyId: string;
  roomTypeId: string;
  roomFactsRevision: number | string;
  active: boolean;
  name: string;
  description: string;
  category: string | null;
  occupancyLimits: unknown;
  roomAttributes: unknown;
  createdAt: string;
  updatedAt: string;
};
type InboundForeignKeyRow = {
  sourceSchema: string;
  sourceTable: string;
  constraintName: string;
  referencedTable: string;
};
type DeleteReferenceCounts = {
  publishedReferenceCount: number | string;
  bookingReferenceCount: number | string;
  assignedPhysicalUnitCount: number | string;
  verifiedPhysicalUnitCount: number | string;
  rateReferenceCount: number | string;
  calendarReferenceCount: number | string;
  roomBlockReferenceCount: number | string;
  channelReferenceCount: number | string;
  otherOperationalReferenceCount: number | string;
};

type FakeOptions = {
  authorized?: boolean;
  entitlementRows?: readonly QueryResultRow[];
  idempotency?: IdempotencyRow;
  idempotencyReads?: readonly (IdempotencyRow | undefined)[];
  reservationAvailable?: boolean;
  binding?: DraftBindingRow;
  nameConflict?: boolean;
  lockedRoom?: RoomRow | null;
  insertRow?: RoomRow;
  updateRow?: RoomRow;
  inboundForeignKeys?: readonly InboundForeignKeyRow[];
  deleteReferenceCounts?: DeleteReferenceCounts;
  deleteReferenceError?: unknown;
};

class RecordingClient implements PmsRoomFactsCommandClient {
  readonly calls: RecordedQuery[] = [];
  readonly commands: string[] = [];
  private idempotencyReadIndex = 0;

  constructor(private readonly options: FakeOptions) {}

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
    this.calls.push({ text, values });
    const sql = normalizeSql(text);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
      this.commands.push(sql);
      return result<T>();
    }
    if (sql.startsWith("SAVEPOINT ") || sql.startsWith("RELEASE SAVEPOINT ")) {
      return result<T>();
    }
    if (sql.startsWith("ROLLBACK TO SAVEPOINT ")) return result<T>();
    if (sql.includes("SELECT property.id") && sql.includes("FROM hotel_catalog.properties")) {
      return result<T>(this.options.authorized === false ? [] : [{ id: propertyId }]);
    }
    if (sql.includes("FROM identity.product_entitlements")) {
      return result<T>(
        this.options.entitlementRows ?? [{ status: "active", startsAt: null, expiresAt: null }],
      );
    }
    if (sql.includes("pg_advisory_xact_lock")) return result<T>();
    if (sql.includes("FROM platform.idempotency_keys") && sql.includes("FOR UPDATE")) {
      const idempotency = this.options.idempotencyReads
        ? this.options.idempotencyReads[this.idempotencyReadIndex++]
        : this.options.idempotency;
      return result<T>(idempotency ? [idempotency] : []);
    }
    if (sql.startsWith("INSERT INTO platform.idempotency_keys")) {
      return result<T>(
        this.options.reservationAvailable === false ? [] : [{ id: idempotencyId, attempt: 1 }],
      );
    }
    if (sql.includes("setup_draft_room_id = $2") && sql.includes("FOR UPDATE")) {
      return result<T>(this.options.binding ? [this.options.binding] : []);
    }
    if (sql.includes("lower(name) = lower($2)")) {
      return result<T>(this.options.nameConflict ? [{ id: roomTypeId }] : []);
    }
    if (sql.startsWith("INSERT INTO pms.room_types")) {
      return result<T>(
        [
          this.options.insertRow ??
            roomRow({ roomTypeId: createdRoomTypeId, roomFactsRevision: 1 }),
        ],
        1,
      );
    }
    if (
      sql.includes("FROM pms.room_types") &&
      sql.includes("id = $2::uuid") &&
      sql.includes("FOR UPDATE")
    ) {
      const locked = Object.hasOwn(this.options, "lockedRoom")
        ? this.options.lockedRoom
        : roomRow();
      return result<T>(locked ? [locked] : []);
    }
    if (sql.startsWith("UPDATE pms.room_types") && sql.includes("SET name = $4")) {
      const expectedRevision = Number(values[2]);
      return result<T>([
        this.options.updateRow ??
          roomRow({
            roomFactsRevision: expectedRevision + 1,
            name: String(values[3]),
            description: String(values[4]),
            category: values[5] === null ? null : String(values[5]),
            occupancyLimits: JSON.parse(String(values[6])),
            roomAttributes: JSON.parse(String(values[7])),
            updatedAt: String(values[8]),
          }),
      ]);
    }
    if (sql.includes("FROM pg_catalog.pg_constraint")) {
      return result<T>([...(this.options.inboundForeignKeys ?? expectedInboundForeignKeys())]);
    }
    if (sql.startsWith("SET LOCAL ")) return result<T>();
    if (sql.startsWith("LOCK TABLE ")) return result<T>();
    if (sql.includes("public_room_offer_snapshots") && sql.includes("publishedReferenceCount")) {
      if (this.options.deleteReferenceError) throw this.options.deleteReferenceError;
      return result<T>([
        this.options.deleteReferenceCounts ?? {
          publishedReferenceCount: 0,
          bookingReferenceCount: 0,
          assignedPhysicalUnitCount: 0,
          verifiedPhysicalUnitCount: 0,
          rateReferenceCount: 0,
          calendarReferenceCount: 0,
          roomBlockReferenceCount: 0,
          channelReferenceCount: 0,
          otherOperationalReferenceCount: 0,
        },
      ]);
    }
    if (sql.startsWith("DELETE FROM pms.room_type_media")) return result<T>([], 0);
    if (sql.startsWith("UPDATE pms.rooms room")) return result<T>([], 0);
    if (sql.startsWith("UPDATE pms.room_types") && sql.includes("active = FALSE")) {
      return result<T>([{ deletedRevision: Number(values[5]) + 1 }], 1);
    }
    if (sql.startsWith("INSERT INTO platform.product_audit_events")) return result<T>([], 1);
    if (
      sql.startsWith("UPDATE platform.idempotency_keys") &&
      sql.includes("status = 'completed'")
    ) {
      return result<T>([], 1);
    }
    throw new Error(`Unexpected PMS room facts unit-test query: ${sql}`);
  }

  release(): void {}
}

function fakeDatabase(options: FakeOptions = {}) {
  const client = new RecordingClient(options);
  const pool: PmsRoomFactsCommandPool = {
    async connect() {
      return client;
    },
    async end() {},
  };
  return {
    pool,
    calls: client.calls,
    commands: client.commands,
    sql: () => client.calls.map(({ text }) => text).join("\n"),
    auditCall: () => client.calls.find(({ text }) => text.includes("product_audit_events")),
    auditPayload: () => {
      const raw = client.calls.find(({ text }) => text.includes("product_audit_events"))?.values[9];
      return typeof raw === "string" ? (JSON.parse(raw) as unknown) : null;
    },
    didAudit: () => client.calls.some(({ text }) => text.includes("product_audit_events")),
    didCompleteIdempotency: () =>
      client.calls.some(
        ({ text }) =>
          text.includes("UPDATE platform.idempotency_keys") && text.includes("completed"),
      ),
    completionStatus: () =>
      client.calls.find(
        ({ text }) =>
          text.includes("UPDATE platform.idempotency_keys") && text.includes("completed"),
      )?.values[1],
  };
}

function createRepository(
  target: ReturnType<typeof fakeDatabase>,
  vocabularyValidator: RoomFactsVocabularyValidationPort = allowVocabulary(),
) {
  return createPgPmsRoomFactsCommandRepository({
    connectionString: "postgresql://pms-room-facts-unit-test",
    pool: target.pool,
    vocabularyValidator,
    now: () => acceptedAt,
    randomId: () => createdRoomTypeId,
  });
}

function allowVocabulary(): RoomFactsVocabularyValidationPort {
  return { validateRoomFactsVocabulary: vi.fn(async () => ({ ok: true as const })) };
}

function createCommand(
  overrides: Partial<CreateRoomTypeFactsCommand> = {},
): CreateRoomTypeFactsCommand {
  return {
    organizationId,
    propertyId,
    idempotencyKey: "room-facts-create-key",
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "request-room-facts-create",
      correlationId: "correlation-room-facts-create",
      requestedAt: "2026-08-03T09:59:00.000Z",
    },
    draftRoomId,
    expectedRevision: 0,
    facts,
    ...overrides,
  };
}

function updateCommand(
  overrides: Partial<UpdateRoomTypeFactsCommand> = {},
): UpdateRoomTypeFactsCommand {
  return {
    organizationId,
    propertyId,
    idempotencyKey: "room-facts-update-key",
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "request-room-facts-update",
      correlationId: "correlation-room-facts-update",
      requestedAt: "2026-08-03T09:59:00.000Z",
    },
    roomTypeId,
    expectedRevision: 3,
    facts,
    ...overrides,
  };
}

function safeDeleteCommand(
  overrides: Partial<SafeDeleteRoomTypeCommand> = {},
): SafeDeleteRoomTypeCommand {
  return {
    organizationId,
    propertyId,
    idempotencyKey: "room-facts-safe-delete-key",
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "request-room-facts-safe-delete",
      correlationId: "correlation-room-facts-safe-delete",
      requestedAt: "2026-08-03T09:59:00.000Z",
    },
    roomTypeId,
    expectedRevision: 2,
    ...overrides,
  };
}

function roomRow(overrides: Partial<RoomRow> = {}): RoomRow {
  return {
    propertyId,
    roomTypeId,
    roomFactsRevision: 3,
    active: true,
    name: facts.name,
    description: facts.description,
    category: facts.category,
    occupancyLimits: {
      total: facts.occupancy.maxGuests,
      adults: facts.occupancy.maxAdults,
      children: facts.occupancy.maxChildren,
      preserved: "unowned",
    },
    roomAttributes: {
      beds: facts.beds,
      bedrooms: facts.bedrooms,
      bathrooms: facts.bathrooms,
      bathroomType: facts.bathroomType,
      size: facts.size,
      preserved: "unowned",
    },
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-02T09:00:00.000Z",
    ...overrides,
  };
}

function nameConflictResult(): CreateRoomTypeFactsResult {
  return { ok: false, error: { code: "room_type_name_conflict" } };
}

function completedIdempotency(
  command: CreateRoomTypeFactsCommand,
  stored: CreateRoomTypeFactsResult,
): IdempotencyRow {
  return {
    id: idempotencyId,
    status: "completed",
    requestFingerprintHash: sha256(serializeCreateRoomTypeFactsFingerprint(command)),
    responseStatusCode: stored.ok ? 201 : 409,
    responseBodyHash: sha256(stableJson(stored.ok ? stored.response : stored.error)),
    idempotencyMetadata: { attempt: 1, result: stored },
    expiresAt: "2026-08-04T10:00:00.000Z",
  };
}

function expectedInboundForeignKeys(): InboundForeignKeyRow[] {
  return [
    inbound("pms", "rooms", "fk_pms_rooms_room_type_property", "pms.room_types"),
    inbound("pms", "rate_plans", "fk_pms_rate_plans_room_type_property", "pms.room_types"),
    inbound("pms", "rate_rules", "fk_pms_rate_rules_room_type_property", "pms.room_types"),
    inbound(
      "pms",
      "recurring_pricing_source_room_values",
      "fk_pms_recurring_pricing_room_values_room_type",
      "pms.room_types",
    ),
    inbound(
      "pms",
      "non_refundable_rate_plan_source_rooms",
      "fk_pms_non_refundable_rate_plan_source_rooms_room_type",
      "pms.room_types",
    ),
    inbound(
      "pms",
      "recurring_pricing_materialized_rows",
      "fk_pms_recurring_pricing_materialized_rows_room_type",
      "pms.room_types",
    ),
    inbound("pms", "inventory_days", "fk_pms_inventory_days_room_type_property", "pms.room_types"),
    inbound("pms", "room_blocks", "fk_pms_room_blocks_room_type_property", "pms.room_types"),
    inbound(
      "pms",
      "operational_booking_assignments",
      "fk_pms_operational_assignments_room_type_property",
      "pms.room_types",
    ),
    inbound(
      "pms",
      "channel_room_type_mappings",
      "fk_pms_channel_room_mappings_room_type_property",
      "pms.room_types",
    ),
    inbound(
      "pms",
      "channel_rate_plan_mappings",
      "fk_pms_channel_rate_mappings_room_type_property",
      "pms.room_types",
    ),
    inbound("pms", "room_type_media", "fk_pms_room_type_media_room_property", "pms.room_types"),
    inbound("pms", "room_blocks", "fk_pms_room_blocks_room_property", "pms.rooms"),
    inbound(
      "pms",
      "operational_booking_assignments",
      "fk_pms_operational_assignments_room_property",
      "pms.rooms",
    ),
  ];
}

function inbound(
  sourceSchema: string,
  sourceTable: string,
  constraintName: string,
  referencedTable: string,
): InboundForeignKeyRow {
  return { sourceSchema, sourceTable, constraintName, referencedTable };
}

function result<T extends QueryResultRow>(
  rows: readonly QueryResultRow[] = [],
  rowCount = rows.length,
): Pick<QueryResult<T>, "rows" | "rowCount"> {
  return { rows: rows as T[], rowCount };
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredDraftRoomId(value: string) {
  const parsed = parseDraftRoomId(value);
  if (!parsed) throw new Error("test draft room id is invalid");
  return parsed;
}

function requiredRoomTypeFacts(value: unknown) {
  const parsed = parseRoomTypeFacts(value);
  if (!parsed) throw new Error("test room facts are invalid");
  return parsed;
}
