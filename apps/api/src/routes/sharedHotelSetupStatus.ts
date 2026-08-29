import { createHash } from "node:crypto";

import { UnauthorizedError, type PermissionKey } from "@vayada/backend-auth";
import {
  AuthorizationError,
  hasPermission,
  resolveEffectivePropertyAccess,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";
import {
  ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
  isSetupTaskLaunchable,
  parseUpdateTracksRequest,
  PROPERTY_PROFILE_CHANNEL_TYPES,
  PROPERTY_PROFILE_CONTACT_PURPOSES,
  PROPERTY_PROFILE_MAP_DISPLAY_MODES,
  SETUP_TASK_DESTINATION_ROUTE_KEYS,
  SHARED_PROPERTY_TYPE_OPTIONS,
  type AdaptiveHotelSetupStatus,
  type CreatePropertyProfileRequest,
  type ProductEntryDecision,
  type PropertyProfile,
  type PropertyProfileContact,
  type PropertyProfileLocation,
  type PropertyProfilePatch,
  type PropertyProfileResponse,
  type PropertySetupPlan,
  type PublicPropertyProfilePatch,
  type PublicPropertyProfileMediaPatchItem,
  type PublicPropertyProfileResponse,
  type SetupTask,
  type SetupTaskId,
  type SharedPropertyTypeOption,
  type SetupTrack,
  type TrackStatus,
  type UpdatePublicPropertyProfileRequest,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { HotelSetupTrackCommandRepository } from "../domains/hotelSetupTrackCommandRepository.js";
import {
  BookingContactPublicationConflictError,
  toLocalizationSettingsResponse,
  type BookingPropertySettingsReadModel,
  type UpdateBookingPropertySettingsBody,
} from "./bookingSettings.js";
import { enforceRoutePolicy } from "./policy.js";

export type SharedHotelSetupEntryProduct = ProductEntryDecision["requestedProduct"];
export type SharedPropertyTypeCatalog = {
  contractVersion: "adaptive-hotel-property-types.v1";
  propertyTypes: readonly SharedPropertyTypeOption[];
};
export type SharedPropertyProfileInput = CreatePropertyProfileRequest;
export type SharedPropertyProfile = PropertyProfileResponse;
export type SharedPublicPropertyProfile = PublicPropertyProfileResponse;
export type SharedPropertyLaunchSettings = {
  defaultCurrency: string;
  supportedCurrencies: string[];
  defaultLanguage: string;
  supportedLanguages: string[];
  instagram: string;
  facebook: string;
  tiktok: string;
  youtube: string;
};

export type SharedPropertyLaunchSettingsRepository = {
  findPropertySettingsByHotelId(
    propertyId: string,
  ): Promise<BookingPropertySettingsReadModel | null>;
  updatePropertySettingsByHotelId(
    propertyId: string,
    settings: UpdateBookingPropertySettingsBody,
    organizationId: string,
  ): Promise<BookingPropertySettingsReadModel | null>;
};

export type UpdatePublicPropertyProfileResult =
  | { status: "updated"; profile: SharedPublicPropertyProfile }
  | { status: "conflict"; currentRevision: number }
  | { status: "command_in_progress" }
  | { status: "invalid_media"; mediaObjectIds: string[] }
  | { status: "not_found" };

export type AdaptiveSetupTaskFact = Pick<
  SetupTask,
  "taskId" | "ownerProgress" | "readiness" | "reasonCodes" | "sourceRevision" | "freshness"
>;

export type AdaptivePropertySetupFacts = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  locationSummary: string | null;
  taskFacts: Record<SetupTaskId, AdaptiveSetupTaskFact>;
};

export type SharedHotelSetupStatusRepository = {
  getHotelSetupStatus(input: { organizationId: string; propertyIds: string[] }): Promise<{
    hotelGroupDisplayName: string | null;
    hotelGroupWebsiteUrl: string | null;
    properties: AdaptivePropertySetupFacts[];
  }>;
  getPropertyProfile(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<SharedPropertyProfile | null>;
  createPropertyProfile(input: {
    organizationId: string;
    idempotencyKey: string;
    correlationId: string;
    profile: SharedPropertyProfileInput;
    audit?: { actorUserId: string; requestId: string; receivedAt: string; reason?: string };
    targetAccountUserId?: string;
    provisioningReference?: string;
  }): Promise<SharedPropertyProfile>;
  updatePropertyProfile(input: {
    organizationId: string;
    propertyId: string;
    expectedProfileRevision: number;
    profile: SharedPropertyProfileInput;
  }): Promise<SharedPropertyProfile | null>;
  getPublicPropertyProfile(input: {
    organizationId: string;
    propertyId: string;
  }): Promise<SharedPublicPropertyProfile | null>;
  updatePublicPropertyProfile(input: {
    organizationId: string;
    propertyId: string;
    expectedProfileRevision: number;
    patch: PublicPropertyProfilePatch;
  }): Promise<UpdatePublicPropertyProfileResult>;
  close?(): Promise<void>;
};

type SharedHotelSetupStatusRoutesOptions = {
  repository: SharedHotelSetupStatusRepository;
  trackCommandRepository: HotelSetupTrackCommandRepository;
  propertyAccessRepository?: PropertyAccessRepository;
  launchSettingsRepository?: SharedPropertyLaunchSettingsRepository;
  now?: () => Date;
};

type SharedHotelSetupQuery = {
  entryProduct?: string;
  propertyId?: string;
};

type SharedPropertyProfileParams = {
  propertyId?: string;
};

type SharedPropertyProfileBody = Record<string, unknown> | undefined;

type SharedHotelSetupTrackAccessError = {
  statusCode: 401 | 403;
  code: "unauthenticated" | "missing_permission" | "invalid_organization_scope";
  category: "authentication" | "authorization";
  message: string;
};

const ENTRY_PRODUCTS: readonly SharedHotelSetupEntryProduct[] = ["booking", "pms", "marketplace"];
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
  const {
    repository,
    trackCommandRepository,
    propertyAccessRepository,
    launchSettingsRepository,
    now = () => new Date(),
  } = options;
  const trackUpdateAccess = new WeakMap<FastifyRequest, ReturnType<typeof enforceRoutePolicy>>();

  app.addHook("onClose", async () => {
    await Promise.all([repository.close?.(), trackCommandRepository.close()]);
  });

  app.get("/property-types", async (request, reply) => {
    if (!resolveSharedSetupAccess(request, reply, null)) return reply;

    return {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: SHARED_PROPERTY_TYPE_OPTIONS,
    } satisfies SharedPropertyTypeCatalog;
  });

  app.get("/status", async (request, reply) => {
    const query = request.query as SharedHotelSetupQuery;
    const entryProduct = parseEntryProduct(query.entryProduct, reply);
    if (entryProduct === false) return reply;

    const requestedPropertyId = parsePropertyId(query.propertyId, reply);
    if (requestedPropertyId === false) return reply;

    const access = await resolveSharedSetupStatusAccess(
      request,
      reply,
      requestedPropertyId,
      propertyAccessRepository,
    );
    if (!access) return reply;

    const status = await repository.getHotelSetupStatus({
      organizationId: access.organizationId,
      propertyIds: access.propertyIds,
    });
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

    const canManageTracks = hasPermission(access.context, "hotel_catalog.products.manage");
    const rawTrackStatus = await trackCommandRepository.getTrackStatus({
      organizationId: access.organizationId,
    });
    const tracks = canManageTracks
      ? rawTrackStatus.tracks
      : rawTrackStatus.tracks.map((track) => ({ ...track, allowedActions: [] }));
    const selectedProperty =
      authorizedProperties.find((property) => property.propertyId === selectedPropertyId) ?? null;
    const evaluatedAt = now().toISOString();

    return {
      contractVersion: ADAPTIVE_HOTEL_SETUP_CONTRACT_VERSION,
      organization: {
        organizationId: access.organizationId,
        displayName: status.hotelGroupDisplayName ?? access.organizationId,
        websiteUrl: status.hotelGroupWebsiteUrl,
        selectedTracks: rawTrackStatus.selectedTracks,
        trackRevision: rawTrackStatus.trackRevision,
        canManageTracks,
        tracks,
      },
      propertySelection: {
        state: selectionState(availablePropertyIds),
        selectedPropertyId,
        availableProperties: authorizedProperties.map(
          ({ propertyId, publicId, displayName, locationSummary }) => ({
            propertyId,
            publicId,
            displayName,
            locationSummary,
          }),
        ),
      },
      entryDecision: entryDecision({
        context: access.context,
        entryProduct,
        propertyId: selectedPropertyId,
        selectedTracks: rawTrackStatus.selectedTracks,
        tracks,
      }),
      setupPlan: selectedProperty
        ? buildPropertySetupPlan({
            context: access.context,
            property: selectedProperty,
            selectedTracks: rawTrackStatus.selectedTracks,
            trackRevision: rawTrackStatus.trackRevision,
            tracks,
            evaluatedAt,
          })
        : null,
      updatedAt: evaluatedAt,
    } satisfies AdaptiveHotelSetupStatus;
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
    const access = resolveSharedSetupAccess(request, reply, null, "hotel_catalog.setup.manage");
    if (!access) return reply;

    const profileInput = parseCreatePropertyProfile(
      request.body as SharedPropertyProfileBody,
      reply,
    );
    if (profileInput === false) return reply;

    if (
      hasPublishedPropertySurface(profileInput) &&
      !ensurePublicPropertyPublicationPermission(access.context, reply)
    ) {
      return reply;
    }
    const idempotencyKey = parseIdempotencyKey(request, reply);
    if (!idempotencyKey) return reply;

    try {
      const profile = await repository.createPropertyProfile({
        organizationId: access.organizationId,
        idempotencyKey,
        correlationId: access.context.audit.correlationId ?? access.context.audit.requestId,
        profile: profileInput,
        audit: {
          actorUserId: access.context.actor.internalUserId,
          requestId: access.context.audit.requestId,
          receivedAt: access.context.audit.receivedAt,
        },
      });

      return reply.status(201).send(profile);
    } catch (error) {
      const code =
        isObjectRecord(error) && typeof error["code"] === "string" ? error["code"] : null;
      const propertyId =
        isObjectRecord(error) && typeof error["propertyId"] === "string"
          ? error["propertyId"]
          : null;
      if (code === "idempotency_key_conflict") {
        return reply.status(409).send({
          code,
          detail: "These hotel details changed during the save. Review them and try again.",
          ...(propertyId ? { propertyId } : {}),
        });
      }
      if (code === "command_in_progress") {
        return reply.status(409).send({
          code,
          detail: "Your hotel setup is still being saved. Please try again in a moment.",
        });
      }
      throw error;
    }
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

    const update = parsePropertyProfileUpdate(
      request.body as SharedPropertyProfileBody,
      existingProfile.profile,
      reply,
    );
    if (update === false) return reply;
    if (
      publishedPropertySurfaceChanged(existingProfile.profile, update.profile) &&
      !ensurePublicPropertyPublicationPermission(access.context, reply)
    ) {
      return reply;
    }

    const profile = await repository.updatePropertyProfile({
      organizationId: access.organizationId,
      propertyId,
      expectedProfileRevision: update.expectedProfileRevision,
      profile: update.profile,
    });
    if (!profile) {
      const currentProfile = await repository.getPropertyProfile({
        organizationId: access.organizationId,
        propertyId,
      });
      if (currentProfile) {
        return reply.status(409).send({
          code: "profile_revision_conflict",
          detail: "The property profile changed while it was being updated. Reload and try again.",
          currentRevision: currentProfile.profileRevision,
        });
      }
      return reply.status(404).send({
        code: "property_profile_not_found",
        detail: "Shared property profile was not found for the selected property.",
      });
    }

    return profile;
  });

  if (launchSettingsRepository) {
    app.get("/properties/:propertyId/launch-settings", async (request, reply) => {
      const params = request.params as SharedPropertyProfileParams;
      const propertyId = parsePropertyId(params.propertyId, reply);
      if (propertyId === false || propertyId === null) return reply;

      const access = resolveSharedSetupAccess(request, reply, propertyId);
      if (!access) return reply;

      let settings: BookingPropertySettingsReadModel | null;
      try {
        settings = await launchSettingsRepository.findPropertySettingsByHotelId(propertyId);
      } catch (error) {
        request.log.error({ err: error, propertyId }, "Property launch settings read failed");
        return reply.status(500).send({
          code: "launch_settings_unavailable",
          detail: "Property launch settings are unavailable.",
        });
      }
      if (!settings) {
        return reply.status(404).send({
          code: "property_launch_settings_not_found",
          detail: "Property launch settings were not found for the selected property.",
        });
      }

      return toSharedPropertyLaunchSettings(settings);
    });

    app.put("/properties/:propertyId/launch-settings", async (request, reply) => {
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

      const settings = parsePropertyLaunchSettings(request.body, reply);
      if (settings === false) return reply;

      let stored: BookingPropertySettingsReadModel | null;
      try {
        stored = await launchSettingsRepository.updatePropertySettingsByHotelId(
          propertyId,
          settings,
          access.organizationId,
        );
      } catch (error) {
        if (error instanceof BookingContactPublicationConflictError) {
          return reply.status(409).send({
            code: "private_contact_conflict",
            detail: error.message,
          });
        }
        request.log.error({ err: error, propertyId }, "Property launch settings write failed");
        return reply.status(500).send({
          code: "launch_settings_unavailable",
          detail: "Property launch settings could not be saved.",
        });
      }
      if (!stored) {
        return reply.status(404).send({
          code: "property_launch_settings_not_found",
          detail: "Property launch settings were not found for the selected property.",
        });
      }

      return toSharedPropertyLaunchSettings(stored);
    });
  }

  app.get("/properties/:propertyId/public-profile", async (request, reply) => {
    const params = request.params as SharedPropertyProfileParams;
    const propertyId = parsePropertyId(params.propertyId, reply);
    if (propertyId === false || propertyId === null) return reply;

    const access = resolveSharedSetupAccess(request, reply, propertyId);
    if (!access) return reply;

    const profile = await repository.getPublicPropertyProfile({
      organizationId: access.organizationId,
      propertyId,
    });
    if (!profile) {
      return reply.status(404).send({
        code: "public_property_profile_not_found",
        detail: "Public property profile was not found for the selected property.",
      });
    }
    return profile;
  });

  app.put("/properties/:propertyId/public-profile", async (request, reply) => {
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
    if (!ensurePublicPropertyPublicationPermission(access.context, reply)) return reply;

    const update = parsePublicPropertyProfileUpdate(
      request.body as SharedPropertyProfileBody,
      reply,
    );
    if (update === false) return reply;

    const result = await repository.updatePublicPropertyProfile({
      organizationId: access.organizationId,
      propertyId,
      ...update,
    });
    if (result.status === "updated") return result.profile;
    if (result.status === "conflict") {
      return reply.status(409).send({
        code: "profile_revision_conflict",
        detail: "The property profile changed while it was being updated. Reload and try again.",
        currentRevision: result.currentRevision,
      });
    }
    if (result.status === "command_in_progress") {
      return reply.status(409).send({
        code: "command_in_progress",
        detail: "A property media update is still being published. Retry shortly.",
      });
    }
    if (result.status === "invalid_media") {
      return reply.status(422).send({
        code: "invalid_setup_request",
        detail: "Public profile media must be active, approved Platform Media for this property.",
        fields: {
          "patch.media": [`Invalid mediaObjectId values: ${result.mediaObjectIds.join(", ")}`],
        },
      });
    }
    return reply.status(404).send({
      code: "public_property_profile_not_found",
      detail: "Public property profile was not found for the selected property.",
    });
  });

  app.put(
    "/tracks",
    {
      async onRequest(request, reply) {
        const access = resolveSharedSetupTrackUpdateAccess(request, reply);
        if (!access) return reply;
        trackUpdateAccess.set(request, access);
      },
    },
    async (request, reply) => {
      const context = trackUpdateAccess.get(request);
      if (!context) {
        throw new Error("Hotel setup track access context was not resolved before body parsing");
      }

      const update = parseUpdateTracksRequest(request.body);
      if (!update) {
        return invalidSetupRequest(
          reply,
          "Request must include valid selectedTracks and expectedRevision.",
        );
      }

      const idempotencyKey = parseIdempotencyKey(request, reply);
      if (!idempotencyKey) return reply;

      const result = await trackCommandRepository.updateTracks({
        organizationId: context.selectedOrganization.organizationId,
        actorUserId: context.actor.internalUserId,
        audit: context.audit,
        idempotencyKey,
        ...update,
      });
      if (!result.ok) return reply.status(409).send(result.error);
      return result.response;
    },
  );
}

function toSharedPropertyLaunchSettings(
  settings: BookingPropertySettingsReadModel,
): SharedPropertyLaunchSettings {
  const localization = toLocalizationSettingsResponse(settings);
  return {
    defaultCurrency: localization.defaultCurrency,
    supportedCurrencies: localization.supportedCurrencies,
    defaultLanguage: localization.defaultLanguage,
    supportedLanguages: localization.supportedLanguages,
    instagram: settings.instagram ?? "",
    facebook: settings.facebook ?? "",
    tiktok: settings.tiktok ?? "",
    youtube: settings.youtube ?? "",
  };
}

function parsePropertyLaunchSettings(
  body: unknown,
  reply: FastifyReply,
): UpdateBookingPropertySettingsBody | false {
  const fields: Record<string, string[]> = {};
  if (!isObjectRecord(body)) {
    addFieldError(fields, "body", "body must be an object.");
    return sendInvalidLaunchSettings(reply, fields);
  }

  const expectedKeys = [
    "defaultCurrency",
    "supportedCurrencies",
    "defaultLanguage",
    "supportedLanguages",
    "instagram",
    "facebook",
    "tiktok",
    "youtube",
  ] as const;
  validateKnownKeys(body, expectedKeys, "body", fields);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(body, key)) addFieldError(fields, key, `${key} is required.`);
  }

  const defaultCurrency = launchCurrencyCode(body.defaultCurrency, "defaultCurrency", fields);
  const defaultLanguage = launchLanguageCode(body.defaultLanguage, "defaultLanguage", fields);
  const supportedCurrencies = launchCodeList(
    body.supportedCurrencies,
    "supportedCurrencies",
    defaultCurrency,
    fields,
    launchCurrencyCode,
  );
  const supportedLanguages = launchCodeList(
    body.supportedLanguages,
    "supportedLanguages",
    defaultLanguage,
    fields,
    launchLanguageCode,
  );
  const instagram = launchSocialUrl(body.instagram, "instagram", fields);
  const facebook = launchSocialUrl(body.facebook, "facebook", fields);
  const tiktok = launchSocialUrl(body.tiktok, "tiktok", fields);
  const youtube = launchSocialUrl(body.youtube, "youtube", fields);

  if (Object.keys(fields).length > 0) return sendInvalidLaunchSettings(reply, fields);
  return {
    defaultCurrency,
    supportedCurrencies,
    defaultLanguage,
    supportedLanguages,
    instagram,
    facebook,
    tiktok,
    youtube,
  };
}

