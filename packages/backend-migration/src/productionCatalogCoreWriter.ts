import type pg from "pg";

import type { PlannedCatalogSourceLink } from "./productionCatalogOwnership.js";
import type { ReconciledCatalogWrites } from "./productionCatalogReconciliation.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type CatalogCoreWriteCounts = {
  properties: number;
  sourceLinks: number;
  slugs: number;
  locations: number;
};

export async function writeProductionCatalogCore(
  client: QueryClient,
  writes: ReconciledCatalogWrites,
  sourceLinks: PlannedCatalogSourceLink[],
  runId: string,
): Promise<CatalogCoreWriteCounts> {
  const properties = await client.query(
    `INSERT INTO hotel_catalog.properties
       (id, public_id, display_name, property_type, category, star_rating, default_locale,
        supported_locales, profile_status, completeness_reasons, created_at, updated_at)
     SELECT source.id, source."publicId", source."displayName", source."propertyType",
            source.category, source."starRating", source."defaultLocale",
            source."supportedLocales", source."profileStatus", source."completenessReasons",
            source."createdAt", source."updatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       id uuid, "publicId" text, "displayName" text, "propertyType" text, category text,
       "starRating" numeric, "defaultLocale" text, "supportedLocales" text[],
       "profileStatus" text, "completenessReasons" text[], "createdAt" timestamptz,
       "updatedAt" timestamptz)
     ON CONFLICT (id) DO UPDATE SET
       public_id = EXCLUDED.public_id, display_name = EXCLUDED.display_name,
       property_type = EXCLUDED.property_type, category = EXCLUDED.category,
       star_rating = EXCLUDED.star_rating, default_locale = EXCLUDED.default_locale,
       supported_locales = EXCLUDED.supported_locales,
       updated_at = EXCLUDED.updated_at
     WHERE hotel_catalog.properties.updated_at < EXCLUDED.updated_at`,
    [JSON.stringify(writes.properties)],
  );
  const links = await client.query(
    `INSERT INTO hotel_catalog.property_source_links
       (property_id, source_system, source_table, source_id, relationship, metadata)
     SELECT source."propertyId", source."sourceSystem", source."sourceTable", source."sourceId",
            source.relationship, jsonb_build_object('migrationRunId', $2::text)
     FROM jsonb_to_recordset($1::jsonb) AS source(
       "propertyId" uuid, "sourceSystem" text, "sourceTable" text, "sourceId" text,
       relationship text)
     ON CONFLICT (source_system, source_table, source_id) DO UPDATE SET
       metadata = hotel_catalog.property_source_links.metadata
         || jsonb_build_object('migrationRunId', $2::text)
     WHERE hotel_catalog.property_source_links.property_id = EXCLUDED.property_id
       AND hotel_catalog.property_source_links.relationship = EXCLUDED.relationship`,
    [JSON.stringify(sourceLinks), runId],
  );
  const slugs = await client.query(
    `INSERT INTO hotel_catalog.property_slugs
       (id, property_id, slug, locale, purpose, status, redirects_to_id, created_at, updated_at)
     SELECT source.id, source."propertyId", source.slug, NULL, source.purpose, source.status,
            source."redirectsToId", source."updatedAt", source."updatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       id uuid, "propertyId" uuid, slug text, purpose text, status text,
       "redirectsToId" uuid, "updatedAt" timestamptz)
     ON CONFLICT (slug, COALESCE(locale, '')) DO UPDATE SET
       purpose = EXCLUDED.purpose, status = EXCLUDED.status,
       redirects_to_id = EXCLUDED.redirects_to_id, updated_at = EXCLUDED.updated_at
     WHERE hotel_catalog.property_slugs.property_id = EXCLUDED.property_id
       AND hotel_catalog.property_slugs.updated_at < EXCLUDED.updated_at`,
    [JSON.stringify(writes.slugs)],
  );
  const locations = await client.query(
    `INSERT INTO hotel_catalog.property_locations
       (property_id, country_code, region, city, street_address, postal_code,
        raw_marketplace_location, latitude, longitude, timezone, source_confidence,
        migration_notes, updated_at)
     SELECT source."propertyId", source."countryCode", source.region, source.city,
            source."streetAddress", source."postalCode", source."rawMarketplaceLocation",
            source.latitude, source.longitude, source.timezone, source."sourceConfidence",
            source."migrationNotes", source."updatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       "propertyId" uuid, "countryCode" text, region text, city text, "streetAddress" text,
       "postalCode" text, "rawMarketplaceLocation" text, latitude numeric, longitude numeric,
       timezone text, "sourceConfidence" text, "migrationNotes" text, "updatedAt" timestamptz)
     ON CONFLICT (property_id) DO UPDATE SET
       country_code = EXCLUDED.country_code, region = EXCLUDED.region, city = EXCLUDED.city,
       street_address = EXCLUDED.street_address, postal_code = EXCLUDED.postal_code,
       raw_marketplace_location = EXCLUDED.raw_marketplace_location,
       latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
       timezone = EXCLUDED.timezone, source_confidence = EXCLUDED.source_confidence,
       migration_notes = EXCLUDED.migration_notes, updated_at = EXCLUDED.updated_at
     WHERE hotel_catalog.property_locations.updated_at < EXCLUDED.updated_at
       AND COALESCE((SELECT revision FROM hotel_catalog.property_owner_revisions
                     WHERE property_id = EXCLUDED.property_id
                       AND owner_key = 'hotel_catalog.location'), 1) <= 1`,
    [JSON.stringify(writes.locations)],
  );
  return {
    properties: properties.rowCount ?? 0,
    sourceLinks: links.rowCount ?? 0,
    slugs: slugs.rowCount ?? 0,
    locations: locations.rowCount ?? 0,
  };
}
