export const MARKETPLACE_OFFER_MATCHING_CRITERIA_CONTRACT_VERSION =
  "marketplace-offer-matching-criteria.v1" as const;

export const MARKETPLACE_OFFER_CAMPAIGN_GOALS = Object.freeze([
  "ugc_asset_creation",
  "awareness",
  "direct_bookings",
  "affiliate_conversion",
  "seasonal_demand",
  "other",
] as const);

export type MarketplaceOfferCampaignGoal = (typeof MARKETPLACE_OFFER_CAMPAIGN_GOALS)[number];
export type MarketplaceOfferRequirementLevel = "required" | "preferred";
export type MarketplaceOfferDateRange = { readonly startsOn: string; readonly endsOn: string };
export type MarketplaceOfferCodeCriterion = {
  readonly requirementLevel: MarketplaceOfferRequirementLevel;
  readonly values: readonly string[];
};

export type MarketplaceOfferMatchingCriteriaWrite = {
  readonly primaryCampaignGoal: MarketplaceOfferCampaignGoal | null;
  readonly availability: {
    readonly requirementLevel: MarketplaceOfferRequirementLevel;
    readonly flexibility: "exact" | "flexible";
    readonly startsOn: string;
    readonly endsOn: string;
    readonly blackouts: readonly MarketplaceOfferDateRange[];
  } | null;
  readonly contentCategories: MarketplaceOfferCodeCriterion | null;
  readonly contentStyles: MarketplaceOfferCodeCriterion | null;
  readonly usageRights: {
    readonly channels: readonly string[];
    readonly duration:
      | { readonly mode: "fixed"; readonly days: number }
      | { readonly mode: "perpetual" };
  } | null;
  readonly includedRevisionRounds: number | null;
  readonly expectedEffortHours: {
    readonly minimum: number;
    readonly maximum: number;
  } | null;
  readonly expectedCompensationValue: {
    readonly amount: string;
    readonly currency: string;
  } | null;
  readonly applicationCapacity: {
    readonly acceptingApplications: boolean;
    readonly maximumActiveApplications: number | null;
  } | null;
};

export type MarketplaceOfferMatchingCriteria = MarketplaceOfferMatchingCriteriaWrite & {
  readonly contractVersion: typeof MARKETPLACE_OFFER_MATCHING_CRITERIA_CONTRACT_VERSION;
  readonly revision: number;
  readonly updatedAt: string;
};

const WRITE_KEYS = [
  "primaryCampaignGoal",
  "availability",
  "contentCategories",
  "contentStyles",
  "usageRights",
  "includedRevisionRounds",
  "expectedEffortHours",
  "expectedCompensationValue",
  "applicationCapacity",
] as const;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseMarketplaceOfferMatchingCriteriaWrite(
  value: unknown,
): MarketplaceOfferMatchingCriteriaWrite | null {
  if (!exactRecord(value, WRITE_KEYS)) return null;
  const primaryCampaignGoal = MARKETPLACE_OFFER_CAMPAIGN_GOALS.find(
    (goal) => goal === value.primaryCampaignGoal,
  );
  if (value.primaryCampaignGoal !== null && !primaryCampaignGoal) return null;

  const availability = parseAvailability(value.availability);
  const contentCategories = parseCodeCriterion(value.contentCategories);
  const contentStyles = parseCodeCriterion(value.contentStyles);
  const usageRights = parseUsageRights(value.usageRights);
  const expectedEffortHours = parseEffort(value.expectedEffortHours);
  const expectedCompensationValue = parseValue(value.expectedCompensationValue);
  const applicationCapacity = parseCapacity(value.applicationCapacity);
  if (
    (value.availability !== null && !availability) ||
    (value.contentCategories !== null && !contentCategories) ||
    (value.contentStyles !== null && !contentStyles) ||
    (value.usageRights !== null && !usageRights) ||
    (value.expectedEffortHours !== null && !expectedEffortHours) ||
    (value.expectedCompensationValue !== null && !expectedCompensationValue) ||
    (value.applicationCapacity !== null && !applicationCapacity) ||
    (value.includedRevisionRounds !== null &&
      (!integer(value.includedRevisionRounds) ||
        value.includedRevisionRounds < 0 ||
        value.includedRevisionRounds > 20))
  ) {
    return null;
  }

  return {
    primaryCampaignGoal: primaryCampaignGoal ?? null,
    availability,
    contentCategories,
    contentStyles,
    usageRights,
    includedRevisionRounds: value.includedRevisionRounds as number | null,
    expectedEffortHours,
    expectedCompensationValue,
    applicationCapacity,
  };
}

