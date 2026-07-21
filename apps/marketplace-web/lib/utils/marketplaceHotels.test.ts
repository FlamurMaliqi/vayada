import { describe, expect, it } from "vitest";

import type { CollaborationOffering, Creator, Hotel } from "@/lib/types";
import { filterMarketplaceHotels, sortMarketplaceHotels } from "./marketplaceHotels";

describe("marketplace hotel discovery", () => {
  it.each([
    ["Hotel", "hotel"],
    ["Resort", "resort"],
    ["Hostel", "hostel"],
    ["Apartment", "apartment"],
    ["Aparthotel", "aparthotel"],
    ["Guesthouse", "guesthouse"],
    ["Bed and breakfast", "bed_and_breakfast"],
    ["Villa", "villa"],
    ["Vacation rental", "vacation_rental"],
    ["Motel", "motel"],
    ["Other", "other"],
  ])("matches the %s display type to canonical %s", (displayType, canonicalType) => {
    const hotels = [hotel({ id: canonicalType, accommodationType: canonicalType })];

    expect(filterMarketplaceHotels(hotels, "", { hotelType: displayType })).toEqual(hotels);
  });

  it.each([
    ["Hotel", "boutique_hotel"],
    ["Hotel", "Boutiques Hotel"],
    ["Hotel", "city_hotel"],
    ["Hotel", "luxury_hotel"],
    ["Resort", "eco_resort"],
    ["Aparthotel", "apart_hotel"],
    ["Guesthouse", "guest_house"],
    ["Other", "lodge"],
    ["Other", "boat"],
  ])("maps the real legacy %s alias %s into the canonical taxonomy", (filter, legacyType) => {
    const hotels = [hotel({ id: legacyType, accommodationType: legacyType })];

    expect(filterMarketplaceHotels(hotels, "", { hotelType: filter })).toEqual(hotels);
  });

  it.each(["Discount", "Affiliate"] as const)("matches the %s compensation option", (offering) => {
    const matching = hotel({ id: offering, offerings: [compensation(offering)] });
    const paid = hotel({ id: "paid", offerings: [compensation("Paid", 1_500)] });

    expect(filterMarketplaceHotels([paid, matching], "", { offering })).toEqual([matching]);
  });

  it("treats multiple offering selections as alternatives", () => {
    const discount = hotel({ id: "discount", offerings: [compensation("Discount")] });
    const affiliate = hotel({ id: "affiliate", offerings: [compensation("Affiliate")] });
    const free = hotel({ id: "free", offerings: [compensation("Free Stay")] });

    expect(
      filterMarketplaceHotels([discount, affiliate, free], "", {
        offering: ["Discount", "Affiliate"],
      }),
    ).toEqual([discount, affiliate]);
  });

  it("applies a minimum paid amount and excludes non-monetary offers", () => {
    const above = hotel({ id: "above", offerings: [compensation("Paid", 2_000)] });
    const below = hotel({ id: "below", offerings: [compensation("Paid", 900)] });
    const nonMonetary = hotel({ id: "discount", offerings: [compensation("Discount")] });
    const mixed = hotel({
      id: "mixed",
      offerings: [compensation("Free Stay"), compensation("Paid", 1_500)],
    });

    expect(
      filterMarketplaceHotels([above, below, nonMonetary, mixed], "", { budget: 1_500 }),
    ).toEqual([above, mixed]);
  });

  it("compares only EUR-denominated paid options to the EUR budget filter", () => {
    const eur = hotel({ id: "eur", offerings: [compensation("Paid", 2_000, "eur")] });
    const usd = hotel({ id: "usd", offerings: [compensation("Paid", 4_000, "USD")] });
    const unknown = hotel({ id: "unknown", offerings: [compensation("Paid", 4_000, null)] });

    expect(filterMarketplaceHotels([usd, unknown, eur], "", { budget: 1_500 })).toEqual([eur]);
  });

  it("combines hotel type, offering, availability, and budget filters", () => {
    const matching = hotel({
      id: "matching",
      accommodationType: "hotel",
      availability: ["July"],
      offerings: [compensation("Affiliate"), compensation("Paid", 2_000)],
    });
    const wrongMonth = hotel({
      id: "wrong-month",
      accommodationType: "hotel",
      availability: ["August"],
      offerings: [compensation("Affiliate"), compensation("Paid", 2_000)],
    });

    expect(
      filterMarketplaceHotels([wrongMonth, matching], "", {
        hotelType: "Hotel",
        offering: "Affiliate",
        availability: "July",
        budget: 1_500,
      }),
    ).toEqual([matching]);
  });

  it("ranks text and creator-platform fit before freshness", () => {
    const creator = creatorWithPlatforms("Instagram");
    const newest = hotel({
      id: "newest",
      createdAt: "2026-07-20",
      name: "City break",
      description: "An Alpine collaboration.",
    });
    const platformFit = hotel({
      id: "platform-fit",
      createdAt: "2026-07-10",
      name: "City break",
      description: "An Alpine collaboration.",
      platforms: ["Instagram"],
    });
    const textFit = hotel({
      id: "text-fit",
      createdAt: "2026-07-01",
      name: "Alpine creator escape",
      platforms: ["Instagram"],
    });

    expect(
      sortMarketplaceHotels([newest, platformFit, textFit], "relevance", "Alpine", creator).map(
        ({ id }) => id,
      ),
    ).toEqual(["text-fit", "platform-fit", "newest"]);
  });

  it("uses newest then offer ID as deterministic relevance tie-breakers", () => {
    const older = hotel({ id: "older", createdAt: "2026-07-01" });
    const laterId = hotel({ id: "z-id", createdAt: "2026-07-20" });
    const earlierId = hotel({ id: "a-id", createdAt: "2026-07-20" });

    expect(
      sortMarketplaceHotels([older, laterId, earlierId], "relevance", "", null).map(({ id }) => id),
    ).toEqual(["a-id", "z-id", "older"]);
  });
});

function hotel(input: {
  id: string;
  name?: string;
  accommodationType?: string;
  offerings?: CollaborationOffering[];
  availability?: string[];
  platforms?: string[];
  description?: string;
  createdAt?: string;
}): Hotel {
  return {
    id: input.id,
    hotelProfileId: `profile-${input.id}`,
    name: input.name ?? "Creator stay",
    location: "Berlin, Germany",
    description: input.description ?? "A complete collaboration offer.",
    images: ["https://images.example/offer.jpg"],
    accommodationType: input.accommodationType,
    collaborationOfferings: input.offerings ?? [],
    availability: input.availability,
    platforms: input.platforms,
    status: "verified",
    createdAt: new Date(input.createdAt ?? "2026-07-01"),
    updatedAt: new Date(input.createdAt ?? "2026-07-01"),
  };
}

function compensation(
  type: CollaborationOffering["collaboration_type"],
  paidAmount?: number,
  currency: string | null = "EUR",
): CollaborationOffering {
  return {
    id: `${type}-option`,
    listing_id: "offer",
    collaboration_type: type,
    availability_months: ["July"],
    platforms: ["Instagram"],
    paid_max_amount: paidAmount ?? null,
    currency,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  };
}

function creatorWithPlatforms(...platforms: string[]): Creator {
  return {
    id: "creator",
    email: "creator@example.test",
    name: "Creator",
    platforms: platforms.map((name) => ({
      name,
      handle: "creator",
      followers: 10_000,
      engagementRate: 4,
    })),
    audienceSize: 10_000,
    location: "Berlin, Germany",
    creatorType: "Travel",
    status: "verified",
    createdAt: new Date("2026-07-01"),
    updatedAt: new Date("2026-07-01"),
  };
}
