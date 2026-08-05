import {
  parseAdaptiveHotelSetupStatus,
  parsePropertyMediaCommandResponse,
  parsePropertyProfileResponse,
  parsePublicPropertyProfileResponse,
  parseReplacePropertyPresentationMediaRequest,
  parseUpdatePublicPropertyProfileRequest,
  parseUpdatePropertyProfileRequest,
  type AdaptiveHotelSetupStatus,
  type CreatePropertyProfileRequest,
  type PropertyMediaCommandResponse,
  type PropertyProfileResponse,
  type PublicPropertyProfileResponse,
  type ReplacePropertyPresentationMediaRequest,
  type UpdatePropertyProfileRequest,
  type UpdatePublicPropertyProfileRequest,
  type UpdateTracksRequest,
  type UpdateTracksResponse,
} from "@vayada/domain-hotels";

import type { SharedHotelSetupEntryProduct } from "./sharedFirstRunSetupFlow";

export type SharedHotelSetupHttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export type AdaptiveHotelSetupStatusParams = {
  entryProduct?: SharedHotelSetupEntryProduct | null;
  propertyId?: string | null;
};

export type SharedPropertyTypeOption = {
  value: string;
  label: string;
};

export type SharedPropertyTypeCatalog = {
  contractVersion: "adaptive-hotel-property-types.v1";
  propertyTypes: SharedPropertyTypeOption[];
};

export type SharedHotelSetupApi = {
  getStatus(
    params?: AdaptiveHotelSetupStatusParams,
    options?: RequestInit,
  ): Promise<AdaptiveHotelSetupStatus>;
  getPropertyTypes(): Promise<SharedPropertyTypeCatalog>;
  getPropertyProfile(propertyId: string, options?: RequestInit): Promise<PropertyProfileResponse>;
  createPropertyProfile(
    profile: CreatePropertyProfileRequest,
    idempotencyKey: string,
  ): Promise<PropertyProfileResponse>;
  updatePropertyProfile(
    propertyId: string,
    request: UpdatePropertyProfileRequest,
  ): Promise<PropertyProfileResponse>;
  getPublicPropertyProfile(
    propertyId: string,
    options?: RequestInit,
  ): Promise<PublicPropertyProfileResponse>;
  updatePublicPropertyProfile(
    propertyId: string,
    request: UpdatePublicPropertyProfileRequest,
  ): Promise<PublicPropertyProfileResponse>;
  replacePropertyPresentationMedia(
    propertyId: string,
    request: ReplacePropertyPresentationMediaRequest,
    idempotencyKey: string,
  ): Promise<PropertyMediaCommandResponse>;
  updateTracks(request: UpdateTracksRequest, idempotencyKey: string): Promise<UpdateTracksResponse>;
};

export function createSharedHotelSetupApi(client: SharedHotelSetupHttpClient): SharedHotelSetupApi {
  return {
    getStatus: async (params, options) => {
      const value = await client.get<unknown>(statusEndpoint(params), options);
      const status = parseAdaptiveHotelSetupStatus(value);
      if (
        !status ||
        (params?.entryProduct && status.entryDecision?.requestedProduct !== params.entryProduct)
      ) {
        throw new Error("Hotel setup data is invalid. Refresh the page and try again.");
      }
      return status;
    },
    getPropertyTypes: () =>
      client.get<SharedPropertyTypeCatalog>("/api/hotel-setup/property-types"),
    getPropertyProfile: async (propertyId, options) =>
      propertyProfileResponse(
        await client.get<unknown>(
          `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/profile`,
          options,
        ),
      ),
    createPropertyProfile: async (profile, idempotencyKey) =>
      propertyProfileResponse(
        await client.post<unknown>(
          "/api/hotel-setup/properties",
          profile,
          idempotencyOptions(idempotencyKey),
        ),
      ),
    updatePropertyProfile: async (propertyId, request) => {
      const update = parseUpdatePropertyProfileRequest(request);
      if (!update) throw new Error("Hotel profile update is invalid.");
      return propertyProfileResponse(
        await client.put<unknown>(
          `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/profile`,
          update,
        ),
      );
    },
    getPublicPropertyProfile: async (propertyId, options) =>
      publicPropertyProfileResponse(
        await client.get<unknown>(
          `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/public-profile`,
          options,
        ),
      ),
    updatePublicPropertyProfile: async (propertyId, request) => {
      const update = parseUpdatePublicPropertyProfileRequest(request);
      if (!update) throw new Error("Public hotel profile update is invalid.");
      return publicPropertyProfileResponse(
        await client.put<unknown>(
          `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/public-profile`,
          update,
        ),
      );
    },
    replacePropertyPresentationMedia: async (propertyId, request, idempotencyKey) => {
      const update = parseReplacePropertyPresentationMediaRequest(request);
      if (!update) throw new Error("Hotel cover and gallery assignments are invalid.");
      return propertyMediaCommandResponse(
        await client.put<unknown>(
          `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/media/presentation`,
          update,
          idempotencyOptions(idempotencyKey),
        ),
      );
    },
    updateTracks: (request, idempotencyKey) =>
      client.put<UpdateTracksResponse>(
        "/api/hotel-setup/tracks",
        request,
        idempotencyOptions(idempotencyKey),
      ),
  };
}

function statusEndpoint(params: AdaptiveHotelSetupStatusParams = {}): string {
  const query = new URLSearchParams();
  if (params.entryProduct) query.set("entryProduct", params.entryProduct);
  if (params.propertyId) query.set("propertyId", params.propertyId);
  const suffix = query.toString();
  return suffix ? `/api/hotel-setup/status?${suffix}` : "/api/hotel-setup/status";
}

function idempotencyOptions(idempotencyKey: string): RequestInit {
  return { headers: { "Idempotency-Key": idempotencyKey } };
}

function propertyProfileResponse(value: unknown): PropertyProfileResponse {
  const profile = parsePropertyProfileResponse(value);
  if (!profile) {
    throw new Error("Hotel profile data is invalid. Refresh the page and try again.");
  }
  return profile;
}

function publicPropertyProfileResponse(value: unknown): PublicPropertyProfileResponse {
  const profile = parsePublicPropertyProfileResponse(value);
  if (!profile) {
    throw new Error("Public hotel profile data is invalid. Refresh the page and try again.");
  }
  return profile;
}

function propertyMediaCommandResponse(value: unknown): PropertyMediaCommandResponse {
  const response = parsePropertyMediaCommandResponse(value);
  if (!response) {
    throw new Error("Hotel media assignment data is invalid. Refresh the page and try again.");
  }
  return response;
}
