import { describe, expect, it } from "vitest";

import { transformListingToApi } from "@/components/profile/transforms";
import { createListingFormDataForEdit, type ProfileHotelListing } from "@/components/profile/types";

describe("createListingFormDataForEdit", () => {
  it("preserves existing media object ids when an edit saves without new images", () => {
    const listing: ProfileHotelListing = {
      id: "offer-1",
      name: "Alpine retreat",
      location: "Munich",
      description: "Mountain views",
      images: ["https://cdn.example.com/offer.webp"],
      imageMediaObjectIds: ["media-1"],
      offerings: [],
      collaborationTypes: [],
      availability: [],
      platforms: [],
      lookingForPlatforms: [],
      targetGroupCountries: [],
      status: "verified",
    };

    const payload = transformListingToApi(createListingFormDataForEdit(listing));

    expect(payload.image_media_object_ids).toEqual(["media-1"]);
  });
});
