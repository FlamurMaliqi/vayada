import type { HotelFormState, ListingFormData } from "@/lib/types";

const DRAFT_KEY_PREFIX = "vayada_hotel_marketplace_draft";
const DRAFT_VERSION = 2;
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

type PersistedListing = Omit<ListingFormData, "imageFiles">;

export type HotelMarketplaceDraft = {
  version: typeof DRAFT_VERSION;
  savedAt: number;
  currentStep: number;
  form: HotelFormState;
  listings: PersistedListing[];
  omittedLocalPhotos: boolean;
};

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function draftKey(propertyId: string): string {
  return `${DRAFT_KEY_PREFIX}:${propertyId}`;
}

function isPersistableImage(image: string): boolean {
  return !image.startsWith("data:") && !image.startsWith("blob:");
}

export function ensureHotelMarketplaceOfferIdempotency(listing: ListingFormData): ListingFormData {
  const rawKey = listing.marketplaceOnboarding?.idempotencyKey;
  const existingKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (existingKey) return listing;
  return {
    ...listing,
    marketplaceOnboarding: {
      idempotencyKey: `marketplace.hotel-onboarding.offer:${randomIdentifier()}:v1`,
    },
  };
}

export function initialHotelMarketplaceOfferImages(picture?: string | null): string[] {
  const image = picture?.trim();
  return image ? [image] : [];
}

export function recoverHotelMarketplaceOfferFromSourceMediaFailure(
  listing: ListingFormData,
  copiedSourceUrls: readonly string[],
  progress: NonNullable<ListingFormData["marketplaceOnboarding"]>,
): ListingFormData {
  const remainingSources = new Map<string, number>();
  for (const sourceUrl of copiedSourceUrls) {
    remainingSources.set(sourceUrl, (remainingSources.get(sourceUrl) ?? 0) + 1);
  }

  let mediaBackedImagesRemaining = listing.imageMediaObjectIds?.length ?? 0;
  const images = listing.images.filter((image) => {
    if (image.startsWith("data:")) return true;
    if (mediaBackedImagesRemaining > 0) {
      mediaBackedImagesRemaining -= 1;
      return true;
    }

    const remaining = remainingSources.get(image) ?? 0;
    if (remaining === 0) return true;
    remainingSources.set(image, remaining - 1);
    return false;
  });

  return {
    ...listing,
    images,
    marketplaceOnboarding: {
      ...progress,
      mediaPending: true,
    },
  };
}

export function createHotelMarketplaceDraft(
  form: HotelFormState,
  listings: ListingFormData[],
  currentStep: number,
  now = Date.now(),
): HotelMarketplaceDraft {
  let omittedLocalPhotos = false;
  const persistedListings = listings.map((value) => {
    const { imageFiles, ...listing } = ensureHotelMarketplaceOfferIdempotency(value);
    const images = listing.images.filter(isPersistableImage);
    if (imageFiles.length > 0 || images.length !== listing.images.length) {
      omittedLocalPhotos = true;
    }
    return { ...listing, images };
  });

  return {
    version: DRAFT_VERSION,
    savedAt: now,
    currentStep: Math.max(1, Math.min(4, currentStep)),
    form,
    listings: persistedListings,
    omittedLocalPhotos,
  };
}

export function recoverHotelMarketplaceDraftFromSourceMediaFailure(
  draft: Omit<HotelMarketplaceDraft, "listings"> & { listings: ListingFormData[] },
  idempotencyKey: string,
  copiedSourceUrls: readonly string[],
  progress: NonNullable<ListingFormData["marketplaceOnboarding"]>,
  now = Date.now(),
): HotelMarketplaceDraft {
  const recovered = createHotelMarketplaceDraft(
    draft.form,
    draft.listings.map((listing) =>
      listing.marketplaceOnboarding?.idempotencyKey === idempotencyKey
        ? recoverHotelMarketplaceOfferFromSourceMediaFailure(listing, copiedSourceUrls, progress)
        : listing,
    ),
    2,
    now,
  );
  return {
    ...recovered,
    omittedLocalPhotos: draft.omittedLocalPhotos || recovered.omittedLocalPhotos,
  };
}

export function saveHotelMarketplaceDraft(
  storage: DraftStorage,
  propertyId: string,
  draft: HotelMarketplaceDraft,
): void {
  const savedOfferProgress = readOfferProgress(storage.getItem(draftKey(propertyId)));
  const listings = draft.listings.map((listing) => {
    const idempotencyKey = listing.marketplaceOnboarding?.idempotencyKey;
    const savedProgress = idempotencyKey ? savedOfferProgress.get(idempotencyKey) : undefined;
    return savedProgress && !listing.marketplaceOnboarding?.createdOfferId
      ? { ...listing, marketplaceOnboarding: savedProgress }
      : listing;
  });
  storage.setItem(draftKey(propertyId), JSON.stringify({ ...draft, listings }));
}

