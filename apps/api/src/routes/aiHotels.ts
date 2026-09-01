import {
  assertPublicBookabilityPublicSafe,
  buildPublicBookabilityProfileProjection,
  PUBLIC_BOOKABILITY_CONTACT_CHANNEL_TYPES,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityDataSourceOwner,
  type PublicBookabilityFreshness,
  type PublicBookabilityFreshnessStatus,
  type PublicBookabilityFreshnessSource,
  type PublicBookabilityHotelProfile,
  type PublicBookabilityProfileProjection,
  type PublicBookabilityReasonCode,
  type PublicBookabilityStatus,
} from "@vayada/domain-distribution";
import type { FastifyInstance } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PublicHotelProfileRepository = {
  findProfileBySlug(slug: string): Promise<PublicBookabilityProfileProjection | null>;
  findProfileByCustomDomain?(domain: string): Promise<PublicBookabilityProfileProjection | null>;
  close?(): Promise<void>;
};

export type BookingHotelProfileRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  location: string | null;
  country: string | null;
  currency: string | null;
  supported_currencies: unknown;
  hero_image: string | null;
  images: unknown;
  amenities: unknown;
  check_in_time: string | null;
  check_out_time: string | null;
  timezone: string | null;
  default_language: string | null;
  supported_languages: unknown;
  custom_domain: string | null;
  instant_book: boolean | null;
  online_card_payment: boolean | null;
  pay_at_property_enabled: boolean | null;
  free_cancellation_days: number | null;
  terms_text: string | null;
  cancellation_policy_text: string | null;
  updated_at: Date | string | null;
};

export type PublicHotelProfileReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type TargetPublicHotelProfileRow = {
  propertyId: string;
  contractVersion: string;
  publicVisibility: string;
  publicId: string;
  canonicalSlug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  customDomainUrl: string | null;
  timezone: string;
  defaultLocale: string;
  supportedLocales: string[];
  defaultCurrency: string;
  supportedCurrencies: string[];
  profileStatus: string;
  publicIdentity: unknown;
  location: unknown;
  media: unknown;
  amenities: unknown;
  publicContacts: unknown;
  policies: unknown;
  capabilities: unknown;
  supportedQuoteParameters: unknown;
  bookingHeaderLogo: string | null;
  bookingHeroImage: string | null;
  bookingHeroHeading: string | null;
  bookingHeroSubtext: string | null;
  bookingPrimaryColor: string | null;
  bookingFontPairing: string | null;
  publicSetupCompleteness: unknown;
  sourceFreshness: unknown;
  freshnessStatus: string;
  dataSources: string[];
  generatedAt: Date | string;
  expiresAt: Date | string | null;
};

type PublicHotelProfileParams = {
  slug: string;
};

export async function registerAiHotelRoutes(
  app: FastifyInstance,
  options: { repository: PublicHotelProfileRepository },
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Params: PublicHotelProfileParams }>("/hotels/:slug", async (request, reply) => {
    const profile = await repository.findProfileBySlug(request.params.slug);
    if (!profile) {
      throw createHttpError(404, "Public hotel profile not found.");
    }

    const response = serializePublicHotelProfileProjection(profile);
    assertPublicBookabilityPublicSafe(response);
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    reply.header("X-Vayada-RateLimit-Policy", "public-ai-profile-read");
    return response;
  });
}

const TARGET_PUBLIC_CATALOG_PROFILE_READY = `(
  catalog_profile.profile_status = 'complete'
  OR (
    catalog_profile.profile_status = 'incomplete'
    AND cardinality(catalog_profile.completeness_reasons) = 1
    AND 'description' = ANY(catalog_profile.completeness_reasons)
    AND NULLIF(BTRIM(booking_branding.hero_subtext), '') IS NOT NULL
  )
)`;

