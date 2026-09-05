import type { FastifyInstance, FastifyReply } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

export const MARKETPLACE_OFFERS_CONTRACT = {
  method: "GET",
  path: "/api/marketplace/offers",
  doc: "engineering/marketplace-discovery-contract.md",
} as const;

export const MARKETPLACE_CREATORS_CONTRACT = {
  method: "GET",
  path: "/api/marketplace/creators",
  doc: "engineering/marketplace-discovery-contract.md",
} as const;

export const MARKETPLACE_DISCOVERY_DEFAULT_LIMIT = 100;
export const MARKETPLACE_DISCOVERY_MIN_LIMIT = 1;
export const MARKETPLACE_DISCOVERY_MAX_LIMIT = 200;

export type MarketplacePlatformName =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "blog"
  | "x"
  | "other";

export type MarketplaceCompensationOptionSummary = {
  compensationOptionId: string;
  compensationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: MarketplacePlatformName[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null;
  currency: string | null;
  discountPercentage: number | null;
  commissionPercentage: number | null;
  minFollowers: number | null;
  termsSummary: string | null;
};

export type MarketplaceCreatorRequirements = {
  platforms: MarketplacePlatformName[];
  targetCountries: string[];
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[] | null;
  creatorTypes: ("lifestyle" | "travel" | "other")[];
};

export type MarketplaceOfferDeliverable = {
  deliverableId: string;
  platform: MarketplacePlatformName;
  deliverableType: string;
  quantity: number;
  timingGuidance: string | null;
};

export type MarketplaceOfferReadModel = {
  offerId: string;
  offerPublicId: string;
  offerTitle: string;
  offerSummary: string | null;
  hotelName: string;
  hotelSlug: string;
  hotelAccommodationType: string | null;
  hotelLocation: {
    displayText: string;
    countryCode?: string;
    region?: string;
    city?: string;
    timezone?: string;
  };
  hotelCoverImageUrl: string | null;
  hotelImageUrls: string[];
  deliverables: MarketplaceOfferDeliverable[];
  compensationOptions: MarketplaceCompensationOptionSummary[];
  creatorRequirements: MarketplaceCreatorRequirements | null;
  createdAt: string;
  projectedAt: string;
};

export type MarketplaceCreatorPlatform = {
  platformId: string;
  platform: MarketplacePlatformName;
  handle: string;
  profileUrl: string | null;
  followerCount: number;
  engagementRate: number;
  audienceCountries: { country: string; percentage: number }[];
  audienceAgeGroups: { ageRange: string; percentage: number }[];
  audienceGenderSplit: { male: number; female: number; other?: number } | null;
};

export type MarketplaceCreatorReadModel = {
  creatorId: string;
  displayName: string;
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  profilePictureUrl: string | null;
  creatorType: "lifestyle" | "travel" | "other";
  platforms: MarketplaceCreatorPlatform[];
  audienceSize: number;
  averageRating: number;
  totalReviews: number;
  createdAt: string;
};

export type MarketplaceDiscoveryPagination = {
  limit: number;
  offset: number;
  total: number;
};

export type MarketplaceOfferPage = {
  items: MarketplaceOfferReadModel[];
  pagination: MarketplaceDiscoveryPagination;
};

export type MarketplaceCreatorPage = {
  items: MarketplaceCreatorReadModel[];
  pagination: MarketplaceDiscoveryPagination;
};

export type MarketplaceDiscoveryError = {
  statusCode: 400 | 500;
  code: "invalid_query" | "internal_error";
  category: "validation" | "internal";
  message: string;
};

export type MarketplaceDiscoveryPageRequest = {
  limit: number;
  offset: number;
};

// Repository obligations (engineering/marketplace-discovery-contract.md):
// - offers: only visibility_status = 'public' rows, ordered
//   createdAt DESC, offerId ASC; total counts the full eligible set.
// - creators: only base-complete, profile_status = 'active', non-null
//   source ID rows, ordered createdAt DESC, creatorId ASC;
//   averageRating rounded to 2 decimals over creator_ratings rows.
// - IDs are the LEGACY marketplace UUIDs (ID continuity clause), not
//   target-schema primary keys.
export type MarketplaceDiscoveryReadRepository = {
  listPublicOffers(
    page: MarketplaceDiscoveryPageRequest,
  ): Promise<{ items: MarketplaceOfferReadModel[]; total: number }>;
  listPublicCreators(
    page: MarketplaceDiscoveryPageRequest,
  ): Promise<{ items: Omit<MarketplaceCreatorReadModel, "audienceSize">[]; total: number }>;
  close?(): Promise<void>;
};

export type MarketplaceDiscoveryReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type MarketplaceOfferRow = {
  offerId: string;
  offerPublicId: string;
  offerTitle: string;
  offerSummary: string | null;
  hotelName: string;
  hotelSlug: string;
  hotelAccommodationType: string | null;
  hotelLocation: unknown;
  hotelCoverImageUrl: string | null;
  hotelImageUrls: string[] | null;
  deliverables: unknown;
  compensationOptions: unknown;
  creatorRequirements: unknown;
  createdAt: Date | string;
  projectedAt: Date | string;
};

type MarketplaceCreatorRow = {
  creatorId: string;
  displayName: string;
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  profilePictureUrl: string | null;
  creatorType: string;
  platforms: unknown;
  averageRating: number | string | null;
  totalReviews: number | string | null;
  createdAt: Date | string;
};

export function createPgMarketplaceDiscoveryReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: MarketplaceDiscoveryReadPool;
}): MarketplaceDiscoveryReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Marketplace discovery repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });
  return {
    async listPublicOffers(page) {
      const [offerResult, countResult] = await Promise.all([
        pool.query<MarketplaceOfferRow>(
          `SELECT
             offer.id::text AS "offerId",
             read_model.public_id AS "offerPublicId",
             read_model.offer_title AS "offerTitle",
             read_model.offer_summary AS "offerSummary",
             COALESCE(property_profile.display_name, read_model.display_name, property.display_name)
               AS "hotelName",
             COALESCE(property_profile.canonical_slug, read_model.canonical_slug, property.public_id)
               AS "hotelSlug",
             property.property_type AS "hotelAccommodationType",
             COALESCE(property_profile.location, '{}'::jsonb) AS "hotelLocation",
             COALESCE(media.cover_image_url, read_model.image_urls[1]) AS "hotelCoverImageUrl",
             COALESCE(media.image_urls, read_model.image_urls, '{}') AS "hotelImageUrls",
             COALESCE(deliverables.items, '[]'::jsonb) AS deliverables,
             COALESCE(compensation.items, '[]'::jsonb) AS "compensationOptions",
             requirements.item AS "creatorRequirements",
             offer.created_at AS "createdAt",
             read_model.projected_at AS "projectedAt"
           FROM marketplace.marketplace_offer_read_model read_model
           JOIN marketplace.marketplace_offers offer
             ON offer.id = read_model.offer_id
            AND offer.property_id = read_model.property_id
           JOIN hotel_catalog.properties property
             ON property.id = read_model.property_id
           LEFT JOIN hotel_catalog.property_public_profile_read_model property_profile
             ON property_profile.property_id = read_model.property_id
           LEFT JOIN LATERAL (
             SELECT
               (array_agg(
                 media_entry->>'url'
                 ORDER BY CASE WHEN media_entry->>'type' = 'hero_image' THEN 0 ELSE 1 END
               ))[1] AS cover_image_url,
               array_agg(
                 media_entry->>'url'
                 ORDER BY CASE WHEN media_entry->>'type' = 'hero_image' THEN 0 ELSE 1 END
               ) AS image_urls
             FROM jsonb_array_elements(COALESCE(property_profile.media, '[]'::jsonb)) media_entry
             WHERE media_entry->>'type' IN ('hero_image', 'gallery_image')
               AND media_entry ? 'platformMediaObjectId'
               AND media_entry->>'url' LIKE 'https://%'
           ) media ON TRUE
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(
               jsonb_build_object(
                 'deliverableId', deliverable.id::text,
                 'platform', deliverable.platform,
                 'deliverableType', deliverable.deliverable_type,
                 'quantity', deliverable.quantity,
                 'timingGuidance', deliverable.timing_guidance
               ) ORDER BY deliverable.created_at, deliverable.id
             ) AS items
             FROM marketplace.offer_deliverables deliverable
             WHERE deliverable.offer_id = offer.id
               AND deliverable.property_id = offer.property_id
               AND deliverable.organization_id = offer.organization_id
           ) deliverables ON TRUE
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(
               jsonb_build_object(
                 'compensationOptionId', option.id::text,
                 'compensationType', option.compensation_type,
                 'availabilityMonths', option.availability_months,
                 'platforms', option.platforms,
                 'freeStayMinNights', option.free_stay_min_nights,
                 'freeStayMaxNights', option.free_stay_max_nights,
                 'paidMaxAmount', option.paid_max_amount::text,
                 'currency', option.currency,
                 'discountPercentage', option.discount_percentage,
                 'commissionPercentage', option.commission_percentage,
                 'minFollowers', option.min_followers,
                 'termsSummary', option.terms_summary
               ) ORDER BY option.created_at, option.id
             ) AS items
             FROM marketplace.offer_compensation_options option
             WHERE option.offer_id = offer.id
               AND option.property_id = offer.property_id
               AND option.organization_id = offer.organization_id
           ) compensation ON TRUE
           LEFT JOIN LATERAL (
             SELECT jsonb_build_object(
               'platforms', requirement.platforms,
               'targetCountries', requirement.target_countries,
               'targetAgeMin', requirement.target_age_min,
               'targetAgeMax', requirement.target_age_max,
               'targetAgeGroups', requirement.target_age_groups,
               'creatorTypes', requirement.creator_types
             ) AS item
             FROM marketplace.offer_creator_requirements requirement
             WHERE requirement.offer_id = offer.id
               AND requirement.property_id = offer.property_id
               AND requirement.organization_id = offer.organization_id
           ) requirements ON TRUE
           WHERE read_model.visibility_status = 'public'
             AND offer.offer_status = 'verified'
           ORDER BY offer.created_at DESC, offer.id ASC
           LIMIT $1 OFFSET $2`,
          [page.limit, page.offset],
        ),
        pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
           FROM marketplace.marketplace_offer_read_model read_model
           JOIN marketplace.marketplace_offers offer
             ON offer.id = read_model.offer_id
            AND offer.property_id = read_model.property_id
           LEFT JOIN hotel_catalog.property_public_profile_read_model property_profile
             ON property_profile.property_id = read_model.property_id
           WHERE read_model.visibility_status = 'public'
             AND offer.offer_status = 'verified'`,
        ),
      ]);

      return {
        items: offerResult.rows.map(mapMarketplaceOfferRow),
        total: parseCount(countResult.rows[0]?.total),
      };
    },
    async listPublicCreators(page) {
      const [creatorResult, countResult] = await Promise.all([
        pool.query<MarketplaceCreatorRow>(
          `SELECT
             creator.source_creator_id AS "creatorId",
             creator.display_name AS "displayName",
             creator.location_text AS "locationText",
             creator.short_description AS "shortDescription",
             creator.portfolio_url AS "portfolioUrl",
             creator.profile_picture_url AS "profilePictureUrl",
             creator.creator_type AS "creatorType",
             COALESCE(platforms.platforms, '[]'::jsonb) AS platforms,
             COALESCE(ROUND(ratings.average_rating::numeric, 2), 0) AS "averageRating",
             COALESCE(ratings.total_reviews, 0)::text AS "totalReviews",
             creator.created_at AS "createdAt"
           FROM marketplace.creator_profiles creator
           LEFT JOIN LATERAL (
             SELECT jsonb_agg(
                      jsonb_build_object(
                        'platformId', platform.id::text,
                        'platform', platform.platform,
                        'handle', platform.handle,
                        'profileUrl', platform.profile_url,
                        'followerCount', platform.follower_count,
                        'engagementRate', platform.engagement_rate,
                        'audienceCountries', platform.audience_countries,
                        'audienceAgeGroups', platform.audience_age_groups,
                        'audienceGenderSplit', platform.audience_gender_split
                      )
                      ORDER BY platform.created_at DESC, platform.id ASC
                    ) AS platforms
             FROM marketplace.creator_platforms platform
             WHERE platform.creator_profile_id = creator.id
               AND platform.organization_id = creator.organization_id
           ) platforms ON TRUE
           LEFT JOIN LATERAL (
             SELECT AVG(rating.rating) AS average_rating,
                    COUNT(*) AS total_reviews
             FROM marketplace.creator_ratings rating
             WHERE rating.creator_profile_id = creator.id
               AND rating.creator_organization_id = creator.organization_id
           ) ratings ON TRUE
           WHERE marketplace.creator_profile_is_complete(
               creator.id,
               creator.organization_id
             )
             AND creator.profile_status = 'active'
             AND creator.source_creator_id IS NOT NULL
           ORDER BY creator.created_at DESC, creator.source_creator_id ASC
           LIMIT $1 OFFSET $2`,
          [page.limit, page.offset],
        ),
        pool.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
           FROM marketplace.creator_profiles creator
           WHERE marketplace.creator_profile_is_complete(
               creator.id,
               creator.organization_id
             )
             AND creator.profile_status = 'active'
             AND creator.source_creator_id IS NOT NULL`,
        ),
      ]);

      return {
        items: creatorResult.rows.map(mapMarketplaceCreatorRow),
        total: parseCount(countResult.rows[0]?.total),
      };
    },
    async close() {
      await pool.end();
    },
  };
}

