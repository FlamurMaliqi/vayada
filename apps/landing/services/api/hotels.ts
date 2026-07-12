/**
 * Hotel API service
 */

import type {
  Hotel,
  PaginatedResponse,
  HotelProfile,
  HotelListing,
  HotelProfileStatus,
} from "@/lib/types";
import { transformHotelListingToHotel, transformListingMarketplaceResponse } from "@/lib/utils";
import {
  getAllMarketplaceOffers,
  type MarketplaceOfferReadModel,
  type MarketplaceCompensationOptionSummary,
  type MarketplacePlatformName,
} from "@vayada/marketplace-shared/api/discovery";
import { apiClient } from "./client";

// Backend API response type for marketplace endpoint (snake_case)
interface ListingMarketplaceResponse {
  id: string;
  hotel_profile_id: string;
  hotel_name: string;
  hotel_picture: string | null;
  name: string;
  location: string;
  description: string;
  accommodation_type: string | null;
  images: string[];
  status: "pending" | "verified" | "rejected";
  collaboration_offerings: Array<{
    id: string;
    listing_id: string;
    collaboration_type: "Free Stay" | "Paid" | "Discount" | "Affiliate";
    availability_months: string[];
    platforms: string[];
    free_stay_min_nights: number | null;
    free_stay_max_nights: number | null;
    paid_max_amount: string | null; // Backend returns as string (e.g., "2000.00")
    currency: string | null;
    discount_percentage: number | null;
    commission_percentage: number | null;
    min_followers: number | null;
    created_at: string;
    updated_at: string;
  }>;
  creator_requirements?: {
    id: string;
    listing_id: string;
    platforms: string[];
    target_countries: string[];
    target_age_min: number | null;
    target_age_max: number | null;
    target_age_groups?: string[] | null;
    created_at: string;
    updated_at: string;
  };
  created_at: string;
}

// Request/Response types for hotel profile endpoints
// Partial update for hotel profile (PUT /hotels/me)
// Send only changed fields; omitted fields stay untouched.
export interface UpdateHotelProfileRequest {
  name?: string;
  location?: string;
  email?: string;
  about?: string;
  website?: string;
  phone?: string;
  picture?: string | null; // allow clearing or replacing
}

export interface CreateListingRequest {
  name: string;
  location: string;
  description: string;
  accommodation_type?: string;
  images?: string[];
  collaboration_offerings: Array<{
    collaboration_type: "Free Stay" | "Paid" | "Discount" | "Affiliate";
    availability_months: string[];
    platforms: string[];
    free_stay_min_nights?: number;
    free_stay_max_nights?: number;
    paid_max_amount?: number;
    currency?: string;
    discount_percentage?: number;
    commission_percentage?: number;
  }>;
  creator_requirements: {
    platforms: string[];
    target_countries: string[];
    target_age_min?: number | null;
    target_age_max?: number | null;
    target_age_groups?: string[] | null;
  };
}

export type UpdateListingRequest = Partial<CreateListingRequest>;

export interface UploadPictureResponse {
  url: string;
}

export interface UploadImagesResponse {
  urls: string[];
}

