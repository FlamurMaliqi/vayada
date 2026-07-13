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
import {
  uploadPlatformMedia,
  type PlatformMediaUploadResult,
} from "@vayada/marketplace-shared/api/platformMedia";
import type { SharedPropertyProfile, SharedPropertyProfileInput } from "@vayada/product-onboarding";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  readSelectedSharedPropertyId,
  SELECTED_SHARED_PROPERTY_ID_KEY,
} from "@/lib/utils/sharedSetupGuard";
import { getAuthSessionUser } from "@/services/auth/sessionStore";
import { apiClient } from "./client";
import { sharedHotelSetupApi } from "./sharedHotelSetupClient";
import { targetApiClient } from "./targetClient";

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
  pictureMediaObjectId?: string | null;
  picture_media_object_id?: string | null;
}

export interface CreateListingRequest {
  name: string;
  location: string;
  description: string;
  accommodation_type?: string;
  images?: string[];
  image_media_object_ids?: string[];
  deliverables?: Array<{
    platform: string;
    deliverable_type: string;
    quantity: number;
    timing_guidance?: string | null;
  }>;
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
    min_followers?: number;
  }>;
  creator_requirements: {
    platforms: string[];
    target_countries: string[];
    target_age_min?: number | null;
    target_age_max?: number | null;
    target_age_groups?: string[] | null;
    creator_types?: string[] | null;
  };
}

export type UpdateListingRequest = Partial<CreateListingRequest>;

export interface UploadPictureResponse {
  url: string;
  mediaObjectId?: string;
}

export interface UploadImagesResponse {
  urls: string[];
  mediaObjectIds?: string[];
}

export type PlatformImageUploadResponse = PlatformMediaUploadResult & {
  mediaObjectId: string;
};

type TargetMarketplaceProfile = {
  propertyId: string;
  profileStatus: "pending" | "verified" | "rejected" | "suspended" | "archived";
  profileComplete: boolean;
  hostSummary: string | null;
  collaborationGuidelines: string | null;
  createdAt: string;
  updatedAt: string;
};

type TargetMarketplacePlatform =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "blog"
  | "x"
  | "other";

type TargetMarketplaceDeliverable = {
  deliverableId: string;
  platform: TargetMarketplacePlatform;
  deliverableType: string;
  quantity: number;
  timingGuidance: string | null;
};

type TargetMarketplaceCompensationOption = {
  compensationOptionId: string;
  compensationType: "free_stay" | "paid" | "discount" | "affiliate";
  availabilityMonths: string[];
  platforms: TargetMarketplacePlatform[];
  freeStayMinNights: number | null;
  freeStayMaxNights: number | null;
  paidMaxAmount: string | null;
  discountPercentage: number | null;
  commissionPercentage: number | null;
  minFollowers: number | null;
  currency: string | null;
  termsSummary: string | null;
};

type TargetMarketplaceCreatorRequirements = {
  platforms: TargetMarketplacePlatform[];
  targetCountries: string[];
  targetAgeMin: number | null;
  targetAgeMax: number | null;
  targetAgeGroups: string[];
  creatorTypes: ("lifestyle" | "travel" | "other")[];
};

type TargetMarketplaceOffer = {
  offerId: string;
  mediaResourceId: string;
  propertyId: string;
  offerStatus: "draft" | "pending" | "verified" | "rejected" | "suspended" | "archived";
  title: string;
  offerSummary: string | null;
  media: Array<{ mediaObjectId: string | null; url: string }>;
  deliverables: TargetMarketplaceDeliverable[];
  compensationOptions: TargetMarketplaceCompensationOption[];
  creatorRequirements: TargetMarketplaceCreatorRequirements | null;
  createdAt: string;
  updatedAt: string;
};

type TargetMarketplaceOfferWrite = {
  title: string;
  offerSummary?: string | null;
  deliverables: Omit<TargetMarketplaceDeliverable, "deliverableId">[];
  compensationOptions: Omit<TargetMarketplaceCompensationOption, "compensationOptionId">[];
  creatorRequirements: TargetMarketplaceCreatorRequirements;
};

