import { ApiClient, ApiErrorResponse } from "../api/client";

const PLATFORM_MEDIA_API_BASE_URL =
  process.env.NEXT_PUBLIC_PLATFORM_MEDIA_API_URL || "https://api.localhost";

const platformMediaClient = new ApiClient(PLATFORM_MEDIA_API_BASE_URL);

export type PlatformMediaResourceScope = {
  product: "hotel_catalog";
  resourceType: "property";
  resourceId: string;
  propertyId: string;
  targetResourceId?: string;
};

export type PlatformMediaUploadResult = {
  mediaId: string;
  url: string;
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
    mediaObjectId: string;
    status: "public_ready";
    publicVariants: Array<{ variantName: string; publicUrl: string }>;
  }>;
};

export async function uploadPlatformMedia(input: {
  purpose: "pms.room_type.media";
  resource: PlatformMediaResourceScope;
  files: File[];
  visibility?: "public" | "private";
}): Promise<PlatformMediaUploadResult[]> {
  if (input.files.length === 0) return [];

  const create = await platformMediaClient.post<UploadSessionResponse>(
    "/api/media/upload-sessions",
    {
      purpose: input.purpose,
      visibility: input.visibility ?? "public",
      resource: input.resource,
      files: input.files.map((file, index) => ({
        clientFileId: `file_${index + 1}`,
        filename: file.name || `room-image-${index + 1}.jpg`,
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

  const finalized = await platformMediaClient.post<FinalizeResponse>(
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
    mediaId: mediaObject.mediaObjectId,
    url:
      mediaObject.publicVariants.find(({ variantName }) => variantName === "thumbnail")
        ?.publicUrl ??
      mediaObject.publicVariants[0]?.publicUrl ??
      "",
  }));
}

function isDeterministicLocalUploadTarget(uploadUrl: string): boolean {
  return uploadUrl.startsWith("https://uploads.vayada.localhost/");
}
