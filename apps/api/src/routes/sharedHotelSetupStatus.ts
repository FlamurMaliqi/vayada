import type { PermissionKey } from "@vayada/backend-auth";
import { SHARED_PROPERTY_TYPE_OPTIONS, type SharedPropertyTypeOption } from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

export type SharedHotelSetupEntryProduct = "booking" | "pms" | "marketplace";
export type SharedPropertyTypeCatalog = {
  contractVersion: "shared-hotel-setup-property-types.v1";
  propertyTypes: readonly SharedPropertyTypeOption[];
};
export type SharedPropertyProfileMissingField =
  | "displayName"
  | "location"
  | "website"
  | "phone"
  | "description"
  | "media";
export type SharedPropertyProfileSource = "canonical" | "legacy_prefill";

export type SharedProductActivation<Product extends SharedHotelSetupEntryProduct> = {
  product: Product;
  status: "not_selected" | "selected_incomplete" | "active" | "suspended" | "unavailable";
  missingSteps: string[];
  statusReasons: string[];
  updatedAt: string | null;
};

export type SharedSetupProperty = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  locationSummary: string | null;
  sharedProfile: {
    status: "incomplete" | "complete" | "disabled" | "private";
    source: SharedPropertyProfileSource;
    completionPercent: number;
    missingFields: SharedPropertyProfileMissingField[];
  };
  products: {
    booking: SharedProductActivation<"booking">;
    pms: SharedProductActivation<"pms">;
    marketplace: SharedProductActivation<"marketplace">;
  };
};

export type SharedHotelSetupNextAction =
  | { action: "create_property"; reasonCodes: string[] }
  | { action: "select_property"; reasonCodes: string[] }
  | {
      action: "complete_shared_profile";
      propertyId: string;
      missingFields: SharedPropertyProfileMissingField[];
      reasonCodes: string[];
    }
  | { action: "select_products"; propertyId: string; reasonCodes: string[] }
  | {
      action: "complete_product_activation";
      propertyId: string;
      product: SharedHotelSetupEntryProduct;
      missingSteps: string[];
      reasonCodes: string[];
    }
  | {
      action: "enter_product";
      propertyId: string;
      product: SharedHotelSetupEntryProduct;
      returnTo: string | null;
      reasonCodes: string[];
    };

export type SharedHotelSetupStatus = {
  contractVersion: "shared-hotel-setup-status.v1";
  entry: {
    entryProduct: SharedHotelSetupEntryProduct | null;
    returnTo: string | null;
  };
  hotelGroup: {
    organizationId: string;
    displayName: string;
    websiteUrl: string | null;
    selectedProducts: SharedHotelSetupEntryProduct[];
  };
  selection: {
    state: "no_property" | "single_property" | "multiple_properties";
    selectedPropertyId: string | null;
  };
  properties: SharedSetupProperty[];
  nextAction: SharedHotelSetupNextAction;
  updatedAt: string;
};

export type SharedHotelSetupAccountProductSelection = {
  organizationId: string;
  selectedProducts: SharedHotelSetupEntryProduct[];
  updatedAt: string;
};

export type SharedPropertyProfileLocation = {
  countryCode: string | null;
  region: string | null;
  city: string | null;
  streetAddress: string | null;
  postalCode: string | null;
  rawMarketplaceLocation: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  addressPublic: boolean;
  mapDisplayMode: "hidden" | "approximate" | "exact";
};

export type SharedPropertyProfileMedia = {
  mediaType: "hero_image" | "gallery_image" | "logo";
  url: string;
  altText: string | null;
  sortOrder: number;
};

export type SharedPropertyProfileInput = {
  displayName: string;
  propertyType: string | null;
  location: SharedPropertyProfileLocation;
  website: string | null;
  contactEmail: string | null;
  phone: string | null;
  shortDescription: string | null;
  longDescription: string | null;
  media: SharedPropertyProfileMedia[];
};

export type SharedPropertyProfile = SharedPropertyProfileInput & {
  propertyId: string;
  publicId: string;
  sharedProfile: SharedSetupProperty["sharedProfile"];
  updatedAt: string;
};