type TargetMarketplaceOfferUpdate = Partial<
  Omit<TargetMarketplaceOfferWrite, "deliverables" | "compensationOptions" | "creatorRequirements">
> & {
  deliverables?: TargetMarketplaceOfferWrite["deliverables"];
  compensationOptions?: TargetMarketplaceOfferWrite["compensationOptions"];
  creatorRequirements?: TargetMarketplaceCreatorRequirements | null;
};

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
   * Get the selected hotel's canonical profile and Marketplace data.
   */
  getMyProfile: async (): Promise<HotelProfile> => {
    const propertyId = await resolveSelectedPropertyId();
    const [property, marketplaceProfile, offers] = await Promise.all([
      sharedHotelSetupApi.getPropertyProfile(propertyId),
      targetApiClient.get<TargetMarketplaceProfile>(marketplaceProfilePath(propertyId)),
      targetApiClient.get<{ offers: TargetMarketplaceOffer[] }>(marketplaceOffersPath(propertyId)),
    ]);
    return toLegacyHotelProfile(property, marketplaceProfile, offers.offers);
  },

  /**
   * Update canonical hotel facts and Marketplace-owned profile copy.
   */
  updateMyProfile: async (data: UpdateHotelProfileRequest | FormData): Promise<HotelProfile> => {
    if (data instanceof FormData) {
      throw new Error("Hotel profile updates must use JSON and platform media uploads");
    }

    const propertyId = await resolveSelectedPropertyId();
    const property = await sharedHotelSetupApi.getPropertyProfile(propertyId);
    const canonicalUpdate = applyCanonicalProfileUpdate(property, data);
    if (canonicalUpdate) {
      await sharedHotelSetupApi.updatePropertyProfile(propertyId, canonicalUpdate);
    }
    if (data.about !== undefined) {
      await targetApiClient.put<TargetMarketplaceProfile>(marketplaceProfilePath(propertyId), {
        hostSummary: normalizedOptionalText(data.about),
      });
    }
    return hotelService.getMyProfile();
  },

  /**
   * Upload hotel profile picture through platform media.
   * Returns media metadata to include in the profile update command.
   */
  uploadProfileImage: async (
    file: File,
    profileId: string,
  ): Promise<PlatformImageUploadResponse> => {
    const [uploaded] = await uploadPlatformMedia({
      purpose: "property.hero_image",
      resource: {
        product: "marketplace",
        resourceType: "hotel_profile",
        resourceId: profileId,
        targetResourceId: profileId,
      },
      files: [file],
    });
    if (!uploaded) throw new Error("Platform media did not return an uploaded image");
    return { ...uploaded, mediaObjectId: uploaded.mediaId };
  },

  /**
   * @deprecated Use uploadProfileImage(file, profileId) so the upload can be
   * scoped to the marketplace hotel profile resource.
   */
  uploadPicture: async (): Promise<UploadPictureResponse> => {
    throw new Error("uploadPicture is retired; use uploadProfileImage(file, profileId)");
  },

  /**
   * Create an offer under the selected hotel.
   */
  createListing: async (data: CreateListingRequest): Promise<HotelListing> => {
    const propertyId = await resolveSelectedPropertyId();
    const property = await updateCanonicalOfferLocation(propertyId, data);
    const offer = await targetApiClient.post<TargetMarketplaceOffer>(
      marketplaceOffersPath(propertyId),
      toTargetOfferCreate(data),
    );
    return toLegacyHotelListing(offer, property);
  },

  /**
   * Update an offer under the selected hotel.
   */
  updateListing: async (id: string, data: UpdateListingRequest): Promise<HotelListing> => {
    const propertyId = await resolveSelectedPropertyId();
    const property = await updateCanonicalOfferLocation(propertyId, data);
    const offer = await targetApiClient.put<TargetMarketplaceOffer>(
      `${marketplaceOffersPath(propertyId)}/${encodeURIComponent(id)}`,
      toTargetOfferUpdate(data),
    );
    return toLegacyHotelListing(offer, property);
  },

  /**
   * Delete an offer under the selected hotel.
   */
  deleteListing: async (id: string): Promise<void> => {
    const propertyId = await resolveSelectedPropertyId();
    return targetApiClient.delete<void>(
      `${marketplaceOffersPath(propertyId)}/${encodeURIComponent(id)}`,
    );
  },

  /**
   * Upload listing images through platform media.
   * Returns media IDs and URLs to include in listing create/update commands.
   */
  uploadListingImages: async (
    files: File[],
    listingId: string,
  ): Promise<{ images: Array<{ url: string; mediaObjectId: string }> }> => {
    const uploaded = await uploadPlatformMedia({
      purpose: "marketplace.offer.media",
      resource: {
        product: "marketplace",
        resourceType: "marketplace_offer",
        resourceId: listingId,
      },
      files,
    });
    return {
      images: uploaded.map((image) => ({
        url: image.url,
        mediaObjectId: image.mediaId,
      })),
    };
  },

  /**
   * @deprecated Use uploadListingImages(files, id) and include media IDs in
   * the listing update command instead.
   */
  uploadListingImagesToExisting: async (
    id: string,
    files: File[],
  ): Promise<UploadImagesResponse> => {
    const uploaded = await hotelService.uploadListingImages(files, id);
    return {
      urls: uploaded.images.map((image) => image.url),
      mediaObjectIds: uploaded.images.map((image) => image.mediaObjectId),
    };
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
   * Get the selected hotel's Marketplace completion status.
   */
  getProfileStatus: async (): Promise<HotelProfileStatus> => {
    const propertyId = await resolveSelectedPropertyId();
    return targetApiClient.get<HotelProfileStatus>(
      `/api/marketplace/properties/${encodeURIComponent(propertyId)}/profile-status`,
    );
  },
};

