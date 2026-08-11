import { uploadPlatformMedia } from "@vayada/marketplace-shared/api/platformMedia";

import { ApiErrorResponse } from "./client";
import { sharedHotelSetupApi } from "./sharedHotelSetupClient";
import { targetApiClient } from "./targetClient";

export type RoomSetupDraft = {
  name: string;
  totalRooms: number;
  maxOccupancy: number;
  nightlyRate: number;
  currency: string;
  minimumStay: number;
};

export type ExistingRoomSetup = {
  roomTypeId: string;
  active: boolean;
  name: string;
  totalRooms: number;
  maxOccupancy: number;
  nightlyRate: string;
  currency: string;
  minimumStay: number | null;
};

export type RoomSetupState =
  | { status: "empty" }
  | {
      status: "complete";
      room: ExistingRoomSetup | null;
    }
  | {
      status: "needs_recovery";
      room: ExistingRoomSetup | null;
      reasonCodes: string[];
    };

export type RoomSetupSaveResult =
  | { status: "created" }
  | Extract<RoomSetupState, { status: "complete" | "needs_recovery" }>;

export type GuestSettingsPolicies = {
  checkInTime: string;
  checkOutTime: string;
  cancellationPolicyText: string;
};

export type PropertyLaunchSettings = {
  defaultCurrency: string;
  supportedCurrencies: string[];
  defaultLanguage: string;
  supportedLanguages: string[];
  instagram: string;
  facebook: string;
  tiktok: string;
  youtube: string;
};

export type PaymentMethodChoice = "pay_at_property" | "bank_transfer" | "stripe";

export type FinancePaymentSettings = {
  paymentsEnabled: boolean;
  paymentProvider: "stripe" | "xendit" | "vayada" | "manual" | "bank_transfer";
  acceptedMethods: string[];
  defaultCurrency: string;
  supportedCurrencies: string[];
  requiresManualReview: boolean;
  providerAccount: {
    providerAccountId: string | null;
    provider: string | null;
    status: string;
    onboardingStatus: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
  };
};

export type DirectBookingSetup = {
  profileRevision: number;
  localityPublic: boolean;
  shortDescription: string;
  heroImageUrl: string;
  heroHeading: string;
  heroSubtext: string;
  primaryColor: string;
  fontPairing: string;
};

export type PublicBookabilityPublication = {
  propertyId: string;
  canonicalSlug: string;
  canonicalUrl: string;
  bookingBaseUrl: string;
  profileStatus: "public" | "incomplete" | "unpublished" | "stale" | "unavailable";
  freshnessStatus: "fresh" | "stale" | "unavailable" | "unknown";
  missingReadiness: string[];
};

type BookingPropertySettingsResponse = {
  check_in_time?: unknown;
  check_out_time?: unknown;
  cancellation_policy_text?: unknown;
};

type PmsRoomTypeListResponse = {
  items: Array<{
    roomTypeId: string;
    name: string;
    occupancyLimits: Record<string, number>;
    baseRate: {
      amountDecimal: string;
      currency: string;
    };
    active: boolean;
    rateRulesSummary: {
      minStayNights: number | null;
    };
    roomCount: number;
  }>;
};

type FinancePaymentSettingsResponse = {
  paymentSettings: FinancePaymentSettings;
};

type StripeProviderAccountResponse = {
  providerAccountId: string;
  onboardingUrl: string;
  status: string;
  onboardingStatus: string;
};

type BookingDesignSettingsResponse = {
  heroImage?: string;
  heroHeading?: string;
  heroSubtext?: string;
  primaryColor?: string;
  fontPairing?: string;
};

const ROOM_SETUP_MISSING_REASON_CODES = [
  "missing_active_room_type",
  "missing_non_retired_room",
  "missing_active_rate_plan",
  "missing_future_inventory",
] as const;

export type SaveDirectBookingSetupInput = {
  localityPublic: boolean;
  publicDescription?: string;
  heroHeading: string;
  heroSubtext: string;
  primaryColor: string;
  fontPairing: string;
  heroImageUrl?: string | null;
};