function launchCurrencyCode(
  value: unknown,
  field: string,
  errors: Record<string, string[]>,
): string {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(normalized)) {
    addFieldError(errors, field, `${field} must be a three-letter currency code.`);
  }
  return normalized;
}

function launchLanguageCode(
  value: unknown,
  field: string,
  errors: Record<string, string[]>,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(normalized)) {
    addFieldError(errors, field, `${field} must be a non-empty language code.`);
  }
  return normalized;
}

function launchCodeList(
  value: unknown,
  field: string,
  defaultValue: string,
  errors: Record<string, string[]>,
  normalize: (value: unknown, field: string, errors: Record<string, string[]>) => string,
): string[] {
  if (!Array.isArray(value)) {
    addFieldError(errors, field, `${field} must be an array.`);
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];
  value.forEach((entry, index) => {
    const entryField = `${field}.${index}`;
    const normalized = normalize(entry, entryField, errors);
    if (!normalized || normalized === defaultValue) return;
    if (seen.has(normalized)) {
      addFieldError(errors, entryField, `${entryField} duplicates another code.`);
      return;
    }
    seen.add(normalized);
    result.push(normalized);
  });
  return result;
}

function launchSocialUrl(value: unknown, field: string, errors: Record<string, string[]>): string {
  if (typeof value !== "string") {
    addFieldError(errors, field, `${field} must be a string.`);
    return "";
  }
  const normalized = value.trim();
  if (!normalized) return "";
  try {
    const url = new URL(normalized);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    ) {
      return normalized;
    }
  } catch {
    // Report the common validation error below.
  }
  addFieldError(errors, field, `${field} must be an http or https URL.`);
  return normalized;
}