export function createTargetPublicHotelProfileRepository(config: {
  connectionString: string;
  max?: number;
  pool?: PublicHotelProfileReadPool;
  now?: () => Date;
}): PublicHotelProfileRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Target public hotel profile repository connectionString must not be empty");
  }

  const ownsPool = !config.pool;
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });
  const now = config.now ?? (() => new Date());

  return {
    async findProfileBySlug(slug) {
      const result = await pool.query<TargetPublicHotelProfileRow>(
        `${TARGET_PUBLIC_PROFILE_SELECT}
         LEFT JOIN hotel_catalog.property_slugs slug_alias
           ON slug_alias.property_id = profile.property_id
          AND slug_alias.slug = lower($1)
          AND slug_alias.purpose = 'redirect'
          AND slug_alias.status = 'redirected'
         WHERE (profile.canonical_slug = lower($1)
           OR slug_alias.property_id IS NOT NULL)
           AND profile.public_visibility = 'public_safe'
           AND profile.profile_status = 'public'
           AND ${TARGET_PUBLIC_CATALOG_PROFILE_READY}
           AND (profile.expires_at IS NULL OR profile.expires_at > now())
         ORDER BY CASE WHEN profile.canonical_slug = lower($1) THEN 0 ELSE 1 END
         LIMIT 1`,
        [slug],
      );

      const row = result.rows[0];
      return row && isPublicTargetProfileRow(row, now())
        ? toTargetPublicHotelProfileProjection(row)
        : null;
    },
    async findProfileByCustomDomain(domain) {
      const normalizedDomain = normalizeDomain(domain);
      if (!normalizedDomain) return null;

      const result = await pool.query<TargetPublicHotelProfileRow>(
        `${TARGET_PUBLIC_PROFILE_SELECT}
         LEFT JOIN hotel_catalog.property_domains verified_domain
           ON verified_domain.property_id = profile.property_id
          AND verified_domain.hostname = lower($1)
          AND verified_domain.verification_status = 'verified'
          AND verified_domain.canonical_when_verified = TRUE
         WHERE verified_domain.property_id IS NOT NULL
           AND profile.public_visibility = 'public_safe'
           AND profile.profile_status = 'public'
           AND ${TARGET_PUBLIC_CATALOG_PROFILE_READY}
           AND (profile.expires_at IS NULL OR profile.expires_at > now())
         LIMIT 1`,
        [normalizedDomain],
      );

      const row = result.rows[0];
      return row && isPublicTargetProfileRow(row, now())
        ? toTargetPublicHotelProfileProjection(row)
        : null;
    },
    async close() {
      if (ownsPool) {
        await pool.end();
      }
    },
  };
}

export function toPublicHotelProfileProjection(
  row: BookingHotelProfileRow,
  generatedAt: string,
  options: { bookingHostBase?: string } = {},
): PublicBookabilityProfileProjection {
  const defaultLocale = row.default_language?.trim() || "en";
  const supportedLocales = withRequiredFirst(
    nonEmptyStrings(row.supported_languages, [defaultLocale]),
    defaultLocale,
  );
  const defaultCurrency = row.currency?.trim() || "EUR";
  const supportedCurrencies = withRequiredFirst(
    nonEmptyStrings(row.supported_currencies, [defaultCurrency]),
    defaultCurrency,
  );
  const customDomainUrl = toCustomDomainUrl(row.custom_domain);
  const bookingBaseUrl =
    customDomainUrl ?? fallbackBookingBaseUrl(row.slug, options.bookingHostBase);
  const images = nonEmptyStrings(row.images, []).slice(0, 10);
  const heroImage = row.hero_image?.trim();
  const lastUpdatedAt = toIsoDateTime(row.updated_at) ?? generatedAt;
  const cancellationSummary =
    row.cancellation_policy_text?.trim() ||
    (row.free_cancellation_days
      ? `Free cancellation until ${row.free_cancellation_days} days before arrival.`
      : null);

  return buildPublicBookabilityProfileProjection(generatedAt, {
    hotelCatalog: {
      propertyId: String(row.id),
      slug: row.slug,
      name: row.name,
      timezone: row.timezone || "UTC",
      defaultLocale,
      supportedLocales,
      location: {
        country: row.country || "",
        city: row.location || "",
      },
      summary: row.description || null,
      images: images.map((url) => ({ url, alt: row.name })),
      amenities: nonEmptyStrings(row.amenities, []),
      publicContacts: [],
      profileComplete: Boolean(row.name && row.slug && row.country && row.location),
      profileVerified: true,
      lastUpdatedAt,
    },
    booking: {
      branding: {
        logoUrl: null,
        heroImage: heroImage || null,
        heroHeading: row.name || null,
        heroSubtext: row.description || null,
        primaryColor: null,
        fontPairing: null,
      },
      policies: {
        checkInFrom: row.check_in_time ?? null,
        checkOutUntil: row.check_out_time ?? null,
        cancellationSummary,
        termsUrl: row.terms_text?.trim() ? `${bookingBaseUrl}/${defaultLocale}/terms` : null,
      },
      capabilities: {
        instantBook: row.instant_book ?? false,
        promoCodes: true,
        referralCodes: true,
      },
      supportedQuoteParameters: {
        minRooms: 1,
        maxRooms: 5,
        minAdults: 1,
        maxAdults: 8,
        childrenSupported: true,
        adultAgeThreshold: 18,
        supportedCurrencies,
        supportedLocales,
      },
      lastUpdatedAt,
    },
    pms: {
      availabilityReady: false,
      freshness: { status: "unknown", reasonCode: "not_configured" },
    },
    finance: {
      defaultCurrency,
      supportedCurrencies,
      onlinePayment: row.online_card_payment ?? false,
      payAtProperty: row.pay_at_property_enabled ?? false,
      lastUpdatedAt,
    },
    bookingWeb: {
      canonicalUrl: `${bookingBaseUrl}/${defaultLocale}`,
      bookingBaseUrl,
      customDomainUrl,
      domainVerified: Boolean(customDomainUrl),
      bookingDeepLinks: true,
    },
  });
}

