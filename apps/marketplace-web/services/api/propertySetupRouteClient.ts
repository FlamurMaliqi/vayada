import {
  PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION,
  PROPERTY_SETUP_ROUTE_CONTRACT_VERSION,
  PROPERTY_SETUP_ROUTE_STEP_STATES,
  PROPERTY_SETUP_STEP_DEFINITIONS,
  SETUP_TRACKS,
  getActivePropertySetupStepIds,
  isPropertySetupDraftFieldValue,
  type PropertySetupBlockerKind,
  type PropertySetupFieldId,
  type PropertySetupOwnerDomain,
  type PropertySetupRouteBlocker,
  type PropertySetupRouteReadModel,
  type PropertySetupStepDraft,
  type PropertySetupStepId,
  type SetupTrack,
} from "@vayada/domain-hotels";

export type PropertySetupRouteHttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
};

export type PropertySetupRouteClient = {
  getRoute(propertyId: string, options?: RequestInit): Promise<PropertySetupRouteReadModel>;
};

const BLOCKER_KINDS: readonly PropertySetupBlockerKind[] = [
  "user_fixable",
  "external_pending",
  "system_error",
];
const OWNER_DOMAINS: readonly PropertySetupOwnerDomain[] = [
  "hotel_catalog",
  "marketplace",
  "booking",
  "pms",
  "finance",
  "distribution",
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REVISION = 2_147_483_646;
const MAX_SOURCE_REVISION_LENGTH = 8_192;
const ROUTE_KEYS = [
  "contractVersion",
  "scope",
  "selectedTracks",
  "trackRevision",
  "sessionId",
  "sessionRevision",
  "resumeStepId",
  "progress",
  "steps",
] as const;
const STEP_KEYS = ["stepId", "position", "state", "sourceRevision", "draft", "blockers"] as const;
const DRAFT_KEYS = [
  "stepId",
  "payload",
  "dirtyFields",
  "baseRevisions",
  "piiClassification",
  "retentionExpiresAt",
  "revision",
  "updatedAt",
] as const;
const BLOCKER_KEYS = [
  "code",
  "product",
  "ownerDomain",
  "owningStepId",
  "affectedEntity",
  "message",
  "kind",
  "sourceRevision",
  "owningStepPosition",
] as const;

export function createPropertySetupRouteClient(
  client: PropertySetupRouteHttpClient,
): PropertySetupRouteClient {
  return {
    async getRoute(propertyId, options) {
      const value = await client.get<unknown>(
        `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/route`,
        options,
      );
      const route = parsePropertySetupRouteReadModel(value);
      if (!route || route.scope.propertyId !== propertyId.toLowerCase()) {
        throw new Error("Property setup route data is invalid. Refresh the page and try again.");
      }
      return route;
    },
  };
}

/** Validates the protected v1 wire response before UI code trusts it. */
export function parsePropertySetupRouteReadModel(
  value: unknown,
): PropertySetupRouteReadModel | null {
  if (!isRecord(value) || !hasExactKeys(value, ROUTE_KEYS)) return null;
  if (value.contractVersion !== PROPERTY_SETUP_ROUTE_CONTRACT_VERSION) return null;

  const scope = value.scope;
  const selectedTracks = value.selectedTracks;
  const progress = value.progress;
  const steps = value.steps;
  if (
    !isRecord(scope) ||
    !hasExactKeys(scope, ["organizationId", "propertyId"]) ||
    !isUuid(scope.organizationId) ||
    !isUuid(scope.propertyId) ||
    !isCanonicalTrackSelection(selectedTracks) ||
    !isRevision(value.trackRevision) ||
    !isSessionMetadata(
      value.sessionId,
      value.sessionRevision,
      value.resumeStepId,
      selectedTracks,
    ) ||
    !isRecord(progress) ||
    !hasExactKeys(progress, ["complete", "total"]) ||
    !isRevision(progress.complete) ||
    !isRevision(progress.total) ||
    !Array.isArray(steps)
  ) {
    return null;
  }

  const expectedStepIds = getActivePropertySetupStepIds(selectedTracks);
  if (
    steps.length !== expectedStepIds.length ||
    progress.total !== steps.length ||
    !steps.every((step, index) => isRouteStep(step, expectedStepIds, index)) ||
    progress.complete !==
      steps.filter((step) => isRecord(step) && step.state === "complete").length ||
    (value.sessionId === null && steps.some((step) => isRecord(step) && step.draft !== null))
  ) {
    return null;
  }

  return value as PropertySetupRouteReadModel;
}

function isRouteStep(
  value: unknown,
  expectedStepIds: PropertySetupStepId[],
  index: number,
): value is PropertySetupRouteReadModel["steps"][number] {
  if (!isRecord(value) || !hasExactKeys(value, STEP_KEYS)) return false;
  const expectedStepId = expectedStepIds[index];
  const state = value.state;
  const draft = value.draft;
  const blockers = value.blockers;
  if (
    value.stepId !== expectedStepId ||
    value.position !== index + 1 ||
    !isOneOf(state, PROPERTY_SETUP_ROUTE_STEP_STATES) ||
    !isNullableSourceRevision(value.sourceRevision) ||
    !Array.isArray(blockers) ||
    !blockers.every((blocker) => isRouteBlocker(blocker, expectedStepIds))
  ) {
    return false;
  }

  if (
    (state === "blocked") !== blockers.length > 0 ||
    ((state === "saved" || state === "blocked") && value.sourceRevision === null) ||
    (state === "draft" && draft === null) ||
    (state === "not_started" && draft !== null)
  ) {
    return false;
  }
  return draft === null || isStepDraft(draft, expectedStepId);
}

function isRouteBlocker(
  value: unknown,
  activeStepIds: PropertySetupStepId[],
): value is PropertySetupRouteBlocker {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, BLOCKER_KEYS) ||
    !hasRequiredKeys(
      value,
      BLOCKER_KEYS.filter((key) => key !== "affectedEntity"),
    ) ||
    !isBoundedNonEmptyString(value.code, 128) ||
    !isOneOf(value.product, OWNER_DOMAINS) ||
    !isOneOf(value.ownerDomain, OWNER_DOMAINS) ||
    !isOneOf(value.owningStepId, activeStepIds) ||
    !isBoundedNonEmptyString(value.message, 2_000) ||
    !isOneOf(value.kind, BLOCKER_KINDS) ||
    !isSourceRevision(value.sourceRevision)
  ) {
    return false;
  }

  const expectedPosition = activeStepIds.indexOf(value.owningStepId) + 1;
  if (value.owningStepPosition !== expectedPosition) return false;
  const entity = value.affectedEntity;
  return (
    entity === undefined ||
    (isRecord(entity) &&
      hasExactKeys(entity, ["entityType", "entityId"]) &&
      isBoundedNonEmptyString(entity.entityType, 128) &&
      isBoundedNonEmptyString(entity.entityId, 256))
  );
}

