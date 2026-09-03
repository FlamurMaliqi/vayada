import type {
  CreatorRating,
  CollaborationReview,
  PlatformCountry,
  PlatformAgeGroup,
  PlatformGenderSplit,
  CreatorType,
} from "@/lib/types";
import type { MarketplaceCreatorMatchingPreferences } from "@vayada/domain-marketplace";

// Re-export for convenience
export type { PlatformCountry, PlatformAgeGroup, PlatformGenderSplit };

// Profile page specific types
export type UserType = "hotel" | "creator";
export type CreatorTab = "overview" | "matching" | "platforms" | "reviews";
export type HotelTab = "overview" | "listings";
export type PlatformName = "Instagram" | "TikTok" | "YouTube" | "Facebook" | "Blog" | "X" | "Other";

// Platform with optional id (for profile management)
export interface ProfilePlatform {
  id?: string;
  name: string;
  handle: string;
  profileUrl?: string | null;
  followers: number;
  engagementRate: number;
  topCountries?: PlatformCountry[];
  topAgeGroups?: PlatformAgeGroup[];
  genderSplit?: PlatformGenderSplit;
}

// API response types that may have snake_case or camelCase fields
export interface ApiAgeGroup {
  ageRange?: string | null;
  age_range?: string | null;
  percentage?: number;
}

export interface ApiPlatformResponse {
  id?: string;
  name: string;
  handle?: string;
  profileUrl?: string | null;
  profile_url?: string | null;
  followers?: number;
  engagementRate?: number;
  engagement_rate?: number;
  topCountries?: PlatformCountry[];
  top_countries?: PlatformCountry[];
  topAgeGroups?: ApiAgeGroup[];
  top_age_groups?: ApiAgeGroup[];
  genderSplit?: PlatformGenderSplit | string;
  gender_split?: PlatformGenderSplit | string;
}

export interface ApiRatingResponse {
  averageRating?: number;
  average_rating?: number;
  totalReviews?: number;
  total_reviews?: number;
  reviews?: CollaborationReview[];
}

export interface ApiCreatorResponse {
  id?: string;
  name?: string;
  email?: string;
  phone?: string | null;
  location?: string;
  status?: "verified" | "pending" | "rejected";
  profilePicture?: string;
  profile_picture?: string;
  shortDescription?: string;
  short_description?: string;
  portfolioLink?: string;
  portfolio_link?: string;
  creatorType?: CreatorType;
  creator_type?: CreatorType;
  platforms?: ApiPlatformResponse[];
  rating?: ApiRatingResponse;
  matchingPreferences?: MarketplaceCreatorMatchingPreferences | null;
}

// Canonical creator profile update payload used by the TypeScript API adapter.
export interface CreatorUpdatePayload {
  name?: string;
  location?: string;
  shortDescription?: string;
  portfolioLink?: string | null;
  phone?: string | null;
  profilePicture?: string;
  profilePictureMediaObjectId?: string;
  creatorType?: CreatorType;
  platforms?: Array<{
    id?: string | null;
    name: PlatformName;
    handle: string;
    profileUrl?: string | null;
    followers: number;
    engagementRate: number;
    topCountries?: Array<{ country: string; percentage: number }>;
    topAgeGroups?: Array<{ ageRange: string; percentage: number }>;
    genderSplit?: { male: number; female: number; other?: number };
  }>;
}

// Creator profile for display
export interface CreatorProfile {
  id: string;
  name: string;
  profilePicture?: string;
  shortDescription: string;
  location: string;
  status: "verified" | "pending" | "rejected";
  creatorType: CreatorType;
  matchingPreferences?: MarketplaceCreatorMatchingPreferences | null;
  rating?: CreatorRating;
  platforms: ProfilePlatform[];
  portfolioLink?: string;
  email: string;
  phone?: string;
}

export type CollaborationKind = "Free Stay" | "Paid" | "Discount" | "Affiliate";

// One configured offering on a listing — each carries its own availability,
// platforms, and (optional) per-offering min-follower threshold so a property
// can express e.g. "Free stay only Jan–May for 100k+ creators".
export interface ListingOffering {
  type: CollaborationKind;
  availabilityMonths: string[];
  platforms: string[];
  minFollowers?: number;
  freeStayMinNights?: number;
  freeStayMaxNights?: number;
  paidMaxAmount?: number;
  currency?: string;
  discountPercentage?: number;
  commissionPercentage?: number;
}