export function serializePublicHotelProfileProjection(
  projection: PublicBookabilityProfileProjection,
): PublicBookabilityProfileProjection {
  const hotel = serializeHotelProfile(projection.hotel);
  const freshness = serializeFreshness(projection.freshness);
  const serialized: PublicBookabilityProfileProjection = {
    contractVersion: projection.contractVersion,
    generatedAt: projection.generatedAt,
    publicVisibility: projection.publicVisibility,
    hotel,
    freshness,
    dataSources: projection.dataSources.map((source) => source),
  };

  assertPublicBookabilityPublicSafe(serialized);
  return serialized;
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

type HttpError = Error & {
  statusCode: number;
};

function serializeHotelProfile(
  hotel: PublicBookabilityHotelProfile,
): PublicBookabilityHotelProfile {
  return {
    propertyId: hotel.propertyId,
    slug: hotel.slug,
    name: hotel.name,
    canonicalUrl: hotel.canonicalUrl,
    bookingBaseUrl: hotel.bookingBaseUrl,
    customDomainUrl: hotel.customDomainUrl,
    timezone: hotel.timezone,
    defaultLocale: hotel.defaultLocale,
    supportedLocales: hotel.supportedLocales.map((locale) => locale),
    defaultCurrency: hotel.defaultCurrency,
    supportedCurrencies: hotel.supportedCurrencies.map((currency) => currency),
    location: {
      country: hotel.location.country,
      city: hotel.location.city,
      region: hotel.location.region ?? null,
      latitude: hotel.location.latitude ?? null,
      longitude: hotel.location.longitude ?? null,
    },
    summary: hotel.summary ?? null,
    ...(hotel.branding
      ? {
          branding: {
            logoUrl: hotel.branding.logoUrl ?? null,
            heroImage: hotel.branding.heroImage ?? null,
            heroHeading: hotel.branding.heroHeading ?? null,
            heroSubtext: hotel.branding.heroSubtext ?? null,
            primaryColor: hotel.branding.primaryColor ?? null,
            fontPairing: hotel.branding.fontPairing ?? null,
          },
        }
      : {}),
    images: hotel.images.map((image) => ({
      url: image.url,
      alt: image.alt ?? null,
    })),
    amenities: hotel.amenities.map((amenity) => amenity),
    publicContacts: publicContactArray(hotel.publicContacts),
    policies: {
      checkInFrom: hotel.policies.checkInFrom ?? null,
      checkOutUntil: hotel.policies.checkOutUntil ?? null,
      cancellationSummary: hotel.policies.cancellationSummary ?? null,
      termsUrl: hotel.policies.termsUrl ?? null,
    },
    capabilities: {
      instantBook: hotel.capabilities.instantBook,
      onlinePayment: hotel.capabilities.onlinePayment,
      payAtProperty: hotel.capabilities.payAtProperty,
      promoCodes: hotel.capabilities.promoCodes,
      referralCodes: hotel.capabilities.referralCodes,
      bookingDeepLinks: hotel.capabilities.bookingDeepLinks,
    },
    supportedQuoteParameters: {
      minRooms: hotel.supportedQuoteParameters.minRooms,
      maxRooms: hotel.supportedQuoteParameters.maxRooms,
      minAdults: hotel.supportedQuoteParameters.minAdults,
      maxAdults: hotel.supportedQuoteParameters.maxAdults,
      childrenSupported: hotel.supportedQuoteParameters.childrenSupported,
      adultAgeThreshold: hotel.supportedQuoteParameters.adultAgeThreshold,
      supportedCurrencies: hotel.supportedQuoteParameters.supportedCurrencies.map(
        (currency) => currency,
      ),
      supportedLocales: hotel.supportedQuoteParameters.supportedLocales.map((locale) => locale),
    },
    trust: {
      profileComplete: hotel.trust.profileComplete,
      profileVerified: hotel.trust.profileVerified,
      domainVerified: hotel.trust.domainVerified,
      bookabilityStatus: hotel.trust.bookabilityStatus,
      reasonCodes: hotel.trust.reasonCodes.map((reasonCode) => reasonCode),
    },
  };
}

function serializeFreshness(freshness: PublicBookabilityFreshness): PublicBookabilityFreshness {
  return {
    status: freshness.status,
    generatedAt: freshness.generatedAt,
    sources: freshness.sources.map(serializeFreshnessSource),
  };
}

function serializeFreshnessSource(
  source: PublicBookabilityFreshnessSource,
): PublicBookabilityFreshnessSource {
  return {
    owner: source.owner,
    lastUpdatedAt: source.lastUpdatedAt,
    status: source.status,
    reasonCode: source.reasonCode,
  };
}

function nonEmptyStrings(value: unknown, fallback: string[]): string[] {
  const parsed = typeof value === "string" ? parseJson<unknown>(value, []) : value;
  const values = Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return values.length > 0 ? values.map((value) => value.trim()) : fallback;
}

function withRequiredFirst(values: string[], required: string): string[] {
  const normalizedRequired = required.trim();
  return [
    normalizedRequired,
    ...values.filter((value) => value.trim() && value.trim() !== normalizedRequired),
  ];
}

function toCustomDomainUrl(value: string | null): string | null {
  const domain = value
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");
  return domain ? `https://${domain}` : null;
}

function fallbackBookingBaseUrl(slug: string, bookingHostBase = "booking.vayada.com"): string {
  const hostBase = bookingHostBase
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");

  return `https://${slug}.${hostBase || "booking.vayada.com"}`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toIsoDateTime(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const TARGET_PUBLIC_PROFILE_SELECT = `SELECT
           profile.property_id::text AS "propertyId",
           profile.contract_version AS "contractVersion",
           profile.public_visibility AS "publicVisibility",
           profile.public_id AS "publicId",
           profile.canonical_slug AS "canonicalSlug",
           profile.canonical_url AS "canonicalUrl",
           profile.booking_base_url AS "bookingBaseUrl",
           profile.custom_domain_url AS "customDomainUrl",
           profile.timezone,
           profile.default_locale AS "defaultLocale",
           profile.supported_locales AS "supportedLocales",
           profile.default_currency AS "defaultCurrency",
           profile.supported_currencies AS "supportedCurrencies",
           profile.profile_status AS "profileStatus",
           profile.public_identity AS "publicIdentity",
           profile.location,
           profile.media,
           profile.amenities,
           catalog_profile.public_contacts AS "publicContacts",
           profile.policies,
           profile.capabilities,
           profile.supported_quote_parameters AS "supportedQuoteParameters",
           booking_header_logo.public_cdn_url AS "bookingHeaderLogo",
           booking_branding.hero_image_url AS "bookingHeroImage",
           booking_branding.hero_heading AS "bookingHeroHeading",
           booking_branding.hero_subtext AS "bookingHeroSubtext",
           booking_branding.primary_color AS "bookingPrimaryColor",
           booking_branding.font_pairing AS "bookingFontPairing",
           profile.public_setup_completeness AS "publicSetupCompleteness",
           profile.source_freshness AS "sourceFreshness",
           profile.freshness_status AS "freshnessStatus",
           profile.data_sources AS "dataSources",
           profile.generated_at AS "generatedAt",
           profile.expires_at AS "expiresAt"
         FROM distribution.public_hotel_bookability_profiles profile
         JOIN hotel_catalog.property_public_profile_read_model catalog_profile
           ON catalog_profile.property_id = profile.property_id
         LEFT JOIN booking.booking_settings booking_branding
           ON booking_branding.property_id = profile.property_id
         LEFT JOIN LATERAL (
           SELECT variant.public_cdn_url
           FROM platform.media_objects media
           JOIN platform.media_variants variant
             ON variant.media_object_id = media.id
            AND variant.visibility = 'public'
            AND variant.public_cdn_url LIKE 'https://%'
           WHERE media.id = booking_branding.header_logo_media_object_id
             AND media.purpose = 'booking.header_logo'
             AND media.visibility = 'public'
             AND media.public_approved = TRUE
             AND media.lifecycle_status = 'active'
             AND media.resource_product = 'booking'
             AND media.resource_type = 'booking_hotel'
             AND (
               media.resource_id = profile.property_id::text
               OR EXISTS (
                 SELECT 1
                 FROM hotel_catalog.property_source_links source_link
                 WHERE source_link.property_id = profile.property_id
                   AND source_link.source_system = 'booking'
                   AND source_link.source_id = media.resource_id
                   AND source_link.relationship = 'canonical_input'
                   AND source_link.status = 'active'
               )
             )
           ORDER BY (variant.variant_name = 'original_safe') DESC, variant.created_at, variant.id
           LIMIT 1
         ) booking_header_logo ON TRUE`;

function toTargetPublicHotelProfileProjection(
  row: TargetPublicHotelProfileRow,
): PublicBookabilityProfileProjection {
  const identity = objectValue(row.publicIdentity);
  const location = objectValue(row.location);
  const capabilities = objectValue(row.capabilities);
  const policies = objectValue(row.policies);
  const quoteParameters = objectValue(row.supportedQuoteParameters);
  const setupCompleteness = objectValue(row.publicSetupCompleteness);
  const generatedAt = toIsoDateTime(row.generatedAt) ?? new Date().toISOString();
  const missingReadiness = stringArray(setupCompleteness["missing"], []);
  const sources = freshnessSources(row.sourceFreshness, row.dataSources, generatedAt);
  const effectiveFreshness = effectiveFreshnessStatus(row.freshnessStatus, sources);
  const publicCapabilities = {
    instantBook: booleanValue(capabilities["instantBook"]),
    onlinePayment: booleanValue(capabilities["onlinePayment"]),
    payAtProperty: booleanValue(capabilities["payAtProperty"]),
    promoCodes: booleanValue(capabilities["promoCodes"]),
    referralCodes: booleanValue(capabilities["referralCodes"]),
    bookingDeepLinks: booleanValue(capabilities["bookingDeepLinks"]),
  };
  const trust = targetProfileTrust(
    row.profileStatus,
    effectiveFreshness,
    setupCompleteness,
    missingReadiness,
    publicCapabilities,
  );
  const customDomainUrl = httpsOrigin(row.customDomainUrl);
  const bookingBaseUrl = customDomainUrl ?? row.bookingBaseUrl;
  const canonicalUrl = customDomainUrl
    ? `${customDomainUrl}/${encodeURIComponent(row.defaultLocale)}`
    : row.canonicalUrl;

  const projection: PublicBookabilityProfileProjection = {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    hotel: {
      propertyId: stringValue(identity["propertyId"]) ?? row.publicId,
      slug: stringValue(identity["slug"]) ?? row.canonicalSlug,
      name: stringValue(identity["name"]) ?? row.publicId,
      canonicalUrl,
      bookingBaseUrl,
      customDomainUrl,
      timezone: row.timezone,
      defaultLocale: row.defaultLocale,
      supportedLocales: stringArray(row.supportedLocales, [row.defaultLocale]),
      defaultCurrency: row.defaultCurrency,
      supportedCurrencies: stringArray(row.supportedCurrencies, [row.defaultCurrency]),
      location: {
        country: stringValue(location["country"]) ?? "",
        city: stringValue(location["city"]) ?? "",
        region: stringValue(location["region"]),
        latitude: numberValue(location["latitude"]),
        longitude: numberValue(location["longitude"]),
      },
      summary: stringValue(identity["summary"]),
      ...publicBookingBranding(row),
      images: galleryImageArray(row.media),
      amenities: amenityArray(row.amenities),
      publicContacts: publicContactArray(row.publicContacts),
      policies: {
        checkInFrom: stringValue(policies["checkInFrom"]),
        checkOutUntil: stringValue(policies["checkOutUntil"]),
        cancellationSummary: stringValue(policies["cancellationSummary"]),
        termsUrl: stringValue(policies["termsUrl"]),
      },
      capabilities: publicCapabilities,
      supportedQuoteParameters: {
        minRooms: integerValue(quoteParameters["minRooms"], 1),
        maxRooms: integerValue(quoteParameters["maxRooms"], 1),
        minAdults: integerValue(quoteParameters["minAdults"], 1),
        maxAdults: integerValue(quoteParameters["maxAdults"], 1),
        childrenSupported: booleanValue(quoteParameters["childrenSupported"]),
        adultAgeThreshold: integerValue(quoteParameters["adultAgeThreshold"], 18),
        supportedCurrencies: stringArray(
          quoteParameters["supportedCurrencies"],
          stringArray(row.supportedCurrencies, [row.defaultCurrency]),
        ),
        supportedLocales: stringArray(
          quoteParameters["supportedLocales"],
          stringArray(row.supportedLocales, [row.defaultLocale]),
        ),
      },
      trust: {
        profileComplete: row.profileStatus === "public",
        profileVerified: row.profileStatus === "public",
        domainVerified: Boolean(customDomainUrl),
        bookabilityStatus: trust.status,
        reasonCodes: trust.reasonCodes,
      },
    },
    freshness: {
      status: effectiveFreshness,
      generatedAt,
      sources,
    },
    dataSources: dataSources(row.dataSources),
  };

  assertPublicBookabilityPublicSafe(projection);
  return projection;
}

function publicBookingBranding(
  row: TargetPublicHotelProfileRow,
): Pick<PublicBookabilityHotelProfile, "branding"> {
  const branding = {
    logoUrl: stringValue(row.bookingHeaderLogo),
    heroImage: stringValue(row.bookingHeroImage),
    heroHeading: stringValue(row.bookingHeroHeading),
    heroSubtext: stringValue(row.bookingHeroSubtext),
    primaryColor: stringValue(row.bookingPrimaryColor),
    fontPairing: stringValue(row.bookingFontPairing),
  };
  return Object.values(branding).some((value) => value !== null) ? { branding } : {};
}

function normalizeDomain(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+|\.+$/g, "");
  return normalized || null;
}

function isPublicTargetProfileRow(row: TargetPublicHotelProfileRow, now: Date): boolean {
  if (row.publicVisibility !== PUBLIC_BOOKABILITY_VISIBILITY || row.profileStatus !== "public") {
    return false;
  }
  if (!row.expiresAt) return true;
  const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > now.getTime();
}

function httpsOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function integerValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : fallback;
  }
  return fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  const values = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return values.length > 0 ? values.map((item) => item.trim()) : fallback;
}

