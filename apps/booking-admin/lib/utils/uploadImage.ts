import {
  getAuthBearerToken,
  getAuthKitAccessToken,
  getScopedBookingHotelIds,
} from "@/services/auth/sessionStore";

const PLATFORM_MEDIA_API_BASE_URL =
  process.env.NEXT_PUBLIC_PLATFORM_MEDIA_API_URL ||
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  "https://api.localhost";
export const MAX_PROPERTY_GALLERY_PHOTOS = 10;
const GALLERY_UPLOAD_TIMEOUT_MS = 30_000;

type BookingMediaPurpose =
  | "property.hero_image"
  | "property.gallery_image"
  | "booking.header_logo"
  | "booking.addon.image";

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
    variants: Array<{ publicCdnUrl: string | null; storageKey: string }>;
  }>;
};

type CanonicalGalleryUploadResponse = {
  contractVersion: "platform-media-upload.v2";
  uploadSession: { sessionId: string; status: "signed" | "completed" };
  uploadTargets: UploadTarget[];
  mediaObjects?: Array<{
    clientFileId?: string;
    mediaObjectId: string;
    purpose: "property.gallery_image";
    status: "private_ready";
  }>;
};

export async function uploadPropertyGalleryImages(
  files: File[],
  propertyId: string,
): Promise<string[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_PROPERTY_GALLERY_PHOTOS) {
    throw new Error(`A property gallery accepts at most ${MAX_PROPERTY_GALLERY_PHOTOS} photos.`);
  }

  try {
    return await performPropertyGalleryUpload(files, propertyId);
  } catch (error) {
    if (isTimeoutError(error)) throw new Error("Gallery upload timed out. Try again.");
    throw error;
  }
}

