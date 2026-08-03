export const MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION =
  "marketplace-hotel-collaboration-preferences.v1" as const;
export const MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_EVIDENCE_VERSION =
  "marketplace-hotel-collaboration-preferences-evidence.v1" as const;

export const MARKETPLACE_PREFERENCE_COMPENSATION_TYPES = Object.freeze([
  "free_stay",
  "paid",
  "discount",
  "affiliate",
] as const);
export const MARKETPLACE_PREFERENCE_CONTENT_PLATFORMS = Object.freeze([
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "blog",
  "x",
  "other",
] as const);
export const MARKETPLACE_PREFERENCE_CONTENT_TYPES = Object.freeze([
  "post",
  "story",
  "short_form_video",
  "long_form_video",
  "photography",
  "other",
] as const);
export const MARKETPLACE_PREFERENCE_AVAILABILITY_MODES = Object.freeze([
  "year_round",
  "selected_months",
] as const);

export type MarketplacePreferenceCompensationType =
  (typeof MARKETPLACE_PREFERENCE_COMPENSATION_TYPES)[number];
export type MarketplacePreferenceContentPlatform =
  (typeof MARKETPLACE_PREFERENCE_CONTENT_PLATFORMS)[number];
export type MarketplacePreferenceContentType =
  (typeof MARKETPLACE_PREFERENCE_CONTENT_TYPES)[number];
export type MarketplacePreferenceAvailability =
  | { readonly mode: "year_round"; readonly selectedMonths: readonly [] }
  | { readonly mode: "selected_months"; readonly selectedMonths: readonly number[] };

declare const marketplacePreferenceRevisionBrand: unique symbol;
declare const marketplacePreferenceSourceRevisionBrand: unique symbol;
export type MarketplaceHotelCollaborationPreferencesRevision = number & {
  readonly [marketplacePreferenceRevisionBrand]: true;
};
export type MarketplaceHotelCollaborationPreferencesSourceRevision = `preferences:${number}` & {
  readonly [marketplacePreferenceSourceRevisionBrand]: true;
};

export type ReplaceMarketplaceHotelCollaborationPreferencesRequest = {
  readonly expectedRevision: number;
  readonly compensationTypes: readonly MarketplacePreferenceCompensationType[];
  readonly contentPlatforms: readonly MarketplacePreferenceContentPlatform[];
  readonly contentTypes: readonly MarketplacePreferenceContentType[];
  readonly availability: MarketplacePreferenceAvailability;
};

export type MarketplaceHotelCollaborationPreferences = Omit<
  ReplaceMarketplaceHotelCollaborationPreferencesRequest,
  "expectedRevision"
>;

type MarketplacePreferenceEvidenceBase = {
  readonly contractVersion: typeof MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_EVIDENCE_VERSION;
  readonly product: "marketplace";
  readonly groupId: "marketplace.collaboration_preferences";
  readonly owningStepId: "marketplace_preferences";
};
type MarketplacePreferenceSource<TRevision extends string> = {
  readonly ownerDomain: "marketplace";
  readonly entityType: "hotel_collaboration_preferences";
  readonly entityId: string;
  readonly revision: TRevision;
};
type MarketplacePreferenceOmissionCode =
  | "compensation_types_unanswered"
  | "content_platforms_unanswered"
  | "content_types_unanswered"
  | "availability_unanswered";
type MarketplacePreferenceOmission = {
  readonly kind: "user_fixable";
  readonly code: MarketplacePreferenceOmissionCode;
  readonly message: string;
};

export type MarketplaceHotelCollaborationPreferencesMissingEvidence =
  MarketplacePreferenceEvidenceBase & {
    readonly source: MarketplacePreferenceSource<"preferences:0">;
    readonly status: "blocked";
    readonly omissions: readonly MarketplacePreferenceOmission[];
  };
export type MarketplaceHotelCollaborationPreferencesReadyEvidence =
  MarketplacePreferenceEvidenceBase & {
    readonly source: MarketplacePreferenceSource<MarketplaceHotelCollaborationPreferencesSourceRevision>;
    readonly status: "ready";
    readonly omissions: readonly [];
  };
export type MarketplaceHotelCollaborationPreferencesEvidence =
  | MarketplaceHotelCollaborationPreferencesMissingEvidence
  | MarketplaceHotelCollaborationPreferencesReadyEvidence;

type MarketplacePreferenceReadModelBase = {
  readonly contractVersion: typeof MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION;
  readonly propertyId: string;
};
export type MarketplaceHotelCollaborationPreferencesMissingReadModel =
  MarketplacePreferenceReadModelBase & {
    readonly revision: 0;
    readonly sourceRevision: "preferences:0";
    readonly preferences: null;
    readonly readiness: MarketplaceHotelCollaborationPreferencesMissingEvidence;
  };