// Hotel listing for profile management
export interface ProfileHotelListing {
  id: string;
  mediaResourceId?: string;
  name: string;
  location: string;
  description: string;
  images: string[];
  imageMediaObjectIds?: string[];
  accommodationType?: string;
  offerings: ListingOffering[];
  // Legacy aggregated fields, kept for read paths that haven't migrated yet
  // (e.g. card chevrons that just check "is the listing complete?").
  collaborationTypes: CollaborationKind[];
  availability: string[];
  platforms: string[];
  freeStayMinNights?: number;
  freeStayMaxNights?: number;
  paidMaxAmount?: number;
  currency?: string;
  discountPercentage?: number;
  commissionPercentage?: number;
  lookingForPlatforms: string[];
  targetGroupCountries: string[];
  targetGroupAgeMin?: number;
  targetGroupAgeMax?: number;
  targetGroupAgeGroups?: string[];
  lookingForCreatorTypes?: CreatorType[];
  status: "verified" | "pending" | "rejected";
}

// Hotel profile for display
export interface ProfileHotelProfile {
  id: string;
  canonicalProfileRevision: number;
  publicProfileRevision: number;
  name: string;
  propertyType?: string;
  picture?: string;
  location: string;
  localityPublic: boolean;
  status: "verified" | "pending" | "rejected";
  website?: string;
  about?: string;
  email: string;
  phone?: string;
  listings: ProfileHotelListing[];
}

// Form data types
export interface CreatorEditFormData {
  name: string;
  profilePicture: string;
  shortDescription: string;
  location: string;
  portfolioLink: string;
  creatorType: CreatorType;
  platforms: ProfilePlatform[];
}

export interface HotelEditFormData {
  name: string;
  picture: string;
  location: string;
  localityPublic: boolean;
  website: string;
  about: string;
}

export interface ListingFormData {
  name: string;
  location: string;
  description: string;
  images: string[];
  imageMediaObjectIds?: string[];
  accommodationType: string;
  // Authoritative editor model — array of independent offerings.
  offerings: ListingOffering[];
  lookingForPlatforms: string[];
  targetGroupCountries: string[];
  targetGroupAgeMin?: number;
  targetGroupAgeMax?: number;
  targetGroupAgeGroups?: string[];
  lookingForCreatorTypes?: CreatorType[];
}

// Modal state types
export interface ErrorModalState {
  isOpen: boolean;
  title: string;
  message: string | string[];
  details?: string;
}

export interface DeleteConfirmModalState {
  isOpen: boolean;
  listingId: string | null;
  listingName: string;
}

/**
 * Factory function for empty listing form data
 */
export function createEmptyListingFormData(
  defaults: Partial<Pick<ListingFormData, "location" | "accommodationType">> = {},
): ListingFormData {
  return {
    name: "",
    location: defaults.location ?? "",
    description: "",
    images: [],
    imageMediaObjectIds: [],
    accommodationType: defaults.accommodationType ?? "",
    offerings: [],
    lookingForPlatforms: [],
    targetGroupCountries: [],
    targetGroupAgeMin: undefined,
    targetGroupAgeMax: undefined,
    targetGroupAgeGroups: [],
    lookingForCreatorTypes: [],
  };
}

export function createListingFormDataForEdit(listing: ProfileHotelListing): ListingFormData {
  return {
    name: listing.name,
    location: listing.location,
    description: listing.description,
    images: listing.images || [],
    imageMediaObjectIds: listing.imageMediaObjectIds ?? [],
    accommodationType: listing.accommodationType || "",
    offerings: listing.offerings.map((offering) => ({ ...offering })),
    lookingForPlatforms: listing.lookingForPlatforms || [],
    targetGroupCountries: listing.targetGroupCountries || [],
    targetGroupAgeMin: listing.targetGroupAgeMin,
    targetGroupAgeMax: listing.targetGroupAgeMax,
    targetGroupAgeGroups: listing.targetGroupAgeGroups || [],
    lookingForCreatorTypes: listing.lookingForCreatorTypes || [],
  };
}

export function createEmptyOffering(type: CollaborationKind = "Free Stay"): ListingOffering {
  return {
    type,
    availabilityMonths: [],
    platforms: [],
    minFollowers: undefined,
    freeStayMinNights: undefined,
    freeStayMaxNights: undefined,
    paidMaxAmount: undefined,
    currency: type === "Paid" ? "USD" : undefined,
    discountPercentage: undefined,
    commissionPercentage: type === "Affiliate" ? 5 : undefined,
  };
}
