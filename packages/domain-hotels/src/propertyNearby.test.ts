import { describe, expect, it } from "vitest";
import {
  checkNearbyCurationWrite,
  parseNearbyCurationWrite,
  type NearbyCurationWrite,
  type NearbyCurationState,
} from "./propertyNearby.js";

const custom = {
  id: "a0000000-0000-4000-8000-000000000001",
  category: "nature" as const,
  name: " Beach ",
  address: null,
  latitude: 0,
  longitude: 0,
  hidden: false,
  favorite: false,
  note: null,
};
const choice = {
  placeId: "google_place",
  category: "food" as const,
  hidden: false,
  favorite: false,
  added: false,
  note: null,
};
const request = (): NearbyCurationWrite => ({
  schemaVersion: 1,
  expectedProfileRevision: 3,
  expectedCurationRevision: 0,
  choices: [{ ...choice }],
  customPlaces: [{ ...custom }],
});
const state = (): NearbyCurationState => ({
  schemaVersion: 1,
  profileRevision: 3,
  curationRevision: 0,
  savedProfileRevision: null,
  choices: [],
  customPlaces: [],
});

describe("nearby curation trust boundary", () => {
  it("accepts address-only curation and snapshots independent hotel content", () => {
    expect(parseNearbyCurationWrite({ ...request(), choices: [], customPlaces: [] }).ok).toBe(true);
    const input = request();
    const parsed = parseNearbyCurationWrite(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("valid request rejected");
    input.customPlaces[0].name = "changed";
    expect(parsed.value.customPlaces[0].name).toBe("Beach");
    expect(parsed.value.customPlaces[0].latitude).toBe(0);
    expect(parsed.value.choices[0].favorite).toBe(false);
  });
  it.each([NaN, Infinity, 91, -91, "0", null])("rejects invalid latitude %s", (latitude) => {
    expect(
      parseNearbyCurationWrite({ ...request(), customPlaces: [{ ...custom, latitude }] }).ok,
    ).toBe(false);
  });
  it.each([181, -181, Infinity, "0"])("rejects invalid longitude %s", (longitude) => {
    expect(
      parseNearbyCurationWrite({ ...request(), customPlaces: [{ ...custom, longitude }] }).ok,
    ).toBe(false);
  });
  it("rejects unknown fields, contradictory controls, markup and invalid categories", () => {
    for (const patch of [
      { hidden: true, favorite: true },
      { category: "hotel" },
      { note: "<script>alert(1)</script>" },
      { note: "x".repeat(501) },
      { name: "   " },
      { id: "not-a-uuid" },
      { latitude: undefined },
      { providerName: "copied" },
    ]) {
      expect(
        parseNearbyCurationWrite({ ...request(), customPlaces: [{ ...custom, ...patch }] }).ok,
      ).toBe(false);
    }
    expect(parseNearbyCurationWrite({ ...request(), organizationId: "other" }).ok).toBe(false);
    expect(
      parseNearbyCurationWrite({
        ...request(),
        choices: [{ ...choice, hidden: true, favorite: true }],
      }).ok,
    ).toBe(false);
  });
  it("rejects duplicate references, including UUID case aliases, and bounds additions", () => {
    expect(parseNearbyCurationWrite({ ...request(), choices: [choice, choice] }).ok).toBe(false);
    expect(
      parseNearbyCurationWrite({
        ...request(),
        customPlaces: [custom, { ...custom, id: custom.id.toUpperCase() }],
      }).ok,
    ).toBe(false);
    expect(
      parseNearbyCurationWrite({
        ...request(),
        choices: Array.from({ length: 20 }, (_, i) => ({
          ...choice,
          placeId: `id_${i}`,
          added: true,
        })),
      }).ok,
    ).toBe(false);
    expect(
      parseNearbyCurationWrite({
        ...request(),
        choices: Array.from({ length: 101 }, (_, i) => ({ ...choice, placeId: `id_${i}` })),
      }).ok,
    ).toBe(false);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, NaN, "3"])(
    "rejects revision %s",
    (expectedProfileRevision) => {
      expect(parseNearbyCurationWrite({ ...request(), expectedProfileRevision }).ok).toBe(false);
      expect(
        parseNearbyCurationWrite({
          ...request(),
          expectedCurationRevision: expectedProfileRevision,
        }).ok,
      ).toBe(false);
    },
  );
  it("enforces UTF-8 payload size even when each field is within its character limit", () => {
    const result = parseNearbyCurationWrite({
      ...request(),
      choices: Array.from({ length: 100 }, (_, i) => ({
        ...choice,
        placeId: `id_${i}`,
        note: "海".repeat(500),
      })),
    });
    expect(result).toEqual({ ok: false, code: "payload_too_large" });
  });
  it("checks both revisions before accepting property-scoped provider references", () => {
    expect(checkNearbyCurationWrite(request(), state(), new Set([choice.placeId]))).toBeNull();
    expect(checkNearbyCurationWrite(request(), { ...state(), profileRevision: 4 }, new Set())).toBe(
      "revision_conflict",
    );
    expect(
      checkNearbyCurationWrite(request(), { ...state(), curationRevision: 1 }, new Set()),
    ).toBe("revision_conflict");
    expect(
      checkNearbyCurationWrite(request(), { ...state(), choices: [choice] }, new Set()),
    ).toBeNull();
  });
  it("rejects fabricated IDs even when first submitted as hidden, not added", () => {
    for (const flags of [{ hidden: true, added: false }, { favorite: true }, { added: true }]) {
      expect(
        checkNearbyCurationWrite(
          { ...request(), choices: [{ ...choice, ...flags }] },
          state(),
          new Set(["other_property_place"]),
        ),
      ).toBe("unknown_place");
    }
    expect(checkNearbyCurationWrite({ ...request(), choices: [] }, state(), new Set())).toBeNull();
  });
});
