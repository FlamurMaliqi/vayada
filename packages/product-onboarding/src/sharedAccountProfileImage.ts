const SHARED_ACCOUNT_PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const SHARED_ACCOUNT_PROFILE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type SharedAccountProfileImageUpload = {
  profilePictureUrl: string;
  profilePictureMediaObjectId: string;
};

type SharedAccountProfileImageUploader = (
  userId: string,
  file: File,
) => Promise<SharedAccountProfileImageUpload>;

type SharedAccountProfileImageHttpClient = {
  post<T>(endpoint: string, data?: unknown, options?: RequestInit): Promise<T>;
};

type UploadTarget = {
  uploadTargetId: string;
  method: "PUT";
  uploadUrl: string;
  headers: Record<string, string>;
};

type UploadSessionResponse = {
  uploadSession: { sessionId: string };
  uploadTargets: UploadTarget[];
};

type MediaObject = {
  mediaId: string;
  storageKey: string;
  variants: Array<{ publicCdnUrl: string | null }>;
};

type FinalizeResponse = {
  mediaObjects: MediaObject[];
};

export function sharedAccountProfileImageError(file: File): string | null {
  if (
    ["image/heic", "image/heif"].includes(file.type.toLowerCase()) ||
    /\.(heic|heif)$/i.test(file.name)
  ) {
    return "HEIC and HEIF photos aren’t supported yet. Convert the photo to JPG, PNG, or WebP and try again.";
  }
  if (
    !SHARED_ACCOUNT_PROFILE_IMAGE_TYPES.has(file.type) &&
    !(file.type === "" && /\.(jpe?g|png|webp)$/i.test(file.name))
  ) {
    return "Choose a JPG, PNG, or WebP image.";
  }
  if (file.size === 0) return "Choose an image that isn’t empty.";
  if (file.size > SHARED_ACCOUNT_PROFILE_IMAGE_MAX_BYTES) {
    return "Choose an image smaller than 5 MB.";
  }
  return null;
}

function sharedAccountProfileImageContentType(file: File): string {
  if (file.type) return file.type;
  if (/\.png$/i.test(file.name)) return "image/png";
  if (/\.webp$/i.test(file.name)) return "image/webp";
  return "image/jpeg";
}

export function createSharedAccountProfileImageUploader(
  client: SharedAccountProfileImageHttpClient,
): SharedAccountProfileImageUploader {
  return async (userId, file) => {
    const validationError = sharedAccountProfileImageError(file);
    if (validationError) throw new Error(validationError);
    const contentType = sharedAccountProfileImageContentType(file);

    const created = await client.post<UploadSessionResponse>("/api/media/upload-sessions", {
      purpose: "identity.user.profile_image",
      visibility: "public",
      resource: {
        product: "platform",
        resourceType: "user_profile",
        resourceId: userId,
      },
      files: [
        {
          clientFileId: "profile_image",
          filename: file.name || "profile-image.jpg",
          contentType,
          sizeBytes: file.size,
        },
      ],
    });

    const target = created.uploadTargets[0];
    if (!target) throw new Error("The profile image upload could not be started.");

    if (!target.uploadUrl.startsWith("https://uploads.vayada.localhost/")) {
      const uploaded = await fetch(target.uploadUrl, {
        method: target.method,
        headers: target.headers,
        body: file,
      });
      if (!uploaded.ok) throw new Error("The profile image could not be uploaded.");
    }

    const finalized = await client.post<FinalizeResponse>(
      `/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
      {
        files: [
          {
            uploadTargetId: target.uploadTargetId,
            contentType,
            sizeBytes: file.size,
          },
        ],
      },
    );
    const mediaObject = finalized.mediaObjects[0];
    if (!mediaObject) throw new Error("The profile image upload did not finish.");
    const publicCdnUrl = mediaObject.variants.find((variant) =>
      variant.publicCdnUrl?.startsWith("https://"),
    )?.publicCdnUrl;
    if (!publicCdnUrl) {
      throw new Error("The profile image is still processing. Please try again later.");
    }

    return {
      profilePictureUrl: publicCdnUrl,
      profilePictureMediaObjectId: mediaObject.mediaId,
    };
  };
}
