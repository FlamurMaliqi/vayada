import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import {
  createTargetPublicHotelQuoteRepository,
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
    roomSummary: { name: publicOfferKey },
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

function targetRepository(rows: QueryResultRow[]) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  const pool: PublicHotelQuoteReadPool = {
    async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      return { rows: (queries.length === 1 ? [] : rows) as T[] };
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

describe("target public hotel quote stay restrictions", () => {
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
      quote: { offers: [{ offerId: "exact-three" }] },
    });
    expect(quote?.quote?.offers).toHaveLength(1);
    expect(queries[1]?.text).toContain(
      "(array_agg(offer.rate_summary ORDER BY offer.stay_date))[1]",
    );
    expect(queries[1]?.values?.[7]).toBe(3);
  });
});
