/**
 * Type definitions for the admin frontend
 */

export interface User {
  id: string;
  email: string;
  name: string;
  type: "hotel" | "creator" | "admin";
  status: "pending" | "verified" | "rejected" | "suspended";
  avatar?: string | null;
  email_verified?: boolean;
  created_at: string;
  updated_at: string;
  creator_profile?: CreatorProfile | null;
  hotel_profile?: HotelProfile | null;
  social_media_platforms?: SocialMediaPlatform[];
  listings?: Listing[];
}

export interface CreatorProfile {
  id?: string;
  user_id?: string;
  location?: string;
  bio?: string;
  website?: string;
  niche?: string;
  follower_count?: number;
  platforms?: string[];
  [key: string]: any;
}

export interface HotelProfile {
  id?: string;
  user_id?: string;
  hotel_name?: string;
  address?: string;
  city?: string;
  country?: string;
  phone?: string;
  website?: string;
  star_rating?: number;
  [key: string]: any;
}

export interface SocialMediaPlatform {
  id: string;
  user_id: string;
  platform: "instagram" | "youtube" | "tiktok" | "twitter" | "facebook" | "linkedin" | "other";
  handle?: string;
  url?: string;
  follower_count?: number;
  verified?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Listing {
  id: string;
  user_id: string;
  title: string;
  description?: string;
  category?: string;
  price?: number;
  currency?: string;
  status?: "active" | "inactive" | "draft" | "sold";
  images?: string[];
  location?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: any;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  id?: string;
  email?: string;
  name?: string;
  type?: string;
  status?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  is_superadmin?: boolean;
  message: string;
  requires_totp?: boolean;
  totp_session?: string;
}

export interface CreateUserRequest {
  email: string;
  password: string;
  name: string;
  type: "creator" | "hotel";
  status?: "pending" | "verified" | "rejected" | "suspended";
  emailVerified?: boolean;
  avatar?: string;
  creatorProfile?: {
    location?: string;
    shortDescription?: string;
    portfolioLink?: string;
    phone?: string;
    profilePicture?: string;
    platforms?: Array<{
      name: "Instagram" | "TikTok" | "YouTube" | "Facebook";
      handle: string;
      followers: number;
      engagementRate: number;
      topCountries?: Array<{ country: string; percentage: number }>;
      topAgeGroups?: Array<{ ageRange: string; percentage: number }>;
      genderSplit?: { male: number; female: number; other?: number };
    }>;
  };
  hotelProfile?: {
    name?: string;
    location?: string;
    about?: string;
    website?: string;
    phone?: string;
  };
}

export interface UpdateUserRequest {
  name?: string;
  email?: string;
  status?: "pending" | "verified" | "rejected" | "suspended";
  creator_profile?: Partial<CreatorProfile>;
  hotel_profile?: Partial<HotelProfile>;
}

export interface CreateSocialMediaPlatformRequest {
  platform: SocialMediaPlatform["platform"];
  handle?: string;
  url?: string;
  follower_count?: number;
  verified?: boolean;
}

export interface UpdateSocialMediaPlatformRequest extends Partial<CreateSocialMediaPlatformRequest> {}

export interface CreateListingRequest {
  title: string;
  description?: string;
  category?: string;
  price?: number;
  currency?: string;
  status?: Listing["status"];
  images?: string[];
  location?: string;
}

export interface UpdateListingRequest extends Partial<CreateListingRequest> {}

// API Response Types for User Detail Endpoint
export interface UserDetailResponse {
  id: string;
  email: string;
  name: string;
  type: "creator" | "hotel" | "admin";
  status: "pending" | "verified" | "rejected" | "suspended";
  emailVerified: boolean;
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
  profile: CreatorProfileDetail | HotelProfileDetail | null;
}

export interface CreatorProfileDetail {
  id: string;
  userId: string;
  location: string | null;
  shortDescription: string | null;
  portfolioLink: string | null;
  phone: string | null;
  profilePicture: string | null;
  profilePictureMediaObjectId: string | null;
  profileComplete: boolean;
  profileCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  platforms: PlatformResponse[];
}

export interface PlatformResponse {
  id: string;
  name: "Instagram" | "TikTok" | "YouTube" | "Facebook";
  handle: string;
  followers: number;
  engagementRate: number;
  topCountries: Array<{ country: string; percentage: number }> | null;
  topAgeGroups: Array<{ ageRange: string; percentage?: number }> | null;
  genderSplit: { male: number; female: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface HotelProfileDetail {
  id: string;
  userId: string;
  name: string;
  location: string;
  picture: string | null;
  website: string | null;
  about: string | null;
  email: string;
  phone: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  listings: ListingResponse[];
}

export interface ListingResponse {
  id: string;
  hotelProfileId: string;
  name: string;
  location: string;
  description: string;
  accommodationType: string | null;
  media: Array<{
    mediaObjectId: string | null;
    url: string | null;
    approvalStatus: "pending_domain_approval" | "approved";
    lifecycleStatus: "staged" | "active";
  }>;
  images: string[];
  status: string;
  createdAt: string;
  updatedAt: string;
  collaborationOfferings?: CollaborationOffering[];
  creatorRequirements?: CreatorRequirements;
}

export interface CollaborationOffering {
  id: string;
  listingId: string;
  collaborationType: "Free Stay" | "Paid" | "Discount" | "Affiliate";
  availabilityMonths: string[];
  platforms: ("Instagram" | "TikTok" | "YouTube" | "Facebook")[];
  // Type-specific fields (only one set will be populated based on type)
  freeStayMinNights: number | null; // Only for 'Free Stay'
  freeStayMaxNights: number | null; // Only for 'Free Stay'
  paidMaxAmount: number | null; // Only for 'Paid'
  currency: string | null; // ISO 4217 code, only meaningful for 'Paid'
  discountPercentage: number | null; // Only for 'Discount'
  commissionPercentage: number | null; // Only for 'Affiliate'
  minFollowers?: number | null; // Optional per-offering follower threshold
  createdAt: string;
  updatedAt: string;
}

export interface CreatorRequirements {
  id: string;
  listingId: string;
  platforms: ("Instagram" | "TikTok" | "YouTube" | "Facebook")[];
  targetCountries: string[];
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[] | null;
  createdAt: string;
  updatedAt: string;
}
