import { describe, expect, it } from "vitest";
import {
  parseNearbyCurationState,
  parseNearbyDiscoveryState,
  projectNearbyPreview,
  type NearbyDiscoveryState,
} from "./nearbyView.js";
import type { NearbyCurationState } from "./propertyNearby.js";
import type { PropertyProfileLocation } from "./propertyProfile.js";
const location: PropertyProfileLocation = {
  streetAddress: "Private road",
  postalCode: "1",
  city: "Town",
  countryCode: "ID",
  timezone: "Asia/Makassar",
  latitude: -1.125,
  longitude: 1.005,
  geoPublic: true,
  localityPublic: true,
  mapDisplayMode: "approximate",
};
const curation: NearbyCurationState = {
  schemaVersion: 1,
  profileRevision: 2,
  curationRevision: 1,
  savedProfileRevision: 2,
  choices: [
    {
      placeId: "hidden",
      category: "food",
      hidden: true,
      favorite: false,
      added: false,
      note: null,
    },
    {
      placeId: "favorite",
      category: "nature",
      hidden: false,
      favorite: true,
      added: false,
      note: "Our favorite",
    },
  ],
  customPlaces: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      category: "nature",
      name: "Our garden",
      address: null,
      latitude: 0,
      longitude: 0,
      hidden: false,
      favorite: false,
      note: null,
    },
  ],
};
const discovery: NearbyDiscoveryState = {
  schemaVersion: 1,
  profileRevision: 2,
  status: "ready",
  places: [
    { placeId: "hidden", category: "food" },
    { placeId: "automatic", category: "activities" },
  ],
  retryAfter: null,
};
describe("nearby public preview contract", () => {
  it("uses public rounding, separates favorites, omits exclusions and strips internal fields", () => {
    const preview = projectNearbyPreview(location, 2, curation, discovery);
    expect(preview.location).toEqual({ mode: "approximate", latitude: -1.13, longitude: 1.01 });
    expect(preview.places.map((p) => (p.source === "google" ? p.placeId : p.name))).toEqual([
      "favorite",
      "automatic",
      "Our garden",
    ]);
    expect(JSON.stringify(preview)).not.toMatch(
      /Private road|curationRevision|hidden|profileRevision/,
    );
    expect(preview.places[0]).toMatchObject({ favorite: true, note: "Our favorite" });
  });
  it("suppresses every destination when location is private or invalid", () => {
    for (const patch of [
      { geoPublic: false },
      { mapDisplayMode: "hidden" as const },
      { latitude: null },
      { longitude: 181 },
    ])
      expect(projectNearbyPreview({ ...location, ...patch }, 2, curation, discovery)).toEqual({
        location: null,
        places: [],
      });
  });
  it("keeps stale exclusions but pauses saved recommendations until reconfirmed", () => {
    const view = projectNearbyPreview(
      location,
      2,
      { ...curation, savedProfileRevision: 1 },
      discovery,
    );
    expect(view.places).toEqual([
      {
        source: "google",
        placeId: "automatic",
        category: "activities",
        favorite: false,
        note: null,
      },
    ]);
    expect(
      projectNearbyPreview(location, 2, curation, { ...discovery, profileRevision: 1 }).places,
    ).toHaveLength(2);
    expect(
      projectNearbyPreview(location, 2, { ...curation, savedProfileRevision: 1 }, null).places,
    ).toEqual([]);
  });
  it("allows useful automatic output without curation and custom output without Google", () => {
    expect(
      projectNearbyPreview(
        location,
        2,
        { ...curation, choices: [], customPlaces: [], savedProfileRevision: null },
        discovery,
      ).places,
    ).toHaveLength(2);
    expect(projectNearbyPreview(location, 2, curation, null).places).toHaveLength(2);
  });
  it("validates responses and discards provider text at the client boundary", () => {
    expect(parseNearbyCurationState(curation)).toEqual(curation);
    expect(() =>
      parseNearbyCurationState({ ...curation, savedProfileRevision: undefined }),
    ).toThrow();
    expect(
      parseNearbyDiscoveryState({
        ...discovery,
        places: [{ placeId: "safe", category: "nature", name: "Do not copy" }],
      }).places,
    ).toEqual([{ placeId: "safe", category: "nature" }]);
    for (const patch of [
      { status: "empty" },
      { profileRevision: 0 },
      { retryAfter: "bad" },
      { places: [discovery.places[0], discovery.places[0]] },
    ])
      expect(() => parseNearbyDiscoveryState({ ...discovery, ...patch })).toThrow();
  });
});
