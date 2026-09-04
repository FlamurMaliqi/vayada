/**
 * Creator API service
 */

import type {
  Creator,
  CreatorPlatformConnection,
  CreatorPlatformPendingAuthorization,
  CreatorPlatformProvider,
  PaginatedResponse,
  CreatorProfileStatus,
} from "@/lib/types";
import { transformCreatorMarketplaceResponse } from "@/lib/utils";
import {
  getAllMarketplaceCreators,
  type MarketplaceCreatorReadModel,
  type MarketplacePlatformName,
} from "@vayada/marketplace-shared/api/discovery";
import type {
  MarketplaceCreatorMatchingPreferences,
  MarketplaceCreatorMatchingPreferencesWrite,
} from "@vayada/domain-marketplace";
import { uploadPlatformMedia } from "@vayada/marketplace-shared/api/platformMedia";
import { targetApiClient } from "./targetClient";

// Backend API response type for marketplace endpoint (snake_case from backend)
interface CreatorMarketplaceResponse {
  id: string;
  name: string;
  location: string;
  short_description: string;
  portfolio_link: string | null;
  profile_picture: string | null;
  creator_type: "Lifestyle" | "Travel" | "Other";
  platforms: Array<{
    id: string;
    name: string;
    handle: string;
    profile_url: string | null;
    followers: number;
    engagement_rate: number;
    top_countries: Array<{ country: string; percentage: number }> | null;
    top_age_groups: Array<{ ageRange: string; percentage: number }> | null;
    gender_split: { male: number; female: number; other?: number } | null;
  }>;
  audience_size: number;
  average_rating: number;
  total_reviews: number;
  created_at: string;
}

type TargetCreatorProfileStatus = {
  profilePhotoRequired: true;
  profileComplete: boolean;
  missingFields: string[];
  missingPlatforms: boolean;
  completionSteps: string[];
};

type TargetCreatorProfile = {
  creatorProfileId: string;
  displayName: string | null;
  creatorType: "lifestyle" | "travel" | "other";
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  phone: string | null;
  profilePictureUrl: string | null;
  profilePictureMediaObjectId?: string | null;
  profileComplete: boolean;
  profileStatus: "pending" | "active" | "rejected" | "suspended" | "archived";
  platforms: TargetCreatorPlatform[];
  audienceSize: number;
  rating: {
    averageRating: number;
    totalReviews: number;
  };
  matchingPreferences: MarketplaceCreatorMatchingPreferences | null;
  createdAt: string;
  updatedAt: string;
};

type TargetCreatorPlatform = {
  platformId: string;
  platform: "instagram" | "tiktok" | "youtube" | "facebook" | "blog" | "x" | "other";
  handle: string;
  profileUrl: string | null;
  followerCount: number;
  engagementRate: number;
  audienceCountries: Array<{ country: string; percentage: number }>;
  audienceAgeGroups: Array<{ ageRange: string; percentage: number }>;
  audienceGenderSplit: { male: number; female: number; other?: number } | null;
};

type TargetUpdateCreatorProfile = {
  displayName?: string;
  creatorType?: "lifestyle" | "travel" | "other";
  locationText?: string | null;
  shortDescription?: string | null;
  portfolioUrl?: string | null;
  phone?: string | null;
  profilePictureUrl?: string | null;
  profilePictureMediaObjectId?: string | null;
  platforms?: Array<{
    platformId?: string | null;
    platform: TargetCreatorPlatform["platform"];
    handle: string;
    profileUrl?: string | null;
    followerCount: number;
    engagementRate: number;
    audienceCountries?: Array<{ country: string; percentage: number }>;
    audienceAgeGroups?: Array<{ ageRange: string; percentage: number }>;
    audienceGenderSplit?: { male: number; female: number; other?: number } | null;
  }>;
};