function sendInvalidLaunchSettings(reply: FastifyReply, fields: Record<string, string[]>): false {
  reply.status(422).send({
    code: "invalid_setup_request",
    detail: "Property launch settings contain invalid fields.",
    fields,
  });
  return false;
}

function ensurePublicPropertyPublicationPermission(
  context: ReturnType<typeof enforceRoutePolicy>,
  reply: FastifyReply,
): boolean {
  if (
    hasPermission(context, "marketplace.profile.manage") ||
    hasPermission(context, "booking.settings.manage")
  ) {
    return true;
  }
  reply.status(403).send({
    code: "missing_permission",
    detail: "Public profile and location publication require hotel-owner access.",
  });
  return false;
}

function hasPublishedPropertySurface(profile: SharedPropertyProfileInput): boolean {
  const surface = propertyPublicationSurface(profile);
  return surface.locality !== null || surface.geo !== null || surface.contacts.length > 0;
}

function publishedPropertySurfaceChanged(
  current: SharedPropertyProfileInput,
  next: SharedPropertyProfileInput,
): boolean {
  return (
    JSON.stringify(propertyPublicationSurface(current)) !==
    JSON.stringify(propertyPublicationSurface(next))
  );
}

function propertyPublicationSurface(profile: SharedPropertyProfileInput): {
  locality: {
    countryCode: string;
    city: string | null;
  } | null;
  geo: {
    latitude: number | null;
    longitude: number | null;
    mapDisplayMode: PropertyProfileLocation["mapDisplayMode"];
  } | null;
  contacts: string[];
} {
  const { location } = profile;
  return {
    locality: location.localityPublic
      ? {
          countryCode: location.countryCode,
          city: location.city ?? null,
        }
      : null,
    geo:
      location.geoPublic || location.mapDisplayMode !== "hidden"
        ? {
            latitude: location.latitude ?? null,
            longitude: location.longitude ?? null,
            mapDisplayMode: location.mapDisplayMode,
          }
        : null,
    contacts: profile.contacts
      .filter(({ isPublic }) => isPublic)
      .map(({ channelType, purpose, value }) => `${channelType}\u0000${purpose}\u0000${value}`)
      .sort(),
  };
}

function resolveSharedSetupTrackUpdateAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): ReturnType<typeof enforceRoutePolicy> | null {
  try {
    const context = enforceRoutePolicy(request, {
      permission: "hotel_catalog.products.manage",
    });
    if (context.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({
        statusCode: 403,
        code: "invalid_organization_scope",
        category: "authorization",
        message: "Hotel setup track changes require a hotel-group organization.",
      } satisfies SharedHotelSetupTrackAccessError);
      return null;
    }

    return context;
  } catch (error) {
    const accessError = toSharedSetupTrackAccessError(error);
    if (!accessError) throw error;
    reply.status(accessError.statusCode).send(accessError);
    return null;
  }
}

function toSharedSetupTrackAccessError(error: unknown): SharedHotelSetupTrackAccessError | null {
  if (error instanceof UnauthorizedError) {
    return {
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    };
  }
  if (!(error instanceof AuthorizationError)) return null;

  return {
    statusCode: 403,
    code: "missing_permission",
    category: "authorization",
    message: "Missing required hotel product management permission.",
  };
}

function resolveSharedSetupAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  requestedPropertyId: string | null,
  permission: PermissionKey = "hotel_catalog.setup.read",
): {
  context: ReturnType<typeof enforceRoutePolicy>;
  organizationId: string;
  propertyIds: string[];
} | null {
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
      context,
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

async function resolveSharedSetupStatusAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  requestedPropertyId: string | null,
  propertyAccessRepository: PropertyAccessRepository | undefined,
): Promise<ReturnType<typeof resolveSharedSetupAccess>> {
  const access = resolveSharedSetupAccess(
    request,
    reply,
    null,
    "hotel_catalog.property_manifest.read",
  );
  if (!access) return null;
  if (!propertyAccessRepository) {
    request.log.error("Shared hotel setup property access repository is unavailable");
    return sharedSetupPropertyAccessUnavailable(reply);
  }

  try {
    const effectiveAccess = await resolveEffectivePropertyAccess(
      access.context,
      propertyAccessRepository,
    );
    if (!effectiveAccess) return sharedSetupPropertyAccessDenied(reply);

    const effectivePropertyIds = new Set(effectiveAccess.propertyIds);
    const propertyIds = access.propertyIds.filter((id) => effectivePropertyIds.has(id));
    if (requestedPropertyId && !propertyIds.includes(requestedPropertyId)) {
      return sharedSetupPropertyAccessDenied(reply);
    }

    return { ...access, propertyIds };
  } catch (error) {
    request.log.error({ err: error }, "Shared hotel setup property access check failed");
    return sharedSetupPropertyAccessUnavailable(reply);
  }
}

function sharedSetupPropertyAccessDenied(reply: FastifyReply): null {
  reply.status(403).send({
    code: "property_access_denied",
    detail: "Property access is not available.",
  });
  return null;
}

function sharedSetupPropertyAccessUnavailable(reply: FastifyReply): null {
  reply.status(503).send({
    code: "property_access_unavailable",
    detail: "Property access is temporarily unavailable.",
  });
  return null;
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

function parseIdempotencyKey(request: FastifyRequest, reply: FastifyReply): string | null {
  const headerOccurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (headerOccurrences !== 1 || typeof header !== "string") {
    invalidSetupRequest(
      reply,
      "Idempotency-Key must be provided exactly once and contain 1 to 200 characters.",
    );
    return null;
  }

  const idempotencyKey = header.trim();
  if (idempotencyKey.length === 0 || idempotencyKey.length > 200) {
    invalidSetupRequest(
      reply,
      "Idempotency-Key must be provided exactly once and contain 1 to 200 characters.",
    );
    return null;
  }
  return idempotencyKey;
}

function invalidSetupRequest(reply: FastifyReply, detail: string): FastifyReply {
  return reply.status(422).send({
    code: "invalid_setup_request",
    detail,
  });
}

function parsePublicPropertyProfileUpdate(
  body: SharedPropertyProfileBody,
  reply: FastifyReply,
): UpdatePublicPropertyProfileRequest | false {
  const errors: Record<string, string[]> = {};
  if (!isObjectRecord(body)) {
    addFieldError(errors, "request", "request must be an object.");
    return sendInvalidProfile(reply, errors);
  }
  validateKnownKeys(body, ["expectedProfileRevision", "patch"], "request", errors);
  const expectedProfileRevision = body["expectedProfileRevision"];
  if (
    !Number.isSafeInteger(expectedProfileRevision) ||
    (expectedProfileRevision as number) < 1 ||
    (expectedProfileRevision as number) > 2_147_483_647
  ) {
    addFieldError(
      errors,
      "expectedProfileRevision",
      "expectedProfileRevision must be a positive integer.",
    );
  }
  const rawPatch = body["patch"];
  if (!isObjectRecord(rawPatch) || Object.keys(rawPatch).length === 0) {
    addFieldError(errors, "patch", "patch must be a non-empty object.");
    return sendInvalidProfile(reply, errors);
  }
  validateKnownKeys(rawPatch, ["shortDescription", "longDescription", "media"], "patch", errors);
  const patch: PublicPropertyProfilePatch = {};
  if (Object.hasOwn(rawPatch, "shortDescription")) {
    patch.shortDescription = nullableDescription(
      rawPatch["shortDescription"],
      "patch.shortDescription",
      500,
      errors,
    );
  }
  if (Object.hasOwn(rawPatch, "longDescription")) {
    patch.longDescription = nullableDescription(
      rawPatch["longDescription"],
      "patch.longDescription",
      5_000,
      errors,
    );
  }
  if (Object.hasOwn(rawPatch, "media")) {
    const media = parsePublicProfileMediaPatch(rawPatch["media"], errors);
    if (media !== false) patch.media = media;
  }
  if (Object.keys(errors).length > 0 || typeof expectedProfileRevision !== "number") {
    return sendInvalidProfile(reply, errors);
  }
  return { expectedProfileRevision, patch };
}

function nullableDescription(
  value: unknown,
  field: string,
  maxLength: number,
  errors: Record<string, string[]>,
): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    addFieldError(errors, field, `${field} must be a string or null.`);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    addFieldError(errors, field, `${field} is too long.`);
    return null;
  }
  return trimmed;
}

