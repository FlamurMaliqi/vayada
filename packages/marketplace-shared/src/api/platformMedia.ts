import { ApiErrorResponse, createVayadaApiClient } from "./client";

const PLATFORM_MEDIA_API_BASE_URL =
  process.env.NEXT_PUBLIC_PLATFORM_MEDIA_API_URL ??
  process.env.NEXT_PUBLIC_AUTH_API_URL ??
  "https://api.localhost";
const platformMediaApiClient = createVayadaApiClient(PLATFORM_MEDIA_API_BASE_URL);

export type PlatformMediaPurpose =
  | "identity.user.profile_image"
  | "property.hero_image"
  | "marketplace.offer.media"
  | "marketplace.creator.profile_image"
  | "marketplace.collaboration_chat.attachment";

export type PlatformMediaResourceScope = {
  product: "platform" | "booking" | "marketplace";
  resourceType:
    | "user_profile"
    | "booking_hotel"
    | "hotel_profile"
    | "marketplace_offer"
    | "creator_profile";
  resourceId: string;
  propertyId?: string;
  targetResourceId?: string;
};

export type PlatformMediaUploadResult = {
  mediaId: string;
  url: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  widthPx?: number;
  heightPx?: number;
  originalFilename: string;
};

type UploadTarget = {
  uploadTargetId: string;
  clientFileId: string;
  method: "PUT";
  uploadUrl: string;
  headers: Record<string, string>;
};

type UploadSessionResponse = {
  uploadSession: { sessionId: string; status: "signed" | "completed" | "failed" };
  uploadTargets: UploadTarget[];
  mediaObjects?: SerializedMediaObject[];
};

type SerializedMediaObject = {
  mediaId: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  widthPx?: number;
  heightPx?: number;
  originalFilename: string;
  variants: Array<{ publicCdnUrl: string | null; storageKey: string }>;
};

type FinalizeResponse = {
  mediaObjects: SerializedMediaObject[];
};

export async function uploadPlatformMedia(input: {
  purpose: PlatformMediaPurpose;
  resource: PlatformMediaResourceScope;
  files: File[];
  visibility?: "public" | "private";
  expectedProfileRevision?: number;
  idempotencyKey?: string;
}): Promise<PlatformMediaUploadResult[]> {
  if (input.files.length === 0) return [];

  const idempotencyKey = input.idempotencyKey?.trim()
    ? `${input.idempotencyKey.trim()}:files:sha256:${await selectedFilesDigest(input.files)}`
    : undefined;
  const create = await platformMediaApiClient.post<UploadSessionResponse>(
    "/api/media/upload-sessions",
    {
      idempotencyKey,
      purpose: input.purpose,
      visibility: input.visibility ?? "public",
      expectedProfileRevision: input.expectedProfileRevision,
      resource: input.resource,
      files: input.files.map((file, index) => ({
        clientFileId: `file_${index + 1}`,
        filename: file.name || `image-${index + 1}.jpg`,
        contentType: uploadContentType(file),
        sizeBytes: file.size,
      })),
    },
  );

  if (create.uploadSession.status === "completed") {
    if (!create.mediaObjects?.length) {
      throw new ApiErrorResponse(409, {
        detail: "Completed platform media session did not return its media objects",
      });
    }
    return create.mediaObjects.map(toUploadResult);
  }

  await Promise.all(
    create.uploadTargets.map(async (target, index) => {
      const file = input.files[index];
      if (!file) {
        throw new ApiErrorResponse(400, { detail: "Upload target did not match a selected file" });
      }
      if (isDeterministicLocalUploadTarget(target.uploadUrl)) return;

      const response = await fetch(target.uploadUrl, {
        method: target.method,
        headers: target.headers,
        body: file,
      });

      if (!response.ok) {
        throw new ApiErrorResponse(response.status, {
          detail: `Platform media upload failed for ${file.name || target.clientFileId}`,
        });
      }
    }),
  );

  const finalized = await platformMediaApiClient.post<FinalizeResponse>(
    `/api/media/upload-sessions/${create.uploadSession.sessionId}/finalize`,
    {
      files: create.uploadTargets.map((target, index) => {
        const file = input.files[index]!;
        return {
          uploadTargetId: target.uploadTargetId,
          contentType: uploadContentType(file),
          sizeBytes: file.size,
        };
      }),
    },
  );

  return finalized.mediaObjects.map(toUploadResult);
}

function toUploadResult(mediaObject: SerializedMediaObject): PlatformMediaUploadResult {
  return {
    mediaId: mediaObject.mediaId,
    url:
      mediaObject.variants.find((variant) => variant.publicCdnUrl)?.publicCdnUrl ??
      mediaObject.storageKey,
    storageKey: mediaObject.storageKey,
    contentType: mediaObject.contentType,
    sizeBytes: mediaObject.sizeBytes,
    widthPx: mediaObject.widthPx,
    heightPx: mediaObject.heightPx,
    originalFilename: mediaObject.originalFilename,
  };
}

async function selectedFilesDigest(files: File[]): Promise<string> {
  const fileSignatures = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      contentSha256: await sha256Hex(await file.arrayBuffer()),
    })),
  );
  return sha256Hex(new TextEncoder().encode(JSON.stringify(fileSignatures)));
}

async function sha256Hex(data: BufferSource): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uploadContentType(file: File): string {
  if (file.type) return file.type;
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return "image/jpeg";
}

function isDeterministicLocalUploadTarget(uploadUrl: string): boolean {
  return uploadUrl.startsWith("https://uploads.vayada.localhost/");
}