export const hotelService = {
  /**
   * Get all hotel listings (public marketplace endpoint - returns direct array)
   */
  getAll: async (params?: { page?: number; limit?: number }): Promise<PaginatedResponse<Hotel>> => {
    const response = (await getAllMarketplaceOffers()).map(toLegacyListingMarketplaceResponse);

    // Transform API response to frontend format
    const hotels = response.map(transformListingMarketplaceResponse);

    // Return as paginated response for consistency with frontend expectations
    return {
      data: hotels,
      pagination: {
        page: params?.page || 1,
        limit: params?.limit || hotels.length,
        total: hotels.length,
        totalPages: 1,
      },
    };
  },

  /**
   * Get hotel by ID (public)
   */
  getById: async (id: string): Promise<Hotel> => {
    const listing = await apiClient.get<HotelListing>(`/hotels/${id}`);
    return transformHotelListingToHotel(listing);
  },

  /**
   * Get current hotel's profile with all listings
   * GET /hotels/me
   */
  getMyProfile: async (): Promise<HotelProfile> => {
    return apiClient.get<HotelProfile>("/hotels/me");
  },

  /**
   * Update hotel profile
   * PUT /hotels/me
   */
  updateMyProfile: async (data: UpdateHotelProfileRequest | FormData): Promise<HotelProfile> => {
    // If FormData, use upload method; otherwise use regular put
    if (data instanceof FormData) {
      return apiClient.upload<HotelProfile>("/hotels/me", data, { method: "PUT" });
    }
    return apiClient.put<HotelProfile>("/hotels/me", data);
  },

  /**
   * Upload hotel profile picture (recommended flow)
   * POST /upload/image/hotel-profile
   * Returns URL and metadata to include in profile update
   */
  uploadProfileImage: async (
    file: File,
  ): Promise<{
    url: string;
    thumbnail_url?: string;
    key?: string;
    width?: number;
    height?: number;
    size_bytes?: number;
    format?: string;
  }> => {
    const formData = new FormData();
    formData.append("file", file);
    return apiClient.upload<{
      url: string;
      thumbnail_url?: string;
      key?: string;
      width?: number;
      height?: number;
      size_bytes?: number;
      format?: string;
    }>("/upload/image/hotel-profile", formData);
  },

  /**
   * Upload hotel profile picture (legacy method)
   * POST /hotels/me/upload-picture
   * @deprecated Use uploadProfileImage() instead (recommended flow)
   */
  uploadPicture: async (file: File): Promise<UploadPictureResponse> => {
    const formData = new FormData();
    formData.append("picture", file);
    return apiClient.upload<UploadPictureResponse>("/hotels/me/upload-picture", formData);
  },

  /**
   * Create new listing
   * POST /hotels/me/listings
   */
  createListing: async (data: CreateListingRequest): Promise<HotelListing> => {
    return apiClient.post<HotelListing>("/hotels/me/listings", data);
  },

  /**
   * Update existing listing
   * PUT /hotels/me/listings/:id
   */
  updateListing: async (id: string, data: UpdateListingRequest): Promise<HotelListing> => {
    return apiClient.put<HotelListing>(`/hotels/me/listings/${id}`, data);
  },

  /**
   * Delete listing
   * DELETE /hotels/me/listings/:id
   */
  deleteListing: async (id: string): Promise<void> => {
    return apiClient.delete<void>(`/hotels/me/listings/${id}`);
  },

  /**
   * Upload listing images (standalone - before creating/updating listing)
   * POST /upload/images/listing
   * Returns array of image URLs to include in listing creation/update
   */
  uploadListingImages: async (files: File[]): Promise<{ images: Array<{ url: string }> }> => {
    const formData = new FormData();
    files.forEach((file) => {
      formData.append("files", file);
    });
    return apiClient.upload<{ images: Array<{ url: string }> }>("/upload/images/listing", formData);
  },

  /**
   * Upload listing images to existing listing (legacy method)
   * POST /hotels/me/listings/:id/upload-images
   * @deprecated Use uploadListingImages() and include URLs in listing update instead
   */
  uploadListingImagesToExisting: async (
    id: string,
    files: File[],
  ): Promise<UploadImagesResponse> => {
    const formData = new FormData();
    files.forEach((file) => {
      formData.append("images", file);
    });
    return apiClient.upload<UploadImagesResponse>(
      `/hotels/me/listings/${id}/upload-images`,
      formData,
    );
  },

  // Legacy methods (kept for backward compatibility)
  /**
   * Create hotel (legacy)
   */
  create: async (data: Partial<Hotel>): Promise<Hotel> => {
    return apiClient.post<Hotel>("/hotels", data);
  },

  /**
   * Update hotel (legacy)
   */
  update: async (id: string, data: Partial<Hotel>): Promise<Hotel> => {
    return apiClient.put<Hotel>(`/hotels/${id}`, data);
  },

  /**
   * Delete hotel (legacy)
   */
  delete: async (id: string): Promise<void> => {
    return apiClient.delete<void>(`/hotels/${id}`);
  },

  /**
   * Get hotel profile completion status
   * GET /hotels/me/profile-status
   */
  getProfileStatus: async (): Promise<HotelProfileStatus> => {
    return apiClient.get<HotelProfileStatus>("/hotels/me/profile-status");
  },
};

function toLegacyListingMarketplaceResponse(
  offer: MarketplaceOfferReadModel,
): ListingMarketplaceResponse {
  return {
    id: offer.offerId,
    hotel_profile_id: offer.offerPublicId,
    hotel_name: offer.hotelName,
    hotel_picture: offer.hotelCoverImageUrl,
    name: offer.offerTitle,
    location: offer.hotelLocation.displayText,
    description: offer.offerSummary ?? "",
    accommodation_type: null,
    images: offer.hotelImageUrls,
    status: "verified",
    collaboration_offerings: offer.compensationOptions.map((option) =>
      toLegacyCompensationOption(option, offer),
    ),
    creator_requirements: offer.creatorRequirements
      ? {
          id: `${offer.offerId}:requirements`,
          listing_id: offer.offerId,
          platforms: offer.creatorRequirements.platforms.map(toLegacyPlatformName),
          target_countries: offer.creatorRequirements.targetCountries,
          target_age_min: offer.creatorRequirements.targetAgeMin,
          target_age_max: offer.creatorRequirements.targetAgeMax,
          target_age_groups: offer.creatorRequirements.targetAgeGroups,
          created_at: offer.createdAt,
          updated_at: offer.projectedAt,
        }
      : undefined,
    created_at: offer.createdAt,
  };
}

function toLegacyCompensationOption(
  option: MarketplaceCompensationOptionSummary,
  offer: MarketplaceOfferReadModel,
): ListingMarketplaceResponse["collaboration_offerings"][number] {
  return {
    id: option.compensationOptionId,
    listing_id: offer.offerId,
    collaboration_type: toLegacyCompensationType(option.compensationType),
    availability_months: option.availabilityMonths,
    platforms: option.platforms.map(toLegacyPlatformName),
    free_stay_min_nights: option.freeStayMinNights,
    free_stay_max_nights: option.freeStayMaxNights,
    paid_max_amount: option.paidMaxAmount,
    currency: option.currency,
    discount_percentage: option.discountPercentage,
    commission_percentage: option.commissionPercentage,
    min_followers: option.minFollowers,
    created_at: offer.createdAt,
    updated_at: offer.projectedAt,
  };
}

function toLegacyCompensationType(
  type: MarketplaceCompensationOptionSummary["compensationType"],
): "Free Stay" | "Paid" | "Discount" | "Affiliate" {
  switch (type) {
    case "paid":
      return "Paid";
    case "discount":
      return "Discount";
    case "affiliate":
      return "Affiliate";
    case "free_stay":
      return "Free Stay";
  }
}

function toLegacyPlatformName(platform: MarketplacePlatformName): string {
  switch (platform) {
    case "instagram":
      return "Instagram";
    case "tiktok":
      return "TikTok";
    case "youtube":
      return "YouTube";
    case "facebook":
      return "Facebook";
    case "blog":
      return "Blog";
    case "x":
      return "X";
    case "other":
      return "Other";
  }
}
