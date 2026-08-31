import type pg from "pg";

import type { IdentityMigrationBlocker } from "./productionIdentityDisposition.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";
import { PRODUCTION_MARKETPLACE_TABLES } from "./productionMarketplaceTables.js";
import type {
  ExistingMarketplaceTargetRecord,
  MarketplacePropertyLink,
  MarketplaceTargetRecord,
  ProductionMarketplacePrerequisites,
  ProductionMarketplaceTargetState,
} from "./productionMarketplaceTypes.js";

type QueryClient = Pick<pg.ClientBase, "query">;

export async function readProductionMarketplacePrerequisites(
  client: QueryClient,
  sourceRunId: string,
): Promise<ProductionMarketplacePrerequisites> {
  const propertyLinks = await client.query<MarketplacePropertyLink>(
    `SELECT source_id AS "sourceId", property_id::text AS "propertyId", relationship, status,
            metadata ->> 'migrationRunId' AS "migrationRunId"
     FROM hotel_catalog.property_source_links
     WHERE source_system = 'marketplace' AND source_table = 'hotel_profiles'
       AND metadata ->> 'migrationRunId' = $1
     ORDER BY source_id, property_id`,
    [sourceRunId],
  );
  const resourceLinks = await client.query<
    ProductionMarketplacePrerequisites["resourceLinks"][number]
  >(
    `SELECT organization_id::text AS "organizationId", resource_type AS "resourceType",
            resource_id AS "resourceId", relationship, status
     FROM identity.organization_resource_links
     WHERE product = 'marketplace' AND resource_type = ANY($1::text[])
     ORDER BY resource_type, resource_id, organization_id`,
    [["creator_profile", "hotel_profile"]],
  );
  const users = await client.query<{ id: string; name: string | null }>(
    `SELECT id::text, name FROM identity.users ORDER BY id`,
  );
  const publicProperties = await client.query<
    ProductionMarketplacePrerequisites["publicProperties"][number]
  >(
    `SELECT property_id::text AS "propertyId", public_id AS "publicId",
            display_name AS "displayName", canonical_slug AS "canonicalSlug", location
     FROM hotel_catalog.property_public_profile_read_model
     ORDER BY property_id`,
  );
  const media = await client.query<ProductionMarketplacePrerequisites["media"][number]>(
    `SELECT media.id::text AS "mediaObjectId", media.source_url AS "sourceUrl",
            media.source_table AS "sourceTable", media.source_row_id AS "sourceRowId",
            media.source_metadata ->> 'sourceField' AS "sourceField",
            media.visibility, media.purpose, media.lifecycle_status AS "lifecycleStatus",
            media.public_approved AS "publicApproved", variant.public_cdn_url AS "publicUrl",
            media.resource_type AS "resourceType", media.resource_id AS "resourceId"
     FROM platform.media_objects media
     LEFT JOIN platform.media_variants variant
       ON variant.media_object_id = media.id
      AND variant.visibility = 'public'
      AND variant.variant_name = 'original_safe'
     WHERE media.source_system = 'marketplace'
       AND media.source_metadata ->> 'migrationRunId' = $1
       AND media.source_url IS NOT NULL
     ORDER BY media.source_url, media.source_table, media.source_row_id, media.id`,
    [sourceRunId],
  );
  const hotelPreferences = await client.query<
    ProductionMarketplacePrerequisites["hotelPreferences"][number]
  >(
    `SELECT property_id::text AS "propertyId", revision
     FROM marketplace.hotel_collaboration_preferences
     ORDER BY property_id`,
  );
  return {
    propertyLinks: propertyLinks.rows,
    resourceLinks: resourceLinks.rows,
    userIds: users.rows.map((row) => row.id),
    userNames: users.rows,
    publicProperties: publicProperties.rows,
    media: media.rows,
    hotelPreferences: hotelPreferences.rows,
  };
}

