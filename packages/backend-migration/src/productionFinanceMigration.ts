import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import { writeProductionMigrationProvenance } from "./productionBookingWriter.js";
import { buildProductionFinancePlan } from "./productionFinancePlan.js";
import { readProductionFinanceSnapshot } from "./productionFinanceSnapshotReader.js";
import {
  readProductionFinancePrerequisites,
  readProductionFinanceTargetState,
} from "./productionFinanceTargetReader.js";
import type {
  FinanceTargetRecord,
  ProductionFinancePlan,
  ProductionFinanceTargetState,
} from "./productionFinanceTypes.js";
import {
  writeProductionFinanceDispositions,
  writeProductionFinanceRecords,
} from "./productionFinanceWriter.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type ProductionFinanceMigrationMode = "dry-run" | "apply";
export type ProductionFinanceMigrationReport = {
  sourceRunId: string;
  mode: ProductionFinanceMigrationMode;
  applied: boolean;
  checksum: string;
  counts: ProductionFinancePlan["counts"];
  dispositionCountsByReason: ProductionFinancePlan["parity"]["dispositionCountsByReason"];
  parity: ProductionFinancePlan["parity"];
  blockers: ProductionFinancePlan["blockers"];
};
export type ProductionFinanceMigrationServices = {
  readSnapshot: typeof readProductionFinanceSnapshot;
  readPrerequisites: typeof readProductionFinancePrerequisites;
  readTarget: typeof readProductionFinanceTargetState;
  buildPlan: typeof buildProductionFinancePlan;
  writeRecords: typeof writeProductionFinanceRecords;
  writeDispositions: typeof writeProductionFinanceDispositions;
  writeProvenance: typeof writeProductionMigrationProvenance;
};

const productionServices: ProductionFinanceMigrationServices = {
  readSnapshot: readProductionFinanceSnapshot,
  readPrerequisites: readProductionFinancePrerequisites,
  readTarget: readProductionFinanceTargetState,
  buildPlan: buildProductionFinancePlan,
  writeRecords: writeProductionFinanceRecords,
  writeDispositions: writeProductionFinanceDispositions,
  writeProvenance: writeProductionMigrationProvenance,
};

export async function runProductionFinanceMigration(config: {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionFinanceMigrationMode;
  applyConfirmation?: string;
  max?: number;
}): Promise<ProductionFinanceMigrationReport> {
  assertMode(config.mode);
  if (
    config.mode === "apply" &&
    config.applyConfirmation !== `production-finance:${config.sourceRunId}`
  )
    throw new Error(`Finance apply requires confirmation production-finance:${config.sourceRunId}`);
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: config.max ?? 1,
  });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    return await runProductionFinanceTransaction(client, config);
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function runProductionFinanceTransaction(
  client: QueryClient,
  input: {
    sourceRunId: string;
    mode: ProductionFinanceMigrationMode;
    applyConfirmation?: string;
  },
  services: ProductionFinanceMigrationServices = productionServices,
): Promise<ProductionFinanceMigrationReport> {
  assertMode(input.mode);
  if (
    input.mode === "apply" &&
    input.applyConfirmation !== `production-finance:${input.sourceRunId}`
  )
    throw new Error(`Finance apply requires confirmation production-finance:${input.sourceRunId}`);
  let finished = false;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    if (input.mode === "apply") await lockFinanceTargets(client);
    const snapshot = await services.readSnapshot(client, input.sourceRunId);
    const prerequisites = await services.readPrerequisites(client, input.sourceRunId);
    const emptyTarget: ProductionFinanceTargetState = {
      ...prerequisites,
      records: [],
      provenance: [],
    };
    const preliminary = services.buildPlan({
      sourceRunId: input.sourceRunId,
      completedAt: snapshot.completedAt,
      rows: snapshot.rows,
      target: emptyTarget,
    });
    const target = await services.readTarget(client, preliminary.records, prerequisites);
    const plan = services.buildPlan({
      sourceRunId: input.sourceRunId,
      completedAt: snapshot.completedAt,
      rows: snapshot.rows,
      target,
    });
    if (input.mode === "dry-run" || plan.blockers.length > 0) {
      await client.query("ROLLBACK");
      finished = true;
      return report(input, plan, false);
    }
    const written = await services.writeRecords(client, plan.writes);
    assertWriteCounts(plan.writes, written);
    const dispositionCount = await services.writeDispositions(
      client,
      plan.dispositions,
      input.sourceRunId,
    );
    if (dispositionCount !== plan.dispositions.length)
      throw new Error(
        `Finance disposition writer preserved ${dispositionCount} of ${plan.dispositions.length} planned rows`,
      );
    const provenanceCount = await services.writeProvenance(
      client,
      plan.provenance,
      input.sourceRunId,
    );
    if (provenanceCount !== plan.provenance.length)
      throw new Error(
        `Finance provenance writer applied ${provenanceCount} of ${plan.provenance.length} planned rows`,
      );
    const verifiedTarget = await services.readTarget(client, plan.records, prerequisites);
    const verified = services.buildPlan({
      sourceRunId: input.sourceRunId,
      completedAt: snapshot.completedAt,
      rows: snapshot.rows,
      target: verifiedTarget,
    });
    if (
      verified.blockers.length > 0 ||
      verified.checksum !== plan.checksum ||
      verified.writes.length > 0
    )
      throw new Error("Post-write Finance verification does not match the migration plan");
    await client.query("COMMIT");
    finished = true;
    return report(input, plan, true);
  } catch (error) {
    if (!finished) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function assertWriteCounts(planned: FinanceTargetRecord[], actual: Record<string, number>): void {
  const expected = new Map<string, number>();
  for (const row of planned)
    expected.set(row.targetTable, (expected.get(row.targetTable) ?? 0) + 1);
  for (const [targetTable, count] of expected)
    if (actual[targetTable] !== count)
      throw new Error(
        `Finance ${targetTable} writer applied ${actual[targetTable] ?? 0} of ${count} planned rows`,
      );
}

async function lockFinanceTargets(client: QueryClient): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query(
    `LOCK TABLE identity.users, identity.organizations, identity.organization_resource_links,
                identity.product_entitlements, hotel_catalog.properties, hotel_catalog.property_source_links,
                booking.guest_bookings IN SHARE MODE`,
  );
  await client.query(
    `LOCK TABLE finance.payment_provider_accounts, finance.payment_settings, finance.payout_settings,
                finance.payments, finance.payouts, finance.commission_rules, finance.commission_rate_changes,
                finance.billing_entitlements, finance.stripe_provider_account_compensation_claims,
                platform.production_migration_source_links,
                platform.production_finance_migration_dispositions
     IN SHARE ROW EXCLUSIVE MODE`,
  );
}

function assertMode(mode: unknown): asserts mode is ProductionFinanceMigrationMode {
  if (mode !== "dry-run" && mode !== "apply")
    throw new Error("Finance migration mode must be dry-run or apply");
}

function report(
  input: { sourceRunId: string; mode: ProductionFinanceMigrationMode },
  plan: ProductionFinancePlan,
  applied: boolean,
): ProductionFinanceMigrationReport {
  return {
    sourceRunId: input.sourceRunId,
    mode: input.mode,
    applied,
    checksum: plan.checksum,
    counts: plan.counts,
    dispositionCountsByReason: plan.parity.dispositionCountsByReason,
    parity: plan.parity,
    blockers: plan.blockers,
  };
}
