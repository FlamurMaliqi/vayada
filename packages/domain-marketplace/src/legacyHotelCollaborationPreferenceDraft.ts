import {
  MARKETPLACE_PREFERENCE_COMPENSATION_TYPES,
  MARKETPLACE_PREFERENCE_CONTENT_PLATFORMS,
  type MarketplacePreferenceCompensationType,
  type MarketplacePreferenceContentPlatform,
} from "./hotelCollaborationPreferences.js";

export const LEGACY_MARKETPLACE_PREFERENCE_DRAFT_TRANSFORM_VERSION =
  "legacy-marketplace-preference-draft.v1" as const;

export const LEGACY_MARKETPLACE_PREFERENCE_DRAFT_FIELDS = Object.freeze([
  "marketplace.preferences.compensation_types",
  "marketplace.preferences.content_platforms",
  "marketplace.preferences.content_types",
  "marketplace.preferences.availability",
] as const);

export type LegacyMarketplaceOfferPreferenceEvidence = {
  readonly offerId: string;
  readonly updatedAt: string;
  readonly compensationOptions: readonly {
    readonly compensationOptionId: string;
    readonly compensationType: string;
    readonly availabilityMonths: readonly string[];
    readonly platforms: readonly string[];
  }[];
};

type LegacyMarketplacePreferenceDraftField =
  (typeof LEGACY_MARKETPLACE_PREFERENCE_DRAFT_FIELDS)[number];
type LegacyMarketplacePreferenceDraftPayload = Readonly<
  Partial<{
    "marketplace.preferences.compensation_types": readonly MarketplacePreferenceCompensationType[];
    "marketplace.preferences.content_platforms": readonly MarketplacePreferenceContentPlatform[];
    "marketplace.preferences.availability": {
      readonly mode: "selected_months";
      readonly selectedMonths: readonly number[];
    };
  }>
>;

export type LegacyMarketplacePreferenceDraftWarning = {
  readonly code: "unknown_compensation_type" | "unknown_platform" | "unknown_month";
  readonly offerId: string;
  readonly compensationOptionId: string;
  readonly value: string;
};

export type LegacyMarketplacePreferenceDraftCandidate = {
  readonly contractVersion: typeof LEGACY_MARKETPLACE_PREFERENCE_DRAFT_TRANSFORM_VERSION;
  readonly stepId: "marketplace_preferences";
  readonly draftOnly: true;
  readonly canonicalWriteAllowed: false;
  readonly payload: LegacyMarketplacePreferenceDraftPayload;
  readonly suggestedFields: readonly LegacyMarketplacePreferenceDraftField[];
  readonly unansweredFields: readonly LegacyMarketplacePreferenceDraftField[];
  readonly provenance: {
    readonly source: "marketplace.offer_compensation_options";
    readonly sources: readonly {
      readonly offerId: string;
      readonly updatedAt: string;
      readonly compensationOptionIds: readonly string[];
    }[];
    readonly warnings: readonly LegacyMarketplacePreferenceDraftWarning[];
  };
};

/**
 * Produces presentation-only draft suggestions from retained offer evidence.
 * Consumers may copy suggestions into an authorized onboarding draft, but this
 * pure transform is never a canonical preference write or readiness result.
 */
