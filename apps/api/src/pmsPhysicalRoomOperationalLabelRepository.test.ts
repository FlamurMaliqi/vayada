import { createHash } from "node:crypto";

import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseSetPhysicalRoomOperationalLabelCommand,
  serializeSetPhysicalRoomOperationalLabelFingerprint,
  type SetPhysicalRoomOperationalLabelResult,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createPgPmsPhysicalRoomOperationalLabelRepository } from "./domains/pmsPhysicalRoomOperationalLabelRepository.js";
import type {
  PmsPhysicalRoomUnitReconcileClient as Client,
  PmsPhysicalRoomUnitReconcilePool as Pool,
} from "./domains/pmsPhysicalRoomUnitReconcileRepository.js";

const organizationId = "d1000000-0000-0000-8000-000000000001";
const propertyId = "d1000000-0000-0000-8000-000000000002";
const roomTypeId = "d1000000-0000-0000-8000-000000000003";
const roomUnitId = "d1000000-0000-0000-8000-000000000004";
const idempotencyId = "d1000000-0000-0000-8000-000000000005";
const acceptedAt = "2026-08-14T12:00:00.000Z";

function command(overrides: Record<string, unknown> = {}) {
  const parsed = parseSetPhysicalRoomOperationalLabelCommand({
    organizationId,
    propertyId,
    roomTypeId,
    roomUnitId,
    expectedRevision: 1,
    operationalLabel: "QA-101",
    idempotencyKey: "verify-room-qa-101",
    audit: {
      actor: { kind: "user", userId: organizationId },
      requestId: "request-1",
      correlationId: "correlation-1",
      requestedAt: acceptedAt,
    },
    ...overrides,
  });
  if (!parsed) throw new Error("invalid test command");
  return parsed;
}

function success(
  outcome: "updated" | "unchanged" = "updated",
): SetPhysicalRoomOperationalLabelResult {
  return {
    ok: true,
    response: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      outcome,
      propertyId,
      roomTypeId,
      roomUnitId,
      roomUnitsRevision: outcome === "updated" ? 2 : 1,
      operationalLabel: "QA-101",
      operationalLabelStatus: "verified",
      acceptedAt,
    },
  };
}

function harness(
  options: {
    scope?: boolean;
    revision?: number | null;
    unit?: { label: string | null; status: string } | null;
    replay?: { fingerprint: string; result: SetPhysicalRoomOperationalLabelResult };
    labelConflict?: "verified" | "legacy";
    failAudit?: boolean;
  } = {},
) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  let ended = false;
  const client: Client = {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">> {
      calls.push({ text, values });
      const sql = text.replace(/\s+/g, " ").trim();
      const result = (rows: QueryResultRow[] = [], rowCount = rows.length) =>
        ({ rows, rowCount }) as Pick<QueryResult<T>, "rows" | "rowCount">;
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("SAVEPOINT")) {
        return result();
      }
      if (sql.includes("FROM hotel_catalog.properties property")) {
        return result(options.scope === false ? [] : [{ id: propertyId }]);
      }
      if (sql.includes("FROM identity.product_entitlements")) {
        return result([{ status: "active", startsAt: null, expiresAt: null }]);
      }
      if (sql.includes("pg_advisory_xact_lock")) return result([{ locked: true }]);
      if (sql.includes("FROM pms.room_types") && sql.includes("FOR UPDATE")) {
        const revision = options.revision === undefined ? 1 : options.revision;
        return result(revision === null ? [] : [{ roomUnitsRevision: revision }]);
      }
      if (sql.includes("FROM platform.idempotency_keys") && sql.includes("LIMIT 1")) {
        return result(
          options.replay
            ? [
                {
                  status: "completed",
                  requestFingerprintHash: options.replay.fingerprint,
                  idempotencyMetadata: { result: options.replay.result },
                },
              ]
            : [],
        );
      }
      if (sql.startsWith("INSERT INTO platform.idempotency_keys")) {
        return result([{ id: idempotencyId }]);
      }
      if (sql.includes('room_number AS "operationalLabel"')) {
        const unit =
          options.unit === undefined ? { label: null, status: "unverified" } : options.unit;
        return result(
          unit ? [{ operationalLabel: unit.label, operationalLabelStatus: unit.status }] : [],
        );
      }
      if (sql.startsWith("UPDATE pms.rooms")) {
        if (options.labelConflict) {
          throw {
            code: "23505",
            constraint:
              options.labelConflict === "legacy"
                ? "uq_pms_rooms_property_number"
                : "uq_pms_rooms_property_verified_label_ci",
          };
        }
        return result([], 1);
      }
      if (sql.startsWith("UPDATE pms.room_types")) {
        return result([{ roomUnitsRevision: 2 }]);
      }
      if (sql.startsWith("INSERT INTO platform.product_audit_events")) {
        if (options.failAudit) throw new Error("injected audit failure");
        return result([], 1);
      }
      if (sql.startsWith("UPDATE platform.idempotency_keys")) return result([], 1);
      throw new Error(`unexpected query: ${sql}`);
    },
    release() {},
  };
  const pool: Pool = {
    async connect() {
      return client;
    },
    async end() {
      ended = true;
    },
  };
  return {
    calls,
    repository: createPgPmsPhysicalRoomOperationalLabelRepository({
      pool,
      now: () => new Date(acceptedAt),
    }),
    ended: () => ended,
  };
}

