import { describe, expect, it } from "vitest";

import {
  SETUP_TRACK_COMPONENT_PRODUCTS,
  SETUP_TRACKS,
  isSetupTrack,
  parseUpdateTracksRequest,
  type UpdateTracksRequest,
} from "./adaptiveHotelSetup.js";

describe("adaptive hotel setup contracts", () => {
  it("exposes only the two owner-facing setup tracks", () => {
    expect(SETUP_TRACKS).toEqual(["hotel_operations", "creator_marketplace"]);
    expect(isSetupTrack("hotel_operations")).toBe(true);
    expect(isSetupTrack("creator_marketplace")).toBe(true);
  });

  it.each(["pms", "booking", "marketplace", "unknown", null, undefined])(
    "rejects component product name %s as a setup track",
    (value) => {
      expect(isSetupTrack(value)).toBe(false);
    },
  );

  it("maps Hotel Operations to PMS and Booking as one bundle", () => {
    expect(SETUP_TRACK_COMPONENT_PRODUCTS).toEqual({
      hotel_operations: ["pms", "booking"],
      creator_marketplace: ["marketplace"],
    });
  });

  it("parses and canonicalizes an update request", () => {
    const request = parseUpdateTracksRequest({
      selectedTracks: ["creator_marketplace", "hotel_operations"],
      expectedRevision: 0,
    });

    expect(request).toEqual({
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      expectedRevision: 0,
    } satisfies UpdateTracksRequest);
  });

  it.each([
    null,
    {},
    { selectedTracks: [], expectedRevision: 0 },
    { selectedTracks: ["hotel_operations", "hotel_operations"], expectedRevision: 0 },
    { selectedTracks: ["booking"], expectedRevision: 0 },
    { selectedTracks: ["hotel_operations"], expectedRevision: -1 },
    { selectedTracks: ["hotel_operations"], expectedRevision: 0.5 },
    { selectedTracks: ["hotel_operations"], expectedRevision: 2_147_483_647 },
    { selectedTracks: ["hotel_operations"], expectedRevision: "0" },
  ])("rejects an invalid update request: %j", (value) => {
    expect(parseUpdateTracksRequest(value)).toBeNull();
  });

  it("rejects sparse setup-track arrays", () => {
    const selectedTracks: unknown[] = [];
    selectedTracks.length = 1;

    expect(parseUpdateTracksRequest({ selectedTracks, expectedRevision: 0 })).toBeNull();
  });
});
