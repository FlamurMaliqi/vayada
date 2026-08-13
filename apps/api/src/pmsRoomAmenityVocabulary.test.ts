import { parsePmsRoomAmenityKey, type PmsRoomAmenityKey } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import {
  PMS_ROOM_AMENITY_KEYS_V1,
  createPmsRoomAmenityVocabularyValidationPort,
  toPublicPmsRoomAmenityLabelsV1,
} from "./domains/pmsRoomAmenityVocabulary.js";

function key(value: string): PmsRoomAmenityKey {
  const parsed = parsePmsRoomAmenityKey(value);
  if (!parsed) throw new Error(`Test key is syntactically invalid: ${value}`);
  return parsed;
}

describe("PMS room amenity vocabulary", () => {
  const vocabulary = createPmsRoomAmenityVocabularyValidationPort();

  it("accepts every explicit V1 room choice", async () => {
    expect(Object.isFrozen(PMS_ROOM_AMENITY_KEYS_V1)).toBe(true);
    expect(PMS_ROOM_AMENITY_KEYS_V1).toEqual([...PMS_ROOM_AMENITY_KEYS_V1].sort());
    expect(new Set(PMS_ROOM_AMENITY_KEYS_V1).size).toBe(PMS_ROOM_AMENITY_KEYS_V1.length);
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("wifi"));
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("air_conditioning"));
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("tv"));
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("balcony"));
    expect(PMS_ROOM_AMENITY_KEYS_V1).toContain(key("kitchen"));

    for (const supported of PMS_ROOM_AMENITY_KEYS_V1) {
      await expect(vocabulary.validateRoomAmenities([supported])).resolves.toEqual({ ok: true });
    }
    await expect(vocabulary.validateRoomAmenities(PMS_ROOM_AMENITY_KEYS_V1)).resolves.toEqual({
      ok: true,
    });
  });

  it("reports unsupported keys once in deterministic code-unit order", async () => {
    const input = Object.freeze([
      key("unknown_z"),
      key("wifi"),
      key("unknown_a"),
      key("unknown_z"),
    ]);
    const before = [...input];

    const result = await vocabulary.validateRoomAmenities(input);

    expect(result).toEqual({
      ok: false,
      error: {
        code: "unsupported_room_amenity_keys",
        unsupportedAmenityKeys: ["unknown_a", "unknown_z"],
      },
    });
    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(true);
    expect(result.ok || Object.isFrozen(result.error.unsupportedAmenityKeys)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("publishes stable guest-facing labels instead of sorted internal keys", () => {
    expect(toPublicPmsRoomAmenityLabelsV1(["balcony", "wifi", "air_conditioning"])).toEqual([
      "Wi-Fi",
      "Air conditioning",
      "Balcony",
    ]);
  });

  it.each([
    ["bathroom type", ["private_bathroom", "shared_bathroom"]],
    ["bed configuration", ["king_bed", "queen_bed", "sofa_bed"]],
    ["room category and size", ["room_category", "room_size"]],
    ["deferred room features", ["room_features", "mountain_view", "private_entrance"]],
    [
      "property facilities",
      [
        "breakfast",
        "concierge",
        "fitness_center",
        "front_desk_24h",
        "parking",
        "restaurant",
        "room_service",
        "spa",
        "swimming_pool",
      ],
    ],
  ])("rejects %s as room amenities", async (_category, values) => {
    const excluded = values.map(key);
    await expect(vocabulary.validateRoomAmenities(excluded)).resolves.toEqual({
      ok: false,
      error: {
        code: "unsupported_room_amenity_keys",
        unsupportedAmenityKeys: [...excluded].sort(),
      },
    });
  });
});
