import { createHash } from "node:crypto";

import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseReconcilePhysicalRoomUnitsCommand,
  serializeReconcilePhysicalRoomUnitsFingerprint,
  type ReconcilePhysicalRoomUnitsResult,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createPgPmsPhysicalRoomUnitReconcileRepository,
  type PmsPhysicalRoomUnitReconcileClient,
  type PmsPhysicalRoomUnitReconcilePool,
} from "./domains/pmsPhysicalRoomUnitReconcileRepository.js";

const organizationId = "b1000000-0000-0000-8000-000000000001";
const propertyId = "b1000000-0000-0000-8000-000000000002";
const roomTypeId = "b1000000-0000-0000-8000-000000000003";
const firstUnitId = "b1000000-0000-0000-8000-000000000004";
const secondUnitId = "b1000000-0000-0000-8000-000000000005";
const thirdUnitId = "b1000000-0000-0000-8000-000000000006";
const occurredAt = "2026-08-03T10:00:00.000Z";

function reconcileCommand(overrides: Record<string, unknown> = {}) {
  const parsed = parseReconcilePhysicalRoomUnitsCommand({
    organizationId,
    propertyId,
    roomTypeId,
    expectedRevision: 2,
    targetActiveUnitCount: 3,
    idempotencyKey: "reconcile-units-1",
    audit: {
      actor: { kind: "user", userId: organizationId },
      requestId: "req-reconcile-1",
      correlationId: "corr-reconcile-1",
      requestedAt: occurredAt,
    },
    ...overrides,
  });
  if (!parsed) throw new Error("test command is invalid");
  return parsed;
}

type HarnessUnit = {
  roomUnitId: string;
  sortOrder?: number;
  status?: "available" | "maintenance" | "out_of_order";
  operationalLabel?: string | null;
  operationalLabelStatus?: "unverified" | "verified";
  setupGenerated?: boolean;
  hasReservationAssignment?: boolean;
  hasRoomBlock?: boolean;
};

