import { describe, expect, it } from "vitest";
import {
  ADDON_OWNERSHIP_VALUES,
  parseAddonEconomicTerms,
  type AddonEconomicTerms,
} from "./bookingAddonEconomics.js";

describe("booking add-on economics", () => {
  it("publishes stable ownership values", () => {
    expect(ADDON_OWNERSHIP_VALUES).toEqual(["property", "partner"]);
  });

  it("accepts canonical property and partner terms", () => {
    expect(parseAddonEconomicTerms({ ownershipKind: "property" })).toEqual({
      ownershipKind: "property",
      partnerCommissionRate: null,
    });
    for (const rate of ["0", "0.0001", "25.125", "99.9999", "100.0000"]) {
      expect(
        parseAddonEconomicTerms({ ownershipKind: "partner", partnerCommissionRate: rate }),
      ).toEqual({ ownershipKind: "partner", partnerCommissionRate: rate });
    }
  });

  it("rejects invalid rates and ownership/rate pairs", () => {
    for (const rate of [null, -1, "-1", "01", ".5", "1.", "1.00000", "100.0001", "101"]) {
      expect(
        parseAddonEconomicTerms({ ownershipKind: "partner", partnerCommissionRate: rate }),
      ).toBeNull();
    }
    expect(
      parseAddonEconomicTerms({ ownershipKind: "property", partnerCommissionRate: "10" }),
    ).toBeNull();
    expect(parseAddonEconomicTerms({ ownershipKind: "provider" })).toBeNull();
  });

  it("makes invalid ownership/rate pairs unrepresentable to typed producers", () => {
    const valid = [
      { ownershipKind: "property", partnerCommissionRate: null },
      { ownershipKind: "partner", partnerCommissionRate: "15" },
    ] satisfies AddonEconomicTerms[];
    // @ts-expect-error Property-owned add-ons cannot carry a partner commission.
    const propertyWithRate: AddonEconomicTerms = {
      ownershipKind: "property",
      partnerCommissionRate: "15",
    };
    // @ts-expect-error Partner add-ons require a commission rate.
    const partnerWithoutRate: AddonEconomicTerms = {
      ownershipKind: "partner",
      partnerCommissionRate: null,
    };

    expect([valid, propertyWithRate, partnerWithoutRate]).toHaveLength(3);
  });
});
