import { describe, expect, it } from "vitest";

import {
  createHotelCatalogStep1MediaAssignments,
  parseHotelCatalogStep1ReadModel,
  parseSaveHotelCatalogStep1Request,
  parseSaveHotelCatalogStep1Response,
} from "./hotelCatalogStep1.js";

const coverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const galleryId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const summary =
  "A welcoming independent hotel with calm rooms, thoughtful service, and an easy walk to local highlights.";

const savedResponse = {
  contractVersion: "hotel-catalog-step1.v1",
  propertyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  displayName: "Hotel Alpenrose",
  profileRevision: 4,
  supportedLocales: ["de", "en"],
  profile: {
    locale: "de",
    shortDescription: summary,
    publicSlug: "hotel-alpenrose",
    amenities: { reviewed: true, keys: ["parking", "wifi"] },
    media: { coverMediaObjectId: coverId, galleryMediaObjectIds: [galleryId] },
  },
  baseRevisions: {
    "hotel_catalog.profile": "profile:4",
    "hotel_catalog.media": "profile:4",
    "hotel_catalog.amenities": "profile:4",
  },
  outcome: "updated",
} as const;

describe("Hotel Catalog Step 1 contract", () => {
  it("normalizes a complete request and preserves reviewed-empty amenities", () => {
    expect(
      parseSaveHotelCatalogStep1Request({
        expectedProfileRevision: 3,
        locale: "de",
        shortDescription: `  ${summary}  `,
        amenities: { reviewed: true, keys: [] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
      }),
    ).toEqual({
      expectedProfileRevision: 3,
      locale: "de",
      shortDescription: summary,
      amenities: { reviewed: true, keys: [] },
      media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
    });
  });

  it("trims only boundaries and preserves authored whitespace within 50 characters", () => {
    const authored = `${"A".repeat(24)}  ${"B".repeat(24)}`;
    expect(authored).toHaveLength(50);
    expect(
      parseSaveHotelCatalogStep1Request({
        expectedProfileRevision: 3,
        locale: "en",
        shortDescription: `  ${authored}  `,
        amenities: { reviewed: true, keys: [] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
      }),
    ).toMatchObject({ shortDescription: authored });
  });

  it("counts Unicode code points rather than UTF-16 storage units", () => {
    const unicodeSummary = "🏨".repeat(500);
    expect(
      parseSaveHotelCatalogStep1Request({
        expectedProfileRevision: 3,
        locale: "en",
        shortDescription: unicodeSummary,
        amenities: { reviewed: true, keys: [] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
      }),
    ).toMatchObject({ shortDescription: unicodeSummary });
  });

  it.each([
    ["unsupported locale", { locale: "pt" }],
    ["short summary", { shortDescription: "Too short" }],
    ["NUL in summary", { shortDescription: `${"A".repeat(49)}\u0000` }],
    ["non-public control in summary", { shortDescription: `${"A".repeat(49)}\u0001` }],
    [
      "unpaired surrogate in summary",
      { shortDescription: `${"A".repeat(49)}${String.fromCharCode(0xd800)}` },
    ],
    ["unreviewed amenities", { amenities: { reviewed: false, keys: [] } }],
    ["unknown amenity", { amenities: { reviewed: true, keys: ["private_address"] } }],
    [
      "duplicate media",
      { media: { coverMediaObjectId: coverId, galleryMediaObjectIds: [galleryId, galleryId] } },
    ],
  ])("rejects %s", (_name, patch) => {
    expect(
      parseSaveHotelCatalogStep1Request({
        expectedProfileRevision: 3,
        locale: "en",
        shortDescription: summary,
        amenities: { reviewed: true, keys: ["wifi"] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
        ...patch,
      }),
    ).toBeNull();
  });

  it("generates deterministic typed media assignments without address input", () => {
    expect(
      createHotelCatalogStep1MediaAssignments(
        { coverMediaObjectId: coverId, galleryMediaObjectIds: [galleryId] },
        " Hotel Alpenrose\nMunich ",
      ),
    ).toEqual([
      {
        mediaObjectId: coverId,
        role: "cover",
        altText: "Cover photo of Hotel Alpenrose Munich",
        sortOrder: 0,
      },
      {
        mediaObjectId: galleryId,
        role: "gallery",
        altText: "Hotel Alpenrose Munich gallery photo 1",
        sortOrder: 1,
      },
    ]);
  });

  it("allows one canonical object to serve distinct cover and gallery roles", () => {
    expect(
      parseSaveHotelCatalogStep1Request({
        expectedProfileRevision: 3,
        locale: "en",
        shortDescription: summary,
        amenities: { reviewed: true, keys: [] },
        media: { coverMediaObjectId: coverId, galleryMediaObjectIds: [coverId] },
      }),
    ).not.toBeNull();
  });

  it("strictly reconstructs a stored successful response", () => {
    expect(parseSaveHotelCatalogStep1Response(savedResponse)).toEqual(savedResponse);
  });

  it("strictly parses the nullable first-visit read model without a save outcome", () => {
    const { outcome: _outcome, ...completeReadModel } = savedResponse;
    const firstVisit = {
      ...completeReadModel,
      profile: {
        ...completeReadModel.profile,
        shortDescription: null,
        publicSlug: null,
        amenities: { reviewed: false, keys: [] },
      },
    };

    expect(parseHotelCatalogStep1ReadModel(firstVisit)).toEqual(firstVisit);
    expect(parseSaveHotelCatalogStep1Response(firstVisit)).toBeNull();
    expect(parseHotelCatalogStep1ReadModel({ ...firstVisit, outcome: "updated" })).toBeNull();
  });

  it("rejects accessors and symbol keys at the read-model boundary", () => {
    const { outcome: _outcome, ...readModel } = savedResponse;
    const accessor = { ...readModel };
    Object.defineProperty(accessor, "displayName", {
      enumerable: true,
      get: () => "Hotel Alpenrose",
    });
    const symbolKey = { ...readModel, [Symbol("unexpected")]: true };

    expect(parseHotelCatalogStep1ReadModel(accessor)).toBeNull();
    expect(parseHotelCatalogStep1ReadModel(symbolKey)).toBeNull();
  });

  it("rejects sparse, accessor-backed, and symbol-bearing nested arrays", () => {
    const { outcome: _outcome, ...readModel } = savedResponse;
    const sparseLocales = Array(1);
    const amenityKeys = ["wifi"];
    Object.defineProperty(amenityKeys, "0", { enumerable: true, get: () => "wifi" });
    const galleryIds = [galleryId];
    Object.defineProperty(galleryIds, Symbol("unexpected"), { value: true });

    expect(
      parseHotelCatalogStep1ReadModel({
        ...readModel,
        supportedLocales: sparseLocales,
        profile: { ...readModel.profile, locale: undefined },
      }),
    ).toBeNull();
    expect(
      parseHotelCatalogStep1ReadModel({
        ...readModel,
        profile: {
          ...readModel.profile,
          amenities: { reviewed: true, keys: amenityKeys },
        },
      }),
    ).toBeNull();
    expect(
      parseHotelCatalogStep1ReadModel({
        ...readModel,
        profile: {
          ...readModel.profile,
          media: { coverMediaObjectId: coverId, galleryMediaObjectIds: galleryIds },
        },
      }),
    ).toBeNull();
  });

  it.each([
    ["unsupported locale", { supportedLocales: ["de", "pt"] }],
    ["unsorted locales", { supportedLocales: ["en", "de"] }],
    ["null saved summary", { profile: { ...savedResponse.profile, shortDescription: null } }],
    [
      "unknown amenity",
      { profile: { ...savedResponse.profile, amenities: { reviewed: true, keys: ["casino"] } } },
    ],
    [
      "invalid media id",
      {
        profile: {
          ...savedResponse.profile,
          media: { coverMediaObjectId: "not-a-uuid", galleryMediaObjectIds: [] },
        },
      },
    ],
    [
      "invalid public slug",
      { profile: { ...savedResponse.profile, publicSlug: "Hotel Alpenrose" } },
    ],
    [
      "mismatched revision tokens",
      { baseRevisions: { ...savedResponse.baseRevisions, "hotel_catalog.media": "profile:3" } },
    ],
  ])("rejects stored success with %s", (_name, patch) => {
    expect(parseSaveHotelCatalogStep1Response({ ...savedResponse, ...patch })).toBeNull();
  });
});