function harness(
  options: {
    scope?: boolean;
    entitlementStatus?: "active" | "suspended" | "expired";
    roomTypeRevision?: number | null;
    units?: HarnessUnit[];
    insertedIds?: string[];
    activeCountAfter?: number;
    replay?: { fingerprint: string; result: ReconcilePhysicalRoomUnitsResult };
    failAudit?: boolean;
  } = {},
) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  let poolEnded = false;
  const units = options.units ?? [{ roomUnitId: firstUnitId }, { roomUnitId: secondUnitId }];
  const client: PmsPhysicalRoomUnitReconcileClient = {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
      calls.push({ text, values });
      const sql = text.replace(/\s+/g, " ").trim();
      const queryResult = (rows: QueryResultRow[] = [], rowCount = rows.length) =>
        result(rows, rowCount) as Pick<QueryResult<T>, "rows" | "rowCount">;
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return queryResult();
      if (sql.includes("pg_advisory_xact_lock")) return queryResult([{ locked: true }]);
      if (sql.includes("FROM hotel_catalog.properties property")) {
        return queryResult(options.scope === false ? [] : [{ id: propertyId }]);
      }
      if (sql.includes("FROM identity.product_entitlements")) {
        return queryResult([
          {
            status: options.entitlementStatus ?? "active",
            startsAt: null,
            expiresAt: null,
          },
        ]);
      }
      if (sql.includes("FROM pms.room_types") && sql.includes("FOR UPDATE")) {
        const revision = options.roomTypeRevision === undefined ? 2 : options.roomTypeRevision;
        return queryResult(revision === null ? [] : [{ roomUnitsRevision: revision }]);
      }
      if (sql.includes("FROM platform.idempotency_keys") && sql.includes("LIMIT 1")) {
        return queryResult(
          options.replay
            ? [
                {
                  id: "b1000000-0000-0000-8000-000000000099",
                  status: "completed",
                  requestFingerprintHash: options.replay.fingerprint,
                  idempotencyMetadata: { result: options.replay.result },
                },
              ]
            : [],
        );
      }
      if (sql.startsWith("INSERT INTO platform.idempotency_keys")) {
        return queryResult([{ id: "b1000000-0000-0000-8000-000000000098" }]);
      }
      if (sql.includes('room.room_number AS "operationalLabel"')) {
        return queryResult(
          units.map((unit, index) => ({
            roomUnitId: unit.roomUnitId,
            sortOrder: unit.sortOrder ?? index + 1,
            status: unit.status ?? "available",
            operationalLabel: unit.operationalLabel ?? null,
            operationalLabelStatus: unit.operationalLabelStatus ?? "unverified",
            setupGenerated: unit.setupGenerated ?? false,
          })),
        );
      }
      if (sql.includes('AS "hasReservationAssignment"')) {
        return queryResult(
          units.map((unit) => ({
            roomUnitId: unit.roomUnitId,
            hasReservationAssignment: unit.hasReservationAssignment ?? false,
            hasRoomBlock: unit.hasRoomBlock ?? false,
          })),
        );
      }
      if (sql.startsWith("WITH room_order_seed AS (")) {
        return queryResult(
          (options.insertedIds ?? [thirdUnitId]).map((roomUnitId) => ({ roomUnitId })),
        );
      }
      if (sql.startsWith("UPDATE pms.rooms"))
        return queryResult([], (values[2] as string[]).length);
      if (sql.startsWith("UPDATE pms.room_types")) return queryResult([{ roomUnitsRevision: 3 }]);
      if (sql.includes('count(*)::integer AS "activeUnitCount"')) {
        return queryResult([{ activeUnitCount: options.activeCountAfter ?? 3 }]);
      }
      if (sql.startsWith("INSERT INTO platform.product_audit_events")) {
        if (options.failAudit) throw new Error("injected audit failure");
        return queryResult([], 1);
      }
      if (sql.startsWith("UPDATE platform.idempotency_keys")) return queryResult([], 1);
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool: PmsPhysicalRoomUnitReconcilePool = {
    async connect() {
      return client;
    },
    async end() {
      poolEnded = true;
    },
  };
  return {
    calls,
    repository: createPgPmsPhysicalRoomUnitReconcileRepository({
      pool,
      now: () => new Date(occurredAt),
    }),
    poolEnded: () => poolEnded,
  };
}