function isStepDraft(
  value: unknown,
  expectedStepId: PropertySetupStepId,
): value is PropertySetupStepDraft {
  if (!isRecord(value) || !hasExactKeys(value, DRAFT_KEYS) || value.stepId !== expectedStepId) {
    return false;
  }
  const definition = PROPERTY_SETUP_STEP_DEFINITIONS.find(
    ({ stepId }) => stepId === expectedStepId,
  );
  if (!definition) return false;

  const payload = value.payload;
  const dirtyFields = value.dirtyFields;
  const baseRevisions = value.baseRevisions;
  const allowedFields = new Set<string>(definition.fields);
  if (
    !isRecord(payload) ||
    !Object.entries(payload).every(
      ([field, fieldValue]) =>
        allowedFields.has(field) &&
        isPropertySetupDraftFieldValue(field as PropertySetupFieldId, fieldValue),
    ) ||
    !Array.isArray(dirtyFields) ||
    dirtyFields.length > definition.fields.length ||
    !dirtyFields.every(
      (field) =>
        typeof field === "string" && allowedFields.has(field) && Object.hasOwn(payload, field),
    ) ||
    new Set(dirtyFields).size !== dirtyFields.length ||
    !sameOrder(
      dirtyFields,
      definition.fields.filter((field) => dirtyFields.includes(field)),
    ) ||
    !isRecord(baseRevisions) ||
    !hasExactKeys(baseRevisions, definition.baseRevisionKeys) ||
    !Object.values(baseRevisions).every(isBaseRevision) ||
    value.piiClassification !== PROPERTY_SETUP_DRAFT_PII_CLASSIFICATION ||
    !isIsoTimestamp(value.retentionExpiresAt) ||
    !isRevision(value.revision) ||
    !isIsoTimestamp(value.updatedAt)
  ) {
    return false;
  }
  return true;
}

function isSessionMetadata(
  sessionId: unknown,
  sessionRevision: unknown,
  resumeStepId: unknown,
  selectedTracks: SetupTrack[],
): boolean {
  const activeSteps = getActivePropertySetupStepIds(selectedTracks);
  if (sessionId === null) return sessionRevision === null && resumeStepId === null;
  return (
    isUuid(sessionId) &&
    isRevision(sessionRevision) &&
    (resumeStepId === null || isOneOf(resumeStepId, activeSteps))
  );
}

function isCanonicalTrackSelection(value: unknown): value is SetupTrack[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((track) => isOneOf(track, SETUP_TRACKS)) &&
    new Set(value).size === value.length &&
    sameOrder(
      value,
      SETUP_TRACKS.filter((track) => value.includes(track)),
    )
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_REVISION;
}

function isBaseRevision(value: unknown): value is string {
  return typeof value === "string" && BASE_REVISION_PATTERN.test(value);
}

function isSourceRevision(value: unknown): value is string {
  return isBoundedNonEmptyString(value, MAX_SOURCE_REVISION_LENGTH);
}

function isNullableSourceRevision(value: unknown): value is string | null {
  return value === null || isSourceRevision(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isBoundedNonEmptyString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function sameOrder(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && hasRequiredKeys(value, expected);
}

function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