export function transformLegacyOffersToMarketplacePreferenceDraft(
  evidence: readonly LegacyMarketplaceOfferPreferenceEvidence[],
): LegacyMarketplacePreferenceDraftCandidate | null {
  const sourceEvidence = snapshotDataArray(evidence);
  if (!sourceEvidence) throw new TypeError("Legacy Marketplace offer evidence is malformed");
  if (sourceEvidence.length === 0) return null;
  const offers = sourceEvidence
    .map(parseOffer)
    .sort((left, right) => compareText(left.offerId, right.offerId));
  assertUnique(
    offers.map(({ offerId }) => offerId),
    "offer ID",
  );
  assertUnique(
    offers.flatMap(({ compensationOptions }) =>
      compensationOptions.map(({ compensationOptionId }) => compensationOptionId),
    ),
    "compensation option ID",
  );

  const compensationTypes = new Set<MarketplacePreferenceCompensationType>();
  const contentPlatforms = new Set<MarketplacePreferenceContentPlatform>();
  const selectedMonths = new Set<number>();
  const warnings: LegacyMarketplacePreferenceDraftWarning[] = [];

  for (const offer of offers) {
    for (const option of offer.compensationOptions) {
      collectCompensation(option, offer.offerId, compensationTypes, warnings);
      collectPlatforms(option, offer.offerId, contentPlatforms, warnings);
      collectMonths(option, offer.offerId, selectedMonths, warnings);
    }
  }

  const payload: Record<string, unknown> = {};
  if (compensationTypes.size > 0) {
    payload[LEGACY_MARKETPLACE_PREFERENCE_DRAFT_FIELDS[0]] =
      MARKETPLACE_PREFERENCE_COMPENSATION_TYPES.filter((value) => compensationTypes.has(value));
  }
  if (contentPlatforms.size > 0) {
    payload[LEGACY_MARKETPLACE_PREFERENCE_DRAFT_FIELDS[1]] =
      MARKETPLACE_PREFERENCE_CONTENT_PLATFORMS.filter((value) => contentPlatforms.has(value));
  }
  if (selectedMonths.size > 0) {
    payload[LEGACY_MARKETPLACE_PREFERENCE_DRAFT_FIELDS[3]] = {
      mode: "selected_months",
      selectedMonths: [...selectedMonths].sort((left, right) => left - right),
    };
  }
  const suggestedFields = LEGACY_MARKETPLACE_PREFERENCE_DRAFT_FIELDS.filter((field) =>
    Object.hasOwn(payload, field),
  );
  const unansweredFields = LEGACY_MARKETPLACE_PREFERENCE_DRAFT_FIELDS.filter(
    (field) => !Object.hasOwn(payload, field),
  );

  return deepFreeze({
    contractVersion: LEGACY_MARKETPLACE_PREFERENCE_DRAFT_TRANSFORM_VERSION,
    stepId: "marketplace_preferences",
    draftOnly: true,
    canonicalWriteAllowed: false,
    payload: payload as LegacyMarketplacePreferenceDraftPayload,
    suggestedFields,
    unansweredFields,
    provenance: {
      source: "marketplace.offer_compensation_options",
      sources: offers.map(({ offerId, updatedAt, compensationOptions }) => ({
        offerId,
        updatedAt,
        compensationOptionIds: compensationOptions.map(
          ({ compensationOptionId }) => compensationOptionId,
        ),
      })),
      warnings: warnings.sort(compareWarnings),
    },
  });
}

type ParsedOffer = ReturnType<typeof parseOffer>;
type ParsedOption = ParsedOffer["compensationOptions"][number];

function parseOffer(value: unknown) {
  const evidence = snapshotDataRecord(value, ["offerId", "updatedAt", "compensationOptions"]);
  const offerId = normalizeUuid(evidence?.offerId);
  const updatedAt = normalizeTimestamp(evidence?.updatedAt);
  const sourceOptions = snapshotDataArray(evidence?.compensationOptions);
  if (!offerId || !updatedAt || !sourceOptions) {
    throw new TypeError("Legacy Marketplace offer evidence is malformed");
  }
  const compensationOptions = sourceOptions
    .map((value) => {
      const option = snapshotDataRecord(value, [
        "compensationOptionId",
        "compensationType",
        "availabilityMonths",
        "platforms",
      ]);
      const compensationOptionId = normalizeUuid(option?.compensationOptionId);
      const availabilityMonths = snapshotStringArray(option?.availabilityMonths);
      const platforms = snapshotStringArray(option?.platforms);
      if (
        !compensationOptionId ||
        typeof option?.compensationType !== "string" ||
        !availabilityMonths ||
        !platforms
      )
        throw new TypeError("Legacy Marketplace compensation evidence is malformed");
      return {
        compensationOptionId,
        compensationType: option.compensationType,
        availabilityMonths,
        platforms,
      };
    })
    .sort((left, right) => compareText(left.compensationOptionId, right.compensationOptionId));
  return { offerId, updatedAt, compensationOptions };
}

