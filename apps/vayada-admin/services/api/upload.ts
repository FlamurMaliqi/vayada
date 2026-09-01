/**
 * Upload API service
 */

import { uploadPlatformMedia } from "@vayada/marketplace-shared/api/platformMedia";

export interface UploadImageResponse {
  mediaObjectId: string;
  url: string;
}

export interface UploadListingImagesResponse {
  mediaObjectIds: string[];
}

export const uploadService = {
  /**
   * Upload an image file for creator profile
   * @param file - The image file to upload
   * @param targetUserId - The user ID of the creator (required for proper organization)
   * @returns The upload response with URL and metadata
   */
  uploadCreatorProfileImage: async (
    file: File,
    targetUserId: string,
  ): Promise<UploadImageResponse> => {
    const [uploaded] = await uploadPlatformMedia({
      purpose: "marketplace.creator.profile_image",
      visibility: "public",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: targetUserId,
      },
      files: [file],
      idempotencyKey: `admin:creator-profile:${targetUserId}`,
    });
    if (!uploaded || !isPublicUrl(uploaded.url)) {
      throw new Error("The creator profile image is still processing. Please try again later.");
    }
    return {
      mediaObjectId: uploaded.mediaId,
      url: uploaded.url,
    };
  },

  /**
   * Upload multiple image files for listing
   * @param files - Array of image files to upload
   * @param offerId - The exact Marketplace offer that owns the media
   * @returns The upload response with media object IDs
   */
  uploadListingImages: async (
    files: File[],
    offerId: string,
  ): Promise<UploadListingImagesResponse> => {
    const uploaded = await uploadPlatformMedia({
      purpose: "marketplace.offer.media",
      visibility: "private",
      resource: {
        product: "marketplace",
        resourceType: "marketplace_offer",
        resourceId: offerId,
      },
      files,
      idempotencyKey: `admin:offer:${offerId}`,
    });
    if (uploaded.length !== files.length) {
      throw new Error("Not every selected offer image finished uploading.");
    }
    return {
      mediaObjectIds: uploaded.map((image) => image.mediaId),
    };
  },

  /**
   * Upload an image file for hotel profile
   * @param file - The image file to upload
   * @param targetUserId - The user ID of the hotel (required for proper organization)
   * @returns The upload response with URL and metadata
   */
  uploadHotelProfileImage: async (
    file: File,
    targetUserId: string,
  ): Promise<UploadImageResponse> => {
    void file;
    void targetUserId;
    throw new Error("Hotel profile uploads require Platform/Admin media publication. See VAY-984.");
  },
};

function isPublicUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
