import type {
  HotelCatalogStep1ReadModel,
  PropertyMediaAssignment,
  ReadinessErrorSource,
  ResolvedPublicHotelMedia,
  SourceEntityRevision,
} from "@vayada/domain-hotels";
import {
  HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
  parsePropertyMediaLibraryItem,
  parseSaveHotelCatalogStep1Request,
  PROPERTY_MEDIA_MAX_ALT_TEXT_LENGTH,
} from "@vayada/domain-hotels";

export const BOOKING_DESIGN_SNAPSHOT_CONTRACT_VERSION = "booking-design-renderer.v1" as const;
export const BOOKING_DESIGN_COVER_FALLBACK_PATH = "/vayada-logo.png" as const;

export type BookingDesignCatalogEvidencePortKey = "profile" | "cover_assignment" | "safe_media";
export type BookingDesignCatalogSourceRevision = Readonly<
  SourceEntityRevision & { ownerDomain: "hotel_catalog" }
>;
export type BookingDesignCatalogEvidenceFailure<
  Port extends BookingDesignCatalogEvidencePortKey = BookingDesignCatalogEvidencePortKey,
> =
  | Readonly<{ outcome: "missing"; evidencePort: Port; code: string }>
  | Readonly<{ outcome: "stale"; evidencePort: Port; code: string }>
  | Readonly<{
      outcome: "unavailable";
      evidencePort: Port;
      code: string;
      errorSource: ReadinessErrorSource;
    }>;
export type BookingDesignCatalogProfileEvidence = Readonly<{
  outcome: "evidence";
  evidencePort: "profile";
  organizationId: string;
  propertyId: string;
  source: BookingDesignCatalogSourceRevision;
  profile: Readonly<{
    contractVersion: HotelCatalogStep1ReadModel["contractVersion"];
    profileRevision: HotelCatalogStep1ReadModel["profileRevision"];
    displayName: HotelCatalogStep1ReadModel["displayName"];
    contentLocale: HotelCatalogStep1ReadModel["profile"]["locale"];
    shortDescription: NonNullable<HotelCatalogStep1ReadModel["profile"]["shortDescription"]>;
  }>;
}>;
export type BookingDesignCatalogCoverAssignmentEvidence = Readonly<{
  outcome: "evidence";
  evidencePort: "cover_assignment";
  organizationId: string;
  propertyId: string;
  source: BookingDesignCatalogSourceRevision;
  /** Null is explicit current no-assignment evidence, never a missing-evidence fallback. */
  cover: null | Readonly<Pick<PropertyMediaAssignment, "mediaObjectId" | "altText">>;
}>;
export type BookingDesignCatalogSafeMediaEvidence = Readonly<{
  outcome: "evidence";
  evidencePort: "safe_media";
  organizationId: string;
  propertyId: string;
  source: BookingDesignCatalogSourceRevision;
  media: ResolvedPublicHotelMedia;
}>;

export type BookingDesignCatalogEvidenceScope = Readonly<{
  organizationId: string;
  propertyId: string;
}>;
export interface BookingDesignCatalogProfileEvidencePort {
  readonly bookingDesignCatalogEvidencePort: "profile";
  getBookingDesignProfileEvidence(
    input: BookingDesignCatalogEvidenceScope,
  ): Promise<BookingDesignCatalogProfileEvidence | BookingDesignCatalogEvidenceFailure<"profile">>;
}
export interface BookingDesignCatalogCoverAssignmentEvidencePort {
  readonly bookingDesignCatalogEvidencePort: "cover_assignment";
  getBookingDesignCoverAssignmentEvidence(
    input: BookingDesignCatalogEvidenceScope,
  ): Promise<
    | BookingDesignCatalogCoverAssignmentEvidence
    | BookingDesignCatalogEvidenceFailure<"cover_assignment">
  >;
}
export interface BookingDesignCatalogSafeMediaEvidencePort {
  readonly bookingDesignCatalogEvidencePort: "safe_media";
  getBookingDesignSafeMediaEvidence(
    input: BookingDesignCatalogEvidenceScope & Readonly<{ mediaObjectId: string }>,
  ): Promise<
    BookingDesignCatalogSafeMediaEvidence | BookingDesignCatalogEvidenceFailure<"safe_media">
  >;
}

