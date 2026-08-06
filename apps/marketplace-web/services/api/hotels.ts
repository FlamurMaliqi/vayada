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
import { transformListingMarketplaceResponse } from "@/lib/utils";
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
import { createHotelCatalogStep1MediaAssignments } from "@vayada/domain-hotels";
import { countries } from "countries-list";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  readSelectedSharedPropertyId,
  SELECTED_SHARED_PROPERTY_ID_KEY,
} from "@/lib/utils/sharedSetupGuard";
import { getAuthSessionUser } from "@/services/auth/sessionStore";
import { hotelPresentationClient } from "./hotelPresentationClient";
import { sharedHotelSetupApi } from "./sharedHotelSetupClient";
import { targetApiClient } from "./targetClient";

type PropertyProfileResponse = Awaited<ReturnType<typeof sharedHotelSetupApi.getPropertyProfile>>;
type PropertyProfileUpdateRequest = Parameters<typeof sharedHotelSetupApi.updatePropertyProfile>[1];
type PropertyProfileContact = PropertyProfileResponse["profile"]["contacts"][number];
type PublicPropertyProfileResponse = Awaited<
  ReturnType<typeof sharedHotelSetupApi.getPublicPropertyProfile>
>;
type PublicPropertyProfileUpdateRequest = Parameters<
  typeof sharedHotelSetupApi.updatePublicPropertyProfile
>[1];

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
    terms_summary?: string | null;
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
  about?: string | null;
  website?: string | null;
  phone?: string;
  localityPublic?: boolean;
  picture?: string | null; // allow clearing or replacing
  pictureMediaObjectId?: string | null;
  picture_media_object_id?: string | null;
}

export type HotelProfileRevisionSnapshot = {
  canonicalProfileRevision: number;
  publicProfileRevision: number;
};