describe("PMS physical-room operational label repository", () => {
  it("verifies the label and commits revision, audit, and idempotency atomically", async () => {
    const test = harness();
    await expect(test.repository.setPhysicalRoomOperationalLabel(command())).resolves.toEqual(
      success(),
    );

    const sql = test.calls.map(({ text }) => text).join("\n");
    expect(sql).toContain("operational_label_status = 'verified'");
    expect(sql).toContain("room_units_revision = room_units_revision + 1");
    expect(sql).toContain("INSERT INTO platform.product_audit_events");
    expect(sql).toContain("COMMIT");
    expect(sql).not.toContain("platform.outbox_events");
  });

  it("returns unchanged without mutating the room or revision", async () => {
    const test = harness({ unit: { label: "QA-101", status: "verified" } });
    await expect(test.repository.setPhysicalRoomOperationalLabel(command())).resolves.toEqual(
      success("unchanged"),
    );
    expect(test.calls.some(({ text }) => text.trim().startsWith("UPDATE pms.rooms"))).toBe(false);
    expect(test.calls.some(({ text }) => text.trim().startsWith("UPDATE pms.room_types"))).toBe(
      false,
    );
  });

  it.each([
    [
      "stale revision",
      { revision: 2 },
      { code: "room_units_revision_conflict", currentRevision: 2 },
    ],
    ["missing unit", { unit: null }, { code: "room_unit_not_found" }],
    ["duplicate label", { labelConflict: "verified" }, { code: "operational_label_conflict" }],
  ] as const)("records a stable %s result", async (_label, options, error) => {
    const test = harness(options);
    await expect(test.repository.setPhysicalRoomOperationalLabel(command())).resolves.toEqual({
      ok: false,
      error,
    });
    expect(test.calls.at(-1)?.text).toBe("COMMIT");
  });

  it("replays an exact result and rejects changed facts for the same key", async () => {
    const original = command();
    const fingerprint = createFingerprint(original);
    const replay = harness({ replay: { fingerprint, result: success() } });
    await expect(replay.repository.setPhysicalRoomOperationalLabel(original)).resolves.toEqual(
      success(),
    );
    expect(replay.calls.some(({ text }) => text.includes("UPDATE pms.rooms"))).toBe(false);

    const conflict = harness({ replay: { fingerprint, result: success() } });
    await expect(
      conflict.repository.setPhysicalRoomOperationalLabel(command({ operationalLabel: "QA-102" })),
    ).resolves.toEqual({ ok: false, error: { code: "idempotency_key_conflict" } });
  });

  it.each([
    [{ ok: false, error: { code: "room_unit_not_found" } }],
    [{ ok: false, error: { code: "operational_label_conflict" } }],
    [{ ok: false, error: { code: "room_units_revision_conflict", currentRevision: 2 } }],
  ] as const)("replays an exact completed failure", async (result) => {
    const original = command();
    const replay = harness({
      replay: { fingerprint: createFingerprint(original), result },
    });
    await expect(replay.repository.setPhysicalRoomOperationalLabel(original)).resolves.toEqual(
      result,
    );
    expect(replay.calls.some(({ text }) => text.includes("UPDATE pms.rooms"))).toBe(false);
  });

  it("maps both operational-label uniqueness constraints", async () => {
    const legacy = harness({ labelConflict: "legacy" });
    await expect(legacy.repository.setPhysicalRoomOperationalLabel(command())).resolves.toEqual({
      ok: false,
      error: { code: "operational_label_conflict" },
    });
  });

  it("denies an unauthorized scope before idempotency and rolls back a late audit failure", async () => {
    const denied = harness({ scope: false });
    await expect(denied.repository.setPhysicalRoomOperationalLabel(command())).resolves.toEqual({
      ok: false,
      error: { code: "setup_scope_unavailable" },
    });
    expect(denied.calls.some(({ text }) => text.includes("platform.idempotency_keys"))).toBe(false);

    const failed = harness({ failAudit: true });
    await expect(failed.repository.setPhysicalRoomOperationalLabel(command())).rejects.toThrow(
      "injected audit failure",
    );
    expect(failed.calls.at(-1)?.text).toBe("ROLLBACK");
  });
});

function createFingerprint(value: ReturnType<typeof command>): string {
  return createHash("sha256")
    .update(serializeSetPhysicalRoomOperationalLabelFingerprint(value))
    .digest("hex");
}