export type SharedHotelSetupStatusRepository = {
  getHotelSetupStatus(input: { organizationId: string; propertyIds: string[] }): Promise<{
    hotelGroupDisplayName: string | null;
    hotelGroupWebsiteUrl: string | null;
    hotelGroupSelectedProducts: SharedHotelSetupEntryProduct[];
    properties: SharedSetupProperty[];
  }>;
  getPropertyProfile(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<SharedPropertyProfile | null>;
  createPropertyProfile(input: {
    organizationId: string;
    profile: SharedPropertyProfileInput;
  }): Promise<SharedPropertyProfile>;
  updatePropertyProfile(input: {
    organizationId: string;
    propertyId: string;
    expectedPropertyType: string | null;
    profile: SharedPropertyProfileInput;
  }): Promise<SharedPropertyProfile | null>;
  setOrganizationProductSelections?(input: {
    organizationId: string;
    selectedProducts: SharedHotelSetupEntryProduct[];
  }): Promise<SharedHotelSetupAccountProductSelection>;
  close?(): Promise<void>;
};

type SharedHotelSetupStatusRoutesOptions = {
  repository: SharedHotelSetupStatusRepository;
  now?: () => Date;
};

type SharedHotelSetupQuery = {
  entryProduct?: string;
  returnTo?: string;
  propertyId?: string;
};

type SharedHotelSetupAccountProductSelectionBody = {
  selectedProducts?: unknown;
};

type SharedPropertyProfileParams = {
  propertyId?: string;
};

type SharedPropertyProfileBody = Record<string, unknown> | undefined;

const ENTRY_PRODUCTS: readonly SharedHotelSetupEntryProduct[] = ["booking", "pms", "marketplace"];
const MEDIA_TYPES = ["hero_image", "gallery_image", "logo"] as const;
const MAP_DISPLAY_MODES = ["hidden", "approximate", "exact"] as const;
const SHARED_PROPERTY_TYPE_VALUES = new Set<string>(
  SHARED_PROPERTY_TYPE_OPTIONS.map(({ value }) => value),
);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMEZONE_PATTERN = /^[A-Za-z_]+\/[A-Za-z0-9_+./-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9(][0-9\s().-]*$/;

export async function registerSharedHotelSetupStatusRoutes(
  app: FastifyInstance,
  options: SharedHotelSetupStatusRoutesOptions,
): Promise<void> {
  const { repository, now = () => new Date() } = options;

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get("/property-types", async (request, reply) => {
    if (!resolveSharedSetupAccess(request, reply, null)) return reply;

    return {
      contractVersion: "shared-hotel-setup-property-types.v1",
      propertyTypes: SHARED_PROPERTY_TYPE_OPTIONS,
    } satisfies SharedPropertyTypeCatalog;
  });

  app.get("/status", async (request, reply) => {
    const query = request.query as SharedHotelSetupQuery;
    const entryProduct = parseEntryProduct(query.entryProduct, reply);
    if (entryProduct === false) return reply;

    const requestedPropertyId = parsePropertyId(query.propertyId, reply);
    if (requestedPropertyId === false) return reply;

    const access = resolveSharedSetupAccess(request, reply, requestedPropertyId);
    if (!access) return reply;

    const status = await repository.getHotelSetupStatus({
      organizationId: access.organizationId,
      propertyIds: access.propertyIds,
    });
    const returnTo = safeReturnTo(query.returnTo, request);
    const authorizedProperties = filterAuthorizedProperties(status.properties, access.propertyIds);
    const availablePropertyIds = authorizedProperties.map((property) => property.propertyId);
    const selectedPropertyId =
      requestedPropertyId ??
      (availablePropertyIds.length === 1 ? authorizedProperties[0]!.propertyId : null);

    if (
      selectedPropertyId &&
      !authorizedProperties.some((item) => item.propertyId === selectedPropertyId)
    ) {
      return reply.status(404).send({
        code: "property_setup_status_not_found",
        detail: "Setup status was not found for the selected property.",
      });
    }

    return {
      contractVersion: "shared-hotel-setup-status.v1",
      entry: {
        entryProduct,
        returnTo,
      },
      hotelGroup: {
        organizationId: access.organizationId,
        displayName: status.hotelGroupDisplayName ?? access.organizationId,
        websiteUrl: status.hotelGroupWebsiteUrl,
        selectedProducts: status.hotelGroupSelectedProducts,
      },
      selection: {
        state: selectionState(availablePropertyIds),
        selectedPropertyId,
      },
      properties: authorizedProperties,
      nextAction: nextAction(authorizedProperties, selectedPropertyId, entryProduct, returnTo),
      updatedAt: now().toISOString(),
    } satisfies SharedHotelSetupStatus;
  });

  app.get("/properties/:propertyId/profile", async (request, reply) => {
    const params = request.params as SharedPropertyProfileParams;
    const propertyId = parsePropertyId(params.propertyId, reply);
    if (propertyId === false || propertyId === null) return reply;

    const access = resolveSharedSetupAccess(request, reply, propertyId);
    if (!access) return reply;

    const profile = await repository.getPropertyProfile({
      organizationId: access.organizationId,
      propertyId,
    });
    if (!profile) {
      return reply.status(404).send({
        code: "property_profile_not_found",
        detail: "Shared property profile was not found for the selected property.",
      });
    }

    return profile;
  });

  app.post("/properties", async (request, reply) => {
    const profileInput = parseSharedPropertyProfile(
      request.body as SharedPropertyProfileBody,
      reply,
    );
    if (profileInput === false) return reply;
    if (!validateNewHotelBasics(profileInput, reply)) return reply;

    const access = resolveSharedSetupAccess(request, reply, null, "hotel_catalog.setup.manage");
    if (!access) return reply;

    const profile = await repository.createPropertyProfile({
      organizationId: access.organizationId,
      profile: profileInput,
    });

    return reply.status(201).send(profile);
  });

  app.put("/properties/:propertyId/profile", async (request, reply) => {
    const params = request.params as SharedPropertyProfileParams;
    const propertyId = parsePropertyId(params.propertyId, reply);
    if (propertyId === false || propertyId === null) return reply;

    const access = resolveSharedSetupAccess(
      request,
      reply,
      propertyId,
      "hotel_catalog.setup.manage",
    );
    if (!access) return reply;

    const existingProfile = await repository.getPropertyProfile({
      organizationId: access.organizationId,
      propertyId,
    });
    if (!existingProfile) {
      return reply.status(404).send({
        code: "property_profile_not_found",
        detail: "Shared property profile was not found for the selected property.",
      });
    }

    const profileInput = parseSharedPropertyProfile(
      request.body as SharedPropertyProfileBody,
      reply,
      existingProfile.propertyType,
    );
    if (profileInput === false) return reply;

    const profile = await repository.updatePropertyProfile({
      organizationId: access.organizationId,
      propertyId,
      expectedPropertyType: existingProfile.propertyType,
      profile: profileInput,
    });
    if (!profile) {
      const currentProfile = await repository.getPropertyProfile({
        organizationId: access.organizationId,
        propertyId,
      });
      if (currentProfile) {
        return reply.status(409).send({
          code: "property_profile_conflict",
          detail: "The property profile changed while it was being updated. Reload and try again.",
        });
      }
      return reply.status(404).send({
        code: "property_profile_not_found",
        detail: "Shared property profile was not found for the selected property.",
      });
    }

    return profile;
  });

  app.put("/products", async (request, reply) => {
    const selectedProducts = parseSelectedProducts(
      request.body as SharedHotelSetupAccountProductSelectionBody | undefined,
      reply,
    );
    if (selectedProducts === false) return reply;

    const access = resolveSharedSetupAccess(request, reply, null, "hotel_catalog.products.manage");
    if (!access) return reply;

    if (!repository.setOrganizationProductSelections) {
      return reply.status(501).send({
        code: "organization_product_selection_unavailable",
        detail: "Account-level product selection is not available.",
      });
    }

    return repository.setOrganizationProductSelections({
      organizationId: access.organizationId,
      selectedProducts,
    });
  });
}

function resolveSharedSetupAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  requestedPropertyId: string | null,
  permission: PermissionKey = "hotel_catalog.setup.read",
): { organizationId: string; propertyIds: string[] } | null {
  try {
    const context = enforceRoutePolicy(request, { permission });
    if (context.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ detail: "This endpoint is only available for hotel groups." });
      return null;
    }

    const propertyIds = unique(
      context.linkedResources
        .filter(
          (resource) =>
            resource.status === "active" &&
            resource.product === "hotel_catalog" &&
            resource.resourceType === "property" &&
            (resource.relationship === "owner" || resource.relationship === "operator") &&
            isUuid(resource.resourceId),
        )
        .map((resource) => resource.resourceId),
    );

    if (requestedPropertyId && !propertyIds.includes(requestedPropertyId)) {
      reply.status(403).send({
        code: "missing_property_resource_link",
        detail: "The selected hotel group is not linked to that property.",
      });
      return null;
    }

    return {
      organizationId: context.selectedOrganization.organizationId,
      propertyIds,
    };
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 500;
    if (statusCode === 401 || statusCode === 403) {
      reply.status(statusCode).send({
        detail: error instanceof Error ? error.message : "Forbidden",
      });
      return null;
    }
    throw error;
  }
}

