import { describe, expect, it } from "vitest";

import {
  PROPERTY_MEDIA_AUTHORIZATION,
  PROPERTY_MEDIA_LIBRARY_STATUSES,
  PROPERTY_MEDIA_MAX_GALLERY_ITEMS,
  PROPERTY_MEDIA_PRESENTATION_ROLES,
  PROPERTY_MEDIA_PUBLIC_VARIANTS,
  PROPERTY_MEDIA_UPLOAD_PURPOSES,
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
    expect(Object.isFrozen(PROPERTY_MEDIA_AUTHORIZATION)).toBe(true);
    expect(Object.isFrozen(PROPERTY_MEDIA_AUTHORIZATION.allowedRelationships)).toBe(true);
    expect(Object.isFrozen(PROPERTY_MEDIA_UPLOAD_PURPOSES)).toBe(true);
    expect(Object.isFrozen(PROPERTY_MEDIA_PRESENTATION_ROLES)).toBe(true);
    expect(Object.isFrozen(PROPERTY_MEDIA_PUBLIC_VARIANTS)).toBe(true);
    expect(Object.isFrozen(PROPERTY_MEDIA_LIBRARY_STATUSES)).toBe(true);
    expect(() =>
      (PROPERTY_MEDIA_AUTHORIZATION.allowedRelationships as unknown as string[]).push("viewer"),
    ).toThrow(TypeError);
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
    const snapshot = parsePropertyMediaLibraryItem({
      ...publicItem,
      mediaObjectId: coverId.toUpperCase(),
    });
    expect(snapshot?.mediaObjectId).toBe(coverId);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.publicVariants)).toBe(true);
    expect(Object.isFrozen(snapshot?.publicVariants[0])).toBe(true);
    publicItem.publicVariants[0]!.publicUrl = "https://attacker.example/replaced.webp";
    expect(snapshot?.publicVariants[0]?.publicUrl).toBe(
      "https://cdn.example/property/cover-large.webp",
    );
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
    const canonical = parseAssignPropertyLogoRequest({
      ...request,
      assignment: { ...request.assignment, mediaObjectId: logoId.toUpperCase() },
    });
    expect(canonical?.assignment?.mediaObjectId).toBe(logoId);
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical?.assignment)).toBe(true);
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
    const parsed = parseReplacePropertyPresentationMediaRequest(request);
    expect(parsed).toEqual(request);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.assignments)).toBe(true);
    expect(Object.isFrozen(parsed?.assignments[0])).toBe(true);
    request.assignments[0]!.altText = "mutated after parsing";
    expect(parsed?.assignments[0]?.altText).toBeNull();
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
          { ...cover, role: "gallery", mediaObjectId: galleryId.toUpperCase() },
          { ...cover, role: "gallery", mediaObjectId: galleryId, sortOrder: 1 },
        ],
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

  it("rejects inherited fields and non-plain records", () => {
    const inheritedRevision = Object.create({ expectedProfileRevision: 4 }) as Record<
      string,
      unknown
    >;
    inheritedRevision["assignments"] = [];
    expect(parseReplacePropertyPresentationMediaRequest(inheritedRevision)).toBeNull();

    const inheritedAssignment = Object.create({ mediaObjectId: galleryId }) as Record<
      string,
      unknown
    >;
    inheritedAssignment["role"] = "gallery";
    inheritedAssignment["altText"] = null;
    inheritedAssignment["sortOrder"] = 0;
    expect(
      parseReplacePropertyPresentationMediaRequest({
        expectedProfileRevision: 4,
        assignments: [inheritedAssignment],
      }),
    ).toBeNull();

    class MediaRequest {
      expectedProfileRevision = 4;
      assignments: unknown[] = [];
    }
    expect(parseReplacePropertyPresentationMediaRequest(new MediaRequest())).toBeNull();

    const accessorRequest = { assignments: [] as unknown[] } as Record<string, unknown>;
    Object.defineProperty(accessorRequest, "expectedProfileRevision", {
      enumerable: true,
      get: () => 4,
    });
    expect(parseReplacePropertyPresentationMediaRequest(accessorRequest)).toBeNull();

    const hiddenFieldRequest = { expectedProfileRevision: 4, assignments: [] };
    Object.defineProperty(hiddenFieldRequest, "legacyMedia", {
      enumerable: false,
      value: [],
    });
    expect(parseReplacePropertyPresentationMediaRequest(hiddenFieldRequest)).toBeNull();

    const symbolFieldRequest = { expectedProfileRevision: 4, assignments: [] };
    Object.defineProperty(symbolFieldRequest, Symbol("legacyMedia"), {
      enumerable: true,
      value: [],
    });
    expect(parseReplacePropertyPresentationMediaRequest(symbolFieldRequest)).toBeNull();
  });
});
