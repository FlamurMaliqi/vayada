export const PROPERTY_MEDIA_UPLOAD_PURPOSES = Object.freeze([
  "property.logo",
  "property.hero_image",
  "property.gallery_image",
  "pms.room_type.media",
] as const);

export const PROPERTY_MEDIA_PRESENTATION_ROLES = Object.freeze([
  "logo",
  "cover",
  "gallery",
] as const);
export const PROPERTY_MEDIA_PUBLIC_VARIANTS = Object.freeze([
  "original_safe",
  "large",
  "thumbnail",
  "blur_preview",
] as const);
export const PROPERTY_MEDIA_LIBRARY_STATUSES = Object.freeze([
  "processing",
  "private_ready",
  "public_ready",
  "rejected",
] as const);

export const PROPERTY_MEDIA_AUTHORIZATION = Object.freeze({
  permission: "hotel_catalog.setup.manage",
  product: "hotel_catalog",
  resourceType: "property",
  allowedRelationships: Object.freeze(["owner", "operator"] as const),
} as const);

export const PROPERTY_MEDIA_MAX_GALLERY_ITEMS = 25;
export const PROPERTY_MEDIA_MAX_ALT_TEXT_LENGTH = 500;

export type PropertyMediaUploadPurpose = (typeof PROPERTY_MEDIA_UPLOAD_PURPOSES)[number];
export type PropertyMediaPresentationRole = (typeof PROPERTY_MEDIA_PRESENTATION_ROLES)[number];
export type PropertyMediaPublicVariantName = (typeof PROPERTY_MEDIA_PUBLIC_VARIANTS)[number];
export type PropertyMediaLibraryStatus = (typeof PROPERTY_MEDIA_LIBRARY_STATUSES)[number];

export type PropertyMediaPublicVariant = {
  variantName: PropertyMediaPublicVariantName;
  publicUrl: string;
};

/**
 * Product-neutral library view. Private storage keys and preview URLs are
 * deliberately absent; only approved public variants may leave this boundary.
 */
export type PropertyMediaLibraryItem = {
  mediaObjectId: string;
  purpose: PropertyMediaUploadPurpose;
  status: PropertyMediaLibraryStatus;
  publicVariants: readonly PropertyMediaPublicVariant[];
};

export type PropertyMediaAssignment = {
  mediaObjectId: string;
  role: PropertyMediaPresentationRole;
  altText: string | null;
  sortOrder: number;
};

export type AssignPropertyLogoRequest = {
  expectedProfileRevision: number;
  assignment: (PropertyMediaAssignment & { role: "logo"; sortOrder: 0 }) | null;
};

export type ReplacePropertyPresentationMediaRequest = {
  expectedProfileRevision: number;
  assignments: readonly (PropertyMediaAssignment & { role: "cover" | "gallery" })[];
};

export type PropertyMediaCommandResponse = {
  outcome: "updated" | "idempotent_replay";
  profileRevision: number;
  logoAssignment: (PropertyMediaAssignment & { role: "logo"; sortOrder: 0 }) | null;
  presentationAssignments: readonly (PropertyMediaAssignment & {
    role: "cover" | "gallery";
  })[];
};

export type PropertyMediaCommandError =
  | { code: "profile_revision_conflict"; currentRevision: number }
  | {
      code: "idempotency_key_conflict" | "command_in_progress" | "media_publication_failed";
    }
  | {
      code: "media_not_found" | "media_not_authorized" | "media_not_ready";
      mediaObjectIds: string[];
    };

export function parsePropertyMediaLibraryItem(value: unknown): PropertyMediaLibraryItem | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["mediaObjectId", "purpose", "status", "publicVariants"]) ||
    !isUuid(value["mediaObjectId"]) ||
    !PROPERTY_MEDIA_UPLOAD_PURPOSES.includes(value["purpose"] as PropertyMediaUploadPurpose) ||
    !PROPERTY_MEDIA_LIBRARY_STATUSES.includes(value["status"] as PropertyMediaLibraryStatus) ||
    !Array.isArray(value["publicVariants"])
  ) {
    return null;
  }
  const parsedVariants = value["publicVariants"].map(parsePublicVariant);
  if (parsedVariants.some((variant) => variant === null)) return null;
  const variants = parsedVariants as PropertyMediaPublicVariant[];
  if (
    new Set(variants.map(({ variantName }) => variantName)).size !== variants.length ||
    (value["status"] === "public_ready" ? variants.length === 0 : variants.length > 0)
  ) {
    return null;
  }
  return Object.freeze({
    mediaObjectId: normalizeUuid(value["mediaObjectId"]),
    purpose: value["purpose"] as PropertyMediaUploadPurpose,
    status: value["status"] as PropertyMediaLibraryStatus,
    publicVariants: Object.freeze(variants as PropertyMediaPublicVariant[]),
  });
}