async function resolveSelectedPropertyId(): Promise<string> {
  const storage = typeof window === "undefined" ? null : window.localStorage;
  const storedPropertyId = readSelectedSharedPropertyId(storage);
  if (storedPropertyId) return storedPropertyId;

  const status = await sharedHotelSetupApi.getStatus({ entryProduct: "marketplace" });
  const propertyId =
    status.selection.selectedPropertyId ?? status.properties[0]?.propertyId ?? null;
  if (!propertyId) throw new Error("Create a hotel before opening Marketplace");
  storage?.setItem(SELECTED_SHARED_PROPERTY_ID_KEY, propertyId);
  return propertyId;
}

function marketplaceProfilePath(propertyId: string): string {
  return `/api/marketplace/properties/${encodeURIComponent(propertyId)}/profile`;
}

function marketplaceOffersPath(propertyId: string): string {
  return `/api/marketplace/properties/${encodeURIComponent(propertyId)}/offers`;
}

function applyCanonicalProfileUpdate(
  profile: SharedPropertyProfile,
  update: UpdateHotelProfileRequest,
): SharedPropertyProfileInput | null {
  const changesCanonicalProfile =
    update.name !== undefined ||
    update.location !== undefined ||
    update.website !== undefined ||
    update.phone !== undefined ||
    update.picture !== undefined;
  if (!changesCanonicalProfile) return null;

  const displayName = update.name?.trim() || profile.displayName;
  return {
    displayName,
    location:
      update.location === undefined
        ? profile.location
        : {
            ...profile.location,
            rawMarketplaceLocation: normalizedOptionalText(update.location),
          },
    website:
      update.website === undefined ? profile.website : normalizedOptionalText(update.website),
    phone: update.phone === undefined ? profile.phone : normalizedOptionalText(update.phone),
    shortDescription: profile.shortDescription,
    longDescription: profile.longDescription,
    media:
      update.picture === undefined
        ? profile.media
        : [
            ...(update.picture
              ? [
                  {
                    mediaType: "hero_image" as const,
                    url: update.picture,
                    altText: displayName,
                    sortOrder: 0,
                  },
                ]
              : []),
            ...profile.media.filter((media) => media.mediaType !== "hero_image"),
          ],
  };
}

