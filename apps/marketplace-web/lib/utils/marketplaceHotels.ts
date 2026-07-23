import type { Creator, Hotel } from "@/lib/types";

export type MarketplaceHotelFilters = {
  hotelType?: string | string[];
  offering?: string | string[];
  availability?: string | string[];
  budget?: number;
};

export type MarketplaceHotelSort = "relevance" | "name-asc" | "name-desc" | "newest" | "oldest";

export function filterMarketplaceHotels(
  hotels: Hotel[],
  searchQuery: string,
  filters: MarketplaceHotelFilters,
): Hotel[] {
  const query = searchQuery.trim().toLowerCase();
  const hotelTypes = toArray(filters.hotelType).map(normalizePropertyType);
  const offeringTypes = toArray(filters.offering).map(toOfferingType);
  const availability = toArray(filters.availability);
  const minimumPaidAmount = filters.budget;

  return hotels.filter((hotel) => {
    if (
      query &&
      ![hotel.name, hotel.location, hotel.description].some((value) =>
        value.toLowerCase().includes(query),
      )
    ) {
      return false;
    }

    if (
      hotelTypes.length > 0 &&
      (!hotel.accommodationType ||
        !hotelTypes.includes(normalizePropertyType(hotel.accommodationType)))
    ) {
      return false;
    }

    const offerTypes = getOfferingTypes(hotel);
    if (offeringTypes.length > 0 && !offeringTypes.some((type) => offerTypes.includes(type))) {
      return false;
    }

    if (
      availability.length > 0 &&
      !availability.some((month) => hotel.availability?.includes(month))
    ) {
      return false;
    }

    // A budget means minimum paid compensation. Offers with no paid option
    // are non-monetary and therefore do not match an active budget filter.
    if (
      minimumPaidAmount !== undefined &&
      !hotel.collaborationOfferings?.some(
        (offering) =>
          offering.collaboration_type === "Paid" &&
          offering.currency?.trim().toUpperCase() === "EUR" &&
          offering.paid_max_amount !== null &&
          offering.paid_max_amount !== undefined &&
          offering.paid_max_amount >= minimumPaidAmount,
      )
    ) {
      return false;
    }

    return true;
  });
}

export function sortMarketplaceHotels(
  hotels: Hotel[],
  sort: MarketplaceHotelSort,
  searchQuery: string,
  creator: Creator | null,
): Hotel[] {
  const sorted = [...hotels];
  switch (sort) {
    case "name-asc":
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case "name-desc":
      return sorted.sort((a, b) => b.name.localeCompare(a.name));
    case "newest":
      return sorted.sort((a, b) => timestamp(b) - timestamp(a));
    case "oldest":
      return sorted.sort((a, b) => timestamp(a) - timestamp(b));
    case "relevance":
      return sorted.sort(
        (a, b) =>
          relevanceScore(b, searchQuery, creator) - relevanceScore(a, searchQuery, creator) ||
          timestamp(b) - timestamp(a) ||
          a.id.localeCompare(b.id),
      );
  }
}

function relevanceScore(hotel: Hotel, searchQuery: string, creator: Creator | null): number {
  const query = searchQuery.trim().toLowerCase();
  let score = 0;

  if (query) {
    if (hotel.name.toLowerCase().includes(query)) score += 30;
    if (hotel.location.toLowerCase().includes(query)) score += 20;
    if (hotel.description.toLowerCase().includes(query)) score += 10;
  }

  if (creator) {
    const creatorPlatforms = new Set(
      creator.platforms.map((platform) => normalizeFacet(platform.name)),
    );
    const hotelPlatforms = new Set(
      [
        ...(hotel.platforms ?? []),
        ...(hotel.collaborationOfferings?.flatMap((offering) => offering.platforms) ?? []),
      ].map(normalizeFacet),
    );
    const sharedPlatformCount = Array.from(hotelPlatforms).filter((platform) =>
      creatorPlatforms.has(platform),
    ).length;
    const eligibleOfferingCount = (hotel.collaborationOfferings ?? []).filter(
      (offering) =>
        offering.min_followers == null || creator.audienceSize >= offering.min_followers,
    ).length;
    score += sharedPlatformCount * 100 + eligibleOfferingCount * 10;
    const creatorCountries = creator.platforms.flatMap(
      (platform) => platform.topCountries?.map(({ country }) => normalizeFacet(country)) ?? [],
    );
    score +=
      2 *
      (hotel.targetAudience?.filter((country) => creatorCountries.includes(normalizeFacet(country)))
        .length ?? 0);
  }

  if (hotel.description.trim()) score += 1;
  if (hotel.images.length > 0) score += 1;
  if (hotel.collaborationOfferings?.length) score += 1;
  return score;
}

function getOfferingTypes(hotel: Hotel): string[] {
  if (hotel.collaborationOfferings?.length) {
    return hotel.collaborationOfferings.map(({ collaboration_type }) =>
      normalizeFacet(collaboration_type),
    );
  }
  return hotel.collaborationType === "Kostenlos"
    ? ["free_stay"]
    : hotel.collaborationType === "Bezahlt"
      ? ["paid"]
      : [];
}

function toOfferingType(value: string): string {
  const normalized = normalizeFacet(value);
  return normalized === "paid_stay" ? "paid" : normalized;
}

function normalizeFacet(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizePropertyType(value: string): string {
  const normalized = normalizeFacet(value);
  const legacyAliases: Record<string, string> = {
    apart_hotel: "aparthotel",
    boutique_hotel: "hotel",
    boutiques_hotel: "hotel",
    city_hotel: "hotel",
    luxury_hotel: "hotel",
    eco_resort: "resort",
    guest_house: "guesthouse",
    lodge: "other",
  };
  const propertyType = legacyAliases[normalized] ?? normalized;
  return CANONICAL_PROPERTY_TYPES.has(propertyType) ? propertyType : "other";
}

const CANONICAL_PROPERTY_TYPES = new Set([
  "hotel",
  "resort",
  "hostel",
  "apartment",
  "aparthotel",
  "guesthouse",
  "bed_and_breakfast",
  "villa",
  "vacation_rental",
  "motel",
  "other",
]);

function toArray(value: string | string[] | undefined): string[] {
  return value ? (Array.isArray(value) ? value : [value]) : [];
}

function timestamp(hotel: Hotel): number {
  const value = hotel.createdAt.getTime();
  return Number.isFinite(value) ? value : 0;
}