function parseEntryProduct(
  value: string | undefined,
  reply: FastifyReply,
): SharedHotelSetupEntryProduct | null | false {
  if (value === undefined || value === "") return null;
  if ((ENTRY_PRODUCTS as readonly string[]).includes(value)) {
    return value as SharedHotelSetupEntryProduct;
  }
  reply.status(422).send({
    code: "invalid_entry_product",
    detail: "entryProduct must be booking, pms, or marketplace.",
  });
  return false;
}

function parsePropertyId(value: string | undefined, reply: FastifyReply): string | null | false {
  if (value === undefined || value === "") return null;
  if (isUuid(value)) return value;
  reply.status(422).send({
    code: "invalid_property_id",
    detail: "propertyId must be a UUID.",
  });
  return false;
}

function parseSelectedProducts(
  body: SharedHotelSetupAccountProductSelectionBody | undefined,
  reply: FastifyReply,
): SharedHotelSetupEntryProduct[] | false {
  if (!body || !Array.isArray(body.selectedProducts)) {
    reply.status(422).send({
      code: "invalid_selected_products",
      detail: "selectedProducts must be an array of booking, pms, or marketplace.",
    });
    return false;
  }

  if (
    !body.selectedProducts.every(
      (value): value is SharedHotelSetupEntryProduct =>
        typeof value === "string" && (ENTRY_PRODUCTS as readonly string[]).includes(value),
    )
  ) {
    reply.status(422).send({
      code: "invalid_selected_products",
      detail: "selectedProducts must contain only booking, pms, or marketplace.",
    });
    return false;
  }

  const requested = new Set(body.selectedProducts);
  return ENTRY_PRODUCTS.filter((product) => requested.has(product));
}

