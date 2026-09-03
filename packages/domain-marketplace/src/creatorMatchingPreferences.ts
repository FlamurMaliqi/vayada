export const MARKETPLACE_CREATOR_MATCHING_PREFERENCES_CONTRACT_VERSION =
  "marketplace-creator-matching-preferences.v1" as const;

export const MARKETPLACE_CREATOR_MATCHING_COMPENSATION_TYPES = [
  "free_stay",
  "paid",
  "discount",
  "affiliate",
] as const;

export const MARKETPLACE_CREATOR_COLLABORATION_GOALS = [
  "audience_distribution",
  "ugc_creation",
  "affiliate_work",
  "other",
] as const;

export const MARKETPLACE_CREATOR_CONTENT_CATEGORIES = [
  "travel",
  "lifestyle",
  "food_drink",
  "wellness_fitness",
  "adventure_outdoors",
  "family",
  "luxury",
  "fashion_beauty",
  "business_events",
  "other",
] as const;

export type MarketplaceCreatorMatchingCompensationType =
  (typeof MARKETPLACE_CREATOR_MATCHING_COMPENSATION_TYPES)[number];
export type MarketplaceCreatorCollaborationGoal =
  (typeof MARKETPLACE_CREATOR_COLLABORATION_GOALS)[number];
export type MarketplaceCreatorContentCategory =
  (typeof MARKETPLACE_CREATOR_CONTENT_CATEGORIES)[number];

export type MarketplaceCreatorCodePreference<T extends string = string> =
  | { readonly mode: "no_preference" }
  | { readonly mode: "selected"; readonly values: readonly T[] };

export type MarketplaceCreatorTravelPreference =
  | { readonly mode: "no_preference" }
  | {
      readonly mode: "planned_trips";
      readonly flexibilityDaysBefore: number;
      readonly flexibilityDaysAfter: number;
    };

export type MarketplaceCreatorMatchingPreferencesWrite = {
  readonly contentCategories: MarketplaceCreatorCodePreference | null;
  readonly deliverableTypes: MarketplaceCreatorCodePreference | null;
  readonly compensationTypes: MarketplaceCreatorCodePreference<MarketplaceCreatorMatchingCompensationType> | null;
  readonly collaborationGoals: MarketplaceCreatorCodePreference<MarketplaceCreatorCollaborationGoal> | null;
  readonly travel: MarketplaceCreatorTravelPreference | null;
};

export type MarketplaceCreatorMatchingPreferences = MarketplaceCreatorMatchingPreferencesWrite & {
  readonly contractVersion: typeof MARKETPLACE_CREATOR_MATCHING_PREFERENCES_CONTRACT_VERSION;
  readonly evidenceSource: "creator_declared";
  readonly revision: number;
  readonly updatedAt: string;
};

const WRITE_KEYS = [
  "contentCategories",
  "deliverableTypes",
  "compensationTypes",
  "collaborationGoals",
  "travel",
] as const;
const CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export function parseMarketplaceCreatorMatchingPreferencesWrite(
  value: unknown,
): MarketplaceCreatorMatchingPreferencesWrite | null {
  if (!exactRecord(value, WRITE_KEYS)) return null;

  const contentCategories = parseCodePreference(value.contentCategories);
  const deliverableTypes = parseCodePreference(value.deliverableTypes);
  const compensationTypes = parseCodePreference(
    value.compensationTypes,
    MARKETPLACE_CREATOR_MATCHING_COMPENSATION_TYPES,
  );
  const collaborationGoals = parseCodePreference(
    value.collaborationGoals,
    MARKETPLACE_CREATOR_COLLABORATION_GOALS,
  );
  const travel = parseTravelPreference(value.travel);
  if (
    (value.contentCategories !== null && !contentCategories) ||
    (value.deliverableTypes !== null && !deliverableTypes) ||
    (value.compensationTypes !== null && !compensationTypes) ||
    (value.collaborationGoals !== null && !collaborationGoals) ||
    (value.travel !== null && !travel)
  ) {
    return null;
  }

  return {
    contentCategories,
    deliverableTypes,
    compensationTypes,
    collaborationGoals,
    travel,
  };
}

export function parseMarketplaceCreatorMatchingPreferences(
  value: unknown,
): MarketplaceCreatorMatchingPreferences | null {
  if (!isRecord(value)) return null;
  const write = parseMarketplaceCreatorMatchingPreferencesWrite(
    Object.fromEntries(WRITE_KEYS.map((key) => [key, value[key]])),
  );
  if (
    !write ||
    !exactKeys(value, [
      ...WRITE_KEYS,
      "contractVersion",
      "evidenceSource",
      "revision",
      "updatedAt",
    ]) ||
    value.contractVersion !== MARKETPLACE_CREATOR_MATCHING_PREFERENCES_CONTRACT_VERSION ||
    value.evidenceSource !== "creator_declared" ||
    !Number.isInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return null;
  }
  return {
    ...write,
    contractVersion: value.contractVersion,
    evidenceSource: value.evidenceSource,
    revision: value.revision as number,
    updatedAt: value.updatedAt,
  };
}

function parseCodePreference<T extends string>(
  value: unknown,
  allowed?: readonly T[],
): MarketplaceCreatorCodePreference<T> | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  if (exactKeys(value, ["mode"]) && value.mode === "no_preference") {
    return { mode: "no_preference" };
  }
  if (
    !exactKeys(value, ["mode", "values"]) ||
    value.mode !== "selected" ||
    !codes(value.values) ||
    (allowed && value.values.some((item) => !allowed.includes(item as T)))
  ) {
    return null;
  }
  return { mode: "selected", values: value.values as T[] };
}

function parseTravelPreference(value: unknown): MarketplaceCreatorTravelPreference | null {
  if (value === null) return null;
  if (!isRecord(value)) return null;
  if (exactKeys(value, ["mode"]) && value.mode === "no_preference") {
    return { mode: "no_preference" };
  }
  if (
    !exactKeys(value, ["mode", "flexibilityDaysBefore", "flexibilityDaysAfter"]) ||
    value.mode !== "planned_trips" ||
    !flexibilityDays(value.flexibilityDaysBefore) ||
    !flexibilityDays(value.flexibilityDaysAfter)
  ) {
    return null;
  }
  return {
    mode: "planned_trips",
    flexibilityDaysBefore: value.flexibilityDaysBefore,
    flexibilityDaysAfter: value.flexibilityDaysAfter,
  };
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

function flexibilityDays(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 365;
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