function mapMarketplaceOfferRow(row: MarketplaceOfferRow): MarketplaceOfferReadModel {
  return {
    offerId: row.offerId,
    offerPublicId: row.offerPublicId,
    offerTitle: row.offerTitle,
    offerSummary: row.offerSummary,
    hotelName: row.hotelName,
    hotelSlug: row.hotelSlug,
    hotelAccommodationType: row.hotelAccommodationType,
    hotelLocation: toMarketplaceLocation(row.hotelLocation),
    hotelCoverImageUrl: row.hotelCoverImageUrl,
    hotelImageUrls: Array.isArray(row.hotelImageUrls) ? row.hotelImageUrls : [],
    deliverables: toMarketplaceOfferDeliverables(row.deliverables),
    compensationOptions: toMarketplaceCompensationOptions(row.compensationOptions),
    creatorRequirements: toMarketplaceCreatorRequirements(row.creatorRequirements),
    createdAt: toIsoString(row.createdAt),
    projectedAt: toIsoString(row.projectedAt),
  };
}

function mapMarketplaceCreatorRow(
  row: MarketplaceCreatorRow,
): Omit<MarketplaceCreatorReadModel, "audienceSize"> {
  return {
    creatorId: row.creatorId,
    displayName: row.displayName,
    locationText: row.locationText,
    shortDescription: row.shortDescription,
    portfolioUrl: row.portfolioUrl,
    profilePictureUrl: row.profilePictureUrl,
    creatorType: toPublicCreatorType(row.creatorType),
    platforms: toMarketplaceCreatorPlatforms(row.platforms),
    averageRating: toNumber(row.averageRating),
    totalReviews: parseCount(row.totalReviews),
    createdAt: toIsoString(row.createdAt),
  };
}