function parseSharedPropertyProfile(
  body: SharedPropertyProfileBody,
  reply: FastifyReply,
  grandfatheredPropertyType: string | null = null,
): SharedPropertyProfileInput | false {
  const errors: Record<string, string[]> = {};
  const input = objectValue(body);
  const rawLocation = input["location"];
  if (rawLocation !== undefined && rawLocation !== null && !isObjectRecord(rawLocation)) {
    addFieldError(errors, "location", "location must be an object.");
  }
  const location = objectValue(rawLocation);

  const displayName = requiredString(input["displayName"], "displayName", errors, {
    maxLength: 200,
  });
  const propertyType = optionalString(input["propertyType"], "propertyType", errors, {
    maxLength: 40,
  });
  if (
    propertyType &&
    !SHARED_PROPERTY_TYPE_VALUES.has(propertyType) &&
    propertyType !== grandfatheredPropertyType
  ) {
    addFieldError(errors, "propertyType", "propertyType is invalid.");
  }
  const website = optionalUrl(input["website"], "website", errors);
  const contactEmail = optionalEmail(input["contactEmail"], "contactEmail", errors);
  const phone = optionalString(input["phone"], "phone", errors, { maxLength: 64 });
  if (phone && !isValidPhone(phone)) {
    addFieldError(errors, "phone", "phone must be a valid phone number.");
  }
  const shortDescription = optionalString(input["shortDescription"], "shortDescription", errors, {
    maxLength: 500,
  });
  const longDescription = optionalString(input["longDescription"], "longDescription", errors, {
    maxLength: 5000,
  });
  const parsedLocation = parseLocation(location, errors);
  const media = parseMedia(input["media"], errors);

  if (Object.keys(errors).length > 0 || !displayName || media === false) {
    reply.status(422).send({
      code: "invalid_shared_property_profile",
      detail: "Shared property profile contains invalid fields.",
      fields: errors,
    });
    return false;
  }

  return {
    displayName,
    propertyType,
    location: parsedLocation,
    website,
    contactEmail,
    phone,
    shortDescription,
    longDescription,
    media,
  };
}