export async function readProductionMarketplaceTargetState(
  client: QueryClient,
  candidates: MarketplaceTargetRecord[],
  prerequisites: ProductionMarketplacePrerequisites,
): Promise<ProductionMarketplaceTargetState> {
  const records: ExistingMarketplaceTargetRecord[] = [];
  const grouped = new Map<string, string[]>();
  for (const candidate of candidates) {
    const ids = grouped.get(candidate.targetTable);
    if (ids) ids.push(candidate.targetId);
    else grouped.set(candidate.targetTable, [candidate.targetId]);
  }
  for (const [targetTable, ids] of grouped) {
    const definition = PRODUCTION_MARKETPLACE_TABLES[targetTable];
    if (!definition) throw new Error(`Unsupported Marketplace target table ${targetTable}`);
    const targetId = `${definition.key[0]}::text`;
    const result = await client.query<{ targetId: string; updatedAt: string; rowData: string }>(
      `SELECT ${targetId} AS "targetId", (${definition.freshness})::text AS "updatedAt",
              to_jsonb(target_row)::text AS "rowData"
       FROM ${definition.table} AS target_row
       WHERE ${targetId} = ANY($1::text[])
       ORDER BY ${targetId}`,
      [[...new Set(ids)]],
    );
    records.push(
      ...result.rows.map((row) => ({
        targetProduct: "marketplace",
        targetTable,
        targetId: row.targetId,
        updatedAt: requiredTimestamp(row.updatedAt, `${definition.table}.${definition.freshness}`),
        row: camelize(JSON.parse(row.rowData) as Record<string, unknown>),
      })),
    );
  }

  const requested = [
    ...new Map(
      candidates.map((record) => {
        const link = {
          sourceDatabase: record.sourceDatabase,
          sourceTable: record.sourceTable,
          sourceId: record.sourceId,
          targetProduct: record.targetProduct,
          targetTable: record.targetTable,
          targetId: record.targetId,
        };
        return [provenanceIdentity(link), link] as const;
      }),
    ).values(),
  ];
  const cohort = await client.query<ProductionMigrationSourceLink>(
    `SELECT source_database AS "sourceDatabase", source_table AS "sourceTable",
            source_id AS "sourceId", target_product AS "targetProduct",
            target_table AS "targetTable", target_id AS "targetId",
            source_checksum AS "sourceChecksum", source_updated_at::text AS "sourceUpdatedAt",
            last_migrated_at::text AS "lastMigratedAt"
     FROM platform.production_migration_source_links
     WHERE source_database = 'marketplace' AND target_product = 'marketplace'
       AND target_table = ANY($1::text[])
     ORDER BY source_table, source_id, target_table, target_id`,
    [Object.keys(PRODUCTION_MARKETPLACE_TABLES)],
  );
  const normalized = cohort.rows.map((row) => ({
    ...row,
    sourceUpdatedAt: normalizeTimestamp(row.sourceUpdatedAt, "source_updated_at"),
    lastMigratedAt: requiredTimestamp(row.lastMigratedAt, "last_migrated_at"),
  }));
  const requestedKeys = new Set(requested.map(provenanceIdentity));
  const provenance = normalized.filter((row) => requestedKeys.has(provenanceIdentity(row)));
  const stale = normalized.filter((row) => !requestedKeys.has(provenanceIdentity(row)));
  return {
    ...prerequisites,
    records,
    provenance,
    blockers: [
      ...(await readMarketplaceCollisions(client, candidates)),
      ...(await readStaleMarketplaceTargets(client, stale)),
    ],
  };
}

