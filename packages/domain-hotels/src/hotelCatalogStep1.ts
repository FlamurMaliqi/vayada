import type { PropertyMediaAssignment } from "./propertyMedia.js";

export const HOTEL_CATALOG_STEP1_CONTRACT_VERSION = "hotel-catalog-step1.v1" as const;
export const HOTEL_CATALOG_STEP1_SUMMARY_MIN_LENGTH = 50;
export const HOTEL_CATALOG_STEP1_SUMMARY_MAX_LENGTH = 500;

export const HOTEL_CATALOG_CONTENT_LOCALES = Object.freeze([
  "de",
  "en",
  "es",
  "fr",
  "id",
  "it",
  "ja",
  "nl",
  "ru",
  "zh",
] as const);

export const HOTEL_CATALOG_AMENITIES = Object.freeze({
  accessible: "Accessible facilities",
  airport_shuttle: "Airport shuttle",
  air_conditioning: "Air conditioning",
  bar: "Bar",
  beach_access: "Beach access",
  breakfast: "Breakfast",
  business_center: "Business center",
  concierge: "Concierge",
  ev_charging: "EV charging",
  family_rooms: "Family rooms",
  fitness_center: "Fitness center",
  front_desk_24h: "24-hour front desk",
  garden: "Garden",
  laundry_service: "Laundry service",
  luggage_storage: "Luggage storage",
  meeting_rooms: "Meeting rooms",
  parking: "Parking",
  pet_friendly: "Pet friendly",
  restaurant: "Restaurant",
  room_service: "Room service",
  ski_storage: "Ski storage",
  spa: "Spa",
  swimming_pool: "Swimming pool",
  terrace: "Terrace",
  wifi: "Wi-Fi",
} as const);

export type HotelCatalogContentLocale = (typeof HOTEL_CATALOG_CONTENT_LOCALES)[number];
export type HotelCatalogAmenityKey = keyof typeof HOTEL_CATALOG_AMENITIES;

export type HotelCatalogStep1MediaSelection = {
  coverMediaObjectId: string | null;
  galleryMediaObjectIds: string[];
};

export type SaveHotelCatalogStep1Request = {
  expectedProfileRevision: number;
  locale: HotelCatalogContentLocale;
  shortDescription: string;
  amenities: {
    reviewed: true;
    keys: HotelCatalogAmenityKey[];
  };
  media: HotelCatalogStep1MediaSelection;
};

export type HotelCatalogStep1ReadModel = {
  contractVersion: typeof HOTEL_CATALOG_STEP1_CONTRACT_VERSION;
  propertyId: string;
  displayName: string;
  profileRevision: number;
  supportedLocales: HotelCatalogContentLocale[];
  profile: {
    locale: HotelCatalogContentLocale;
    shortDescription: string | null;
    publicSlug: string | null;
    amenities: {
      reviewed: boolean;
      keys: HotelCatalogAmenityKey[];
    };
    media: HotelCatalogStep1MediaSelection;
  };
  baseRevisions: {
    "hotel_catalog.profile": string;
    "hotel_catalog.media": string;
    "hotel_catalog.amenities": string;
  };
};

export type SaveHotelCatalogStep1Response = HotelCatalogStep1ReadModel & {
  outcome: "updated" | "idempotent_replay";
};

export type SaveHotelCatalogStep1Error =
  | { code: "property_not_found" }
  | { code: "profile_revision_conflict"; currentRevision: number }
  | { code: "idempotency_key_conflict" | "command_in_progress" | "media_publication_failed" }
  | {
      code: "media_not_found" | "media_not_authorized" | "media_not_ready";
      mediaObjectIds: string[];
    };

export type SaveHotelCatalogStep1Result =
  | { ok: true; response: SaveHotelCatalogStep1Response }
  | { ok: false; error: SaveHotelCatalogStep1Error };

export function parseSaveHotelCatalogStep1Request(
  value: unknown,
): SaveHotelCatalogStep1Request | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "expectedProfileRevision",
      "locale",
      "shortDescription",
      "amenities",
      "media",
    ]) ||
    !isPositiveRevision(value["expectedProfileRevision"]) ||
    !HOTEL_CATALOG_CONTENT_LOCALES.includes(value["locale"] as HotelCatalogContentLocale)
  ) {
    return null;
  }

  const shortDescription = normalizeSummary(value["shortDescription"]);
  const amenities = parseAmenities(value["amenities"]);
  const media = parseMedia(value["media"]);
  if (!shortDescription || !amenities || !media) return null;

  return Object.freeze({
    expectedProfileRevision: value["expectedProfileRevision"] as number,
    locale: value["locale"] as HotelCatalogContentLocale,
    shortDescription,
    amenities,
    media,
  });
}

export function parseSaveHotelCatalogStep1Response(
  value: unknown,
): SaveHotelCatalogStep1Response | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contractVersion",
      "propertyId",
      "displayName",
      "profileRevision",
      "supportedLocales",
      "profile",
      "baseRevisions",
      "outcome",
    ]) ||
    value["contractVersion"] !== HOTEL_CATALOG_STEP1_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    typeof value["displayName"] !== "string" ||
    value["displayName"].trim().length === 0 ||
    !isPositiveRevision(value["profileRevision"]) ||
    (value["outcome"] !== "updated" && value["outcome"] !== "idempotent_replay")
  ) {
    return null;
  }
  const supportedLocales = parseSupportedLocales(value["supportedLocales"]);
  const profile = parseSavedProfile(value["profile"], supportedLocales);
  const revision = value["profileRevision"] as number;
  const baseRevisions = parseBaseRevisions(value["baseRevisions"], revision);
  if (!supportedLocales || !profile || !baseRevisions) return null;
  return {
    contractVersion: HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
    propertyId: (value["propertyId"] as string).toLowerCase(),
    displayName: value["displayName"],
    profileRevision: revision,
    supportedLocales,
    profile,
    baseRevisions,
    outcome: value["outcome"] as SaveHotelCatalogStep1Response["outcome"],
  };
}