function toLegacyHotelProfile(
  property: SharedPropertyProfile,
  marketplaceProfile: TargetMarketplaceProfile,
  offers: TargetMarketplaceOffer[],
): HotelProfile {
  const user = getAuthSessionUser();
  const email =
    user?.email ??
    (typeof window === "undefined" ? "" : (localStorage.getItem(STORAGE_KEYS.USER_EMAIL) ?? ""));
  const location = formatPropertyLocation(property);
  return {
    id: property.propertyId,
    user_id: user?.id ?? property.propertyId,
    name: property.displayName,
    category: "Hotel",
    location,
    picture: property.media.find((media) => media.mediaType === "hero_image")?.url ?? null,
    website: property.website,
    about: marketplaceProfile.hostSummary,
    email,
    phone: property.phone,
    status: toLegacyProfileStatus(marketplaceProfile.profileStatus),
    created_at: marketplaceProfile.createdAt,
    updated_at: marketplaceProfile.updatedAt,
    listings: offers.map((offer) => toLegacyHotelListing(offer, property)),
  };
}

async function updateCanonicalOfferLocation(
  propertyId: string,
  data: UpdateListingRequest,
): Promise<SharedPropertyProfile> {
  const property = await sharedHotelSetupApi.getPropertyProfile(propertyId);
  if (data.location === undefined) return property;

  return sharedHotelSetupApi.updatePropertyProfile(propertyId, {
    displayName: property.displayName,
    location:
      data.location === undefined
        ? property.location
        : {
            ...property.location,
            rawMarketplaceLocation: normalizedOptionalText(data.location),
          },
    website: property.website,
    phone: property.phone,
    shortDescription: property.shortDescription,
    longDescription: property.longDescription,
    media: property.media,
  });
}

function toTargetOfferCreate(data: CreateListingRequest): TargetMarketplaceOfferWrite {
  return {
    title: data.name.trim(),
    offerSummary: normalizedOptionalText(data.description),
    deliverables: toTargetDeliverables(data),
    compensationOptions: data.collaboration_offerings.map(toTargetCompensationOption),
    creatorRequirements: toTargetCreatorRequirements(data.creator_requirements),
  };
}

function toTargetOfferUpdate(data: UpdateListingRequest): TargetMarketplaceOfferUpdate {
  return {
    ...(data.name !== undefined ? { title: data.name.trim() } : {}),
    ...(data.description !== undefined
      ? { offerSummary: normalizedOptionalText(data.description) }
      : {}),
    ...(data.deliverables !== undefined || data.creator_requirements !== undefined
      ? { deliverables: toTargetDeliverables(data) }
      : {}),
    ...(data.collaboration_offerings !== undefined
      ? { compensationOptions: data.collaboration_offerings.map(toTargetCompensationOption) }
      : {}),
    ...(data.creator_requirements !== undefined
      ? { creatorRequirements: toTargetCreatorRequirements(data.creator_requirements) }
      : {}),
  };
}

function toTargetDeliverables(data: {
  deliverables?: CreateListingRequest["deliverables"];
  creator_requirements?: CreateListingRequest["creator_requirements"];
}): TargetMarketplaceOfferWrite["deliverables"] {
  const deliverables =
    data.deliverables ??
    (data.creator_requirements?.platforms ?? []).map((platform) => ({
      platform,
      deliverable_type: "content",
      quantity: 1,
      timing_guidance: null,
    }));
  return deliverables.map((deliverable) => ({
    platform: toTargetPlatform(deliverable.platform),
    deliverableType: deliverable.deliverable_type.trim(),
    quantity: deliverable.quantity,
    timingGuidance: normalizedOptionalText(deliverable.timing_guidance),
  }));
}

function toTargetCompensationOption(
  offering: CreateListingRequest["collaboration_offerings"][number],
): Omit<TargetMarketplaceCompensationOption, "compensationOptionId"> {
  return {
    compensationType: toTargetCompensationType(offering.collaboration_type),
    availabilityMonths: offering.availability_months,
    platforms: offering.platforms.map(toTargetPlatform),
    freeStayMinNights: offering.free_stay_min_nights ?? null,
    freeStayMaxNights: offering.free_stay_max_nights ?? null,
    paidMaxAmount: offering.paid_max_amount === undefined ? null : String(offering.paid_max_amount),
    discountPercentage: offering.discount_percentage ?? null,
    commissionPercentage: offering.commission_percentage ?? null,
    minFollowers: offering.min_followers ?? null,
    currency: normalizedOptionalText(offering.currency),
    termsSummary: null,
  };
}