export const creatorService = {
  /**
   * Get all creators (marketplace endpoint - returns direct array)
   * No query parameters supported - endpoint returns all verified creators with complete profiles
   */
  getAll: async (): Promise<PaginatedResponse<Creator>> => {
    const response = (await getAllMarketplaceCreators()).map(toLegacyCreatorMarketplaceResponse);

    // Transform API response to frontend format
    const creators = response.map(transformCreatorMarketplaceResponse);

    // Return as paginated response for consistency with frontend expectations
    return {
      data: creators,
      pagination: {
        page: 1,
        limit: creators.length,
        total: creators.length,
        totalPages: 1,
      },
    };
  },

  /**
   * Get current creator's profile
   * GET /api/marketplace/creators/me
   */
  getMyProfile: async (options?: RequestInit): Promise<Creator> => {
    return toLegacyCreator(
      await targetApiClient.get<TargetCreatorProfile>("/api/marketplace/creators/me", options),
    );
  },

  /**
   * Update creator profile
   * PUT /api/marketplace/creators/me
   * Accepts JSON only (no FormData support)
   */
  updateMyProfile: async (data: Partial<Creator>): Promise<Creator> => {
    return toLegacyCreator(
      await targetApiClient.put<TargetCreatorProfile>(
        "/api/marketplace/creators/me",
        toTargetCreatorUpdate(data),
      ),
    );
  },

  updateMatchingPreferences: async (
    matchingPreferences: MarketplaceCreatorMatchingPreferencesWrite | null,
  ): Promise<Creator> => {
    return toLegacyCreator(
      await targetApiClient.put<TargetCreatorProfile>("/api/marketplace/creators/me", {
        matchingPreferences,
      }),
    );
  },

  getPlatformConnections: async (options?: RequestInit): Promise<CreatorPlatformConnection[]> => {
    const result = await targetApiClient.get<{ connections: CreatorPlatformConnection[] }>(
      "/api/marketplace/creators/me/platform-connections",
      options,
    );
    return result.connections;
  },

  startPlatformAuthorization: async (
    platform: CreatorPlatformProvider,
    platformId?: string,
  ): Promise<{ authorizationUrl: string }> => {
    const result = await targetApiClient.post<{ authorizationUrl: string }>(
      `/api/marketplace/creators/me/platform-connections/${platform}/authorize`,
      platformId ? { platformId } : undefined,
    );
    if (!isAbsoluteHttpsUrl(result.authorizationUrl)) {
      throw new Error("The platform authorization URL is invalid");
    }
    return result;
  },

  getPendingPlatformAuthorization: async (
    options?: RequestInit,
  ): Promise<CreatorPlatformPendingAuthorization | null> => {
    return targetApiClient.get<CreatorPlatformPendingAuthorization | null>(
      "/api/marketplace/creators/me/platform-authorizations/pending",
      options,
    );
  },

  selectPlatformAuthorizationAccount: async (
    authorizationId: string,
    externalAccountId: string,
  ): Promise<void> => {
    await targetApiClient.post(
      `/api/marketplace/creators/me/platform-authorizations/${encodeURIComponent(authorizationId)}/accounts`,
      { externalAccountId },
    );
  },

  syncPlatformConnection: async (connectionId: string): Promise<void> => {
    await targetApiClient.post(
      `/api/marketplace/creators/me/platform-connections/${encodeURIComponent(connectionId)}/sync`,
    );
  },

  disconnectPlatformConnection: async (connectionId: string): Promise<void> => {
    await targetApiClient.delete(
      `/api/marketplace/creators/me/platform-connections/${encodeURIComponent(connectionId)}`,
    );
  },

  /**
   * Upload creator profile picture through platform media.
   */
  uploadProfilePicture: async (
    file: File,
    creatorProfileId: string,
  ): Promise<{ url: string; mediaObjectId: string }> => {
    const [uploaded] = await uploadPlatformMedia({
      purpose: "marketplace.creator.profile_image",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: creatorProfileId,
      },
      files: [file],
    });
    if (!uploaded) throw new Error("Platform media did not return an uploaded image");
    if (!isAbsoluteHttpsUrl(uploaded.url)) {
      throw new Error("The profile image is still processing. Please try again later.");
    }
    return {
      url: uploaded.url,
      mediaObjectId: uploaded.mediaId,
    };
  },

  /**
   * Get creator profile completion status
   * GET /api/marketplace/creators/me/profile-status
   */
  getProfileStatus: async (options?: RequestInit): Promise<CreatorProfileStatus> => {
    const status = await targetApiClient.get<TargetCreatorProfileStatus>(
      "/api/marketplace/creators/me/profile-status",
      options,
    );
    return {
      profile_photo_required: status.profilePhotoRequired,
      profile_complete: status.profileComplete,
      missing_fields: status.missingFields,
      missing_platforms: status.missingPlatforms,
      completion_steps: status.completionSteps,
    };
  },
};

