/**
 * Marketplace API service - fetches public marketplace data
 */
import { ApiErrorResponse } from "./client";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_AUTH_API_URL ||
  "https://api.localhost";

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
   * Get all marketplace listings (public endpoint)
   */
  getListings: async (): Promise<MarketplaceListing[]> => {
    return requestMarketplaceDiscovery<MarketplaceListing[]>("/marketplace/listings");
  },

  /**
   * Get all marketplace creators (public endpoint)
   */
  getCreators: async (): Promise<MarketplaceCreator[]> => {
    return requestMarketplaceDiscovery<MarketplaceCreator[]>("/marketplace/creators");
  },
};

async function requestMarketplaceDiscovery<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "omit",
  });

  const contentType = response.headers.get("content-type");
  const body = contentType?.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "message" in body
        ? String(body.message)
        : `Marketplace discovery request failed: ${response.status}`;
    throw new ApiErrorResponse(response.status, { detail: message });
  }

  return body as T;
}
