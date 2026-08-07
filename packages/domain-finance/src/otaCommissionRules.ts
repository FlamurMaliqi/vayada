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
const OFFSET_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

export function normalizeFinanceOtaCommissionRate(value: string): FinanceOtaCommissionRate | null {
  if (!OTA_COMMISSION_RATE.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}` as FinanceOtaCommissionRate;
}

export function normalizeFinanceOtaCommissionInstant(value: string): string | null {
  try {
    return new Date(timestamp(value)).toISOString();
  } catch {
    return null;
  }
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
  const match = OFFSET_INSTANT.exec(value);
  const invalid = () => new Error("Invalid OTA commission rule timestamp");
  if (!match) throw invalid();
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const wall = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0")}Z`,
  );
  if (!Number.isFinite(wall.getTime()) || wall.toISOString().slice(0, 19) !== value.slice(0, 19))
    throw invalid();
  const [offsetHour, offsetMinute] = zone === "Z" ? [0, 0] : zone.slice(1).split(":").map(Number);
  if (offsetHour! > 23 || offsetMinute! > 59) throw invalid();
  return (
    wall.getTime() - (zone?.startsWith("-") ? -1 : 1) * (offsetHour! * 60 + offsetMinute!) * 60_000
  );
}
