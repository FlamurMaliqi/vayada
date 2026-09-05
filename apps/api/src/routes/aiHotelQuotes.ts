import {
  assertPublicBookabilityPublicSafe,
  buildPublicBookabilityQuoteProjection,
  PUBLIC_BOOKABILITY_CONTRACT_VERSION,
  PUBLIC_BOOKABILITY_VISIBILITY,
  type PublicBookabilityAvailabilityOfferInput,
  type PublicBookabilityBookingOfferPolicyInput,
  type PublicBookabilityDataSourceOwner,
  type PublicBookabilityDeepLink,
  type PublicBookabilityFreshness,
  type PublicBookabilityFreshnessStatus,
  type PublicBookabilityFreshnessSource,
  type PublicBookabilityHotelProfile,
  type PublicBookabilityOffer,
  type PublicBookabilityQuoteProjection,
  type PublicBookabilityQuoteRequest,
  type PublicBookabilityReasonCode,
  type PublicBookabilityStatus,
  type PublicBookabilityUnavailableReason,
} from "@vayada/domain-distribution";
import {
  bestBookingPromotion,
  evaluateSameDayBooking,
  SAME_DAY_BOOKING_POLICY_DEFAULTS,
} from "@vayada/domain-booking";
import type { FastifyInstance } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { toPublicPmsRoomAmenityLabelsV1 } from "../domains/pmsRoomAmenityVocabulary.js";
import type { PublicHotelProfileRepository } from "./aiHotels.js";

export type PublicHotelQuoteQuery = {
  check_in?: string;
  check_out?: string;
  adults?: string;
  children?: string;
  rooms?: string;
  currency?: string;
  locale?: string;
  promo_code?: string;
  referral_code?: string;
};

export type PublicHotelQuoteRepository = {
  findQuoteBySlug(
    slug: string,
    query: PublicHotelQuoteQuery,
  ): Promise<PublicBookabilityQuoteProjection | null>;
  close?(): Promise<void>;
};

export type PublicHotelQuoteReadPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

type TargetPublicHotelQuoteRow = {
  quoteSessionId: string;
  publicQuoteReference: string;
  quoteHash: string;
  requestSnapshot: unknown;
  quoteStatus: string;
  unavailableReasons: unknown;
  offers: unknown;
  totals: unknown;
  deepLinkUrl: string | null;
  priceGuarantee: string;
  currency: string;
  sourceFreshness: unknown;
  freshnessStatus: string;
  dataSources: string[];
  generatedAt: Date | string | null;
  expiresAt: Date | string;
};

type TargetRoomOfferSnapshotQuoteRow = {
  promotionSettings?: unknown;
  nightlyRoomAmounts?: { stayDate: string; grossRoomAmount: string }[];
  publicOfferKey: string;
  roomTypeId: string;
  ratePlanId: string | null;
  roomSummary: unknown;
  rateSummary: unknown;
  occupancy: unknown;
  publicPolicy: unknown;
  paymentOptions: string[];
  availableRooms: string | number;
  roomTotal: string | number;
  taxesAndFees: string | number;
  discounts: string | number;
  currency: string;
  generatedAt: Date | string | null;
};

type TargetSameDayBookingPolicyRow = {
  timezone: string;
  enabled: boolean;
  cutoffLocalTime: string | null;
};

type PublicHotelQuoteParams = {
  slug: string;
};

const PUBLIC_QUOTE_DATA_SOURCES: PublicBookabilityDataSourceOwner[] = [
  "hotel_catalog",
  "booking",
  "pms",
  "finance",
  "distribution",
];
const PUBLIC_QUOTE_MAX_NIGHTS = 30;
const PUBLIC_QUOTE_MAX_ADVANCE_DAYS = 365;