export function toMarketplaceLocation(value: unknown): MarketplaceOfferReadModel["hotelLocation"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { displayText: "" };
  }
  const location = value as Record<string, unknown>;
  const countryCode = readString(location.countryCode);
  const region = readString(location.region);
  const city = readString(location.city);
  const displayText = [...new Set([city, region, countryCode].filter(Boolean))].join(", ");
  return {
    displayText,
    ...(countryCode ? { countryCode } : {}),
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
    ...(readString(location.timezone) ? { timezone: readString(location.timezone)! } : {}),
  };
}

function toMarketplaceCompensationOptions(value: unknown): MarketplaceCompensationOptionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((compensationOption) => {
    const row = isRecord(compensationOption) ? compensationOption : {};
    const nights = isRecord(row.nights) ? row.nights : {};
    const compensationType = readString(row.compensationType) ?? readString(row.type);
    return {
      compensationOptionId: readString(row.compensationOptionId) ?? readString(row.id) ?? "",
      compensationType: toCompensationType(compensationType),
      availabilityMonths: toStringArray(row.availabilityMonths ?? row.months),
      platforms: toPlatformArray(row.platforms),
      freeStayMinNights: toNullableNumber(row.freeStayMinNights ?? nights.min),
      freeStayMaxNights: toNullableNumber(row.freeStayMaxNights ?? nights.max),
      paidMaxAmount: readString(row.paidMaxAmount),
      currency: readString(row.currency),
      discountPercentage: toNullableNumber(row.discountPercentage),
      commissionPercentage: toNullableNumber(row.commissionPercentage ?? row.commissionPercent),
      minFollowers: toNullableNumber(row.minFollowers),
      termsSummary: readString(row.termsSummary),
    };
  });
}

