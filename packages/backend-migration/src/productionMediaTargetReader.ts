import type pg from "pg";

import type { ProductionMediaTargetState } from "./productionMediaPlan.js";

type QueryClient = Pick<pg.ClientBase, "query">;

export async function readProductionMediaTargetState(
  client: QueryClient,
  sourceRunId: string,
): Promise<ProductionMediaTargetState> {
  const propertyLinks = await client.query<ProductionMediaTargetState["propertyLinks"][number]>(
    `SELECT source_system AS "sourceSystem", source_table AS "sourceTable",
            source_id AS "sourceId", property_id::text AS "propertyId", relationship, status,
            metadata ->> 'migrationRunId' AS "migrationRunId",
            metadata ->> 'migrationDisposition' AS "migrationDisposition"
       FROM hotel_catalog.property_source_links
      WHERE (source_system, source_table) IN (
              ('booking', 'booking_hotels'),
              ('marketplace', 'hotel_profiles'),
              ('pms', 'hotels')
            )
        AND metadata ->> 'migrationRunId' = $1
      ORDER BY source_system, source_table, source_id, property_id`,
    [sourceRunId],
  );
  const resourceLinks = await client.query<ProductionMediaTargetState["resourceLinks"][number]>(
    `SELECT organization_id::text AS "organizationId", product, resource_type AS "resourceType",
            resource_id AS "resourceId", relationship, status
       FROM identity.organization_resource_links
      WHERE (product, resource_type) IN (
              ('booking', 'booking_hotel'),
              ('marketplace', 'creator_profile'),
              ('marketplace', 'hotel_profile'),
              ('pms', 'pms_hotel')
            )
      ORDER BY product, resource_type, resource_id, organization_id`,
  );
  const mediaObjects = await client.query<ProductionMediaTargetState["mediaObjects"][number]>(
    `SELECT media.id::text, media.source_system AS "sourceSystem",
            media.source_table AS "sourceTable", media.source_row_id AS "sourceRowId",
            media.source_url AS "sourceUrl", media.purpose,
            media.lifecycle_status AS "lifecycleStatus", media.visibility,
            media.public_approved AS "publicApproved",
            media.source_metadata ->> 'migrationRunId' AS "migrationRunId",
            media.checksum_sha256 AS "checksumSha256",
            media.bucket, media.storage_kind AS "storageKind", media.storage_key AS "storageKey",
            media.property_id::text AS "propertyId",
            media.owner_organization_id::text AS "ownerOrganizationId",
            media.resource_product AS "resourceProduct", media.resource_type AS "resourceType",
            media.resource_id AS "resourceId", media.retained_until::text AS "retainedUntil",
            media.source_metadata ->> 'migrationCase' AS "migrationCase",
            COALESCE(jsonb_agg(jsonb_build_object(
              'name', variant.variant_name,
              'visibility', variant.visibility,
              'storageKey', variant.storage_key,
              'publicCdnUrl', variant.public_cdn_url
            ) ORDER BY variant.variant_name)
              FILTER (WHERE variant.variant_name IS NOT NULL), '[]'::jsonb) AS variants
       FROM platform.media_objects media
       LEFT JOIN platform.media_variants variant ON variant.media_object_id = media.id
      WHERE media.source_system IN ('booking', 'marketplace', 'pms')
        AND media.source_table IS NOT NULL
        AND media.source_row_id IS NOT NULL
      GROUP BY media.id
      ORDER BY media.source_system, media.source_table, media.source_row_id, media.purpose`,
  );
  return {
    propertyLinks: propertyLinks.rows,
    resourceLinks: resourceLinks.rows,
    mediaObjects: mediaObjects.rows.map((media) => ({
      ...media,
      retainedUntil: media.retainedUntil ? new Date(media.retainedUntil).toISOString() : null,
    })),
  };
}