export async function registerAiHotelQuoteRoutes(
  app: FastifyInstance,
  options: { repository: PublicHotelQuoteRepository },
): Promise<void> {
  const { repository } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get<{ Params: PublicHotelQuoteParams; Querystring: PublicHotelQuoteQuery }>(
    "/hotels/:slug/quote",
    async (request, reply) => {
      const quote = await repository.findQuoteBySlug(request.params.slug, request.query);
      if (!quote) {
        throw createHttpError(404, "Public hotel quote not found.");
      }

      const response = serializePublicHotelQuoteProjection(quote);
      assertPublicBookabilityPublicSafe(response);
      reply.header("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
      reply.header("X-Vayada-RateLimit-Policy", "public-ai-quote-read");
      reply.header("X-Robots-Tag", "noindex");
      return response;
    },
  );
}

export function createTargetPublicHotelQuoteRepository(config: {
  connectionString: string;
  profileRepository: PublicHotelProfileRepository;
  max?: number;
  pool?: PublicHotelQuoteReadPool;
  now?: () => Date;
}): PublicHotelQuoteRepository {
  const now = config.now ?? (() => new Date());
  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max ?? 5,
    });

  return {
    async findQuoteBySlug(slug, query) {
      const profile = await config.profileRepository.findProfileBySlug(slug);
      if (!profile) return null;

      const requestedAt = now();
      const parsed = parsePublicHotelQuoteRequest(profile.hotel, query, requestedAt);
      if (parsed.reasons.length > 0) {
        return toUnavailablePublicHotelQuoteProjection(profile.hotel, query, requestedAt);
      }
      if (profile.hotel.trust.bookabilityStatus !== "bookable") {
        return toUnavailablePublicHotelQuoteProjection(
          profile.hotel,
          query,
          requestedAt,
          profile.hotel.trust.reasonCodes.map((code) => ({ code })),
        );
      }

      try {
        const sameDayPolicy = await loadTargetSameDayBookingPolicy(pool, profile.hotel.propertyId);
        const sameDayDecision = evaluateSameDayBooking({
          checkIn: parsed.request.checkIn,
          policy: {
            enabled: sameDayPolicy.enabled,
            cutoffLocalTime: sameDayPolicy.cutoffLocalTime,
          },
          propertyTimeZone: sameDayPolicy.timezone,
          now: requestedAt,
        });
        if (!sameDayDecision.eligible) {
          return toUnavailablePublicHotelQuoteProjection(profile.hotel, query, requestedAt, [
            { code: "same_day_cutoff_passed" },
          ]);
        }
        const result = await pool.query<TargetPublicHotelQuoteRow>(
          `SELECT
           read_model.quote_session_id::text AS "quoteSessionId",
           read_model.public_quote_reference AS "publicQuoteReference",
           read_model.quote_hash AS "quoteHash",
           read_model.request_snapshot AS "requestSnapshot",
           read_model.quote_status AS "quoteStatus",
           read_model.unavailable_reasons AS "unavailableReasons",
           read_model.offers,
           read_model.totals,
           read_model.deep_link_url AS "deepLinkUrl",
           read_model.price_guarantee AS "priceGuarantee",
           read_model.currency,
           read_model.source_freshness AS "sourceFreshness",
           read_model.freshness_status AS "freshnessStatus",
           read_model.data_sources AS "dataSources",
           read_model.generated_at AS "generatedAt",
           read_model.expires_at AS "expiresAt"
         FROM distribution.public_quote_read_models read_model
         JOIN distribution.public_hotel_bookability_profiles profile
           ON profile.property_id = read_model.property_id
         WHERE profile.canonical_slug = $1
           AND profile.public_visibility = 'public_safe'
           AND profile.profile_status = 'public'
           AND profile.freshness_status = 'fresh'
           AND (profile.expires_at IS NULL OR profile.expires_at > $11::timestamptz)
           AND NOT EXISTS (SELECT 1 FROM booking.booking_settings settings
             WHERE settings.property_id = read_model.property_id
               AND (settings.last_minute_discount -> 'promotions' IS NOT NULL OR settings.last_minute_discount ->> 'enabled' = 'true'))
           AND read_model.public_visibility = 'public_safe'
           AND read_model.freshness_status = 'fresh'
           AND read_model.request_snapshot ->> 'checkIn' = $2
           AND read_model.request_snapshot ->> 'checkOut' = $3
           AND COALESCE((read_model.request_snapshot ->> 'adults')::int, 0) = $4
           AND COALESCE((read_model.request_snapshot ->> 'children')::int, 0) = $5
           AND COALESCE((read_model.request_snapshot ->> 'rooms')::int, 0) = $6
           AND read_model.currency = $7
           AND COALESCE(read_model.request_snapshot ->> 'locale', $8) = $8
           AND COALESCE(read_model.request_snapshot ->> 'promoCode', '') = $9
           AND COALESCE(read_model.request_snapshot ->> 'referralCode', '') = $10
           AND (read_model.quote_status <> 'bookable' OR read_model.expires_at > $11::timestamptz)
         ORDER BY read_model.projected_at DESC
         LIMIT 1`,
          [
            profile.hotel.slug,
            parsed.request.checkIn,
            parsed.request.checkOut,
            parsed.request.adults,
            parsed.request.children,
            parsed.request.rooms,
            parsed.request.currency,
            parsed.request.locale,
            parsed.request.promoCode ?? "",
            parsed.request.referralCode ?? "",
            requestedAt.toISOString(),
          ],
        );

        const row = result.rows[0];
        if (!row) {
          return quoteFromTargetOfferSnapshots(pool, {
            hotel: profile.hotel,
            request: parsed.request,
            requestedAt,
          });
        }

        return toTargetPublicHotelQuoteProjection(profile.hotel, parsed.request, row);
      } catch {
        return toUnavailablePublicHotelQuoteProjection(profile.hotel, query, requestedAt);
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function loadTargetSameDayBookingPolicy(
  pool: PublicHotelQuoteReadPool,
  propertyId: string,
): Promise<TargetSameDayBookingPolicyRow> {
  const result = await pool.query<TargetSameDayBookingPolicyRow>(
    `SELECT
       location.timezone,
       COALESCE(policy.enabled, $2::boolean) AS enabled,
       CASE WHEN policy.property_id IS NULL THEN $3::text
         ELSE policy.cutoff_local_time END AS "cutoffLocalTime"
     FROM hotel_catalog.properties property
     JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN booking.same_day_booking_policies policy ON policy.property_id = property.id
     WHERE property.id = $1::uuid
     LIMIT 1`,
    [
      propertyId,
      SAME_DAY_BOOKING_POLICY_DEFAULTS.enabled,
      SAME_DAY_BOOKING_POLICY_DEFAULTS.cutoffLocalTime,
    ],
  );
  const policy = result.rows[0];
  if (!policy) throw new Error("Target same-day booking policy is unavailable");
  return policy;
}

async function quoteFromTargetOfferSnapshots(
  pool: PublicHotelQuoteReadPool,
  config: {
    hotel: PublicBookabilityHotelProfile;
    request: PublicBookabilityQuoteRequest;
    requestedAt: Date;
  },
): Promise<PublicBookabilityQuoteProjection> {
  const generatedAt = config.requestedAt.toISOString();
  const result = await pool.query<TargetRoomOfferSnapshotQuoteRow>(
    `SELECT
       (SELECT last_minute_discount FROM booking.booking_settings WHERE property_id = offer.property_id) AS "promotionSettings",
       jsonb_agg(jsonb_build_object('stayDate', offer.stay_date, 'grossRoomAmount', offer.base_price_amount - offer.discounts_amount) ORDER BY offer.stay_date) AS "nightlyRoomAmounts",
       offer.public_offer_key AS "publicOfferKey",
       offer.room_type_id::text AS "roomTypeId",
       offer.rate_plan_id::text AS "ratePlanId",
       (array_agg(offer.room_summary ORDER BY offer.stay_date))[1] AS "roomSummary",
       (array_agg(offer.rate_summary ORDER BY offer.stay_date))[1] AS "rateSummary",
       (array_agg(offer.occupancy ORDER BY offer.stay_date))[1] AS occupancy,
       (array_agg(offer.public_policy ORDER BY offer.stay_date))[1] AS "publicPolicy",
       (jsonb_agg(offer.payment_options ORDER BY offer.stay_date)->0) AS "paymentOptions",
       MIN(offer.available_rooms) AS "availableRooms",
       SUM(offer.base_price_amount) * $7::int AS "roomTotal",
       SUM(offer.taxes_and_fees_amount) * $7::int AS "taxesAndFees",
       SUM(offer.discounts_amount) * $7::int AS discounts,
       offer.currency,
       MAX(offer.generated_at) AS "generatedAt"
     FROM distribution.public_room_offer_snapshots offer
     JOIN distribution.public_hotel_bookability_profiles profile
       ON profile.property_id = offer.property_id
     WHERE profile.canonical_slug = $1
       AND profile.public_visibility = 'public_safe'
       AND profile.profile_status = 'public'
       AND profile.freshness_status = 'fresh'
       AND (profile.expires_at IS NULL OR profile.expires_at > $9::timestamptz)
       AND offer.public_visibility = 'public_safe'
       AND offer.stay_date >= $2::date
       AND offer.stay_date < $3::date
       AND offer.currency = $4
       AND offer.sellable_publicly = TRUE
       AND offer.availability_status IN ('available', 'limited')
       AND offer.available_rooms > 0
       AND offer.freshness_status = 'fresh'
       AND COALESCE((offer.occupancy ->> 'maxAdults')::int, $5::int) >= $5::int
       AND COALESCE((offer.occupancy ->> 'maxChildren')::int, $6::int) >= $6::int
       AND COALESCE((offer.occupancy ->> 'maxOccupancy')::int, $5::int + $6::int) >= ($5::int + $6::int)
       AND (offer.expires_at IS NULL OR offer.expires_at > $9::timestamptz)
     GROUP BY offer.property_id, offer.public_offer_key, offer.room_type_id, offer.rate_plan_id, offer.currency
     HAVING COUNT(DISTINCT offer.stay_date) = $8::int
        AND MIN(offer.available_rooms) >= $7::int
     ORDER BY SUM(offer.base_price_amount), offer.public_offer_key
     LIMIT 20`,
    [
      config.hotel.slug,
      config.request.checkIn,
      config.request.checkOut,
      config.request.currency,
      config.request.adults,
      config.request.children,
      config.request.rooms,
      config.request.nights,
      config.requestedAt.toISOString(),
    ],
  );

  const stayRestrictions = applyStayRestrictions(result.rows, config.request.nights);
  const offers = stayRestrictions.eligibleRows.map((row) => {
    const offer = snapshotOfferInput(row);
    const promotion = bestBookingPromotion({
      settings: row.promotionSettings,
      roomTypeId: row.roomTypeId,
      today: propertyDateOnly(config.hotel.timezone, config.requestedAt),
      nights: row.nightlyRoomAmounts ?? [],
      roomTotal: offer.totals.roomTotal - offer.totals.discounts,
      roomCount: config.request.rooms,
    });
    if (promotion) {
      offer.totals.promotion = promotion;
      offer.totals.discounts += promotion.discountAmount;
      offer.totals.grandTotal = roundMoney(offer.totals.grandTotal - promotion.discountAmount);
    }
    return offer;
  });
  const offerPolicies = stayRestrictions.eligibleRows.map((row) => snapshotOfferPolicy(row));
  const quoteId = buildPublicQuoteId(config.request);
  const expiresAt = new Date(config.requestedAt.getTime() + 15 * 60 * 1_000).toISOString();
  const latestGeneratedAt =
    result.rows
      .map((row) => toIsoDateTime(row.generatedAt))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? generatedAt;

  return buildPublicBookabilityQuoteProjection(latestGeneratedAt, {
    request: config.request,
    hotelCatalog: { lastUpdatedAt: latestGeneratedAt },
    booking: { lastUpdatedAt: latestGeneratedAt, offerPolicies },
    pms: {
      availabilityReady: true,
      lastUpdatedAt: latestGeneratedAt,
      offers,
      unavailableReasons: offers.length === 0 ? stayRestrictions.unavailableReasons : [],
    },
    finance: {
      lastUpdatedAt: latestGeneratedAt,
      publicPaymentOptions: publicHotelPaymentOptions(config.hotel),
      supportedCurrencies: config.hotel.supportedCurrencies,
    },
    bookingWeb: {
      offerBookingUrlBase: `${config.hotel.bookingBaseUrl}/${config.request.locale}/book`,
      deepLink:
        offers.length > 0
          ? buildPublicQuoteDeepLink(config.hotel, config.request, quoteId, expiresAt)
          : null,
    },
    quote: {
      quoteId,
      quoteHash: buildPublicQuoteHash(config.request, offers),
      expiresAt,
      priceGuarantee: offers.length > 0 ? "expires_at" : "none",
    },
  });
}

function applyStayRestrictions(
  rows: TargetRoomOfferSnapshotQuoteRow[],
  nights: number,
): {
  eligibleRows: TargetRoomOfferSnapshotQuoteRow[];
  unavailableReasons: PublicBookabilityUnavailableReason[];
} {
  const eligibleRows: TargetRoomOfferSnapshotQuoteRow[] = [];
  const unmetMinimums: number[] = [];
  const exceededMaximums: number[] = [];

  for (const row of rows) {
    const rateSummary = objectValue(row.rateSummary);
    const minimum = positiveIntegerValue(rateSummary["minStayNights"]);
    const maximum = positiveIntegerValue(rateSummary["maxStayNights"]);

    if (minimum !== null && nights < minimum) {
      unmetMinimums.push(minimum);
      continue;
    }
    if (maximum !== null && nights > maximum) {
      exceededMaximums.push(maximum);
      continue;
    }
    eligibleRows.push(row);
  }

  if (eligibleRows.length > 0) {
    return { eligibleRows, unavailableReasons: [] };
  }

  const unavailableReasons: PublicBookabilityUnavailableReason[] = [];
  if (unmetMinimums.length > 0) {
    const requiredNights = Math.min(...unmetMinimums);
    unavailableReasons.push({
      code: "min_stay_not_met",
      detail: `Minimum stay is ${requiredNights} ${requiredNights === 1 ? "night" : "nights"}.`,
    });
  }
  if (exceededMaximums.length > 0) {
    const maximumNights = Math.max(...exceededMaximums);
    unavailableReasons.push({
      code: "max_stay_exceeded",
      detail: `Maximum stay is ${maximumNights} ${maximumNights === 1 ? "night" : "nights"}.`,
    });
  }

  return { eligibleRows, unavailableReasons };
}

function snapshotOfferInput(
  row: TargetRoomOfferSnapshotQuoteRow,
): PublicBookabilityAvailabilityOfferInput {
  const roomSummary = objectValue(row.roomSummary);
  const rateSummary = objectValue(row.rateSummary);
  const occupancy = objectValue(row.occupancy);
  const roomTotal = moneyValue(row.roomTotal) ?? 0;
  const taxesAndFees = moneyValue(row.taxesAndFees) ?? 0;
  const discounts = moneyValue(row.discounts) ?? 0;

  return {
    offerId: row.publicOfferKey,
    roomTypeId: row.roomTypeId,
    ratePlanId: row.ratePlanId,
    name: stringValue(roomSummary["name"]) ?? row.publicOfferKey,
    locationAddress: stringValue(roomSummary["locationAddress"]),
    latitude: numberValue(roomSummary["latitude"]),
    longitude: numberValue(roomSummary["longitude"]),
    occupancy: {
      maxAdults: integerValue(occupancy["maxAdults"], 1),
      maxChildren: integerValue(occupancy["maxChildren"], 0),
    },
    availableRooms: integerLikeValue(row.availableRooms, 0),
    refundable: booleanValue(rateSummary["refundable"]) ?? true,
    mealPlan: stringValue(rateSummary["mealPlan"]),
    amenities: toPublicPmsRoomAmenityLabelsV1(publicStringArray(roomSummary["amenities"])),
    paymentOptions: paymentOptionsArray(row.paymentOptions),
    totals: {
      currency: row.currency,
      roomTotal,
      taxesAndFees,
      discounts,
      grandTotal: roundMoney(roomTotal + taxesAndFees - discounts),
    },
  };
}

function integerLikeValue(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : fallback;
  }
  return integerValue(value, fallback);
}

function positiveIntegerValue(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : numberValue(value);
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function snapshotOfferPolicy(
  row: TargetRoomOfferSnapshotQuoteRow,
): PublicBookabilityBookingOfferPolicyInput {
  const policy = objectValue(row.publicPolicy);
  return {
    roomTypeId: row.roomTypeId,
    ratePlanId: row.ratePlanId,
    cancellation: stringValue(policy["cancellation"]),
    deposit:
      stringValue(policy["deposit"]) ??
      (Object.keys(objectValue(policy["deposit"])).length > 0
        ? JSON.stringify(objectValue(policy["deposit"]))
        : null),
  };
}

export function toUnavailablePublicHotelQuoteProjection(
  hotel: PublicBookabilityHotelProfile,
  query: PublicHotelQuoteQuery,
  now: Date,
  profileReasons: PublicBookabilityUnavailableReason[] = [],
): PublicBookabilityQuoteProjection {
  const generatedAt = now.toISOString();
  const { request, reasons } = parsePublicHotelQuoteRequest(hotel, query, now);
  const readModelUnavailableReason: PublicBookabilityUnavailableReason = {
    code: "unavailable_data",
    detail: "Public quote read model is not ready yet.",
  };
  const unavailableReasons = dedupeReasons(
    reasons.length > 0
      ? reasons
      : profileReasons.length > 0
        ? profileReasons
        : [readModelUnavailableReason],
  );
  const freshness = unavailableQuoteFreshness(generatedAt, unavailableReasons);

  const projection: PublicBookabilityQuoteProjection = {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    request,
    status:
      freshness.status === "stale" &&
      unavailableReasons.every((reason) => reason.code === "stale_data")
        ? "stale"
        : "unavailable",
    unavailableReasons,
    freshness,
    dataSources: PUBLIC_QUOTE_DATA_SOURCES,
  };

  assertPublicBookabilityPublicSafe(projection);
  return projection;
}

function toTargetPublicHotelQuoteProjection(
  hotel: PublicBookabilityHotelProfile,
  request: PublicBookabilityQuoteRequest,
  row: TargetPublicHotelQuoteRow,
): PublicBookabilityQuoteProjection {
  const generatedAt = toIsoDateTime(row.generatedAt) ?? new Date().toISOString();
  const expiresAt = toIsoDateTime(row.expiresAt) ?? generatedAt;
  let status = publicBookabilityStatus(row.quoteStatus);
  let unavailableReasons = unavailableReasonsArray(row.unavailableReasons);
  const dataSources = dataSourcesArray(row.dataSources);
  const publicPaymentOptions = new Set(publicHotelPaymentOptions(hotel));
  const unfilteredOffers = offersArray(hotel, row.offers, row.totals, request, row.deepLinkUrl);
  const offers = unfilteredOffers
    .map((offer) => ({
      ...offer,
      paymentOptions: offer.paymentOptions.filter((option) => publicPaymentOptions.has(option)),
    }))
    .filter((offer) => offer.paymentOptions.length > 0);
  const freshness = targetQuoteFreshness(
    generatedAt,
    row.sourceFreshness,
    freshnessStatusValue(row.freshnessStatus),
    PUBLIC_QUOTE_DATA_SOURCES,
  );
  if (status === "bookable" && freshness.status !== "fresh") {
    status = freshness.status === "stale" ? "stale" : "unavailable";
    unavailableReasons = dedupeReasons([
      ...unavailableReasons,
      { code: freshness.status === "stale" ? "stale_data" : "unavailable_data" },
    ]);
  }
  if (status === "bookable" && offers.length === 0) {
    status = "unavailable";
    unavailableReasons = dedupeReasons([
      ...unavailableReasons,
      { code: unfilteredOffers.length === 0 ? "sold_out" : "payment_disabled" },
    ]);
  }
  const projection: PublicBookabilityQuoteProjection = {
    contractVersion: PUBLIC_BOOKABILITY_CONTRACT_VERSION,
    generatedAt,
    publicVisibility: PUBLIC_BOOKABILITY_VISIBILITY,
    request,
    status,
    unavailableReasons,
    quote:
      status === "bookable"
        ? {
            quoteId: row.publicQuoteReference || row.quoteSessionId,
            quoteHash: row.quoteHash,
            expiresAt,
            priceGuarantee: row.priceGuarantee === "expires_at" ? "expires_at" : "none",
            offers,
          }
        : undefined,
    deepLink:
      status === "bookable" && row.deepLinkUrl
        ? {
            url: row.deepLinkUrl,
            expiresAt,
            preserves: deepLinkPreserves(request),
          }
        : undefined,
    freshness,
    dataSources: [...new Set([...PUBLIC_QUOTE_DATA_SOURCES, ...dataSources])],
  };

  assertPublicBookabilityPublicSafe(projection);
  return projection;
}

export function serializePublicHotelQuoteProjection(
  projection: PublicBookabilityQuoteProjection,
): PublicBookabilityQuoteProjection {
  const serialized: PublicBookabilityQuoteProjection = {
    contractVersion: projection.contractVersion,
    generatedAt: projection.generatedAt,
    publicVisibility: projection.publicVisibility,
    request: {
      hotelSlug: projection.request.hotelSlug,
      checkIn: projection.request.checkIn,
      checkOut: projection.request.checkOut,
      nights: projection.request.nights,
      adults: projection.request.adults,
      children: projection.request.children,
      rooms: projection.request.rooms,
      currency: projection.request.currency,
      locale: projection.request.locale,
      promoCode: projection.request.promoCode ?? null,
      referralCode: projection.request.referralCode ?? null,
    },
    status: projection.status,
    unavailableReasons: projection.unavailableReasons.map((reason) => ({
      code: reason.code,
      detail: reason.detail,
    })),
    quote: projection.quote
      ? {
          quoteId: projection.quote.quoteId,
          quoteHash: projection.quote.quoteHash,
          expiresAt: projection.quote.expiresAt,
          priceGuarantee: projection.quote.priceGuarantee,
          offers: projection.quote.offers.map(serializeOffer),
        }
      : undefined,
    deepLink: projection.deepLink
      ? {
          url: projection.deepLink.url,
          expiresAt: projection.deepLink.expiresAt ?? null,
          preserves: projection.deepLink.preserves.map((value) => value),
        }
      : undefined,
    freshness: serializeFreshness(projection.freshness),
    dataSources: projection.dataSources.map((source) => source),
  };

  assertPublicBookabilityPublicSafe(serialized);
  validatePublicQuoteUrls(serialized);
  return serialized;
}

function parsePublicHotelQuoteRequest(
  hotel: PublicBookabilityHotelProfile,
  query: PublicHotelQuoteQuery,
  now: Date,
): { request: PublicBookabilityQuoteRequest; reasons: PublicBookabilityUnavailableReason[] } {
  const defaultCurrency = hotel.defaultCurrency;
  const defaultLocale = hotel.defaultLocale;
  const checkIn = normalizeDateOnly(query.check_in) ?? "";
  const checkOut = normalizeDateOnly(query.check_out) ?? "";
  const parsedAdults = parsePublicInteger(query.adults, hotel.supportedQuoteParameters.minAdults);
  const parsedChildren = parsePublicInteger(query.children, 0);
  const parsedRooms = parsePublicInteger(query.rooms, hotel.supportedQuoteParameters.minRooms);
  const adults = parsedAdults.value;
  const children = parsedChildren.value;
  const rooms = parsedRooms.value;
  const currency = (query.currency?.trim() || defaultCurrency).toUpperCase();
  const locale = query.locale?.trim() || defaultLocale;
  const nights = checkIn && checkOut ? Math.max(0, daysBetweenDateOnly(checkIn, checkOut) ?? 0) : 0;
  const request: PublicBookabilityQuoteRequest = {
    hotelSlug: hotel.slug,
    checkIn,
    checkOut,
    nights,
    adults,
    children,
    rooms,
    currency,
    locale,
    promoCode: sanitizePublicCode(query.promo_code),
    referralCode: sanitizePublicCode(query.referral_code),
  };
  const reasons: PublicBookabilityUnavailableReason[] = [];
  const timezoneValid = isValidTimeZone(hotel.timezone);

  if (!timezoneValid) {
    reasons.push({
      code: "unavailable_data",
      detail: "Hotel timezone is unavailable.",
    });
  }

  if (!query.check_in || !query.check_out || !checkIn || !checkOut || nights <= 0) {
    reasons.push({
      code: "invalid_request",
      detail: "check_in and check_out must be ISO dates and check_out must be after check_in.",
    });
  }

  if (parsedAdults.invalid || parsedChildren.invalid || parsedRooms.invalid) {
    reasons.push({
      code: "invalid_request",
      detail: "adults, children, and rooms must be non-negative integers.",
    });
  }

  if (
    adults < hotel.supportedQuoteParameters.minAdults ||
    adults > hotel.supportedQuoteParameters.maxAdults ||
    rooms < hotel.supportedQuoteParameters.minRooms ||
    rooms > hotel.supportedQuoteParameters.maxRooms ||
    (!hotel.supportedQuoteParameters.childrenSupported && children > 0)
  ) {
    reasons.push({ code: "unsupported_occupancy" });
  }

  if (request.promoCode) {
    reasons.push({
      code: "promo_not_applicable",
      detail: "Public promo-aware quote pricing is not available yet.",
    });
  }

  if (nights > PUBLIC_QUOTE_MAX_NIGHTS) {
    reasons.push({
      code: "max_stay_exceeded",
      detail: `Public quote requests are limited to ${PUBLIC_QUOTE_MAX_NIGHTS} nights.`,
    });
  }

  if (!hotel.supportedCurrencies.includes(currency)) {
    reasons.push({ code: "currency_not_supported" });
  }

  if (!hotel.supportedLocales.includes(locale)) {
    reasons.push({ code: "locale_not_supported" });
  }

  if (checkIn && timezoneValid && isBeforePropertyToday(checkIn, hotel.timezone, now)) {
    reasons.push({ code: "invalid_request", detail: "check_in cannot be in the past." });
  }

  if (
    checkIn &&
    timezoneValid &&
    daysBetweenDateOnly(propertyDateOnly(hotel.timezone, now), checkIn)! >
      PUBLIC_QUOTE_MAX_ADVANCE_DAYS
  ) {
    reasons.push({
      code: "invalid_request",
      detail: `check_in must be within ${PUBLIC_QUOTE_MAX_ADVANCE_DAYS} days.`,
    });
  }

  return {
    request,
    reasons: dedupeReasons(reasons),
  };
}

function unavailableQuoteFreshness(
  generatedAt: string,
  reasons: PublicBookabilityUnavailableReason[],
): PublicBookabilityFreshness {
  const pmsStatus: PublicBookabilityFreshnessStatus = reasons.some(
    (reason) => reason.code === "unavailable_data",
  )
    ? "unavailable"
    : reasons.some((reason) => reason.code === "stale_data")
      ? "stale"
      : "unknown";
  const pmsReasonCode =
    pmsStatus === "unavailable"
      ? "source_unavailable"
      : pmsStatus === "stale"
        ? "source_stale"
        : "not_configured";
  const sources: PublicBookabilityFreshnessSource[] = [
    { owner: "hotel_catalog", lastUpdatedAt: generatedAt, status: "fresh" },
    { owner: "booking", lastUpdatedAt: generatedAt, status: "fresh" },
    { owner: "pms", status: pmsStatus, reasonCode: pmsReasonCode },
    { owner: "finance", lastUpdatedAt: generatedAt, status: "fresh" },
    { owner: "distribution", lastUpdatedAt: generatedAt, status: "fresh" },
  ];

  return {
    status: pmsStatus,
    generatedAt,
    sources,
  };
}

function publicBookabilityStatus(value: string): PublicBookabilityStatus {
  if (value === "bookable" || value === "unavailable" || value === "stale" || value === "error") {
    return value;
  }
  return "unavailable";
}

function unavailableReasonsArray(value: unknown): PublicBookabilityUnavailableReason[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PublicBookabilityUnavailableReason[] => {
    const reason = objectValue(entry);
    const code = reasonCode(stringValue(reason["code"]));
    if (!code) return [];
    const detail = stringValue(reason["detail"]) ?? publicDetailValue(reason["publicDetail"]);
    return [
      {
        code,
        ...(detail ? { detail } : {}),
      },
    ];
  });
}

function publicDetailValue(value: unknown): string | null {
  const direct = stringValue(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  assertPublicBookabilityPublicSafe(value);
  return JSON.stringify(value);
}

function offersArray(
  hotel: PublicBookabilityHotelProfile,
  value: unknown,
  totalsValue: unknown,
  request: PublicBookabilityQuoteRequest,
  deepLinkUrl: string | null,
): PublicBookabilityOffer[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) =>
    targetOfferFromRow(
      hotel,
      objectValue(entry),
      objectValue(totalsValue),
      request,
      deepLinkUrl,
      index,
    ),
  );
}

function targetOfferFromRow(
  hotel: PublicBookabilityHotelProfile,
  offer: Record<string, unknown>,
  rowTotals: Record<string, unknown>,
  request: PublicBookabilityQuoteRequest,
  deepLinkUrl: string | null,
  index: number,
): PublicBookabilityOffer {
  const offerTotals = objectValue(offer["totals"]);
  const totals = Object.keys(offerTotals).length > 0 ? offerTotals : rowTotals;
  const offerId =
    stringValue(offer["offerId"]) ?? stringValue(offer["publicOfferKey"]) ?? `offer_${index + 1}`;
  const roomTypeId =
    stringValue(offer["roomTypeId"]) ?? stringValue(offer["roomTypeName"]) ?? offerId;
  const ratePlanId = stringValue(offer["ratePlanId"]) ?? stringValue(offer["ratePlanName"]);
  const roomSummary = objectValue(offer["roomSummary"]);

  return {
    offerId,
    roomTypeId,
    ratePlanId,
    name:
      stringValue(offer["name"]) ??
      stringValue(offer["roomTypeName"]) ??
      stringValue(offer["publicOfferKey"]) ??
      offerId,
    locationAddress:
      stringValue(offer["locationAddress"]) ?? stringValue(roomSummary["locationAddress"]),
    latitude: numberValue(offer["latitude"]) ?? numberValue(roomSummary["latitude"]),
    longitude: numberValue(offer["longitude"]) ?? numberValue(roomSummary["longitude"]),
    occupancy: {
      maxAdults: integerValue(objectValue(offer["occupancy"])["maxAdults"], request.adults),
      maxChildren: integerValue(objectValue(offer["occupancy"])["maxChildren"], request.children),
    },
    availableRooms: integerValue(offer["availableRooms"], request.rooms),
    refundable:
      booleanValue(offer["refundable"]) ??
      booleanValue(objectValue(offer["rateSummary"])["refundable"]) ??
      true,
    mealPlan:
      stringValue(offer["mealPlan"]) ?? stringValue(objectValue(offer["rateSummary"])["mealPlan"]),
    amenities: toPublicPmsRoomAmenityLabelsV1(
      publicStringArray(offer["amenities"] ?? roomSummary["amenities"]),
    ),
    paymentOptions: paymentOptionsArray(offer["paymentOptions"]),
    totals: {
      currency:
        stringValue(totals["currency"]) ?? stringValue(offer["currency"]) ?? request.currency,
      roomTotal: moneyValue(totals["roomTotal"]) ?? moneyValue(offer["amount"]) ?? 0,
      taxesAndFees: moneyValue(totals["taxesAndFees"]) ?? 0,
      discounts: moneyValue(totals["discounts"]) ?? 0,
      grandTotal:
        moneyValue(totals["grandTotal"]) ??
        moneyValue(totals["total"]) ??
        moneyValue(offer["amount"]) ??
        0,
    },
    policies: {
      cancellation:
        stringValue(objectValue(offer["policies"])["cancellation"]) ??
        stringValue(objectValue(offer["publicPolicy"])["cancellation"]),
      deposit:
        stringValue(objectValue(offer["policies"])["deposit"]) ??
        stringValue(objectValue(offer["publicPolicy"])["deposit"]),
    },
    bookingUrl:
      stringValue(offer["bookingUrl"]) ?? deepLinkUrl ?? buildFallbackBookingUrl(hotel, request),
  };
}

function targetQuoteFreshness(
  generatedAt: string,
  sourceFreshness: unknown,
  status: PublicBookabilityFreshnessStatus,
  owners: PublicBookabilityDataSourceOwner[],
): PublicBookabilityFreshness {
  const sourcesByOwner = new Map<
    PublicBookabilityDataSourceOwner,
    PublicBookabilityFreshnessSource
  >();
  for (const source of parseFreshnessSources(sourceFreshness, generatedAt)) {
    sourcesByOwner.set(source.owner, source);
  }

  for (const owner of owners) {
    if (!sourcesByOwner.has(owner)) {
      const isDistribution = owner === "distribution";
      sourcesByOwner.set(owner, {
        owner,
        lastUpdatedAt: isDistribution ? generatedAt : undefined,
        status: isDistribution ? "fresh" : "unknown",
        reasonCode: isDistribution ? undefined : "not_configured",
      });
    }
  }

  if (!sourcesByOwner.has("distribution")) {
    sourcesByOwner.set("distribution", {
      owner: "distribution",
      lastUpdatedAt: generatedAt,
      status: "fresh",
    });
  }

  const effectiveStatus = rollupQuoteFreshness(status, [...sourcesByOwner.values()]);
  return {
    status: effectiveStatus,
    generatedAt,
    sources: [...sourcesByOwner.values()],
  };
}

function rollupQuoteFreshness(
  declaredStatus: PublicBookabilityFreshnessStatus,
  sources: PublicBookabilityFreshnessSource[],
): PublicBookabilityFreshnessStatus {
  const statuses = [declaredStatus, ...sources.map((source) => source.status)];
  if (statuses.includes("unavailable")) return "unavailable";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("unknown")) return "unknown";
  return "fresh";
}

