import type pg from "pg";

import type {
  ExistingCatalogDomain,
  ExistingCatalogMediaObject,
} from "./productionCatalogPresentationPlan.js";
import type { CatalogOwnerLink, ExistingCatalogSourceLink } from "./productionCatalogOwnership.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type CatalogTargetRow = Record<string, unknown> & { updatedAt: string };
export type CatalogOwnerRevision = {
  propertyId: string;
  ownerKey: "hotel_catalog.location" | "hotel_catalog.policy";
  revision: string;
};
export type ProductionCatalogTargetState = {
  properties: CatalogTargetRow[];
  sourceLinks: ExistingCatalogSourceLink[];
  ownerLinks: CatalogOwnerLink[];
  slugs: CatalogTargetRow[];
  domains: ExistingCatalogDomain[];
  locations: CatalogTargetRow[];
  profiles: CatalogTargetRow[];
  amenities: CatalogTargetRow[];
  contacts: CatalogTargetRow[];
  policies: CatalogTargetRow[];
  media: CatalogTargetRow[];
  mediaObjects: ExistingCatalogMediaObject[];
  ownerRevisions: CatalogOwnerRevision[];
};

export async function readProductionCatalogSourceLinks(
  client: QueryClient,
): Promise<ExistingCatalogSourceLink[]> {
  const result = await client.query<ExistingCatalogSourceLink>(
    `SELECT property_id::text AS "propertyId", source_system AS "sourceSystem",
            source_table AS "sourceTable", source_id AS "sourceId", relationship, status,
            metadata ->> 'migrationRunId' AS "migrationRunId",
            metadata ->> 'migrationPhase' AS "migrationPhase",
            metadata ->> 'migrationDisposition' AS "migrationDisposition",
            metadata ->> 'migrationDispositionReason' AS "migrationDispositionReason"
     FROM hotel_catalog.property_source_links
     WHERE source_system IN ('booking', 'pms', 'marketplace')
     ORDER BY source_system, source_table, source_id`,
  );
  return result.rows;
}

