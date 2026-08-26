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

const PMS_ROOM_AMENITY_PUBLIC_PRIORITY_V1 = [
  "wifi",
  "air_conditioning",
  "flat_screen_tv",
  "balcony",
  "kitchen",
  "non_smoking",
  "heating",
  "blackout_curtains",
  "bathrobe",
  "slippers",
  "extra_pillows",
  "wardrobe",
  "clothes_rack",
  "bathtub",
  "shower",
  "hairdryer",
  "free_toiletries",
  "towels",
  "minibar",
  "refrigerator",
  "microwave",
  "electric_kettle",
  "kitchenware",
  "work_desk",
  "laptop_friendly_workspace",
] as const;

const PMS_ROOM_AMENITY_PUBLIC_PRIORITY_KEY_SET_V1 = new Set<string>(
  PMS_ROOM_AMENITY_PUBLIC_PRIORITY_V1,
);

const PMS_ROOM_AMENITY_PUBLIC_ORDER_V1 = Object.freeze([
  ...PMS_ROOM_AMENITY_PUBLIC_PRIORITY_V1,
  ...PMS_ROOM_AMENITY_KEY_STRINGS_V1.filter(
    (key) => !PMS_ROOM_AMENITY_PUBLIC_PRIORITY_KEY_SET_V1.has(key),
  ),
]);

const PMS_ROOM_AMENITY_PUBLIC_LABEL_OVERRIDES_V1: Readonly<Record<string, string>> = Object.freeze({
  flat_screen_tv: "Flat-screen TV",
  in_room_safe: "In-room safe",
  laptop_friendly_workspace: "Laptop-friendly workspace",
  non_smoking: "Non-smoking",
  smart_tv: "Smart TV",
  tv: "TV",
  wifi: "Wi-Fi",
});

export function toPublicPmsRoomAmenityLabelsV1(amenities: readonly string[]): string[] {
  const uniqueAmenities = [...new Set(amenities)];
  const selectedKeys = new Set(
    uniqueAmenities.filter((key) => PMS_ROOM_AMENITY_KEY_SET_V1.has(key)),
  );
  return [
    ...PMS_ROOM_AMENITY_PUBLIC_ORDER_V1.filter((key) => selectedKeys.has(key)).map(
      publicRoomAmenityLabel,
    ),
    ...uniqueAmenities.filter((amenity) => !PMS_ROOM_AMENITY_KEY_SET_V1.has(amenity)),
  ];
}

function publicRoomAmenityLabel(key: string): string {
  return (
    PMS_ROOM_AMENITY_PUBLIC_LABEL_OVERRIDES_V1[key] ??
    `${key.charAt(0).toUpperCase()}${key.slice(1).replaceAll("_", " ")}`
  );
}

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
