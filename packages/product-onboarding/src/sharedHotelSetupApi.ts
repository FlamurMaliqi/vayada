import {
  parseAdaptiveHotelSetupStatus,
  parsePropertyMediaCommandResponse,
  parsePropertyMediaLibraryItem,
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
import { sharedPropertyLogoContentType, sharedPropertyLogoError } from "./sharedPropertyLogo";

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
  uploadPropertyLogo(propertyId: string, file: File, idempotencyKey: string): Promise<string>;
  assignPropertyLogo(
    propertyId: string,
    request: {
      expectedProfileRevision: number;
      mediaObjectId: string;
      altText: string | null;
    },
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
    uploadPropertyLogo: async (propertyId, file, idempotencyKey) => {
      const validationError = sharedPropertyLogoError(file);
      if (validationError) throw new Error(validationError);
      const contentType = sharedPropertyLogoContentType(file);
      const created = await client.post<unknown>("/api/media/upload-sessions", {
        idempotencyKey,
        purpose: "property.logo",
        visibility: "private",
        resource: {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
        },
        files: [
          {
            clientFileId: "property_logo",
            filename: file.name || "property-logo.jpg",
            contentType,
            sizeBytes: file.size,
          },
        ],
      });
      const replayedMediaObject = firstPropertyLogoMediaObject(created);
      if (replayedMediaObject) return replayedMediaObject;
      const upload = propertyLogoUploadTarget(created);
      if (!upload.uploadUrl.startsWith("https://uploads.vayada.localhost/")) {
        const response = await fetch(upload.uploadUrl, {
          method: "PUT",
          headers: upload.headers,
          body: file,
        });
        if (!response.ok) throw new Error("The hotel logo could not be uploaded.");
      }
      const finalized = await client.post<unknown>(
        `/api/media/upload-sessions/${encodeURIComponent(upload.sessionId)}/finalize`,
        {
          files: [
            {
              uploadTargetId: upload.uploadTargetId,
              contentType,
              sizeBytes: file.size,
            },
          ],
        },
      );
      const mediaObjectId = firstPropertyLogoMediaObject(finalized);
      if (!mediaObjectId) throw new Error("The hotel logo upload did not finish.");
      return mediaObjectId;
    },
    assignPropertyLogo: async (propertyId, request, idempotencyKey) => {
      const value = await client.put<unknown>(
        `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/media/logo`,
        {
          expectedProfileRevision: request.expectedProfileRevision,
          assignment: {
            mediaObjectId: request.mediaObjectId,
            role: "logo",
            altText: request.altText,
            sortOrder: 0,
          },
        },
        idempotencyOptions(idempotencyKey),
      );
      const response = parsePropertyMediaCommandResponse(value);
      if (!response) throw new Error("Hotel logo assignment data is invalid.");
      return response;
    },
    updateTracks: (request, idempotencyKey) =>
      client.put<UpdateTracksResponse>(
        "/api/hotel-setup/tracks",
        request,
        idempotencyOptions(idempotencyKey),
      ),
  };
}

function propertyLogoUploadTarget(value: unknown): {
  sessionId: string;
  uploadTargetId: string;
  uploadUrl: string;
  headers: Record<string, string>;
} {
  if (!value || typeof value !== "object")
    throw new Error("The hotel logo upload could not start.");
  const response = value as {
    uploadSession?: { sessionId?: unknown };
    uploadTargets?: Array<{
      uploadTargetId?: unknown;
      method?: unknown;
      uploadUrl?: unknown;
      headers?: unknown;
    }>;
  };
  const target = response.uploadTargets?.[0];
  if (
    typeof response.uploadSession?.sessionId !== "string" ||
    typeof target?.uploadTargetId !== "string" ||
    target.method !== "PUT" ||
    typeof target.uploadUrl !== "string" ||
    !target.headers ||
    typeof target.headers !== "object" ||
    Array.isArray(target.headers)
  ) {
    throw new Error("The hotel logo upload could not start.");
  }
  return {
    sessionId: response.uploadSession.sessionId,
    uploadTargetId: target.uploadTargetId,
    uploadUrl: target.uploadUrl,
    headers: target.headers as Record<string, string>,
  };
}

function firstPropertyLogoMediaObject(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const mediaObjects = (value as { mediaObjects?: unknown }).mediaObjects;
  if (!Array.isArray(mediaObjects) || mediaObjects.length !== 1) return null;
  const media = parsePropertyMediaLibraryItem(mediaObjects[0]);
  return media?.purpose === "property.logo" && media.status === "private_ready"
    ? media.mediaObjectId
    : null;
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
