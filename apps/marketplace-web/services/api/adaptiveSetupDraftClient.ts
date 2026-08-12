import {
  PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
  SETUP_TRACKS,
  parseSavePropertySetupDraftRequest,
  type SavePropertySetupDraftReceipt,
  type SavePropertySetupDraftRequest,
} from "@vayada/domain-hotels";

import { targetApiClient } from "./targetClient";

export type AdaptiveSetupDraftHttpClient = {
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export function createAdaptiveSetupDraftClient(http: AdaptiveSetupDraftHttpClient) {
  return {
    async save(
      propertyId: string,
      request: SavePropertySetupDraftRequest,
    ): Promise<SavePropertySetupDraftReceipt> {
      const parsed = parseSavePropertySetupDraftRequest(request);
      if (!parsed.ok) throw new TypeError("The setup draft is invalid and was not sent.");
      const value = await http.put<unknown>(
        `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/setup-drafts/${parsed.value.stepId}`,
        parsed.value,
        {
          headers: {
            "Idempotency-Key": await draftIdempotencyKey(propertyId, parsed.value),
          },
        },
      );
      const receipt = parseReceipt(value, parsed.value);
      if (!receipt) throw new Error("The setup draft response is invalid. Refresh and try again.");
      return receipt;
    },
  };
}

export const adaptiveSetupDraftClient = createAdaptiveSetupDraftClient(targetApiClient);

async function draftIdempotencyKey(
  propertyId: string,
  request: SavePropertySetupDraftRequest,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ propertyId, request })),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `setup-draft:${request.stepId}:${propertyId}:${hex.slice(0, 40)}`;
}

function parseReceipt(
  value: unknown,
  request: SavePropertySetupDraftRequest,
): SavePropertySetupDraftReceipt | null {
  if (
    !record(value) ||
    !exact(value, [
      "contractVersion",
      "sessionId",
      "stepId",
      "selectedTracks",
      "trackRevision",
      "sessionRevision",
      "draftRevision",
      "retentionExpiresAt",
      "updatedAt",
      "replayed",
    ]) ||
    value.contractVersion !== PROPERTY_SETUP_DRAFT_CONTRACT_VERSION ||
    value.stepId !== request.stepId ||
    typeof value.sessionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.sessionId,
    ) ||
    !Array.isArray(value.selectedTracks) ||
    value.selectedTracks.length === 0 ||
    new Set(value.selectedTracks).size !== value.selectedTracks.length ||
    value.selectedTracks.some((track) => !SETUP_TRACKS.includes(track)) ||
    !revision(value.trackRevision) ||
    !revision(value.sessionRevision) ||
    !revision(value.draftRevision) ||
    value.trackRevision !== request.expectedTrackRevision ||
    value.sessionRevision !== request.expectedSessionRevision + 1 ||
    value.draftRevision !== request.expectedDraftRevision + 1 ||
    !timestamp(value.retentionExpiresAt) ||
    !timestamp(value.updatedAt) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }
  return value as SavePropertySetupDraftReceipt;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
