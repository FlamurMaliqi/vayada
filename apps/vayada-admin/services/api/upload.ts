/**
 * Upload API service
 */

export interface UploadImageResponse {
  url: string;
  thumbnail_url?: string;
  key?: string;
  width?: number;
  height?: number;
  size_bytes?: number;
  format?: string;
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
    void file;
    void targetUserId;
    throw new Error(
      "Creator profile uploads require Platform/Admin media publication. See VAY-984.",
    );
  },

  /**
   * Upload multiple image files for listing
   * @param files - Array of image files to upload
   * @param targetUserId - The user ID of the hotel (required for proper organization)
   * @returns The upload response with array of image URLs and metadata
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