async function readStaleMarketplaceTargets(
  client: QueryClient,
  stale: ProductionMigrationSourceLink[],
): Promise<IdentityMigrationBlocker[]> {
  const blockers: IdentityMigrationBlocker[] = [];
  const grouped = new Map<string, ProductionMigrationSourceLink[]>();
  for (const link of stale) {
    if (!PRODUCTION_MARKETPLACE_TABLES[link.targetTable]) continue;
    const links = grouped.get(link.targetTable);
    if (links) links.push(link);
    else grouped.set(link.targetTable, [link]);
  }
  for (const [targetTable, links] of grouped) {
    const definition = PRODUCTION_MARKETPLACE_TABLES[targetTable]!;
    const targetId = `${definition.key[0]}::text`;
    const result = await client.query<{ targetId: string }>(
      `SELECT ${targetId} AS "targetId"
       FROM ${definition.table}
       WHERE ${targetId} = ANY($1::text[])
       ORDER BY ${targetId}`,
      [[...new Set(links.map((link) => link.targetId))]],
    );
    const existing = new Set(result.rows.map((row) => row.targetId));
    for (const link of links)
      if (existing.has(link.targetId))
        blockers.push({
          code: "SOURCE_ABSENT_MIGRATED_TARGET",
          source: `${link.sourceDatabase}.${link.sourceTable}`,
          sourceId: link.sourceId,
          message: `marketplace.${link.targetTable} ${link.targetId} remains active but its authoritative source row is absent`,
        });
  }
  return blockers;
}