export const hotelOperationsSetupApi = {
  getExistingRoomSetup,
  getRoomSetupState,

  saveRoomSetup: async (
    propertyId: string,
    draft: RoomSetupDraft,
  ): Promise<RoomSetupSaveResult> => {
    const state = await getRoomSetupState(propertyId);
    if (state.status !== "empty") return state;

    const body = buildRoomSetupRequest(propertyId, draft);
    await targetApiClient.post(`/api/pms/properties/${encoded(propertyId)}/room-types`, body);
    return { status: "created" };
  },

  getGuestSettingsPolicies: async (
    propertyId: string,
    signal?: AbortSignal,
  ): Promise<GuestSettingsPolicies> => {
    const response = await targetApiClient.get<BookingPropertySettingsResponse>(
      `/api/booking/hotels/${encoded(propertyId)}/settings/property`,
      signal ? { signal } : undefined,
    );
    return {
      checkInTime: stringValue(response.check_in_time, "15:00"),
      checkOutTime: stringValue(response.check_out_time, "11:00"),
      cancellationPolicyText: stringValue(response.cancellation_policy_text),
    };
  },

  updateGuestSettingsPolicies: async (
    propertyId: string,
    settings: GuestSettingsPolicies,
  ): Promise<void> => {
    await targetApiClient.patch(`/api/booking/hotels/${encoded(propertyId)}/settings/property`, {
      check_in_time: settings.checkInTime,
      check_out_time: settings.checkOutTime,
      cancellation_policy_text: settings.cancellationPolicyText.trim(),
    });
  },

  getPropertyLaunchSettings: async (
    propertyId: string,
    signal?: AbortSignal,
  ): Promise<PropertyLaunchSettings> => {
    const response = await targetApiClient.get<PropertyLaunchSettings>(
      `/api/hotel-setup/properties/${encoded(propertyId)}/launch-settings`,
      signal ? { signal } : undefined,
    );
    return {
      defaultCurrency: stringValue(response.defaultCurrency, "USD"),
      supportedCurrencies: stringArray(response.supportedCurrencies),
      defaultLanguage: stringValue(response.defaultLanguage, "en"),
      supportedLanguages: stringArray(response.supportedLanguages),
      instagram: stringValue(response.instagram),
      facebook: stringValue(response.facebook),
      tiktok: stringValue(response.tiktok),
      youtube: stringValue(response.youtube),
    };
  },

  updatePropertyLaunchSettings: async (
    propertyId: string,
    settings: PropertyLaunchSettings,
  ): Promise<void> => {
    await targetApiClient.put(
      `/api/hotel-setup/properties/${encoded(propertyId)}/launch-settings`,
      settings,
    );
  },

  getPaymentSettings: async (
    propertyId: string,
    signal?: AbortSignal,
  ): Promise<FinancePaymentSettings> => {
    const response = await targetApiClient.get<FinancePaymentSettingsResponse>(
      `/api/finance/properties/${encoded(propertyId)}/payment-settings`,
      signal ? { signal } : undefined,
    );
    return response.paymentSettings;
  },

  updatePaymentSettings: async (
    propertyId: string,
    method: PaymentMethodChoice,
    currency: string,
  ): Promise<FinancePaymentSettings> => {
    const body = buildPaymentSettingsRequest(propertyId, method, currency);
    const response = await targetApiClient.patch<FinancePaymentSettingsResponse>(
      `/api/finance/properties/${encoded(propertyId)}/payment-settings`,
      body,
    );
    return response.paymentSettings;
  },

  startStripeOnboarding: async (
    propertyId: string,
    input: { email: string; country: string; providerAccountId?: string | null },
  ): Promise<StripeProviderAccountResponse> => {
    const endpoint = input.providerAccountId
      ? `/api/finance/properties/${encoded(propertyId)}/provider-accounts/${encoded(
          input.providerAccountId,
        )}/onboarding-link`
      : `/api/finance/properties/${encoded(propertyId)}/provider-accounts/stripe`;
    const commandId = stableSetupCommandId(
      input.providerAccountId ? "finance-stripe-onboarding" : "finance-stripe-account",
      propertyId,
      input.providerAccountId
        ? { providerAccountId: input.providerAccountId }
        : { email: input.email.trim().toLowerCase(), country: input.country.trim().toUpperCase() },
    );
    return targetApiClient.post<StripeProviderAccountResponse>(
      endpoint,
      input.providerAccountId
        ? { commandId, idempotencyKey: commandId }
        : {
            commandId,
            idempotencyKey: commandId,
            email: input.email.trim().toLowerCase(),
            country: input.country.trim().toUpperCase(),
          },
    );
  },

  getDirectBookingSetup: async (
    propertyId: string,
    signal?: AbortSignal,
  ): Promise<DirectBookingSetup> => {
    const options = signal ? { signal } : undefined;
    const [canonical, publicProfile, design] = await Promise.all([
      sharedHotelSetupApi.getPropertyProfile(propertyId, options),
      sharedHotelSetupApi.getPublicPropertyProfile(propertyId, options),
      targetApiClient.get<BookingDesignSettingsResponse>(
        `/api/booking/hotels/${encoded(propertyId)}/settings/design`,
        options,
      ),
    ]);
    const hero =
      publicProfile.publicProfile.media.find(({ mediaType }) => mediaType === "hero_image") ??
      publicProfile.publicProfile.media[0];
    const shortDescription =
      publicProfile.publicProfile.shortDescription ??
      publicProfile.publicProfile.longDescription ??
      "";
    return {
      profileRevision: canonical.profileRevision,
      localityPublic: canonical.profile.location.localityPublic,
      shortDescription,
      heroImageUrl: design.heroImage || hero?.url || "",
      heroHeading: design.heroHeading || canonical.profile.displayName,
      heroSubtext: design.heroSubtext || shortDescription,
      primaryColor: design.primaryColor || "#2946E8",
      fontPairing: design.fontPairing || "modern-minimalist",
    };
  },

  uploadDirectBookingHero: async (
    propertyId: string,
    heroImage: File,
    expectedProfileRevision: number,
  ): Promise<string> => {
    const [uploaded] = await uploadPlatformMedia({
      idempotencyKey: `booking.direct-hero:${propertyId}:revision:${expectedProfileRevision}`,
      purpose: "property.hero_image",
      visibility: "public",
      expectedProfileRevision,
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: propertyId,
        propertyId,
      },
      files: [heroImage],
    });
    if (!uploaded?.url) throw new Error("The public hotel image could not be saved.");
    return uploaded.url;
  },

  saveDirectBookingSetup: async (
    propertyId: string,
    input: SaveDirectBookingSetupInput,
  ): Promise<void> => {
    const canonical = await sharedHotelSetupApi.getPropertyProfile(propertyId);
    if (canonical.profile.location.localityPublic !== input.localityPublic) {
      await sharedHotelSetupApi.updatePropertyProfile(propertyId, {
        expectedProfileRevision: canonical.profileRevision,
        patch: { location: { localityPublic: input.localityPublic } },
      });
    }

    if (input.publicDescription !== undefined) {
      const publicProfile = await sharedHotelSetupApi.getPublicPropertyProfile(propertyId);
      const description = input.publicDescription.trim();
      if (publicProfile.publicProfile.shortDescription !== description) {
        await sharedHotelSetupApi.updatePublicPropertyProfile(propertyId, {
          expectedProfileRevision: publicProfile.profileRevision,
          patch: { shortDescription: description },
        });
      }
    }

    await targetApiClient.patch(`/api/booking/hotels/${encoded(propertyId)}/settings/design`, {
      heroImage: input.heroImageUrl || undefined,
      heroHeading: input.heroHeading.trim(),
      heroSubtext: input.heroSubtext.trim(),
      primaryColor: input.primaryColor,
      fontPairing: input.fontPairing,
    });
  },

  publishDirectBooking: async (propertyId: string): Promise<PublicBookabilityPublication> =>
    targetApiClient.post<PublicBookabilityPublication>(
      `/api/booking/hotels/${encoded(propertyId)}/public-bookability`,
    ),
};

