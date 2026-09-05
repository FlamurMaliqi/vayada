import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropertyProfileLocation } from "@vayada/domain-hotels";
import {
  discoverGoogleNearby,
  nearbySearchOrigin,
  NEARBY_SEARCH_POLICY,
} from "./googleNearbyPlaces.js";
const location: PropertyProfileLocation = {
  streetAddress: null,
  postalCode: null,
  city: null,
  countryCode: null,
  timezone: null,
  latitude: -8.654321,
  longitude: 115.14321,
  localityPublic: true,
  geoPublic: true,
  mapDisplayMode: "approximate",
};
const origin = { latitude: 0, longitude: 0 };
afterEach(() => vi.useRealTimers());
describe("Google nearby boundary", () => {
  it("uses only the existing public precision and suppresses private/missing origins", () => {
    expect(nearbySearchOrigin(location)).toEqual({ latitude: -8.65, longitude: 115.14 });
    expect(nearbySearchOrigin({ ...location, latitude: -1.125, longitude: 1.005 })).toEqual({
      latitude: -1.13,
      longitude: 1.01,
    });
    expect(nearbySearchOrigin({ ...location, mapDisplayMode: "exact" })).toEqual({
      latitude: -8.654321,
      longitude: 115.14321,
    });
    for (const patch of [
      { geoPublic: false },
      { mapDisplayMode: "hidden" as const },
      { latitude: null },
      { longitude: Infinity },
      { latitude: 91 },
      { longitude: -181 },
    ]) {
      expect(nearbySearchOrigin({ ...location, ...patch })).toBeNull();
    }
  });
  it("makes no calls for absent configuration or origin", async () => {
    const fetch = vi.fn();
    expect((await discoverGoogleNearby({ origin, apiKey: "", fetch })).status).toBe(
      "not_configured",
    );
    expect((await discoverGoogleNearby({ origin: null, apiKey: "test", fetch })).status).toBe(
      "location_required",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses four bounded policy requests, deduplicates IDs and drops provider content/lodging", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({
        places: [
          {
            id: "shared",
            location: origin,
            types: body.includedTypes,
            displayName: "restricted name",
          },
          { id: `valid_${body.includedTypes[0]}`, location: origin, types: body.includedTypes },
          { id: "competitor", location: origin, types: [...body.includedTypes, "resort_hotel"] },
          { id: "broken", location: { latitude: NaN, longitude: 0 }, types: body.includedTypes },
        ],
      });
    });
    const result = await discoverGoogleNearby({ origin, apiKey: "test-only", fetch });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(result.places.map((p) => p.placeId)).toEqual([
      "shared",
      "valid_beach",
      "valid_restaurant",
      "valid_tourist_attraction",
      "valid_airport",
    ]);
    expect(result.places[0].category).toBe("nature");
    expect(JSON.stringify(result)).not.toMatch(/restricted name|competitor|broken|test-only/);
    fetch.mock.calls.forEach(([url, init], i) => {
      expect(url).toBe("https://places.googleapis.com/v1/places:searchNearby");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({
        "X-Goog-FieldMask": "places.id,places.location,places.types",
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({
        maxResultCount: 10,
        rankPreference: "DISTANCE",
        includedTypes: NEARBY_SEARCH_POLICY[i].types,
        locationRestriction: { circle: { center: origin, radius: NEARBY_SEARCH_POLICY[i].radius } },
      });
    });
  });
  it("distinguishes empty, malformed, quota and provider failures without reflecting messages", async () => {
    for (const [response, status] of [
      [Response.json({}), "empty"],
      [Response.json({ places: "bad" }), "invalid_response"],
      [new Response("secret", { status: 429 }), "quota_exhausted"],
      [new Response("secret", { status: 403 }), "provider_unavailable"],
    ] as const) {
      const result = await discoverGoogleNearby({
        origin,
        apiKey: "test",
        fetch: vi.fn(async () => response.clone()),
      });
      expect(result).toEqual({ status, places: [] });
    }
  });
  it("times out every call after five seconds without retries", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("private diagnostic")));
        }),
    );
    const pending = discoverGoogleNearby({ origin, apiKey: "test", fetch });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ status: "timeout", places: [] });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
