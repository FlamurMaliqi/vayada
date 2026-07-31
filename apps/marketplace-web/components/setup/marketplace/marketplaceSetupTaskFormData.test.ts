import { describe, expect, it } from "vitest";

import type { HotelListing, HotelProfile, ListingFormData } from "@/lib/types";
import {
  buildHotelMarketplaceCreatorRequirements,
  buildHotelMarketplaceOfferings,
} from "@/lib/utils/hotelMarketplaceDraft";

import { hydrateMarketplaceSetupTask } from "./marketplaceSetupTaskFormData";

describe("Marketplace inline setup task data", () => {
  it("hydrates the one shared hotel description from the canonical public profile", () => {
    const profile = hotelProfile();

    expect(hydrateMarketplaceSetupTask(profile, "public_profile").form).toEqual({
      about: "The canonical public hotel description.",
      localityPublic: true,
    });
  });

  it("does not restore a legacy Marketplace-only description", () => {
    const profile = hotelProfile({ publicAbout: null });

    expect(hydrateMarketplaceSetupTask(profile, "public_profile").form.about).toBe("");
  });

  it("hydrates the active offer for editing", () => {
    const pending = hotelListing({ id: "pending", status: "pending" });
    const profile = hotelProfile({
      picture: null,
      listings: [
        hotelListing({
          id: "rejected",
          status: "rejected",
          images: ["https://cdn.example/rejected-cover.jpg"],
        }),
        pending,
      ],
    });

    const hydration = hydrateMarketplaceSetupTask(profile, "creator_offer");

    expect(hydration.hasExistingOffer).toBe(true);
    expect(hydration.listings).toHaveLength(1);
    expect(hydration.listings[0]).toMatchObject({
      name: pending.name,
      marketplaceOnboarding: {
        createdOfferId: "pending",
        existingOffer: true,
      },
    });
    expect(hydration.existingOfferCoverUrl).toBe(pending.images[0]);
  });

  it("reuses a rejected offer only as a public-cover fallback", () => {
    const profile = hotelProfile({
      picture: null,
      listings: [
        hotelListing({
          id: "rejected",
          status: "rejected",
          images: ["https://cdn.example/rejected-cover.jpg"],
        }),
      ],
    });

    const offerHydration = hydrateMarketplaceSetupTask(profile, "creator_offer");
    const publicHydration = hydrateMarketplaceSetupTask(profile, "public_profile");

    expect(offerHydration.hasExistingOffer).toBe(false);
    expect(offerHydration.listings[0]?.marketplaceOnboarding?.createdOfferId).toBeUndefined();
    expect(publicHydration.existingOfferCoverUrl).toBe("https://cdn.example/rejected-cover.jpg");
  });

  it("maps offer compensation and audience age groups to the write contract", () => {
    const listing = listingForm({
      collaborationTypes: ["Free Stay", "Paid", "Affiliate"],
      freeStayMinNights: 2,
      freeStayMaxNights: 4,
      paidMaxAmount: 500,
      currency: "EUR",
      commissionPercentage: 7,
      targetGroupAgeGroups: ["25-34", "55+"],
    });

    expect(buildHotelMarketplaceOfferings(listing)).toEqual([
      expect.objectContaining({
        collaboration_type: "Free Stay",
        free_stay_min_nights: 2,
        free_stay_max_nights: 4,
      }),
      expect.objectContaining({
        collaboration_type: "Paid",
        paid_max_amount: 500,
        currency: "EUR",
      }),
      expect.objectContaining({
        collaboration_type: "Affiliate",
        commission_percentage: 7,
      }),
    ]);
    expect(buildHotelMarketplaceCreatorRequirements(listing)).toMatchObject({
      target_age_min: 25,
      target_age_max: undefined,
      target_age_groups: ["25-34", "55+"],
    });
  });
});

function hotelProfile(overrides: Partial<HotelProfile> = {}): HotelProfile {
  return {
    id: "property-one",
    user_id: "user-one",
    canonicalProfileRevision: 3,
    publicProfileRevision: 3,
    name: "Hotel One",
    propertyType: "hotel",
    category: "Hotel",
    location: "Berlin, Germany",
    localityPublic: true,
    picture: "https://cdn.example/hotel.jpg",
    website: null,
    about: "The Marketplace-only creator introduction.",
    publicAbout: "The canonical public hotel description.",
    marketplaceAbout: "The Marketplace-only creator introduction.",
    email: "hotel@example.com",
    phone: null,
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    listings: [],
    ...overrides,
  };
}

function hotelListing(overrides: Partial<HotelListing> = {}): HotelListing {
  return {
    id: "offer-one",
    media_resource_id: "offer-one",
    hotel_profile_id: "property-one",
    name: "Creator stay",
    location: "Berlin, Germany",
    description: "A complete creator stay.",
    accommodation_type: "hotel",
    images: ["https://cdn.example/offer.jpg"],
    image_media_object_ids: ["media-one"],
    status: "pending",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    collaboration_offerings: [
      {
        id: "compensation-one",
        listing_id: "offer-one",
        collaboration_type: "Free Stay",
        availability_months: ["January"],
        platforms: ["Instagram"],
        free_stay_min_nights: 2,
        free_stay_max_nights: 3,
        paid_max_amount: null,
        currency: null,
        discount_percentage: null,
        commission_percentage: null,
        min_followers: null,
        terms_summary: null,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    creator_requirements: {
      id: "requirements-one",
      listing_id: "offer-one",
      platforms: ["Instagram"],
      target_countries: [],
      target_age_min: null,
      target_age_max: null,
      target_age_groups: [],
      creator_types: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function listingForm(overrides: Partial<ListingFormData> = {}): ListingFormData {
  return {
    name: "Creator stay",
    location: "Berlin, Germany",
    description: "A complete creator stay.",
    accommodation_type: "hotel",
    images: ["https://cdn.example/offer.jpg"],
    imageMediaObjectIds: ["media-one"],
    imageFiles: [],
    collaborationTypes: ["Free Stay"],
    availability: ["January"],
    platforms: ["Instagram"],
    lookingForPlatforms: ["Instagram"],
    targetGroupCountries: [],
    targetGroupAgeGroups: [],
    ...overrides,
  };
}