function parseFreshnessSources(
  value: unknown,
  generatedAt: string,
): PublicBookabilityFreshnessSource[] {
  const sourceObject = objectValue(value);
  const rawSources = Array.isArray(sourceObject["sources"])
    ? (sourceObject["sources"] as unknown[])
    : Object.entries(sourceObject).map(([owner, source]) => ({
        owner,
        ...objectValue(source),
      }));

  return rawSources.flatMap((entry): PublicBookabilityFreshnessSource[] => {
    const source = objectValue(entry);
    const owner = dataSourceOwner(stringValue(source["owner"]));
    if (!owner) return [];
    return [
      {
        owner,
        lastUpdatedAt:
          stringValue(source["lastUpdatedAt"]) ?? stringValue(source["generatedAt"]) ?? generatedAt,
        status: freshnessStatusValue(stringValue(source["status"])),
        reasonCode: freshnessReasonCode(stringValue(source["reasonCode"])),
      },
    ];
  });
}

function deepLinkPreserves(
  request: PublicBookabilityQuoteRequest,
): PublicBookabilityDeepLink["preserves"] {
  return [
    "dates",
    "guests",
    "rooms",
    "currency",
    "locale",
    ...(request.promoCode ? (["promo_code"] as const) : []),
    ...(request.referralCode ? (["referral_code"] as const) : []),
    "quote_id",
  ];
}

