import {
  parseHotelCatalogStep1ReadModel,
  parsePropertyMediaLibraryItem,
  parseSaveHotelCatalogStep1Request,
  parseSaveHotelCatalogStep1Response,
  type HotelCatalogStep1ReadModel,
  type PropertyMediaLibraryItem,
  type SaveHotelCatalogStep1Request,
  type SaveHotelCatalogStep1Response,
} from "@vayada/domain-hotels";

import { ApiErrorResponse, createVayadaApiClient } from "./client";
import { targetApiClient } from "./targetClient";

const mediaClient = createVayadaApiClient(
  process.env.NEXT_PUBLIC_PLATFORM_MEDIA_API_URL ??
    process.env.NEXT_PUBLIC_AUTH_API_URL ??
    "https://api.localhost",
);

type HttpClient = {
  get<T>(endpoint: string, options?: RequestInit): Promise<T>;
  put<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};
type MediaHttpClient = {
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

export function createHotelPresentationClient(
  http: HttpClient,
  mediaHttp: MediaHttpClient,
  uploadFetch: typeof fetch = fetch,
) {
  return {
    async load(propertyId: string, options?: RequestInit): Promise<HotelCatalogStep1ReadModel> {
      const value = await http.get<unknown>(path(propertyId), options);
      const parsed = parseHotelCatalogStep1ReadModel(value);
      if (!parsed || parsed.propertyId !== propertyId.toLowerCase()) throw invalid("profile read");
      return parsed;
    },

    async save(
      propertyId: string,
      request: SaveHotelCatalogStep1Request,
    ): Promise<SaveHotelCatalogStep1Response> {
      const parsedRequest = parseSaveHotelCatalogStep1Request(request);
      if (!parsedRequest) throw new TypeError("The hotel presentation is incomplete.");
      const value = await http.put<unknown>(path(propertyId), parsedRequest, {
        headers: {
          "Idempotency-Key": await key("present-hotel", propertyId, parsedRequest),
        },
      });
      const parsed = parseSaveHotelCatalogStep1Response(value);
      if (
        !parsed ||
        parsed.propertyId !== propertyId.toLowerCase() ||
        parsed.profileRevision <= parsedRequest.expectedProfileRevision ||
        parsed.profile.locale !== parsedRequest.locale ||
        parsed.profile.shortDescription !== parsedRequest.shortDescription ||
        JSON.stringify(parsed.profile.amenities.keys) !==
          JSON.stringify(parsedRequest.amenities.keys) ||
        parsed.profile.media.coverMediaObjectId !== parsedRequest.media.coverMediaObjectId ||
        JSON.stringify(parsed.profile.media.galleryMediaObjectIds) !==
          JSON.stringify(parsedRequest.media.galleryMediaObjectIds)
      ) {
        throw invalid("profile save");
      }
      return parsed;
    },

    async upload(propertyId: string, files: readonly File[]): Promise<PropertyMediaLibraryItem[]> {
      if (files.length === 0) return [];
      const request = {
        idempotencyKey: await key("presentation-media", propertyId, {
          files: await Promise.all(
            files.map(async (file) => ({
              name: file.name,
              type: contentType(file),
              size: file.size,
              digest: await sha256(await file.arrayBuffer()),
            })),
          ),
        }),
        purpose: "property.gallery_image",
        visibility: "private",
        resource: {
          product: "hotel_catalog",
          resourceType: "property",
          resourceId: propertyId,
          propertyId,
        },
        files: files.map((file, index) => ({
          clientFileId: `file_${index + 1}`,
          filename: file.name || `hotel-photo-${index + 1}.jpg`,
          contentType: contentType(file),
          sizeBytes: file.size,
        })),
      };
      const created = parseUploadSession(
        await mediaHttp.post<unknown>("/api/media/upload-sessions", request),
        files.length,
      );
      if (!created) throw invalid("media upload session");
      if (created.status === "completed") return created.mediaObjects!;

      await Promise.all(
        created.targets.map(async (target, index) => {
          const file = files[index];
          if (!file) throw invalid("media upload target");
          if (target.uploadUrl.startsWith("https://uploads.vayada.localhost/")) return;
          const response = await uploadFetch(target.uploadUrl, {
            method: "PUT",
            headers: target.headers,
            body: file,
          });
          if (!response.ok) {
            throw new ApiErrorResponse(response.status, {
              detail: `Photo upload failed for ${file.name || target.clientFileId}.`,
            });
          }
        }),
      );

      const value = await mediaHttp.post<unknown>(
        `/api/media/upload-sessions/${encodeURIComponent(created.sessionId)}/finalize`,
        {
          files: created.targets.map((target, index) => ({
            uploadTargetId: target.uploadTargetId,
            contentType: contentType(files[index]!),
            sizeBytes: files[index]!.size,
          })),
        },
      );
      const finalized = parseMediaItems(value, files.length);
      if (!finalized) throw invalid("finalized presentation media");
      return finalized;
    },
  };
}

export const hotelPresentationClient = createHotelPresentationClient(targetApiClient, mediaClient);

function path(propertyId: string): string {
  return `/api/hotel-setup/properties/${encodeURIComponent(propertyId)}/steps/present-hotel`;
}

type UploadSession = {
  sessionId: string;
  status: "signed" | "completed";
  targets: Array<{
    uploadTargetId: string;
    clientFileId: string;
    uploadUrl: string;
    headers: Record<string, string>;
  }>;
  mediaObjects: PropertyMediaLibraryItem[] | null;
};

function parseUploadSession(value: unknown, count: number): UploadSession | null {
  if (
    !record(value) ||
    value.contractVersion !== "platform-media-upload.v2" ||
    !record(value.uploadSession) ||
    typeof value.uploadSession.sessionId !== "string" ||
    (value.uploadSession.status !== "signed" && value.uploadSession.status !== "completed") ||
    !Array.isArray(value.uploadTargets)
  ) {
    return null;
  }
  const mediaObjects = parseMediaArray(value.mediaObjects, count);
  if (value.uploadSession.status === "completed") {
    return mediaObjects
      ? {
          sessionId: value.uploadSession.sessionId,
          status: "completed",
          targets: [],
          mediaObjects,
        }
      : null;
  }
  const rawTargets = value.uploadTargets.map(parseTarget);
  const targets = Array.from({ length: count }, (_, index) =>
    rawTargets.find((target) => target?.clientFileId === `file_${index + 1}`),
  );
  return rawTargets.length === count && targets.every(Boolean)
    ? {
        sessionId: value.uploadSession.sessionId,
        status: "signed",
        targets: targets as UploadSession["targets"],
        mediaObjects: null,
      }
    : null;
}

function parseTarget(value: unknown): UploadSession["targets"][number] | null {
  if (
    !record(value) ||
    typeof value.uploadTargetId !== "string" ||
    typeof value.clientFileId !== "string" ||
    value.method !== "PUT" ||
    typeof value.uploadUrl !== "string" ||
    !record(value.headers) ||
    !Object.values(value.headers).every((header) => typeof header === "string")
  ) {
    return null;
  }
  return value as UploadSession["targets"][number];
}

function parseMediaItems(value: unknown, count: number): PropertyMediaLibraryItem[] | null {
  return record(value) && value.contractVersion === "platform-media-upload.v2"
    ? parseMediaArray(value.mediaObjects, count)
    : null;
}

function parseMediaArray(value: unknown, count: number): PropertyMediaLibraryItem[] | null {
  if (!Array.isArray(value) || value.length !== count) return null;
  const parsed = value.map(parsePropertyMediaLibraryItem);
  return parsed.some((item) => !item || item.purpose !== "property.gallery_image")
    ? null
    : (parsed as PropertyMediaLibraryItem[]);
}

async function key(label: string, propertyId: string, value: unknown): Promise<string> {
  return `${label}:${propertyId}:${(await sha256(new TextEncoder().encode(JSON.stringify(value)))).slice(0, 40)}`;
}

async function sha256(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function contentType(file: File): string {
  if (file.type) return file.type;
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return "image/jpeg";
}

function invalid(label: string): Error {
  return new Error(`The ${label} response is invalid. Refresh and try again.`);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