describe("PMS physical room unit reconcile repository", () => {
  it("adds opaque null/unverified units and commits audit without outbox work", async () => {
    const test = harness();
    const result = await test.repository.reconcilePhysicalRoomUnits(reconcileCommand());

    expect(result).toMatchObject({
      ok: true,
      response: {
        outcome: "reconciled",
        previousActiveUnitCount: 2,
        capacity: { activeUnitCount: 3, roomUnitsRevision: 3 },
        addedUnits: [
          {
            roomUnitId: thirdUnitId,
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          },
        ],
      },
    });
    const sql = test.calls.map(({ text }) => text).join("\n");
    expect(sql).toContain("INSERT INTO pms.rooms");
    expect(sql).toContain("setupGenerated");
    expect(sql).toContain("MAX(sort_order)");
    expect(sql).toContain("room_units_revision = room_units_revision + 1");
    expect(sql).not.toContain("room_facts_revision");
    expect(sql).toContain("INSERT INTO platform.product_audit_events");
    expect(sql).not.toContain("platform.outbox_events");
    expect(sql).not.toContain("platform.domain_events");
    expect(sql).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+booking\./);
    const roomOrderLock = test.calls.findIndex(({ text }) => text.includes("pms.room-order:"));
    const roomTypeLock = test.calls.findIndex(({ text }) =>
      text.includes("pms.physical-room-unit:"),
    );
    const insert = test.calls.findIndex(({ text }) => text.includes("INSERT INTO pms.rooms"));
    expect(roomOrderLock).toBeGreaterThan(-1);
    expect(roomOrderLock).toBeLessThan(roomTypeLock);
    expect(roomTypeLock).toBeLessThan(insert);
  });

  it("retires the first deterministic eligible identities and preserves protected rows", async () => {
    const test = harness({
      units: [
        { roomUnitId: thirdUnitId, sortOrder: 3 },
        { roomUnitId: secondUnitId, sortOrder: 2 },
        { roomUnitId: firstUnitId, sortOrder: 1, hasReservationAssignment: true },
      ],
      activeCountAfter: 2,
    });
    const result = await test.repository.reconcilePhysicalRoomUnits(
      reconcileCommand({ targetActiveUnitCount: 2 }),
    );

    expect(result).toMatchObject({
      ok: true,
      response: { retiredUnitIds: [thirdUnitId], capacity: { activeUnitCount: 2 } },
    });
    const retirement = test.calls.find(({ text }) => text.includes("UPDATE pms.rooms"));
    expect(retirement?.values[2]).toEqual([thirdUnitId]);
    expect(retirement?.text).toContain("NOT EXISTS");
    const roomLock = test.calls.find(({ text }) =>
      text.includes('room.room_number AS "operationalLabel"'),
    );
    expect(roomLock?.text).toContain("ORDER BY room.id");
    expect(roomLock?.text).toContain('room.sort_order AS "sortOrder"');
    const advisoryLockIndex = test.calls.findIndex(({ text }) =>
      text.includes("pg_advisory_xact_lock"),
    );
    const roomTypeLockIndex = test.calls.findIndex(
      ({ text }) => text.includes("FROM pms.room_types") && text.includes("FOR UPDATE"),
    );
    expect(advisoryLockIndex).toBeGreaterThan(-1);
    expect(advisoryLockIndex).toBeLessThan(roomTypeLockIndex);
  });

  it("can retire an unused verified unit generated by canonical setup", async () => {
    const test = harness({
      units: [
        { roomUnitId: firstUnitId },
        {
          roomUnitId: secondUnitId,
          operationalLabel: "Castrop Suite 2",
          operationalLabelStatus: "verified",
          setupGenerated: true,
        },
      ],
      activeCountAfter: 1,
    });

    await expect(
      test.repository.reconcilePhysicalRoomUnits(reconcileCommand({ targetActiveUnitCount: 1 })),
    ).resolves.toMatchObject({
      ok: true,
      response: { retiredUnitIds: [secondUnitId], capacity: { activeUnitCount: 1 } },
    });

    const retirement = test.calls.find(({ text }) => text.includes("UPDATE pms.rooms"));
    expect(retirement?.text).toContain("setupGenerated");
    expect(retirement?.text).toContain("operational_label_status = 'unverified'");
  });

  it("returns counted blockers without changing units when safe capacity is insufficient", async () => {
    const test = harness({
      units: [
        {
          roomUnitId: thirdUnitId,
          operationalLabel: "301",
          operationalLabelStatus: "verified",
        },
        { roomUnitId: secondUnitId, hasReservationAssignment: true },
        { roomUnitId: firstUnitId, status: "maintenance", hasRoomBlock: true },
      ],
    });
    const result = await test.repository.reconcilePhysicalRoomUnits(
      reconcileCommand({ targetActiveUnitCount: 1 }),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "physical_unit_reconcile_blocked",
        currentRevision: 2,
        currentActiveUnitCount: 3,
        targetActiveUnitCount: 1,
        safelyRemovableUnitCount: 0,
        blockers: [
          { code: "verified_operational_label", affectedCount: 1 },
          { code: "reservation_assignment", affectedCount: 1 },
          { code: "room_block", affectedCount: 1 },
          { code: "operational_status", affectedCount: 1 },
        ],
      },
    });
    expect(test.calls.some(({ text }) => text.includes("UPDATE pms.rooms"))).toBe(false);
    expect(test.calls.some(({ text }) => text.includes("UPDATE platform.idempotency_keys"))).toBe(
      true,
    );
  });

  it("stores stale revision conflicts after locking scope and the canonical room type", async () => {
    const test = harness({ roomTypeRevision: 5 });
    const result = await test.repository.reconcilePhysicalRoomUnits(reconcileCommand());

    expect(result).toEqual({
      ok: false,
      error: { code: "room_units_revision_conflict", currentRevision: 5 },
    });
    const scopeIndex = test.calls.findIndex(({ text }) =>
      text.includes("hotel_catalog.properties"),
    );
    const roomTypeIndex = test.calls.findIndex(({ text }) => text.includes("FROM pms.room_types"));
    const idempotencyIndex = test.calls.findIndex(({ text }) =>
      text.includes("FROM platform.idempotency_keys"),
    );
    expect(scopeIndex).toBeLessThan(roomTypeIndex);
    expect(roomTypeIndex).toBeLessThan(idempotencyIndex);
    expect(test.calls.some(({ text }) => text.includes("FROM pms.rooms"))).toBe(false);
  });

  it("replays the exact stored result only after current scope and room checks", async () => {
    const command = reconcileCommand();
    const replayResult: ReconcilePhysicalRoomUnitsResult = {
      ok: true,
      response: {
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        outcome: "reconciled",
        propertyId,
        roomTypeId,
        previousActiveUnitCount: 2,
        capacity: {
          contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
          propertyId,
          roomTypeId,
          roomUnitsRevision: 3,
          activeUnitCount: 3,
          capturedAt: occurredAt,
        },
        addedUnits: [
          {
            contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
            propertyId,
            roomTypeId,
            roomUnitId: thirdUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          },
        ],
        retiredUnitIds: [],
        acceptedAt: occurredAt,
      },
    };
    const fingerprint = createHash("sha256")
      .update(serializeReconcilePhysicalRoomUnitsFingerprint(command))
      .digest("hex");
    const test = harness({ replay: { fingerprint, result: replayResult } });

    await expect(test.repository.reconcilePhysicalRoomUnits(command)).resolves.toEqual(
      replayResult,
    );
    expect(test.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(test.calls.some(({ text }) => text.includes("product_audit_events"))).toBe(false);

    const wrongRevision: ReconcilePhysicalRoomUnitsResult = {
      ...replayResult,
      response: {
        ...replayResult.response,
        capacity: { ...replayResult.response.capacity, roomUnitsRevision: 99 },
      },
    };
    const corrupted = harness({ replay: { fingerprint, result: wrongRevision } });
    await expect(corrupted.repository.reconcilePhysicalRoomUnits(command)).resolves.toEqual({
      ok: false,
      error: { code: "idempotency_key_conflict" },
    });
  });

  it("fails wrong-property scope before idempotency and rolls back injected audit failure", async () => {
    const wrongScope = harness({ scope: false });
    await expect(
      wrongScope.repository.reconcilePhysicalRoomUnits(reconcileCommand()),
    ).resolves.toEqual({ ok: false, error: { code: "setup_scope_unavailable" } });
    expect(wrongScope.calls.some(({ text }) => text.includes("idempotency_keys"))).toBe(false);

    const auditFailure = harness({ failAudit: true });
    await expect(
      auditFailure.repository.reconcilePhysicalRoomUnits(reconcileCommand()),
    ).rejects.toThrow("injected audit failure");
    expect(auditFailure.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("fails closed when the current PMS entitlement is suspended", async () => {
    const test = harness({ entitlementStatus: "suspended" });

    await expect(test.repository.reconcilePhysicalRoomUnits(reconcileCommand())).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(test.calls.some(({ text }) => text.includes("pms.room_types"))).toBe(false);
    expect(test.calls.some(({ text }) => text.includes("platform.idempotency_keys"))).toBe(false);
    expect(test.calls.at(-1)?.text).toBe("ROLLBACK");
  });

  it("does not own an injected pool", async () => {
    const test = harness();
    await test.repository.close();
    expect(test.poolEnded()).toBe(false);
  });
});

function result<T extends Record<string, unknown>>(rows: T[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}