export function isAbsoluteHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function toTargetCreatorUpdate(data: Partial<Creator>): TargetUpdateCreatorProfile {
  const input = data as Partial<Creator> & {
    profile_picture?: string | null;
    profilePictureMediaObjectId?: string | null;
    profile_picture_media_object_id?: string | null;
  };
  const includesProfilePictureMediaObjectId =
    input.profilePictureMediaObjectId !== undefined ||
    input.profile_picture_media_object_id !== undefined;
  const profilePictureMediaObjectId =
    input.profilePictureMediaObjectId ?? input.profile_picture_media_object_id ?? null;
  return {
    ...(input.name !== undefined ? { displayName: input.name } : {}),
    ...(input.location !== undefined ? { locationText: input.location } : {}),
    ...(input.creatorType !== undefined
      ? { creatorType: toTargetCreatorType(input.creatorType) }
      : {}),
    ...(input.portfolioLink !== undefined ? { portfolioUrl: input.portfolioLink ?? null } : {}),
    ...(input.shortDescription !== undefined
      ? { shortDescription: input.shortDescription ?? null }
      : {}),
    ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
    ...(!includesProfilePictureMediaObjectId &&
    (input.profilePicture !== undefined || input.profile_picture !== undefined)
      ? { profilePictureUrl: input.profilePicture ?? input.profile_picture ?? null }
      : {}),
    ...(includesProfilePictureMediaObjectId ? { profilePictureMediaObjectId } : {}),
    ...(input.platforms !== undefined
      ? {
          platforms: input.platforms.map((platform) => ({
            platformId: platform.id ?? null,
            platform: toTargetPlatformName(platform.name),
            handle: platform.handle,
            ...(platform.profileUrl !== undefined ? { profileUrl: platform.profileUrl } : {}),
            followerCount: Number(platform.followers) || 0,
            engagementRate: Number(platform.engagementRate) || 0,
            ...(platform.topCountries !== undefined
              ? { audienceCountries: platform.topCountries }
              : {}),
            ...(platform.topAgeGroups !== undefined
              ? { audienceAgeGroups: platform.topAgeGroups }
              : {}),
            ...(platform.genderSplit !== undefined
              ? { audienceGenderSplit: platform.genderSplit }
              : {}),
          })),
        }
      : {}),
  };
}

function toLegacyCreator(profile: TargetCreatorProfile): Creator {
  return {
    id: profile.creatorProfileId,
    email: "",
    name: profile.displayName ?? "",
    platforms: profile.platforms.map((platform) => ({
      id: platform.platformId,
      name: toLegacyPlatformName(platform.platform),
      handle: platform.handle,
      profileUrl: platform.profileUrl,
      followers: platform.followerCount,
      engagementRate: platform.engagementRate,
      ...(platform.audienceCountries.length > 0
        ? { topCountries: platform.audienceCountries }
        : {}),
      ...(platform.audienceAgeGroups.length > 0
        ? { topAgeGroups: platform.audienceAgeGroups }
        : {}),
      genderSplit: platform.audienceGenderSplit ?? undefined,
    })),
    audienceSize: profile.audienceSize,
    location: profile.locationText ?? "",
    portfolioLink: profile.portfolioUrl ?? undefined,
    shortDescription: profile.shortDescription ?? undefined,
    phone: profile.phone,
    profilePicture: profile.profilePictureUrl ?? undefined,
    profilePictureMediaObjectId: profile.profilePictureMediaObjectId ?? undefined,
    creatorType: toLegacyCreatorType(profile.creatorType),
    matchingPreferences: profile.matchingPreferences,
    rating: profile.rating,
    status: toLegacyStatus(profile.profileStatus),
    createdAt: new Date(profile.createdAt),
    updatedAt: new Date(profile.updatedAt),
  };
}

function toLegacyCreatorType(
  creatorType: TargetCreatorProfile["creatorType"],
): Creator["creatorType"] {
  if (creatorType === "travel") return "Travel";
  if (creatorType === "other") return "Other";
  return "Lifestyle";
}

function toTargetCreatorType(
  creatorType: Creator["creatorType"],
): "lifestyle" | "travel" | "other" {
  if (creatorType === "Travel") return "travel";
  if (creatorType === "Other") return "other";
  return "lifestyle";
}

function toTargetPlatformName(platform: string): TargetCreatorPlatform["platform"] {
  switch (platform.toLowerCase()) {
    case "instagram":
      return "instagram";
    case "tiktok":
    case "tik tok":
      return "tiktok";
    case "youtube":
    case "you tube":
      return "youtube";
    case "facebook":
      return "facebook";
    case "blog":
      return "blog";
    case "x":
    case "twitter":
      return "x";
    default:
      return "other";
  }
}

function toLegacyStatus(status: TargetCreatorProfile["profileStatus"]): Creator["status"] {
  if (status === "active") return "verified";
  if (status === "rejected" || status === "suspended") return status;
  return "pending";
}

function toLegacyCreatorMarketplaceResponse(
  creator: MarketplaceCreatorReadModel,
): CreatorMarketplaceResponse {
  return {
    id: creator.creatorId,
    name: creator.displayName,
    location: creator.locationText ?? "",
    short_description: creator.shortDescription ?? "",
    portfolio_link: creator.portfolioUrl,
    profile_picture: creator.profilePictureUrl,
    creator_type: toLegacyCreatorType(creator.creatorType),
    platforms: creator.platforms.map((platform) => ({
      id: platform.platformId,
      name: toLegacyPlatformName(platform.platform),
      handle: platform.handle,
      profile_url: platform.profileUrl,
      followers: platform.followerCount,
      engagement_rate: platform.engagementRate,
      top_countries: platform.audienceCountries,
      top_age_groups: platform.audienceAgeGroups,
      gender_split: platform.audienceGenderSplit,
    })),
    audience_size: creator.audienceSize,
    average_rating: creator.averageRating,
    total_reviews: creator.totalReviews,
    created_at: creator.createdAt,
  };
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
