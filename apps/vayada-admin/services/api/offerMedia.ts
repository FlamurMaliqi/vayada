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
    super("The offer was saved, but its media was not published.", options);
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
    await publishOfferMedia(hotelUserId, offer.offerId, files);
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
    await publishOfferMedia(hotelUserId, offerId, files);
  } catch (cause) {
    throw new OfferMediaPublicationError(offerId, { cause });
  }
}

async function publishOfferMedia(
  hotelUserId: string,
  offerId: string,
  files: File[],
): Promise<void> {
  if (files.length === 0) return;
  const uploaded = await uploadService.uploadListingImages(files, offerId);
  await usersService.verifyOffer(hotelUserId, offerId, uploaded.mediaObjectIds);
}