function collectCompensation(
  option: ParsedOption,
  offerId: string,
  result: Set<MarketplacePreferenceCompensationType>,
  warnings: LegacyMarketplacePreferenceDraftWarning[],
): void {
  if (
    MARKETPLACE_PREFERENCE_COMPENSATION_TYPES.includes(
      option.compensationType as MarketplacePreferenceCompensationType,
    )
  ) {
    result.add(option.compensationType as MarketplacePreferenceCompensationType);
  } else {
    warnings.push(warning("unknown_compensation_type", offerId, option, option.compensationType));
  }
}

function collectPlatforms(
  option: ParsedOption,
  offerId: string,
  result: Set<MarketplacePreferenceContentPlatform>,
  warnings: LegacyMarketplacePreferenceDraftWarning[],
): void {
  for (const value of option.platforms) {
    const normalized = value.toLowerCase();
    if (
      MARKETPLACE_PREFERENCE_CONTENT_PLATFORMS.includes(
        normalized as MarketplacePreferenceContentPlatform,
      )
    ) {
      result.add(normalized as MarketplacePreferenceContentPlatform);
    } else {
      warnings.push(warning("unknown_platform", offerId, option, value));
    }
  }
}

function collectMonths(
  option: ParsedOption,
  offerId: string,
  result: Set<number>,
  warnings: LegacyMarketplacePreferenceDraftWarning[],
): void {
  for (const value of option.availabilityMonths) {
    const month = MONTHS.indexOf(value.trim().toLowerCase()) + 1;
    if (month > 0) result.add(month);
    else warnings.push(warning("unknown_month", offerId, option, value));
  }
}

function warning(
  code: LegacyMarketplacePreferenceDraftWarning["code"],
  offerId: string,
  option: ParsedOption,
  value: string,
): LegacyMarketplacePreferenceDraftWarning {
  return { code, offerId, compensationOptionId: option.compensationOptionId, value };
}

function compareWarnings(
  left: LegacyMarketplacePreferenceDraftWarning,
  right: LegacyMarketplacePreferenceDraftWarning,
): number {
  return compareText(JSON.stringify(left), JSON.stringify(right));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`Duplicate legacy ${label}`);
}

function snapshotStringArray(value: unknown): string[] | null {
  const values = snapshotDataArray(value);
  return values?.every((item) => typeof item === "string") ? (values as string[]) : null;
}

function snapshotDataArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const descriptorMap = descriptors as unknown as Record<string, PropertyDescriptor>;
  const length = descriptorMap.length?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    Reflect.ownKeys(descriptors).length !== length + 1 ||
    !Array.from(
      { length },
      (_unused, index) => descriptorMap[String(index)] && "value" in descriptorMap[String(index)]!,
    ).every(Boolean)
  )
    return null;
  return Array.from({ length }, (_unused, index) => descriptorMap[String(index)]!.value);
}

function snapshotDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    !ownKeys.every((key) => typeof key === "string" && keys.includes(key)) ||
    !keys.every((key) => Object.hasOwn(descriptors, key) && "value" in descriptors[key]!)
  )
    return null;
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function normalizeUuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = STRICT_TIMESTAMP.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match;
  if (!yearText || !monthText || !dayText || !hourText || !minuteText || !secondText || !zone)
    return null;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    !year ||
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  )
    return null;
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, Number((fraction ?? "").padEnd(3, "0")));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  )
    return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const MONTHS: readonly string[] = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const STRICT_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