async function getExistingRoomSetup(
  propertyId: string,
  signal?: AbortSignal,
): Promise<ExistingRoomSetup | null> {
  const response = await targetApiClient.get<PmsRoomTypeListResponse>(
    `/api/pms/properties/${encoded(propertyId)}/room-types`,
    signal ? { signal } : undefined,
  );
  const roomType = response.items.find(({ active }) => active) ?? response.items[0];
  if (!roomType) return null;

  return {
    roomTypeId: roomType.roomTypeId,
    active: roomType.active,
    name: roomType.name,
    totalRooms: roomType.roomCount,
    maxOccupancy: roomType.occupancyLimits.total ?? roomType.occupancyLimits.adults ?? 0,
    nightlyRate: roomType.baseRate.amountDecimal,
    currency: roomType.baseRate.currency,
    minimumStay: roomType.rateRulesSummary.minStayNights,
  };
}

async function getRoomSetupState(
  propertyId: string,
  signal?: AbortSignal,
): Promise<RoomSetupState> {
  const options = signal ? { signal } : undefined;
  const [room, setupStatus] = await Promise.all([
    getExistingRoomSetup(propertyId, signal),
    sharedHotelSetupApi.getStatus({ propertyId }, options),
  ]);
  const roomTask = setupStatus.setupPlan?.tasks.find(
    ({ taskId }) => taskId === "rooms_rates_availability",
  );
  if (!roomTask) {
    throw new Error("Room setup readiness could not be confirmed. Refresh the page and try again.");
  }
  if (roomTask.readiness === "complete") {
    return { status: "complete", room };
  }
  const genuinelyEmpty =
    !room &&
    ROOM_SETUP_MISSING_REASON_CODES.every((reasonCode) =>
      roomTask.reasonCodes.includes(reasonCode),
    );
  if (!genuinelyEmpty) {
    return {
      status: "needs_recovery",
      room,
      reasonCodes: roomTask.reasonCodes,
    };
  }
  return { status: "empty" };
}