export async function readProductionCatalogTargetState(
  client: QueryClient,
  propertyIds: string[],
  sourceRunId: string,
): Promise<ProductionCatalogTargetState> {
  const ids = [...new Set(propertyIds)].sort();
  const values = [ids];
  const properties = await client.query<CatalogTargetRow>(
    `SELECT id::text, public_id AS "publicId", display_name AS "displayName",
            property_type AS "propertyType", category, star_rating::text AS "starRating",
            default_locale AS "defaultLocale", supported_locales AS "supportedLocales",
            profile_status AS "profileStatus", completeness_reasons AS "completenessReasons",
            created_at::text AS "createdAt", updated_at::text AS "updatedAt"
     FROM hotel_catalog.properties WHERE id = ANY($1::uuid[]) ORDER BY id`,
    values,
  );
  const sourceLinks = await readProductionCatalogSourceLinks(client);
  const ownerLinks = await client.query<CatalogOwnerLink>(
    `SELECT organization_id::text AS "organizationId", product,
            resource_type AS "resourceType", resource_id AS "resourceId", relationship, status
       FROM identity.organization_resource_links
      WHERE (product, resource_type, relationship) IN (
              ('booking', 'booking_hotel', 'owner'),
              ('pms', 'pms_hotel', 'operator'),
              ('marketplace', 'hotel_profile', 'owner')
            )
      ORDER BY product, resource_type, resource_id, relationship, organization_id`,
  );
  const slugs = await client.query<CatalogTargetRow>(
    `SELECT id::text, property_id::text AS "propertyId", slug, locale, purpose, status,
            redirects_to_id::text AS "redirectsToId", created_at::text AS "createdAt",
            updated_at::text AS "updatedAt"
     FROM hotel_catalog.property_slugs WHERE property_id = ANY($1::uuid[]) ORDER BY slug, locale`,
    values,
  );
  const domains = await client.query<ExistingCatalogDomain>(
    `SELECT id::text, property_id::text AS "propertyId", hostname,
            verification_status AS "verificationStatus",
            canonical_when_verified AS "canonicalWhenVerified",
            verified_at::text AS "verifiedAt", updated_at::text AS "updatedAt"
     FROM hotel_catalog.property_domains WHERE property_id = ANY($1::uuid[]) ORDER BY hostname`,
    values,
  );
  const locations = await client.query<CatalogTargetRow>(
    `SELECT property_id::text AS "propertyId", country_code AS "countryCode", region, city,
            street_address AS "streetAddress", postal_code AS "postalCode",
            raw_marketplace_location AS "rawMarketplaceLocation", latitude::text, longitude::text,
            timezone, address_public AS "addressPublic", geo_public AS "geoPublic",
            map_display_mode AS "mapDisplayMode", source_confidence AS "sourceConfidence",
            migration_notes AS "migrationNotes", updated_at::text AS "updatedAt"
     FROM hotel_catalog.property_locations WHERE property_id = ANY($1::uuid[]) ORDER BY property_id`,
    values,
  );
  const profiles = await client.query<CatalogTargetRow>(
    `SELECT id::text, property_id::text AS "propertyId", locale,
            short_description AS "shortDescription", long_description AS "longDescription",
            public_notes AS "publicNotes", source_confidence AS "sourceConfidence",
            created_at::text AS "createdAt", updated_at::text AS "updatedAt"
     FROM hotel_catalog.property_profiles WHERE property_id = ANY($1::uuid[]) ORDER BY property_id, locale`,
    values,
  );
  const amenities = await client.query<CatalogTargetRow>(
    `SELECT id::text, property_id::text AS "propertyId", amenity_key AS "amenityKey", label,
            source_system AS "sourceSystem", public_safe AS "publicSafe",
            created_at::text AS "createdAt", updated_at::text AS "updatedAt"
     FROM hotel_catalog.property_amenities WHERE property_id = ANY($1::uuid[]) ORDER BY property_id, amenity_key`,
    values,
  );
  const contacts = await client.query<CatalogTargetRow>(
    `SELECT id::text, property_id::text AS "propertyId", channel_type AS "channelType", value,
            is_public AS "isPublic", source_system AS "sourceSystem",
            created_at::text AS "createdAt", updated_at::text AS "updatedAt"
     FROM hotel_catalog.property_contact_channels WHERE property_id = ANY($1::uuid[])
     ORDER BY property_id, channel_type, value`,
    values,
  );
  const policies = await client.query<CatalogTargetRow>(
    `SELECT property_id::text AS "propertyId", check_in_time::text AS "checkInTime",
            check_out_time::text AS "checkOutTime", cancellation_summary AS "cancellationSummary",
            cancellation_terms_url AS "cancellationTermsUrl",
            deposit_policy_summary AS "depositPolicySummary",
            payment_policy_summary AS "paymentPolicySummary",
            policy_source_owner AS "policySourceOwner", updated_at::text AS "updatedAt"
     FROM hotel_catalog.property_policy_summaries WHERE property_id = ANY($1::uuid[]) ORDER BY property_id`,
    values,
  );
  const media = await client.query<CatalogTargetRow>(
    `SELECT id::text, property_id::text AS "propertyId", media_type AS "mediaType", url,
            alt_text AS "altText", sort_order AS "sortOrder", source_system AS "sourceSystem",
            public_approved AS "publicApproved", platform_media_object_id::text AS "platformMediaObjectId",
            created_at::text AS "createdAt", updated_at::text AS "updatedAt"
     FROM hotel_catalog.property_media WHERE property_id = ANY($1::uuid[]) ORDER BY property_id, id`,
    values,
  );
  const mediaObjects = await client.query<ExistingCatalogMediaObject>(
    `SELECT id::text, property_id::text AS "propertyId", purpose,
            source_system AS "sourceSystem", source_table AS "sourceTable",
            source_row_id AS "sourceRowId", visibility,
            lifecycle_status AS "lifecycleStatus", public_approved AS "publicApproved"
     FROM platform.media_objects
     WHERE source_system IN ('booking', 'marketplace')
       AND source_table IN ('booking_hotels', 'hotel_profiles')
       AND source_metadata ->> 'migrationRunId' = $1::text
     ORDER BY source_system, source_table, source_row_id, purpose`,
    [sourceRunId],
  );
  const ownerRevisions = await client.query<CatalogOwnerRevision>(
    `SELECT property_id::text AS "propertyId", owner_key AS "ownerKey", revision::text
     FROM hotel_catalog.property_owner_revisions
     WHERE property_id = ANY($1::uuid[]) ORDER BY property_id, owner_key`,
    values,
  );
  return {
    properties: properties.rows,
    sourceLinks,
    ownerLinks: ownerLinks.rows,
    slugs: slugs.rows,
    domains: domains.rows,
    locations: locations.rows,
    profiles: profiles.rows,
    amenities: amenities.rows,
    contacts: contacts.rows,
    policies: policies.rows,
    media: media.rows,
    mediaObjects: mediaObjects.rows,
    ownerRevisions: ownerRevisions.rows,
  };
}
