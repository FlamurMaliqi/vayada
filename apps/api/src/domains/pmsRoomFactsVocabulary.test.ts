import { parseRoomTypeFacts } from "@vayada/domain-pms";
import { describe, expect, it } from "vitest";

import { createPmsRoomFactsVocabularyValidationPort } from "./pmsRoomFactsVocabulary.js";

describe("PMS room-facts vocabulary", () => {
  const vocabulary = createPmsRoomFactsVocabularyValidationPort();

  it("accepts the canonical adaptive room setup keys", async () => {
    await expect(
      vocabulary.validateRoomFactsVocabulary(
        vocabularyInput("suite", ["king", "bunk_bed", "sofa_bed"]),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("returns every unsupported category and unique bed key", async () => {
    const input = vocabularyInput("tree_house", ["hammock", "cot"]);
    await expect(
      vocabulary.validateRoomFactsVocabulary({
        ...input,
        bedTypeKeys: [input.bedTypeKeys[0]!, input.bedTypeKeys[0]!, input.bedTypeKeys[1]!],
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "unsupported_room_fact_keys",
        unsupportedCategoryKeys: ["tree_house"],
        unsupportedBedTypeKeys: ["hammock", "cot"],
      },
    });
  });
});

function vocabularyInput(category: string, bedTypeKeys: string[]) {
  const facts = parseRoomTypeFacts({
    name: "Vocabulary test room",
    description: "",
    category,
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
    beds: bedTypeKeys.map((type) => ({ type, quantity: 1 })),
    bedrooms: 1,
    bathrooms: 1,
    bathroomType: "private",
    size: null,
  });
  if (!facts) throw new Error("Expected syntactically valid room facts");
  return {
    category: facts.category,
    bedTypeKeys: facts.beds.map(({ type }) => type),
  };
}