function validateNewHotelBasics(profile: SharedPropertyProfileInput, reply: FastifyReply): boolean {
  const errors: Record<string, string[]> = {};
  if (!profile.propertyType) {
    addFieldError(errors, "propertyType", "propertyType is required.");
  } else if (!SHARED_PROPERTY_TYPE_VALUES.has(profile.propertyType)) {
    addFieldError(errors, "propertyType", "propertyType is invalid.");
  }
  if (!profile.location.streetAddress) {
    addFieldError(errors, "location.streetAddress", "streetAddress is required.");
  }
  if (!profile.location.postalCode) {
    addFieldError(errors, "location.postalCode", "postalCode is required.");
  }
  if (!profile.location.city) {
    addFieldError(errors, "location.city", "city is required.");
  }
  if (!profile.location.countryCode) {
    addFieldError(errors, "location.countryCode", "countryCode is required.");
  }
  if (!profile.location.timezone) {
    addFieldError(errors, "location.timezone", "timezone is required.");
  }
  if (!profile.contactEmail) {
    addFieldError(errors, "contactEmail", "contactEmail is required.");
  }
  if (!profile.phone) {
    addFieldError(errors, "phone", "phone is required.");
  }
  if (Object.keys(errors).length === 0) return true;

  reply.status(422).send({
    code: "invalid_shared_property_profile",
    detail: "Required hotel basics are missing.",
    fields: errors,
  });
  return false;
}

function parseLocation(
  location: Record<string, unknown>,
  errors: Record<string, string[]>,
): SharedPropertyProfileLocation {
  const countryCode = optionalString(location["countryCode"], "location.countryCode", errors, {
    maxLength: 2,
  });
  if (countryCode && !/^[A-Za-z]{2}$/.test(countryCode)) {
    addFieldError(errors, "location.countryCode", "countryCode must be a two-letter code.");
  }

  const timezone = optionalString(location["timezone"], "location.timezone", errors, {
    maxLength: 80,
  });
  if (timezone && (!TIMEZONE_PATTERN.test(timezone) || !isValidTimezone(timezone))) {
    addFieldError(errors, "location.timezone", "timezone must be an IANA timezone.");
  }

  const latitude = optionalNumber(location["latitude"], "location.latitude", errors, {
    min: -90,
    max: 90,
  });
  const longitude = optionalNumber(location["longitude"], "location.longitude", errors, {
    min: -180,
    max: 180,
  });
  if ((latitude === null) !== (longitude === null)) {
    addFieldError(errors, "location.latitude", "latitude and longitude must be provided together.");
    addFieldError(
      errors,
      "location.longitude",
      "latitude and longitude must be provided together.",
    );
  }

  const mapDisplayMode = optionalEnum(
    location["mapDisplayMode"],
    "location.mapDisplayMode",
    MAP_DISPLAY_MODES,
    errors,
    "hidden",
  );
  const addressPublicValue = location["addressPublic"];
  let addressPublic = true;
  if (addressPublicValue !== undefined && addressPublicValue !== null) {
    if (typeof addressPublicValue === "boolean") {
      addressPublic = addressPublicValue;
    } else {
      addFieldError(errors, "location.addressPublic", "location.addressPublic must be a boolean.");
    }
  }

  return {
    countryCode: countryCode?.toUpperCase() ?? null,
    region: optionalString(location["region"], "location.region", errors, { maxLength: 120 }),
    city: optionalString(location["city"], "location.city", errors, { maxLength: 120 }),
    streetAddress: optionalString(location["streetAddress"], "location.streetAddress", errors, {
      maxLength: 240,
    }),
    postalCode: optionalString(location["postalCode"], "location.postalCode", errors, {
      maxLength: 32,
    }),
    rawMarketplaceLocation: optionalString(
      location["rawMarketplaceLocation"],
      "location.rawMarketplaceLocation",
      errors,
      { maxLength: 240 },
    ),
    timezone,
    latitude,
    longitude,
    addressPublic,
    mapDisplayMode,
  };
}