function imageArray(value: unknown): PublicBookabilityHotelProfile["images"] {
  if (!Array.isArray(value)) return [];
  const images: PublicBookabilityHotelProfile["images"] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      images.push({ url: entry.trim(), alt: null });
      continue;
    }
    const object = objectValue(entry);
    const mediaType = stringValue(object["type"]) ?? stringValue(object["mediaType"]);
    if (mediaType === "logo") continue;
    const url = stringValue(object["url"]);
    if (url) {
      images.push({ url, alt: stringValue(object["alt"]) ?? stringValue(object["altText"]) });
    }
  }
  return images;
}

function galleryImageArray(value: unknown): PublicBookabilityHotelProfile["images"] {
  if (!Array.isArray(value)) return [];
  return imageArray(
    value
      .filter((entry) => stringValue(objectValue(entry)["type"]) === "gallery_image")
      .slice(0, 10),
  );
}

function amenityArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : stringValue(objectValue(entry)["key"])))
    .filter((entry): entry is string => Boolean(entry));
}

function publicContactArray(value: unknown): PublicBookabilityHotelProfile["publicContacts"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const contact = objectValue(entry);
    const type = stringValue(contact["type"]);
    const contactValue = stringValue(contact["value"]);
    const publicType = PUBLIC_BOOKABILITY_CONTACT_CHANNEL_TYPES.find(
      (allowedType) => allowedType === type,
    );
    if (!publicType || !contactValue || contact["isPublic"] === false) return [];
    return [
      {
        type: publicType,
        value: contactValue,
      },
    ];
  });
}