export type MarketplaceHotelCollaborationPreferencesReadyReadModel =
  MarketplacePreferenceReadModelBase & {
    readonly revision: MarketplaceHotelCollaborationPreferencesRevision;
    readonly sourceRevision: MarketplaceHotelCollaborationPreferencesSourceRevision;
    readonly preferences: MarketplaceHotelCollaborationPreferences;
    readonly readiness: MarketplaceHotelCollaborationPreferencesReadyEvidence;
  };
export type MarketplaceHotelCollaborationPreferencesReadModel =
  | MarketplaceHotelCollaborationPreferencesMissingReadModel
  | MarketplaceHotelCollaborationPreferencesReadyReadModel;

export function parseReplaceMarketplaceHotelCollaborationPreferencesRequest(
  value: unknown,
): ReplaceMarketplaceHotelCollaborationPreferencesRequest | null {
  try {
    const request = snapshotExactRecord(value, REQUEST_KEYS);
    if (!request || !isRevision(request.expectedRevision, true)) return null;
    const preferences = parsePreferences({
      compensationTypes: request.compensationTypes,
      contentPlatforms: request.contentPlatforms,
      contentTypes: request.contentTypes,
      availability: request.availability,
    });
    return preferences
      ? deepFreeze({ expectedRevision: request.expectedRevision, ...preferences })
      : null;
  } catch {
    return null;
  }
}

export function parseMarketplaceHotelCollaborationPreferencesReadModel(
  value: unknown,
): MarketplaceHotelCollaborationPreferencesReadModel | null {
  try {
    const readModel = snapshotExactRecord(value, READ_MODEL_KEYS);
    if (
      !readModel ||
      readModel.contractVersion !== MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION ||
      !isUuid(readModel.propertyId)
    )
      return null;
    const propertyId = readModel.propertyId.toLowerCase();
    const revision = readModel.revision;
    if (!isRevision(revision, true) || readModel.sourceRevision !== `preferences:${revision}`)
      return null;

    const preferences = revision === 0 ? null : parsePreferences(readModel.preferences);
    if ((revision === 0 && readModel.preferences !== null) || (revision > 0 && !preferences))
      return null;
    const readiness = createMarketplaceHotelCollaborationPreferencesEvidence(
      propertyId,
      revision,
      preferences,
    );
    if (!matchesEvidence(readModel.readiness, readiness)) return null;

    return deepFreeze({
      contractVersion: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
      propertyId,
      revision,
      sourceRevision: `preferences:${revision}`,
      preferences,
      readiness,
    }) as MarketplaceHotelCollaborationPreferencesReadModel;
  } catch {
    return null;
  }
}

export function createMarketplaceHotelCollaborationPreferencesEvidence(
  propertyId: string,
  revision: number,
  preferences: MarketplaceHotelCollaborationPreferences | null,
): MarketplaceHotelCollaborationPreferencesEvidence {
  if (!isUuid(propertyId) || !isRevision(revision, true)) {
    throw new TypeError("Marketplace preference evidence requires a property UUID and revision");
  }
  if ((revision === 0) !== (preferences === null)) {
    throw new TypeError("Only an absent Marketplace preference aggregate may use revision zero");
  }
  if (preferences && !parsePreferences(preferences)) {
    throw new TypeError("Marketplace preference evidence requires a complete canonical document");
  }
  const omissions: MarketplaceHotelCollaborationPreferencesEvidence["omissions"] = preferences
    ? []
    : [
        {
          kind: "user_fixable",
          code: "compensation_types_unanswered",
          message: "Choose at least one compensation type.",
        },
        {
          kind: "user_fixable",
          code: "content_platforms_unanswered",
          message: "Choose at least one content platform.",
        },
        {
          kind: "user_fixable",
          code: "content_types_unanswered",
          message: "Choose at least one content type.",
        },
        {
          kind: "user_fixable",
          code: "availability_unanswered",
          message: "Choose year-round or selected-month availability.",
        },
      ];
  return deepFreeze({
    contractVersion: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_EVIDENCE_VERSION,
    product: "marketplace",
    groupId: "marketplace.collaboration_preferences",
    owningStepId: "marketplace_preferences",
    source: {
      ownerDomain: "marketplace",
      entityType: "hotel_collaboration_preferences",
      entityId: propertyId.toLowerCase(),
      revision: `preferences:${revision}`,
    },
    status: preferences ? "ready" : "blocked",
    omissions,
  }) as MarketplaceHotelCollaborationPreferencesEvidence;
}

