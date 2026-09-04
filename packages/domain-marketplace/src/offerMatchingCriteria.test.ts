import { describe, expect, it } from "vitest";

import {
  MARKETPLACE_OFFER_MATCHING_CRITERIA_CONTRACT_VERSION,
  parseMarketplaceOfferMatchingCriteria,
  parseMarketplaceOfferMatchingCriteriaWrite,
  type MarketplaceOfferMatchingCriteriaWrite,
} from "./offerMatchingCriteria.js";

function criteria(): MarketplaceOfferMatchingCriteriaWrite {
  return {
    primaryCampaignGoal: "ugc_asset_creation",
    availability: {
      requirementLevel: "required",
      flexibility: "flexible",
      startsOn: "2026-10-01",
      endsOn: "2026-10-31",
      blackouts: [{ startsOn: "2026-10-10", endsOn: "2026-10-12" }],
    },
    contentCategories: { requirementLevel: "required", values: ["travel"] },
    contentStyles: { requirementLevel: "preferred", values: ["cinematic"] },
    usageRights: {
      channels: ["organic_social", "website"],
      duration: { mode: "fixed", days: 365 },
    },
    includedRevisionRounds: 2,
    expectedEffortHours: { minimum: 6, maximum: 10 },
    expectedCompensationValue: { amount: "900.00", currency: "EUR" },
    applicationCapacity: { acceptingApplications: true, maximumActiveApplications: 20 },
  };
}

describe("Marketplace offer matching criteria", () => {
  it("parses the complete approved v1 document and read metadata", () => {
    const write = parseMarketplaceOfferMatchingCriteriaWrite(criteria());
    expect(write).toEqual(criteria());

    expect(
      parseMarketplaceOfferMatchingCriteria({
        ...criteria(),
        contractVersion: MARKETPLACE_OFFER_MATCHING_CRITERIA_CONTRACT_VERSION,
        revision: 2,
        updatedAt: "2026-09-03T00:00:00.000Z",
      }),
    ).toMatchObject({ revision: 2, primaryCampaignGoal: "ugc_asset_creation" });
  });

  it.each([
    ["missing key", (({ usageRights: _ignored, ...value }) => value)(criteria())],
    [
      "invalid date",
      { ...criteria(), availability: { ...criteria().availability!, startsOn: "2026-13-01" } },
    ],
    [
      "overlapping blackout",
      {
        ...criteria(),
        availability: {
          ...criteria().availability!,
          blackouts: [
            { startsOn: "2026-10-10", endsOn: "2026-10-12" },
            { startsOn: "2026-10-12", endsOn: "2026-10-13" },
          ],
        },
      },
    ],
    ["reversed effort", { ...criteria(), expectedEffortHours: { minimum: 12, maximum: 6 } }],
    [
      "capacity on a paused offer",
      {
        ...criteria(),
        applicationCapacity: { acceptingApplications: false, maximumActiveApplications: 2 },
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(parseMarketplaceOfferMatchingCriteriaWrite(value)).toBeNull();
  });

  it("keeps unknown criteria explicit instead of inventing defaults", () => {
    const unknown = Object.fromEntries(Object.keys(criteria()).map((key) => [key, null]));
    expect(parseMarketplaceOfferMatchingCriteriaWrite(unknown)).toEqual(unknown);
  });
});