function dataSources(value: unknown): PublicBookabilityDataSourceOwner[] {
  const allowed = new Set(["hotel_catalog", "booking", "pms", "finance", "distribution"]);
  const sources = stringArray(value, ["hotel_catalog", "distribution"]).filter((source) =>
    allowed.has(source),
  ) as PublicBookabilityDataSourceOwner[];
  return sources.includes("distribution") ? sources : [...sources, "distribution"];
}

function freshnessStatus(value: string): PublicBookabilityFreshnessStatus {
  if (["fresh", "stale", "unavailable", "unknown"].includes(value)) {
    return value as PublicBookabilityFreshnessStatus;
  }
  return "unknown";
}

function effectiveFreshnessStatus(
  declaredStatus: string,
  sources: PublicBookabilityFreshnessSource[],
): PublicBookabilityFreshnessStatus {
  const statuses = [freshnessStatus(declaredStatus), ...sources.map((source) => source.status)];
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("unknown")) return "unknown";
  return "fresh";
}

function freshnessSources(
  value: unknown,
  owners: string[],
  generatedAt: string,
): PublicBookabilityFreshnessSource[] {
  const sourceObject = objectValue(value);
  return dataSources(owners).map((owner) => {
    const entry = objectValue(sourceObject[owner]);
    return {
      owner,
      lastUpdatedAt:
        stringValue(entry["lastUpdatedAt"]) ?? stringValue(entry["generatedAt"]) ?? generatedAt,
      status: freshnessStatus(stringValue(entry["status"]) ?? "unknown"),
      reasonCode: freshnessReasonCode(entry["reasonCode"]),
    };
  });
}

