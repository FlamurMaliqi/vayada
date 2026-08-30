import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import { writeProductionMigrationProvenance } from "./productionBookingWriter.js";
import { buildProductionMarketplacePlan } from "./productionMarketplacePlan.js";
import { readProductionMarketplaceSnapshot } from "./productionMarketplaceSnapshotReader.js";
import {
  readProductionMarketplacePrerequisites,
  readProductionMarketplaceTargetState,
} from "./productionMarketplaceTargetReader.js";
import type {
  MarketplaceTargetRecord,
  ProductionMarketplacePlan,
  ProductionMarketplaceTargetState,
} from "./productionMarketplaceTypes.js";
import { writeProductionMarketplaceRecords } from "./productionMarketplaceWriter.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type ProductionMarketplaceMigrationMode = "dry-run" | "apply";
export type ProductionMarketplaceMigrationReport = {
  sourceRunId: string;
  mode: ProductionMarketplaceMigrationMode;
  applied: boolean;
  checksum: string;
  counts: ProductionMarketplacePlan["counts"];
  parity: ProductionMarketplacePlan["parity"];
  blockers: ProductionMarketplacePlan["blockers"];
};
export type ProductionMarketplaceMigrationServices = {
  readSnapshot: typeof readProductionMarketplaceSnapshot;
  readPrerequisites: typeof readProductionMarketplacePrerequisites;
  readTarget: typeof readProductionMarketplaceTargetState;
  buildPlan: typeof buildProductionMarketplacePlan;
  writeRecords: typeof writeProductionMarketplaceRecords;
  writeProvenance: typeof writeProductionMigrationProvenance;
};

const productionServices: ProductionMarketplaceMigrationServices = {
  readSnapshot: readProductionMarketplaceSnapshot,
  readPrerequisites: readProductionMarketplacePrerequisites,
  readTarget: readProductionMarketplaceTargetState,
  buildPlan: buildProductionMarketplacePlan,
  writeRecords: writeProductionMarketplaceRecords,
  writeProvenance: writeProductionMigrationProvenance,
};

export async function runProductionMarketplaceMigration(config: {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionMarketplaceMigrationMode;
  applyConfirmation?: string;
  max?: number;
}): Promise<ProductionMarketplaceMigrationReport> {
  assertMode(config.mode);
  if (
    config.mode === "apply" &&
    config.applyConfirmation !== `production-marketplace:${config.sourceRunId}`
  )
    throw new Error(
      `Marketplace apply requires confirmation production-marketplace:${config.sourceRunId}`,
    );
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: config.max ?? 1,
  });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    return await runProductionMarketplaceTransaction(client, config);
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function runProductionMarketplaceTransaction(
  client: QueryClient,
  input: { sourceRunId: string; mode: ProductionMarketplaceMigrationMode },
  services: ProductionMarketplaceMigrationServices = productionServices,
): Promise<ProductionMarketplaceMigrationReport> {
  assertMode(input.mode);
  let finished = false;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    if (input.mode === "apply") await lockMarketplaceTargets(client);
    const snapshot = await services.readSnapshot(client, input.sourceRunId);
    const prerequisites = await services.readPrerequisites(client, input.sourceRunId);
    const emptyTarget: ProductionMarketplaceTargetState = {
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
    const provenanceCount = await services.writeProvenance(
      client,
      plan.provenance,
      input.sourceRunId,
    );
    if (provenanceCount !== plan.provenance.length)
      throw new Error(
        `Marketplace provenance writer applied ${provenanceCount} of ${plan.provenance.length} planned rows`,
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
      throw new Error("Post-write Marketplace verification does not match the migration plan");
    await client.query("COMMIT");
    finished = true;
    return report(input, plan, true);
  } catch (error) {
    if (!finished) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function assertWriteCounts(
  planned: MarketplaceTargetRecord[],
  actual: Record<string, number>,
): void {
  const expected = new Map<string, number>();
  for (const row of planned)
    expected.set(row.targetTable, (expected.get(row.targetTable) ?? 0) + 1);
  for (const [targetTable, count] of expected)
    if (actual[targetTable] !== count)
      throw new Error(
        `Marketplace ${targetTable} writer applied ${actual[targetTable] ?? 0} of ${count} planned rows`,
      );
}

async function lockMarketplaceTargets(client: QueryClient): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query(
    `LOCK TABLE identity.users, identity.organizations,
                identity.organization_resource_links,
                hotel_catalog.properties, hotel_catalog.property_source_links,
                hotel_catalog.property_public_profile_read_model,
                platform.media_objects, platform.media_variants
     IN SHARE MODE`,
  );
  await client.query(
    `LOCK TABLE marketplace.creator_profiles, marketplace.creator_platforms,
                marketplace.marketplace_hotel_profiles, marketplace.marketplace_offers,
                marketplace.offer_compensation_options, marketplace.offer_creator_requirements,
                marketplace.collaborations, marketplace.creator_ratings,
                marketplace.collaboration_deliverables, marketplace.marketplace_chat_messages,
                marketplace.trips, marketplace.external_collaborations,
                marketplace.marketplace_notifications, marketplace.invite_codes,
                marketplace.newsletter_preferences, marketplace.marketplace_offer_read_model,
                platform.production_migration_source_links
     IN SHARE ROW EXCLUSIVE MODE`,
  );
}

function assertMode(mode: unknown): asserts mode is ProductionMarketplaceMigrationMode {
  if (mode !== "dry-run" && mode !== "apply")
    throw new Error("Marketplace migration mode must be dry-run or apply");
}

function report(
  input: { sourceRunId: string; mode: ProductionMarketplaceMigrationMode },
  plan: ProductionMarketplacePlan,
  applied: boolean,
): ProductionMarketplaceMigrationReport {
  return {
    sourceRunId: input.sourceRunId,
    mode: input.mode,
    applied,
    checksum: plan.checksum,
    counts: plan.counts,
    parity: plan.parity,
    blockers: plan.blockers,
  };
}