function parsePublicProfileMediaPatch(
  value: unknown,
  errors: Record<string, string[]>,
): PublicPropertyProfileMediaPatchItem[] | false {
  if (!Array.isArray(value)) {
    addFieldError(errors, "patch.media", "patch.media must be an array.");
    return false;
  }
  if (value.length > 100) {
    addFieldError(errors, "patch.media", "patch.media may contain at most 100 items.");
  }
  const media = value.map((item, index): PublicPropertyProfileMediaPatchItem => {
    const field = `patch.media.${index}`;
    const input = objectValue(item);
    if (!isObjectRecord(item)) addFieldError(errors, field, `${field} must be an object.`);
    validateKnownKeys(input, ["mediaObjectId", "altText", "sortOrder"], field, errors);
    const mediaObjectId = requiredString(input["mediaObjectId"], `${field}.mediaObjectId`, errors, {
      maxLength: 36,
    });
    if (mediaObjectId && !isUuid(mediaObjectId)) {
      addFieldError(errors, `${field}.mediaObjectId`, "mediaObjectId must be a UUID.");
    }
    const altText = nullableDescription(input["altText"], `${field}.altText`, 240, errors);
    const sortOrder = input["sortOrder"];
    if (
      !Number.isSafeInteger(sortOrder) ||
      (sortOrder as number) < 0 ||
      (sortOrder as number) > 2_147_483_647
    ) {
      addFieldError(errors, `${field}.sortOrder`, "sortOrder must be a non-negative integer.");
    }
    return {
      mediaObjectId: mediaObjectId ?? "",
      altText,
      sortOrder: typeof sortOrder === "number" ? sortOrder : 0,
    };
  });
  if (new Set(media.map(({ mediaObjectId }) => mediaObjectId)).size !== media.length) {
    addFieldError(errors, "patch.media", "patch.media must not contain duplicate mediaObjectIds.");
  }
  if (new Set(media.map(({ sortOrder }) => sortOrder)).size !== media.length) {
    addFieldError(
      errors,
      "patch.media",
      "patch.media must not contain duplicate sortOrder values.",
    );
  }
  return media;
}

function parseCreatePropertyProfile(
  body: SharedPropertyProfileBody,
  reply: FastifyReply,
): SharedPropertyProfileInput | false {
  const errors: Record<string, string[]> = {};
  if (!isObjectRecord(body)) {
    addFieldError(errors, "request", "request must be an object.");
    return sendInvalidProfile(reply, errors);
  }
  const input = objectValue(body);
  validateKnownKeys(
    input,
    ["displayName", "propertyType", "location", "contacts"],
    "request",
    errors,
  );
  const location = objectValue(input["location"]);
  validateKnownKeys(
    location,
    [
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
    ],
    "location",
    errors,
  );
  const profile = parseCanonicalPropertyProfile(input, errors);
  if (profile && Object.keys(errors).length === 0) return profile;
  return sendInvalidProfile(reply, errors);
}

function parsePropertyProfileUpdate(
  body: SharedPropertyProfileBody,
  existing: PropertyProfile,
  reply: FastifyReply,
): { expectedProfileRevision: number; profile: PropertyProfile } | false {
  const errors: Record<string, string[]> = {};
  if (!isObjectRecord(body)) {
    addFieldError(errors, "request", "request must be an object.");
    return sendInvalidProfile(reply, errors);
  }
  validateKnownKeys(body, ["expectedProfileRevision", "patch"], "request", errors);
  const expectedProfileRevision = body["expectedProfileRevision"];
  if (
    !Number.isSafeInteger(expectedProfileRevision) ||
    (expectedProfileRevision as number) < 1 ||
    (expectedProfileRevision as number) > 2_147_483_647
  ) {
    addFieldError(
      errors,
      "expectedProfileRevision",
      "expectedProfileRevision must be a positive integer.",
    );
  }
  const rawPatch = body["patch"];
  if (!isObjectRecord(rawPatch) || Object.keys(rawPatch).length === 0) {
    addFieldError(errors, "patch", "patch must be a non-empty object.");
    return sendInvalidProfile(reply, errors);
  }
  validateKnownKeys(
    rawPatch,
    ["displayName", "propertyType", "location", "contacts"],
    "patch",
    errors,
  );
  if (
    rawPatch["location"] !== undefined &&
    (!isObjectRecord(rawPatch["location"]) || Object.keys(rawPatch["location"]).length === 0)
  ) {
    addFieldError(errors, "patch.location", "patch.location must be a non-empty object.");
  }
  const locationPatch = objectValue(rawPatch["location"]);
  validateKnownKeys(
    locationPatch,
    [
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
    ],
    "patch.location",
    errors,
  );
  const merged: Record<string, unknown> = {
    ...existing,
    ...rawPatch,
    location: { ...existing.location, ...locationPatch },
    contacts: rawPatch["contacts"] ?? existing.contacts,
  };
  const profile = parseCanonicalPropertyProfile(merged, errors);
  if (profile && Object.keys(errors).length === 0 && typeof expectedProfileRevision === "number") {
    return { expectedProfileRevision, profile };
  }
  return sendInvalidProfile(reply, errors);
}

function parseCanonicalPropertyProfile(
  input: Record<string, unknown>,
  errors: Record<string, string[]>,
): PropertyProfile | null {
  const displayName = requiredString(input["displayName"], "displayName", errors, {
    maxLength: 200,
  });
  const propertyType = requiredString(input["propertyType"], "propertyType", errors, {
    maxLength: 40,
  });
  if (propertyType && !SHARED_PROPERTY_TYPE_VALUES.has(propertyType)) {
    addFieldError(errors, "propertyType", "propertyType is invalid.");
  }
  if (!isObjectRecord(input["location"])) {
    addFieldError(errors, "location", "location must be an object.");
  }
  const location = parseProfileLocation(objectValue(input["location"]), errors);
  const contacts = parseProfileContacts(input["contacts"], errors);
  if (!displayName || !propertyType || contacts === false) return null;
  return { displayName, propertyType, location, contacts };
}

