import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createTargetPublicHotelQuoteRepository,
  serializePublicHotelQuoteProjection,
  type PublicHotelQuoteReadPool,
} from "./aiHotelQuotes.js";
import type { PublicHotelProfileRepository } from "./aiHotels.js";

const NOW = new Date("2026-07-22T10:00:00.000Z");
const profile = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "bookable",
)!.profile;
const profileRepository: PublicHotelProfileRepository = {
  async findProfileBySlug(slug) {
    return slug === profile.hotel.slug ? profile : null;
  },
};

function snapshotOffer(
  publicOfferKey: string,
  rateSummary: Record<string, unknown>,
): QueryResultRow {
  return {
    publicOfferKey,
    roomTypeId: `room-${publicOfferKey}`,
    ratePlanId: `rate-${publicOfferKey}`,
    roomSummary: {
      name: publicOfferKey,
      amenities: ["balcony", "wifi", "air_conditioning"],
    },
    rateSummary: { refundable: true, ...rateSummary },
    occupancy: { maxAdults: 2, maxChildren: 1 },
    publicPolicy: { cancellation: "Free cancellation" },
    paymentOptions: ["pay_at_property"],
    availableRooms: 2,
    roomTotal: "300.00",
    taxesAndFees: "30.00",
    discounts: "0.00",
    currency: "EUR",
    generatedAt: NOW.toISOString(),
  };
}

function targetRepository(
  rows: QueryResultRow[],
  policy: QueryResultRow = { timezone: "Etc/UTC", enabled: true, cutoffLocalTime: null },
) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const pool: PublicHotelQuoteReadPool = {
    async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      if (text.includes("same_day_booking_policies")) return { rows: [policy] as T[] };
      if (text.includes("public_quote_read_models")) return { rows: [] };
      return { rows: rows as T[] };
    },
    async end() {},
  };

  return {
    queries,
    repository: createTargetPublicHotelQuoteRepository({
      connectionString: "postgresql://target",
      profileRepository,
      pool,
      now: () => NOW,
    }),
  };
}

function cachedTargetRepository(
  offers: Record<string, unknown>[],
  hotelProfile = profile,
  policy: QueryResultRow = { timezone: "Etc/UTC", enabled: true, cutoffLocalTime: null },
) {
  const pool: PublicHotelQuoteReadPool = {
    async query<T extends QueryResultRow>(text: string) {
      if (text.includes("same_day_booking_policies")) return { rows: [policy] as T[] };
      return {
        rows: [
          {
            quoteSessionId: "f6898100-0000-0000-0000-000000000001",
            publicQuoteReference: "quote_cached",
            quoteHash: "sha256:cached",
            requestSnapshot: {},
            quoteStatus: "bookable",
            unavailableReasons: [],
            offers,
            totals: {},
            deepLinkUrl: "https://hotel-alpenrose.booking.localhost/en/book",
            priceGuarantee: "expires_at",
            currency: "EUR",
            sourceFreshness: {
              hotel_catalog: { status: "fresh" },
              booking: { status: "fresh" },
              pms: { status: "fresh" },
              finance: { status: "fresh" },
              distribution: { status: "fresh" },
            },
            freshnessStatus: "fresh",
            dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
            generatedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + 15 * 60 * 1_000).toISOString(),
          },
        ] as unknown as T[],
      };
    },
    async end() {},
  };

  return createTargetPublicHotelQuoteRepository({
    connectionString: "postgresql://target",
    profileRepository: {
      async findProfileBySlug(slug) {
        return slug === hotelProfile.hotel.slug ? hotelProfile : null;
      },
    },
    pool,
    now: () => NOW,
  });
}

function cachedOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    offerId: "offer-deluxe",
    roomTypeId: "room-deluxe",
    name: "Deluxe Room",
    availableRooms: 1,
    paymentOptions: ["card"],
    totals: {
      currency: "EUR",
      roomTotal: 180,
      taxesAndFees: 18,
      discounts: 0,
      grandTotal: 198,
    },
    ...overrides,
  };
}