function dataSourcesArray(value: unknown): PublicBookabilityDataSourceOwner[] {
  const sources = (Array.isArray(value) ? value : [])
    .map((source) => dataSourceOwner(stringValue(source)))
    .filter((source): source is PublicBookabilityDataSourceOwner => Boolean(source));
  return sources.includes("distribution") ? sources : [...sources, "distribution"];
}

function paymentOptionsArray(value: unknown): PublicBookabilityOffer["paymentOptions"] {
  if (value === null || value === undefined) return ["card"];

  const options = Array.isArray(value)
    ? value
        .map(normalizePublicPaymentMethod)
        .filter((method): method is PublicBookabilityOffer["paymentOptions"][number] =>
          Boolean(method),
        )
    : [];
  return [...new Set(options)];
}

function publicStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = stringValue(entry);
    return parsed ? [parsed] : [];
  });
}

function normalizePublicPaymentMethod(
  value: unknown,
): PublicBookabilityOffer["paymentOptions"][number] | null {
  if (value === "card" || value === "credit_card" || value === "stripe" || value === "xendit") {
    return "card";
  }
  if (value === "pay_at_property" || value === "cash" || value === "on_arrival") {
    return "pay_at_property";
  }
  if (value === "bank_transfer") {
    return "bank_transfer";
  }
  if (value === "paypal") {
    return "paypal";
  }
  return null;
}

