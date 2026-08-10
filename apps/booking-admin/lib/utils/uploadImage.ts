import {
  getAuthBearerToken,
  getAuthKitAccessToken,
  getScopedBookingHotelIds,
} from "@/services/auth/sessionStore";

const PLATFORM_MEDIA_API_BASE_URL =
  process.env.NEXT_PUBLIC_PLATFORM_MEDIA_API_URL ||
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  "https://api.localhost";

type BookingMediaPurpose = "property.hero_image" | "property.gallery_image" | "booking.header_logo";

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
    variants: Array<{ publicCdnUrl: string | null; storageKey: string }>;
  }>;
};

export async function uploadImages(
  files: File | File[],
  purpose: BookingMediaPurpose = "property.gallery_image",
  explicitBookingHotelId?: string,
  expectedProfileRevision?: number,
): Promise<string[]> {
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
    const publicUrl = mediaObject.variants.find((variant) =>
      variant.publicCdnUrl?.startsWith("https://"),
    )?.publicCdnUrl;
    if (!publicUrl) throw new Error("Platform media did not return a public HTTPS image URL");
    return publicUrl;
  });
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
