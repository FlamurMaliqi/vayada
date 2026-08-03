import { describe, expect, it, vi } from "vitest";

import {
  LEGACY_MARKETPLACE_PREFERENCE_DRAFT_FIELDS,
  transformLegacyOffersToMarketplacePreferenceDraft,
} from "./legacyHotelCollaborationPreferenceDraft.js";

const OFFER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OFFER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPTION_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OPTION_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OPTION_C = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function offers() {
  return [
    {
      offerId: OFFER_B.toUpperCase(),
      updatedAt: "2026-08-02T12:00:00Z",
      compensationOptions: [
        {
          compensationOptionId: OPTION_C,
          compensationType: "affiliate",
          availabilityMonths: ["December", "January"],
          platforms: ["YouTube", "instagram"],
        },
      ],
    },
    {
      offerId: OFFER_A,
      updatedAt: "2026-08-01T12:00:00.000Z",
      compensationOptions: [
        {
          compensationOptionId: OPTION_B,
          compensationType: "paid",
          availabilityMonths: ["June"],
          platforms: ["tiktok"],
        },
        {
          compensationOptionId: OPTION_A,
          compensationType: "free_stay",
          availabilityMonths: ["January"],
          platforms: ["instagram"],
        },
      ],
    },
  ];
}

describe("legacy Marketplace preference draft transform", () => {
  it("produces a deterministic canonical-order partial draft with provenance", () => {
    const candidate = transformLegacyOffersToMarketplacePreferenceDraft(offers());
    expect(candidate).toEqual({
      contractVersion: "legacy-marketplace-preference-draft.v1",
      stepId: "marketplace_preferences",
      draftOnly: true,
      canonicalWriteAllowed: false,
      payload: {
        "marketplace.preferences.compensation_types": ["free_stay", "paid", "affiliate"],
        "marketplace.preferences.content_platforms": ["instagram", "tiktok", "youtube"],
        "marketplace.preferences.availability": {
          mode: "selected_months",
          selectedMonths: [1, 6, 12],
        },
      },
      suggestedFields: [
        "marketplace.preferences.compensation_types",
        "marketplace.preferences.content_platforms",
        "marketplace.preferences.availability",
      ],
      unansweredFields: ["marketplace.preferences.content_types"],
      provenance: {
        source: "marketplace.offer_compensation_options",
        sources: [
          {
            offerId: OFFER_A,
            updatedAt: "2026-08-01T12:00:00.000Z",
            compensationOptionIds: [OPTION_A, OPTION_B],
          },
          {
            offerId: OFFER_B,
            updatedAt: "2026-08-02T12:00:00.000Z",
            compensationOptionIds: [OPTION_C],
          },
        ],
        warnings: [],
      },
    });
    expect(transformLegacyOffersToMarketplacePreferenceDraft([...offers()].reverse())).toEqual(
      candidate,
    );
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate?.payload)).toBe(true);
    expect("readiness" in (candidate ?? {})).toBe(false);
  });

  it("never turns empty/default months into a year-round answer", () => {
    const evidence = offers().slice(0, 1);
    evidence[0]!.compensationOptions[0]!.availabilityMonths = [];
    const candidate = transformLegacyOffersToMarketplacePreferenceDraft(evidence)!;
    expect(candidate.payload).not.toHaveProperty("marketplace.preferences.availability");
    expect(candidate.unansweredFields).toContain("marketplace.preferences.availability");
    expect(JSON.stringify(candidate)).not.toContain("year_round");
  });

  it("keeps content types unanswered because compensation options do not prove them", () => {
    const candidate = transformLegacyOffersToMarketplacePreferenceDraft(offers())!;
    expect(candidate.payload).not.toHaveProperty("marketplace.preferences.content_types");
    expect(candidate.unansweredFields).toContain("marketplace.preferences.content_types");
  });

  it("retains unknown legacy values as deterministic provenance warnings", () => {
    const evidence = offers().slice(0, 1);
    evidence[0]!.compensationOptions[0] = {
      ...evidence[0]!.compensationOptions[0]!,
      compensationType: "barter",
      availabilityMonths: ["Whenever"],
      platforms: ["Threads"],
    };
    const candidate = transformLegacyOffersToMarketplacePreferenceDraft(evidence)!;
    expect(candidate.payload).toEqual({});
    expect(candidate.suggestedFields).toEqual([]);
    expect(candidate.unansweredFields).toEqual(LEGACY_MARKETPLACE_PREFERENCE_DRAFT_FIELDS);
    expect(candidate.provenance.warnings).toEqual([
      {
        code: "unknown_compensation_type",
        offerId: OFFER_B,
        compensationOptionId: OPTION_C,
        value: "barter",
      },
      {
        code: "unknown_month",
        offerId: OFFER_B,
        compensationOptionId: OPTION_C,
        value: "Whenever",
      },
      {
        code: "unknown_platform",
        offerId: OFFER_B,
        compensationOptionId: OPTION_C,
        value: "Threads",
      },
    ]);
  });

  it("returns no candidate without retained offers", () => {
    expect(transformLegacyOffersToMarketplacePreferenceDraft([])).toBeNull();
  });

  it("normalizes explicit offsets without accepting local or impossible timestamps", () => {
    const offsetEvidence = offers().slice(0, 1);
    offsetEvidence[0]!.updatedAt = "2026-08-03T12:00:00+02:00";
    expect(
      transformLegacyOffersToMarketplacePreferenceDraft(offsetEvidence)?.provenance.sources[0]
        ?.updatedAt,
    ).toBe("2026-08-03T10:00:00.000Z");

    for (const updatedAt of ["08/03/2026", "2026-08-03T12:00:00", "2026-02-30T00:00:00Z"]) {
      const malformed = offers().slice(0, 1);
      malformed[0]!.updatedAt = updatedAt;
      expect(() => transformLegacyOffersToMarketplacePreferenceDraft(malformed)).toThrow(
        /offer evidence is malformed/i,
      );
    }
  });

  it("rejects duplicate source identities instead of merging ambiguous provenance", () => {
    expect(() =>
      transformLegacyOffersToMarketplacePreferenceDraft([offers()[0]!, offers()[0]!]),
    ).toThrow(/duplicate legacy offer id/i);
    const duplicateOption = offers();
    duplicateOption[1]!.compensationOptions[0] = {
      ...duplicateOption[1]!.compensationOptions[0]!,
      compensationOptionId: OPTION_C,
    };
    expect(() => transformLegacyOffersToMarketplacePreferenceDraft(duplicateOption)).toThrow(
      /duplicate legacy compensation option id/i,
    );
  });

  it("rejects accessors, sparse arrays, subclasses, and changing proxies", () => {
    const getter = vi.fn(() => offers()[0]!.compensationOptions);
    const accessor = { ...offers()[0]! };
    Object.defineProperty(accessor, "compensationOptions", { enumerable: true, get: getter });
    expect(() => transformLegacyOffersToMarketplacePreferenceDraft([accessor])).toThrow(
      /offer evidence is malformed/i,
    );
    expect(getter).not.toHaveBeenCalled();

    const sparse = offers();
    sparse[0]!.compensationOptions[0]!.platforms = Array(1);
    expect(() => transformLegacyOffersToMarketplacePreferenceDraft(sparse)).toThrow(
      /compensation evidence is malformed/i,
    );

    class HostilePlatforms extends Array<string> {}
    const subclass = offers();
    const platforms = new HostilePlatforms();
    platforms.push("Threads");
    subclass[0]!.compensationOptions[0]!.platforms = platforms;
    expect(() => transformLegacyOffersToMarketplacePreferenceDraft(subclass)).toThrow(
      /compensation evidence is malformed/i,
    );

    const changing = offers();
    changing[0]!.compensationOptions[0]!.availabilityMonths = new Proxy(["Not a month"], {
      get(target, key, receiver) {
        if (key === Symbol.iterator)
          return function* () {
            yield "January";
          };
        return Reflect.get(target, key, receiver);
      },
    });
    expect(
      transformLegacyOffersToMarketplacePreferenceDraft(changing)?.provenance.warnings,
    ).toContainEqual(expect.objectContaining({ code: "unknown_month", value: "Not a month" }));
  });
});
