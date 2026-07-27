import { describe, expect, it } from "vitest";

import type { ListingFormData } from "@/lib/types";

import { canRemoveListingImage, removeListingImageAt } from "./listingImageState";

describe("removeListingImageAt", () => {
  it("removes a persisted media image without removing a local upload", () => {
    const listing = listingWithMixedImages();

    const result = removeListingImageAt(listing, 0);

    expect(result.images).toEqual([
      "https://source.example/copy.jpg",
      "data:local-a",
      "data:local-b",
    ]);
    expect(result.imageMediaObjectIds).toEqual([]);
    expect(result.imageFiles).toEqual(listing.imageFiles);
  });

  it("removes a copied source image without shifting media ids or local uploads", () => {
    const listing = listingWithMixedImages();

    const result = removeListingImageAt(listing, 1);

    expect(result.images).toEqual([
      "https://media.example/one.jpg",
      "data:local-a",
      "data:local-b",
    ]);
    expect(result.imageMediaObjectIds).toEqual(["media-1"]);
    expect(result.imageFiles).toEqual(listing.imageFiles);
  });

  it("removes only the local file paired with the selected local preview", () => {
    const listing = listingWithMixedImages();

    const result = removeListingImageAt(listing, 3);

    expect(result.images).toEqual([
      "https://media.example/one.jpg",
      "https://source.example/copy.jpg",
      "data:local-a",
    ]);
    expect(result.imageMediaObjectIds).toEqual(["media-1"]);
    expect(result.imageFiles).toEqual([listing.imageFiles[0]]);
  });
});

describe("canRemoveListingImage", () => {
  it("keeps persisted images read-only when the offer already exists", () => {
    const listing = listingWithMixedImages(true);

    expect(canRemoveListingImage(listing, 0)).toBe(false);
    expect(canRemoveListingImage(listing, 1)).toBe(false);
    expect(canRemoveListingImage(listing, 2)).toBe(true);
  });

  it("allows source images to be removed before a new offer is created", () => {
    const listing = listingWithMixedImages(false);

    expect(canRemoveListingImage(listing, 0)).toBe(true);
    expect(canRemoveListingImage(listing, 1)).toBe(true);
  });
});

function listingWithMixedImages(existingOffer = false): ListingFormData {
  const listing: ListingFormData = {
    name: "Creator stay",
    location: "Berlin",
    description: "A creator collaboration offer.",
    accommodation_type: "hotel",
    images: [
      "https://media.example/one.jpg",
      "https://source.example/copy.jpg",
      "data:local-a",
      "data:local-b",
    ],
    imageMediaObjectIds: ["media-1"],
    imageFiles: [{ name: "local-a.jpg" } as File, { name: "local-b.jpg" } as File],
    collaborationTypes: ["Free Stay"],
    availability: ["January"],
    platforms: ["Instagram"],
    lookingForPlatforms: ["Instagram"],
    targetGroupCountries: ["Germany"],
  };
  if (existingOffer) {
    listing.marketplaceOnboarding = {
      idempotencyKey: "marketplace.hotel-offer.edit:offer-1:v1",
      createdOfferId: "offer-1",
      existingOffer: true,
    };
  }
  return listing;
}
