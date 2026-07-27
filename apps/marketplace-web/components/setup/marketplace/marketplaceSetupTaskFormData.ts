import type { HotelFormState, HotelListing, HotelProfile, ListingFormData } from "@/lib/types";
import {
  ensureHotelMarketplaceOfferIdempotency,
  initialHotelMarketplaceOfferImages,
} from "@/lib/utils/hotelMarketplaceDraft";

export type MarketplaceSetupTaskId = "public_profile" | "creator_profile" | "creator_offer";

export type MarketplaceSetupTaskHydration = {
  form: HotelFormState;
  listings: ListingFormData[];
  canonicalCoverUrl: string | null;
  existingOfferCoverUrl: string | null;
  hasExistingOffer: boolean;
};

export function hydrateMarketplaceSetupTask(
  profile: HotelProfile,
  taskId: MarketplaceSetupTaskId,
): MarketplaceSetupTaskHydration {
  const canonicalCoverUrl = profile.picture?.trim() || null;
  const existingOffer = profile.listings.find(
    (listing) => listing.status === "pending" || listing.status === "verified",
  );
  const coverSourceOffer =
    existingOffer ?? profile.listings.find((listing) => listing.status === "rejected");
  const existingOfferCoverUrl =
    coverSourceOffer?.images.find((image) => image.trim())?.trim() || null;

  return {
    form: {
      about:
        taskId === "public_profile"
          ? (profile.publicAbout ?? "")
          : taskId === "creator_profile"
            ? (profile.marketplaceAbout ?? "")
            : "",
      localityPublic: profile.localityPublic,
    },
    listings:
      taskId !== "creator_offer"
        ? []
        : existingOffer
          ? [existingMarketplaceOfferDraft(existingOffer)]
          : [newMarketplaceOffer(profile)],
    canonicalCoverUrl,
    existingOfferCoverUrl,
    hasExistingOffer: Boolean(existingOffer),
  };
}

function newMarketplaceOffer(profile: HotelProfile): ListingFormData {
  return ensureHotelMarketplaceOfferIdempotency({
    name: "",
    location: profile.location,
    description: "",
    accommodation_type: profile.propertyType ?? "",
    images: initialHotelMarketplaceOfferImages(profile.picture),
    imageMediaObjectIds: [],
    imageFiles: [],
    collaborationTypes: [],
    availability: [],
    platforms: [],
    lookingForPlatforms: [],
    targetGroupCountries: [],
    targetGroupAgeGroups: [],
  });
}

function existingMarketplaceOfferDraft(listing: HotelListing): ListingFormData {
  const offerings = listing.collaboration_offerings;

  return ensureHotelMarketplaceOfferIdempotency({
    name: listing.name,
    location: listing.location,
    description: listing.description,
    accommodation_type: listing.accommodation_type ?? "",
    images: listing.images,
    imageMediaObjectIds: listing.image_media_object_ids ?? [],
    imageFiles: [],
    collaborationTypes: Array.from(
      new Set(offerings.map(({ collaboration_type }) => collaboration_type)),
    ),
    availability: Array.from(
      new Set(offerings.flatMap(({ availability_months }) => availability_months)),
    ),
    platforms: Array.from(new Set(offerings.flatMap(({ platforms }) => platforms))),
    freeStayMinNights:
      offerings.find(({ collaboration_type }) => collaboration_type === "Free Stay")
        ?.free_stay_min_nights ?? undefined,
    freeStayMaxNights:
      offerings.find(({ collaboration_type }) => collaboration_type === "Free Stay")
        ?.free_stay_max_nights ?? undefined,
    paidMaxAmount:
      offerings.find(({ collaboration_type }) => collaboration_type === "Paid")?.paid_max_amount ??
      undefined,
    currency:
      offerings.find(({ collaboration_type }) => collaboration_type === "Paid")?.currency ??
      undefined,
    discountPercentage:
      offerings.find(({ collaboration_type }) => collaboration_type === "Discount")
        ?.discount_percentage ?? undefined,
    commissionPercentage:
      offerings.find(({ collaboration_type }) => collaboration_type === "Affiliate")
        ?.commission_percentage ?? undefined,
    lookingForPlatforms: listing.creator_requirements.platforms,
    targetGroupCountries: listing.creator_requirements.target_countries,
    targetGroupAgeMin: listing.creator_requirements.target_age_min ?? undefined,
    targetGroupAgeMax: listing.creator_requirements.target_age_max ?? undefined,
    targetGroupAgeGroups: listing.creator_requirements.target_age_groups ?? [],
    lookingForCreatorTypes: (listing.creator_requirements.creator_types ??
      []) as ListingFormData["lookingForCreatorTypes"],
    marketplaceOnboarding: {
      idempotencyKey: `marketplace.hotel-offer.edit:${listing.id}:v1`,
      createdOfferId: listing.id,
      ...(listing.media_resource_id
        ? { createdOfferMediaResourceId: listing.media_resource_id }
        : {}),
      mediaPending: false,
      existingOffer: true,
    },
  });
}