function parseMedia(
  value: unknown,
  errors: Record<string, string[]>,
): SharedPropertyProfileMedia[] | false {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    addFieldError(errors, "media", "media must be an array.");
    return false;
  }

  return value.map((item, index) => {
    const media = objectValue(item);
    const field = `media.${index}`;
    const url = optionalUrl(media["url"], `${field}.url`, errors);
    if (!url) {
      addFieldError(errors, `${field}.url`, "url is required.");
    }

    return {
      mediaType: optionalEnum(
        media["mediaType"],
        `${field}.mediaType`,
        MEDIA_TYPES,
        errors,
        "gallery_image",
      ),
      url: url ?? "",
      altText: optionalString(media["altText"], `${field}.altText`, errors, {
        maxLength: 240,
      }),
      sortOrder: index,
    };
  });
}

function requiredString(
  value: unknown,
  field: string,
  errors: Record<string, string[]>,
  options: { maxLength: number },
): string | null {
  const parsed = optionalString(value, field, errors, options);
  if (!parsed) {
    addFieldError(errors, field, `${field} is required.`);
  }
  return parsed;
}

function optionalString(
  value: unknown,
  field: string,
  errors: Record<string, string[]>,
  options: { maxLength: number },
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    addFieldError(errors, field, `${field} must be a string.`);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > options.maxLength) {
    addFieldError(errors, field, `${field} is too long.`);
    return null;
  }
  return trimmed;
}

function optionalUrl(
  value: unknown,
  field: string,
  errors: Record<string, string[]>,
): string | null {
  const parsed = optionalString(value, field, errors, { maxLength: 2048 });
  if (!parsed) return null;

  try {
    const url = new URL(parsed);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return url.toString();
    }
  } catch {
    // Add a field error below.
  }

  addFieldError(errors, field, `${field} must be an http or https URL.`);
  return null;
}

function optionalEmail(
  value: unknown,
  field: string,
  errors: Record<string, string[]>,
): string | null {
  const parsed = optionalString(value, field, errors, { maxLength: 320 });
  if (!parsed) return null;
  if (EMAIL_PATTERN.test(parsed)) return parsed.toLowerCase();
  addFieldError(errors, field, `${field} must be a valid email address.`);
  return null;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isValidPhone(value: string): boolean {
  if (!PHONE_PATTERN.test(value)) return false;
  const digitCount = value.replace(/\D/g, "").length;
  return digitCount >= 7 && digitCount <= 15;
}

function optionalNumber(
  value: unknown,
  field: string,
  errors: Record<string, string[]>,
  options: { min: number; max: number },
): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addFieldError(errors, field, `${field} must be a number.`);
    return null;
  }
  if (value < options.min || value > options.max) {
    addFieldError(errors, field, `${field} is out of range.`);
    return null;
  }
  return value;
}

function optionalEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
  errors: Record<string, string[]>,
  fallback: T[number],
): T[number] {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  addFieldError(errors, field, `${field} is invalid.`);
  return fallback;
}

