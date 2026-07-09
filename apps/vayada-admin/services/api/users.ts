/**
 * Users API service for admin
 */

import { apiClient } from "./client";
import type { User, UserDetailResponse, CreateUserRequest } from "@/lib/types";

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
    const endpoint = `/admin/users${queryString ? `?${queryString}` : ""}`;

    return apiClient.get<UsersListResponse>(endpoint);
  },

  /**
   * Get user by ID with full details (profile, platforms, listings)
   */
  getUserById: async (userId: string): Promise<UserDetailResponse> => {
    const response = await apiClient.get<any>(`/admin/users/${userId}`);
    // Transform snake_case to camelCase to match TypeScript interfaces
    return transformSnakeToCamel(response) as UserDetailResponse;
  },

  /**
   * Create a new identity user. Product profile writes are handled separately
   * by their owning target admin routes.
   */
  createUser: async (data: CreateUserRequest): Promise<User> => {
    return apiClient.post<User>("/admin/users", data);
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
    const response = await apiClient.put<any>(`/admin/users/${userId}`, data);
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
    const response = await apiClient.put<any>(`/admin/users/${userId}/profile/creator`, {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.profilePicture !== undefined ? { profilePicture: data.profilePicture } : {}),
      ...(data.location !== undefined ? { location: data.location } : {}),
      ...(data.shortDescription !== undefined ? { shortDescription: data.shortDescription } : {}),
      ...(data.portfolioLink !== undefined ? { portfolioLink: data.portfolioLink } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.platforms !== undefined ? { platforms: data.platforms } : {}),
    });
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
    const response = await apiClient.put<any>(`/admin/users/${userId}/profile/hotel`, {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.location !== undefined ? { location: data.location } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.about !== undefined ? { about: data.about } : {}),
      ...(data.website !== undefined ? { website: data.website } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.picture !== undefined ? { picture: data.picture } : {}),
    });
    return transformSnakeToCamel(response);
  },

  /**
   * Create a listing for a hotel user
   */
  createListing: async (
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
  ): Promise<any> => {
    const response = await apiClient.post<any>(`/admin/users/${hotelUserId}/listings`, data);
    return transformSnakeToCamel(response);
  },

  /**
   * Update a listing
   */
  updateListing: async (
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
    const response = await apiClient.put<any>(
      `/admin/users/${hotelUserId}/listings/${listingId}`,
      data,
    );
    return transformSnakeToCamel(response);
  },

  /**
   * Delete a listing
   * ⚠️ Warning: This action cannot be undone!
   * Permanently removes the listing, all collaboration offerings, creator requirements, and all images from S3.
   */
  deleteListing: async (
    hotelUserId: string,
    listingId: string,
  ): Promise<{
    message: string;
    deletedListing: {
      id: string;
      name: string;
    };
    imagesDeleted: number;
    imagesFailed: number;
  }> => {
    const response = await apiClient.delete<{
      message: string;
      deleted_listing: { id: string; name: string };
      images_deleted: number;
      images_failed: number;
    }>(`/admin/users/${hotelUserId}/listings/${listingId}`);
    return {
      message: response.message,
      deletedListing: {
        id: response.deleted_listing.id,
        name: response.deleted_listing.name,
      },
      imagesDeleted: response.images_deleted,
      imagesFailed: response.images_failed,
    };
  },

  /**
   * Delete a legacy auth user.
   */
  deleteUser: async (userId: string): Promise<{ message: string; deleted_user: User }> => {
    return apiClient.delete<{ message: string; deleted_user: User }>(`/admin/users/${userId}`);
  },

  setPlatformAccess: async (userId: string, enabled: boolean): Promise<IdentityCommandResponse> => {
    await apiClient.patch(`/admin/users/${userId}/superadmin`, { is_superadmin: enabled });
    return { userId, status: "accepted", commands: [] };
  },
};
