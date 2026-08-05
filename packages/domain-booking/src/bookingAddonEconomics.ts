export const ADDON_OWNERSHIP_VALUES = Object.freeze(["property", "partner"] as const);

export type AddonOwnership = (typeof ADDON_OWNERSHIP_VALUES)[number];

export type AddonEconomicTerms =
  | { ownershipKind: "property"; partnerCommissionRate: null }
  | { ownershipKind: "partner"; partnerCommissionRate: string };

const PARTNER_COMMISSION_RATE = /^(?:100(?:\.0{1,4})?|(?:0|[1-9]\d?)(?:\.\d{1,4})?)$/u;

export function parseAddonEconomicTerms(value: unknown): AddonEconomicTerms | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const input = value as Record<string, unknown>;
  const ownershipKind = input["ownershipKind"];
  const partnerCommissionRate = input["partnerCommissionRate"];

  if (ownershipKind === "property") {
    return partnerCommissionRate == null ? { ownershipKind, partnerCommissionRate: null } : null;
  }

  if (
    ownershipKind === "partner" &&
    typeof partnerCommissionRate === "string" &&
    PARTNER_COMMISSION_RATE.test(partnerCommissionRate)
  ) {
    return { ownershipKind, partnerCommissionRate };
  }

  return null;
}
