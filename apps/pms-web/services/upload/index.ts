import { uploadPlatformMedia } from "../platform-media";
import type { PlatformMediaResourceScope } from "../platform-media";

export type UploadedImage = {
  url: string;
  platformMediaObjectId?: string;
  storageKey: string;
  width: number;
  height: number;
  size_bytes: number;
  format: string;
};

export type RoomImageReference =
  | string
  | {
      url?: string | null;
      platformMediaObjectId?: string;
      mediaId?: string;
      storageKey?: string;
      altText?: string | null;
    };

export interface MultipleUploadResponse {
  images: UploadedImage[];
  total: number;
}

export function pmsRoomMediaResource(
  propertyId: string,
  roomTypeId?: string,
): PlatformMediaResourceScope {
  return {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
    targetResourceId: roomTypeId || "pending-room-type",
  };
}

export const uploadService = {
  async uploadImages(
    files: File[],
    resource: PlatformMediaResourceScope,
  ): Promise<MultipleUploadResponse> {
    const uploaded = await uploadPlatformMedia({
      purpose: "pms.room_type.media",
      resource,
      files,
      visibility: "public",
    });

    const images = uploaded.flatMap((image) =>
      image?.url
        ? [
            {
              url: image.url,
              platformMediaObjectId: image.mediaId,
              storageKey: image.storageKey,
              width: image.widthPx ?? 0,
              height: image.heightPx ?? 0,
              size_bytes: image.sizeBytes,
              format: image.contentType,
            },
          ]
        : [],
    );

    return {
      images,
      total: images.length,
    };
  },
};

export function imageReferenceUrl(image: RoomImageReference | null | undefined): string {
  if (!image) return "";
  if (typeof image === "string") return image;
  return image.url ?? "";
}

export function isRoomImageReference(
  image: RoomImageReference | null | undefined,
): image is RoomImageReference {
  return imageReferenceUrl(image).trim().length > 0;
}