export function parseAssignPropertyLogoRequest(value: unknown): AssignPropertyLogoRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["expectedProfileRevision", "assignment"]) ||
    !isPositiveRevision(value["expectedProfileRevision"])
  ) {
    return null;
  }
  if (value["assignment"] === null) {
    return Object.freeze({
      expectedProfileRevision: value["expectedProfileRevision"] as number,
      assignment: null,
    });
  }
  const assignment = parseAssignment(value["assignment"]);
  if (assignment?.role !== "logo" || assignment.sortOrder !== 0) return null;
  return Object.freeze({
    expectedProfileRevision: value["expectedProfileRevision"] as number,
    assignment: assignment as PropertyMediaAssignment & { role: "logo"; sortOrder: 0 },
  });
}

export function parseReplacePropertyPresentationMediaRequest(
  value: unknown,
): ReplacePropertyPresentationMediaRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["expectedProfileRevision", "assignments"]) ||
    !isPositiveRevision(value["expectedProfileRevision"]) ||
    !Array.isArray(value["assignments"])
  ) {
    return null;
  }
  const assignments = value["assignments"].map(parseAssignment);
  if (assignments.some((assignment) => assignment === null)) return null;
  const parsed = assignments as PropertyMediaAssignment[];
  if (!isValidPresentationAssignments(parsed)) return null;
  return Object.freeze({
    expectedProfileRevision: value["expectedProfileRevision"] as number,
    assignments: Object.freeze(
      parsed as (PropertyMediaAssignment & { role: "cover" | "gallery" })[],
    ),
  });
}

function isValidPresentationAssignments(assignments: PropertyMediaAssignment[]): boolean {
  const galleryCount = assignments.filter(({ role }) => role === "gallery").length;
  const coverCount = assignments.filter(({ role }) => role === "cover").length;
  return !(
    assignments.some(({ role }) => role === "logo") ||
    coverCount > 1 ||
    galleryCount > PROPERTY_MEDIA_MAX_GALLERY_ITEMS ||
    new Set(assignments.map(({ mediaObjectId, role }) => `${role}:${mediaObjectId.toLowerCase()}`))
      .size !== assignments.length ||
    assignments.some(({ sortOrder }, index) => sortOrder !== index) ||
    (coverCount === 1 && assignments[0]?.role !== "cover")
  );
}

function parseAssignment(value: unknown): PropertyMediaAssignment | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["mediaObjectId", "role", "altText", "sortOrder"]) ||
    !isUuid(value["mediaObjectId"]) ||
    !PROPERTY_MEDIA_PRESENTATION_ROLES.includes(value["role"] as PropertyMediaPresentationRole) ||
    !isValidAltText(value["altText"]) ||
    !isNonNegativeInteger(value["sortOrder"])
  ) {
    return null;
  }
  return Object.freeze({
    mediaObjectId: normalizeUuid(value["mediaObjectId"]),
    role: value["role"] as PropertyMediaPresentationRole,
    altText: value["altText"] as string | null,
    sortOrder: value["sortOrder"] as number,
  });
}

function parsePublicVariant(value: unknown): PropertyMediaPublicVariant | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["variantName", "publicUrl"]) ||
    !PROPERTY_MEDIA_PUBLIC_VARIANTS.includes(
      value["variantName"] as PropertyMediaPublicVariantName,
    ) ||
    !isPublicHttpsUrl(value["publicUrl"])
  ) {
    return null;
  }
  return Object.freeze({
    variantName: value["variantName"] as PropertyMediaPublicVariantName,
    publicUrl: value["publicUrl"] as string,
  });
}

function isPublicHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === allowed.length && allowed.every((key) => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function normalizeUuid(value: string): string {
  return value.toLowerCase();
}

function isValidAltText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= PROPERTY_MEDIA_MAX_ALT_TEXT_LENGTH)
  );
}

function isPositiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647
  );
}
