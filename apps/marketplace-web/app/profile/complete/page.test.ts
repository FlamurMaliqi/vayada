import { describe, expect, it } from "vitest";

import type { ListingFormData } from "@/lib/types";
import {
  createHotelMarketplaceDraft,
  markHotelMarketplaceDraftOfferProgress,
  readHotelMarketplaceDraft,
  recoverHotelMarketplaceDraftFromSourceMediaFailure,
  recoverHotelMarketplaceOfferFromSourceMediaFailure,
  resolveHotelMarketplaceDraftResume,
  saveHotelMarketplaceDraft,
} from "@/lib/utils/hotelMarketplaceDraft";

describe("Marketplace hotel profile completion offer resume", () => {
  it("keeps unfinished draft offers when an earlier offer already exists", () => {
    const completed = draftListing("First offer", "draft-key-one", "offer-one");
    const unfinished = draftListing("Second offer", "draft-key-two");

    const resumed = resolveHotelMarketplaceDraftResume({ listings: [completed, unfinished] }, true);

    expect(resumed.hasExistingMarketplaceOffer).toBe(false);
    expect(resumed.listings).toEqual([unfinished]);
  });

  it("uses the existing-offer path only after every draft offer is complete", () => {
    const resumed = resolveHotelMarketplaceDraftResume(
      {
        listings: [
          draftListing("First offer", "draft-key-one", "offer-one"),
          draftListing("Second offer", "draft-key-two", "offer-two"),
        ],
      },
      true,
    );

    expect(resumed).toEqual({ listings: [], hasExistingMarketplaceOffer: true });
  });

  it("resumes media for an offer that was created before its upload failed", () => {
    const pendingMedia = draftListing("First offer", "draft-key-one", "offer-one");
    pendingMedia.marketplaceOnboarding = {
      ...pendingMedia.marketplaceOnboarding!,
      createdOfferMediaResourceId: "offer-media-resource",
      mediaPending: true,
    };

    const resumed = resolveHotelMarketplaceDraftResume({ listings: [pendingMedia] }, true);

    expect(resumed.hasExistingMarketplaceOffer).toBe(false);
    expect(resumed.listings).toEqual([pendingMedia]);
  });

  it("does not retry a canonical photo that the browser could not reuse", () => {
    const canonicalPhoto = "https://booking-images.example/hotel.jpg";
    const completedOffer = draftListing("Completed offer", "draft-key-complete", "offer-complete");
    completedOffer.marketplaceOnboarding = {
      ...completedOffer.marketplaceOnboarding!,
      createdOfferMediaResourceId: "completed-media-resource",
      mediaPending: true,
    };
    const pendingMedia = draftListing("First offer", "draft-key-one", "offer-one");
    pendingMedia.images = [canonicalPhoto];
    pendingMedia.imageMediaObjectIds = [];
    pendingMedia.marketplaceOnboarding = {
      ...pendingMedia.marketplaceOnboarding!,
      createdOfferMediaResourceId: "offer-media-resource",
      mediaPending: true,
    };
    const storage = memoryStorage();

    const recovered = recoverHotelMarketplaceOfferFromSourceMediaFailure(
      pendingMedia,
      [canonicalPhoto],
      pendingMedia.marketplaceOnboarding,
    );
    saveHotelMarketplaceDraft(
      storage,
      "property-one",
      createHotelMarketplaceDraft(
        { about: "About the hotel" },
        [completedOffer, pendingMedia],
        4,
        100,
      ),
    );
    markHotelMarketplaceDraftOfferProgress(
      storage,
      "property-one",
      "draft-key-complete",
      {
        ...completedOffer.marketplaceOnboarding,
        mediaPending: false,
      },
      150,
    );
    saveHotelMarketplaceDraft(
      storage,
      "property-one",
      recoverHotelMarketplaceDraftFromSourceMediaFailure(
        readHotelMarketplaceDraft(storage, "property-one", 175)!,
        "draft-key-one",
        [canonicalPhoto],
        recovered.marketplaceOnboarding!,
        180,
      ),
    );

    const restored = readHotelMarketplaceDraft(storage, "property-one", 200)!;
    const completedAfterRecovery = restored.listings[0]!;
    const nextRetry = restored.listings[1]!;
    const nextCopiedSources = nextRetry.images
      .filter((image) => !image.startsWith("data:"))
      .slice(nextRetry.imageMediaObjectIds?.length ?? 0);

    expect(nextRetry.images).toEqual([]);
    expect(nextCopiedSources).toEqual([]);
    expect(nextRetry.marketplaceOnboarding).toMatchObject({
      createdOfferId: "offer-one",
      createdOfferMediaResourceId: "offer-media-resource",
      mediaPending: true,
    });
    expect(completedAfterRecovery.marketplaceOnboarding).toMatchObject({
      createdOfferId: "offer-complete",
      createdOfferMediaResourceId: "completed-media-resource",
      mediaPending: false,
    });
    expect(resolveHotelMarketplaceDraftResume(restored, true).listings).toEqual([nextRetry]);
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function draftListing(
  name: string,
  idempotencyKey: string,
  createdOfferId?: string,
): ListingFormData {
  return {
    name,
    location: "Berlin",
    description: "A complete collaboration offer.",
    accommodation_type: "hotel",
    images: ["https://cdn.example/hotel.jpg"],
    imageFiles: [],
    collaborationTypes: ["Free Stay"],
    availability: ["January"],
    platforms: ["Instagram"],
    lookingForPlatforms: ["Instagram"],
    targetGroupCountries: [],
    marketplaceOnboarding: { idempotencyKey, ...(createdOfferId ? { createdOfferId } : {}) },
  };
}