export function parseBookingDesignCatalogProfileEvidenceResult(
  value: unknown,
  expectedScope: BookingDesignCatalogEvidenceScope,
): BookingDesignCatalogProfileEvidence | BookingDesignCatalogEvidenceFailure<"profile"> | null {
  const failure = parseFailure(value, "profile");
  if (failure) return failure;
  const scope = parseScope(expectedScope);
  if (
    !scope ||
    !exact(value, [
      "outcome",
      "evidencePort",
      "organizationId",
      "propertyId",
      "source",
      "profile",
    ]) ||
    value["outcome"] !== "evidence" ||
    value["evidencePort"] !== "profile" ||
    !matchesScope(value, scope) ||
    !exact(value["profile"], [
      "contractVersion",
      "profileRevision",
      "displayName",
      "contentLocale",
      "shortDescription",
    ]) ||
    value["profile"]["contractVersion"] !== HOTEL_CATALOG_STEP1_CONTRACT_VERSION ||
    typeof value["profile"]["displayName"] !== "string" ||
    value["profile"]["displayName"].trim().length === 0
  ) {
    return null;
  }
  const parsedProfile = parseSaveHotelCatalogStep1Request({
    expectedProfileRevision: value["profile"]["profileRevision"],
    locale: value["profile"]["contentLocale"],
    shortDescription: value["profile"]["shortDescription"],
    amenities: { reviewed: true, keys: [] },
    media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
  });
  const source = parseSource(value["source"], scope.propertyId);
  if (
    !parsedProfile ||
    parsedProfile.shortDescription !== value["profile"]["shortDescription"] ||
    !source ||
    source.entityType !== "property_profile" ||
    source.revision !== `profile:${parsedProfile.expectedProfileRevision}`
  ) {
    return null;
  }
  return Object.freeze({
    outcome: "evidence",
    evidencePort: "profile",
    ...scope,
    source,
    profile: Object.freeze({
      contractVersion: HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
      profileRevision: parsedProfile.expectedProfileRevision,
      displayName: value["profile"]["displayName"],
      contentLocale: parsedProfile.locale,
      shortDescription: parsedProfile.shortDescription,
    }),
  });
}

export function parseBookingDesignCatalogCoverAssignmentEvidenceResult(
  value: unknown,
  expectedScope: BookingDesignCatalogEvidenceScope,
):
  | BookingDesignCatalogCoverAssignmentEvidence
  | BookingDesignCatalogEvidenceFailure<"cover_assignment">
  | null {
  const failure = parseFailure(value, "cover_assignment");
  if (failure) return failure;
  const scope = parseScope(expectedScope);
  if (
    !scope ||
    !exact(value, ["outcome", "evidencePort", "organizationId", "propertyId", "source", "cover"]) ||
    value["outcome"] !== "evidence" ||
    value["evidencePort"] !== "cover_assignment" ||
    !matchesScope(value, scope)
  ) {
    return null;
  }
  const source = parseSource(value["source"], scope.propertyId);
  if (!source || source.entityType !== "property_media_assignment") return null;
  if (value["cover"] === null) {
    return Object.freeze({
      outcome: "evidence",
      evidencePort: "cover_assignment",
      ...scope,
      source,
      cover: null,
    });
  }
  if (
    !exact(value["cover"], ["mediaObjectId", "altText"]) ||
    !uuid(value["cover"]["mediaObjectId"]) ||
    !validAltText(value["cover"]["altText"])
  ) {
    return null;
  }
  return Object.freeze({
    outcome: "evidence",
    evidencePort: "cover_assignment",
    ...scope,
    source,
    cover: Object.freeze({
      mediaObjectId: value["cover"]["mediaObjectId"].toLowerCase(),
      altText: value["cover"]["altText"],
    }),
  });
}

