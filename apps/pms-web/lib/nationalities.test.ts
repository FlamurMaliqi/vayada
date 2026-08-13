import { describe, expect, it } from "vitest";

import {
  NATIONALITY_OPTIONS,
  nationalityDisplayLabel,
  nationalityInputLabel,
  nationalityLabel,
  normalizeNationalityCode,
} from "./nationalities";

describe("nationalities", () => {
  it("exposes ISO countries, Kosovo, and the two operational edge cases", () => {
    expect(NATIONALITY_OPTIONS).toHaveLength(252);
    expect(new Set(NATIONALITY_OPTIONS.map(({ code }) => code)).size).toBe(252);
    expect(nationalityLabel("NL")).toBe("Netherlands");
    expect(nationalityLabel("XS")).toBe("Stateless");
    expect(nationalityLabel("XX")).toBe("Unknown");
  });

  it.each([
    ["nl", "NL"],
    ["Netherlands", "NL"],
    ["Holland", "NL"],
    ["Dutch", "NL"],
    ["USA", "US"],
    ["America", "US"],
    ["Côte d’Ivoire", "CI"],
    ["Stateless", "XS"],
    ["Unknown nationality", "XX"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeNationalityCode(input)).toBe(expected);
  });

  it("rejects arbitrary free text", () => {
    expect(normalizeNationalityCode("Netherlandish")).toBeNull();
    expect(normalizeNationalityCode("ZZ")).toBeNull();
    expect(normalizeNationalityCode(" ")).toBeNull();
  });

  it("keeps non-standard imported values visible for correction", () => {
    expect(nationalityInputLabel("ZZ")).toBe("ZZ");
    expect(nationalityDisplayLabel("ZZ")).toBe("ZZ · Needs review");
    expect(nationalityDisplayLabel("Holland")).toBe("Netherlands");
  });
});