async function readMarketplaceCollisions(
  client: QueryClient,
  candidates: MarketplaceTargetRecord[],
): Promise<IdentityMigrationBlocker[]> {
  if (!candidates.length) return [];
  const rows = candidates.map((candidate) => ({
    targetTable: candidate.targetTable,
    targetId: candidate.targetId,
    ...candidate.row,
  }));
  const result = await client.query<IdentityMigrationBlocker>(
    `WITH requested AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS source(
         "targetTable" text, "targetId" text, "sourceSystem" text,
         "sourceCreatorId" text, "sourcePlatformId" text, "sourceHotelProfileId" text,
         "sourceOfferId" text, "sourceCompensationOptionId" text,
         "sourceRequirementId" text, "sourceCollaborationId" text,
         "sourceTripId" text, "sourceExternalCollaborationId" text,
         "offerId" uuid, "creatorProfileId" uuid, "lifecycleStatus" text,
         "collaborationId" uuid, "userId" uuid, code text
       )
     )
     SELECT 'TARGET_UNIQUE_CONFLICT' AS code, 'marketplace.creator_profiles' AS source,
            target.id::text AS "sourceId", 'Another creator profile owns this source identity' AS message
     FROM requested JOIN marketplace.creator_profiles target
       ON requested."targetTable" = 'creator_profiles'
      AND target.id::text <> requested."targetId"
      AND target.source_system = requested."sourceSystem"
      AND target.source_creator_id = requested."sourceCreatorId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.creator_platforms', target.id::text,
            'Another creator platform owns this source identity'
     FROM requested JOIN marketplace.creator_platforms target
       ON requested."targetTable" = 'creator_platforms'
      AND target.id::text <> requested."targetId"
      AND target.source_system = requested."sourceSystem"
      AND target.source_platform_id = requested."sourcePlatformId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.marketplace_hotel_profiles', target.property_id::text,
            'Another Marketplace hotel profile owns this source identity'
     FROM requested JOIN marketplace.marketplace_hotel_profiles target
       ON requested."targetTable" = 'marketplace_hotel_profiles'
      AND target.property_id::text <> requested."targetId"
      AND target.source_system = requested."sourceSystem"
      AND target.source_hotel_profile_id = requested."sourceHotelProfileId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.marketplace_offers', target.id::text,
            'Another offer owns this source identity'
     FROM requested JOIN marketplace.marketplace_offers target
       ON requested."targetTable" = 'marketplace_offers'
      AND target.id::text <> requested."targetId"
      AND target.source_system = requested."sourceSystem"
      AND target.source_offer_id = requested."sourceOfferId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.offer_compensation_options', target.id::text,
            'Another compensation option owns this source identity'
     FROM requested JOIN marketplace.offer_compensation_options target
       ON requested."targetTable" = 'offer_compensation_options'
      AND target.id::text <> requested."targetId"
      AND target.source_system = requested."sourceSystem"
      AND target.source_compensation_option_id = requested."sourceCompensationOptionId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.offer_creator_requirements', target.id::text,
            'Another creator requirement owns this source identity or offer'
     FROM requested JOIN marketplace.offer_creator_requirements target
       ON requested."targetTable" = 'offer_creator_requirements'
      AND target.id::text <> requested."targetId"
      AND ((target.source_system = requested."sourceSystem"
            AND target.source_requirement_id = requested."sourceRequirementId")
           OR target.offer_id = requested."offerId")
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.collaborations', target.id::text,
            'Another collaboration owns this source identity'
     FROM requested JOIN marketplace.collaborations target
       ON requested."targetTable" = 'collaborations'
      AND target.id::text <> requested."targetId"
      AND ((target.source_system = requested."sourceSystem"
            AND target.source_collaboration_id = requested."sourceCollaborationId")
           OR (requested."lifecycleStatus" IN ('pending', 'negotiating', 'accepted')
               AND target.lifecycle_status IN ('pending', 'negotiating', 'accepted')
               AND target.offer_id = requested."offerId"
               AND target.creator_profile_id = requested."creatorProfileId"))
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.collaborations', right_side."targetId",
            'Multiple source collaborations collide on the active offer and creator identity'
     FROM requested left_side
     JOIN requested right_side
       ON left_side."targetTable" = 'collaborations'
      AND right_side."targetTable" = 'collaborations'
      AND left_side."targetId" < right_side."targetId"
      AND left_side."lifecycleStatus" IN ('pending', 'negotiating', 'accepted')
      AND right_side."lifecycleStatus" IN ('pending', 'negotiating', 'accepted')
      AND left_side."offerId" = right_side."offerId"
      AND left_side."creatorProfileId" = right_side."creatorProfileId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.creator_ratings', target.id::text,
            'Another creator rating owns this collaboration'
     FROM requested JOIN marketplace.creator_ratings target
       ON requested."targetTable" = 'creator_ratings'
      AND target.id::text <> requested."targetId"
      AND requested."collaborationId" IS NOT NULL
      AND target.collaboration_id = requested."collaborationId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.trips', target.id::text,
            'Another trip owns this source identity'
     FROM requested JOIN marketplace.trips target
       ON requested."targetTable" = 'trips'
      AND target.id::text <> requested."targetId"
      AND target.source_system = requested."sourceSystem"
      AND target.source_trip_id = requested."sourceTripId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.external_collaborations', target.id::text,
            'Another external collaboration owns this source identity'
     FROM requested JOIN marketplace.external_collaborations target
       ON requested."targetTable" = 'external_collaborations'
      AND target.id::text <> requested."targetId"
      AND target.source_system = requested."sourceSystem"
      AND target.source_external_collaboration_id = requested."sourceExternalCollaborationId"
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.invite_codes', target.id::text,
            'Another invite owns this code'
     FROM requested JOIN marketplace.invite_codes target
       ON requested."targetTable" = 'invite_codes'
      AND target.id::text <> requested."targetId" AND target.code = requested.code
     UNION ALL
     SELECT 'TARGET_UNIQUE_CONFLICT', 'marketplace.newsletter_preferences', target.id::text,
            'Another newsletter preference owns this user'
     FROM requested JOIN marketplace.newsletter_preferences target
       ON requested."targetTable" = 'newsletter_preferences'
      AND target.id::text <> requested."targetId" AND target.user_id = requested."userId"
     ORDER BY source, "sourceId"`,
    [JSON.stringify(rows)],
  );
  return result.rows;
}

function provenanceIdentity(value: {
  sourceDatabase: string;
  sourceTable: string;
  sourceId: string;
  targetProduct: string;
  targetTable: string;
  targetId: string;
}): string {
  return [
    value.sourceDatabase,
    value.sourceTable,
    value.sourceId,
    value.targetProduct,
    value.targetTable,
    value.targetId,
  ].join(":");
}

function normalizeTimestamp(value: string | null | undefined, field: string): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid ${field} timestamp: ${value}`);
  return new Date(timestamp).toISOString();
}

function requiredTimestamp(value: string | null | undefined, field: string): string {
  const normalized = normalizeTimestamp(value, field);
  if (!normalized) throw new Error(`Missing required ${field} timestamp`);
  return normalized;
}

function camelize(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_, character: string) => character.toUpperCase()),
      entry,
    ]),
  );
}