export function parseBookingDesignCatalogSafeMediaEvidenceResult(
  value: unknown,
  expectedScope: BookingDesignCatalogEvidenceScope & Readonly<{ mediaObjectId: string }>,
):
  | BookingDesignCatalogSafeMediaEvidence
  | BookingDesignCatalogEvidenceFailure<"safe_media">
  | null {
  const failure = parseFailure(value, "safe_media");
  if (failure) return failure;
  const scope = parseScope(expectedScope);
  const mediaObjectId = normalizeUuid(expectedScope.mediaObjectId);
  if (
    !scope ||
    !mediaObjectId ||
    !exact(value, ["outcome", "evidencePort", "organizationId", "propertyId", "source", "media"]) ||
    value["outcome"] !== "evidence" ||
    value["evidencePort"] !== "safe_media" ||
    !matchesScope(value, scope) ||
    !exact(value["media"], [
      "mediaObjectId",
      "ownerOrganizationId",
      "propertyId",
      "purpose",
      "publicVariants",
    ]) ||
    !dataArray(value["media"]["publicVariants"])
  ) {
    return null;
  }
  const parsedMedia = parsePropertyMediaLibraryItem({
    mediaObjectId: value["media"]["mediaObjectId"],
    purpose: value["media"]["purpose"],
    status: "public_ready",
    publicVariants: value["media"]["publicVariants"],
  });
  const ownerOrganizationId = normalizeUuid(value["media"]["ownerOrganizationId"]);
  const propertyId = normalizeUuid(value["media"]["propertyId"]);
  const source = parseSource(value["source"], mediaObjectId);
  if (
    !parsedMedia ||
    parsedMedia.mediaObjectId !== mediaObjectId ||
    ownerOrganizationId !== scope.organizationId ||
    propertyId !== scope.propertyId ||
    (parsedMedia.purpose !== "property.hero_image" &&
      parsedMedia.purpose !== "property.gallery_image") ||
    !parsedMedia.publicVariants.some(({ variantName }) => variantName === "original_safe") ||
    !source
  ) {
    return null;
  }
  const media = Object.freeze({
    mediaObjectId,
    ownerOrganizationId,
    propertyId,
    purpose: parsedMedia.purpose,
    publicVariants: parsedMedia.publicVariants,
  }) as ResolvedPublicHotelMedia;
  return Object.freeze({
    outcome: "evidence",
    evidencePort: "safe_media",
    ...scope,
    source,
    media,
  });
}

function parseFailure<Port extends BookingDesignCatalogEvidencePortKey>(
  value: unknown,
  evidencePort: Port,
): BookingDesignCatalogEvidenceFailure<Port> | null {
  if (
    exact(value, ["outcome", "evidencePort", "code"]) &&
    (value["outcome"] === "missing" || value["outcome"] === "stale") &&
    value["evidencePort"] === evidencePort &&
    token(value["code"])
  ) {
    return Object.freeze({ outcome: value["outcome"], evidencePort, code: value["code"] });
  }
  if (
    exact(value, ["outcome", "evidencePort", "code", "errorSource"]) &&
    value["outcome"] === "unavailable" &&
    value["evidencePort"] === evidencePort &&
    token(value["code"]) &&
    (value["errorSource"] === "provider" || value["errorSource"] === "system")
  ) {
    return Object.freeze({
      outcome: "unavailable",
      evidencePort,
      code: value["code"],
      errorSource: value["errorSource"],
    });
  }
  return null;
}

function parseScope(value: BookingDesignCatalogEvidenceScope) {
  const organizationId = normalizeUuid(value.organizationId);
  const propertyId = normalizeUuid(value.propertyId);
  return organizationId && propertyId ? Object.freeze({ organizationId, propertyId }) : null;
}

function matchesScope(
  value: Record<string, unknown>,
  scope: BookingDesignCatalogEvidenceScope,
): boolean {
  return (
    normalizeUuid(value["organizationId"]) === scope.organizationId &&
    normalizeUuid(value["propertyId"]) === scope.propertyId
  );
}

function parseSource(
  value: unknown,
  expectedEntityId: string,
): BookingDesignCatalogSourceRevision | null {
  if (
    !exact(value, ["ownerDomain", "entityType", "entityId", "revision"]) ||
    value["ownerDomain"] !== "hotel_catalog" ||
    !token(value["entityType"]) ||
    normalizeUuid(value["entityId"]) !== expectedEntityId ||
    !token(value["revision"])
  ) {
    return null;
  }
  return Object.freeze({
    ownerDomain: "hotel_catalog",
    entityType: value["entityType"],
    entityId: expectedEntityId,
    revision: value["revision"],
  });
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function dataArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === value.length + 1 &&
    ownKeys[value.length] === "length" &&
    Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    }).every(Boolean)
  );
}

function normalizeUuid(value: unknown): string | null {
  return uuid(value) ? value.toLowerCase() : null;
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function token(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validAltText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= PROPERTY_MEDIA_MAX_ALT_TEXT_LENGTH)
  );
}
