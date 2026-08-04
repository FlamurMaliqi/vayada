import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  type PropertySetupBaseRevisions,
  type PropertySetupStepId,
} from "./propertySetupDraft.js";

export const PROPERTY_SETUP_DRAFT_RESET_CONTRACT_VERSION = "property-setup-draft-reset.v1" as const;

export type ResetPropertySetupDraftRequest = {
  [TStepId in PropertySetupStepId]: {
    sessionId: string;
    stepId: TStepId;
    expectedTrackRevision: number;
    expectedSessionRevision: number;
    expectedDraftRevision: number;
    /** The exact historical manifest stored with the draft being discarded. */
    expectedBaseRevisions: PropertySetupBaseRevisions<TStepId>;
  };
}[PropertySetupStepId];

export type ResetPropertySetupDraftReceipt = Readonly<{
  contractVersion: typeof PROPERTY_SETUP_DRAFT_RESET_CONTRACT_VERSION;
  operation: "reset_step_draft";
  sessionId: string;
  stepId: PropertySetupStepId;
  trackRevision: number;
  sessionRevision: number;
  discardedDraftRevision: number;
  resetAt: string;
  nextRead: Readonly<{
    method: "GET";
    href: `/api/hotel-setup/properties/${string}/route`;
  }>;
}>;

export type ResetPropertySetupDraftError =
  | { code: "setup_scope_unavailable" }
  | { code: "inactive_setup_step"; currentTrackRevision: number }
  | { code: "track_revision_conflict"; currentTrackRevision: number }
  | { code: "session_revision_conflict"; currentSessionRevision: number }
  | { code: "draft_revision_conflict"; currentDraftRevision: number }
  | { code: "draft_base_revision_conflict" }
  | { code: "setup_session_expired"; currentSessionRevision: number }
  | { code: "setup_draft_expired"; currentDraftRevision: number }
  | { code: "idempotency_key_conflict" }
  | { code: "command_in_progress" };

export type ResetPropertySetupDraftResult =
  | { ok: true; receipt: ResetPropertySetupDraftReceipt }
  | { ok: false; error: ResetPropertySetupDraftError };

export type PropertySetupDraftResetRequestError = Readonly<{
  code: "invalid_request";
  message: "The property setup draft reset request is invalid.";
}>;

export type PropertySetupDraftResetRequestResult =
  | { ok: true; value: ResetPropertySetupDraftRequest }
  | { ok: false; error: PropertySetupDraftResetRequestError };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE_REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REVISION = 2_147_483_646;
const REQUEST_KEYS = [
  "sessionId",
  "stepId",
  "expectedTrackRevision",
  "expectedSessionRevision",
  "expectedDraftRevision",
  "expectedBaseRevisions",
] as const;

export function parseResetPropertySetupDraftRequest(
  value: unknown,
): PropertySetupDraftResetRequestResult {
  if (!isRecord(value) || !hasExactKeys(value, REQUEST_KEYS)) return invalidRequest();
  const definition = PROPERTY_SETUP_STEP_DEFINITIONS.find(
    ({ stepId }) => stepId === value["stepId"],
  );
  const baseRevisions = value["expectedBaseRevisions"];
  if (
    !definition ||
    typeof value["sessionId"] !== "string" ||
    !UUID_PATTERN.test(value["sessionId"]) ||
    !isPositiveRevision(value["expectedTrackRevision"]) ||
    !isPositiveRevision(value["expectedSessionRevision"]) ||
    !isPositiveRevision(value["expectedDraftRevision"]) ||
    !isRecord(baseRevisions) ||
    !hasExactKeys(baseRevisions, definition.baseRevisionKeys) ||
    !Object.values(baseRevisions).every(isBaseRevision)
  ) {
    return invalidRequest();
  }

  return {
    ok: true,
    value: {
      sessionId: value["sessionId"].toLowerCase(),
      stepId: definition.stepId,
      expectedTrackRevision: value["expectedTrackRevision"],
      expectedSessionRevision: value["expectedSessionRevision"],
      expectedDraftRevision: value["expectedDraftRevision"],
      expectedBaseRevisions: Object.fromEntries(
        definition.baseRevisionKeys.map((key) => [key, baseRevisions[key]]),
      ),
    } as ResetPropertySetupDraftRequest,
  };
}

function isPositiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_REVISION;
}

function isBaseRevision(value: unknown): value is string {
  return typeof value === "string" && BASE_REVISION_PATTERN.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(): PropertySetupDraftResetRequestResult {
  return {
    ok: false,
    error: {
      code: "invalid_request",
      message: "The property setup draft reset request is invalid.",
    },
  };
}
