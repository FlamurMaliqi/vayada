import type { ListingFormData } from "@/lib/types";

export function canRemoveListingImage(listing: ListingFormData, imageIndex: number): boolean {
  if (!listing.marketplaceOnboarding?.existingOffer) return true;
  const localImageStart = Math.max(0, listing.images.length - listing.imageFiles.length);
  return imageIndex >= localImageStart;
}

export function removeListingImageAt(
  listing: ListingFormData,
  imageIndex: number,
): ListingFormData {
  if (imageIndex < 0 || imageIndex >= listing.images.length) return listing;

  const localImageStart = Math.max(0, listing.images.length - listing.imageFiles.length);
  const nextFiles =
    imageIndex >= localImageStart
      ? listing.imageFiles.filter((_, index) => index !== imageIndex - localImageStart)
      : listing.imageFiles;
  const mediaObjectIds = listing.imageMediaObjectIds ?? [];
  const nextMediaObjectIds =
    imageIndex < Math.min(localImageStart, mediaObjectIds.length)
      ? mediaObjectIds.filter((_, index) => index !== imageIndex)
      : mediaObjectIds;

  return {
    ...listing,
    images: listing.images.filter((_, index) => index !== imageIndex),
    imageFiles: nextFiles,
    imageMediaObjectIds: nextMediaObjectIds,
  };
}
