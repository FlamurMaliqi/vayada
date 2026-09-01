/**
 * Users API service for admin
 */

import { apiClient } from "./client";
import {
  createMarketplaceAdminOffer,
  deleteMarketplaceAdminOffer,
  getMarketplaceAdminHotelReview,
  updateMarketplaceAdminOffer,
  verifyMarketplaceAdminOffer,
  type MarketplaceAdminCreateOfferRequest,
  type MarketplaceAdminHotelReviewResponse,
  type MarketplaceAdminOffer,
  type MarketplaceAdminUpdateOfferRequest,
  type MarketplaceOfferCreatorRequirementsWrite,
  type MarketplaceOfferCompensationOptionWrite,
} from "@vayada/marketplace-shared/api/admin";
import type {
  CollaborationOffering,
  CreateUserRequest,
  CreatorRequirements,
  HotelProfileDetail,
  ListingResponse,
  User,
  UserDetailResponse,
} from "@/lib/types";

export interface UsersListResponse {
  users: User[];
  total: number;
}

export interface IdentityCommandResponse {
  userId: string;
  status: "accepted" | "idempotent_replay";
  commands: Array<{
    commandType: string;
    commandId: string;
    idempotencyKey: string;
    status: "accepted" | "idempotent_replay";
  }>;
}

/**
 * Transform snake_case to camelCase for nested objects
 */
function transformSnakeToCamel(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => transformSnakeToCamel(item));
  }
  if (typeof obj !== "object") return obj;

  const transformed: any = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    transformed[camelKey] = transformSnakeToCamel(value);
  }
  return transformed;
}

