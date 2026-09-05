import { describe, expect, it, vi } from "vitest";

import {
  runProductionFinanceMigration,
  runProductionFinanceTransaction,
  type ProductionFinanceMigrationServices,
} from "./productionFinanceMigration.js";
import type { ProductionFinancePlan } from "./productionFinanceTypes.js";

const RUN = "vay1351-0123456789abcdef01234567";
const APPLY = `production-finance:${RUN}`;

describe("production Finance migration transaction", () => {
  it("rejects programmatic apply without a run-bound confirmation", async () => {
    await expect(
      runProductionFinanceMigration({
        connectionString: "postgresql://unused/unused",
        sourceRunId: RUN,
        mode: "apply",
      }),
    ).rejects.toThrow(`confirmation production-finance:${RUN}`);
  });

  it("always rolls dry-run back without provider or target writes", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    const report = await runProductionFinanceTransaction(
      client as never,
      { sourceRunId: RUN, mode: "dry-run" },
      services,
    );
    expect(report.applied).toBe(false);
    expect(client.sql).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ", "ROLLBACK"]);
    expect(services.writeRecords).not.toHaveBeenCalled();
    expect(services.writeProvenance).not.toHaveBeenCalled();
  });

  it("rejects direct transaction apply without the run-bound confirmation", async () => {
    const client = new TransactionFixture();
    await expect(
      runProductionFinanceTransaction(
        client as never,
        { sourceRunId: RUN, mode: "apply" },
        serviceFixture(),
      ),
    ).rejects.toThrow(`confirmation production-finance:${RUN}`);
    expect(client.sql).toEqual([]);
  });

  it("locks, writes, verifies, and commits only a blocker-free apply", async () => {
    const client = new TransactionFixture();
    const services = serviceFixture();
    let builds = 0;
    services.buildPlan = vi.fn(() => (++builds === 3 ? plan(false) : plan(true)));
    const report = await runProductionFinanceTransaction(
      client as never,
      { sourceRunId: RUN, mode: "apply", applyConfirmation: APPLY },
      services,
    );
    expect(report.applied).toBe(true);
    expect(client.sql[2]).toContain("identity.organization_resource_links");
    expect(client.sql[3]).toContain("LOCK TABLE finance.payment_provider_accounts");
    expect(client.sql[3]).toContain("finance.stripe_provider_account_compensation_claims");
    expect(client.sql[3]).toContain("production_finance_migration_dispositions");
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("rolls back blocked plans and exact write-count mismatches", async () => {
    const blockedClient = new TransactionFixture();
    const blocked = serviceFixture();
    blocked.buildPlan = vi.fn(() => ({
      ...plan(true),
      blockers: [{ code: "STALE", source: "pms.payments", sourceId: "x", message: "blocked" }],
    }));
    const report = await runProductionFinanceTransaction(
      blockedClient as never,
      { sourceRunId: RUN, mode: "apply", applyConfirmation: APPLY },
      blocked,
    );
    expect(report.applied).toBe(false);
    expect(blocked.writeRecords).not.toHaveBeenCalled();
    const mismatchClient = new TransactionFixture();
    const mismatch = serviceFixture();
    mismatch.writeRecords = vi.fn(async () => ({ payments: 0 }));
    await expect(
      runProductionFinanceTransaction(
        mismatchClient as never,
        { sourceRunId: RUN, mode: "apply", applyConfirmation: APPLY },
        mismatch,
      ),
    ).rejects.toThrow("applied 0 of 1");
    expect(mismatchClient.sql.at(-1)).toBe("ROLLBACK");
  });
});

class TransactionFixture {
  sql: string[] = [];
  async query(sql: string) {
    this.sql.push(sql);
    return { rows: [], rowCount: 0 };
  }
}

function serviceFixture(): ProductionFinanceMigrationServices {
  const prerequisites = {
    propertyLinks: [],
    resourceLinks: [],
    guestBookings: [],
    userIds: [],
  };
  return {
    readSnapshot: vi.fn(async () => ({ rows: [], completedAt: "2026-08-30T00:00:00.000Z" })),
    readPrerequisites: vi.fn(async () => prerequisites),
    readTarget: vi.fn(async () => ({ ...prerequisites, records: [], provenance: [] })),
    buildPlan: vi.fn(() => plan(true)),
    writeRecords: vi.fn(async () => ({ payments: 1 })),
    writeDispositions: vi.fn(async (_client, dispositions) => dispositions.length),
    writeProvenance: vi.fn(async () => 1),
  } as ProductionFinanceMigrationServices;
}

function plan(withWrite: boolean): ProductionFinancePlan {
  const record = {
    targetProduct: "finance" as const,
    targetTable: "payments",
    targetId: "00000000-0000-4000-8000-000000000001",
    sourceDatabase: "pms" as const,
    sourceTable: "payments",
    sourceId: "00000000-0000-4000-8000-000000000001",
    sourceChecksum: "a".repeat(64),
    sourceUpdatedAt: "2026-08-30T00:00:00.000Z",
    mutable: true,
    row: { id: "00000000-0000-4000-8000-000000000001" },
  };
  return {
    sourceRunId: RUN,
    checksum: "b".repeat(64),
    records: [record],
    writes: withWrite ? [record] : [],
    provenance: [
      {
        sourceDatabase: "pms",
        sourceTable: "payments",
        sourceId: record.sourceId,
        targetProduct: "finance",
        targetTable: "payments",
        targetId: record.targetId,
        sourceChecksum: record.sourceChecksum,
        sourceUpdatedAt: record.sourceUpdatedAt,
        lastMigratedAt: "2026-08-30T00:00:00.000Z",
      },
    ],
    dispositions: [],
    blockers: [],
    parity: {
      sourceTableCounts: { "pms.payments": 1 },
      targetTableCounts: { "finance.payments": 1 },
      dispositionCountsByReason: {},
      omittedSourceRowCounts: {},
      sourcePaymentAmountsByCurrencyStatusOwner: {},
      omittedPaymentAmountsByCurrencyStatusOwner: {},
      targetPaymentAmountsByCurrencyStatusOwner: {},
      sourcePaymentCountsByCurrencyStatusOwner: {},
      omittedPaymentCountsByCurrencyStatusOwner: {},
      targetPaymentCountsByCurrencyStatusOwner: {},
      sourcePaymentFeesByCurrencyStatusOwner: {},
      omittedPaymentFeesByCurrencyStatusOwner: {},
      targetPaymentFeesByCurrencyStatusOwner: {},
      sourcePaymentNetByCurrencyStatusOwner: {},
      omittedPaymentNetByCurrencyStatusOwner: {},
      targetPaymentNetByCurrencyStatusOwner: {},
      sourcePaymentRefundsByCurrencyStatusOwner: {},
      omittedPaymentRefundsByCurrencyStatusOwner: {},
      targetPaymentRefundsByCurrencyStatusOwner: {},
      sourcePayoutAmountsByCurrencyStatusOwner: {},
      omittedPayoutAmountsByCurrencyStatusOwner: {},
      targetPayoutAmountsByCurrencyStatusOwner: {},
      sourcePayoutCountsByCurrencyStatusOwner: {},
      omittedPayoutCountsByCurrencyStatusOwner: {},
      targetPayoutCountsByCurrencyStatusOwner: {},
      sourcePayoutNetByCurrencyStatusOwner: {},
      omittedPayoutNetByCurrencyStatusOwner: {},
      targetPayoutNetByCurrencyStatusOwner: {},
      sourcePayoutAllocationsByBookingOwner: {},
      omittedPayoutAllocationsByBookingOwner: {},
      targetPayoutAllocationsByBookingOwner: {},
    },
    counts: {
      sourceRows: 1,
      plannedRecords: 1,
      inserts: withWrite ? 1 : 0,
      updates: 0,
      unchanged: withWrite ? 0 : 1,
      preservedNewerTarget: 0,
      preservedTargetDeletions: 0,
      dispositions: 0,
      omittedSourceRows: 0,
    },
  };
}