function toTargetCreatorRequirements(
  requirements: CreateListingRequest["creator_requirements"],
): TargetMarketplaceCreatorRequirements {
  return {
    platforms: requirements.platforms.map(toTargetPlatform),
    targetCountries: requirements.target_countries,
    targetAgeMin: requirements.target_age_min ?? null,
    targetAgeMax: requirements.target_age_max ?? null,
    targetAgeGroups: requirements.target_age_groups ?? [],
    creatorTypes: (requirements.creator_types ?? []).map(toTargetCreatorType),
  };
}

function toLegacyHotelListing(
  offer: TargetMarketplaceOffer,
  property: SharedPropertyProfile,
): HotelListing {
  return {
    id: offer.offerId,
    media_resource_id: offer.mediaResourceId,
    hotel_profile_id: offer.propertyId,
    name: offer.title,
    location: formatPropertyLocation(property),
    description: offer.offerSummary ?? "",
    accommodation_type: null,
    images: offer.media.map((media) => media.url),
    image_media_object_ids: offer.media.flatMap((media) =>
      media.mediaObjectId ? [media.mediaObjectId] : [],
    ),
    status: toLegacyOfferStatus(offer.offerStatus),
    created_at: offer.createdAt,
    updated_at: offer.updatedAt,
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
      updated_at: offer.updatedAt,
    })),
    creator_requirements: {
      id: `${offer.offerId}:requirements`,
      listing_id: offer.offerId,
      platforms: offer.creatorRequirements?.platforms.map(toLegacyPlatformName) ?? [],
      target_countries: offer.creatorRequirements?.targetCountries ?? [],
      target_age_min: offer.creatorRequirements?.targetAgeMin ?? null,
      target_age_max: offer.creatorRequirements?.targetAgeMax ?? null,
      target_age_groups: offer.creatorRequirements?.targetAgeGroups ?? [],
      creator_types: offer.creatorRequirements?.creatorTypes.map(toLegacyCreatorType) ?? [],
      created_at: offer.createdAt,
      updated_at: offer.updatedAt,
    },
  };
}

function toTargetCompensationType(
  type: CreateListingRequest["collaboration_offerings"][number]["collaboration_type"],
): TargetMarketplaceCompensationOption["compensationType"] {
  switch (type) {
    case "Free Stay":
      return "free_stay";
    case "Paid":
      return "paid";
    case "Discount":
      return "discount";
    case "Affiliate":
      return "affiliate";
  }
}

function toTargetPlatform(platform: string): TargetMarketplacePlatform {
  switch (platform.trim().toLowerCase()) {
    case "instagram":
      return "instagram";
    case "tiktok":
    case "tik tok":
      return "tiktok";
    case "youtube":
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

function toTargetCreatorType(type: string): "lifestyle" | "travel" | "other" {
  switch (type.trim().toLowerCase()) {
    case "lifestyle":
      return "lifestyle";
    case "travel":
      return "travel";
    default:
      return "other";
  }
}

function toLegacyCreatorType(type: "lifestyle" | "travel" | "other"): string {
  return type === "lifestyle" ? "Lifestyle" : type === "travel" ? "Travel" : "Other";
}

function toLegacyProfileStatus(
  status: TargetMarketplaceProfile["profileStatus"],
): HotelProfile["status"] {
  return status === "archived" ? "suspended" : status;
}

function toLegacyOfferStatus(
  status: TargetMarketplaceOffer["offerStatus"],
): HotelListing["status"] {
  if (status === "verified" || status === "rejected") return status;
  return "pending";
}

function formatPropertyLocation(profile: SharedPropertyProfile): string {
  return (
    profile.location.rawMarketplaceLocation?.trim() ||
    [profile.location.city, profile.location.region, profile.location.countryCode]
      .filter(Boolean)
      .join(", ")
  );
}

function normalizedOptionalText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

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
    accommodation_type: offer.hotelAccommodationType,
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