function freshnessReasonCode(
  value: unknown,
): PublicBookabilityFreshnessSource["reasonCode"] | undefined {
  if (value === "source_unavailable" || value === "source_stale" || value === "not_configured") {
    return value;
  }
  return undefined;
}

function targetProfileTrust(
  profileStatus: string,
  freshness: PublicBookabilityFreshnessStatus,
  setupCompleteness: Record<string, unknown>,
  missing: string[],
  capabilities: PublicBookabilityHotelProfile["capabilities"],
): { status: PublicBookabilityStatus; reasonCodes: PublicBookabilityReasonCode[] } {
  const reasonCodes: PublicBookabilityReasonCode[] = [];

  if (profileStatus !== "public") reasonCodes.push("unpublished");
  if (freshness === "stale") reasonCodes.push("stale_data");
  if (freshness === "unavailable" || freshness === "unknown") {
    reasonCodes.push("unavailable_data");
  }
  if (!missing.includes("availability_source") && missing.includes("sellable_availability")) {
    reasonCodes.push("sold_out");
  }
  if (
    missing.includes("payment_method") ||
    (!capabilities.onlinePayment && !capabilities.payAtProperty)
  ) {
    reasonCodes.push("payment_disabled");
  }

  const knownReadinessReasons = new Set(["sellable_availability", "payment_method", "freshness"]);
  if (
    missing.some((reason) => !knownReadinessReasons.has(reason)) ||
    (setupCompleteness["status"] !== "ready" && missing.length === 0)
  ) {
    reasonCodes.push("unavailable_data");
  }

  const deduped = [...new Set(reasonCodes)];
  return {
    status:
      deduped.length === 0
        ? "bookable"
        : freshness === "stale" && deduped.every((reason) => reason === "stale_data")
          ? "stale"
          : "unavailable",
    reasonCodes: deduped,
  };
}
