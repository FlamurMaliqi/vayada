import {
  parsePmsRoomAmenityKey,
  type PmsRoomAmenityKey,
  type RoomAmenityVocabularyValidationPort,
} from "@vayada/domain-pms";

const PMS_ROOM_AMENITY_KEY_STRINGS_V1 = [
  "air_conditioning",
  "balcony",
  "bathrobe",
  "bathtub",
  "bed_linen",
  "blackout_curtains",
  "clothes_rack",
  "dining_table",
  "dryer",
  "electric_kettle",
  "extra_pillows",
  "fan",
  "fire_extinguisher",
  "fireplace",
  "first_aid_kit",
  "flat_screen_tv",
  "free_toiletries",
  "hairdryer",
  "heating",
  "hot_tub",
  "in_room_safe",
  "iron_and_ironing_board",
  "kitchen",
  "kitchenware",
  "laptop_friendly_workspace",
  "microwave",
  "minibar",
  "non_smoking",
  "refrigerator",
  "shower",
  "slippers",
  "smart_tv",
  "smoke_detector",
  "stovetop",
  "streaming_services",
  "toilet",
  "toilet_paper",
  "towels",
  "tv",
  "wardrobe",
  "washing_machine",
  "wifi",
  "work_desk",
] as const;

/**
 * PMS-owned V1 room choices. Property facilities, room facts, and deferred
 * room features intentionally do not belong to this membership set.
 */
export const PMS_ROOM_AMENITY_KEYS_V1: readonly PmsRoomAmenityKey[] = Object.freeze(
  PMS_ROOM_AMENITY_KEY_STRINGS_V1.map((key) => {
    const parsed = parsePmsRoomAmenityKey(key);
    if (!parsed) throw new Error(`Invalid PMS room amenity key: ${key}`);
    return parsed;
  }),
);

const PMS_ROOM_AMENITY_KEY_SET_V1 = new Set<string>(PMS_ROOM_AMENITY_KEYS_V1);

export function createPmsRoomAmenityVocabularyValidationPort(): RoomAmenityVocabularyValidationPort {
  return Object.freeze({
    async validateRoomAmenities(amenities) {
      const unsupportedAmenityKeys = Object.freeze(
        [...new Set(amenities.filter((key) => !PMS_ROOM_AMENITY_KEY_SET_V1.has(key)))].sort(),
      );
      return unsupportedAmenityKeys.length === 0
        ? Object.freeze({ ok: true as const })
        : Object.freeze({
            ok: false as const,
            error: Object.freeze({
              code: "unsupported_room_amenity_keys" as const,
              unsupportedAmenityKeys,
            }),
          });
    },
  });
}