function parseProfileLocation(
  input: Record<string, unknown>,
  errors: Record<string, string[]>,
): PropertyProfileLocation {
  const countryCode = requiredString(input["countryCode"], "location.countryCode", errors, {
    maxLength: 2,
  });
  if (countryCode && !/^[A-Za-z]{2}$/.test(countryCode)) {
    addFieldError(errors, "location.countryCode", "countryCode must be a two-letter code.");
  }

  const timezone = requiredString(input["timezone"], "location.timezone", errors, {
    maxLength: 80,
  });
  if (timezone && (!TIMEZONE_PATTERN.test(timezone) || !isValidTimezone(timezone))) {
    addFieldError(errors, "location.timezone", "timezone must be an IANA timezone.");
  }

  const latitude = optionalNumber(input["latitude"], "location.latitude", errors, {
    min: -90,
    max: 90,
  });
  const longitude = optionalNumber(input["longitude"], "location.longitude", errors, {
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
    input["mapDisplayMode"],
    "location.mapDisplayMode",
    PROPERTY_PROFILE_MAP_DISPLAY_MODES,
    errors,
    "hidden",
  );
  const localityPublic = optionalBoolean(
    input["localityPublic"],
    "location.localityPublic",
    errors,
    false,
  );
  const geoPublic = optionalBoolean(input["geoPublic"], "location.geoPublic", errors, false);
  if (geoPublic && (latitude === null || longitude === null || mapDisplayMode === "hidden")) {
    addFieldError(
      errors,
      "location.geoPublic",
      "geoPublic requires coordinates and an approximate or exact map display mode.",
    );
  }
  if (!geoPublic && mapDisplayMode !== "hidden") {
    addFieldError(
      errors,
      "location.mapDisplayMode",
      "mapDisplayMode must be hidden while geoPublic is false.",
    );
  }

  return {
    countryCode: countryCode?.toUpperCase() ?? "",
    city: requiredString(input["city"], "location.city", errors, { maxLength: 120 }) ?? "",
    streetAddress:
      requiredString(input["streetAddress"], "location.streetAddress", errors, {
        maxLength: 240,
      }) ?? "",
    postalCode:
      requiredString(input["postalCode"], "location.postalCode", errors, {
        maxLength: 32,
      }) ?? "",
    timezone: timezone ?? "",
    latitude,
    longitude,
    localityPublic,
    geoPublic,
    mapDisplayMode,
  };
}

function parseProfileContacts(
  value: unknown,
  errors: Record<string, string[]>,
): PropertyProfileContact[] | false {
  if (!Array.isArray(value)) {
    addFieldError(errors, "contacts", "contacts must be an array.");
    return false;
  }
  if (value.length > 50) {
    addFieldError(errors, "contacts", "contacts may contain at most 50 items.");
  }
  const contacts = value.map((item, index): PropertyProfileContact => {
    const contact = objectValue(item);
    const field = `contacts.${index}`;
    if (!isObjectRecord(item)) addFieldError(errors, field, `${field} must be an object.`);
    validateKnownKeys(contact, ["channelType", "value", "purpose", "isPublic"], field, errors);
    const channelType = optionalEnum(
      contact["channelType"],
      `${field}.channelType`,
      PROPERTY_PROFILE_CHANNEL_TYPES,
      errors,
      "email",
      true,
    );
    let contactValue =
      requiredString(contact["value"], `${field}.value`, errors, {
        maxLength: channelType === "website" ? 2048 : 320,
      }) ?? "";
    if (channelType === "email" && contactValue) {
      if (EMAIL_PATTERN.test(contactValue)) contactValue = contactValue.toLowerCase();
      else addFieldError(errors, `${field}.value`, "email contact must be a valid email address.");
    }
    if ((channelType === "phone" || channelType === "whatsapp") && !isValidPhone(contactValue)) {
      addFieldError(
        errors,
        `${field}.value`,
        `${channelType} contact must be a valid phone number.`,
      );
    }
    if (channelType === "website" && contactValue) {
      contactValue = validHttpUrl(contactValue) ?? "";
      if (!contactValue) {
        addFieldError(errors, `${field}.value`, "website contact must be an http or https URL.");
      }
    }
    const purpose = optionalEnum(
      contact["purpose"],
      `${field}.purpose`,
      PROPERTY_PROFILE_CONTACT_PURPOSES,
      errors,
      "general",
      true,
    );
    const isPublic = requiredBoolean(contact["isPublic"], `${field}.isPublic`, errors);
    return { channelType, value: contactValue, purpose, isPublic };
  });

  if (!contacts.some(({ channelType }) => channelType === "email")) {
    addFieldError(errors, "contacts", "contacts must include an email.");
  }
  if (!contacts.some(({ channelType }) => channelType === "phone")) {
    addFieldError(errors, "contacts", "contacts must include a phone.");
  }
  const uniqueContacts = new Set(
    contacts.map(({ channelType, value }) => `${channelType}\u0000${value.toLowerCase()}`),
  );
  if (uniqueContacts.size !== contacts.length) {
    addFieldError(errors, "contacts", "contacts must not contain duplicates.");
  }
  return contacts;
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

function validHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
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

function optionalBoolean(
  value: unknown,
  field: string,
  errors: Record<string, string[]>,
  fallback: boolean,
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  addFieldError(errors, field, `${field} must be a boolean.`);
  return fallback;
}

function requiredBoolean(value: unknown, field: string, errors: Record<string, string[]>): boolean {
  if (typeof value === "boolean") return value;
  addFieldError(errors, field, `${field} must be a boolean.`);
  return false;
}

function optionalEnum<T extends readonly string[]>(
  value: unknown,
  field: string,
  allowed: T,
  errors: Record<string, string[]>,
  fallback: T[number],
  required = false,
): T[number] {
  if (value === undefined || value === null || value === "") {
    if (required) addFieldError(errors, field, `${field} is required.`);
    return fallback;
  }
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  addFieldError(errors, field, `${field} is invalid.`);
  return fallback;
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  errors: Record<string, string[]>,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      addFieldError(errors, `${field}.${key}`, `${field}.${key} is not supported.`);
    }
  }
}

function sendInvalidProfile(reply: FastifyReply, errors: Record<string, string[]>): false {
  reply.status(422).send({
    code: "invalid_setup_request",
    detail: "Property profile contains invalid fields.",
    fields: errors,
  });
  return false;
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
  properties: AdaptivePropertySetupFacts[],
  propertyIds: string[],
): AdaptivePropertySetupFacts[] {
  const authorized = new Set(propertyIds);
  const order = new Map(propertyIds.map((propertyId, index) => [propertyId, index]));
  return properties
    .filter((property) => authorized.has(property.propertyId))
    .sort((left, right) => (order.get(left.propertyId) ?? 0) - (order.get(right.propertyId) ?? 0));
}

function selectionState(
  propertyIds: string[],
): AdaptiveHotelSetupStatus["propertySelection"]["state"] {
  if (propertyIds.length === 0) return "no_property";
  return propertyIds.length === 1 ? "single_property" : "multiple_properties";
}

type SetupTaskDefinition = Pick<SetupTask, "taskId" | "track" | "requirementOwnerDomain"> & {
  permissions: PermissionKey[];
  actionableBy: Exclude<SetupTask["actionableBy"], null>;
  dependencies: SetupTaskId[];
};

const SETUP_TASK_REGISTRY: readonly SetupTaskDefinition[] = [
  {
    taskId: "shared_identity",
    track: "shared",
    requirementOwnerDomain: "hotel_catalog",
    permissions: ["hotel_catalog.setup.manage"],
    actionableBy: "operator",
    dependencies: [],
  },
  {
    taskId: "public_profile",
    track: "creator_marketplace",
    requirementOwnerDomain: "hotel_catalog",
    permissions: ["hotel_catalog.setup.manage", "marketplace.profile.manage"],
    actionableBy: "owner",
    dependencies: ["shared_identity"],
  },
  {
    taskId: "creator_offer",
    track: "creator_marketplace",
    requirementOwnerDomain: "marketplace",
    permissions: ["marketplace.profile.manage"],
    actionableBy: "owner",
    dependencies: ["shared_identity", "public_profile"],
  },
  {
    taskId: "rooms_rates_availability",
    track: "hotel_operations",
    requirementOwnerDomain: "pms",
    permissions: ["pms.operations.manage"],
    actionableBy: "operator",
    dependencies: ["shared_identity"],
  },
  {
    taskId: "guest_settings_policies",
    track: "hotel_operations",
    requirementOwnerDomain: "booking",
    permissions: ["booking.settings.manage"],
    actionableBy: "owner",
    dependencies: ["shared_identity", "rooms_rates_availability"],
  },
  {
    taskId: "billing_plan",
    track: "hotel_operations",
    requirementOwnerDomain: "finance",
    permissions: ["booking.settings.manage"],
    actionableBy: "owner",
    dependencies: ["shared_identity", "rooms_rates_availability"],
  },
  {
    taskId: "payment",
    track: "hotel_operations",
    requirementOwnerDomain: "finance",
    permissions: ["booking.settings.manage"],
    actionableBy: "owner",
    dependencies: ["shared_identity", "billing_plan"],
  },
  {
    taskId: "direct_booking_publication",
    track: "hotel_operations",
    requirementOwnerDomain: "distribution",
    permissions: ["booking.settings.manage"],
    actionableBy: "owner",
    dependencies: [
      "shared_identity",
      "rooms_rates_availability",
      "guest_settings_policies",
      "billing_plan",
      "payment",
    ],
  },
];

