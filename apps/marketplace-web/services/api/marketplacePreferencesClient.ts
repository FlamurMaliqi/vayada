import {
  parseMarketplaceHotelCollaborationPreferencesReadModel,
  parseReplaceMarketplaceHotelCollaborationPreferencesRequest,
  parseReplaceMarketplaceHotelCollaborationPreferencesResult,
  type MarketplaceHotelCollaborationPreferencesReadModel,
  type ReplaceMarketplaceHotelCollaborationPreferencesRequest,
  type ReplaceMarketplaceHotelCollaborationPreferencesResponse,
} from "@vayada/domain-marketplace";

import { targetApiClient } from "./targetClient";

type HttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export function createMarketplacePreferencesClient(http: HttpClient) {
  return {
    async load(
      propertyId: string,
      options?: RequestInit,
    ): Promise<MarketplaceHotelCollaborationPreferencesReadModel> {
      const parsed = parseMarketplaceHotelCollaborationPreferencesReadModel(
        await http.get<unknown>(path(propertyId), options),
      );
      if (!parsed || parsed.propertyId !== propertyId.toLowerCase()) throw invalid("read");
      return parsed;
    },

    async save(
      propertyId: string,
      request: ReplaceMarketplaceHotelCollaborationPreferencesRequest,
    ): Promise<ReplaceMarketplaceHotelCollaborationPreferencesResponse> {
      const parsedRequest = parseReplaceMarketplaceHotelCollaborationPreferencesRequest(request);
      if (!parsedRequest) throw new TypeError("Every Marketplace preference group is required.");
      const value = await http.put<unknown>(path(propertyId), parsedRequest, {
        headers: {
          "Idempotency-Key": await key(propertyId, parsedRequest),
        },
      });
      const parsed = parseReplaceMarketplaceHotelCollaborationPreferencesResult({
        ok: true,
        response: value,
      });
      if (
        !parsed?.ok ||
        parsed.response.propertyId !== propertyId.toLowerCase() ||
        parsed.response.revision !== parsedRequest.expectedRevision + 1 ||
        !samePreferences(parsed.response.preferences, parsedRequest)
      ) {
        throw invalid("save");
      }
      return parsed.response;
    },
  };
}

export const marketplacePreferencesClient = createMarketplacePreferencesClient(targetApiClient);

function path(propertyId: string): string {
  return `/api/marketplace/properties/${encodeURIComponent(propertyId)}/hotel-collaboration-preferences`;
}

async function key(
  propertyId: string,
  request: ReplaceMarketplaceHotelCollaborationPreferencesRequest,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ propertyId, request })),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `marketplace-preferences:${propertyId}:${hex.slice(0, 40)}`;
}

function invalid(operation: string): Error {
  return new Error(
    `The Marketplace preference ${operation} response is invalid. Refresh and try again.`,
  );
}

function samePreferences(
  actual: ReplaceMarketplaceHotelCollaborationPreferencesResponse["preferences"],
  expected: ReplaceMarketplaceHotelCollaborationPreferencesRequest,
): boolean {
  return (
    JSON.stringify(actual.compensationTypes) === JSON.stringify(expected.compensationTypes) &&
    JSON.stringify(actual.contentPlatforms) === JSON.stringify(expected.contentPlatforms) &&
    JSON.stringify(actual.contentTypes) === JSON.stringify(expected.contentTypes) &&
    actual.availability.mode === expected.availability.mode &&
    JSON.stringify(actual.availability.selectedMonths) ===
      JSON.stringify(expected.availability.selectedMonths)
  );
}
