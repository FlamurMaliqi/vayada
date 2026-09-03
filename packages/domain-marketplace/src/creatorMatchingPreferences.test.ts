import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_CREATOR_MATCHING_PREFERENCES_CONTRACT_VERSION,
  parseMarketplaceCreatorMatchingPreferences,
  parseMarketplaceCreatorMatchingPreferencesWrite,
} from "./creatorMatchingPreferences.js";

const write = {
  contentCategories: { mode: "selected", values: ["travel", "wellness"] },
  deliverableTypes: { mode: "selected", values: ["reel", "story"] },
  compensationTypes: { mode: "selected", values: ["free_stay", "paid"] },
  collaborationGoals: { mode: "selected", values: ["ugc_creation"] },
  travel: {
    mode: "planned_trips",
    flexibilityDaysBefore: 3,
    flexibilityDaysAfter: 5,
  },
} as const;

describe("Marketplace creator matching preferences", () => {
  it("parses approved declared preferences", () => {
    expect(parseMarketplaceCreatorMatchingPreferencesWrite(write)).toEqual(write);
    expect(
      parseMarketplaceCreatorMatchingPreferences({
        ...write,
        contractVersion: MARKETPLACE_CREATOR_MATCHING_PREFERENCES_CONTRACT_VERSION,
        evidenceSource: "creator_declared",
        revision: 2,
        updatedAt: "2026-09-03T01:00:00.000Z",
      }),
    ).toMatchObject({ revision: 2, evidenceSource: "creator_declared" });
  });

  it("distinguishes intentionally unset fields from explicit no preference", () => {
    const value = parseMarketplaceCreatorMatchingPreferencesWrite({
      contentCategories: null,
      deliverableTypes: { mode: "no_preference" },
      compensationTypes: null,
      collaborationGoals: { mode: "no_preference" },
      travel: null,
    });

    expect(value?.contentCategories).toBeNull();
    expect(value?.deliverableTypes).toEqual({ mode: "no_preference" });
  });

  it.each([
    { ...write, compensationTypes: { mode: "selected", values: ["crypto"] } },
    { ...write, deliverableTypes: { mode: "selected", values: [] } },
    { ...write, contentCategories: { mode: "selected", values: ["Travel"] } },
    {
      ...write,
      travel: { mode: "planned_trips", flexibilityDaysBefore: -1, flexibilityDaysAfter: 0 },
    },
    { ...write, providerAudience: { countries: ["DE"] } },
  ])("rejects invalid or provider-derived input %#", (value) => {
    expect(parseMarketplaceCreatorMatchingPreferencesWrite(value)).toBeNull();
  });
});