function toMarketplaceOfferDeliverables(value: unknown): MarketplaceOfferDeliverable[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((row) => ({
    deliverableId: readString(row.deliverableId) ?? "",
    platform: toPlatformName(readString(row.platform)),
    deliverableType: readString(row.deliverableType) ?? "other",
    quantity: Math.max(1, toNumber(row.quantity)),
    timingGuidance: readString(row.timingGuidance),
  }));
}

function toMarketplaceCreatorRequirements(value: unknown): MarketplaceCreatorRequirements | null {
  if (!value || !isRecord(value)) return null;
  return {
    platforms: toPlatformArray(value.platforms),
    targetCountries: toStringArray(value.targetCountries ?? value.countries),
    targetAgeMin: toNullableNumber(value.targetAgeMin),
    targetAgeMax: toNullableNumber(value.targetAgeMax),
    targetAgeGroups:
      value.targetAgeGroups === null
        ? null
        : toStringArray(value.targetAgeGroups ?? value.ageGroups),
    creatorTypes: toCreatorTypeArray(value.creatorTypes),
  };
}

function toCreatorTypeArray(value: unknown): ("lifestyle" | "travel" | "other")[] {
  return toStringArray(value).map((entry) =>
    entry === "lifestyle" || entry === "travel" ? entry : "other",
  );
}

