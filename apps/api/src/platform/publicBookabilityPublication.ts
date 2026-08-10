import type {
  PublicBookabilityPublicationCommandPort,
  PublicBookabilityPublicationResult,
} from "@vayada/domain-distribution";
import pg from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE } from "./propertyMediaPublicationJob.js";

type PublicationPool = {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
};

type PublicationTransaction = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

/** Catalog-owned adapter invoked by Distribution before consuming the public profile read model. */
export type CatalogPublicProfileProjectionPort = {
  project(input: { propertyId: string; transaction: PublicationTransaction }): Promise<void>;
};

type PropertySlugRow = QueryResultRow & {
  propertyId: string;
  publicId: string;
  displayName: string;
  defaultLocale: string;
  canonicalSlug: string | null;
};

type ReservedSlugRow = QueryResultRow & {
  canonicalSlug: string;
};

type PublicationRow = QueryResultRow & {
  propertyId: string;
  canonicalSlug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  profileStatus: PublicBookabilityPublicationResult["profileStatus"];
  freshnessStatus: PublicBookabilityPublicationResult["freshnessStatus"];
  missingReadiness: string[];
};

export type TargetPublicBookabilityPublicationOptions = {
  connectionString: string;
  bookingHostBase?: string;
  max?: number;
  pool?: PublicationPool;
  catalogProfileProjector?: CatalogPublicProfileProjectionPort;
};

const PROPERTY_FOR_PUBLICATION_SELECT = `
  SELECT
    property.id::text AS "propertyId",
    property.public_id AS "publicId",
    property.display_name AS "displayName",
    property.default_locale AS "defaultLocale",
    canonical_slug.slug AS "canonicalSlug"
  FROM hotel_catalog.properties property
  LEFT JOIN LATERAL (
    SELECT slug.slug
    FROM hotel_catalog.property_slugs slug
    WHERE slug.property_id = property.id
      AND slug.purpose = 'canonical'
      AND slug.status = 'active'
    ORDER BY slug.updated_at DESC, slug.id
    LIMIT 1
  ) canonical_slug ON TRUE
  WHERE property.id = $1::uuid
  FOR UPDATE OF property
`;

const RESERVE_CANONICAL_SLUG = `
  INSERT INTO hotel_catalog.property_slugs (
    property_id,
    slug,
    locale,
    purpose,
    status,
    updated_at
  )
  VALUES ($1::uuid, $2, NULL, 'canonical', 'active', now())
  ON CONFLICT DO NOTHING
  RETURNING slug AS "canonicalSlug"
`;

