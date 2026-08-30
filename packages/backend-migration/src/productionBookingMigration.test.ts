import { describe, expect, it, vi } from "vitest";

import {
  runProductionBookingTransaction,
  type ProductionBookingMigrationServices,
} from "./productionBookingMigration.js";
import type { ProductionBookingPlan } from "./productionBookingTypes.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production Booking migration transaction", () => {
  it("always rolls a dry-run back without writing", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    const report = await runProductionBookingTransaction(
      client as never,
      { sourceRunId: RUN, mode: "dry-run" },
      services,
    );
    expect(report.applied).toBe(false);
    expect(client.sql).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "ROLLBACK"]);
    expect(services.writeRecords).not.toHaveBeenCalled();
    expect(services.writeProvenance).not.toHaveBeenCalled();
  });

  it("locks, writes, verifies, and commits an apply transaction", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    let builds = 0;
    services.buildPlan = vi.fn(() => (++builds === 3 ? plan(false) : plan(true)));
    const report = await runProductionBookingTransaction(
      client as never,
      { sourceRunId: RUN, mode: "apply" },
      services,
    );
    expect(report.applied).toBe(true);
    expect(client.sql[1]).toContain("lock_timeout");
    expect(client.sql[2]).toContain("LOCK TABLE booking.booking_settings");
    expect(client.sql.at(-1)).toBe("COMMIT");
    expect(services.writeRecords).toHaveBeenCalledTimes(1);
    expect(services.writeProvenance).toHaveBeenCalledWith(
      client,
      expect.any(Array),
      RUN,
    );
  });

  it("rolls back when a writer count disagrees with the plan", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    services.writeRecords = vi.fn(async () => ({ guest_bookings: 0 }));
    await expect(
      runProductionBookingTransaction(
        client as never,
        { sourceRunId: RUN, mode: "apply" },
        services,
      ),
    ).rejects.toThrow("applied 0 of 1");
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });
});

class TransactionFixture {
  sql: string[] = [];
  async query(sql: string) {
    this.sql.push(sql);
    return { rows: [], rowCount: 0 };
  }
}

function serviceFixture(): ProductionBookingMigrationServices {
  return {
    readSnapshot: vi.fn(async () => ({ rows: [], completedAt: "2026-08-30T00:00:00.000Z" })),
    readOwnership: vi.fn(async () => ({ propertyLinks: [], propertySlugs: [] })),
    readTarget: vi.fn(async () => ({
      propertyLinks: [],
      propertySlugs: [],
      records: [],
      provenance: [],
    })),
    buildPlan: vi.fn(() => plan(true)),
    writeRecords: vi.fn(async () => ({ guest_bookings: 1 })),
    writeProvenance: vi.fn(async () => 1),
  } as ProductionBookingMigrationServices;
}

function plan(withWrite: boolean): ProductionBookingPlan {
  const record = {
    targetProduct: "booking" as const,
    targetTable: "guest_bookings",
    targetId: "13550000-0000-4000-8000-000000000071",
    sourceDatabase: "pms" as const,
    sourceTable: "bookings",
    sourceId: "13550000-0000-4000-8000-000000000071",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
    mutable: true,
    row: { id: "13550000-0000-4000-8000-000000000071" },
  };
  return {
    sourceRunId: RUN,
    checksum: "b".repeat(64),
    records: [record],
    writes: withWrite ? [record] : [],
    provenance: [
      {
        sourceDatabase: "pms",
        sourceTable: "bookings",
        sourceId: record.sourceId,
        targetProduct: "booking",
        targetTable: "guest_bookings",
        targetId: record.targetId,
        sourceChecksum: record.sourceChecksum,
        sourceUpdatedAt: record.sourceUpdatedAt,
        lastMigratedAt: "2026-08-30T00:00:00.000Z",
      },
    ],
    blockers: [],
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