function toMarketplaceCreatorPlatforms(value: unknown): MarketplaceCreatorPlatform[] {
  if (!Array.isArray(value)) return [];
  return value.map((platform) => {
    const row = isRecord(platform) ? platform : {};
    const platformName = readString(row.platform) ?? readString(row.name);
    return {
      platformId: readString(row.platformId) ?? readString(row.id) ?? "",
      platform: toPlatformName(platformName),
      handle: readString(row.handle) ?? "",
      profileUrl: toAbsoluteHttpsUrl(row.profileUrl ?? row.profile_url),
      followerCount: toNumber(row.followerCount ?? row.followers),
      engagementRate: toNumber(row.engagementRate ?? row.engagement_rate),
      audienceCountries: toAudienceCountries(row.audienceCountries ?? row.top_countries),
      audienceAgeGroups: toAudienceAgeGroups(row.audienceAgeGroups ?? row.top_age_groups),
      audienceGenderSplit: toAudienceGenderSplit(row.audienceGenderSplit ?? row.gender_split),
    };
  });
}

function toAudienceCountries(value: unknown): MarketplaceCreatorPlatform["audienceCountries"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      country: readString(entry.country) ?? "",
      percentage: toNumber(entry.percentage),
    }))
    .filter((entry) => entry.country);
}