export function advanceHotelProfileRevisionsAfterCoverUpload(
  revisions: HotelProfileRevisionSnapshot,
): HotelProfileRevisionSnapshot {
  const nextRevision = revisions.canonicalProfileRevision + 1;
  return {
    canonicalProfileRevision: nextRevision,
    publicProfileRevision: nextRevision,
  };
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

export type CreateListingOptions = {
  idempotencyKey: string;
};

export class CanonicalHotelPhotoReuseError extends Error {
  constructor(readonly sourceUrl: string) {
    super("The shared hotel photo could not be copied");
    this.name = "CanonicalHotelPhotoReuseError";
  }
}

export class HotelAddressSetupRequiredError extends Error {
  constructor() {
    super(
      "Hotel addresses must be updated in Hotel setup so the full address, timezone, and map details stay consistent.",
    );
    this.name = "HotelAddressSetupRequiredError";
  }
}

export type UpdateListingRequest = Partial<CreateListingRequest>;

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
  media: Array<{
    mediaObjectId: string | null;
    url: string | null;
    approvalStatus: "pending_domain_approval" | "approved";
    lifecycleStatus: "staged" | "active";
  }>;
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
   * Get the selected hotel's canonical profile and Marketplace data.
   */
  getMyProfile: async (
    propertyIdOverride?: string,
    options?: RequestInit,
  ): Promise<HotelProfile> => {
    const propertyId = await resolveSelectedPropertyId(propertyIdOverride);
    const [property, publicProfile, marketplaceProfile, offers] = await Promise.all([
      sharedHotelSetupApi.getPropertyProfile(propertyId, options),
      sharedHotelSetupApi.getPublicPropertyProfile(propertyId, options),
      targetApiClient.get<TargetMarketplaceProfile>(marketplaceProfilePath(propertyId), options),
      targetApiClient.get<{ offers: TargetMarketplaceOffer[] }>(
        marketplaceOffersPath(propertyId),
        options,
      ),
    ]);
    return toLegacyHotelProfile(property, publicProfile, marketplaceProfile, offers.offers);
  },

  /**
   * Update canonical hotel facts and Marketplace-owned profile copy.
   */
  updateMyProfile: async (
    data: UpdateHotelProfileRequest | FormData,
    propertyIdOverride?: string,
    revisions?: HotelProfileRevisionSnapshot,
  ): Promise<HotelProfile> => {
    return updateHotelProfile(data, propertyIdOverride, revisions, {
      publicProfile: true,
      marketplaceProfile: true,
    });
  },

  updatePublicSetupProfile: async (
    data: Pick<UpdateHotelProfileRequest, "about" | "localityPublic">,
    propertyId: string,
    revisions: HotelProfileRevisionSnapshot,
  ): Promise<HotelProfile> => {
    return updateHotelProfile(data, propertyId, revisions, {
      publicProfile: true,
      marketplaceProfile: true,
    });
  },

  updateMarketplaceHostSummary: async (about: string, propertyId: string): Promise<void> => {
    await targetApiClient.put<TargetMarketplaceProfile>(marketplaceProfilePath(propertyId), {
      hostSummary: normalizedOptionalText(about),
    });
  },

  /**
   * Upload hotel profile picture through platform media.
   * Returns media metadata to include in the profile update command.
   */
  uploadProfileImage: async (
    file: File,
    profileId: string,
    expectedProfileRevision: number,
  ): Promise<PlatformImageUploadResponse> => {
    const [uploaded] = await uploadPlatformMedia({
      idempotencyKey: `marketplace.property-hero:${profileId}:revision:${expectedProfileRevision}`,
      purpose: "property.hero_image",
      visibility: "private",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: profileId,
      },
      files: [file],
    });
    if (!uploaded) throw new Error("Platform media did not return an uploaded image");

    const canonicalPresentation = await hotelPresentationClient.load(profileId);
    const galleryAssignments = createHotelCatalogStep1MediaAssignments(
      canonicalPresentation.profile.media,
      canonicalPresentation.displayName,
    ).filter(({ role }) => role === "gallery");
    await sharedHotelSetupApi.replacePropertyPresentationMedia(
      profileId,
      {
        expectedProfileRevision,
        assignments: [
          {
            mediaObjectId: uploaded.mediaId,
            role: "cover",
            altText: null,
            sortOrder: 0,
          },
          ...galleryAssignments,
        ],
      },
      `marketplace.property-cover.assign:${profileId}:revision:${expectedProfileRevision}:media:${uploaded.mediaId}`,
    );

    const publishedProfile = await sharedHotelSetupApi.getPublicPropertyProfile(profileId);
    const publishedCover = publishedProfile.publicProfile.media.find(
      ({ mediaObjectId, mediaType }) =>
        mediaType === "hero_image" && mediaObjectId === uploaded.mediaId,
    );
    if (!publishedCover) {
      throw new Error("The hotel cover was assigned but its public image is unavailable.");
    }
    return { ...uploaded, url: publishedCover.url, mediaObjectId: uploaded.mediaId };
  },

  /**
   * Promote an already selected remote offer photo to the canonical hotel
   * cover. The same guarded download path used for offer-photo reuse keeps
   * third-party URLs out of the profile command.
   */
  uploadProfileImageFromSource: async (
    sourceImageUrl: string,
    profileId: string,
    expectedProfileRevision: number,
  ): Promise<PlatformImageUploadResponse> => {
    const file = await remoteImageFile(sourceImageUrl, 0);
    return hotelService.uploadProfileImage(file, profileId, expectedProfileRevision);
  },

  /**
   * Create an offer under the selected hotel.
   */
  createListing: async (
    data: CreateListingRequest,
    propertyIdOverride?: string,
    options?: CreateListingOptions,
  ): Promise<HotelListing> => {
    const propertyId = await resolveSelectedPropertyId(propertyIdOverride);
    const property = await sharedHotelSetupApi.getPropertyProfile(propertyId);
    const idempotencyKey =
      options?.idempotencyKey.trim() || `marketplace.hotel-offer.create:${randomIdentifier()}:v1`;
    const offer = await targetApiClient.post<TargetMarketplaceOffer>(
      marketplaceOffersPath(propertyId),
      toTargetOfferCreate(data),
      { headers: { "Idempotency-Key": idempotencyKey } },
    );
    return toLegacyHotelListing(offer, property);
  },

  /**
   * Update an offer under the selected hotel.
   */
  updateListing: async (
    id: string,
    data: UpdateListingRequest,
    propertyIdOverride?: string,
  ): Promise<HotelListing> => {
    const propertyId = await resolveSelectedPropertyId(propertyIdOverride);
    const property = await sharedHotelSetupApi.getPropertyProfile(propertyId);
    const offer = await targetApiClient.put<TargetMarketplaceOffer>(
      `${marketplaceOffersPath(propertyId)}/${encodeURIComponent(id)}`,
      toTargetOfferUpdate(data),
    );
    return toLegacyHotelListing(offer, property);
  },

  /**
   * Delete an offer under the selected hotel.
   */
  deleteListing: async (id: string, propertyIdOverride?: string): Promise<void> => {
    const propertyId = await resolveSelectedPropertyId(propertyIdOverride);
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
    options?: { idempotencyKey?: string },
  ): Promise<{ images: Array<{ url: string; mediaObjectId: string }> }> => {
    const uploaded = await uploadPlatformMedia({
      idempotencyKey: options?.idempotencyKey,
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
   * Reuse canonical hotel photos without asking the hotel to upload them again.
   * The copied files still become offer-owned media, so Marketplace review and
   * publication keep their existing media-approval boundary.
   */
  uploadListingImagesFromSources: async (
    sourceImageUrls: string[],
    files: File[],
    listingId: string,
    options?: { idempotencyKey?: string },
  ): Promise<{ images: Array<{ url: string; mediaObjectId: string }> }> => {
    const copiedFiles = await Promise.all(sourceImageUrls.map(remoteImageFile));
    return hotelService.uploadListingImages([...copiedFiles, ...files], listingId, options);
  },

  /**
   * Get the selected hotel's Marketplace completion status.
   */
  getProfileStatus: async (propertyIdOverride?: string): Promise<HotelProfileStatus> => {
    const propertyId = await resolveSelectedPropertyId(propertyIdOverride);
    return targetApiClient.get<HotelProfileStatus>(
      `/api/marketplace/properties/${encodeURIComponent(propertyId)}/profile-status`,
    );
  },
};

async function resolveSelectedPropertyId(propertyIdOverride?: string): Promise<string> {
  const requestedPropertyId = propertyIdOverride?.trim();
  if (requestedPropertyId) return requestedPropertyId;

  const storage = typeof window === "undefined" ? null : window.localStorage;
  const storedPropertyId = readSelectedSharedPropertyId(storage);
  if (storedPropertyId) return storedPropertyId;

  const status = await sharedHotelSetupApi.getStatus({ entryProduct: "marketplace" });
  const propertyId =
    status.propertySelection.selectedPropertyId ??
    status.propertySelection.availableProperties[0]?.propertyId ??
    null;
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

async function updateHotelProfile(
  data: UpdateHotelProfileRequest | FormData,
  propertyIdOverride: string | undefined,
  revisions: HotelProfileRevisionSnapshot | undefined,
  targets: {
    publicProfile: boolean;
    marketplaceProfile: boolean;
  },
): Promise<HotelProfile> {
  if (data instanceof FormData) {
    throw new Error("Hotel profile updates must use JSON and platform media uploads");
  }
  if (!revisions) {
    throw new Error("Hotel profile updates require the editor-loaded profile revisions");
  }

  const propertyId = await resolveSelectedPropertyId(propertyIdOverride);
  const property = await sharedHotelSetupApi.getPropertyProfile(propertyId);
  assertLocationIsUnchanged(property, data);
  const canonicalUpdate = applyCanonicalProfileUpdate(
    property,
    data,
    revisions.canonicalProfileRevision,
  );
  let expectedPublicProfileRevision = revisions.publicProfileRevision;
  if (canonicalUpdate) {
    if (canonicalProfileUpdateMatches(property, data)) {
      if (property.profileRevision !== revisions.canonicalProfileRevision) {
        expectedPublicProfileRevision = property.profileRevision;
      }
    } else {
      const updated = await sharedHotelSetupApi.updatePropertyProfile(propertyId, canonicalUpdate);
      expectedPublicProfileRevision = updated.profileRevision;
    }
  }

  if (targets.publicProfile && changesPublicPropertyProfile(data)) {
    const publicProfile = await sharedHotelSetupApi.getPublicPropertyProfile(propertyId);
    const publicUpdate = applyPublicPropertyProfileUpdate(
      publicProfile,
      data,
      expectedPublicProfileRevision,
    );
    if (publicUpdate) {
      await sharedHotelSetupApi.updatePublicPropertyProfile(propertyId, publicUpdate);
    }
  }

  if (targets.marketplaceProfile && Object.hasOwn(data, "about")) {
    await targetApiClient.put<TargetMarketplaceProfile>(marketplaceProfilePath(propertyId), {
      hostSummary: normalizedOptionalText(data.about),
    });
  }
  return hotelService.getMyProfile(propertyId);
}

function applyCanonicalProfileUpdate(
  response: PropertyProfileResponse,
  update: UpdateHotelProfileRequest,
  expectedProfileRevision: number,
): PropertyProfileUpdateRequest | null {
  const changesCanonicalProfile =
    update.name !== undefined ||
    update.localityPublic !== undefined ||
    Object.hasOwn(update, "website") ||
    Object.hasOwn(update, "email") ||
    Object.hasOwn(update, "phone");
  if (!changesCanonicalProfile) return null;

  const patch: PropertyProfileUpdateRequest["patch"] = {};
  if (update.name !== undefined) {
    patch.displayName = update.name.trim() || response.profile.displayName;
  }
  if (update.localityPublic !== undefined) {
    patch.location = { localityPublic: update.localityPublic };
  }
  if (
    Object.hasOwn(update, "website") ||
    Object.hasOwn(update, "email") ||
    Object.hasOwn(update, "phone")
  ) {
    let contacts = response.profile.contacts;
    if (Object.hasOwn(update, "website")) {
      contacts = withGeneralContact(
        contacts,
        "website",
        normalizedOptionalText(update.website),
        true,
      );
    }
    if (Object.hasOwn(update, "email")) {
      contacts = withGeneralContact(contacts, "email", normalizedOptionalText(update.email), false);
    }
    if (Object.hasOwn(update, "phone")) {
      contacts = withGeneralContact(contacts, "phone", normalizedOptionalText(update.phone), false);
    }
    patch.contacts = contacts;
  }

  return {
    expectedProfileRevision,
    patch,
  };
}

function canonicalProfileUpdateMatches(
  response: PropertyProfileResponse,
  update: UpdateHotelProfileRequest,
): boolean {
  if (
    update.name !== undefined &&
    response.profile.displayName !== (update.name.trim() || response.profile.displayName)
  ) {
    return false;
  }
  if (
    update.localityPublic !== undefined &&
    response.profile.location.localityPublic !== update.localityPublic
  ) {
    return false;
  }
  let expectedContacts = response.profile.contacts;
  for (const [channelType, isPublic] of [
    ["website", true],
    ["email", false],
    ["phone", false],
  ] as const) {
    if (Object.hasOwn(update, channelType)) {
      expectedContacts = withGeneralContact(
        expectedContacts,
        channelType,
        normalizedOptionalText(update[channelType]),
        isPublic,
      );
    }
  }
  if (!samePropertyContacts(response.profile.contacts, expectedContacts)) {
    return false;
  }
  return true;
}

function samePropertyContacts(
  left: readonly PropertyProfileContact[],
  right: readonly PropertyProfileContact[],
): boolean {
  return (
    left.length === right.length &&
    left.every((contact, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        contact.channelType === other.channelType &&
        contact.value === other.value &&
        contact.purpose === other.purpose &&
        contact.isPublic === other.isPublic
      );
    })
  );
}

function applyPublicPropertyProfileUpdate(
  response: PublicPropertyProfileResponse,
  update: UpdateHotelProfileRequest,
  expectedProfileRevision: number,
): PublicPropertyProfileUpdateRequest | null {
  const patch: PublicPropertyProfileUpdateRequest["patch"] = {};
  if (Object.hasOwn(update, "about")) {
    const shortDescription = normalizedOptionalText(update.about);
    if (normalizedOptionalText(response.publicProfile.shortDescription) !== shortDescription) {
      patch.shortDescription = shortDescription;
    }
  }
  if (update.picture === null) {
    patch.media = response.publicProfile.media
      .filter(({ mediaType }) => mediaType !== "hero_image")
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map(({ mediaObjectId, altText }, index) => ({
        mediaObjectId,
        altText,
        sortOrder: index,
      }));
  } else {
    const pictureMediaObjectId =
      update.pictureMediaObjectId ?? update.picture_media_object_id ?? null;
    if (pictureMediaObjectId) {
      const matchingMedia = response.publicProfile.media.find(
        ({ mediaObjectId }) => mediaObjectId === pictureMediaObjectId,
      );
      const retainedMedia = response.publicProfile.media
        .filter(
          ({ mediaObjectId, mediaType }) =>
            mediaType !== "hero_image" && mediaObjectId !== pictureMediaObjectId,
        )
        .sort((left, right) => left.sortOrder - right.sortOrder);
      patch.media = [
        {
          mediaObjectId: pictureMediaObjectId,
          altText: matchingMedia?.altText ?? null,
          sortOrder: 0,
        },
        ...retainedMedia.map(({ mediaObjectId, altText }, index) => ({
          mediaObjectId,
          altText,
          sortOrder: index + 1,
        })),
      ];
    }
  }
  if (Object.keys(patch).length === 0) return null;

  return {
    expectedProfileRevision,
    patch,
  };
}

function toLegacyHotelProfile(
  property: PropertyProfileResponse,
  publicProfile: PublicPropertyProfileResponse,
  marketplaceProfile: TargetMarketplaceProfile,
  offers: TargetMarketplaceOffer[],
): HotelProfile {
  const user = getAuthSessionUser();
  const email =
    profileContactValue(property, "email") ??
    user?.email ??
    (typeof window === "undefined" ? "" : (localStorage.getItem(STORAGE_KEYS.USER_EMAIL) ?? ""));
  const location = formatPropertyLocation(property);
  const picture = publicProfilePicture(publicProfile);
  return {
    id: property.propertyId,
    user_id: user?.id ?? property.propertyId,
    canonicalProfileRevision: property.profileRevision,
    publicProfileRevision: publicProfile.profileRevision,
    name: property.profile.displayName,
    propertyType: property.profile.propertyType,
    category: "Hotel",
    location,
    localityPublic: property.profile.location.localityPublic,
    picture,
    website: profileContactValue(property, "website"),
    about:
      normalizedOptionalText(publicProfile.publicProfile.shortDescription) ??
      normalizedOptionalText(publicProfile.publicProfile.longDescription),
    publicAbout:
      normalizedOptionalText(publicProfile.publicProfile.shortDescription) ??
      normalizedOptionalText(publicProfile.publicProfile.longDescription),
    marketplaceAbout: normalizedOptionalText(marketplaceProfile.hostSummary),
    email,
    phone: profileContactValue(property, "phone"),
    status: toLegacyProfileStatus(marketplaceProfile.profileStatus),
    created_at: marketplaceProfile.createdAt,
    updated_at: marketplaceProfile.updatedAt,
    listings: offers.map((offer) => toLegacyHotelListing(offer, property)),
  };
}

function changesPublicPropertyProfile(update: UpdateHotelProfileRequest): boolean {
  return (
    Object.hasOwn(update, "about") ||
    update.picture === null ||
    Boolean(update.pictureMediaObjectId ?? update.picture_media_object_id)
  );
}

function assertLocationIsUnchanged(
  property: PropertyProfileResponse,
  update: UpdateHotelProfileRequest,
): void {
  if (
    Object.hasOwn(update, "location") &&
    update.location?.trim() !== formatPropertyLocation(property)
  ) {
    throw new HotelAddressSetupRequiredError();
  }
}

function publicProfilePicture(response: PublicPropertyProfileResponse): string | null {
  const media = [...response.publicProfile.media].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  );
  return (
    media.find(({ mediaType }) => mediaType === "hero_image")?.url ??
    media.find(({ mediaType }) => mediaType === "gallery_image")?.url ??
    null
  );
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
  property: PropertyProfileResponse,
): HotelListing {
  return {
    id: offer.offerId,
    media_resource_id: offer.mediaResourceId,
    hotel_profile_id: offer.propertyId,
    name: offer.title,
    location: formatPropertyLocation(property),
    description: offer.offerSummary ?? "",
    accommodation_type: property.profile.propertyType,
    images: offer.media.flatMap((media) => (media.url ? [media.url] : [])),
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
      terms_summary: option.termsSummary,
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

function formatPropertyLocation(response: PropertyProfileResponse): string {
  const location = response.profile.location;
  const countryCode = location.countryCode.toUpperCase() as keyof typeof countries;
  const countryName = countries[countryCode]?.name ?? location.countryCode;
  return [location.city, countryName].filter(Boolean).join(", ");
}

function profileContactValue(
  response: PropertyProfileResponse,
  channelType: PropertyProfileContact["channelType"],
): string | null {
  const contacts = response.profile.contacts.filter(
    (contact) => contact.channelType === channelType,
  );
  return (
    contacts.find((contact) => contact.purpose === "general")?.value ?? contacts[0]?.value ?? null
  );
}

function withGeneralContact(
  contacts: PropertyProfileContact[],
  channelType: PropertyProfileContact["channelType"],
  value: string | null,
  isPublic: boolean,
): PropertyProfileContact[] {
  const existingIndex = contacts.findIndex(
    (contact) => contact.channelType === channelType && contact.purpose === "general",
  );
  if (!value) {
    return existingIndex === -1 ? contacts : contacts.filter((_, index) => index !== existingIndex);
  }

  const contact: PropertyProfileContact = {
    channelType,
    value,
    purpose: "general",
    isPublic: existingIndex === -1 ? isPublic : contacts[existingIndex]!.isPublic,
  };
  if (existingIndex === -1) return [...contacts, contact];
  return contacts.map((current, index) => (index === existingIndex ? contact : current));
}

function normalizedOptionalText(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

async function remoteImageFile(url: string, index: number): Promise<File> {
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new CanonicalHotelPhotoReuseError(url);

    const blob = await response.blob();
    const extension = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    }[blob.type];
    if (!extension) throw new CanonicalHotelPhotoReuseError(url);

    return new File([blob], `shared-hotel-photo-${index + 1}.${extension}`, { type: blob.type });
  } catch (error) {
    if (error instanceof CanonicalHotelPhotoReuseError) throw error;
    throw new CanonicalHotelPhotoReuseError(url);
  }
}

function randomIdentifier(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
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
    terms_summary: option.termsSummary,
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
