/**
 * Marketplace API service - fetches public marketplace data
 */
import {
  getAllMarketplaceCreators,
  getAllMarketplaceOffers,
  type MarketplaceCompensationOptionSummary,
  type MarketplaceCreatorReadModel,
  type MarketplaceOfferReadModel,
  type MarketplacePlatformName,
} from "@vayada/marketplace-shared/api/discovery";

export interface MarketplaceListing {
  id: string;
  hotel_profile_id: string;
  hotel_name: string;
  hotel_picture: string | null;
  owner_email: string | null;
  owner_user_id: string | null;
  name: string;
  location: string;
  description: string;
  accommodation_type: string | null;
  images: string[];
  status: string;
  collaboration_offerings: CollaborationOffering[];
  creator_requirements: CreatorRequirements | null;
  created_at: string;
}

export interface CollaborationOffering {
  id: string;
  listing_id: string;
  collaboration_type: "Free Stay" | "Paid" | "Discount" | "Affiliate";
  availability_months: string[];
  platforms: string[];
  free_stay_min_nights: number | null;
  free_stay_max_nights: number | null;
  paid_max_amount: number | null;
  currency: string | null;
  discount_percentage: number | null;
  commission_percentage: number | null;
  min_followers?: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreatorRequirements {
  id: string;
  listing_id: string;
  platforms: string[];
  target_countries: string[];
  target_age_min: number | null;
  target_age_max: number | null;
  target_age_groups: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface MarketplaceCreator {
  id: string;
  name: string;
  location: string;
  short_description: string;
  portfolio_link: string | null;
  profile_picture: string | null;
  platforms: CreatorPlatform[];
  audience_size: number;
  average_rating: number;
  total_reviews: number;
  created_at: string;
}

export interface CreatorPlatform {
  id: string;
  name: string;
  handle: string;
  followers: number;
  engagement_rate: number;
  top_countries: { country: string; percentage: number }[] | null;
  top_age_groups: { ageRange: string; percentage: number }[] | null;
  gender_split: { male: number; female: number } | null;
}

export const marketplaceService = {
  /**
   * Get all marketplace offers (public endpoint)
   */
  getListings: async (): Promise<MarketplaceListing[]> => {
    return (await getAllMarketplaceOffers()).map(toMarketplaceListing);
  },

  /**
   * Get all marketplace creators (public endpoint)
   */
  getCreators: async (): Promise<MarketplaceCreator[]> => {
    return (await getAllMarketplaceCreators()).map(toMarketplaceCreator);
  },
};

function toMarketplaceListing(offer: MarketplaceOfferReadModel): MarketplaceListing {
  return {
    id: offer.offerId,
    hotel_profile_id: offer.offerPublicId,
    hotel_name: offer.hotelName,
    hotel_picture: offer.hotelCoverImageUrl,
    owner_email: null,
    owner_user_id: null,
    name: offer.offerTitle,
    location: offer.hotelLocation.displayText,
    description: offer.offerSummary ?? "",
    accommodation_type: offer.hotelAccommodationType,
    images: offer.hotelImageUrls,
    status: "verified",
    collaboration_offerings: offer.compensationOptions.map((option) => ({
      id: option.compensationOptionId,
      listing_id: offer.offerId,
      collaboration_type: toLegacyCompensationType(option.compensationType),
      availability_months: option.availabilityMonths,
      platforms: option.platforms.map(toLegacyPlatformName),
      free_stay_min_nights: option.freeStayMinNights,
      free_stay_max_nights: option.freeStayMaxNights,
      paid_max_amount: option.paidMaxAmount === null ? null : Number(option.paidMaxAmount),
      currency: option.currency,
      discount_percentage: option.discountPercentage,
      commission_percentage: option.commissionPercentage,
      min_followers: option.minFollowers,
      created_at: offer.createdAt,
      updated_at: offer.projectedAt,
    })),
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
      : null,
    created_at: offer.createdAt,
  };
}

function toMarketplaceCreator(creator: MarketplaceCreatorReadModel): MarketplaceCreator {
  return {
    id: creator.creatorId,
    name: creator.displayName,
    location: creator.locationText ?? "",
    short_description: creator.shortDescription ?? "",
    portfolio_link: creator.portfolioUrl,
    profile_picture: creator.profilePictureUrl,
    platforms: creator.platforms.map((platform) => ({
      id: platform.platformId,
      name: toLegacyPlatformName(platform.platform),
      handle: platform.handle,
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