function toAudienceAgeGroups(value: unknown): MarketplaceCreatorPlatform["audienceAgeGroups"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((entry) => ({
      ageRange: readString(entry.ageRange) ?? readString(entry.age_range) ?? "",
      percentage: toNumber(entry.percentage),
    }))
    .filter((entry) => entry.ageRange);
}

function toAudienceGenderSplit(value: unknown): MarketplaceCreatorPlatform["audienceGenderSplit"] {
  if (!value || !isRecord(value) || Object.keys(value).length === 0) return null;
  const other = value.other === undefined ? undefined : toNumber(value.other);
  return {
    male: toNumber(value.male),
    female: toNumber(value.female),
    ...(other !== undefined ? { other } : {}),
  };
}

function parseCount(value: number | string | null | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return toNumber(value);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry)).filter((entry) => entry.length > 0)
    : [];
}

function toPlatformArray(value: unknown): MarketplacePlatformName[] {
  return toStringArray(value).map(toPlatformName);
}

function toPlatformName(value: string | null | undefined): MarketplacePlatformName {
  switch (value) {
    case "instagram":
    case "tiktok":
    case "youtube":
    case "facebook":
    case "blog":
    case "x":
      return value;
    default:
      return "other";
  }
}

function toCompensationType(
  value: string | null | undefined,
): MarketplaceCompensationOptionSummary["compensationType"] {
  switch (value) {
    case "paid":
    case "discount":
    case "affiliate":
      return value;
    default:
      return "free_stay";
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toAbsoluteHttpsUrl(value: unknown): string | null {
  const rawUrl = readString(value);
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" && Boolean(url.hostname) ? rawUrl : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type MarketplaceDiscoveryRoutesOptions = {
  repository: MarketplaceDiscoveryReadRepository;
  allowedOrigins?: string[];
};

type DiscoveryQuery = {
  limit?: string | string[];
  offset?: string | string[];
};

// Public routes: documented exception to the enforceRoutePolicy requirement
// (engineering/marketplace-discovery-contract.md, Authorization). No
// RequestContext, no tenant scope; the repository must only ever surface
// public-eligible rows.
export async function registerMarketplaceDiscoveryRoutes(
  app: FastifyInstance,
  options: MarketplaceDiscoveryRoutesOptions,
): Promise<void> {
  const { repository } = options;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  // GET-only simple requests need no preflight; reflecting the allowlisted
  // Origin is the entire CORS surface for this group. Vary must be set on
  // every response (not just allowlisted ones) or shared caches replay
  // un-CORSed responses to browser consumers.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Vary", "Origin");
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
    }
  });

  app.get<{ Querystring: DiscoveryQuery }>("/offers", async (request, reply) => {
    const page = parsePageQuery(request.query);
    if ("error" in page) {
      return sendDiscoveryError(reply, page.error);
    }

    try {
      const { items, total } = await repository.listPublicOffers(page);
      const response: MarketplaceOfferPage = {
        items: items.map(serializeMarketplaceOffer),
        pagination: { limit: page.limit, offset: page.offset, total },
      };
      assertMarketplaceDiscoveryPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return response;
    } catch (error) {
      request.log.error({ err: error }, "marketplace discovery offers read failed");
      return sendDiscoveryError(reply, internalError("Failed to fetch marketplace offers."));
    }
  });

  app.get<{ Querystring: DiscoveryQuery }>("/creators", async (request, reply) => {
    const page = parsePageQuery(request.query);
    if ("error" in page) {
      return sendDiscoveryError(reply, page.error);
    }

    try {
      const { items, total } = await repository.listPublicCreators(page);
      const response: MarketplaceCreatorPage = {
        items: items.map(serializeMarketplaceCreator),
        pagination: { limit: page.limit, offset: page.offset, total },
      };
      assertMarketplaceDiscoveryPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
      return response;
    } catch (error) {
      request.log.error({ err: error }, "marketplace discovery creators read failed");
      return sendDiscoveryError(reply, internalError("Failed to fetch marketplace creators."));
    }
  });
}