export const usersService = {
  /**
   * Get all users (with optional filters and pagination)
   */
  getAllUsers: async (params?: {
    type?: "hotel" | "creator" | "admin";
    status?: "pending" | "verified" | "rejected" | "suspended";
    search?: string;
    page?: number;
    page_size?: number;
  }): Promise<UsersListResponse> => {
    const queryParams = new URLSearchParams();

    // Add query parameters if provided
    if (params?.page) queryParams.append("page", params.page.toString());
    if (params?.page_size) queryParams.append("page_size", params.page_size.toString());
    if (params?.type) queryParams.append("type", params.type);
    if (params?.status) queryParams.append("status", params.status);
    if (params?.search) queryParams.append("search", params.search);

    const queryString = queryParams.toString();
    const endpoint = `/api/identity/admin/users${queryString ? `?${queryString}` : ""}`;

    return apiClient.get<UsersListResponse>(endpoint);
  },

  /**
   * Get user by ID with full details (profile, platforms, listings)
   */
  getUserById: async (userId: string): Promise<UserDetailResponse> => {
    const response = await apiClient.get<any>(`/api/identity/admin/users/${userId}`);
    const identityUser = transformSnakeToCamel(response) as UserDetailResponse;
    if (identityUser.type !== "hotel") return identityUser;
    const review = await getMarketplaceAdminHotelReview(userId);
    return {
      ...identityUser,
      profile: review.profile ? toHotelProfileDetail(identityUser, review) : null,
    };
  },

  /**
   * Create a new identity user. Product profile writes are handled separately
   * by their owning target admin routes.
   */
  createUser: async (data: CreateUserRequest): Promise<User> => {
    const response = await apiClient.post<IdentityCommandResponse>("/api/identity/admin/users", {
      email: data.email,
      name: data.name,
      type: data.type,
      status: data.status,
      emailVerified: data.emailVerified,
    });
    return {
      id: response.userId,
      email: data.email,
      name: data.name,
      type: data.type,
      status: data.status ?? "pending",
      email_verified: data.emailVerified,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  },

  /**
   * Update user account fields (status, emailVerified, email, name, etc.)
   */
  updateUser: async (
    userId: string,
    data: {
      status?: "pending" | "verified" | "rejected" | "suspended";
      emailVerified?: boolean;
      email?: string;
      name?: string;
    },
  ): Promise<any> => {
    const response = await apiClient.patch<any>(`/api/identity/admin/users/${userId}`, data);
    return transformSnakeToCamel(response);
  },

  /**
   * Update creator profile
   */
  updateCreatorProfile: async (
    userId: string,
    data: {
      name?: string;
      profilePicture?: string;
      profilePictureMediaObjectId?: string | null;
      location?: string;
      shortDescription?: string;
      portfolioLink?: string;
      phone?: string;
      platforms?: Array<{
        name: "Instagram" | "TikTok" | "YouTube" | "Facebook";
        handle: string;
        followers: number;
        engagementRate: number;
        topCountries?: Array<{ country: string; percentage: number }>;
        topAgeGroups?: Array<{ ageRange: string; percentage: number }>;
        genderSplit?: { male: number; female: number; other?: number };
      }>;
    },
  ): Promise<any> => {
    if (Object.keys(data).length === 0) return {};
    const response = await apiClient.put<any>(
      `/api/marketplace/admin/users/${userId}/profile/creator`,
      {
        ...(data.name !== undefined ? { displayName: data.name } : {}),
        ...(data.profilePicture !== undefined ? { profilePictureUrl: data.profilePicture } : {}),
        ...(data.profilePictureMediaObjectId !== undefined
          ? { profilePictureMediaObjectId: data.profilePictureMediaObjectId }
          : {}),
        ...(data.location !== undefined ? { locationText: data.location } : {}),
        ...(data.shortDescription !== undefined ? { shortDescription: data.shortDescription } : {}),
        ...(data.portfolioLink !== undefined ? { portfolioUrl: data.portfolioLink } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        ...(data.platforms !== undefined
          ? {
              platforms: data.platforms.map((platform) => ({
                platform: toMarketplacePlatform(platform.name),
                handle: platform.handle,
                followerCount: platform.followers,
                engagementRate: platform.engagementRate,
                audienceCountries: (platform.topCountries ?? []).map((country) => ({
                  country: country.country,
                  percentage: country.percentage ?? 0,
                })),
                audienceAgeGroups: (platform.topAgeGroups ?? []).map((ageGroup) => ({
                  ageRange: ageGroup.ageRange,
                  percentage: ageGroup.percentage ?? 0,
                })),
                audienceGenderSplit: platform.genderSplit ?? null,
              })),
            }
          : {}),
      },
    );
    return transformSnakeToCamel(response);
  },

  /**
   * Update hotel profile
   */
  updateHotelProfile: async (
    userId: string,
    data: {
      name?: string;
      location?: string;
      email?: string;
      about?: string;
      website?: string;
      phone?: string;
      picture?: string;
    },
  ): Promise<any> => {
    const unsupportedFields = Object.entries(data)
      .filter(([key, value]) => key !== "about" && value !== undefined)
      .map(([key]) => key);
    if (unsupportedFields.length > 0) {
      throw new Error(
        `Hotel profile target route only supports about. Unsupported fields: ${unsupportedFields.join(", ")}.`,
      );
    }
    if (data.about === undefined) return {};
    const response = await apiClient.put<any>(
      `/api/marketplace/admin/users/${userId}/profile/hotel`,
      {
        hostSummary: data.about,
      },
    );
    return transformSnakeToCamel(response);
  },

  /**
   * Create a listing for a hotel user
   */
  createOffer: async (
    hotelUserId: string,
    data: {
      name: string;
      location: string;
      description: string;
      accommodationType?: string;
      images?: string[];
      collaborationOfferings?: any[];
      creatorRequirements?: any;
    },
  ): Promise<MarketplaceAdminOffer> => {
    return createMarketplaceAdminOffer(hotelUserId, toMarketplaceAdminCreateOfferRequest(data));
  },

  /**
   * Update a listing
   */
  updateOffer: async (
    hotelUserId: string,
    listingId: string,
    data: {
      name?: string;
      location?: string;
      description?: string;
      accommodationType?: string;
      images?: string[];
      collaborationOfferings?: any[];
      creatorRequirements?: any;
    },
  ): Promise<any> => {
    const response = await updateMarketplaceAdminOffer(
      hotelUserId,
      listingId,
      toMarketplaceAdminUpdateOfferRequest(data),
    );
    return transformSnakeToCamel(response);
  },

  /**
   * Approve a pending offer and publish its media.
   */
  verifyOffer: async (
    hotelUserId: string,
    listingId: string,
    mediaObjectIds?: string[],
  ): Promise<MarketplaceAdminOffer> =>
    verifyMarketplaceAdminOffer(hotelUserId, listingId, mediaObjectIds),

  /**
   * Delete a listing
   * ⚠️ Warning: This action cannot be undone!
   * Permanently removes the listing, all collaboration offerings, creator requirements, and all images from S3.
   */
  deleteOffer: async (
    hotelUserId: string,
    listingId: string,
  ): Promise<{
    message: string;
    deletedOffer: {
      id: string;
      name: string;
    };
    imagesDeleted: number;
    imagesFailed: number;
  }> => {
    const response = await deleteMarketplaceAdminOffer(hotelUserId, listingId);
    return {
      message: "Offer archived.",
      deletedOffer: {
        id: response.deletedOffer.offerId,
        name: response.deletedOffer.title,
      },
      imagesDeleted: 0,
      imagesFailed: 0,
    };
  },

  /**
   * Soft-delete an identity user through the identity lifecycle command bus.
   */
  deleteUser: async (userId: string): Promise<{ message: string; deleted_user: User }> => {
    const response = await apiClient.delete<IdentityCommandResponse>(
      `/api/identity/admin/users/${userId}`,
    );
    return {
      message: "Identity user deletion command accepted.",
      deleted_user: {
        id: response.userId,
        email: "",
        name: "",
        type: "admin",
        status: "suspended",
        created_at: "",
        updated_at: "",
      },
    };
  },

  setPlatformAccess: async (userId: string, enabled: boolean): Promise<IdentityCommandResponse> => {
    return apiClient.put<IdentityCommandResponse>(
      `/api/identity/admin/users/${userId}/platform-access`,
      { enabled },
    );
  },
};

function toHotelProfileDetail(
  identityUser: UserDetailResponse,
  review: MarketplaceAdminHotelReviewResponse,
): HotelProfileDetail {
  const profile = review.profile!;
  return {
    id: profile.propertyId,
    userId: identityUser.id,
    name: profile.displayName,
    location: profile.location,
    picture: null,
    website: null,
    about: profile.hostSummary,
    email: identityUser.email,
    phone: null,
    status: profile.profileStatus,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    listings: review.offers.map((offer) => toListingResponse(offer, profile.location)),
  };
}

function toListingResponse(offer: MarketplaceAdminOffer, location: string): ListingResponse {
  return {
    id: offer.offerId,
    hotelProfileId: offer.propertyId,
    name: offer.title,
    location,
    description: offer.offerSummary ?? "",
    accommodationType: null,
    media: offer.media,
    images: offer.media.flatMap((media) => (media.url ? [media.url] : [])),
    status: offer.offerStatus,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
    collaborationOfferings: offer.compensationOptions.map((option) =>
      toCollaborationOffering(offer, option),
    ),
    creatorRequirements: offer.creatorRequirements
      ? toCreatorRequirements(offer, offer.creatorRequirements)
      : undefined,
  };
}

function toCollaborationOffering(
  offer: MarketplaceAdminOffer,
  option: MarketplaceAdminOffer["compensationOptions"][number],
): CollaborationOffering {
  const collaborationType = {
    free_stay: "Free Stay",
    paid: "Paid",
    discount: "Discount",
    affiliate: "Affiliate",
  }[option.compensationType] as CollaborationOffering["collaborationType"];
  return {
    id: option.compensationOptionId,
    listingId: offer.offerId,
    collaborationType,
    availabilityMonths: option.availabilityMonths,
    platforms: option.platforms.flatMap(toLegacyPlatformName),
    freeStayMinNights: option.freeStayMinNights,
    freeStayMaxNights: option.freeStayMaxNights,
    paidMaxAmount: toNullableNumber(option.paidMaxAmount),
    currency: option.currency,
    discountPercentage: option.discountPercentage,
    commissionPercentage: option.commissionPercentage,
    minFollowers: option.minFollowers,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  };
}

function toCreatorRequirements(
  offer: MarketplaceAdminOffer,
  requirements: NonNullable<MarketplaceAdminOffer["creatorRequirements"]>,
): CreatorRequirements {
  return {
    id: `${offer.offerId}:creator-requirements`,
    listingId: offer.offerId,
    platforms: requirements.platforms.flatMap(toLegacyPlatformName),
    targetCountries: requirements.targetCountries,
    targetAgeMin: requirements.targetAgeMin,
    targetAgeMax: requirements.targetAgeMax,
    targetAgeGroups: requirements.targetAgeGroups,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  };
}

function toLegacyPlatformName(
  platform: MarketplaceAdminOffer["compensationOptions"][number]["platforms"][number],
): CollaborationOffering["platforms"] {
  switch (platform) {
    case "instagram":
      return ["Instagram"];
    case "tiktok":
      return ["TikTok"];
    case "youtube":
      return ["YouTube"];
    case "facebook":
      return ["Facebook"];
    default:
      return [];
  }
}

function toMarketplaceAdminCreateOfferRequest(data: {
  name: string;
  location: string;
  description: string;
  accommodationType?: string;
  images?: string[];
  collaborationOfferings?: any[];
  creatorRequirements?: any;
}): MarketplaceAdminCreateOfferRequest {
  const compensationOptions = toMarketplaceCompensationOptions(data.collaborationOfferings);
  return {
    title: data.name,
    offerSummary: data.description,
    deliverables: toMarketplaceOfferDeliverables(compensationOptions),
    compensationOptions,
    creatorRequirements: toMarketplaceCreatorRequirements(data.creatorRequirements),
  };
}

function toMarketplaceAdminUpdateOfferRequest(data: {
  name?: string;
  location?: string;
  description?: string;
  accommodationType?: string;
  images?: string[];
  collaborationOfferings?: any[];
  creatorRequirements?: any;
}): MarketplaceAdminUpdateOfferRequest {
  const compensationOptions =
    data.collaborationOfferings === undefined
      ? undefined
      : toMarketplaceCompensationOptions(data.collaborationOfferings);
  return {
    ...(data.name !== undefined ? { title: data.name } : {}),
    ...(data.description !== undefined ? { offerSummary: data.description } : {}),
    ...(compensationOptions !== undefined
      ? {
          deliverables: toMarketplaceOfferDeliverables(compensationOptions),
          compensationOptions,
        }
      : {}),
    ...(data.creatorRequirements !== undefined
      ? { creatorRequirements: toMarketplaceCreatorRequirements(data.creatorRequirements) }
      : {}),
  };
}

function toMarketplaceCompensationOptions(
  offerings: any[] | undefined,
): MarketplaceOfferCompensationOptionWrite[] {
  return (offerings ?? []).map((offering) => ({
    compensationType: toMarketplaceCompensationType(offering.collaborationType),
    availabilityMonths: offering.availabilityMonths ?? [],
    platforms: (offering.platforms ?? []).map(toMarketplacePlatform),
    freeStayMinNights: toNullableNumber(offering.freeStayMinNights),
    freeStayMaxNights: toNullableNumber(offering.freeStayMaxNights),
    paidMaxAmount:
      offering.paidMaxAmount === null || offering.paidMaxAmount === undefined
        ? null
        : String(offering.paidMaxAmount),
    discountPercentage: toNullableNumber(offering.discountPercentage),
    commissionPercentage: toNullableNumber(offering.commissionPercentage),
    minFollowers: toNullableNumber(offering.minFollowers),
    currency: offering.currency ?? null,
    termsSummary: offering.termsSummary ?? null,
  }));
}

function toMarketplaceOfferDeliverables(
  compensationOptions: MarketplaceOfferCompensationOptionWrite[],
): MarketplaceAdminCreateOfferRequest["deliverables"] {
  return Array.from(new Set(compensationOptions.flatMap((option) => option.platforms))).map(
    (platform) => ({
      platform,
      deliverableType: "post",
      quantity: 1,
      timingGuidance: null,
    }),
  );
}

function toMarketplaceCreatorRequirements(
  requirements: any,
): MarketplaceOfferCreatorRequirementsWrite {
  return {
    platforms: (requirements?.platforms ?? []).map(toMarketplacePlatform),
    targetCountries: requirements?.targetCountries ?? [],
    targetAgeMin: toNullableNumber(requirements?.targetAgeMin),
    targetAgeMax: toNullableNumber(requirements?.targetAgeMax),
    targetAgeGroups: requirements?.targetAgeGroups ?? [],
    creatorTypes: requirements?.creatorTypes ?? [],
  };
}

function toMarketplaceCompensationType(
  value: string | undefined,
): MarketplaceOfferCompensationOptionWrite["compensationType"] {
  switch (value) {
    case "Paid":
      return "paid";
    case "Discount":
      return "discount";
    case "Affiliate":
      return "affiliate";
    case "Free Stay":
    default:
      return "free_stay";
  }
}

function toMarketplacePlatform(
  value: string,
): "instagram" | "tiktok" | "youtube" | "facebook" | "blog" | "x" | "other" {
  switch (value) {
    case "Instagram":
      return "instagram";
    case "TikTok":
      return "tiktok";
    case "YouTube":
      return "youtube";
    case "Facebook":
      return "facebook";
    case "Blog":
      return "blog";
    case "X":
      return "x";
    default:
      return "other";
  }
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
