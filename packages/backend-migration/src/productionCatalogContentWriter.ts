import type pg from "pg";

import type { ReconciledCatalogWrites } from "./productionCatalogReconciliation.js";

type QueryClient = Pick<pg.ClientBase, "query">;
export type CatalogContentWriteCounts = {
  profiles: number;
  amenities: number;
  contacts: number;
  policies: number;
};

export async function writeProductionCatalogContent(
  client: QueryClient,
  writes: ReconciledCatalogWrites,
): Promise<CatalogContentWriteCounts> {
  const profiles = await client.query(
    `INSERT INTO hotel_catalog.property_profiles
       (property_id, locale, short_description, long_description, source_confidence,
        created_at, updated_at)
     SELECT source."propertyId", source.locale, source."shortDescription",
            source."longDescription", source."sourceConfidence",
            source."updatedAt", source."updatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       "propertyId" uuid, locale text, "shortDescription" text, "longDescription" text,
       "sourceConfidence" text, "updatedAt" timestamptz)
     ON CONFLICT (property_id, locale) DO UPDATE SET
       short_description = EXCLUDED.short_description,
       long_description = EXCLUDED.long_description,
       source_confidence = EXCLUDED.source_confidence,
       updated_at = EXCLUDED.updated_at
     WHERE hotel_catalog.property_profiles.updated_at < EXCLUDED.updated_at`,
    [JSON.stringify(writes.profiles)],
  );
  const amenities = await client.query(
    `INSERT INTO hotel_catalog.property_amenities
       (property_id, amenity_key, label, source_system, public_safe, created_at, updated_at)
     SELECT source."propertyId", source."amenityKey", source.label, source."sourceSystem",
            source."publicSafe", source."updatedAt", source."updatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       "propertyId" uuid, "amenityKey" text, label text, "sourceSystem" text,
       "publicSafe" boolean, "updatedAt" timestamptz)
     ON CONFLICT (property_id, amenity_key) DO UPDATE SET
       label = EXCLUDED.label, source_system = EXCLUDED.source_system,
       updated_at = EXCLUDED.updated_at
     WHERE hotel_catalog.property_amenities.updated_at < EXCLUDED.updated_at`,
    [JSON.stringify(writes.amenities)],
  );
  const contacts = await client.query(
    `INSERT INTO hotel_catalog.property_contact_channels
       (property_id, channel_type, value, is_public, source_system, created_at, updated_at)
     SELECT source."propertyId", source."channelType", source.value, FALSE,
            source."sourceSystem", source."updatedAt", source."updatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       "propertyId" uuid, "channelType" text, value text, "sourceSystem" text,
       "updatedAt" timestamptz)
     ON CONFLICT (property_id, channel_type, value) DO UPDATE SET
       source_system = EXCLUDED.source_system, updated_at = EXCLUDED.updated_at
     WHERE hotel_catalog.property_contact_channels.updated_at < EXCLUDED.updated_at`,
    [JSON.stringify(writes.contacts)],
  );
  const policies = await client.query(
    `INSERT INTO hotel_catalog.property_policy_summaries
       (property_id, check_in_time, check_out_time, check_in_until, check_out_from, cancellation_summary,
        payment_policy_summary, policy_source_owner, updated_at)
     SELECT source."propertyId", source."checkInTime"::time, source."checkOutTime"::time,
            source."checkInUntil"::time, source."checkOutFrom"::time,
            source."cancellationSummary", source."paymentPolicySummary", 'booking',
            source."updatedAt"
     FROM jsonb_to_recordset($1::jsonb) AS source(
       "propertyId" uuid, "checkInTime" text, "checkOutTime" text,
       "checkInUntil" text, "checkOutFrom" text,
       "cancellationSummary" text, "paymentPolicySummary" text, "updatedAt" timestamptz)
     ON CONFLICT (property_id) DO UPDATE SET
       check_in_time = EXCLUDED.check_in_time, check_out_time = EXCLUDED.check_out_time,
       check_in_until = EXCLUDED.check_in_until, check_out_from = EXCLUDED.check_out_from,
       cancellation_summary = EXCLUDED.cancellation_summary,
       payment_policy_summary = EXCLUDED.payment_policy_summary,
       updated_at = EXCLUDED.updated_at
     WHERE hotel_catalog.property_policy_summaries.updated_at <= EXCLUDED.updated_at
       AND COALESCE((SELECT revision FROM hotel_catalog.property_owner_revisions
                     WHERE property_id = EXCLUDED.property_id
                       AND owner_key = 'hotel_catalog.policy'), 1) <= 1`,
    [JSON.stringify(writes.policies)],
  );
  return {
    profiles: profiles.rowCount ?? 0,
    amenities: amenities.rowCount ?? 0,
    contacts: contacts.rowCount ?? 0,
    policies: policies.rowCount ?? 0,
  };
}
