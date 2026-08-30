import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import { writeProductionCatalogContent } from "./productionCatalogContentWriter.js";
import { writeProductionCatalogCore } from "./productionCatalogCoreWriter.js";
import type { ExistingCatalogSourceLink } from "./productionCatalogOwnership.js";
import {
  buildProductionCatalogPlan,
  type ProductionCatalogCounts,
  type ProductionCatalogPlan,
} from "./productionCatalogPlan.js";
import { writeProductionCatalogPresentation } from "./productionCatalogPresentationWriter.js";
import { rebuildProductionCatalogPublicProjection } from "./productionCatalogPublicProjection.js";
import { readProductionCatalogSnapshot } from "./productionCatalogSnapshotReader.js";
import { readProductionCatalogTargetState } from "./productionCatalogTargetReader.js";
import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type ProductionCatalogMigrationMode = "dry-run" | "apply";
export type ProductionCatalogMigrationReport = {
  sourceRunId: string;
  mode: ProductionCatalogMigrationMode;
  applied: boolean;
  checksum: string;
  counts: ProductionCatalogCounts;
  preservedTarget: ProductionCatalogPlan["preservedTarget"];
  blockers: IdentityMigrationBlocker[];
};
export type ProductionCatalogMigrationServices = {
  readSnapshot: typeof readProductionCatalogSnapshot;
  readTarget: typeof readProductionCatalogTargetState;
  buildPlan: typeof buildProductionCatalogPlan;
  writeCore: typeof writeProductionCatalogCore;
  writeContent: typeof writeProductionCatalogContent;
  writePresentation: typeof writeProductionCatalogPresentation;
  rebuildPublicProjection: typeof rebuildProductionCatalogPublicProjection;
};

const productionServices: ProductionCatalogMigrationServices = {
  readSnapshot: readProductionCatalogSnapshot,
  readTarget: readProductionCatalogTargetState,
  buildPlan: buildProductionCatalogPlan,
  writeCore: writeProductionCatalogCore,
  writeContent: writeProductionCatalogContent,
  writePresentation: writeProductionCatalogPresentation,
  rebuildPublicProjection: rebuildProductionCatalogPublicProjection,
};

export async function runProductionCatalogMigration(config: {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionCatalogMigrationMode;
  max?: number;
}): Promise<ProductionCatalogMigrationReport> {
  assertMode(config.mode);
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: config.max ?? 1,
  });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    return await runProductionCatalogTransaction(client, config);
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function runProductionCatalogTransaction(
  client: QueryClient,
  input: { sourceRunId: string; mode: ProductionCatalogMigrationMode },
  services: ProductionCatalogMigrationServices = productionServices,
): Promise<ProductionCatalogMigrationReport> {
  assertMode(input.mode);
  let finished = false;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    if (input.mode === "apply") {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        `LOCK TABLE hotel_catalog.properties, hotel_catalog.property_source_links,
                    hotel_catalog.property_slugs, hotel_catalog.property_domains,
                    hotel_catalog.property_locations, hotel_catalog.property_profiles,
                    hotel_catalog.property_media, hotel_catalog.property_amenities,
                    hotel_catalog.property_contact_channels,
                    hotel_catalog.property_policy_summaries,
                    hotel_catalog.property_public_profile_read_model,
                    hotel_catalog.property_owner_revisions,
                    platform.media_objects, platform.media_variants
         IN SHARE ROW EXCLUSIVE MODE`,
      );
    }
    const rows = await services.readSnapshot(client, input.sourceRunId);
    const target = await services.readTarget(client, catalogPropertyIds(rows));
    const plan = services.buildPlan(rows, target);
    if (input.mode === "dry-run" || plan.blockers.length > 0) {
      await client.query("ROLLBACK");
      finished = true;
      return report(input, plan, false);
    }

    const core = await services.writeCore(client, plan.writes, plan.sourceLinks, input.sourceRunId);
    const content = await services.writeContent(client, plan.writes);
    const presentation = await services.writePresentation(client, plan.writes);
    assertWriteCounts(plan, { ...core, ...content, ...presentation });
    const verifiedTarget = await services.readTarget(client, plan.propertyIds);
    assertSourceLinks(plan, verifiedTarget.sourceLinks);
    const verified = services.buildPlan(rows, verifiedTarget);
    if (
      verified.blockers.length > 0 ||
      verified.checksum !== plan.checksum ||
      verified.counts.writes > 0
    )
      throw new Error("Post-write catalog verification does not match the migration plan");
    await services.rebuildPublicProjection(client, plan.propertyIds, input.sourceRunId);

    await client.query("COMMIT");
    finished = true;
    return report(input, plan, true);
  } catch (error) {
    if (!finished) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function catalogPropertyIds(rows: IdentitySourceRow[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.sourceDatabase === "booking" &&
        row.sourceTable === "booking_hotels" &&
        typeof row.data["id"] === "string" &&
        UUID.test(row.data["id"])
          ? [row.data["id"].toLowerCase()]
          : [],
      ),
    ),
  ].sort();
}
function assertWriteCounts(plan: ProductionCatalogPlan, actual: Record<string, number>): void {
  for (const [entity, rows] of Object.entries(plan.writes))
    if (actual[entity] !== rows.length)
      throw new Error(
        `Catalog ${entity} writer applied ${actual[entity] ?? 0} of ${rows.length} planned rows`,
      );
}
function assertSourceLinks(
  plan: ProductionCatalogPlan,
  existing: ExistingCatalogSourceLink[],
): void {
  const links = new Map(
    existing.map((row) => [
      `${row.sourceSystem}:${row.sourceTable}:${row.sourceId}`,
      `${row.propertyId}:${row.relationship ?? ""}`,
    ]),
  );
  for (const row of plan.sourceLinks)
    if (
      links.get(`${row.sourceSystem}:${row.sourceTable}:${row.sourceId}`) !==
      `${row.propertyId}:${row.relationship}`
    )
      throw new Error("Post-write catalog source-link verification failed");
}
function assertMode(mode: unknown): asserts mode is ProductionCatalogMigrationMode {
  if (mode !== "dry-run" && mode !== "apply")
    throw new Error("Catalog migration mode must be dry-run or apply");
}
function report(
  input: { sourceRunId: string; mode: ProductionCatalogMigrationMode },
  plan: ProductionCatalogPlan,
  applied: boolean,
): ProductionCatalogMigrationReport {
  return {
    sourceRunId: input.sourceRunId,
    mode: input.mode,
    applied,
    checksum: plan.checksum,
    counts: plan.counts,
    preservedTarget: plan.preservedTarget,
    blockers: plan.blockers,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
