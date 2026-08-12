import {
  PROPERTY_SETUP_DRAFT_RESET_CONTRACT_VERSION,
  parseResetPropertySetupDraftRequest,
  type ResetPropertySetupDraftError,
  type ResetPropertySetupDraftReceipt,
  type ResetPropertySetupDraftRequest,
} from "@vayada/domain-hotels";

import { ApiErrorResponse } from "./client";
import { targetApiClient } from "./targetClient";

export type PropertySetupDraftResetHttpClient = {
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export type PropertySetupDraftResetClient = {
  reset(
    propertyId: string,
    request: ResetPropertySetupDraftRequest,
  ): Promise<ResetPropertySetupDraftReceipt>;
};

type ResetClientErrorCode =
  | ResetPropertySetupDraftError["code"]
  | "invalid_request"
  | "owner_contract_violation";

export class PropertySetupDraftResetError extends Error {
  constructor(
    message: string,
    readonly code: ResetClientErrorCode,
    readonly details: unknown,
    readonly requiresRefresh: boolean,
  ) {
    super(message);
    this.name = "PropertySetupDraftResetError";
  }
}

export function createPropertySetupDraftResetClient(
  http: PropertySetupDraftResetHttpClient,
): PropertySetupDraftResetClient {
  return {
    async reset(propertyId, request) {
      if (!isUuid(propertyId)) throw invalidRequestError();
      const parsed = parseResetPropertySetupDraftRequest(request);
      if (!parsed.ok) throw invalidRequestError();
      const normalizedPropertyId = propertyId.toLowerCase();
      const normalized = parsed.value;
      let value: unknown;
      try {
        value = await http.post<unknown>(
          `/api/hotel-setup/properties/${encodeURIComponent(normalizedPropertyId)}/setup-drafts/${encodeURIComponent(normalized.stepId)}/reset`,
          normalized,
          {
            headers: {
              "Idempotency-Key": await commandKey(normalizedPropertyId, normalized),
            },
          },
        );
      } catch (error) {
        throw parseResetFailure(error);
      }
      const receipt = parseResetReceipt(value, normalizedPropertyId, normalized);
      if (!receipt) throw ownerContractError();
      return receipt;
    },
  };
}

function parseResetReceipt(
  value: unknown,
  propertyId: string,
  request: ResetPropertySetupDraftRequest,
): ResetPropertySetupDraftReceipt | null {
  if (
    !hasExactKeys(value, [
      "contractVersion",
      "operation",
      "sessionId",
      "stepId",
      "trackRevision",
      "sessionRevision",
      "discardedDraftRevision",
      "resetAt",
      "nextRead",
    ]) ||
    value.contractVersion !== PROPERTY_SETUP_DRAFT_RESET_CONTRACT_VERSION ||
    value.operation !== "reset_step_draft" ||
    value.sessionId !== request.sessionId ||
    value.stepId !== request.stepId ||
    value.trackRevision !== request.expectedTrackRevision ||
    value.sessionRevision !== request.expectedSessionRevision + 1 ||
    value.discardedDraftRevision !== request.expectedDraftRevision ||
    !isCanonicalIsoDateTime(value.resetAt) ||
    !hasExactKeys(value.nextRead, ["method", "href"]) ||
    value.nextRead.method !== "GET" ||
    value.nextRead.href !== `/api/hotel-setup/properties/${propertyId}/route`
  ) {
    return null;
  }
  return value as ResetPropertySetupDraftReceipt;
}

function parseResetFailure(error: unknown): Error {
  if (!(error instanceof ApiErrorResponse)) {
    return error instanceof Error ? error : new Error("The setup draft could not be reset.");
  }
  const parsed = parseTypedResetError(error.data);
  if (error.status === 404) {
    return parsed?.code === "setup_scope_unavailable" ? resetError(parsed) : ownerContractError();
  }
  if (error.status === 409) {
    return parsed && parsed.code !== "setup_scope_unavailable"
      ? resetError(parsed)
      : ownerContractError();
  }
  return error;
}

function parseTypedResetError(value: unknown): ResetPropertySetupDraftError | null {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  switch (value.code) {
    case "setup_scope_unavailable":
    case "draft_base_revision_conflict":
    case "idempotency_key_conflict":
    case "command_in_progress":
      return hasExactKeys(value, ["code"])
        ? ({ code: value.code } as ResetPropertySetupDraftError)
        : null;
    case "inactive_setup_step":
    case "track_revision_conflict":
      return hasExactKeys(value, ["code", "currentTrackRevision"]) &&
        isPositiveRevision(value.currentTrackRevision)
        ? { code: value.code, currentTrackRevision: value.currentTrackRevision }
        : null;
    case "session_revision_conflict":
    case "setup_session_expired":
      return hasExactKeys(value, ["code", "currentSessionRevision"]) &&
        isPositiveRevision(value.currentSessionRevision)
        ? { code: value.code, currentSessionRevision: value.currentSessionRevision }
        : null;
    case "draft_revision_conflict":
    case "setup_draft_expired":
      return hasExactKeys(value, ["code", "currentDraftRevision"]) &&
        isPositiveRevision(value.currentDraftRevision)
        ? { code: value.code, currentDraftRevision: value.currentDraftRevision }
        : null;
    default:
      return null;
  }
}

function resetError(details: ResetPropertySetupDraftError): PropertySetupDraftResetError {
  const messages: Record<ResetPropertySetupDraftError["code"], string> = {
    setup_scope_unavailable: "Setup access is no longer available for this hotel.",
    inactive_setup_step: "This setup step is no longer active.",
    track_revision_conflict: "The selected setup track changed in another session.",
    session_revision_conflict: "This setup session changed in another session.",
    draft_revision_conflict: "This setup draft changed in another session.",
    draft_base_revision_conflict: "The draft source manifest changed in another session.",
    setup_session_expired: "This setup session expired.",
    setup_draft_expired: "This setup draft expired.",
    idempotency_key_conflict: "This reset key was reused for a different request.",
    command_in_progress: "This reset is still processing. Retry in a moment.",
  };
  const requiresRefresh = new Set<ResetPropertySetupDraftError["code"]>([
    "inactive_setup_step",
    "track_revision_conflict",
    "session_revision_conflict",
    "draft_revision_conflict",
    "draft_base_revision_conflict",
    "setup_session_expired",
    "setup_draft_expired",
  ]).has(details.code);
  return new PropertySetupDraftResetError(
    messages[details.code],
    details.code,
    details,
    requiresRefresh,
  );
}

function invalidRequestError(): PropertySetupDraftResetError {
  return new PropertySetupDraftResetError(
    "The property setup draft reset request is invalid.",
    "invalid_request",
    null,
    false,
  );
}

function ownerContractError(): PropertySetupDraftResetError {
  return new PropertySetupDraftResetError(
    "The protected setup draft reset adapter returned invalid data.",
    "owner_contract_violation",
    null,
    false,
  );
}

async function commandKey(
  propertyId: string,
  request: ResetPropertySetupDraftRequest,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(request)),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `setup-draft-reset:${propertyId}:${request.stepId}:${hash.slice(0, 40)}`;
}

function isCanonicalIsoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isPositiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const propertySetupDraftResetApi = createPropertySetupDraftResetClient(targetApiClient);