export function parsePageQuery(
  query: DiscoveryQuery,
): MarketplaceDiscoveryPageRequest | { error: MarketplaceDiscoveryError } {
  const limit = parsePageParameter(query.limit, "limit");
  if (typeof limit !== "number" && limit !== undefined) return limit;
  const offset = parsePageParameter(query.offset, "offset");
  if (typeof offset !== "number" && offset !== undefined) return offset;

  return {
    limit: clamp(
      limit ?? MARKETPLACE_DISCOVERY_DEFAULT_LIMIT,
      MARKETPLACE_DISCOVERY_MIN_LIMIT,
      MARKETPLACE_DISCOVERY_MAX_LIMIT,
    ),
    offset: clamp(offset ?? 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function parsePageParameter(
  raw: string | string[] | undefined,
  name: "limit" | "offset",
): number | undefined | { error: MarketplaceDiscoveryError } {
  if (raw === undefined || raw === "") return undefined;
  if (Array.isArray(raw) || !/^-?\d+$/.test(raw.trim())) {
    return {
      error: {
        statusCode: 400,
        code: "invalid_query",
        category: "validation",
        message: `Query parameter "${name}" must be a single integer.`,
      },
    };
  }
  return Number.parseInt(raw, 10);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function internalError(message: string): MarketplaceDiscoveryError {
  return { statusCode: 500, code: "internal_error", category: "internal", message };
}

function sendDiscoveryError(
  reply: FastifyReply,
  error: MarketplaceDiscoveryError,
): MarketplaceDiscoveryError {
  void reply.status(error.statusCode);
  return error;
}

export function serializeMarketplaceOffer(
  offer: MarketplaceOfferReadModel,
): MarketplaceOfferReadModel {
  return {
    offerId: offer.offerId,
    offerPublicId: offer.offerPublicId,
    offerTitle: offer.offerTitle,
    offerSummary: offer.offerSummary ?? null,
    hotelName: offer.hotelName,
    hotelSlug: offer.hotelSlug,
    hotelAccommodationType: offer.hotelAccommodationType ?? null,
    hotelLocation: {
      displayText: offer.hotelLocation.displayText,
      ...(offer.hotelLocation.countryCode ? { countryCode: offer.hotelLocation.countryCode } : {}),
      ...(offer.hotelLocation.region ? { region: offer.hotelLocation.region } : {}),
      ...(offer.hotelLocation.city ? { city: offer.hotelLocation.city } : {}),
      ...(offer.hotelLocation.timezone ? { timezone: offer.hotelLocation.timezone } : {}),
    },
    hotelCoverImageUrl: offer.hotelCoverImageUrl ?? null,
    hotelImageUrls: offer.hotelImageUrls.map((url) => url),
    deliverables: offer.deliverables.map((deliverable) => ({ ...deliverable })),
    compensationOptions: offer.compensationOptions.map(serializeCompensationOption),
    creatorRequirements: offer.creatorRequirements
      ? serializeCreatorRequirements(offer.creatorRequirements)
      : null,
    createdAt: offer.createdAt,
    projectedAt: offer.projectedAt,
  };
}

export function serializeMarketplaceCreator(
  creator: Omit<MarketplaceCreatorReadModel, "audienceSize">,
): MarketplaceCreatorReadModel {
  const platforms = creator.platforms.map(serializeCreatorPlatform);
  return {
    creatorId: creator.creatorId,
    displayName: creator.displayName,
    locationText: creator.locationText ?? null,
    shortDescription: creator.shortDescription ?? null,
    portfolioUrl: creator.portfolioUrl ?? null,
    profilePictureUrl: creator.profilePictureUrl ?? null,
    creatorType: toPublicCreatorType(creator.creatorType),
    platforms,
    audienceSize: platforms.reduce((sum, platform) => sum + platform.followerCount, 0),
    averageRating: creator.averageRating,
    totalReviews: creator.totalReviews,
    createdAt: creator.createdAt,
  };
}

// DDL allows 'migration' on creator_profiles.creator_type; the public enum
// does not include it (contract: maps to "other").
export function toPublicCreatorType(value: string): "lifestyle" | "travel" | "other" {
  return value === "lifestyle" || value === "travel" ? value : "other";
}

function serializeCreatorPlatform(
  platform: MarketplaceCreatorPlatform,
): MarketplaceCreatorPlatform {
  return {
    platformId: platform.platformId,
    platform: platform.platform,
    handle: platform.handle,
    profileUrl: platform.profileUrl ?? null,
    followerCount: platform.followerCount,
    engagementRate: platform.engagementRate,
    audienceCountries: platform.audienceCountries.map((entry) => ({
      country: entry.country,
      percentage: entry.percentage,
    })),
    audienceAgeGroups: platform.audienceAgeGroups.map((entry) => ({
      ageRange: entry.ageRange,
      percentage: entry.percentage,
    })),
    audienceGenderSplit: platform.audienceGenderSplit
      ? {
          male: platform.audienceGenderSplit.male,
          female: platform.audienceGenderSplit.female,
          ...(platform.audienceGenderSplit.other !== undefined
            ? { other: platform.audienceGenderSplit.other }
            : {}),
        }
      : null,
  };
}

function serializeCompensationOption(
  compensationOption: MarketplaceCompensationOptionSummary,
): MarketplaceCompensationOptionSummary {
  return {
    compensationOptionId: compensationOption.compensationOptionId,
    compensationType: compensationOption.compensationType,
    availabilityMonths: compensationOption.availabilityMonths.map((month) => month),
    platforms: compensationOption.platforms.map((platform) => platform),
    freeStayMinNights: compensationOption.freeStayMinNights ?? null,
    freeStayMaxNights: compensationOption.freeStayMaxNights ?? null,
    paidMaxAmount: compensationOption.paidMaxAmount ?? null,
    currency: compensationOption.currency ?? null,
    discountPercentage: compensationOption.discountPercentage ?? null,
    commissionPercentage: compensationOption.commissionPercentage ?? null,
    minFollowers: compensationOption.minFollowers ?? null,
    termsSummary: compensationOption.termsSummary ?? null,
  };
}

function serializeCreatorRequirements(
  requirements: MarketplaceCreatorRequirements,
): MarketplaceCreatorRequirements {
  return {
    platforms: requirements.platforms.map((platform) => platform),
    targetCountries: requirements.targetCountries.map((country) => country),
    targetAgeMin: requirements.targetAgeMin ?? null,
    targetAgeMax: requirements.targetAgeMax ?? null,
    targetAgeGroups: requirements.targetAgeGroups?.map((group) => group) ?? null,
    creatorTypes: requirements.creatorTypes.map((type) => type),
  };
}

const FORBIDDEN_KEY_PATTERN =
  /(email|phone|user[_-]?id|owner|hotel_profile_id|pii|profile_?metadata|status$)/i;

export function findForbiddenMarketplaceDiscoveryKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findForbiddenMarketplaceDiscoveryKeys(item, `${path}[${index}]`),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const childPath = `${path}.${key}`;
      const own = FORBIDDEN_KEY_PATTERN.test(key) ? [childPath] : [];
      return [...own, ...findForbiddenMarketplaceDiscoveryKeys(child, childPath)];
    });
  }
  return [];
}

export function assertMarketplaceDiscoveryPublicSafe(payload: unknown): void {
  const forbidden = findForbiddenMarketplaceDiscoveryKeys(payload);
  if (forbidden.length > 0) {
    throw new Error(
      `Marketplace discovery payload contains forbidden public keys: ${forbidden.join(", ")}`,
    );
  }
}