function reasonCode(value: string | null): PublicBookabilityReasonCode | null {
  if (
    value === "sold_out" ||
    value === "payment_disabled" ||
    value === "min_stay_not_met" ||
    value === "max_stay_exceeded" ||
    value === "same_day_cutoff_passed" ||
    value === "unsupported_occupancy" ||
    value === "unpublished" ||
    value === "policy_missing" ||
    value === "stale_data" ||
    value === "unavailable_data" ||
    value === "invalid_request" ||
    value === "currency_not_supported" ||
    value === "locale_not_supported" ||
    value === "promo_not_applicable"
  ) {
    return value;
  }
  return null;
}

function dataSourceOwner(value: string | null): PublicBookabilityDataSourceOwner | null {
  if (["hotel_catalog", "booking", "pms", "finance", "distribution"].includes(value ?? "")) {
    return value as PublicBookabilityDataSourceOwner;
  }
  return null;
}

function freshnessStatusValue(value: string | null): PublicBookabilityFreshnessStatus {
  if (["fresh", "stale", "unavailable", "unknown"].includes(value ?? "")) {
    return value as PublicBookabilityFreshnessStatus;
  }
  return "unknown";
}

function freshnessReasonCode(
  value: string | null,
): PublicBookabilityFreshnessSource["reasonCode"] | undefined {
  if (value === "source_unavailable" || value === "source_stale" || value === "not_configured") {
    return value;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integerValue(value: unknown, fallback: number): number {
  const parsed = numberValue(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : fallback;
}

function moneyValue(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : numberValue(value);
  return typeof parsed === "number" && Number.isFinite(parsed) ? roundMoney(parsed) : null;
}

function toIsoDateTime(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildFallbackBookingUrl(
  hotel: PublicBookabilityHotelProfile,
  request: PublicBookabilityQuoteRequest,
): string {
  const url = new URL(`/${request.locale}/book`, hotel.bookingBaseUrl);
  url.searchParams.set("check_in", request.checkIn);
  url.searchParams.set("check_out", request.checkOut);
  url.searchParams.set("adults", String(request.adults));
  url.searchParams.set("children", String(request.children));
  url.searchParams.set("rooms", String(request.rooms));
  url.searchParams.set("currency", request.currency);
  url.searchParams.set("locale", request.locale);
  url.searchParams.set("quote_id", buildPublicQuoteId(request));
  if (request.promoCode) url.searchParams.set("promo_code", request.promoCode);
  if (request.referralCode) url.searchParams.set("referral_code", request.referralCode);
  return url.toString();
}

function serializeOffer(offer: PublicBookabilityOffer): PublicBookabilityOffer {
  return {
    offerId: offer.offerId,
    roomTypeId: offer.roomTypeId,
    ratePlanId: offer.ratePlanId ?? null,
    name: offer.name,
    locationAddress: offer.locationAddress ?? null,
    latitude: offer.latitude ?? null,
    longitude: offer.longitude ?? null,
    occupancy: {
      maxAdults: offer.occupancy.maxAdults,
      maxChildren: offer.occupancy.maxChildren,
    },
    availableRooms: offer.availableRooms,
    refundable: offer.refundable,
    mealPlan: offer.mealPlan ?? null,
    amenities: offer.amenities.map((amenity) => amenity),
    paymentOptions: offer.paymentOptions.map((option) => option),
    totals: {
      currency: offer.totals.currency,
      roomTotal: offer.totals.roomTotal,
      taxesAndFees: offer.totals.taxesAndFees,
      discounts: offer.totals.discounts,
      grandTotal: offer.totals.grandTotal,
      ...(offer.totals.promotion
        ? {
            promotion: {
              name: offer.totals.promotion.name,
              discountAmount: offer.totals.promotion.discountAmount,
              discountPercent: offer.totals.promotion.discountPercent,
            },
          }
        : {}),
    },
    policies: {
      cancellation: offer.policies.cancellation ?? null,
      deposit: offer.policies.deposit ?? null,
    },
    bookingUrl: offer.bookingUrl,
  };
}

function buildPublicQuoteDeepLink(
  hotel: PublicBookabilityHotelProfile,
  request: PublicBookabilityQuoteRequest,
  quoteId: string,
  expiresAt: string,
): PublicBookabilityDeepLink {
  const url = new URL(`/${request.locale}/book`, hotel.bookingBaseUrl);
  url.searchParams.set("check_in", request.checkIn);
  url.searchParams.set("check_out", request.checkOut);
  url.searchParams.set("adults", String(request.adults));
  url.searchParams.set("children", String(request.children));
  url.searchParams.set("rooms", String(request.rooms));
  url.searchParams.set("currency", request.currency);
  url.searchParams.set("locale", request.locale);
  url.searchParams.set("quote_id", quoteId);
  if (request.promoCode) url.searchParams.set("promo_code", request.promoCode);
  if (request.referralCode) url.searchParams.set("referral_code", request.referralCode);

  return {
    url: url.toString(),
    expiresAt,
    preserves: [
      "dates",
      "guests",
      "rooms",
      "currency",
      "locale",
      ...(request.promoCode ? (["promo_code"] as const) : []),
      ...(request.referralCode ? (["referral_code"] as const) : []),
      "quote_id",
    ],
  };
}

function validatePublicQuoteUrls(projection: PublicBookabilityQuoteProjection): void {
  const urls = [
    projection.deepLink?.url,
    ...(projection.quote?.offers.map((offer) => offer.bookingUrl) ?? []),
  ].filter((url): url is string => Boolean(url));
  if (urls.length === 0) return;

  const parsed = urls.map((url) => new URL(url));
  const origin = parsed[0]!.origin;
  for (const url of parsed) {
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Public quote URL must use http or https.");
    }
    if (url.origin !== origin) {
      throw new Error("Public quote URLs must share the canonical booking origin.");
    }
    if (!url.pathname.endsWith("/book")) {
      throw new Error("Public quote URLs must point to the booking flow.");
    }
  }
}

function serializeFreshness(freshness: PublicBookabilityFreshness): PublicBookabilityFreshness {
  return {
    status: freshness.status,
    generatedAt: freshness.generatedAt,
    sources: freshness.sources.map((source) => ({
      owner: source.owner,
      lastUpdatedAt: source.lastUpdatedAt,
      status: source.status,
      reasonCode: source.reasonCode,
    })),
  };
}

function normalizeDateOnly(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

function parsePublicInteger(
  value: string | undefined,
  fallback: number,
): { value: number; invalid: boolean } {
  if (!value) return { value: fallback, invalid: false };
  if (!/^\d+$/.test(value)) return { value: fallback, invalid: true };
  return { value: Number.parseInt(value, 10), invalid: false };
}

function daysBetweenDateOnly(start: string, end: string): number | null {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  return Math.round((endMs - startMs) / 86_400_000);
}

function publicHotelPaymentOptions(
  hotel: PublicBookabilityHotelProfile,
): PublicBookabilityOffer["paymentOptions"] {
  const options: PublicBookabilityOffer["paymentOptions"] = [];
  if (hotel.capabilities.onlinePayment) options.push("card");
  if (hotel.capabilities.payAtProperty) options.push("pay_at_property");
  return options;
}

function sanitizePublicCode(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(trimmed) ? trimmed : null;
}

function buildPublicQuoteId(request: PublicBookabilityQuoteRequest): string {
  return `quote_${stablePublicHash(
    [
      request.hotelSlug,
      request.checkIn,
      request.checkOut,
      request.adults,
      request.children,
      request.rooms,
      request.currency,
      request.locale,
    ].join("|"),
  ).slice(0, 16)}`;
}

function buildPublicQuoteHash(
  request: PublicBookabilityQuoteRequest,
  offers: PublicBookabilityAvailabilityOfferInput[],
): string {
  return `sha256:${stablePublicHash(JSON.stringify({ request, offers })).slice(0, 24)}`;
}

function stablePublicHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").repeat(3);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function isBeforePropertyToday(checkIn: string, timezone: string, now: Date): boolean {
  return checkIn < propertyDateOnly(timezone, now);
}

function isValidTimeZone(timezone: string): boolean {
  if (!timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function propertyDateOnly(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function dedupeReasons(
  reasons: PublicBookabilityUnavailableReason[],
): PublicBookabilityUnavailableReason[] {
  const seen = new Set<PublicBookabilityReasonCode>();
  return reasons.filter((reason) => {
    if (seen.has(reason.code)) return false;
    seen.add(reason.code);
    return true;
  });
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

type HttpError = Error & {
  statusCode: number;
};
