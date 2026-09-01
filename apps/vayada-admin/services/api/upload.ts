/**
 * Upload API service
 */

import { uploadPlatformMedia } from "@vayada/marketplace-shared/api/platformMedia";

export interface UploadImageResponse {
  mediaObjectId: string;
  url: string;
}

export interface UploadListingImagesResponse {
  images: UploadImageResponse[];
  total: number;
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
   * @param targetUserId - The user ID of the hotel
   * @returns The upload response with array of images
   */
  uploadListingImages: async (
    files: File[],
    targetUserId: string,
  ): Promise<UploadListingImagesResponse> => {
    void files;
    void targetUserId;
    throw new Error("Offer uploads require Platform/Admin media publication. See VAY-984.");
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
