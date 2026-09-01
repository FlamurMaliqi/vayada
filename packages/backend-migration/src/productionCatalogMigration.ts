import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import { writeProductionCatalogContent } from "./productionCatalogContentWriter.js";
import { writeProductionCatalogCore } from "./productionCatalogCoreWriter.js";
import type { ExistingCatalogSourceLink } from "./productionCatalogOwnership.js";
import { stableCatalogId } from "./productionCatalogValues.js";
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
  quarantinedSources: ProductionCatalogPlan["quarantinedSources"];
  preservedTarget: ProductionCatalogPlan["preservedTarget"];
  blockers: IdentityMigrationBlocker[];
};
export type ProductionCatalogPrerequisiteReport = ProductionCatalogMigrationReport & {
  remainingMediaBlockers: IdentityMigrationBlocker[];
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

export async function runProductionCatalogPrerequisites(config: {
  connectionString: string;
  sourceRunId: string;
  mode: ProductionCatalogMigrationMode;
  max?: number;
}): Promise<ProductionCatalogPrerequisiteReport> {
  assertMode(config.mode);
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: config.max ?? 1,
  });
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    return await runProductionCatalogPrerequisiteTransaction(client, config);
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function runProductionCatalogPrerequisiteTransaction(
  client: QueryClient,
  input: { sourceRunId: string; mode: ProductionCatalogMigrationMode },
  services: ProductionCatalogMigrationServices = productionServices,
): Promise<ProductionCatalogPrerequisiteReport> {
  assertMode(input.mode);
  let finished = false;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    if (input.mode === "apply") {
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        `LOCK TABLE identity.organization_resource_links, identity.product_entitlements,
                    hotel_catalog.properties, hotel_catalog.property_source_links,
                    hotel_catalog.property_slugs, hotel_catalog.property_locations,
                    hotel_catalog.property_profiles, hotel_catalog.property_amenities,
                    hotel_catalog.property_contact_channels,
                    hotel_catalog.property_policy_summaries,
                    hotel_catalog.property_owner_revisions,
                    platform.production_media_migration_quarantines
         IN SHARE ROW EXCLUSIVE MODE`,
      );
    }
    const rows = await services.readSnapshot(client, input.sourceRunId);
    const target = await services.readTarget(client, catalogPropertyIds(rows), input.sourceRunId);
    const plan = services.buildPlan(rows, target);
    const remainingMediaBlockers = plan.blockers.filter(isMediaPrerequisiteBlocker);
    const blocking = plan.blockers.filter((blocker) => !isMediaPrerequisiteBlocker(blocker));
    if (input.mode === "dry-run" || blocking.length > 0) {
      await client.query("ROLLBACK");
      finished = true;
      return { ...report(input, plan, false), blockers: blocking, remainingMediaBlockers };
    }

    const core = await services.writeCore(
      client,
      plan.writes,
      plan.sourceLinks,
      input.sourceRunId,
      "prerequisites",
    );
    const content = await services.writeContent(client, plan.writes);
    assertPrerequisiteWriteCounts(plan, { ...core, ...content });
    const verifiedTarget = await services.readTarget(client, plan.propertyIds, input.sourceRunId);
    assertSourceLinks(plan, verifiedTarget.sourceLinks);
    const verified = services.buildPlan(rows, verifiedTarget);
    const verifiedBlocking = verified.blockers.filter(
      (blocker) => !isMediaPrerequisiteBlocker(blocker),
    );
    if (
      verifiedBlocking.length > 0 ||
      verified.checksum !== plan.checksum ||
      prerequisiteWriteCount(verified) > 0
    )
      throw new Error(
        "Post-write catalog prerequisite verification does not match the migration plan",
      );

    await client.query("COMMIT");
    finished = true;
    return {
      ...report(input, plan, true),
      blockers: [],
      remainingMediaBlockers: verified.blockers.filter(isMediaPrerequisiteBlocker),
    };
  } catch (error) {
    if (!finished) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
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
        `LOCK TABLE identity.organization_resource_links, identity.product_entitlements,
                    hotel_catalog.properties, hotel_catalog.property_source_links,
                    hotel_catalog.property_slugs, hotel_catalog.property_domains,
                    hotel_catalog.property_locations, hotel_catalog.property_profiles,
                    hotel_catalog.property_media, hotel_catalog.property_amenities,
                    hotel_catalog.property_contact_channels,
                    hotel_catalog.property_policy_summaries,
                    hotel_catalog.property_public_profile_read_model,
                    hotel_catalog.property_owner_revisions,
                    platform.media_objects, platform.media_variants,
                    platform.production_media_migration_quarantines
         IN SHARE ROW EXCLUSIVE MODE`,
      );
    }
    const rows = await services.readSnapshot(client, input.sourceRunId);
    const target = await services.readTarget(client, catalogPropertyIds(rows), input.sourceRunId);
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
    const verifiedTarget = await services.readTarget(client, plan.propertyIds, input.sourceRunId);
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
      rows.flatMap((row) => {
        const sourceId = row.data["id"];
        if (typeof sourceId !== "string" || !UUID.test(sourceId)) return [];
        const normalized = sourceId.toLowerCase();
        if (row.sourceDatabase === "booking" && row.sourceTable === "booking_hotels")
          return [normalized];
        if (
          (row.sourceDatabase === "pms" && row.sourceTable === "hotels") ||
          (row.sourceDatabase === "marketplace" && row.sourceTable === "hotel_profiles")
        )
          return [
            stableCatalogId(
              "private-property",
              `${row.sourceDatabase}:${row.sourceTable}:${normalized}`,
            ),
          ];
        return [];
      }),
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
function assertPrerequisiteWriteCounts(
  plan: ProductionCatalogPlan,
  actual: Record<string, number>,
): void {
  const expected: Record<string, number> = {
    properties: plan.writes.properties.length,
    sourceLinks: plan.sourceLinks.length,
    slugs: plan.writes.slugs.length,
    locations: plan.writes.locations.length,
    profiles: plan.writes.profiles.length,
    amenities: plan.writes.amenities.length,
    contacts: plan.writes.contacts.length,
    policies: plan.writes.policies.length,
  };
  for (const [entity, count] of Object.entries(expected))
    if (actual[entity] !== count)
      throw new Error(
        `Catalog prerequisite ${entity} writer applied ${actual[entity] ?? 0} of ${count} planned rows`,
      );
}
function prerequisiteWriteCount(plan: ProductionCatalogPlan): number {
  return [
    plan.writes.properties,
    plan.writes.slugs,
    plan.writes.locations,
    plan.writes.profiles,
    plan.writes.amenities,
    plan.writes.contacts,
    plan.writes.policies,
  ].reduce((count, rows) => count + rows.length, 0);
}
function isMediaPrerequisiteBlocker(blocker: IdentityMigrationBlocker): boolean {
  return blocker.code === "UNRESOLVED_MEDIA_REFERENCE" || blocker.code === "MEDIA_NOT_READY";
}
function assertSourceLinks(
  plan: ProductionCatalogPlan,
  existing: ExistingCatalogSourceLink[],
): void {
  const links = new Map(
    existing.map((row) => [
      `${row.sourceSystem}:${row.sourceTable}:${row.sourceId}`,
      `${row.propertyId}:${row.relationship ?? ""}:${row.status ?? ""}`,
    ]),
  );
  for (const row of plan.sourceLinks)
    if (
      links.get(`${row.sourceSystem}:${row.sourceTable}:${row.sourceId}`) !==
      `${row.propertyId}:${row.relationship}:active`
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
    quarantinedSources: plan.quarantinedSources,
    preservedTarget: plan.preservedTarget,
    blockers: plan.blockers,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