async function performPropertyGalleryUpload(files: File[], propertyId: string): Promise<string[]> {
  const token = getAuthKitAccessToken() ?? getAuthBearerToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const requestFiles = files.map((file, index) => ({
    clientFileId: `file_${index + 1}`,
    filename: file.name || `property-gallery-${index + 1}.jpg`,
    contentType: file.type || "image/jpeg",
    sizeBytes: file.size,
  }));
  const create = await fetch(`${PLATFORM_MEDIA_API_BASE_URL}/api/media/upload-sessions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(GALLERY_UPLOAD_TIMEOUT_MS),
    body: JSON.stringify({
      idempotencyKey: `booking.property-gallery.upload:${propertyId}:${crypto.randomUUID()}`,
      purpose: "property.gallery_image",
      visibility: "private",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
      },
      files: requestFiles,
    }),
  });
  if (!create.ok) throw new Error(await readMediaError(create, "Upload session failed"));
  const created = (await create.json()) as CanonicalGalleryUploadResponse;
  if (created.uploadSession.status === "completed") {
    return galleryMediaObjectIds(
      created,
      requestFiles.map(({ clientFileId }) => clientFileId),
    );
  }

  const uploadByClientFileId = new Map(
    requestFiles.map((requestFile, index) => [
      requestFile.clientFileId,
      { file: files[index]!, requestFile },
    ]),
  );
  const orderedTargets = requestFiles.map((requestFile) =>
    created.uploadTargets.find((target) => target.clientFileId === requestFile.clientFileId),
  );
  if (
    created.uploadTargets.length !== requestFiles.length ||
    orderedTargets.some((target) => !target) ||
    new Set(created.uploadTargets.map(({ clientFileId }) => clientFileId)).size !==
      created.uploadTargets.length ||
    new Set(created.uploadTargets.map(({ uploadTargetId }) => uploadTargetId)).size !==
      created.uploadTargets.length
  ) {
    throw new Error("Platform media returned invalid upload targets.");
  }
  const validTargets = orderedTargets as UploadTarget[];

  await Promise.all(
    validTargets.map(async (target) => {
      const upload = uploadByClientFileId.get(target.clientFileId);
      if (!upload) throw new Error("Platform media returned an invalid upload target.");
      if (isDeterministicLocalUploadTarget(target.uploadUrl)) return;
      const response = await fetch(target.uploadUrl, {
        method: target.method,
        headers: target.headers,
        body: upload.file,
        signal: AbortSignal.timeout(GALLERY_UPLOAD_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("Upload failed");
    }),
  );

  const finalized = await fetch(
    `${PLATFORM_MEDIA_API_BASE_URL}/api/media/upload-sessions/${created.uploadSession.sessionId}/finalize`,
    {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(GALLERY_UPLOAD_TIMEOUT_MS),
      body: JSON.stringify({
        files: validTargets.map((target) => {
          const requestFile = uploadByClientFileId.get(target.clientFileId)?.requestFile;
          if (!requestFile) throw new Error("Platform media returned an invalid upload target.");
          return {
            uploadTargetId: target.uploadTargetId,
            contentType: requestFile.contentType,
            sizeBytes: requestFile.sizeBytes,
          };
        }),
      }),
    },
  );
  if (!finalized.ok) throw new Error(await readMediaError(finalized, "Upload finalize failed"));
  return galleryMediaObjectIds(
    (await finalized.json()) as CanonicalGalleryUploadResponse,
    requestFiles.map(({ clientFileId }) => clientFileId),
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

export type UploadedImage = {
  mediaObjectId: string;
  publicUrl: string;
};

async function uploadImageRecords(
  files: File | File[],
  purpose: BookingMediaPurpose = "property.gallery_image",
  explicitBookingHotelId?: string,
  expectedProfileRevision?: number,
): Promise<UploadedImage[]> {
  const fileList = Array.isArray(files) ? files : [files];
  if (fileList.length === 0) return [];

  const profileRevision = validateExpectedProfileRevision(purpose, expectedProfileRevision);
  const token = getAuthKitAccessToken() ?? getAuthBearerToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const bookingHotelId = getBookingHotelUploadResourceId(explicitBookingHotelId);

  const create = await fetch(`${PLATFORM_MEDIA_API_BASE_URL}/api/media/upload-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      purpose,
      visibility: "public",
      ...(profileRevision === undefined ? {} : { expectedProfileRevision: profileRevision }),
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: bookingHotelId,
      },
      files: fileList.map((file, index) => ({
        clientFileId: `file_${index + 1}`,
        filename: file.name || `booking-image-${index + 1}.jpg`,
        contentType: uploadContentType(file),
        sizeBytes: file.size,
      })),
    }),
  });

  if (!create.ok) throw new Error(await readMediaError(create, "Upload session failed"));
  const createBody = (await create.json()) as UploadSessionResponse;

  await Promise.all(
    createBody.uploadTargets.map(async (target, index) => {
      const file = fileList[index];
      if (!file || isDeterministicLocalUploadTarget(target.uploadUrl)) return;

      const upload = await fetch(target.uploadUrl, {
        method: target.method,
        headers: target.headers,
        body: file,
      });

      if (!upload.ok) throw new Error("Upload failed");
    }),
  );

  const finalized = await fetch(
    `${PLATFORM_MEDIA_API_BASE_URL}/api/media/upload-sessions/${createBody.uploadSession.sessionId}/finalize`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        files: createBody.uploadTargets.map((target, index) => {
          const file = fileList[index]!;
          return {
            uploadTargetId: target.uploadTargetId,
            contentType: uploadContentType(file),
            sizeBytes: file.size,
          };
        }),
      }),
    },
  );

  if (!finalized.ok) throw new Error(await readMediaError(finalized, "Upload finalize failed"));
  const finalizedBody = (await finalized.json()) as FinalizeResponse;
  return finalizedBody.mediaObjects.map((mediaObject) => {
    if (!mediaObject.mediaId) throw new Error("Platform media did not return a media object ID");
    const publicUrl = mediaObject.variants.find((variant) =>
      variant.publicCdnUrl?.startsWith("https://"),
    )?.publicCdnUrl;
    if (!publicUrl) throw new Error("Platform media did not return a public HTTPS image URL");
    return { mediaObjectId: mediaObject.mediaId, publicUrl };
  });
}

