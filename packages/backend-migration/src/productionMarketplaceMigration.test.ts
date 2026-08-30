import { describe, expect, it, vi } from "vitest";

import {
  runProductionMarketplaceMigration,
  runProductionMarketplaceTransaction,
  type ProductionMarketplaceMigrationServices,
} from "./productionMarketplaceMigration.js";
import type { ProductionMarketplacePlan } from "./productionMarketplaceTypes.js";

const RUN = "vay1351-0123456789abcdef01234567";

describe("production Marketplace migration transaction", () => {
  it("rejects programmatic apply without explicit run-bound confirmation", async () => {
    await expect(
      runProductionMarketplaceMigration({
        connectionString: "postgresql://unused/unused",
        sourceRunId: RUN,
        mode: "apply",
      }),
    ).rejects.toThrow(`confirmation production-marketplace:${RUN}`);
  });

  it("always rolls a dry-run back without writing", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    const report = await runProductionMarketplaceTransaction(
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
    const report = await runProductionMarketplaceTransaction(
      client as never,
      { sourceRunId: RUN, mode: "apply" },
      services,
    );
    expect(report.applied).toBe(true);
    expect(client.sql[1]).toContain("lock_timeout");
    expect(client.sql[2]).toContain("identity.organization_resource_links");
    expect(client.sql[3]).toContain("LOCK TABLE marketplace.creator_profiles");
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("rolls back when exact writer counts disagree", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    services.writeRecords = vi.fn(async () => ({ creator_profiles: 0 }));
    await expect(
      runProductionMarketplaceTransaction(
        client as never,
        { sourceRunId: RUN, mode: "apply" },
        services,
      ),
    ).rejects.toThrow("applied 0 of 1");
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("never writes a blocked apply plan", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    services.buildPlan = vi.fn(() => ({
      ...plan(true),
      blockers: [
        { code: "STALE", source: "marketplace.creators", sourceId: "x", message: "blocked" },
      ],
    }));
    const report = await runProductionMarketplaceTransaction(
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

function serviceFixture(): ProductionMarketplaceMigrationServices {
  const prerequisites = {
    propertyLinks: [],
    resourceLinks: [],
    userIds: [],
    userNames: [],
    publicProperties: [],
    media: [],
    hotelPreferences: [],
  };
  return {
    readSnapshot: vi.fn(async () => ({
      rows: [],
      completedAt: "2026-08-30T00:00:00.000Z",
    })),
    readPrerequisites: vi.fn(async () => prerequisites),
    readTarget: vi.fn(async () => ({ ...prerequisites, records: [], provenance: [] })),
    buildPlan: vi.fn(() => plan(true)),
    writeRecords: vi.fn(async () => ({ creator_profiles: 1 })),
    writeProvenance: vi.fn(async () => 1),
  } as ProductionMarketplaceMigrationServices;
}

function plan(withWrite: boolean): ProductionMarketplacePlan {
  const record = {
    targetProduct: "marketplace" as const,
    targetTable: "creator_profiles",
    targetId: "00000000-0000-4000-8000-000000000001",
    sourceDatabase: "marketplace" as const,
    sourceTable: "creators",
    sourceId: "00000000-0000-4000-8000-000000000001",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
    mutable: true as const,
    row: { id: "00000000-0000-4000-8000-000000000001" },
  };
  return {
    sourceRunId: RUN,
    checksum: "b".repeat(64),
    records: [record],
    writes: withWrite ? [record] : [],
    provenance: [
      {
        sourceDatabase: "marketplace",
        sourceTable: "creators",
        sourceId: record.sourceId,
        targetProduct: "marketplace",
        targetTable: "creator_profiles",
        targetId: record.targetId,
        sourceChecksum: record.sourceChecksum,
        sourceUpdatedAt: record.sourceUpdatedAt,
        lastMigratedAt: "2026-08-30T00:00:00.000Z",
      },
    ],
    blockers: [],
    parity: {
      sourceTableCounts: { "marketplace.creators": 1 },
      targetTableCounts: { "marketplace.creator_profiles": 1 },
      sourceCountsByProperty: {},
      targetCountsByProperty: {},
      preferenceDraftsByProperty: {},
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