const ENTRY_PRODUCT_WORKSPACE_PERMISSIONS: Record<
  SharedHotelSetupEntryProduct,
  readonly PermissionKey[]
> = {
  booking: [
    "booking.analytics.read",
    "booking.reservation.read",
    "booking.design.read",
    "booking.flow.read",
    "booking.settings.read",
  ],
  pms: [
    "pms.operations.read",
    "pms.dashboard.read",
    "pms.calendar.read",
    "pms.reservation.read",
    "pms.inbox.read",
    "pms.room_status.read",
    "pms.rooms_rates.read",
    "pms.channel_manager.read",
    "pms.finance.read",
    "pms.settings.read",
  ],
  marketplace: ["marketplace.collaboration.read"],
};

function entryDecision(input: {
  context: ReturnType<typeof enforceRoutePolicy>;
  entryProduct: SharedHotelSetupEntryProduct | null;
  propertyId: string | null;
  selectedTracks: SetupTrack[];
  tracks: TrackStatus[];
}): ProductEntryDecision | null {
  const { context, entryProduct, propertyId, selectedTracks, tracks } = input;
  if (!entryProduct) return null;
  const track = entryProduct === "marketplace" ? "creator_marketplace" : "hotel_operations";
  if (!propertyId) {
    return {
      requestedProduct: entryProduct,
      propertyId: null,
      decision: "setup_required",
      destinationRouteKey: "hotel_setup",
      reasonCode: "property_selection_required",
    };
  }
  if (!selectedTracks.includes(track)) {
    return {
      requestedProduct: entryProduct,
      propertyId,
      decision: "setup_required",
      destinationRouteKey: "hotel_setup",
      reasonCode: "track_not_selected",
    };
  }
  const status = tracks.find((item) => item.track === track);
  const component = status?.components.find((item) => item.product === entryProduct);
  if (
    component?.access === "active" &&
    hasProductPropertyAccess(context, entryProduct, propertyId)
  ) {
    if (
      !ENTRY_PRODUCT_WORKSPACE_PERMISSIONS[entryProduct].some((permission) =>
        hasPermission(context, permission),
      )
    ) {
      return {
        requestedProduct: entryProduct,
        propertyId,
        decision: "unavailable",
        destinationRouteKey: null,
        reasonCode: "workspace_permission_missing",
      };
    }
    return {
      requestedProduct: entryProduct,
      propertyId,
      decision: "enter",
      destinationRouteKey: `${entryProduct}.workspace`,
      reasonCode: null,
    };
  }
  if (status?.provisioning === "blocked") {
    return {
      requestedProduct: entryProduct,
      propertyId,
      decision: "unavailable",
      destinationRouteKey: null,
      reasonCode: "service_management_required",
    };
  }
  if (component?.access === "suspended" || component?.access === "unavailable") {
    return {
      requestedProduct: entryProduct,
      propertyId,
      decision: "unavailable",
      destinationRouteKey: null,
      reasonCode:
        component.access === "suspended" ? "component_suspended" : "component_unavailable",
    };
  }
  return {
    requestedProduct: entryProduct,
    propertyId,
    decision: "setup_required",
    destinationRouteKey: "hotel_setup",
    reasonCode: "product_access_pending",
  };
}

export function buildPropertySetupPlan(input: {
  context: ReturnType<typeof enforceRoutePolicy>;
  property: AdaptivePropertySetupFacts;
  selectedTracks: SetupTrack[];
  trackRevision: number;
  tracks: TrackStatus[];
  evaluatedAt: string;
}): PropertySetupPlan {
  const { context, property, selectedTracks, trackRevision, tracks, evaluatedAt } = input;
  const definitions = SETUP_TASK_REGISTRY.filter(({ track }) =>
    track === "shared" ? selectedTracks.length > 0 : selectedTracks.includes(track),
  );
  const includedTaskIds = new Set(definitions.map(({ taskId }) => taskId));
  const tasks = definitions.map((definition): SetupTask => {
    const fact = property.taskFacts[definition.taskId];
    const requiredProduct = setupTaskProduct(definition.taskId);
    const productAccessBlocked =
      requiredProduct !== null &&
      (tracks
        .flatMap(({ components }) => components)
        .find(({ product }) => product === requiredProduct)?.access !== "active" ||
        !hasProductPropertyAccess(context, requiredProduct, property.propertyId));
    const blockedDependencies = definition.dependencies.filter(
      (taskId) =>
        includedTaskIds.has(taskId) &&
        property.taskFacts[taskId].ownerProgress !== "owner_complete",
    );
    const factReadiness =
      fact.freshness === "stale" && fact.readiness === "complete" ? "pending_sync" : fact.readiness;
    const dependencyBlocked =
      blockedDependencies.length > 0 &&
      (factReadiness === "actionable" || factReadiness === "complete");
    const readiness = productAccessBlocked
      ? "blocked"
      : dependencyBlocked
        ? "blocked"
        : factReadiness;
    const callerCapability = productAccessBlocked
      ? "forbidden"
      : readiness === "pending_review" || readiness === "pending_sync"
        ? "waiting"
        : definition.permissions.every((permission) => hasPermission(context, permission))
          ? "allowed"
          : "ask_owner";
    const actionableBy =
      readiness === "complete"
        ? null
        : readiness === "pending_review"
          ? "support"
          : readiness === "pending_sync"
            ? "system"
            : readiness === "blocked"
              ? null
              : definition.actionableBy;

    return {
      taskId: definition.taskId,
      propertyId: property.propertyId,
      track: definition.track,
      requirementOwnerDomain: definition.requirementOwnerDomain,
      destinationRouteKey: SETUP_TASK_DESTINATION_ROUTE_KEYS[definition.taskId],
      callerCapability,
      ownerProgress: fact.ownerProgress,
      readiness,
      actionableBy,
      reasonCodes: unique([
        ...fact.reasonCodes,
        ...(fact.freshness === "stale" && fact.readiness === "complete"
          ? ["source_facts_stale"]
          : []),
        ...(factReadiness === "blocked" ? ["domain_readiness_blocked"] : []),
        ...(productAccessBlocked ? ["task_product_access_blocked"] : []),
        ...(dependencyBlocked ? ["task_dependencies_incomplete"] : []),
        ...blockedDependencies.map((taskId) => `${taskId}_incomplete`),
      ]),
      sourceRevision: fact.sourceRevision,
      freshness: fact.freshness,
      evaluatedAt,
    };
  });
  const recommendedTask = tasks.find(isSetupTaskLaunchable) ?? null;
  const ownerComplete = tasks.filter(
    ({ ownerProgress }) => ownerProgress === "owner_complete",
  ).length;
  const ownerProgress = { complete: ownerComplete, total: tasks.length };
  const launchReadinessByUse = {
    operationsUse: launchReadiness(tasks, selectedTracks, "hotel_operations", [
      "shared_identity",
      "rooms_rates_availability",
    ]),
    directBookingPublish: launchReadiness(tasks, selectedTracks, "hotel_operations", [
      "shared_identity",
      "rooms_rates_availability",
      "guest_settings_policies",
      "billing_plan",
      "payment",
      "direct_booking_publication",
    ]),
    marketplacePublish: launchReadiness(tasks, selectedTracks, "creator_marketplace", [
      "shared_identity",
      "public_profile",
      "creator_offer",
    ]),
  };

  return {
    propertyId: property.propertyId,
    planRevision: propertySetupPlanRevision({
      context,
      property,
      selectedTracks,
      trackRevision,
      tracks,
      definitions,
      tasks,
      recommendedTaskId: recommendedTask?.taskId ?? null,
      ownerProgress,
      launchReadiness: launchReadinessByUse,
    }),
    tasks,
    recommendedTaskId: recommendedTask?.taskId ?? null,
    ownerProgress,
    launchReadiness: launchReadinessByUse,
  };
}