const REQUEST_KEYS = [
  "expectedRevision",
  "compensationTypes",
  "contentPlatforms",
  "contentTypes",
  "availability",
] as const;
const PREFERENCE_KEYS = REQUEST_KEYS.slice(1);
const READ_MODEL_KEYS = [
  "contractVersion",
  "propertyId",
  "revision",
  "sourceRevision",
  "preferences",
  "readiness",
] as const;
const EVIDENCE_KEYS = [
  "contractVersion",
  "product",
  "groupId",
  "owningStepId",
  "source",
  "status",
  "omissions",
] as const;
const SOURCE_KEYS = ["ownerDomain", "entityType", "entityId", "revision"] as const;
const OMISSION_KEYS = ["kind", "code", "message"] as const;

function parsePreferences(value: unknown): MarketplaceHotelCollaborationPreferences | null {
  const preferences = snapshotExactRecord(value, PREFERENCE_KEYS);
  if (!preferences) return null;
  const compensationTypes = parseSelection(
    preferences.compensationTypes,
    MARKETPLACE_PREFERENCE_COMPENSATION_TYPES,
  );
  const contentPlatforms = parseSelection(
    preferences.contentPlatforms,
    MARKETPLACE_PREFERENCE_CONTENT_PLATFORMS,
  );
  const contentTypes = parseSelection(
    preferences.contentTypes,
    MARKETPLACE_PREFERENCE_CONTENT_TYPES,
  );
  const availability = parseAvailability(preferences.availability);
  return compensationTypes && contentPlatforms && contentTypes && availability
    ? { compensationTypes, contentPlatforms, contentTypes, availability }
    : null;
}

function parseSelection<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number][] | null {
  const selection = snapshotDenseDataArray(value);
  if (!selection || selection.length === 0 || selection.length > allowed.length) return null;
  if (
    selection.some((item) => typeof item !== "string" || !allowed.includes(item)) ||
    new Set(selection).size !== selection.length
  )
    return null;
  return allowed.filter((item) => selection.includes(item));
}

function parseAvailability(value: unknown): MarketplacePreferenceAvailability | null {
  const availability = snapshotExactRecord(value, ["mode", "selectedMonths"]);
  const months = availability ? snapshotDenseDataArray(availability.selectedMonths) : null;
  if (!availability || !months) return null;
  if (
    months.length > 12 ||
    months.some(
      (month) =>
        typeof month !== "number" || !Number.isSafeInteger(month) || month < 1 || month > 12,
    ) ||
    new Set(months).size !== months.length
  )
    return null;
  if (availability.mode === "year_round")
    return months.length === 0 ? { mode: "year_round", selectedMonths: [] } : null;
  if (availability.mode !== "selected_months" || months.length === 0) return null;
  return {
    mode: "selected_months",
    selectedMonths: [...(months as number[])].sort((a, b) => a - b),
  };
}

function matchesEvidence(
  value: unknown,
  expected: MarketplaceHotelCollaborationPreferencesEvidence,
): boolean {
  const evidence = snapshotExactRecord(value, EVIDENCE_KEYS);
  const source = evidence ? snapshotExactRecord(evidence.source, SOURCE_KEYS) : null;
  const omissions = evidence ? snapshotDenseDataArray(evidence.omissions) : null;
  if (!evidence || !source || !omissions) return false;
  if (
    evidence.contractVersion !== expected.contractVersion ||
    evidence.product !== expected.product ||
    evidence.groupId !== expected.groupId ||
    evidence.owningStepId !== expected.owningStepId ||
    evidence.status !== expected.status ||
    source.ownerDomain !== expected.source.ownerDomain ||
    source.entityType !== expected.source.entityType ||
    source.entityId !== expected.source.entityId ||
    source.revision !== expected.source.revision ||
    omissions.length !== expected.omissions.length
  )
    return false;
  return omissions.every((omission, index) => {
    const expectedOmission = expected.omissions[index];
    const omissionSnapshot = snapshotExactRecord(omission, OMISSION_KEYS);
    return (
      expectedOmission !== undefined &&
      omissionSnapshot !== null &&
      omissionSnapshot.kind === expectedOmission.kind &&
      omissionSnapshot.code === expectedOmission.code &&
      omissionSnapshot.message === expectedOmission.message
    );
  });
}

function snapshotExactRecord(
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

function snapshotDenseDataArray(value: unknown): unknown[] | null {
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRevision(value: unknown, allowZero: boolean): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= 2_147_483_647
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
