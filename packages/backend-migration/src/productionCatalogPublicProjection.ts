import type pg from "pg";

type QueryClient = Pick<pg.ClientBase, "query">;

export async function rebuildProductionCatalogPublicProjection(
  client: QueryClient,
  propertyIds: string[],
  runId: string,
): Promise<number> {
  const ids = [...new Set(propertyIds)].sort();
  const result = await client.query(
    `WITH migration_properties AS (
       SELECT * FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])
     ),
     canonical_slugs AS (
       SELECT property_id, slug FROM hotel_catalog.property_slugs
       WHERE property_id = ANY($1::uuid[]) AND purpose = 'canonical' AND status = 'active'
     ),
     verified_domains AS (
       SELECT id, property_id, hostname FROM hotel_catalog.property_domains
       WHERE property_id = ANY($1::uuid[])
         AND verification_status = 'verified' AND canonical_when_verified
     ),
     descriptions AS (
       SELECT property_id,
              jsonb_object_agg(locale, jsonb_strip_nulls(jsonb_build_object(
                'short', short_description, 'long', long_description))) AS value
       FROM hotel_catalog.property_profiles
       WHERE property_id = ANY($1::uuid[]) GROUP BY property_id
     ),
     public_media AS (
       SELECT assignment.property_id,
              jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                'id', assignment.id::text, 'type', assignment.media_type,
                'url', variant.public_cdn_url, 'altText', assignment.alt_text,
                'sortOrder', assignment.sort_order,
                'platformMediaObjectId', media_object.id::text
              )) ORDER BY assignment.sort_order, assignment.id) AS value
       FROM hotel_catalog.property_media assignment
       JOIN platform.media_objects media_object
         ON media_object.id = assignment.platform_media_object_id
        AND media_object.property_id = assignment.property_id
        AND media_object.visibility = 'public'
        AND media_object.public_approved
        AND media_object.lifecycle_status = 'active'
       JOIN platform.media_variants variant
         ON variant.media_object_id = media_object.id
        AND variant.visibility = 'public'
        AND variant.variant_name = 'original_safe'
        AND variant.public_cdn_url IS NOT NULL
       WHERE assignment.property_id = ANY($1::uuid[]) AND assignment.public_approved
       GROUP BY assignment.property_id
     ),
     public_amenities AS (
       SELECT property_id,
              jsonb_agg(jsonb_build_object('key', amenity_key, 'label', label)
                        ORDER BY amenity_key) AS value
       FROM hotel_catalog.property_amenities
       WHERE property_id = ANY($1::uuid[]) AND public_safe GROUP BY property_id
     ),
     public_contacts AS (
       SELECT property_id,
              jsonb_agg(jsonb_build_object('type', channel_type, 'value', value)
                        ORDER BY channel_type, value) AS value
       FROM hotel_catalog.property_contact_channels
       WHERE property_id = ANY($1::uuid[]) AND is_public GROUP BY property_id
     ),
     public_policies AS (
       SELECT property_id, jsonb_strip_nulls(jsonb_build_object(
         'checkInTime', CASE WHEN check_in_time IS NULL THEN NULL ELSE to_char(check_in_time, 'HH24:MI') END,
         'checkOutTime', CASE WHEN check_out_time IS NULL THEN NULL ELSE to_char(check_out_time, 'HH24:MI') END
       )) AS value
       FROM hotel_catalog.property_policy_summaries WHERE property_id = ANY($1::uuid[])
     )
     INSERT INTO hotel_catalog.property_public_profile_read_model
       (property_id, public_id, display_name, canonical_slug, property_domain_id,
        verified_custom_domain, default_locale, supported_locales, profile_status,
        completeness_reasons, location, descriptions, media, amenities, public_contacts,
        public_policy, source_freshness, projected_at)
     SELECT property.id, property.public_id, property.display_name, slug.slug,
            domain.id, domain.hostname, property.default_locale, property.supported_locales,
            property.profile_status, property.completeness_reasons,
            CASE WHEN property.profile_status = 'complete' THEN jsonb_strip_nulls(jsonb_build_object(
              'countryCode', location.country_code, 'city', location.city,
              'timezone', location.timezone,
              'streetAddress', CASE WHEN location.address_public THEN location.street_address END,
              'postalCode', CASE WHEN location.address_public THEN location.postal_code END,
              'geo', CASE
                WHEN location.geo_public AND location.map_display_mode = 'exact'
                  THEN jsonb_build_object('latitude', location.latitude::double precision,
                                          'longitude', location.longitude::double precision)
                WHEN location.geo_public AND location.map_display_mode = 'approximate'
                  THEN jsonb_build_object('latitude', round(location.latitude, 2)::double precision,
                                          'longitude', round(location.longitude, 2)::double precision)
              END
            )) ELSE '{}'::jsonb END,
            CASE WHEN property.profile_status = 'complete'
              THEN COALESCE(descriptions.value, '{}'::jsonb) ELSE '{}'::jsonb END,
            CASE WHEN property.profile_status = 'complete'
              THEN COALESCE(public_media.value, '[]'::jsonb) ELSE '[]'::jsonb END,
            CASE WHEN property.profile_status = 'complete'
              THEN COALESCE(public_amenities.value, '[]'::jsonb) ELSE '[]'::jsonb END,
            CASE WHEN property.profile_status = 'complete'
              THEN COALESCE(public_contacts.value, '[]'::jsonb) ELSE '[]'::jsonb END,
            CASE WHEN property.profile_status = 'complete'
              THEN COALESCE(public_policies.value, '{}'::jsonb) ELSE '{}'::jsonb END,
            jsonb_build_object('catalogMigration',
              jsonb_build_object('runId', $2::text, 'status', 'reconciled')),
            now()
     FROM migration_properties property
     JOIN canonical_slugs slug ON slug.property_id = property.id
     LEFT JOIN verified_domains domain ON domain.property_id = property.id
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN descriptions ON descriptions.property_id = property.id
     LEFT JOIN public_media ON public_media.property_id = property.id
     LEFT JOIN public_amenities ON public_amenities.property_id = property.id
     LEFT JOIN public_contacts ON public_contacts.property_id = property.id
     LEFT JOIN public_policies ON public_policies.property_id = property.id
     ON CONFLICT (property_id) DO UPDATE SET
       public_id = EXCLUDED.public_id, display_name = EXCLUDED.display_name,
       canonical_slug = EXCLUDED.canonical_slug, property_domain_id = EXCLUDED.property_domain_id,
       verified_custom_domain = EXCLUDED.verified_custom_domain,
       default_locale = EXCLUDED.default_locale, supported_locales = EXCLUDED.supported_locales,
       profile_status = EXCLUDED.profile_status,
       completeness_reasons = EXCLUDED.completeness_reasons, location = EXCLUDED.location,
       descriptions = EXCLUDED.descriptions, media = EXCLUDED.media,
       amenities = EXCLUDED.amenities, public_contacts = EXCLUDED.public_contacts,
       public_policy = EXCLUDED.public_policy, source_freshness = EXCLUDED.source_freshness,
       projected_at = EXCLUDED.projected_at`,
    [ids, runId],
  );
  const count = result.rowCount ?? 0;
  if (count !== ids.length)
    throw new Error(`Public catalog projection wrote ${count} of ${ids.length} properties`);
  return count;
}