export function buildRoomSetupRequest(propertyId: string, draft: RoomSetupDraft) {
  const currency = normalizeCurrency(draft.currency);
  const rate = positiveNumber(draft.nightlyRate, "Nightly rate").toFixed(2);
  const payload = {
    initialSetupOnly: true,
    name: requiredText(draft.name, "Room type name"),
    totalRooms: positiveInteger(draft.totalRooms, "Number of rooms"),
    maxOccupancy: positiveInteger(draft.maxOccupancy, "Maximum occupancy"),
    maxAdults: positiveInteger(draft.maxOccupancy, "Maximum occupancy"),
    maxChildren: 0,
    baseRate: rate,
    currency,
    isActive: true,
    operatingPeriods: [{ from: "01-01", to: "12-31" }],
    seasons: [
      {
        name: "Year-round",
        tier: "standard",
        from: "01-01",
        to: "12-31",
        rate,
        minStay: positiveInteger(draft.minimumStay, "Minimum stay"),
      },
    ],
  };
  const commandId = stableSetupCommandId("pms-room-type-create", propertyId, payload);
  return { ...payload, commandId, idempotencyKey: commandId };
}

export function buildPaymentSettingsRequest(
  propertyId: string,
  method: PaymentMethodChoice,
  currencyInput: string,
) {
  const currency = normalizeCurrency(currencyInput);
  const paymentSettings =
    method === "stripe"
      ? {
          paymentsEnabled: true,
          paymentProvider: "stripe",
          acceptedMethods: ["card"],
          defaultCurrency: currency,
          supportedCurrencies: [currency],
          requiresManualReview: false,
        }
      : method === "bank_transfer"
        ? {
            paymentsEnabled: true,
            paymentProvider: "bank_transfer",
            acceptedMethods: ["bank_transfer"],
            defaultCurrency: currency,
            supportedCurrencies: [currency],
            requiresManualReview: false,
          }
        : {
            paymentsEnabled: true,
            paymentProvider: "manual",
            acceptedMethods: ["pay_at_property"],
            defaultCurrency: currency,
            supportedCurrencies: [currency],
            requiresManualReview: false,
          };
  const commandId = stableSetupCommandId("finance-payment-settings", propertyId, paymentSettings);
  return { commandId, idempotencyKey: commandId, paymentSettings };
}

export function stableSetupCommandId(prefix: string, propertyId: string, payload: unknown): string {
  const source = `${propertyId}:${stableJson(payload)}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}:${propertyId}:${(hash >>> 0).toString(16).padStart(8, "0")}:v1`;
}

export function isStripeReady(settings: FinancePaymentSettings): boolean {
  return (
    settings.paymentsEnabled &&
    settings.acceptedMethods.includes("card") &&
    settings.providerAccount.status === "active" &&
    settings.providerAccount.onboardingStatus === "completed" &&
    settings.providerAccount.chargesEnabled
  );
}

export function isPublicationReady(publication: PublicBookabilityPublication): boolean {
  return (
    publication.profileStatus === "public" &&
    publication.freshnessStatus === "fresh" &&
    publication.missingReadiness.length === 0
  );
}

export function hotelOperationsErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiErrorResponse) {
    const detail = error.data.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (typeof error.data.message === "string" && error.data.message.trim()) {
      return error.data.message;
    }
  }
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function encoded(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Property id is required.");
  return encodeURIComponent(normalized);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be at least one.`);
  }
  return value;
}

function normalizeCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new Error("Currency must be a three-letter ISO code.");
  }
  return normalized;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
