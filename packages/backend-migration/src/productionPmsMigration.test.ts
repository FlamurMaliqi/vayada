import { describe, expect, it, vi } from "vitest";

import {
  runProductionPmsMigration,
  runProductionPmsTransaction,
  type ProductionPmsMigrationServices,
} from "./productionPmsMigration.js";
import type { ProductionPmsPlan } from "./productionPmsTypes.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production PMS migration transaction", () => {
  it("rejects programmatic apply without explicit run-bound confirmation", async () => {
    await expect(
      runProductionPmsMigration({
        connectionString: "postgresql://unused/unused",
        sourceRunId: RUN,
        mode: "apply",
      }),
    ).rejects.toThrow(`confirmation production-pms:${RUN}`);
  });

  it("always rolls a dry-run back without writing", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    const report = await runProductionPmsTransaction(
      client as never,
      { sourceRunId: RUN, mode: "dry-run" },
      services,
    );
    expect(report.applied).toBe(false);
    expect(client.sql).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "ROLLBACK"]);
    expect(services.writeRecords).not.toHaveBeenCalled();
    expect(services.writeProvenance).not.toHaveBeenCalled();
  });

  it("locks, writes, verifies, and commits an apply", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    let builds = 0;
    services.buildPlan = vi.fn(() => (++builds === 3 ? plan(false) : plan(true)));
    const report = await runProductionPmsTransaction(
      client as never,
      { sourceRunId: RUN, mode: "apply" },
      services,
    );
    expect(report.applied).toBe(true);
    expect(client.sql[1]).toContain("lock_timeout");
    expect(client.sql[2]).toContain("LOCK TABLE pms.linked_inventory_groups");
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("rolls back when exact writer counts disagree", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    services.writeRecords = vi.fn(async () => ({ room_types: 0 }));
    await expect(
      runProductionPmsTransaction(client as never, { sourceRunId: RUN, mode: "apply" }, services),
    ).rejects.toThrow("applied 0 of 1");
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("never writes a blocked apply plan", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    services.buildPlan = vi.fn(() => ({
      ...plan(true),
      blockers: [{ code: "STALE", source: "pms.rooms", sourceId: "x", message: "blocked" }],
    }));
    const report = await runProductionPmsTransaction(
      client as never,
      { sourceRunId: RUN, mode: "apply" },
      services,
    );
    expect(report.applied).toBe(false);
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(services.writeRecords).not.toHaveBeenCalled();
  });
});

class TransactionFixture {
  sql: string[] = [];
  async query(sql: string) {
    this.sql.push(sql);
    return { rows: [], rowCount: 0 };
  }
}

function serviceFixture(): ProductionPmsMigrationServices {
  return {
    readSnapshot: vi.fn(async () => ({ rows: [], completedAt: "2026-08-30T00:00:00.000Z" })),
    readPrerequisites: vi.fn(async () => ({
      propertyLinks: [],
      bookings: [],
      userIds: [],
      mediaIds: [],
    })),
    readTarget: vi.fn(async () => ({
      propertyLinks: [],
      bookings: [],
      userIds: [],
      mediaIds: [],
      records: [],
      provenance: [],
    })),
    buildPlan: vi.fn(() => plan(true)),
    writeRecords: vi.fn(async () => ({ room_types: 1 })),
    writeProvenance: vi.fn(async () => 1),
  } as ProductionPmsMigrationServices;
}

function plan(withWrite: boolean): ProductionPmsPlan {
  const record = {
    targetProduct: "pms" as const,
    targetTable: "room_types",
    targetId: "13560000-0000-4000-8000-000000000071",
    sourceDatabase: "pms" as const,
    sourceTable: "room_types",
    sourceId: "13560000-0000-4000-8000-000000000071",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
    mutable: true,
    row: { id: "13560000-0000-4000-8000-000000000071" },
  };
  return {
    sourceRunId: RUN,
    checksum: "b".repeat(64),
    records: [record],
    writes: withWrite ? [record] : [],
    provenance: [
      {
        sourceDatabase: "pms",
        sourceTable: "room_types",
        sourceId: record.sourceId,
        targetProduct: "pms",
        targetTable: "room_types",
        targetId: record.targetId,
        sourceChecksum: record.sourceChecksum,
        sourceUpdatedAt: record.sourceUpdatedAt,
        lastMigratedAt: "2026-08-30T00:00:00.000Z",
      },
    ],
    blockers: [],
    parity: {
      sourceTableCounts: { "pms.room_types": 1 },
      targetTableCounts: { "pms.room_types": 1 },
      sourceCountsByProperty: {},
      targetCountsByProperty: {},
      futureInventoryByProperty: {},
    },
    counts: {
      sourceRows: 1,
      plannedRecords: 1,
      inserts: withWrite ? 1 : 0,
      updates: 0,
      unchanged: withWrite ? 0 : 1,
      preservedNewerTarget: 0,
      preservedTargetDeletions: 0,
    },
  };
}
