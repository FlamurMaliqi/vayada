import { describe, expect, it } from "vitest";

import {
  PROPERTY_MEDIA_AUTHORIZATION,
  PROPERTY_MEDIA_MAX_GALLERY_ITEMS,
  parseAssignPropertyLogoRequest,
  parsePropertyMediaLibraryItem,
  parseReplacePropertyPresentationMediaRequest,
} from "./propertyMedia.js";

const logoId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const coverId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const galleryId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("canonical property media contract", () => {
  it("uses Hotel Catalog property authorization instead of a product-specific resource", () => {
    expect(PROPERTY_MEDIA_AUTHORIZATION).toEqual({
      permission: "hotel_catalog.setup.manage",
      product: "hotel_catalog",
      resourceType: "property",
      allowedRelationships: ["owner", "operator"],
    });
  });

  it("keeps upload purpose separate from presentation role and hides private URLs", () => {
    const privateItem = {
      mediaObjectId: galleryId,
      purpose: "property.gallery_image",
      status: "private_ready",
      publicVariants: [],
    };
    expect(parsePropertyMediaLibraryItem(privateItem)).toEqual(privateItem);
    expect(
      parsePropertyMediaLibraryItem({
        ...privateItem,
        role: "cover",
      }),
    ).toBeNull();
    expect(
      parsePropertyMediaLibraryItem({
        ...privateItem,
        stagingKey: "private/uploads/file.webp",
      }),
    ).toBeNull();
    expect(
      parsePropertyMediaLibraryItem({
        ...privateItem,
        purpose: "pms.room_type.media",
      }),
    ).not.toBeNull();
  });

  it("exposes variants only for public-ready library items", () => {
    const publicItem = {
      mediaObjectId: coverId,
      purpose: "property.hero_image",
      status: "public_ready",
      publicVariants: [
        {
          variantName: "large",
          publicUrl: "https://cdn.example/property/cover-large.webp",
        },
      ],
    };
    expect(parsePropertyMediaLibraryItem(publicItem)).toEqual(publicItem);
    expect(
      parsePropertyMediaLibraryItem({
        ...publicItem,
        status: "private_ready",
      }),
    ).toBeNull();
    expect(
      parsePropertyMediaLibraryItem({
        ...publicItem,
        publicVariants: [],
      }),
    ).toBeNull();
  });

  it("assigns or removes the property logo through its own CAS request", () => {
    const request = {
      expectedProfileRevision: 3,
      assignment: {
        mediaObjectId: logoId,
        role: "logo",
        altText: "Hotel Alpenrose logo",
        sortOrder: 0,
      },
    };
    expect(parseAssignPropertyLogoRequest(request)).toEqual(request);
    expect(
      parseAssignPropertyLogoRequest({
        expectedProfileRevision: 3,
        assignment: null,
      }),
    ).toEqual({
      expectedProfileRevision: 3,
      assignment: null,
    });
    expect(
      parseAssignPropertyLogoRequest({
        ...request,
        assignment: { ...request.assignment, role: "cover" },
      }),
    ).toBeNull();
  });

  it("replaces cover and gallery without accepting a logo assignment", () => {
    const request = {
      expectedProfileRevision: 4,
      assignments: [
        { mediaObjectId: coverId, role: "cover", altText: null, sortOrder: 0 },
        { mediaObjectId: galleryId, role: "gallery", altText: "Lobby", sortOrder: 1 },
      ],
    };
    expect(parseReplacePropertyPresentationMediaRequest(request)).toEqual(request);
    expect(
      parseReplacePropertyPresentationMediaRequest({
        ...request,
        assignments: [
          ...request.assignments,
          { mediaObjectId: logoId, role: "logo", altText: null, sortOrder: 2 },
        ],
      }),
    ).toBeNull();
  });

  it("allows an explicit empty presentation set", () => {
    expect(
      parseReplacePropertyPresentationMediaRequest({
        expectedProfileRevision: 4,
        assignments: [],
      }),
    ).toEqual({
      expectedProfileRevision: 4,
      assignments: [],
    });
  });

  it("reuses one asset across roles but rejects duplicate role references and bad order", () => {
    const cover = { mediaObjectId: coverId, role: "cover", altText: null, sortOrder: 0 };
    expect(
      parseReplacePropertyPresentationMediaRequest({
        expectedProfileRevision: 4,
        assignments: [cover, { ...cover, mediaObjectId: galleryId, sortOrder: 1 }],
      }),
    ).toBeNull();
    expect(
      parseReplacePropertyPresentationMediaRequest({
        expectedProfileRevision: 4,
        assignments: [
          cover,
          { mediaObjectId: coverId, role: "gallery", altText: null, sortOrder: 1 },
        ],
      }),
    ).not.toBeNull();
    expect(
      parseReplacePropertyPresentationMediaRequest({
        expectedProfileRevision: 4,
        assignments: [
          { ...cover, role: "gallery" },
          { ...cover, role: "gallery", sortOrder: 1 },
        ],
      }),
    ).toBeNull();
    expect(
      parseReplacePropertyPresentationMediaRequest({
        expectedProfileRevision: 4,
        assignments: [{ ...cover, role: "gallery", sortOrder: 1 }],
      }),
    ).toBeNull();
  });

  it("enforces the gallery limit and exact request shape", () => {
    const assignments = Array.from(
      { length: PROPERTY_MEDIA_MAX_GALLERY_ITEMS + 1 },
      (_, index) => ({
        mediaObjectId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        role: "gallery",
        altText: null,
        sortOrder: index,
      }),
    );
    expect(
      parseReplacePropertyPresentationMediaRequest({
        expectedProfileRevision: 4,
        assignments,
      }),
    ).toBeNull();
    expect(
      parseReplacePropertyPresentationMediaRequest({
        expectedProfileRevision: 4,
        assignments: [],
        legacyImageUrls: [],
      }),
    ).toBeNull();
  });
});
