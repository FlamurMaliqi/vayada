import type { BookingPublicationOperation } from "@vayada/domain-booking";
import {
  readBankTransferDestination,
  saveBankTransferDestination,
  type SavedBankTransferDestination,
  type BankTransferSaveAttempt,
} from "@vayada/product-onboarding/bankTransferDestination";
import { createHotelCatalogStep1MediaAssignments } from "@vayada/domain-hotels";

import { ApiErrorResponse } from "./client";
import { sharedHotelSetupApi } from "./sharedHotelSetupClient";
import { hotelPresentationClient } from "./hotelPresentationClient";
import { targetApiClient } from "./targetClient";

export type RoomSetupDraft = {
  name: string;
  totalRooms: number;
  maxOccupancy: number;
  nightlyRate: number;
  currency: string;
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
  termsAndConditions: string;
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

export type PaymentMethodChoice = "online_card" | "pay_at_property" | "bank_transfer" | "paypal";
export type OnlinePaymentProvider = "stripe" | "xendit" | "vayada";
export type PayAtHotelMethod = "cash" | "card";

export type PaymentSetupDraft = {
  bankDestination?: SavedBankTransferDestination | null;
  methods: PaymentMethodChoice[];
  onlineProvider: OnlinePaymentProvider;
  payAtHotelMethods: PayAtHotelMethod[];
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  bicSwift: string;
  paypalEmail: string;
};

export type FinancePaymentSettings = {
  bankDestination?: SavedBankTransferDestination | null;
  paymentsEnabled: boolean;
  paymentProvider: "stripe" | "xendit" | "vayada" | "manual" | "bank_transfer";
  acceptedMethods: string[];
  defaultCurrency: string;
  supportedCurrencies: string[];
  depositPolicy: Record<string, string | number | boolean | null>;
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

export type FinancePlanStatus = {
  plan: "commission" | "fixed";
  status: "commission" | "checkout_pending" | "active" | "past_due" | "cancel_at_period_end";
  currency: "EUR";
  activeRoomCount: number;
  amountMinor: number;
  checkoutPending: boolean;
  updatedAt: string;
};

type FinancePlanStatusResponse = { planStatus: FinancePlanStatus };

export type DirectBookingSetup = {
  profileRevision: number;
  propertyName: string;
  heroImageUrl: string;
  heroHeading: string;
  heroSubtext: string;
  defaultHeroSubtext: string;
  primaryColor: string;
  fontPairing: string;
  defaultCurrency: string;
  defaultLanguage: string;
};

export type PublicBookabilityPublication =
  | BookingPublicationOperation
  | {
      propertyId: string;
      canonicalSlug: string;
      canonicalUrl: string;
      bookingBaseUrl: string;
      profileStatus: "public" | "incomplete" | "unpublished" | "stale" | "unavailable";
      freshnessStatus: "fresh" | "stale" | "unavailable" | "unknown";
      missingReadiness: string[];
    };

export const DIRECT_BOOKING_SUBTEXT_MAX_LENGTH = 200;

type BookingPropertySettingsResponse = {
  property_name?: unknown;
  check_in_time?: unknown;
  check_out_time?: unknown;
  terms_text?: unknown;
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

type StripeProviderAccountReconciliationResponse = {
  propertyId: string;
  providerAccount: {
    ready: boolean;
  };
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

  addRoomSetup: async (propertyId: string, draft: RoomSetupDraft): Promise<void> => {
    const body = buildRoomSetupRequest(propertyId, draft, false);
    await targetApiClient.post(`/api/pms/properties/${encoded(propertyId)}/room-types`, body);
  },

  getGuestSettingsPolicies: async (
    propertyId: string,
    signal?: AbortSignal,
    seedDefaultTerms = false,
  ): Promise<GuestSettingsPolicies> => {
    const response = await targetApiClient.get<BookingPropertySettingsResponse>(
      `/api/booking/hotels/${encoded(propertyId)}/settings/property`,
      signal ? { signal } : undefined,
    );
    return {
      checkInTime: stringValue(response.check_in_time, "15:00"),
      checkOutTime: stringValue(response.check_out_time, "11:00"),
      termsAndConditions:
        stringValue(response.terms_text) || (seedDefaultTerms ? defaultTermsAndConditions() : ""),
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
      terms_text: settings.termsAndConditions.trim(),
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
    const bankDestination = await readBankTransferDestination(targetApiClient, propertyId);
    return { ...response.paymentSettings, bankDestination };
  },

  getPlanStatus: async (propertyId: string, signal?: AbortSignal): Promise<FinancePlanStatus> => {
    const response = await targetApiClient.get<FinancePlanStatusResponse>(
      `/api/finance/properties/${encoded(propertyId)}/plan-status`,
      signal ? { signal } : undefined,
    );
    return response.planStatus;
  },

  selectCommissionPlan: async (
    propertyId: string,
    intentRevision = "initial",
  ): Promise<FinancePlanStatus> => {
    const commandId = stableSetupCommandId("finance-plan-commission", propertyId, {
      plan: "commission",
      intentRevision,
    });
    const response = await targetApiClient.post<FinancePlanStatusResponse>(
      `/api/finance/properties/${encoded(propertyId)}/select-commission`,
      { commandId, idempotencyKey: commandId },
    );
    return response.planStatus;
  },

  startFixedPlanCheckout: async (
    propertyId: string,
    intentRevision = "initial",
  ): Promise<{ checkoutUrl: string; amountMinor: number; activeRoomCount: number }> => {
    const commandId = stableSetupCommandId("finance-plan-fixed", propertyId, {
      plan: "fixed",
      intentRevision,
    });
    const response = await targetApiClient.post<{
      checkout: { checkoutUrl: string; amountMinor: number; activeRoomCount: number };
    }>(`/api/finance/properties/${encoded(propertyId)}/fixed-plan/checkout`, {
      commandId,
      idempotencyKey: commandId,
    });
    return response.checkout;
  },

  updatePaymentSettings: async (
    propertyId: string,
    draft: PaymentSetupDraft,
    canonicalCurrency: string,
    intentRevision: string,
    bankAttempt: BankTransferSaveAttempt,
    onDestinationSaved: (destination: SavedBankTransferDestination | null) => void,
  ): Promise<FinancePaymentSettings> => {
    const body = buildPaymentSettingsRequest(propertyId, draft, canonicalCurrency, intentRevision);
    const bankDestination = await saveBankTransferDestination(targetApiClient, {
      propertyId,
      enabled: draft.methods.includes("bank_transfer"),
      saved: draft.bankDestination,
      attempt: bankAttempt,
      details: {
        bankName: draft.bankName,
        accountHolder: draft.accountHolder,
        accountNumber: draft.accountNumber,
        accountType: /^[A-Za-z]{2}\d{2}/.test(draft.accountNumber) ? "iban" : "account_number",
        bicSwift: draft.bicSwift,
        instructions: "",
      },
    });
    onDestinationSaved(bankDestination ?? null);
    const response = await targetApiClient.patch<FinancePaymentSettingsResponse>(
      `/api/finance/properties/${encoded(propertyId)}/payment-settings`,
      body,
    );
    return { ...response.paymentSettings, bankDestination };
  },

  startStripeOnboarding: async (
    propertyId: string,
    input: {
      email: string;
      country: string;
      providerAccountId?: string | null;
      linkAttemptId?: string;
    },
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
        ? {
            providerAccountId: input.providerAccountId,
            linkAttemptId: input.linkAttemptId ?? "initial",
          }
        : { email: input.email.trim().toLowerCase(), country: input.country.trim().toUpperCase() },
    );
    return targetApiClient.post<StripeProviderAccountResponse>(
      endpoint,
      input.providerAccountId
        ? { commandId, idempotencyKey: commandId, returnSurface: "marketplace" }
        : {
            commandId,
            idempotencyKey: commandId,
            email: input.email.trim().toLowerCase(),
            country: input.country.trim().toUpperCase(),
            returnSurface: "marketplace",
          },
    );
  },

  reconcileStripeProviderAccount: async (
    propertyId: string,
    commandId: string,
    signal?: AbortSignal,
  ): Promise<StripeProviderAccountReconciliationResponse> =>
    targetApiClient.post<StripeProviderAccountReconciliationResponse>(
      `/api/finance/properties/${encoded(propertyId)}/provider-accounts/stripe/reconcile`,
      { commandId, idempotencyKey: commandId },
      signal ? { signal } : undefined,
    ),

  getDirectBookingSetup: async (
    propertyId: string,
    signal?: AbortSignal,
  ): Promise<DirectBookingSetup> => {
    const options = signal ? { signal } : undefined;
    const [canonical, publicProfile, design, launchSettings] = await Promise.all([
      sharedHotelSetupApi.getPropertyProfile(propertyId, options),
      sharedHotelSetupApi.getPublicPropertyProfile(propertyId, options),
      targetApiClient.get<BookingDesignSettingsResponse>(
        `/api/booking/hotels/${encoded(propertyId)}/settings/design`,
        options,
      ),
      hotelOperationsSetupApi.getPropertyLaunchSettings(propertyId, signal),
    ]);
    const hero = publicProfile.publicProfile.media.find(
      ({ mediaType }) => mediaType === "hero_image",
    );
    const pendingHeroImage = pendingDirectBookingHero(propertyId);
    if (pendingHeroImage && pendingHeroImage !== hero?.url) {
      clearPendingDirectBookingHero(propertyId);
    }
    const propertyName = canonical.profile.displayName;
    const defaultHeroSubtext = defaultDirectBookingSubtext(propertyName);
    return {
      profileRevision: canonical.profileRevision,
      propertyName,
      heroImageUrl:
        (pendingHeroImage === hero?.url ? pendingHeroImage : null) ??
        design.heroImage ??
        hero?.url ??
        "",
      heroHeading: design.heroHeading || propertyName,
      heroSubtext: design.heroSubtext || defaultHeroSubtext,
      defaultHeroSubtext,
      primaryColor: design.primaryColor || "#2946E8",
      fontPairing: design.fontPairing || "modern-minimalist",
      defaultCurrency: launchSettings.defaultCurrency,
      defaultLanguage: launchSettings.defaultLanguage,
    };
  },

  uploadDirectBookingHero: async (
    propertyId: string,
    heroImage: File,
    expectedProfileRevision: number,
  ): Promise<string> => {
    const [uploaded] = await hotelPresentationClient.upload(
      propertyId,
      [heroImage],
      "property.hero_image",
    );
    if (!uploaded) throw new Error("The hotel image could not be uploaded.");
    const presentation = await hotelPresentationClient.load(propertyId);
    const galleryAssignments = createHotelCatalogStep1MediaAssignments(
      presentation.profile.media,
      presentation.displayName,
    )
      .filter(({ role }) => role === "gallery")
      .map((assignment, index) => ({ ...assignment, sortOrder: index + 1 }));
    await sharedHotelSetupApi.replacePropertyPresentationMedia(
      propertyId,
      {
        expectedProfileRevision,
        assignments: [
          {
            mediaObjectId: uploaded.mediaObjectId,
            role: "cover",
            altText: null,
            sortOrder: 0,
          },
          ...galleryAssignments,
        ],
      },
      `booking.direct-hero.assign:${propertyId}:revision:${expectedProfileRevision}:media:${uploaded.mediaObjectId}`,
    );
    const publicProfile = await sharedHotelSetupApi.getPublicPropertyProfile(propertyId);
    const publishedHero = publicProfile.publicProfile.media.find(
      ({ mediaObjectId, mediaType }) =>
        mediaType === "hero_image" && mediaObjectId === uploaded.mediaObjectId,
    );
    if (!publishedHero) throw new Error("The hotel image could not be published.");
    rememberPendingDirectBookingHero(propertyId, publishedHero.url);
    return publishedHero.url;
  },

  saveDirectBookingSetup: async (
    propertyId: string,
    input: SaveDirectBookingSetupInput,
  ): Promise<void> => {
    await targetApiClient.patch(`/api/booking/hotels/${encoded(propertyId)}/settings/design`, {
      heroImage: input.heroImageUrl || undefined,
      heroHeading: input.heroHeading.trim(),
      heroSubtext: input.heroSubtext.trim(),
      primaryColor: input.primaryColor,
      fontPairing: input.fontPairing,
    });
    clearPendingDirectBookingHero(propertyId);
  },

  getDirectBookingPublication: async (
    propertyId: string,
    operationId: string,
  ): Promise<BookingPublicationOperation> =>
    targetApiClient.get(
      `/api/hotel-setup/properties/${encoded(propertyId)}/publications/booking/${encoded(operationId)}`,
    ),

  publishDirectBooking: async (propertyId: string): Promise<PublicBookabilityPublication> =>
    targetApiClient.post<PublicBookabilityPublication>(
      `/api/booking/hotels/${encoded(propertyId)}/public-bookability`,
    ),
};

export function defaultDirectBookingSubtext(propertyName: string): string {
  const prefix = "Book direct for a memorable stay at ";
  const name = propertyName.trim() || "your property";
  return `${prefix}${name.slice(0, DIRECT_BOOKING_SUBTEXT_MAX_LENGTH - prefix.length - 1).trimEnd()}.`;
}

export function directBookingSubtextError(value: string): string | null {
  if (!value.trim()) return "Add a booking page subtext before publishing.";
  return value.length > DIRECT_BOOKING_SUBTEXT_MAX_LENGTH
    ? `Keep the booking page subtext within ${DIRECT_BOOKING_SUBTEXT_MAX_LENGTH} characters.`
    : null;
}

const pendingDirectBookingHeroKey = (propertyId: string) =>
  `vayada:setup:direct-booking-hero:${propertyId}`;

function pendingDirectBookingHero(propertyId: string): string | null {
  try {
    const value = browserStorage()?.getItem(pendingDirectBookingHeroKey(propertyId))?.trim();
    return value && new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function rememberPendingDirectBookingHero(propertyId: string, url: string): void {
  try {
    browserStorage()?.setItem(pendingDirectBookingHeroKey(propertyId), url);
  } catch {
    // Persistence is a reload recovery aid; the in-memory retry path remains available.
  }
}

function clearPendingDirectBookingHero(propertyId: string): void {
  try {
    browserStorage()?.removeItem(pendingDirectBookingHeroKey(propertyId));
  } catch {
    // A stale recovery hint is harmless and will be cleared after a later successful save.
  }
}

function browserStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function defaultTermsAndConditions(): string {
  return `These Terms & Conditions govern your booking made through the vayada platform ("vayada"). By completing this booking, you ("Guest") enter into a direct agreement with us for our accommodation services. vayada acts solely as an intermediary platform that facilitates bookings and payment processing between you and us. vayada is not a party to the accommodation agreement and is not the provider of our accommodation services.

1. Booking Confirmation
Your booking is confirmed immediately upon submission and successful payment. You will receive a confirmation email with your booking details shortly after completing checkout. Your card will be charged the full booking amount shown at checkout.`;
}

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

export function buildRoomSetupRequest(
  propertyId: string,
  draft: RoomSetupDraft,
  initialSetupOnly = true,
) {
  const currency = normalizeCurrency(draft.currency);
  const rate = positiveNumber(draft.nightlyRate, "Nightly rate").toFixed(2);
  const payload = {
    onboardingSetup: true,
    initialSetupOnly,
    name: requiredText(draft.name, "Room type name"),
    totalRooms: positiveInteger(draft.totalRooms, "Number of rooms"),
    maxOccupancy: positiveInteger(draft.maxOccupancy, "Maximum occupancy"),
    maxAdults: positiveInteger(draft.maxOccupancy, "Maximum occupancy"),
    maxChildren: 0,
    bathroomType: "private",
    bathrooms: 1,
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
        minStay: 1,
      },
    ],
  };
  const commandId = stableSetupCommandId("pms-room-type-create", propertyId, payload);
  return { ...payload, commandId, idempotencyKey: commandId };
}

export function buildPaymentSettingsRequest(
  propertyId: string,
  draft: PaymentSetupDraft,
  canonicalCurrency = "EUR",
  intentRevision = "initial",
) {
  if (draft.methods.length === 0) {
    throw new Error("Select at least one payment method so guests can complete bookings.");
  }
  const selected = new Set(draft.methods);
  if (selected.has("pay_at_property") && draft.payAtHotelMethods.length === 0) {
    throw new Error("Choose cash, card, or both for Pay at Hotel.");
  }
  const acceptedMethods: string[] = [];
  if (selected.has("online_card")) {
    acceptedMethods.push(draft.onlineProvider === "xendit" ? "xendit" : "card");
  }
  if (selected.has("pay_at_property")) {
    acceptedMethods.push("pay_at_property");
    if (draft.payAtHotelMethods.includes("cash")) acceptedMethods.push("cash");
    if (draft.payAtHotelMethods.includes("card")) acceptedMethods.push("manual_card");
  }
  if (selected.has("bank_transfer")) acceptedMethods.push("bank_transfer");
  if (selected.has("paypal")) acceptedMethods.push("paypal");

  const paymentProvider = selected.has("online_card")
    ? draft.onlineProvider
    : selected.has("bank_transfer")
      ? "bank_transfer"
      : "manual";
  const paypalEmail = selected.has("paypal")
    ? requiredEmail(draft.paypalEmail, "PayPal email")
    : "";
  const paymentSettings = {
    paymentsEnabled: true,
    ...(selected.has("online_card") ? { paymentProvider } : {}),
    acceptedMethods,
    depositPolicy: {
      paypalEmail,
      paypalPaymentWindowHours: 24,
    },
    requiresManualReview: false,
  };
  const commandId = stableSetupCommandId("finance-payment-settings", propertyId, {
    canonicalCurrency,
    paymentSettings,
    intentRevision,
  });
  return { commandId, idempotencyKey: commandId, paymentSettings };
}

function requiredEmail(value: string, label: string): string {
  const normalized = requiredText(value, label).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`${label} must be a valid email address.`);
  }
  return normalized;
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
  if ("status" in publication) return publication.status === "succeeded";
  return (
    publication.profileStatus === "public" &&
    publication.freshnessStatus === "fresh" &&
    publication.missingReadiness.length === 0
  );
}

export function hotelOperationsErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiErrorResponse) {
    if (error.data.code === "invalid_body" || error.data.category === "validation") return fallback;
    const detail = error.data.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (typeof error.data.message === "string" && error.data.message.trim()) {
      return error.data.message;
    }
  }
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function hotelOperationsWriteMayHaveCommitted(error: unknown): boolean {
  return !(error instanceof ApiErrorResponse) || error.status >= 500;
}

export function isPropertyCurrencyConflict(error: unknown): boolean {
  return (
    error instanceof ApiErrorResponse &&
    error.status === 409 &&
    error.data.code === "property_currency_conflict"
  );
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
