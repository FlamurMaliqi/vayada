export const FINANCE_OTA_CHANNELS = [
  "booking_com",
  "airbnb",
  "expedia",
  "agoda",
  "other_ota",
] as const;

export type FinanceOtaChannel = (typeof FINANCE_OTA_CHANNELS)[number];
declare const financeOtaCommissionRateBrand: unique symbol;
export type FinanceOtaCommissionRate = string & {
  readonly [financeOtaCommissionRateBrand]: true;
};

export type FinanceOtaCommissionRule = {
  ruleId: string;
  propertyId: string;
  channel: FinanceOtaChannel;
  percentageRate: FinanceOtaCommissionRate;
  effectiveFrom: string;
  effectiveTo: string | null;
  revision: number;
};

export type FinanceOtaCommissionRuleResolution =
  | { status: "applied"; rule: FinanceOtaCommissionRule }
  | {
      status: "missing";
      propertyId: string;
      channel: FinanceOtaChannel;
      effectiveAt: string;
      reason: "not_configured";
    };

const OTA_COMMISSION_RATE = /^(?:0|[1-9]\d?)(?:\.\d{1,4})?$|^100(?:\.0{1,4})?$/u;

export function normalizeFinanceOtaCommissionRate(value: string): FinanceOtaCommissionRate | null {
  if (!OTA_COMMISSION_RATE.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}` as FinanceOtaCommissionRate;
}

export function resolveFinanceOtaCommissionRule(
  rules: readonly FinanceOtaCommissionRule[],
  input: { propertyId: string; channel: FinanceOtaChannel; effectiveAt: string },
): FinanceOtaCommissionRuleResolution {
  const effectiveAt = timestamp(input.effectiveAt);
  const matches = rules.filter((rule) => {
    if (rule.propertyId !== input.propertyId || rule.channel !== input.channel) return false;
    const effectiveFrom = timestamp(rule.effectiveFrom);
    const effectiveTo = rule.effectiveTo === null ? null : timestamp(rule.effectiveTo);
    if (
      normalizeFinanceOtaCommissionRate(rule.percentageRate) !== rule.percentageRate ||
      !Number.isInteger(rule.revision) ||
      rule.revision < 1 ||
      (effectiveTo !== null && effectiveFrom >= effectiveTo)
    ) {
      throw new Error("Invalid OTA commission rule evidence");
    }
    return effectiveFrom <= effectiveAt && (effectiveTo === null || effectiveAt < effectiveTo);
  });
  if (matches.length > 1) throw new Error("Overlapping OTA commission rule evidence");
  return matches[0]
    ? { status: "applied", rule: matches[0] }
    : { status: "missing", ...input, reason: "not_configured" };
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid OTA commission rule timestamp");
  return parsed;
}
