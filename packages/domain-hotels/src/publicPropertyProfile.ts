export const PUBLIC_PROPERTY_MEDIA_TYPES = ["hero_image", "gallery_image", "logo"] as const;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export type PublicPropertyMediaType = (typeof PUBLIC_PROPERTY_MEDIA_TYPES)[number];

export type PublicPropertyProfileMedia = {
  mediaObjectId: string;
  mediaType: PublicPropertyMediaType;
  url: string;
  altText: string | null;
  sortOrder: number;
};

export type PublicPropertyProfileResponse = {
  propertyId: string;
  profileRevision: number;
  publicProfile: {
    locale: string;
    shortDescription: string | null;
    longDescription: string | null;
    media: PublicPropertyProfileMedia[];
  };
};

export type PublicPropertyProfileMediaPatchItem = {
  mediaObjectId: string;
  altText: string | null;
  sortOrder: number;
};

export type PublicPropertyProfilePatch = {
  shortDescription?: string | null;
  longDescription?: string | null;
  media?: PublicPropertyProfileMediaPatchItem[];
};

export type UpdatePublicPropertyProfileRequest = {
  expectedProfileRevision: number;
  patch: PublicPropertyProfilePatch;
};

export function parsePublicPropertyProfileResponse(
  value: unknown,
): PublicPropertyProfileResponse | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["propertyId", "profileRevision", "publicProfile"]) ||
    !isNonEmptyString(value["propertyId"]) ||
    !isPositiveInteger(value["profileRevision"])
  ) {
    return null;
  }
  const publicProfile = value["publicProfile"];
  if (
    !isRecord(publicProfile) ||
    !hasOnlyKeys(publicProfile, ["locale", "shortDescription", "longDescription", "media"]) ||
    !isNonEmptyString(publicProfile["locale"]) ||
    !isNullableString(publicProfile["shortDescription"]) ||
    !isNullableString(publicProfile["longDescription"]) ||
    !Array.isArray(publicProfile["media"]) ||
    !publicProfile["media"].every(isResponseMedia)
  ) {
    return null;
  }
  const mediaRoles = publicProfile["media"].map((item) => {
    const media = item as PublicPropertyProfileMedia;
    return `${media.mediaType}:${media.mediaObjectId.toLowerCase()}`;
  });
  const roleOrders = publicProfile["media"].map((item) => {
    const media = item as PublicPropertyProfileMedia;
    return `${media.mediaType}:${media.sortOrder}`;
  });
  if (
    new Set(mediaRoles).size !== mediaRoles.length ||
    new Set(roleOrders).size !== roleOrders.length
  ) {
    return null;
  }
  return value as PublicPropertyProfileResponse;
}

export function parseUpdatePublicPropertyProfileRequest(
  value: unknown,
): UpdatePublicPropertyProfileRequest | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["expectedProfileRevision", "patch"]) ||
    !isPositiveInteger(value["expectedProfileRevision"])
  ) {
    return null;
  }
  const patch = value["patch"];
  if (
    !isRecord(patch) ||
    Object.keys(patch).length === 0 ||
    !hasOnlyKeys(patch, ["shortDescription", "longDescription", "media"]) ||
    (patch["shortDescription"] !== undefined && !isNullableString(patch["shortDescription"])) ||
    (patch["longDescription"] !== undefined && !isNullableString(patch["longDescription"]))
  ) {
    return null;
  }
  if (patch["media"] !== undefined) {
    if (!Array.isArray(patch["media"]) || !patch["media"].every(isPatchMedia)) return null;
    const mediaIds = patch["media"].map(({ mediaObjectId }) => mediaObjectId);
    const sortOrders = patch["media"].map(({ sortOrder }) => sortOrder);
    if (
      new Set(mediaIds).size !== mediaIds.length ||
      new Set(sortOrders).size !== sortOrders.length
    ) {
      return null;
    }
  }
  return value as UpdatePublicPropertyProfileRequest;
}

function isResponseMedia(value: unknown): value is PublicPropertyProfileMedia {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["mediaObjectId", "mediaType", "url", "altText", "sortOrder"]) &&
    isUuid(value["mediaObjectId"]) &&
    PUBLIC_PROPERTY_MEDIA_TYPES.includes(value["mediaType"] as PublicPropertyMediaType) &&
    isNonEmptyString(value["url"]) &&
    isNullableString(value["altText"]) &&
    isNonNegativeInteger(value["sortOrder"])
  );
}

function isPatchMedia(value: unknown): value is PublicPropertyProfileMediaPatchItem {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["mediaObjectId", "altText", "sortOrder"]) &&
    isUuid(value["mediaObjectId"]) &&
    isNullableString(value["altText"]) &&
    isNonNegativeInteger(value["sortOrder"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPositiveInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= POSTGRES_INTEGER_MAX
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= POSTGRES_INTEGER_MAX
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