export function parseMarketplaceOfferMatchingCriteria(
  value: unknown,
): MarketplaceOfferMatchingCriteria | null {
  if (!isRecord(value)) return null;
  const write = parseMarketplaceOfferMatchingCriteriaWrite(
    Object.fromEntries(WRITE_KEYS.map((key) => [key, value[key]])),
  );
  if (
    !write ||
    !exactKeys(value, [...WRITE_KEYS, "contractVersion", "revision", "updatedAt"]) ||
    value.contractVersion !== MARKETPLACE_OFFER_MATCHING_CRITERIA_CONTRACT_VERSION ||
    !integer(value.revision) ||
    value.revision < 1 ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return null;
  }
  return {
    ...write,
    contractVersion: value.contractVersion,
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
}

function parseAvailability(value: unknown): MarketplaceOfferMatchingCriteriaWrite["availability"] {
  if (value === null) return null;
  if (!exactRecord(value, ["requirementLevel", "flexibility", "startsOn", "endsOn", "blackouts"]))
    return null;
  if (
    !requirementLevel(value.requirementLevel) ||
    !["exact", "flexible"].includes(String(value.flexibility))
  )
    return null;
  if (
    !date(value.startsOn) ||
    !date(value.endsOn) ||
    value.startsOn > value.endsOn ||
    !Array.isArray(value.blackouts)
  )
    return null;
  const startsOn = value.startsOn;
  const endsOn = value.endsOn;
  const blackouts = value.blackouts.map(parseDateRange);
  if (blackouts.some((range) => !range)) return null;
  const ranges = blackouts as MarketplaceOfferDateRange[];
  if (
    ranges.some(
      (range, index) =>
        range.startsOn < startsOn ||
        range.endsOn > endsOn ||
        (index > 0 && range.startsOn <= ranges[index - 1]!.endsOn),
    )
  )
    return null;
  return {
    requirementLevel: value.requirementLevel,
    flexibility: value.flexibility as "exact" | "flexible",
    startsOn,
    endsOn,
    blackouts: ranges,
  };
}

function parseDateRange(value: unknown): MarketplaceOfferDateRange | null {
  return exactRecord(value, ["startsOn", "endsOn"]) &&
    date(value.startsOn) &&
    date(value.endsOn) &&
    value.startsOn <= value.endsOn
    ? { startsOn: value.startsOn, endsOn: value.endsOn }
    : null;
}

function parseCodeCriterion(value: unknown): MarketplaceOfferCodeCriterion | null {
  if (value === null) return null;
  if (
    !exactRecord(value, ["requirementLevel", "values"]) ||
    !requirementLevel(value.requirementLevel) ||
    !codes(value.values)
  )
    return null;
  return { requirementLevel: value.requirementLevel, values: value.values };
}

function parseUsageRights(value: unknown): MarketplaceOfferMatchingCriteriaWrite["usageRights"] {
  if (value === null) return null;
  if (
    !exactRecord(value, ["channels", "duration"]) ||
    !codes(value.channels) ||
    !isRecord(value.duration)
  )
    return null;
  if (exactKeys(value.duration, ["mode"]) && value.duration.mode === "perpetual")
    return { channels: value.channels, duration: { mode: "perpetual" } };
  if (
    exactKeys(value.duration, ["mode", "days"]) &&
    value.duration.mode === "fixed" &&
    integer(value.duration.days) &&
    value.duration.days >= 1 &&
    value.duration.days <= 3650
  )
    return { channels: value.channels, duration: { mode: "fixed", days: value.duration.days } };
  return null;
}

function parseEffort(value: unknown): MarketplaceOfferMatchingCriteriaWrite["expectedEffortHours"] {
  if (value === null) return null;
  if (
    !exactRecord(value, ["minimum", "maximum"]) ||
    !positiveNumber(value.minimum) ||
    !positiveNumber(value.maximum) ||
    value.minimum > value.maximum ||
    value.maximum > 1000
  )
    return null;
  return { minimum: value.minimum, maximum: value.maximum };
}

function parseValue(
  value: unknown,
): MarketplaceOfferMatchingCriteriaWrite["expectedCompensationValue"] {
  if (value === null) return null;
  if (
    !exactRecord(value, ["amount", "currency"]) ||
    typeof value.amount !== "string" ||
    !AMOUNT_PATTERN.test(value.amount) ||
    Number(value.amount) <= 0 ||
    typeof value.currency !== "string" ||
    !/^[A-Z]{3}$/.test(value.currency)
  )
    return null;
  return { amount: value.amount, currency: value.currency };
}

function parseCapacity(
  value: unknown,
): MarketplaceOfferMatchingCriteriaWrite["applicationCapacity"] {
  if (value === null) return null;
  if (
    !exactRecord(value, ["acceptingApplications", "maximumActiveApplications"]) ||
    typeof value.acceptingApplications !== "boolean"
  )
    return null;
  if (
    value.maximumActiveApplications !== null &&
    (!integer(value.maximumActiveApplications) ||
      value.maximumActiveApplications < 1 ||
      value.maximumActiveApplications > 10000)
  )
    return null;
  if (!value.acceptingApplications && value.maximumActiveApplications !== null) return null;
  return {
    acceptingApplications: value.acceptingApplications,
    maximumActiveApplications: value.maximumActiveApplications as number | null,
  };
}

function date(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  try {
    return new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value);
  } catch {
    return false;
  }
}
function codes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 20 &&
    value.every((item) => typeof item === "string" && CODE_PATTERN.test(item)) &&
    new Set(value).size === value.length
  );
}
function requirementLevel(value: unknown): value is MarketplaceOfferRequirementLevel {
  return value === "required" || value === "preferred";
}
function integer(value: unknown): value is number {
  return Number.isInteger(value);
}
function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactRecord<const T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], unknown> {
  return isRecord(value) && exactKeys(value, keys);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