/** SQL owned by the target Catalog adapter, not by the Distribution projection. */
export const PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE = `
  WITH canonical_slug AS (
    SELECT slug.id, slug.property_id, slug.slug
    FROM hotel_catalog.property_slugs slug
    WHERE slug.property_id = $1::uuid
      AND slug.purpose = 'canonical'
      AND slug.status = 'active'
    LIMIT 1
  ),
  verified_domain AS (
    SELECT domain.id, domain.property_id, domain.hostname
    FROM hotel_catalog.property_domains domain
    WHERE domain.property_id = $1::uuid
      AND domain.verification_status = 'verified'
      AND domain.canonical_when_verified = TRUE
    ORDER BY domain.verified_at DESC NULLS LAST, domain.id
    LIMIT 1
  ),
  descriptions AS (
    SELECT
      profile.property_id,
      jsonb_object_agg(
        profile.locale,
        jsonb_strip_nulls(jsonb_build_object(
          'short', profile.short_description,
          'long', profile.long_description
        ))
      ) AS descriptions
    FROM hotel_catalog.property_profiles profile
    WHERE profile.property_id = $1::uuid
    GROUP BY profile.property_id
  ),
  approved_media AS (
    SELECT
      media.property_id,
      jsonb_agg(
        jsonb_strip_nulls(jsonb_build_object(
          'id', media.id::text,
          'type', media.media_type,
          'url', media.url,
          'altText', media.alt_text,
          'sortOrder', media.sort_order,
          'platformMediaObjectId', media.platform_media_object_id::text
        ))
        ORDER BY
          CASE media.media_type WHEN 'logo' THEN 0 WHEN 'hero_image' THEN 1 ELSE 2 END,
          media.sort_order,
          media.id
      ) AS media
    FROM (
      SELECT
        candidate.id,
        candidate.property_id,
        candidate.media_type,
        media_variant.public_cdn_url AS url,
        candidate.alt_text,
        candidate.sort_order,
        candidate.platform_media_object_id
      FROM hotel_catalog.property_media candidate
      JOIN platform.media_objects media_object
        ON media_object.id = candidate.platform_media_object_id
       AND media_object.property_id = candidate.property_id
       AND ${APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE}
      JOIN platform.media_variants media_variant
        ON media_variant.media_object_id = media_object.id
       AND media_variant.variant_name = 'original_safe'
       AND media_variant.visibility = 'public'
       AND NULLIF(media_variant.public_cdn_url, '') IS NOT NULL
      WHERE candidate.property_id = $1::uuid
        AND candidate.public_approved = TRUE
        AND candidate.source_system = 'platform'
    ) media
    GROUP BY media.property_id
  ),
  amenities AS (
    SELECT
      amenity.property_id,
      jsonb_agg(
        jsonb_build_object('key', amenity.amenity_key, 'label', amenity.label)
        ORDER BY amenity.amenity_key
      ) AS amenities
    FROM hotel_catalog.property_amenities amenity
    WHERE amenity.property_id = $1::uuid
      AND amenity.public_safe = TRUE
    GROUP BY amenity.property_id
  ),
  contacts AS (
    SELECT
      contact.property_id,
      jsonb_agg(
        jsonb_build_object('type', contact.channel_type, 'value', contact.value)
        ORDER BY contact.channel_type, contact.value
      ) AS public_contacts
    FROM hotel_catalog.property_contact_channels contact
    WHERE contact.property_id = $1::uuid
      AND contact.is_public = TRUE
    GROUP BY contact.property_id
  ),
  projection_input AS (
    SELECT
      property.*,
      canonical_slug.id AS canonical_slug_id,
      canonical_slug.slug,
      verified_domain.id AS domain_id,
      verified_domain.hostname AS verified_hostname,
      location.country_code,
      location.region,
      location.city,
      location.latitude,
      location.longitude,
      location.address_public AS locality_public,
      location.geo_public,
      location.map_display_mode,
      descriptions.descriptions,
      approved_media.media AS catalog_media,
      amenities.amenities,
      contacts.public_contacts,
      policy.check_in_time,
      policy.check_out_time,
      policy.cancellation_summary,
      policy.cancellation_terms_url
    FROM hotel_catalog.properties property
    JOIN canonical_slug ON canonical_slug.property_id = property.id
    LEFT JOIN verified_domain ON verified_domain.property_id = property.id
    LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
    LEFT JOIN descriptions ON descriptions.property_id = property.id
    LEFT JOIN approved_media ON approved_media.property_id = property.id
    LEFT JOIN amenities ON amenities.property_id = property.id
    LEFT JOIN contacts ON contacts.property_id = property.id
    LEFT JOIN hotel_catalog.property_policy_summaries policy ON policy.property_id = property.id
    WHERE property.id = $1::uuid
  )
  INSERT INTO hotel_catalog.property_public_profile_read_model (
    property_id,
    public_id,
    display_name,
    canonical_slug,
    property_domain_id,
    verified_custom_domain,
    default_locale,
    supported_locales,
    profile_status,
    completeness_reasons,
    location,
    descriptions,
    media,
    amenities,
    public_contacts,
    public_policy,
    source_freshness,
    projected_at
  )
  SELECT
    input.id,
    input.public_id,
    input.display_name,
    input.slug,
    input.domain_id,
    input.verified_hostname,
    input.default_locale,
    input.supported_locales,
    input.profile_status,
    input.completeness_reasons,
    jsonb_strip_nulls(jsonb_build_object(
      'countryCode', CASE
        WHEN COALESCE(input.locality_public, FALSE) THEN input.country_code
      END,
      'region', CASE
        WHEN COALESCE(input.locality_public, FALSE) THEN input.region
      END,
      'city', CASE
        WHEN COALESCE(input.locality_public, FALSE) THEN input.city
      END,
      'geo', CASE
        WHEN COALESCE(input.geo_public, FALSE)
          AND input.map_display_mode IN ('approximate', 'exact')
          AND input.latitude IS NOT NULL
          AND input.longitude IS NOT NULL
          THEN jsonb_build_object(
            'latitude', CASE
              WHEN input.map_display_mode = 'approximate'
                THEN round(input.latitude::numeric, 2)::double precision
              ELSE input.latitude::double precision
            END,
            'longitude', CASE
              WHEN input.map_display_mode = 'approximate'
                THEN round(input.longitude::numeric, 2)::double precision
              ELSE input.longitude::double precision
            END
          )
      END,
      'mapDisplayMode', CASE
        WHEN COALESCE(input.geo_public, FALSE)
          AND input.map_display_mode IN ('approximate', 'exact')
          AND input.latitude IS NOT NULL
          AND input.longitude IS NOT NULL
          THEN input.map_display_mode
      END
    )),
    COALESCE(input.descriptions, '{}'::jsonb),
    COALESCE(input.catalog_media, '[]'::jsonb),
    COALESCE(input.amenities, '[]'::jsonb),
    COALESCE(input.public_contacts, '[]'::jsonb),
    jsonb_strip_nulls(jsonb_build_object(
      'checkInTime', CASE
        WHEN input.check_in_time IS NULL THEN NULL
        ELSE to_char(input.check_in_time, 'HH24:MI')
      END,
      'checkOutTime', CASE
        WHEN input.check_out_time IS NULL THEN NULL
        ELSE to_char(input.check_out_time, 'HH24:MI')
      END,
      'cancellationSummary', input.cancellation_summary,
      'termsUrl', input.cancellation_terms_url
    )),
    jsonb_build_object(
      'hotel_catalog', jsonb_build_object('status', 'fresh', 'generatedAt', now())
    ),
    now()
  FROM projection_input input
  ON CONFLICT (property_id) DO UPDATE SET
    public_id = EXCLUDED.public_id,
    display_name = EXCLUDED.display_name,
    canonical_slug = EXCLUDED.canonical_slug,
    property_domain_id = EXCLUDED.property_domain_id,
    verified_custom_domain = EXCLUDED.verified_custom_domain,
    default_locale = EXCLUDED.default_locale,
    supported_locales = EXCLUDED.supported_locales,
    profile_status = EXCLUDED.profile_status,
    completeness_reasons = EXCLUDED.completeness_reasons,
    location = EXCLUDED.location,
    descriptions = EXCLUDED.descriptions,
    media = EXCLUDED.media,
    amenities = EXCLUDED.amenities,
    public_contacts = EXCLUDED.public_contacts,
    public_policy = EXCLUDED.public_policy,
    source_freshness = EXCLUDED.source_freshness,
    projected_at = EXCLUDED.projected_at
`;

