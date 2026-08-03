import { describe, expect, it } from "vitest";

import {
  PMS_ROOM_AMENITIES_CONTRACT_VERSION,
  parseConfirmRoomTypeAmenitiesCommand,
  parseConfirmRoomTypeAmenitiesResult,
  parseRoomAmenitiesSnapshot,
  serializeConfirmRoomTypeAmenitiesFingerprint,
} from "./roomAmenities.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const actorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function command(amenities: string[] = ["wifi", "air_conditioning"]) {
  return {
    organizationId,
    propertyId,
    roomTypeId,
    expectedRoomAmenitiesRevision: 3,
    amenities,
    idempotencyKey: "amenities-command",
    audit: {
      actor: { kind: "user", userId: actorId },
      requestId: "request-1",
      correlationId: null,
      requestedAt: "2026-08-03T08:00:00.000Z",
    },
  };
}

describe("room amenities contract", () => {
  it("canonicalizes a reviewed amenity set and rejects duplicates", () => {
    const source = command(["wifi", "air_conditioning"]);
    const parsed = parseConfirmRoomTypeAmenitiesCommand(source);
    expect(parsed?.amenities).toEqual(["air_conditioning", "wifi"]);
    expect(Object.isFrozen(parsed?.amenities)).toBe(true);
    source.amenities[0] = "mutated";
    expect(parsed?.amenities).toEqual(["air_conditioning", "wifi"]);

    expect(parseConfirmRoomTypeAmenitiesCommand(command(["wifi", "wifi"]))).toBeNull();
    expect(parseConfirmRoomTypeAmenitiesCommand(command(["WiFi"]))).toBeNull();
  });

  it("makes set ordering irrelevant to the command fingerprint", () => {
    const first = parseConfirmRoomTypeAmenitiesCommand(command(["wifi", "air_conditioning"]));
    const second = parseConfirmRoomTypeAmenitiesCommand(command(["air_conditioning", "wifi"]));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(serializeConfirmRoomTypeAmenitiesFingerprint(first!)).toBe(
      serializeConfirmRoomTypeAmenitiesFingerprint(second!),
    );
  });

  it("distinguishes untouched empty from reviewed empty", () => {
    expect(
      parseRoomAmenitiesSnapshot({
        contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomAmenitiesRevision: 1,
        reviewed: false,
        amenities: [],
        reviewedAt: null,
      }),
    ).toMatchObject({ reviewed: false, amenities: [] });

    const reviewed = parseRoomAmenitiesSnapshot({
      contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomAmenitiesRevision: 2,
      reviewed: true,
      amenities: [],
      reviewedAt: "2026-08-03T08:00:00.000Z",
    });
    expect(reviewed).toMatchObject({ reviewed: true, amenities: [] });
    expect(
      parseRoomAmenitiesSnapshot({
        contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomAmenitiesRevision: 1,
        reviewed: true,
        amenities: [],
        reviewedAt: "2026-08-03T08:00:00.000Z",
      }),
    ).toBeNull();
    expect(
      parseRoomAmenitiesSnapshot({
        contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
        propertyId,
        roomTypeId,
        roomAmenitiesRevision: 1,
        reviewed: false,
        amenities: ["wifi"],
        reviewedAt: null,
      }),
    ).toMatchObject({ reviewed: false, amenities: ["wifi"] });
  });

  it("strictly parses reviewed-empty results and safe errors", () => {
    expect(
      parseConfirmRoomTypeAmenitiesResult({
        ok: true,
        response: {
          contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
          outcome: "confirmed",
          roomAmenities: {
            contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
            propertyId,
            roomTypeId,
            roomAmenitiesRevision: 2,
            reviewed: true,
            amenities: [],
            reviewedAt: "2026-08-03T08:00:00.000Z",
          },
          acceptedAt: "2026-08-03T08:00:00.000Z",
        },
      }),
    ).not.toBeNull();
    expect(
      parseConfirmRoomTypeAmenitiesResult({
        ok: false,
        error: {
          code: "unsupported_room_amenity_keys",
          unsupportedAmenityKeys: ["unknown_key"],
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "unsupported_room_amenity_keys",
        unsupportedAmenityKeys: ["unknown_key"],
      },
    });
    expect(
      parseConfirmRoomTypeAmenitiesResult({
        ok: false,
        error: { code: "room_amenities_revision_conflict", currentRevision: 4 },
      }),
    ).not.toBeNull();
  });

  it("rejects extra fields and invalid scope", () => {
    expect(parseConfirmRoomTypeAmenitiesCommand({ ...command(), legacyAmenities: [] })).toBeNull();
    expect(
      parseConfirmRoomTypeAmenitiesCommand({ ...command(), propertyId: "not-a-uuid" }),
    ).toBeNull();
    expect(
      parseConfirmRoomTypeAmenitiesResult({
        ok: false,
        error: { code: "room_type_not_found", privateRoomName: "Suite" },
      }),
    ).toBeNull();
  });
});
