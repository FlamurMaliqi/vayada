import type pg from "pg";

import type { ReconciledCatalogWrites } from "./productionCatalogReconciliation.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type CatalogPresentationWriteCounts = { domains: number; media: number };

export async function writeProductionCatalogPresentation(
  client: QueryClient,
  writes: ReconciledCatalogWrites,
): Promise<CatalogPresentationWriteCounts> {
  const domains = await client.query(
    `INSERT INTO hotel_catalog.property_domains
       (id, property_id, hostname, verification_status, canonical_when_verified,
        verified_at, created_at, updated_at)
     SELECT source.id, source."propertyId", source.hostname, source."verificationStatus",
            source."canonicalWhenVerified", source."verifiedAt", source."updatedAt",
            source."updatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       id uuid, "propertyId" uuid, hostname text, "verificationStatus" text,
       "canonicalWhenVerified" boolean, "verifiedAt" timestamptz, "updatedAt" timestamptz)
     ON CONFLICT DO NOTHING`,
    [JSON.stringify(writes.domains)],
  );
  const media = await client.query(
    `INSERT INTO hotel_catalog.property_media
       (id, property_id, media_type, url, sort_order, source_system, public_approved,
        platform_media_object_id, created_at, updated_at)
     SELECT source.id, source."propertyId", source."mediaType",
            'platform-media:' || media_object.id::text, source."sortOrder",
            source."sourceSystem", source."publicApproved", media_object.id,
            source."updatedAt", source."updatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       id uuid, "propertyId" uuid, "platformMediaObjectId" uuid, "mediaType" text,
       "sortOrder" integer, "sourceSystem" text, "publicApproved" boolean,
       "updatedAt" timestamptz)
     JOIN platform.media_objects media_object
       ON media_object.id = source."platformMediaObjectId"
      AND media_object.property_id = source."propertyId"
      AND media_object.purpose = CASE source."mediaType"
        WHEN 'hero_image' THEN 'property.hero_image'
        WHEN 'gallery_image' THEN 'property.gallery_image'
        WHEN 'logo' THEN 'property.logo'
      END
      AND (
        media_object.lifecycle_status = 'external_reference'
        OR (
          media_object.lifecycle_status = 'active'
          AND (
            media_object.visibility = 'private'
            OR (media_object.visibility = 'public' AND media_object.public_approved)
          )
        )
      )
     ON CONFLICT (id) DO UPDATE SET
       media_type = EXCLUDED.media_type, url = EXCLUDED.url,
       sort_order = EXCLUDED.sort_order, source_system = EXCLUDED.source_system,
       platform_media_object_id = EXCLUDED.platform_media_object_id,
       updated_at = EXCLUDED.updated_at
     WHERE hotel_catalog.property_media.property_id = EXCLUDED.property_id
       AND hotel_catalog.property_media.updated_at < EXCLUDED.updated_at`,
    [JSON.stringify(writes.media)],
  );
  const counts = { domains: domains.rowCount ?? 0, media: media.rowCount ?? 0 };
  if (counts.domains !== writes.domains.length || counts.media !== writes.media.length)
    throw new Error("Catalog presentation write lost its ownership or freshness race");
  return counts;
}
