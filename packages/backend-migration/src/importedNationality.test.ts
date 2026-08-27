import { describe, expect, it } from "vitest";

import { importedNationalityMap } from "./importedNationality.js";

describe("imported nationality normalization", () => {
  it("maps shared codes, country names, and aliases while preserving unmatched source text", () => {
    expect(
      importedNationalityMap([" nl ", "Holland", "Cote d'Ivoire", "Atlantis", "  ", null]),
    ).toEqual({
      sourceValues: [" nl ", "Holland", "Cote d'Ivoire", "Atlantis", "  "],
      countryCodes: ["NL", "NL", "CI", null, null],
      rawValues: [null, null, null, "Atlantis", null],
      reviewRequired: [false, false, false, true, false],
    });
  });

  it("deduplicates exact source values without conflating distinct imported evidence", () => {
    expect(importedNationalityMap(["Holland", "Holland", "holland"]).sourceValues).toEqual([
      "Holland",
      "holland",
    ]);
  });
});