/** Distribution-owned projection. PMS contributes only its public snapshot read model. */
export const PROJECT_PUBLIC_BOOKABILITY_PROFILE = `
  WITH projection_input AS (
    SELECT
      profile.*,
      settings.default_language AS booking_default_language,
      settings.supported_languages AS booking_supported_languages,
      settings.special_requests_enabled,
      settings.arrival_time_enabled,
      settings.guest_count_enabled,
      settings.adult_age_threshold,
      settings.children_enabled,
      settings.updated_at AS booking_updated_at,
      finance.payments_enabled,
      finance.accepted_methods,
      finance.default_currency AS finance_default_currency,
      finance.refund_policy AS finance_refund_policy,
      finance.updated_at AS finance_updated_at,
      payment_provider.provider AS payment_provider,
      payment_provider.status AS payment_provider_status,
      payment_provider.onboarding_status AS payment_provider_onboarding_status,
      payment_provider.charges_enabled AS payment_provider_charges_enabled,
      location.timezone AS catalog_timezone,
      location.address_public AS catalog_locality_public,
      location.geo_public AS catalog_geo_public,
      location.map_display_mode AS catalog_map_display_mode,
      verified_domain.hostname AS verified_hostname,
      availability.has_coverage,
      availability.has_sellable_offers,
      availability.has_unavailable_source,
      availability.has_stale_source,
      availability.has_unknown_source,
      availability.latest_generated_at,
      EXISTS (
        SELECT 1
        FROM booking.promo_definitions promo
        WHERE promo.property_id = profile.property_id
          AND promo.status = 'active'
          AND promo.is_active = TRUE
          AND (promo.valid_from IS NULL OR promo.valid_from <= current_date)
          AND (promo.valid_until IS NULL OR promo.valid_until >= current_date)
      ) AS has_active_promos
    FROM hotel_catalog.property_public_profile_read_model profile
    LEFT JOIN booking.booking_settings settings ON settings.property_id = profile.property_id
    LEFT JOIN finance.payment_settings finance ON finance.property_id = profile.property_id
    LEFT JOIN finance.payment_provider_accounts payment_provider
      ON payment_provider.id = finance.provider_account_id
     AND payment_provider.property_id = profile.property_id
    LEFT JOIN hotel_catalog.property_locations location ON location.property_id = profile.property_id
    LEFT JOIN LATERAL (
      SELECT domain.hostname
      FROM hotel_catalog.property_domains domain
      WHERE domain.property_id = profile.property_id
        AND domain.verification_status = 'verified'
        AND domain.canonical_when_verified = TRUE
      ORDER BY domain.verified_at DESC NULLS LAST, domain.id
      LIMIT 1
    ) verified_domain ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        count(*) > 0 AS has_coverage,
        COALESCE(bool_or(
          offer.sellable_publicly = TRUE
          AND offer.availability_status IN ('available', 'limited')
          AND offer.available_rooms > 0
        ), FALSE) AS has_sellable_offers,
        COALESCE(bool_or(offer.freshness_status = 'unavailable'), FALSE)
          AS has_unavailable_source,
        COALESCE(bool_or(offer.freshness_status = 'stale'), FALSE) AS has_stale_source,
        COALESCE(bool_or(offer.freshness_status = 'unknown'), FALSE) AS has_unknown_source,
        max(offer.generated_at) AS latest_generated_at
      FROM distribution.public_room_offer_snapshots offer
      WHERE offer.property_id = profile.property_id
        AND offer.public_visibility = 'public_safe'
        AND offer.stay_date >= (
          now() AT TIME ZONE CASE
            WHEN location.timezone ~ '^[A-Za-z_]+/[A-Za-z0-9_+./-]+$'
              AND EXISTS (
                SELECT 1
                FROM pg_timezone_names timezone_name
                WHERE timezone_name.name = location.timezone
              )
              THEN location.timezone
            ELSE 'Etc/UTC'
          END
        )::date
        AND (offer.expires_at IS NULL OR offer.expires_at > now())
    ) availability ON TRUE
    WHERE profile.property_id = $1::uuid
  ),
  normalized AS (
    SELECT
      input.*,
      CASE
        WHEN input.catalog_timezone ~ '^[A-Za-z_]+/[A-Za-z0-9_+./-]+$'
          AND EXISTS (
            SELECT 1
            FROM pg_timezone_names timezone_name
            WHERE timezone_name.name = input.catalog_timezone
          )
          THEN input.catalog_timezone
        ELSE 'Etc/UTC'
      END AS timezone,
      input.catalog_timezone ~ '^[A-Za-z_]+/[A-Za-z0-9_+./-]+$'
        AND EXISTS (
          SELECT 1
          FROM pg_timezone_names timezone_name
          WHERE timezone_name.name = input.catalog_timezone
        ) AS timezone_is_valid,
      COALESCE(NULLIF(input.booking_default_language, ''), input.default_locale, 'en') AS locale,
      NULLIF(upper(trim(input.finance_default_currency)), '') AS currency,
      COALESCE(
        COALESCE(input.payments_enabled, FALSE)
          AND input.payment_provider_status = 'active'
          AND input.payment_provider_onboarding_status = 'completed'
          AND input.payment_provider_charges_enabled = TRUE
          AND (
            COALESCE(input.accepted_methods, ARRAY[]::text[])
              && ARRAY['card', 'wallet']::text[]
            OR (
              input.payment_provider = 'xendit'
              AND 'xendit' = ANY(COALESCE(input.accepted_methods, ARRAY[]::text[]))
            )
          ),
        FALSE
      ) AS online_payment_ready,
      COALESCE(input.payments_enabled, FALSE)
        AND COALESCE(input.accepted_methods, ARRAY[]::text[])
          && ARRAY[
            'pay_at_property',
            'cash',
            'bank_transfer',
            'manual_card',
            'other'
          ]::text[] AS pay_at_property_ready,
      CASE
        WHEN NOT COALESCE(input.has_coverage, FALSE) THEN 'unavailable'
        WHEN input.has_unavailable_source THEN 'unavailable'
        WHEN input.has_stale_source THEN 'stale'
        WHEN input.has_unknown_source THEN 'unknown'
        ELSE 'fresh'
      END AS availability_freshness,
      CASE
        WHEN NOT COALESCE(input.has_coverage, FALSE) THEN 'unavailable'
        WHEN input.has_unavailable_source THEN 'unavailable'
        WHEN input.has_stale_source THEN 'stale'
        WHEN input.has_unknown_source THEN 'unknown'
        WHEN input.booking_updated_at IS NULL OR input.finance_updated_at IS NULL
          THEN 'unavailable'
        ELSE 'fresh'
      END AS computed_freshness
    FROM projection_input input
  ),
  readiness AS (
    SELECT
      input.*,
      ARRAY_REMOVE(ARRAY[
        CASE WHEN input.profile_status <> 'complete' THEN 'profile' END,
        CASE WHEN input.timezone_is_valid IS NOT TRUE THEN 'timezone' END,
        CASE WHEN input.booking_updated_at IS NULL THEN 'booking_settings' END,
        CASE WHEN input.currency IS NULL THEN 'default_currency' END,
        CASE WHEN NOT COALESCE(input.has_coverage, FALSE) THEN 'availability_source' END,
        CASE WHEN NOT COALESCE(input.has_sellable_offers, FALSE) THEN 'sellable_availability' END,
        CASE
          WHEN NOT COALESCE(input.online_payment_ready OR input.pay_at_property_ready, FALSE)
            THEN 'payment_method'
        END,
        CASE WHEN input.computed_freshness <> 'fresh' THEN 'freshness' END
      ], NULL)::text[] AS missing_readiness
    FROM normalized input
  ),
  upserted AS (
    INSERT INTO distribution.public_hotel_bookability_profiles (
      property_id,
      finance_payment_settings_property_id,
      public_id,
      canonical_slug,
      canonical_url,
      booking_base_url,
      custom_domain_url,
      timezone,
      default_locale,
      supported_locales,
      default_currency,
      supported_currencies,
      profile_status,
      public_identity,
      location,
      media,
      amenities,
      policies,
      capabilities,
      supported_quote_parameters,
      public_setup_completeness,
      source_freshness,
      freshness_status,
      data_sources,
      generated_at,
      projected_at,
      expires_at
    )
    SELECT
      input.property_id,
      CASE WHEN input.finance_updated_at IS NULL THEN NULL ELSE input.property_id END,
      input.public_id,
      input.canonical_slug,
      CASE
        WHEN input.verified_hostname IS NULL THEN $2
        ELSE 'https://' || input.verified_hostname || '/' || input.locale
      END,
      CASE
        WHEN input.verified_hostname IS NULL THEN $3
        ELSE 'https://' || input.verified_hostname
      END,
      CASE WHEN input.verified_hostname IS NULL THEN NULL ELSE 'https://' || input.verified_hostname END,
      input.timezone,
      input.locale,
      ARRAY(
        SELECT DISTINCT value
        FROM unnest(
          ARRAY[input.locale] || COALESCE(input.booking_supported_languages, input.supported_locales)
        ) value
        WHERE NULLIF(value, '') IS NOT NULL
      ),
      COALESCE(input.currency, 'XXX'),
      CASE
        WHEN input.currency IS NULL THEN ARRAY[]::text[]
        ELSE ARRAY[input.currency]::text[]
      END,
      CASE
        WHEN input.profile_status IN ('disabled', 'private') THEN 'unpublished'
        WHEN input.profile_status <> 'complete' THEN 'incomplete'
        ELSE 'public'
      END,
      jsonb_strip_nulls(jsonb_build_object(
        'propertyId', input.property_id::text,
        'slug', input.canonical_slug,
        'name', input.display_name,
        'summary', COALESCE(
          input.descriptions -> input.locale ->> 'short',
          input.descriptions -> input.default_locale ->> 'short'
        )
      )),
      jsonb_strip_nulls(jsonb_build_object(
        'country', CASE
          WHEN COALESCE(input.catalog_locality_public, FALSE)
            THEN input.location ->> 'countryCode'
        END,
        'city', CASE
          WHEN COALESCE(input.catalog_locality_public, FALSE)
            THEN input.location ->> 'city'
        END,
        'region', CASE
          WHEN COALESCE(input.catalog_locality_public, FALSE)
            THEN input.location ->> 'region'
        END,
        'latitude', CASE
          WHEN COALESCE(input.catalog_geo_public, FALSE)
            AND input.catalog_map_display_mode IN ('approximate', 'exact')
            THEN input.location #> '{geo,latitude}'
        END,
        'longitude', CASE
          WHEN COALESCE(input.catalog_geo_public, FALSE)
            AND input.catalog_map_display_mode IN ('approximate', 'exact')
            THEN input.location #> '{geo,longitude}'
        END
      )),
      COALESCE((
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'url', media.item ->> 'url',
          'alt', media.item ->> 'altText'
        )))
        FROM jsonb_array_elements(input.media) media(item)
        WHERE NULLIF(media.item ->> 'url', '') IS NOT NULL
          AND COALESCE(media.item ->> 'type', media.item ->> 'mediaType') IS DISTINCT FROM 'logo'
      ), '[]'::jsonb),
      input.amenities,
      jsonb_strip_nulls(jsonb_build_object(
        'checkInFrom', input.public_policy ->> 'checkInTime',
        'checkOutUntil', input.public_policy ->> 'checkOutTime',
        'cancellationSummary', input.public_policy ->> 'cancellationSummary',
        'freeCancellationDays', input.finance_refund_policy -> 'freeCancellationDays',
        'freeUntilDays', input.finance_refund_policy -> 'freeUntilDays',
        'refundWindowDays', input.finance_refund_policy -> 'refundWindowDays',
        'termsUrl', input.public_policy ->> 'termsUrl'
      )),
      jsonb_build_object(
        'instantBook', COALESCE(input.has_sellable_offers, FALSE),
        'onlinePayment', input.online_payment_ready,
        'payAtProperty', input.pay_at_property_ready,
        'promoCodes', input.has_active_promos,
        'referralCodes', FALSE,
        'bookingDeepLinks', TRUE
      ),
      jsonb_build_object(
        'minRooms', 1,
        'maxRooms', 5,
        'minAdults', 1,
        'maxAdults', 10,
        'childrenSupported', COALESCE(input.children_enabled, TRUE),
        'adultAgeThreshold', COALESCE(input.adult_age_threshold, 18),
        'supportedCurrencies', CASE
          WHEN input.currency IS NULL THEN ARRAY[]::text[]
          ELSE ARRAY[input.currency]::text[]
        END,
        'supportedLocales', ARRAY(
          SELECT DISTINCT value
          FROM unnest(
            ARRAY[input.locale] || COALESCE(input.booking_supported_languages, input.supported_locales)
          ) value
          WHERE NULLIF(value, '') IS NOT NULL
        ),
        'specialRequestsSupported', COALESCE(input.special_requests_enabled, TRUE),
        'arrivalTimeSupported', COALESCE(input.arrival_time_enabled, TRUE),
        'guestCountSupported', COALESCE(input.guest_count_enabled, TRUE)
      ),
      jsonb_build_object(
        'status', CASE WHEN cardinality(input.missing_readiness) = 0 THEN 'ready' ELSE 'incomplete' END,
        'missing', to_jsonb(input.missing_readiness)
      ),
      jsonb_strip_nulls(jsonb_build_object(
        'hotel_catalog', jsonb_build_object('status', 'fresh', 'generatedAt', now()),
        'booking', jsonb_build_object(
          'status', CASE WHEN input.booking_updated_at IS NULL THEN 'unavailable' ELSE 'fresh' END,
          'generatedAt', COALESCE(input.booking_updated_at, now()),
          'reasonCode', CASE WHEN input.booking_updated_at IS NULL THEN 'not_configured' ELSE NULL END
        ),
        'pms', jsonb_build_object(
          'status', input.availability_freshness,
          'generatedAt', COALESCE(input.latest_generated_at, now()),
          'reasonCode', CASE input.availability_freshness
            WHEN 'unavailable' THEN 'source_unavailable'
            WHEN 'stale' THEN 'source_stale'
            WHEN 'unknown' THEN 'not_configured'
            ELSE NULL
          END
        ),
        'finance', jsonb_build_object(
          'status', CASE
            WHEN input.finance_updated_at IS NULL OR input.currency IS NULL THEN 'unavailable'
            ELSE 'fresh'
          END,
          'generatedAt', COALESCE(input.finance_updated_at, now()),
          'reasonCode', CASE
            WHEN input.finance_updated_at IS NULL OR input.currency IS NULL THEN 'not_configured'
            ELSE NULL
          END
        ),
        'distribution', jsonb_build_object(
          'status', input.computed_freshness,
          'generatedAt', now(),
          'reasonCode', CASE input.computed_freshness
            WHEN 'unavailable' THEN 'source_unavailable'
            WHEN 'stale' THEN 'source_stale'
            WHEN 'unknown' THEN 'not_configured'
            ELSE NULL
          END
        )
      )),
      input.computed_freshness,
      ARRAY['hotel_catalog', 'booking', 'pms', 'finance', 'distribution']::text[],
      now(),
      now(),
      NULL
    FROM readiness input
    ON CONFLICT (property_id) DO UPDATE SET
      finance_payment_settings_property_id = EXCLUDED.finance_payment_settings_property_id,
      public_id = EXCLUDED.public_id,
      canonical_slug = EXCLUDED.canonical_slug,
      canonical_url = EXCLUDED.canonical_url,
      booking_base_url = EXCLUDED.booking_base_url,
      custom_domain_url = EXCLUDED.custom_domain_url,
      timezone = EXCLUDED.timezone,
      default_locale = EXCLUDED.default_locale,
      supported_locales = EXCLUDED.supported_locales,
      default_currency = EXCLUDED.default_currency,
      supported_currencies = EXCLUDED.supported_currencies,
      profile_status = EXCLUDED.profile_status,
      public_identity = EXCLUDED.public_identity,
      location = EXCLUDED.location,
      media = EXCLUDED.media,
      amenities = EXCLUDED.amenities,
      policies = EXCLUDED.policies,
      capabilities = EXCLUDED.capabilities,
      supported_quote_parameters = EXCLUDED.supported_quote_parameters,
      public_setup_completeness = EXCLUDED.public_setup_completeness,
      source_freshness = EXCLUDED.source_freshness,
      freshness_status = EXCLUDED.freshness_status,
      data_sources = EXCLUDED.data_sources,
      generated_at = EXCLUDED.generated_at,
      projected_at = EXCLUDED.projected_at,
      expires_at = EXCLUDED.expires_at,
      updated_at = now()
    RETURNING
      property_id::text AS "propertyId",
      canonical_slug AS "canonicalSlug",
      canonical_url AS "canonicalUrl",
      booking_base_url AS "bookingBaseUrl",
      profile_status AS "profileStatus",
      freshness_status AS "freshnessStatus",
      ARRAY(
        SELECT jsonb_array_elements_text(public_setup_completeness -> 'missing')
      ) AS "missingReadiness"
  )
  SELECT * FROM upserted
`;