function propertySetupPlanRevision(input: {
  context: ReturnType<typeof enforceRoutePolicy>;
  property: AdaptivePropertySetupFacts;
  selectedTracks: SetupTrack[];
  trackRevision: number;
  tracks: TrackStatus[];
  definitions: readonly SetupTaskDefinition[];
  tasks: SetupTask[];
  recommendedTaskId: SetupTaskId | null;
  ownerProgress: PropertySetupPlan["ownerProgress"];
  launchReadiness: PropertySetupPlan["launchReadiness"];
}): string {
  const {
    context,
    property,
    selectedTracks,
    trackRevision,
    tracks,
    definitions,
    tasks,
    recommendedTaskId,
    ownerProgress,
    launchReadiness,
  } = input;
  const selectedTrackSet = new Set(selectedTracks);
  const relevantProducts = new Set<string>();
  if (selectedTrackSet.has("hotel_operations")) {
    relevantProducts.add("pms");
    relevantProducts.add("booking");
  }
  if (selectedTrackSet.has("creator_marketplace")) relevantProducts.add("marketplace");

  const revisionState = {
    revisionContract: "property-setup-plan-revision.v2",
    property: {
      propertyId: property.propertyId,
      publicId: property.publicId,
      displayName: property.displayName,
      locationSummary: property.locationSummary,
    },
    trackSelection: {
      trackRevision,
      selectedTracks: [...selectedTracks].sort(),
      statuses: tracks
        .filter(({ track }) => selectedTrackSet.has(track))
        .map(({ track, provisioning, components }) => ({
          track,
          provisioning,
          components: components
            .map(({ product, access }) => ({ product, access }))
            .sort((left, right) => compareCanonicalText(left.product, right.product)),
        }))
        .sort((left, right) => compareCanonicalText(left.track, right.track)),
    },
    authorization: {
      permissions: unique(definitions.flatMap(({ permissions }) => permissions))
        .sort()
        .map((permission) => ({
          permission,
          granted: hasPermission(context, permission),
        })),
      entitlements: context.entitlements
        .filter(
          ({ product, resource }) =>
            relevantProducts.has(product) &&
            (!resource || resource.resourceId === property.propertyId),
        )
        .map(({ product, key, status, resource }) => ({
          product,
          key,
          status,
          resource: resource
            ? {
                product: resource.product,
                resourceType: resource.resourceType,
                resourceId: resource.resourceId,
              }
            : null,
        }))
        .sort(compareCanonicalValues),
      propertyLinks: context.linkedResources
        .filter(
          ({ product, resourceId }) =>
            resourceId === property.propertyId &&
            (product === "hotel_catalog" || relevantProducts.has(product)),
        )
        .map(({ product, resourceType, resourceId, relationship, status }) => ({
          product,
          resourceType,
          resourceId,
          relationship,
          status,
        }))
        .sort(compareCanonicalValues),
    },
    taskDefinitions: definitions.map(
      ({ taskId, track, requirementOwnerDomain, permissions, actionableBy, dependencies }) => ({
        taskId,
        track,
        requirementOwnerDomain,
        destinationRouteKey: SETUP_TASK_DESTINATION_ROUTE_KEYS[taskId],
        permissions: [...permissions].sort(),
        actionableBy,
        dependencies: [...dependencies].sort(),
      }),
    ),
    tasks: tasks.map(
      ({
        taskId,
        propertyId,
        track,
        requirementOwnerDomain,
        destinationRouteKey,
        callerCapability,
        ownerProgress: taskOwnerProgress,
        readiness,
        actionableBy,
        reasonCodes,
        sourceRevision,
        freshness,
      }) => ({
        taskId,
        propertyId,
        track,
        requirementOwnerDomain,
        destinationRouteKey,
        callerCapability,
        ownerProgress: taskOwnerProgress,
        readiness,
        actionableBy,
        reasonCodes: [...reasonCodes].sort(),
        sourceRevision,
        freshness,
      }),
    ),
    recommendedTaskId,
    ownerProgress,
    launchReadiness,
  };
  const digest = createHash("sha256").update(JSON.stringify(revisionState)).digest("base64url");
  return `plan.v2:${digest}`;
}

function compareCanonicalValues(left: unknown, right: unknown): number {
  return compareCanonicalText(JSON.stringify(left), JSON.stringify(right));
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function launchReadiness(
  tasks: SetupTask[],
  selectedTracks: SetupTrack[],
  track: SetupTrack,
  requiredTaskIds: SetupTaskId[],
): PropertySetupPlan["launchReadiness"]["operationsUse"] {
  if (!selectedTracks.includes(track)) return "not_applicable";
  const required = requiredTaskIds.map((taskId) => tasks.find((task) => task.taskId === taskId)!);
  if (
    required.some(
      (task) =>
        task.readiness === "rejected" ||
        task.reasonCodes.includes("domain_readiness_blocked") ||
        task.reasonCodes.includes("task_product_access_blocked"),
    )
  ) {
    return "blocked";
  }
  return required.every(
    ({ readiness, freshness }) => readiness === "complete" && freshness === "fresh",
  )
    ? "ready"
    : "pending";
}

function setupTaskProduct(taskId: SetupTaskId): SharedHotelSetupEntryProduct | null {
  if (taskId === "public_profile" || taskId === "creator_offer") return "marketplace";
  if (taskId === "rooms_rates_availability") return "pms";
  if (
    taskId === "guest_settings_policies" ||
    taskId === "billing_plan" ||
    taskId === "payment" ||
    taskId === "direct_booking_publication"
  ) {
    return "booking";
  }
  return null;
}

function hasProductPropertyAccess(
  context: ReturnType<typeof enforceRoutePolicy>,
  product: SharedHotelSetupEntryProduct,
  propertyId: string,
): boolean {
  const resourceType = {
    booking: "booking_hotel",
    pms: "pms_property",
    marketplace: "hotel_profile",
  } as const;
  return context.linkedResources.some(
    (resource) =>
      resource.product === product &&
      resource.resourceType === resourceType[product] &&
      resource.resourceId === propertyId &&
      resource.status === "active" &&
      (resource.relationship === "owner" || resource.relationship === "operator"),
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