export async function uploadImages(
  files: File | File[],
  purpose: BookingMediaPurpose = "property.gallery_image",
  explicitBookingHotelId?: string,
  expectedProfileRevision?: number,
): Promise<string[]> {
  const images = await uploadImageRecords(
    files,
    purpose,
    explicitBookingHotelId,
    expectedProfileRevision,
  );
  return images.map(({ publicUrl }) => publicUrl);
}

export async function uploadSingleImage(
  file: File,
  purpose: BookingMediaPurpose = "property.gallery_image",
  explicitBookingHotelId?: string,
  expectedProfileRevision?: number,
): Promise<string> {
  const urls = await uploadImages(file, purpose, explicitBookingHotelId, expectedProfileRevision);
  if (!urls[0]) throw new Error("No image URL returned");
  return urls[0];
}

export async function uploadSingleImageWithMediaReference(
  file: File,
  purpose: BookingMediaPurpose,
  explicitBookingHotelId?: string,
): Promise<UploadedImage> {
  const images = await uploadImageRecords(file, purpose, explicitBookingHotelId);
  if (!images[0]) throw new Error("No image returned");
  return images[0];
}

function validateExpectedProfileRevision(
  purpose: BookingMediaPurpose,
  expectedProfileRevision?: number,
): number | undefined {
  if (purpose !== "property.hero_image") return undefined;
  if (
    expectedProfileRevision === undefined ||
    !Number.isSafeInteger(expectedProfileRevision) ||
    expectedProfileRevision < 1 ||
    expectedProfileRevision > 2_147_483_647
  ) {
    throw new Error("A valid property profile revision is required for hero image uploads.");
  }
  return expectedProfileRevision;
}

function uploadContentType(file: File): string {
  if (file.type) return file.type;
  if (/\.svg$/i.test(file.name)) return "image/svg+xml";
  if (/\.png$/i.test(file.name)) return "image/png";
  return "image/jpeg";
}

function isDeterministicLocalUploadTarget(uploadUrl: string): boolean {
  return uploadUrl.startsWith("https://uploads.vayada.localhost/");
}

function getBookingHotelUploadResourceId(explicitBookingHotelId?: string): string {
  const explicitId = explicitBookingHotelId?.trim();
  if (explicitId) {
    if (!getScopedBookingHotelIds().includes(explicitId)) {
      throw new Error("Booking hotel is outside the active organization scope.");
    }
    return explicitId;
  }

  if (typeof window !== "undefined") {
    const selectedHotelId = localStorage.getItem("selectedHotelId");
    if (selectedHotelId) return selectedHotelId;
  }

  const scopedHotelId = getScopedBookingHotelIds()[0];
  if (scopedHotelId) return scopedHotelId;

  return "booking_hotel_current";
}

async function readMediaError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown; code?: unknown };
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    if (typeof body.code === "string") return body.code;
  } catch {
    /* ignore */
  }
  return fallback;
}

function galleryMediaObjectIds(
  response: CanonicalGalleryUploadResponse,
  clientFileIds: readonly string[],
): string[] {
  if (
    response.contractVersion !== "platform-media-upload.v2" ||
    response.mediaObjects?.length !== clientFileIds.length ||
    response.mediaObjects.some(
      (item) =>
        item.purpose !== "property.gallery_image" ||
        item.status !== "private_ready" ||
        !item.mediaObjectId,
    )
  ) {
    throw new Error("Platform media did not return the uploaded property photos.");
  }
  const returnedClientFileIds = response.mediaObjects.map(({ clientFileId }) => clientFileId);
  if (returnedClientFileIds.some(Boolean)) {
    if (
      returnedClientFileIds.some((clientFileId) => !clientFileId) ||
      new Set(returnedClientFileIds).size !== clientFileIds.length
    ) {
      throw new Error("Platform media did not return the uploaded property photos.");
    }
    return clientFileIds.map((clientFileId) => {
      const mediaObject = response.mediaObjects!.find(
        (candidate) => candidate.clientFileId === clientFileId,
      );
      if (!mediaObject) {
        throw new Error("Platform media did not return the uploaded property photos.");
      }
      return mediaObject.mediaObjectId;
    });
  }
  // The v2 API serializes completed media in the original session-file order.
  return response.mediaObjects.map(({ mediaObjectId }) => mediaObjectId);
}