function addFieldError(errors: Record<string, string[]>, field: string, message: string): void {
  errors[field] = [...(errors[field] ?? []), message];
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObjectRecord(value) ? value : {};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterAuthorizedProperties(
  properties: SharedSetupProperty[],
  propertyIds: string[],
): SharedSetupProperty[] {
  const authorized = new Set(propertyIds);
  const order = new Map(propertyIds.map((propertyId, index) => [propertyId, index]));
  return properties
    .filter((property) => authorized.has(property.propertyId))
    .sort((left, right) => (order.get(left.propertyId) ?? 0) - (order.get(right.propertyId) ?? 0));
}

function selectionState(propertyIds: string[]): SharedHotelSetupStatus["selection"]["state"] {
  if (propertyIds.length === 0) return "no_property";
  return propertyIds.length === 1 ? "single_property" : "multiple_properties";
}

function nextAction(
  properties: SharedSetupProperty[],
  selectedPropertyId: string | null,
  entryProduct: SharedHotelSetupEntryProduct | null,
  returnTo: string | null,
): SharedHotelSetupNextAction {
  if (properties.length === 0) {
    return { action: "create_property", reasonCodes: ["no_property"] };
  }
  if (!selectedPropertyId) {
    return { action: "select_property", reasonCodes: ["multiple_properties"] };
  }

  const property = properties.find((item) => item.propertyId === selectedPropertyId)!;
  const missingRoutingFields = property.sharedProfile.missingFields.filter(
    (field) => field === "displayName" || field === "location",
  );
  if (
    missingRoutingFields.length > 0 ||
    property.sharedProfile.status === "disabled" ||
    property.sharedProfile.status === "private"
  ) {
    return {
      action: "complete_shared_profile",
      propertyId: property.propertyId,
      missingFields: missingRoutingFields,
      reasonCodes: [`shared_profile_${property.sharedProfile.status}`],
    };
  }

  if (entryProduct) {
    const activation = property.products[entryProduct];
    if (activation.status === "active") {
      return {
        action: "enter_product",
        propertyId: property.propertyId,
        product: entryProduct,
        returnTo,
        reasonCodes: ["entry_product_active"],
      };
    }
    if (activation.status === "not_selected") {
      return {
        action: "select_products",
        propertyId: property.propertyId,
        reasonCodes: ["entry_product_not_selected"],
      };
    }
    return {
      action: "complete_product_activation",
      propertyId: property.propertyId,
      product: entryProduct,
      missingSteps: activation.missingSteps,
      reasonCodes: activationReasonCodes(activation, "entry_product_activation_incomplete"),
    };
  }

  const incompleteProduct = ENTRY_PRODUCTS.map((product) => property.products[product]).find(
    (activation) =>
      activation.status === "selected_incomplete" ||
      activation.status === "suspended" ||
      activation.status === "unavailable",
  );
  if (incompleteProduct) {
    return {
      action: "complete_product_activation",
      propertyId: property.propertyId,
      product: incompleteProduct.product,
      missingSteps: incompleteProduct.missingSteps,
      reasonCodes: activationReasonCodes(
        incompleteProduct,
        `${incompleteProduct.product}_activation_incomplete`,
      ),
    };
  }

  const activeProduct = ENTRY_PRODUCTS.map((product) => property.products[product]).find(
    (activation) => activation.status === "active",
  );
  if (activeProduct) {
    return {
      action: "enter_product",
      propertyId: property.propertyId,
      product: activeProduct.product,
      returnTo,
      reasonCodes: ["product_active"],
    };
  }

  return {
    action: "select_products",
    propertyId: property.propertyId,
    reasonCodes: ["no_products_selected"],
  };
}

function activationReasonCodes<Product extends SharedHotelSetupEntryProduct>(
  activation: SharedProductActivation<Product>,
  fallback: string,
): string[] {
  if (activation.missingSteps.length === 0 && activation.statusReasons.length > 0) {
    return activation.statusReasons;
  }
  return [fallback];
}

function safeReturnTo(value: string | undefined, request: FastifyRequest): string | null {
  if (!value) return null;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) {
    return value;
  }

  const origin = request.headers.origin;
  if (!origin) return null;

  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === origin) {
      return url.toString();
    }
  } catch {
    return null;
  }

  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