describe("target public hotel quote stay restrictions", () => {
  it.each(["MIDWEEK", "EXTENDED_STAY"])(
    "projects named %s discounts for unequal nights and multiple rooms",
    async (type) => {
      const { repository, queries } = targetRepository([
        {
          ...snapshotOffer("promoted", {}),
          roomTotal: "600.00",
          taxesAndFees: "60.00",
          nightlyRoomAmounts: [
            { stayDate: "2026-09-06", grossRoomAmount: 100 },
            { stayDate: "2026-09-07", grossRoomAmount: 200 },
          ],
          promotionSettings: {
            promotions: [
              {
                type,
                active: true,
                roomTypeIds: [],
                discountPercent: type === "MIDWEEK" ? 25 : 0,
                threshold: 2,
                freeNights: type === "EXTENDED_STAY" ? 1 : 0,
                weekdays: type === "MIDWEEK" ? [0] : [],
                tiers: [],
              },
            ],
          },
        },
      ]);
      const projection = await repository.findQuoteBySlug(profile.hotel.slug, {
        check_in: "2026-09-06",
        check_out: "2026-09-08",
        adults: "2",
        rooms: "2",
        currency: "EUR",
        locale: "en",
      });
      expect(projection?.status).toBe("bookable");
      const response = serializePublicHotelQuoteProjection(projection!);
      expect(response.quote?.offers[0]?.totals).toMatchObject({
        roomTotal: 600,
        taxesAndFees: 60,
        discounts: type === "MIDWEEK" ? 50 : 200,
        grandTotal: type === "MIDWEEK" ? 610 : 460,
        promotion: {
          name: type === "MIDWEEK" ? "Midweek getaway" : "Extended stay",
          discountAmount: type === "MIDWEEK" ? 50 : 200,
        },
      });
      expect(queries[1]?.text).toContain("settings.last_minute_discount");
    },
  );

  it("returns min_stay_not_met when every otherwise available rate requires a longer stay", async () => {
    const { repository } = targetRepository([
      snapshotOffer("minimum-three", { minStayNights: 3 }),
      snapshotOffer("minimum-five", { minStayNights: 5 }),
    ]);

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-14",
      adults: "2",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: "min_stay_not_met", detail: "Minimum stay is 3 nights." }],
    });
    expect(quote?.quote).toBeUndefined();
  });

  it("returns max_stay_exceeded when every otherwise available rate has a shorter limit", async () => {
    const { repository } = targetRepository([
      snapshotOffer("maximum-three", { maxStayNights: 3 }),
      snapshotOffer("maximum-five", { maxStayNights: "5" }),
    ]);

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-18",
      adults: "2",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: "max_stay_exceeded", detail: "Maximum stay is 5 nights." }],
    });
    expect(quote?.quote).toBeUndefined();
  });

  it("keeps eligible rates and drops rates whose arrival-day restriction rejects the stay", async () => {
    const { repository, queries } = targetRepository([
      snapshotOffer("minimum-four", { minStayNights: 4 }),
      snapshotOffer("exact-three", { minStayNights: 3, maxStayNights: 3 }),
    ]);

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "bookable",
      unavailableReasons: [],
      quote: {
        offers: [
          {
            offerId: "exact-three",
            amenities: ["Wi-Fi", "Air conditioning", "Balcony"],
          },
        ],
      },
    });
    expect(quote?.quote?.offers).toHaveLength(1);
    expect(queries[2]?.text).toContain(
      "(array_agg(offer.rate_summary ORDER BY offer.stay_date))[1]",
    );
    expect(queries[2]?.values?.[7]).toBe(3);
  });

  it("rejects a same-day quote at the exact property-local cutoff", async () => {
    const { repository, queries } = targetRepository([snapshotOffer("same-day", {})], {
      timezone: "Etc/UTC",
      enabled: true,
      cutoffLocalTime: "10:00",
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-07-22",
      check_out: "2026-07-23",
      adults: "2",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: "same_day_cutoff_passed" }],
    });
    expect(queries).toHaveLength(1);
  });
});

describe("cached target public hotel quote payment readiness", () => {
  const query = {
    check_in: "2026-09-12",
    check_out: "2026-09-15",
    adults: "2",
    rooms: "1",
    currency: "EUR",
    locale: "en",
  };

  it("reports sold_out when the cached projection originally contains no offers", async () => {
    const quote = await cachedTargetRepository([]).findQuoteBySlug(profile.hotel.slug, query);

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: "sold_out" }],
    });
  });

  it("reports payment_disabled when hotel payment readiness removes every offer", async () => {
    const payAtPropertyOnlyProfile = {
      ...profile,
      hotel: {
        ...profile.hotel,
        capabilities: {
          ...profile.hotel.capabilities,
          onlinePayment: false,
          payAtProperty: true,
        },
      },
    };
    const quote = await cachedTargetRepository(
      [cachedOffer({ paymentOptions: ["card"] })],
      payAtPropertyOnlyProfile,
    ).findQuoteBySlug(profile.hotel.slug, query);

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: "payment_disabled" }],
    });
  });

  it("retains the established card fallback when payment options are missing", async () => {
    const offer = cachedOffer();
    delete offer.paymentOptions;

    const quote = await cachedTargetRepository([offer]).findQuoteBySlug(profile.hotel.slug, query);

    expect(quote).toMatchObject({
      status: "bookable",
      quote: { offers: [{ paymentOptions: ["card"] }] },
    });
  });

  it("publishes cached PMS amenity keys as ordered guest-facing labels", async () => {
    const quote = await cachedTargetRepository([
      cachedOffer({ amenities: ["balcony", "wifi", "air_conditioning"] }),
    ]).findQuoteBySlug(profile.hotel.slug, query);

    expect(quote).toMatchObject({
      status: "bookable",
      quote: {
        offers: [{ amenities: ["Wi-Fi", "Air conditioning", "Balcony"] }],
      },
    });
  });
});