export function readHotelMarketplaceDraft(
  storage: DraftStorage,
  propertyId: string,
  now = Date.now(),
): (HotelMarketplaceDraft & { listings: ListingFormData[] }) | null {
  const rawDraft = storage.getItem(draftKey(propertyId));
  if (!rawDraft) return null;

  try {
    const parsed = JSON.parse(rawDraft) as Partial<Omit<HotelMarketplaceDraft, "version">> & {
      version?: number;
    };
    if (
      (parsed.version !== 1 && parsed.version !== DRAFT_VERSION) ||
      typeof parsed.savedAt !== "number" ||
      now - parsed.savedAt > MAX_DRAFT_AGE_MS ||
      typeof parsed.currentStep !== "number" ||
      typeof parsed.form?.about !== "string" ||
      !Array.isArray(parsed.listings)
    ) {
      storage.removeItem(draftKey(propertyId));
      return null;
    }

    return {
      ...parsed,
      version: DRAFT_VERSION,
      savedAt: parsed.savedAt,
      currentStep: Math.max(1, Math.min(4, parsed.currentStep)),
      form: parsed.form,
      listings: parsed.listings.map((listing) =>
        ensureHotelMarketplaceOfferIdempotency({ ...listing, imageFiles: [] }),
      ),
      omittedLocalPhotos: parsed.omittedLocalPhotos === true,
    };
  } catch {
    storage.removeItem(draftKey(propertyId));
    return null;
  }
}

export function clearHotelMarketplaceDraft(storage: DraftStorage, propertyId: string): void {
  storage.removeItem(draftKey(propertyId));
}

export function markHotelMarketplaceDraftOfferCreated(
  storage: DraftStorage,
  propertyId: string,
  idempotencyKey: string,
  createdOfferId: string,
  now = Date.now(),
): void {
  markHotelMarketplaceDraftOfferProgress(
    storage,
    propertyId,
    idempotencyKey,
    { idempotencyKey, createdOfferId },
    now,
  );
}

export function markHotelMarketplaceDraftOfferProgress(
  storage: DraftStorage,
  propertyId: string,
  idempotencyKey: string,
  progress: NonNullable<ListingFormData["marketplaceOnboarding"]>,
  now = Date.now(),
): void {
  const draft = readHotelMarketplaceDraft(storage, propertyId, now);
  if (!draft) return;
  const listings = draft.listings.map((listing) =>
    listing.marketplaceOnboarding?.idempotencyKey === idempotencyKey
      ? {
          ...listing,
          marketplaceOnboarding: {
            ...progress,
            idempotencyKey,
          },
        }
      : listing,
  );
  saveHotelMarketplaceDraft(storage, propertyId, {
    ...draft,
    version: DRAFT_VERSION,
    savedAt: now,
    listings,
  });
}

export function pendingHotelMarketplaceDraftListings(draft: {
  listings: readonly ListingFormData[];
}): ListingFormData[] {
  return draft.listings.filter(
    (listing) =>
      !listing.marketplaceOnboarding?.createdOfferId ||
      listing.marketplaceOnboarding.mediaPending === true,
  );
}

export function resolveHotelMarketplaceDraftResume(
  draft: { listings: readonly ListingFormData[] },
  hasExistingMarketplaceOffer: boolean,
): { listings: ListingFormData[]; hasExistingMarketplaceOffer: boolean } {
  const listings = pendingHotelMarketplaceDraftListings(draft);
  return {
    listings,
    hasExistingMarketplaceOffer: hasExistingMarketplaceOffer && listings.length === 0,
  };
}

function randomIdentifier(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function readOfferProgress(
  rawDraft: string | null,
): Map<string, NonNullable<ListingFormData["marketplaceOnboarding"]>> {
  if (!rawDraft) return new Map();
  try {
    const parsed = JSON.parse(rawDraft) as { listings?: unknown };
    if (!Array.isArray(parsed.listings)) return new Map();
    return new Map(
      parsed.listings.flatMap((listing) => {
        if (typeof listing !== "object" || listing === null) return [];
        const onboarding = (listing as { marketplaceOnboarding?: unknown }).marketplaceOnboarding;
        if (typeof onboarding !== "object" || onboarding === null) return [];
        const { idempotencyKey, createdOfferId, createdOfferMediaResourceId, mediaPending } =
          onboarding as {
            idempotencyKey?: unknown;
            createdOfferId?: unknown;
            createdOfferMediaResourceId?: unknown;
            mediaPending?: unknown;
          };
        return typeof idempotencyKey === "string" && typeof createdOfferId === "string"
          ? [
              [
                idempotencyKey,
                {
                  idempotencyKey,
                  createdOfferId,
                  ...(typeof createdOfferMediaResourceId === "string"
                    ? { createdOfferMediaResourceId }
                    : {}),
                  ...(typeof mediaPending === "boolean" ? { mediaPending } : {}),
                },
              ] as const,
            ]
          : [];
      }),
    );
  } catch {
    return new Map();
  }
}
