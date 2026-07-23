import { describe, expect, it, vi } from "vitest";
import type { ListingFormData } from "@/lib/types";
import {
  clearHotelMarketplaceDraft,
  createHotelMarketplaceDraft,
  ensureHotelMarketplaceOfferIdempotency,
  initialHotelMarketplaceOfferImages,
  markHotelMarketplaceDraftOfferCreated,
  markHotelMarketplaceDraftOfferProgress,
  pendingHotelMarketplaceDraftListings,
  readHotelMarketplaceDraft,
  saveHotelMarketplaceDraft,
} from "./hotelMarketplaceDraft";

function listing(overrides: Partial<ListingFormData> = {}): ListingFormData {
  return {
    name: "Creator stay",
    location: "Berlin",
    description: "A creator stay in Berlin",
    accommodation_type: "hotel",
    images: ["https://cdn.example/hotel.jpg"],
    imageMediaObjectIds: ["media-1"],
    imageFiles: [],
    collaborationTypes: ["Free Stay"],
    availability: ["Jan"],
    platforms: ["Instagram"],
    lookingForPlatforms: ["Instagram"],
    targetGroupCountries: [],
    targetGroupAgeGroups: [],
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
}

describe("hotel Marketplace draft", () => {
  it("reuses the canonical hotel hero for the first collaboration offer", () => {
    expect(initialHotelMarketplaceOfferImages(" https://cdn.example/hotel.jpg ")).toEqual([
      "https://cdn.example/hotel.jpg",
    ]);
    expect(initialHotelMarketplaceOfferImages(null)).toEqual([]);
  });

  it("restores serializable offer fields and remote media", () => {
    const storage = memoryStorage();
    saveHotelMarketplaceDraft(
      storage,
      "property-1",
      createHotelMarketplaceDraft({ about: "About the hotel" }, [listing()], 3, 100),
    );

    expect(readHotelMarketplaceDraft(storage, "property-1", 200)).toMatchObject({
      currentStep: 3,
      form: { about: "About the hotel" },
      listings: [
        { name: "Creator stay", images: ["https://cdn.example/hotel.jpg"], imageFiles: [] },
      ],
      omittedLocalPhotos: false,
    });
  });

  it("persists one stable idempotency key per draft offer", () => {
    const storage = memoryStorage();
    const first = ensureHotelMarketplaceOfferIdempotency(listing({ name: "First offer" }));
    const second = ensureHotelMarketplaceOfferIdempotency(listing({ name: "Second offer" }));
    const draft = createHotelMarketplaceDraft(
      { about: "About the hotel" },
      [first, second],
      4,
      100,
    );
    saveHotelMarketplaceDraft(storage, "property-1", draft);

    const restored = readHotelMarketplaceDraft(storage, "property-1", 200);

    expect(restored?.listings.map((offer) => offer.marketplaceOnboarding?.idempotencyKey)).toEqual([
      first.marketplaceOnboarding?.idempotencyKey,
      second.marketplaceOnboarding?.idempotencyKey,
    ]);
    expect(restored?.listings[0]?.marketplaceOnboarding?.idempotencyKey).not.toBe(
      restored?.listings[1]?.marketplaceOnboarding?.idempotencyKey,
    );
  });

  it("marks successful offers individually and keeps unfinished offers pending", () => {
    const storage = memoryStorage();
    const first = ensureHotelMarketplaceOfferIdempotency(listing({ name: "First offer" }));
    const second = ensureHotelMarketplaceOfferIdempotency(listing({ name: "Second offer" }));
    saveHotelMarketplaceDraft(
      storage,
      "property-1",
      createHotelMarketplaceDraft({ about: "About" }, [first, second], 4, 100),
    );

    markHotelMarketplaceDraftOfferCreated(
      storage,
      "property-1",
      first.marketplaceOnboarding!.idempotencyKey,
      "created-offer-one",
      200,
    );
    const restored = readHotelMarketplaceDraft(storage, "property-1", 300)!;

    expect(restored.listings[0]?.marketplaceOnboarding?.createdOfferId).toBe("created-offer-one");
    expect(pendingHotelMarketplaceDraftListings(restored).map((offer) => offer.name)).toEqual([
      "Second offer",
    ]);

    saveHotelMarketplaceDraft(
      storage,
      "property-1",
      createHotelMarketplaceDraft({ about: "About" }, [first, second], 4, 250),
    );
    expect(
      readHotelMarketplaceDraft(storage, "property-1", 300)?.listings[0]?.marketplaceOnboarding
        ?.createdOfferId,
    ).toBe("created-offer-one");
  });

  it("persists a created offer as pending until its media upload finishes", () => {
    const storage = memoryStorage();
    const offer = ensureHotelMarketplaceOfferIdempotency(listing());
    const idempotencyKey = offer.marketplaceOnboarding!.idempotencyKey;
    saveHotelMarketplaceDraft(
      storage,
      "property-1",
      createHotelMarketplaceDraft({ about: "About" }, [offer], 4, 100),
    );

    markHotelMarketplaceDraftOfferProgress(
      storage,
      "property-1",
      idempotencyKey,
      {
        idempotencyKey,
        createdOfferId: "created-offer-one",
        createdOfferMediaResourceId: "offer-media-resource",
        mediaPending: true,
      },
      200,
    );
    const pending = readHotelMarketplaceDraft(storage, "property-1", 300)!;
    expect(pendingHotelMarketplaceDraftListings(pending)).toHaveLength(1);
    expect(pending.listings[0]?.marketplaceOnboarding).toMatchObject({
      createdOfferId: "created-offer-one",
      createdOfferMediaResourceId: "offer-media-resource",
      mediaPending: true,
    });

    markHotelMarketplaceDraftOfferProgress(
      storage,
      "property-1",
      idempotencyKey,
      {
        idempotencyKey,
        createdOfferId: "created-offer-one",
        createdOfferMediaResourceId: "offer-media-resource",
        mediaPending: false,
      },
      400,
    );
    expect(
      pendingHotelMarketplaceDraftListings(readHotelMarketplaceDraft(storage, "property-1", 500)!),
    ).toEqual([]);
  });

  it("does not put local image data or File objects in local storage", () => {
    const storage = memoryStorage();
    const file = new File(["image"], "hotel.png", { type: "image/png" });
    const draft = createHotelMarketplaceDraft(
      { about: "About the hotel" },
      [listing({ images: ["data:image/png;base64,aGVsbG8="], imageFiles: [file] })],
      4,
      100,
    );

    saveHotelMarketplaceDraft(storage, "property-1", draft);
    const restored = readHotelMarketplaceDraft(storage, "property-1", 200);

    expect(restored?.listings[0]).toMatchObject({ images: [], imageFiles: [] });
    expect(restored?.omittedLocalPhotos).toBe(true);
  });

  it("removes expired, malformed, and completed drafts", () => {
    const storage = memoryStorage();
    storage.setItem("vayada_hotel_marketplace_draft:malformed", "not-json");
    expect(readHotelMarketplaceDraft(storage, "malformed")).toBeNull();

    saveHotelMarketplaceDraft(
      storage,
      "expired",
      createHotelMarketplaceDraft({ about: "About" }, [listing()], 2, 0),
    );
    expect(readHotelMarketplaceDraft(storage, "expired", 8 * 24 * 60 * 60 * 1_000)).toBeNull();

    saveHotelMarketplaceDraft(
      storage,
      "complete",
      createHotelMarketplaceDraft({ about: "About" }, [listing()], 2),
    );
    clearHotelMarketplaceDraft(storage, "complete");
    expect(readHotelMarketplaceDraft(storage, "complete")).toBeNull();
  });
});