export function createTargetCatalogPublicProfileProjectionAdapter(): CatalogPublicProfileProjectionPort {
  return {
    async project({ propertyId, transaction }) {
      await transaction.query(PROJECT_CANONICAL_PUBLIC_PROPERTY_PROFILE, [propertyId]);
    },
  };
}

export function createTargetPublicBookabilityPublicationCommandPort(
  options: TargetPublicBookabilityPublicationOptions,
): PublicBookabilityPublicationCommandPort {
  const ownsPool = !options.pool;
  const pool =
    options.pool ??
    new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 5,
    });
  const bookingHostBase = normalizeBookingHostBase(options.bookingHostBase);
  const catalogProfileProjector =
    options.catalogProfileProjector ?? createTargetCatalogPublicProfileProjectionAdapter();

  return {
    async publish({ propertyId }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const propertyResult = await client.query<PropertySlugRow>(
          PROPERTY_FOR_PUBLICATION_SELECT,
          [propertyId],
        );
        const property = propertyResult.rows[0];
        if (!property) {
          await client.query("ROLLBACK");
          return null;
        }

        const canonicalSlug =
          property.canonicalSlug ?? (await reserveCanonicalSlug(client, property));
        const bookingBaseUrl = `https://${canonicalSlug}.${bookingHostBase}`;
        const canonicalUrl = `${bookingBaseUrl}/${encodeURIComponent(property.defaultLocale || "en")}`;

        await catalogProfileProjector.project({ propertyId, transaction: client });
        const publicationResult = await client.query<PublicationRow>(
          PROJECT_PUBLIC_BOOKABILITY_PROFILE,
          [propertyId, canonicalUrl, bookingBaseUrl],
        );
        const publication = publicationResult.rows[0];
        if (!publication) {
          throw new Error("Public bookability projection was not created.");
        }
        await client.query("COMMIT");
        return publication;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function reserveCanonicalSlug(
  client: PublicationTransaction,
  property: PropertySlugRow,
): Promise<string> {
  const base = slugify(property.displayName) || slugify(property.publicId) || "hotel";
  const suffix =
    slugify(property.publicId).slice(-12) || property.propertyId.replaceAll("-", "").slice(0, 12);
  const candidates = [...new Set([base, withDnsSuffix(base, suffix)])];

  for (const candidate of candidates) {
    const result = (await client.query(RESERVE_CANONICAL_SLUG, [
      property.propertyId,
      candidate,
    ])) as QueryResult<ReservedSlugRow>;
    if (result.rows[0]) return result.rows[0].canonicalSlug;
  }

  throw new Error(`Unable to reserve a canonical slug for property ${property.propertyId}.`);
}

export async function ensureCanonicalPropertySlug(
  client: PublicationTransaction,
  propertyId: string,
): Promise<string | null> {
  const result = await client.query<PropertySlugRow>(PROPERTY_FOR_PUBLICATION_SELECT, [propertyId]);
  const property = result.rows[0];
  if (!property) return null;
  return property.canonicalSlug ?? reserveCanonicalSlug(client, property);
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

function withDnsSuffix(base: string, suffix: string): string {
  const normalizedSuffix = suffix.slice(0, 12).replace(/^-+|-+$/g, "") || "property";
  const prefixLength = Math.max(1, 63 - normalizedSuffix.length - 1);
  return `${base.slice(0, prefixLength).replace(/-+$/g, "")}-${normalizedSuffix}`;
}

function normalizeBookingHostBase(value?: string): string {
  const host = (value ?? "booking.vayada.com")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");
  return host || "booking.vayada.com";
}
