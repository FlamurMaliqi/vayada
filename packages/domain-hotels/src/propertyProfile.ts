export const PROPERTY_PROFILE_CHANNEL_TYPES = [
  "email",
  "phone",
  "website",
  "whatsapp",
  "instagram",
  "facebook",
  "x",
] as const;

export const PROPERTY_PROFILE_CONTACT_PURPOSES = [
  "general",
  "operations",
  "guest",
  "creator",
] as const;

export const PROPERTY_PROFILE_MAP_DISPLAY_MODES = ["hidden", "approximate", "exact"] as const;

export type PropertyProfileChannelType = (typeof PROPERTY_PROFILE_CHANNEL_TYPES)[number];
export type PropertyProfileContactPurpose = (typeof PROPERTY_PROFILE_CONTACT_PURPOSES)[number];
export type PropertyProfileMapDisplayMode = (typeof PROPERTY_PROFILE_MAP_DISPLAY_MODES)[number];

export type PropertyProfileLocation = {
  streetAddress: string;
  postalCode: string;
  city: string;
  countryCode: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  localityPublic: boolean;
  geoPublic: boolean;
  mapDisplayMode: PropertyProfileMapDisplayMode;
};

export type PropertyProfileContact = {
  channelType: PropertyProfileChannelType;
  value: string;
  purpose: PropertyProfileContactPurpose;
  isPublic: boolean;
};

export type PropertyProfile = {
  displayName: string;
  propertyType: string;
  location: PropertyProfileLocation;
  contacts: PropertyProfileContact[];
};

export type CreatePropertyProfileRequest = PropertyProfile;

export type PropertyProfilePatch = {
  displayName?: string;
  propertyType?: string;
  location?: Partial<PropertyProfileLocation>;
  contacts?: PropertyProfileContact[];
};

export type UpdatePropertyProfileRequest = {
  expectedProfileRevision: number;
  patch: PropertyProfilePatch;
};

export type PropertyProfileResponse = {
  propertyId: string;
  profileRevision: number;
  profile: PropertyProfile;
};

export function parseCreatePropertyProfileRequest(
  value: unknown,
): CreatePropertyProfileRequest | null {
  return isPropertyProfile(value) ? value : null;
}

export function parsePropertyProfileResponse(value: unknown): PropertyProfileResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["propertyId", "profileRevision", "profile"])) {
    return null;
  }
  const propertyId = value["propertyId"];
  const profileRevision = value["profileRevision"];
  const profile = value["profile"];
  if (
    typeof propertyId !== "string" ||
    !propertyId ||
    !Number.isSafeInteger(profileRevision) ||
    (profileRevision as number) < 1 ||
    !isPropertyProfile(profile)
  ) {
    return null;
  }
  return value as PropertyProfileResponse;
}

export function parseUpdatePropertyProfileRequest(
  value: unknown,
): UpdatePropertyProfileRequest | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["expectedProfileRevision", "patch"])) {
    return null;
  }
  const expectedProfileRevision = value["expectedProfileRevision"];
  const patch = value["patch"];
  if (
    !Number.isSafeInteger(expectedProfileRevision) ||
    (expectedProfileRevision as number) < 1 ||
    !isPropertyProfilePatch(patch)
  ) {
    return null;
  }
  return value as UpdatePropertyProfileRequest;
}

function isPropertyProfile(value: unknown): value is PropertyProfile {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["displayName", "propertyType", "location", "contacts"])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value["displayName"]) &&
    isNonEmptyString(value["propertyType"]) &&
    isPropertyProfileLocation(value["location"]) &&
    Array.isArray(value["contacts"]) &&
    value["contacts"].every(isPropertyProfileContact)
  );
}

function isPropertyProfileLocation(value: unknown): value is PropertyProfileLocation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "streetAddress",
      "postalCode",
      "city",
      "countryCode",
      "timezone",
      "latitude",
      "longitude",
      "localityPublic",
      "geoPublic",
      "mapDisplayMode",
    ])
  ) {
    return false;
  }
  return (
    isNonEmptyString(value["streetAddress"]) &&
    isNonEmptyString(value["postalCode"]) &&
    isNonEmptyString(value["city"]) &&
    isNonEmptyString(value["countryCode"]) &&
    isNonEmptyString(value["timezone"]) &&
    isNullableFiniteNumber(value["latitude"]) &&
    isNullableFiniteNumber(value["longitude"]) &&
    typeof value["localityPublic"] === "boolean" &&
    typeof value["geoPublic"] === "boolean" &&
    PROPERTY_PROFILE_MAP_DISPLAY_MODES.includes(
      value["mapDisplayMode"] as PropertyProfileMapDisplayMode,
    )
  );
}

function isPropertyProfileContact(value: unknown): value is PropertyProfileContact {
  if (!isRecord(value) || !hasOnlyKeys(value, ["channelType", "value", "purpose", "isPublic"])) {
    return false;
  }
  return (
    PROPERTY_PROFILE_CHANNEL_TYPES.includes(value["channelType"] as PropertyProfileChannelType) &&
    isNonEmptyString(value["value"]) &&
    PROPERTY_PROFILE_CONTACT_PURPOSES.includes(value["purpose"] as PropertyProfileContactPurpose) &&
    typeof value["isPublic"] === "boolean"
  );
}

function isPropertyProfilePatch(value: unknown): value is PropertyProfilePatch {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !hasOnlyKeys(value, ["displayName", "propertyType", "location", "contacts"])
  ) {
    return false;
  }
  if (value["displayName"] !== undefined && !isNonEmptyString(value["displayName"])) return false;
  if (value["propertyType"] !== undefined && !isNonEmptyString(value["propertyType"])) return false;
  if (value["contacts"] !== undefined) {
    if (!Array.isArray(value["contacts"]) || !value["contacts"].every(isPropertyProfileContact)) {
      return false;
    }
  }
  if (value["location"] !== undefined) {
    const location = value["location"];
    if (
      !isRecord(location) ||
      Object.keys(location).length === 0 ||
      !hasOnlyKeys(location, [
        "streetAddress",
        "postalCode",
        "city",
        "countryCode",
        "timezone",
        "latitude",
        "longitude",
        "localityPublic",
        "geoPublic",
        "mapDisplayMode",
      ])
    ) {
      return false;
    }
    for (const key of ["streetAddress", "postalCode", "city", "countryCode", "timezone"]) {
      if (location[key] !== undefined && !isNonEmptyString(location[key])) return false;
    }
    for (const key of ["latitude", "longitude"]) {
      if (location[key] !== undefined && !isNullableFiniteNumber(location[key])) return false;
    }
    for (const key of ["localityPublic", "geoPublic"]) {
      if (location[key] !== undefined && typeof location[key] !== "boolean") return false;
    }
    if (
      location["mapDisplayMode"] !== undefined &&
      !PROPERTY_PROFILE_MAP_DISPLAY_MODES.includes(
        location["mapDisplayMode"] as PropertyProfileMapDisplayMode,
      )
    ) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
