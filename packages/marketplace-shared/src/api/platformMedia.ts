import { ApiClient, ApiErrorResponse, getApiBearerToken } from "./client";

const PLATFORM_MEDIA_API_BASE_URL =
  process.env.NEXT_PUBLIC_PLATFORM_MEDIA_API_URL ??
  process.env.NEXT_PUBLIC_AUTH_API_URL ??
  "https://api.localhost";
const LEGACY_IMAGE_UPLOAD_API_BASE_URL =
  process.env.NEXT_PUBLIC_MARKETPLACE_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.NEXT_PUBLIC_AUTH_API_URL ??
  "https://api.marketplace.localhost";

const platformMediaApiClient = new ApiClient(PLATFORM_MEDIA_API_BASE_URL);

export type PlatformMediaPurpose =
  | "property.hero_image"
  | "marketplace.offer.media"
  | "marketplace.creator.profile_image";

export type PlatformMediaResourceScope = {
  product: "booking" | "marketplace";
  resourceType: "booking_hotel" | "hotel_profile" | "marketplace_offer" | "creator_profile";
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
  uploadSession: { sessionId: string };
  uploadTargets: UploadTarget[];
};

type FinalizeResponse = {
  mediaObjects: Array<{
    mediaId: string;
    storageKey: string;
    contentType: string;
    sizeBytes: number;
    widthPx?: number;
    heightPx?: number;
    originalFilename: string;
    variants: Array<{ publicCdnUrl: string | null; storageKey: string }>;
  }>;
};

type LegacyImageUploadResponse = {
  url?: string;
  thumbnail_url?: string | null;
  key?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
  format?: string;
};

type LegacyMultipleImageUploadResponse = {
  images?: LegacyImageUploadResponse[];
  total?: number;
};

export async function uploadPlatformMedia(input: {
  purpose: PlatformMediaPurpose;
  resource: PlatformMediaResourceScope;
  files: File[];
  visibility?: "public" | "private";
}): Promise<PlatformMediaUploadResult[]> {
  if (input.files.length === 0) return [];

  if (shouldUseLegacyMarketplaceImageUpload()) {
    return uploadLegacyMarketplaceImages(input);
  }

  const create = await platformMediaApiClient.post<UploadSessionResponse>(
    "/api/media/upload-sessions",
    {
      purpose: input.purpose,
      visibility: input.visibility ?? "public",
      resource: input.resource,
      files: input.files.map((file, index) => ({
        clientFileId: `file_${index + 1}`,
        filename: file.name || `image-${index + 1}.jpg`,
        contentType: file.type || "image/jpeg",
        sizeBytes: file.size,
      })),
    },
  );

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
          contentType: file.type || "image/jpeg",
          sizeBytes: file.size,
        };
      }),
    },
  );

  return finalized.mediaObjects.map((mediaObject) => ({
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
  }));
}

function isDeterministicLocalUploadTarget(uploadUrl: string): boolean {
  return uploadUrl.startsWith("https://uploads.vayada.localhost/");
}

async function uploadLegacyMarketplaceImages(input: {
  purpose: PlatformMediaPurpose;
  files: File[];
}): Promise<PlatformMediaUploadResult[]> {
  const endpoint = legacyEndpointForPurpose(input.purpose);
  const token = getLegacyBearerToken();
  if (!token) {
    throw new ApiErrorResponse(401, { detail: "Not authenticated" });
  }

  const legacyBaseUrl = stripTrailingSlash(LEGACY_IMAGE_UPLOAD_API_BASE_URL);

  if (endpoint.kind === "single") {
    const file = input.files[0];
    if (!file) return [];

    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(`${legacyBaseUrl}${endpoint.path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const body = await parseLegacyUploadResponseBody(response);
    if (!response.ok) {
      throw new ApiErrorResponse(response.status, {
        detail: legacyUploadErrorDetail(body) ?? "Image upload failed",
      });
    }

    const image = body as LegacyImageUploadResponse;
    return legacyImageToPlatformMediaResult(image, file);
  }

  const formData = new FormData();
  input.files.forEach((file) => formData.append("files", file));

  const response = await fetch(`${legacyBaseUrl}${endpoint.path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const body = await parseLegacyUploadResponseBody(response);
  if (!response.ok) {
    throw new ApiErrorResponse(response.status, {
      detail: legacyUploadErrorDetail(body) ?? "Image upload failed",
    });
  }

  const data = body as LegacyMultipleImageUploadResponse;
  const uploaded = (data.images ?? []).flatMap((image, index) =>
    legacyImageToPlatformMediaResult(image, input.files[index]),
  );
  if (uploaded.length !== input.files.length) {
    throw new ApiErrorResponse(502, { detail: "Not all images were uploaded" });
  }
  return uploaded;
}

function legacyEndpointForPurpose(purpose: PlatformMediaPurpose): {
  kind: "single" | "multiple";
  path: string;
} {
  switch (purpose) {
    case "property.hero_image":
      return { kind: "single", path: "/upload/image/hotel-profile" };
    case "marketplace.creator.profile_image":
      return { kind: "single", path: "/upload/image/creator-profile" };
    case "marketplace.offer.media":
      return { kind: "multiple", path: "/upload/images/listing" };
  }
}

function legacyImageToPlatformMediaResult(
  image: LegacyImageUploadResponse,
  file?: File,
): PlatformMediaUploadResult[] {
  if (!image.url) return [];

  const storageKey = image.key ?? image.url;
  return [
    {
      mediaId: storageKey,
      url: image.url,
      storageKey,
      contentType: file?.type || image.format || "image/jpeg",
      sizeBytes: image.size_bytes ?? file?.size ?? 0,
      widthPx: image.width,
      heightPx: image.height,
      originalFilename: file?.name || storageKey.split("/").pop() || "image",
    },
  ];
}

async function parseLegacyUploadResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function legacyUploadErrorDetail(body: unknown): string | undefined {
  if (typeof body === "string") return body || undefined;
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail?: unknown }).detail;
    return typeof detail === "string" ? detail : undefined;
  }
  return undefined;
}

function shouldUseLegacyMarketplaceImageUpload(): boolean {
  return process.env.NEXT_PUBLIC_MARKETPLACE_LEGACY_UPLOADS_ENABLED === "true";
}

function getLegacyBearerToken(): string | null {
  return getApiBearerToken();
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