export function createHotelCatalogStep1MediaAssignments(
  selection: HotelCatalogStep1MediaSelection,
  displayName: string,
): readonly (PropertyMediaAssignment & { role: "cover" | "gallery" })[] {
  const name = publicDisplayName(displayName);
  const assignments: (PropertyMediaAssignment & { role: "cover" | "gallery" })[] = [];
  if (selection.coverMediaObjectId) {
    assignments.push({
      mediaObjectId: selection.coverMediaObjectId.toLowerCase(),
      role: "cover",
      altText: `Cover photo of ${name}`,
      sortOrder: 0,
    });
  }
  for (const [index, mediaObjectId] of selection.galleryMediaObjectIds.entries()) {
    assignments.push({
      mediaObjectId: mediaObjectId.toLowerCase(),
      role: "gallery",
      altText: `${name} gallery photo ${index + 1}`,
      sortOrder: assignments.length,
    });
  }
  return Object.freeze(assignments.map((assignment) => Object.freeze(assignment)));
}

export function hotelCatalogAmenityLabel(key: HotelCatalogAmenityKey): string {
  return HOTEL_CATALOG_AMENITIES[key];
}

function parseAmenities(value: unknown): SaveHotelCatalogStep1Request["amenities"] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["reviewed", "keys"]) ||
    value["reviewed"] !== true ||
    !Array.isArray(value["keys"])
  ) {
    return null;
  }
  const keys = value["keys"];
  if (
    keys.length > Object.keys(HOTEL_CATALOG_AMENITIES).length ||
    keys.some((key) => typeof key !== "string" || !Object.hasOwn(HOTEL_CATALOG_AMENITIES, key)) ||
    new Set(keys).size !== keys.length
  ) {
    return null;
  }
  return Object.freeze({ reviewed: true, keys: Object.freeze([...keys].sort()) }) as {
    reviewed: true;
    keys: HotelCatalogAmenityKey[];
  };
}

function parseMedia(value: unknown): HotelCatalogStep1MediaSelection | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["coverMediaObjectId", "galleryMediaObjectIds"]) ||
    (value["coverMediaObjectId"] !== null && !isUuid(value["coverMediaObjectId"])) ||
    !Array.isArray(value["galleryMediaObjectIds"]) ||
    value["galleryMediaObjectIds"].length > 25 ||
    value["galleryMediaObjectIds"].some((id) => !isUuid(id))
  ) {
    return null;
  }
  const cover = value["coverMediaObjectId"] as string | null;
  const gallery = value["galleryMediaObjectIds"] as string[];
  const normalizedGallery = gallery.map((id) => id.toLowerCase());
  if (new Set(normalizedGallery).size !== normalizedGallery.length) {
    return null;
  }
  return Object.freeze({
    coverMediaObjectId: cover?.toLowerCase() ?? null,
    galleryMediaObjectIds: Object.freeze(normalizedGallery),
  }) as HotelCatalogStep1MediaSelection;
}

function parseSupportedLocales(value: unknown): HotelCatalogContentLocale[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (locale) =>
        typeof locale !== "string" ||
        !HOTEL_CATALOG_CONTENT_LOCALES.includes(locale as HotelCatalogContentLocale),
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  const locales = value as HotelCatalogContentLocale[];
  return [...locales].sort().every((locale, index) => locale === locales[index])
    ? [...locales]
    : null;
}

function parseSavedProfile(
  value: unknown,
  supportedLocales: readonly HotelCatalogContentLocale[] | null,
): HotelCatalogStep1ReadModel["profile"] | null {
  if (
    !supportedLocales ||
    !isRecord(value) ||
    !hasExactKeys(value, ["locale", "shortDescription", "publicSlug", "amenities", "media"]) ||
    !supportedLocales.includes(value["locale"] as HotelCatalogContentLocale) ||
    typeof value["shortDescription"] !== "string" ||
    normalizeSummary(value["shortDescription"]) !== value["shortDescription"] ||
    typeof value["publicSlug"] !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value["publicSlug"]) ||
    value["publicSlug"].length > 63
  ) {
    return null;
  }
  const amenities = parseAmenities(value["amenities"]);
  const media = parseMedia(value["media"]);
  if (!amenities || !media) return null;
  return {
    locale: value["locale"] as HotelCatalogContentLocale,
    shortDescription: value["shortDescription"] as string,
    publicSlug: value["publicSlug"],
    amenities,
    media,
  };
}

function parseBaseRevisions(
  value: unknown,
  profileRevision: number,
): HotelCatalogStep1ReadModel["baseRevisions"] | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "hotel_catalog.profile",
      "hotel_catalog.media",
      "hotel_catalog.amenities",
    ])
  ) {
    return null;
  }
  const expected = `profile:${profileRevision}`;
  if (
    value["hotel_catalog.profile"] !== expected ||
    value["hotel_catalog.media"] !== expected ||
    value["hotel_catalog.amenities"] !== expected
  ) {
    return null;
  }
  return {
    "hotel_catalog.profile": expected,
    "hotel_catalog.media": expected,
    "hotel_catalog.amenities": expected,
  };
}

function normalizeSummary(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const characterCount = Array.from(normalized).length;
  return characterCount >= HOTEL_CATALOG_STEP1_SUMMARY_MIN_LENGTH &&
    characterCount <= HOTEL_CATALOG_STEP1_SUMMARY_MAX_LENGTH
    ? normalized
    : null;
}

function publicDisplayName(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 180)
    .trim();
  return normalized || "this property";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isPositiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
