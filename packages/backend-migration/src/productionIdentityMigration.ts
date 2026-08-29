import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import type { IdentityMigrationBlocker } from "./productionIdentityDisposition.js";
import { writeProductionIdentityCore } from "./productionIdentityCoreWriter.js";
import {
  buildProductionIdentityPlan,
  type ProductionIdentityCounts,
  type ProductionIdentityPlan,
} from "./productionIdentityPlan.js";
import { writeProductionIdentityPrivacyAudit } from "./productionIdentityPrivacyAuditWriter.js";
import { readProductionIdentitySnapshot } from "./productionIdentitySnapshotReader.js";
import { readProductionIdentityTargetState } from "./productionIdentityTargetReader.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type ProductionIdentityMigrationMode = "dry-run" | "apply";
export type ProductionIdentityMigrationReport = {
  sourceRunId: string;
  mode: ProductionIdentityMigrationMode;
  applied: boolean;
  checksum: string;
  counts: ProductionIdentityCounts;
  retiredAuthRows: Record<string, number>;
  blockers: IdentityMigrationBlocker[];
};
export type ProductionIdentityMigrationServices = {
  readSnapshot: typeof readProductionIdentitySnapshot;
  readTarget: typeof readProductionIdentityTargetState;
  buildPlan: typeof buildProductionIdentityPlan;
  writeCore: typeof writeProductionIdentityCore;
  writePrivacyAudit: typeof writeProductionIdentityPrivacyAudit;
};

const productionServices: ProductionIdentityMigrationServices = {
  readSnapshot: readProductionIdentitySnapshot,
  readTarget: readProductionIdentityTargetState,
  buildPlan: buildProductionIdentityPlan,
  writeCore: writeProductionIdentityCore,
  writePrivacyAudit: writeProductionIdentityPrivacyAudit,
};

export async function runProductionIdentityMigration(config: {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionIdentityMigrationMode;
  max?: number;
}): Promise<ProductionIdentityMigrationReport> {
  assertMode(config.mode);
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: config.max ?? 1,
  });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    return await runProductionIdentityTransaction(client, config);
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function runProductionIdentityTransaction(
  client: QueryClient,
  input: { sourceRunId: string; mode: ProductionIdentityMigrationMode },
  services: ProductionIdentityMigrationServices = productionServices,
): Promise<ProductionIdentityMigrationReport> {
  assertMode(input.mode);
  let transactionFinished = false;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    const rows = await services.readSnapshot(client, input.sourceRunId);
    const existing = await services.readTarget(client, rows);
    const plan = services.buildPlan(rows, existing);
    if (input.mode === "dry-run" || plan.blockers.length > 0) {
      await client.query("ROLLBACK");
      transactionFinished = true;
      return report(input, plan, false);
    }

    await services.writeCore(client, plan);
    await services.writePrivacyAudit(client, plan);
    const verified = services.buildPlan(rows, await services.readTarget(client, rows));
    if (verified.blockers.length > 0 || verified.checksum !== plan.checksum)
      throw new Error("Post-write identity verification does not match the migration plan");

    await client.query("COMMIT");
    transactionFinished = true;
    return report(input, plan, true);
  } catch (error) {
    if (!transactionFinished) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function assertMode(mode: unknown): asserts mode is ProductionIdentityMigrationMode {
  if (mode !== "dry-run" && mode !== "apply")
    throw new Error("Identity migration mode must be dry-run or apply");
}

function report(
  input: { sourceRunId: string; mode: ProductionIdentityMigrationMode },
  plan: ProductionIdentityPlan,
  applied: boolean,
): ProductionIdentityMigrationReport {
  return {
    ...input,
    applied,
    checksum: plan.checksum,
    counts: plan.counts,
    retiredAuthRows: plan.retiredAuthRows,
    blockers: plan.blockers,
  };
}
