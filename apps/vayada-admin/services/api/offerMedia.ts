import type { MarketplaceAdminOffer } from "@vayada/marketplace-shared/api/admin";

import { uploadService } from "./upload";
import { usersService } from "./users";

type CreateOfferData = Parameters<typeof usersService.createOffer>[1];
type UpdateOfferData = Parameters<typeof usersService.updateOffer>[2];

export class OfferMediaPublicationError extends Error {
  constructor(
    readonly offerId: string,
    options: { cause: unknown },
  ) {
    super("The offer was saved, but its photos could not be uploaded.", options);
    this.name = "OfferMediaPublicationError";
  }
}

export async function createOfferWithMedia(
  hotelUserId: string,
  data: CreateOfferData,
  files: File[],
): Promise<MarketplaceAdminOffer> {
  const offer = await usersService.createOffer(hotelUserId, data);
  try {
    if (files.length) await uploadService.uploadListingImages(files, offer.offerId);
  } catch (cause) {
    throw new OfferMediaPublicationError(offer.offerId, { cause });
  }
  return offer;
}

export async function updateOfferWithMedia(
  hotelUserId: string,
  offerId: string,
  data: UpdateOfferData,
  files: File[],
): Promise<void> {
  await usersService.updateOffer(hotelUserId, offerId, data);
  try {
    if (files.length) await uploadService.uploadListingImages(files, offerId);
  } catch (cause) {
    throw new OfferMediaPublicationError(offerId, { cause });
  }
}
