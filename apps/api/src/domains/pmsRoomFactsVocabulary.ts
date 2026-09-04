import type { RoomFactsVocabularyValidationPort } from "@vayada/domain-pms";

const ROOM_CATEGORIES = new Set([
  "standard",
  "deluxe",
  "superior",
  "suite",
  "villa",
  "bungalow",
  "studio",
  "penthouse",
]);
const BED_TYPES = new Set(["king", "queen", "double", "twin", "single", "bunk_bed", "sofa_bed"]);

export function createPmsRoomFactsVocabularyValidationPort(): RoomFactsVocabularyValidationPort {
  return Object.freeze({
    async validateRoomFactsVocabulary({ category, bedTypeKeys }) {
      const unsupportedCategoryKeys = category && !ROOM_CATEGORIES.has(category) ? [category] : [];
      const unsupportedBedTypeKeys = [...new Set(bedTypeKeys.filter((key) => !BED_TYPES.has(key)))];
      return unsupportedCategoryKeys.length === 0 && unsupportedBedTypeKeys.length === 0
        ? { ok: true as const }
        : {
            ok: false as const,
            error: {
              code: "unsupported_room_fact_keys" as const,
              unsupportedCategoryKeys,
              unsupportedBedTypeKeys,
            },
          };
    },
  });
}
