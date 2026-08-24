import {
  createFakeVerifier,
  requireAuthContext,
  type ProductEntitlement,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  BookingAdditionalGuestCreateCommand,
  BookingAdditionalGuestDeleteCommand,
  BookingAdditionalGuestUpdateCommand,
  BookingGuestPii,
  BookingGuestPiiCommandMeta,
  BookingGuestPiiPort,
  BookingGuestPiiProjection,
  BookingPrimaryGuestNationalityCorrectionCommand,
  BookingReservationReadModel,
} from "@vayada/domain-booking";
import {
  findForbiddenPublicBookabilityKeys,
  type PmsInventoryPublicOfferProjectionPort,
  type PublicBookabilityPublicationCommandPort,
} from "@vayada/domain-distribution";
import { PUBLIC_BOOKABILITY_FIXTURES } from "@vayada/domain-distribution/fixtures";
import {
  setupIncompletePaymentSettings,
  type CancellationPolicy,
  type FinancePropertyReadRepository,
} from "@vayada/domain-finance";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { QueryResult, QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTargetPublicHotelQuoteRepository,
  serializePublicHotelQuoteProjection,
  toUnavailablePublicHotelQuoteProjection,
  type PublicHotelQuoteReadPool,
  type PublicHotelQuoteRepository,
} from "./routes/aiHotelQuotes.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { PropertyPlanReadRepository } from "./domains/propertyPlanReadModel.js";
import { pmsRoomOrderVersion } from "./domains/pmsRoomOrder.js";
import {
  createTargetPublicHotelProfileRepository,
  serializePublicHotelProfileProjection,
  toPublicHotelProfileProjection,
  type PublicHotelProfileReadPool,
  type PublicHotelProfileRepository,
} from "./routes/aiHotels.js";
import {
  BookingContactPublicationConflictError,
  createPgTargetBookingSettingsRepository,
  type BookingSettingsPool,
  type BookingSettingsReadRepository,
  type BookingSettingsWriteRepository,
} from "./routes/bookingSettings.js";
import type {
  BookingAddonItem,
  BookingAddonItemsPool,
  BookingAddonItemsRepository,
  CreateBookingAddonItemBody,
  UpdateBookingAddonItemBody,
} from "./routes/bookingAddonItems.js";
import { createPgTargetBookingAddonItemsRepository } from "./routes/bookingAddonItems.js";
import type {
  BookingPromoCode,
  BookingPromoCodesPool,
  BookingPromoCodesRepository,
  CreateBookingPromoCodeBody,
  UpdateBookingPromoCodeBody,
} from "./routes/bookingPromoCodes.js";
import { createPgTargetBookingPromoCodesRepository } from "./routes/bookingPromoCodes.js";
import {
  createTargetBookingCustomDomainRepository,
  type BookingCustomDomainPool,
  type BookingCustomDomainRepository,
} from "./routes/bookingCustomDomain.js";
import {
  createTargetBookingWebCalendarRepository,
  type BookingWebCalendarReadPool,
  type BookingHotelChangeRequestRepository,
} from "./routes/bookingWebPublic.js";
import { unusedBookingWebCheckoutAdapter } from "./routes/bookingWebPublic.fixtures.js";
import type {
  PlatformAdminDashboardRepository,
  PlatformAdminGrowthDashboard,
} from "./routes/platform/admin/dashboard/bookingCompatible.js";
import {
  createTargetPmsOperationsReadRepository,
  type PmsOperationsReadPool,
} from "./domains/pmsOperationsReadModel.js";
import type { BookingAcceptanceSettingsPort } from "./domains/bookingAcceptanceSettings.js";
import type { PmsRoomAssignmentSettingsPort } from "./domains/pmsRoomAssignmentSettings.js";
import type { PmsRoomAssignmentOptimizationHistoryPort } from "./domains/pmsRoomAssignmentOptimizationHistory.js";
import {
  type BookingReservationListFilters,
  type BookingReservationsReadRepository,
} from "./routes/bookingReservations.js";
import {
  toBookingReservationReadModel,
  type BookingReservationReadModelRow,
} from "./platform/bookingReservationReadModel.js";
import type {
  PmsAssignmentCommand,
  PmsAssignmentCommandResult,
  PmsBookingLifecycleCommand,
  PmsCheckInCommand,
  PmsNoShowCommand,
  PmsOperationalCommandResult,
  PmsOperationalStatusCommand,
  PmsCheckOutCommand,
  PmsCheckOutCommandResponse,
  PmsCheckOutCommandResult,
  PmsCheckOutRecord,
  PmsCheckoutCharge,
  PmsCheckoutChargeCommandResponse,
  PmsCheckoutChargeCreateCommand,
  PmsCheckoutChargeMarkPaidCommand,
  PmsCheckoutChargeWaiveCommand,
  PmsCommandMeta,
  PmsOperationalTemplate,
  PmsOperationalTemplateCommandResponse,
  PmsOperationalTemplateKind,
  PmsOperationalTemplateResponse,
  PmsOperationalTemplateUpdateCommand,
  PmsOperationsCommandResponse,
  PmsOperationsCommandRepository,
  PmsCalendarDay,
  PmsOperationalReservation,
  PmsPrivateNote,
  PmsPrivateNoteCommandResponse,
  PmsPrivateNoteCreateCommand,
  PmsPrivateNoteDeleteCommand,
  PmsPrivateNoteDeleteResponse,
  PmsPrivateNoteUpdateCommand,
  PmsOperationsReadRepository,
  PmsRoom,
  PmsRoomBlockCreateCommand,
  PmsRoomBlockSummary,
  PmsRoomOrderCommand,
  PmsRoomType,
  PmsRoomTypeCommandResponse,
  PmsRoomTypeCreateCommand,
  PmsRoomTypeUpdateCommand,
} from "./routes/pmsOperations.js";
import { createTargetBookingReservationsReadRepository } from "./platform/bookingReservations.js";

type BookingReservationsReadPool = NonNullable<
  Parameters<typeof createTargetBookingReservationsReadRepository>[0]["pool"]
>;

type PmsOperationsTestListResponse<T> = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  items: T[];
  orderVersion?: string;
};

type PmsOperationsTestPrivateNotesResponse = PmsOperationsTestListResponse<PmsPrivateNote> & {
  guestBookingId: string;
};

type PmsOperationsTestDetailResponse<T> = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  item: T;
};

type PmsOperationsTestCalendarResponse = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  days: PmsCalendarDay[];
};

type PmsOperationsTestReservationListResponse = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  items: PmsOperationalReservation[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
};

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const pmsOperationsContractCases = JSON.parse(
  readFileSync(
    new URL(
      "../../../engineering/fixtures/pms-operations-route-contracts/cases.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  cases: Array<{
    caseId: string;
    skip?: boolean;
    skipReason?: string;
    request: {
      path: string;
      method?: "GET" | "PATCH" | "POST" | "DELETE";
      query?: Record<string, string | number>;
      body?: Record<string, unknown>;
    };
    expected: {
      status?: number;
      itemCount?: number;
      dayCount?: number;
      mustInclude?: string[];
      mustExclude?: string[];
      denials?: Array<{ condition: string; status: number; errorCode: string }>;
      errorCode?: string;
      message?: string;
      sideEffects?: string[];
      mustCall?: string[];
      mustNotCall?: string[];
      mustNotWrite?: string[];
      commandMeta?: {
        contractVersion?: string;
        sideEffects?: string[];
        replayed?: boolean;
      };
      publicPayloadMustExclude?: string[];
    };
  }>;
};

const financeRouteContractCases = JSON.parse(
  readFileSync(
    new URL("../../../engineering/fixtures/finance-route-contracts/cases.json", import.meta.url),
    "utf8",
  ),
) as {
  cases: Array<{
    caseId: string;
    input?: {
      eventType: string;
      payload: {
        propertyId: string;
        guestBookingId: string;
        checkoutChargeId: string;
        amount: string;
        currency: string;
        paymentMethod: string;
        reference?: string;
        pmsCommandId: string;
      };
    };
    request?: {
      path: string;
      method: string;
      body: {
        commandId: string;
        idempotencyKey: string;
        amount: string;
        currency: string;
        paymentMethod: string;
      };
      simulate?: {
        financeBridgeEnabled?: boolean;
        rehearsalFreeze?: boolean;
      };
    };
    expected: {
      status?: number;
      errorCode?: string;
      financeCommandType?: string;
      financePaymentStatus?: string;
      idempotencyKey?: string;
      sideEffects?: string[];
      mustNotWrite?: string[];
      mustNotCall?: string[];
    };
  }>;
};

function pmsOperationsRequestOptions(request: {
  path: string;
  query?: Record<string, string | number>;
}): { url: string; query?: Record<string, string> } {
  return {
    url: request.path,
    query: request.query
      ? Object.fromEntries(
          Object.entries(request.query).map(([key, value]) => [key, String(value)]),
        )
      : undefined,
  };
}

const pmsRoomTypesReadCase = pmsOperationsContractCases.cases.find(
  (testCase) => testCase.caseId === "rooms-room-types-read",
)!;
const pmsRoomsReadCase = pmsOperationsContractCases.cases.find(
  (testCase) => testCase.caseId === "rooms-read-statuses",
)!;
const pmsAuthorizationDenialCases = pmsOperationsContractCases.cases.filter((testCase) =>
  testCase.caseId.startsWith("authorization-denial-matrix-"),
);
const pmsCalendarBlocksReadCase = pmsOperationsContractCases.cases.find(
  (testCase) => testCase.caseId === "calendar-blocks-read",
)!;
const pmsCalendarRangeTooLargeCase = pmsOperationsContractCases.cases.find(
  (testCase) => testCase.caseId === "calendar-range-too-large",
)!;
const pmsCalendarReadModelUnavailableCase = pmsOperationsContractCases.cases.find(
  (testCase) => testCase.caseId === "calendar-read-model-unavailable",
)!;
const pmsRoomBlocksReadCase = pmsOperationsContractCases.cases.find(
  (testCase) => testCase.caseId === "room-blocks-read",
)!;
const pmsReservationsAssignedUnassignedCase = pmsOperationsContractCases.cases.find(
  (testCase) => testCase.caseId === "reservations-assigned-unassigned",
)!;
const checkoutChargeMarkPaidFreezeCase = financeRouteContractCases.cases.find(
  (testCase) => testCase.caseId === "checkout-charge-mark-paid-freeze",
)!;
const pmsAssignmentCommandCases = Object.fromEntries(
  [
    "assignment-command-assign",
    "assignment-command-move",
    "assignment-command-unassign",
    "assignment-command-swap",
    "assignment-command-conflict",
    "assignment-command-version-conflict",
    "assignment-command-assignment-conflict",
    "assignment-command-idempotency-replay",
  ].map((caseId) => [
    caseId,
    pmsOperationsContractCases.cases.find((testCase) => testCase.caseId === caseId)!,
  ]),
);
const pmsOperationalCommandCases = Object.fromEntries(
  [
    "checkin-command",
    "operational-status-transition",
    "operational-status-invalid-transition",
    "operational-status-version-conflict",
    "no-show-command",
    "no-show-version-conflict",
  ].map((caseId) => [
    caseId,
    pmsOperationsContractCases.cases.find((testCase) => testCase.caseId === caseId)!,
  ]),
);

const pmsPrivateNoteCases = Object.fromEntries(
  [
    "private-notes-excluded-from-public",
    "private-note-create",
    "private-note-delete",
    "private-note-not-found",
  ].map((caseId) => [
    caseId,
    pmsOperationsContractCases.cases.find((testCase) => testCase.caseId === caseId)!,
  ]),
);
const pmsOperationalTemplateCases = Object.fromEntries(
  [
    "checklist-template-read",
    "checklist-template-write",
    "inspection-template-read",
    "inspection-template-write",
    "template-validation-non-array",
    "template-validation-oversized",
    "template-validation-missing-label",
  ].map((caseId) => [
    caseId,
    pmsOperationsContractCases.cases.find((testCase) => testCase.caseId === caseId)!,
  ]),
);
const pmsCheckoutChargeCases = Object.fromEntries(
  ["checkout-charge-create-mark-paid-waive"].map((caseId) => [
    caseId,
    pmsOperationsContractCases.cases.find((testCase) => testCase.caseId === caseId)!,
  ]),
);
const pmsCheckOutCases = Object.fromEntries(
  ["checkout-charges-and-checkout", "checkout-version-conflict"].map((caseId) => [
    caseId,
    pmsOperationsContractCases.cases.find((testCase) => testCase.caseId === caseId)!,
  ]),
);
const pmsAdditionalGuestCases = Object.fromEntries(
  ["additional-guests-booking-pii-boundary"].map((caseId) => [
    caseId,
    pmsOperationsContractCases.cases.find((testCase) => testCase.caseId === caseId)!,
  ]),
);

const session: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: futureExpiry,
};

const bookingHeaderLogoMediaObjectId = "a1000000-0000-4000-8000-000000001218";

const identityRepository: IdentityRepository = {
  async findUserByProviderUserId() {
    return {
      userId: "user_hotel_owner",
      email: "owner@example.com",
      name: "Harper Owner",
      status: "active",
    };
  },
  async findOrganizationByWorkosOrgId() {
    return {
      organizationId: "org_hotel_group",
      workosOrgId: "org_workos_hotel_group",
      kind: "hotel_group",
      status: "active",
    };
  },
  async findActiveMembership() {
    return {
      membershipId: "membership_hotel_owner",
      status: "active",
      roleKey: "hotel_owner",
      workosMembershipId: "om_hotel_owner",
      workosRoleSlugs: ["hotel_owner"],
    };
  },
  async findLinkedResources() {
    return [
      {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: "booking_hotel_alpenrose",
        relationship: "owner",
        status: "active",
      },
    ];
  },
};

const platformSession: VerifiedSession = {
  workosUserId: "user_workos_platform",
  workosOrgId: "org_workos_platform",
  sessionId: "session_platform",
  expiresAt: futureExpiry,
};

const platformIdentityRepository: IdentityRepository = {
  async findUserByProviderUserId() {
    return {
      userId: "user_platform_admin",
      email: "platform@example.com",
      status: "active",
    };
  },
  async findOrganizationByWorkosOrgId() {
    return {
      organizationId: "org_platform",
      workosOrgId: "org_workos_platform",
      kind: "platform",
      status: "active",
    };
  },
  async findActiveMembership() {
    return {
      membershipId: "membership_platform_admin",
      status: "active",
      roleKey: "platform_admin",
      workosMembershipId: "om_platform_admin",
      workosRoleSlugs: ["platform_admin"],
    };
  },
  async findLinkedResources() {
    return [
      {
        product: "platform",
        resourceType: "platform",
        resourceId: "vayada",
        relationship: "operator",
        status: "active",
      },
    ];
  },
};

function buildPlatformAdminApp(
  options: {
    permissions?: PermissionKey[];
    repository?: PlatformAdminDashboardRepository;
    resourceAccess?: boolean;
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    platformAdminDashboardRepository: options.repository,
    auth: {
      verifier: createFakeVerifier(new Map([["platform-token", platformSession]])),
      repository:
        options.resourceAccess === false
          ? {
              ...platformIdentityRepository,
              async findLinkedResources() {
                return [];
              },
            }
          : platformIdentityRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["platform.admin.read"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return [];
        },
      },
    },
  });
}

const bookingSettingsRepository: BookingSettingsReadRepository = {
  async findPropertyLinkByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      propertyId: pmsPropertyId,
      pmsProperty: true,
      financeProperty: true,
    };
  },
  async findPropertySettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      id: "booking_hotel_alpenrose",
      slug: "hotel-alpenrose",
      propertyName: "Hotel Alpenrose",
      reservationEmail: "reservations@alpenrose.example",
      phoneNumber: "+43 1 2345",
      whatsappNumber: "+43 1 6789",
      address: "Alpenweg 1, Innsbruck",
      city: "Innsbruck",
      country: "AT",
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "https://youtube.com/@alpenrose",
      defaultCurrency: "CHF",
      defaultLanguage: "de",
      supportedCurrencies: ["CHF", "EUR"],
      supportedLanguages: ["de", "en"],
      checkInTime: "15:00",
      checkOutTime: "11:00",
      specialRequestsEnabled: false,
      arrivalTimeEnabled: true,
      guestCountEnabled: true,
      termsAndConditions: "Alpenrose booking terms.",
      cancellationPolicyText: "Free cancellation until seven days before arrival.",
      acceptedPaymentMethods: ["pay_at_property", "cash", "card", "bank_transfer"],
    };
  },
  async findAddonSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      showAddonsStep: false,
      groupAddonsByCategory: true,
    };
  },
  async findGuestFormSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      specialRequestsEnabled: false,
      arrivalTimeEnabled: true,
      guestCountEnabled: true,
      phoneRequired: false,
      adultAgeThreshold: 21,
      childrenEnabled: false,
    };
  },
  async findBenefitsSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      benefits: ["Free breakfast", "Late checkout"],
    };
  },
  async findLocalizationSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      defaultCurrency: "CHF",
      defaultLanguage: "de",
      supportedCurrencies: ["CHF", "EUR"],
      supportedLanguages: ["de", "en"],
    };
  },
  async findRoomFilterSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      bookingFilters: ["oceanView", "spa_access"],
      customFilters: {
        spa_access: "Spa access",
      },
      filterRooms: {
        oceanView: ["room_101", "room_102"],
        spa_access: ["room_102"],
      },
    };
  },
  async findDesignSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") return null;
    return {
      headerLogo: "https://cdn.vayada.example/alpenrose/header-logo.webp",
      headerLogoMediaObjectId: bookingHeaderLogoMediaObjectId,
      heroImage: "https://cdn.vayada.example/alpenrose/booking-hero.jpg",
      heroHeading: "Stay above the clouds",
      heroSubtext: "An independent alpine escape.",
      primaryColor: "#2563EB",
      fontPairing: "modern-minimalist",
    };
  },
  async findLastMinuteSettingsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") {
      return null;
    }

    return {
      lastMinuteDiscount: {
        enabled: true,
        stackWithPromo: false,
        tiers: [{ daysBeforeMin: 0, daysBeforeMax: 2, discountPercent: 30 }],
      },
      updatedAt: "2026-06-22T10:00:00.000Z",
    };
  },
};

const bookingSettingsWriteRepository: BookingSettingsWriteRepository = {
  async updatePropertySettingsByHotelId(hotelId, settings) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return {
      id: hotelId,
      slug: "hotel-alpenrose",
      propertyName: settings.propertyName ?? "Hotel Alpenrose",
      reservationEmail: settings.reservationEmail ?? "reservations@alpenrose.example",
      phoneNumber: settings.phoneNumber ?? "+43 1 2345",
      whatsappNumber: settings.whatsappNumber ?? "+43 1 6789",
      address: settings.address ?? "Alpenweg 1, Innsbruck",
      city: settings.city ?? "Innsbruck",
      country: settings.country ?? "AT",
      instagram: settings.instagram ?? "https://instagram.com/alpenrose",
      facebook: settings.facebook ?? "https://facebook.com/alpenrose",
      tiktok: settings.tiktok ?? "https://tiktok.com/@alpenrose",
      youtube: settings.youtube ?? "https://youtube.com/@alpenrose",
      defaultCurrency: settings.defaultCurrency ?? "CHF",
      defaultLanguage: settings.defaultLanguage ?? "de",
      supportedCurrencies: settings.supportedCurrencies ?? ["CHF", "EUR"],
      supportedLanguages: settings.supportedLanguages ?? ["de", "en"],
      checkInTime: settings.checkInTime ?? "15:00",
      checkOutTime: settings.checkOutTime ?? "11:00",
      specialRequestsEnabled: settings.specialRequestsEnabled ?? false,
      arrivalTimeEnabled: settings.arrivalTimeEnabled ?? true,
      guestCountEnabled: settings.guestCountEnabled ?? true,
      termsAndConditions: settings.termsAndConditions ?? "Alpenrose booking terms.",
      cancellationPolicyText:
        settings.cancellationPolicyText ?? "Free cancellation until seven days before arrival.",
      acceptedPaymentMethods: settings.acceptedPaymentMethods ?? [
        "pay_at_property",
        "cash",
        "card",
        "bank_transfer",
      ],
    };
  },
  async updateAddonSettingsByHotelId(hotelId, settings) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return settings;
  },
  async updateGuestFormSettingsByHotelId(hotelId, settings) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return settings;
  },
  async updateBenefitsSettingsByHotelId(hotelId, settings) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return settings;
  },
  async updateLocalizationSettingsByHotelId(hotelId, settings) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return settings;
  },
  async updateRoomFilterSettingsByHotelId(hotelId, settings) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return settings;
  },
  async updateDesignSettingsByHotelId(hotelId, settings, organizationId) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    expect(organizationId).toBe("org_hotel_group");
    return {
      headerLogo:
        settings.headerLogoMediaObjectId === null
          ? null
          : settings.headerLogoMediaObjectId
            ? "https://cdn.vayada.example/alpenrose/new-logo.webp"
            : "https://cdn.vayada.example/alpenrose/header-logo.webp",
      headerLogoMediaObjectId:
        settings.headerLogoMediaObjectId === undefined
          ? bookingHeaderLogoMediaObjectId
          : settings.headerLogoMediaObjectId,
      heroImage: settings.heroImage ?? "https://cdn.vayada.example/alpenrose/booking-hero.jpg",
      heroHeading: settings.heroHeading ?? "Stay above the clouds",
      heroSubtext: settings.heroSubtext ?? "An independent alpine escape.",
      primaryColor: settings.primaryColor ?? "#2563EB",
      fontPairing: settings.fontPairing ?? "modern-minimalist",
    };
  },
  async updateLastMinuteSettingsByHotelId(hotelId, settings) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return {
      lastMinuteDiscount: settings,
      updatedAt: "2026-06-22T10:00:00.000Z",
    };
  },
};

const bookingCustomDomainRepository: BookingCustomDomainRepository = {
  async findByBookingHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") return null;
    return {
      hotelId,
      propertyId: "f6853000-0000-0000-0000-000000000001",
      domain: "book.alpenrose.example",
      verificationStatus: "verified",
      verifiedAt: "2026-06-22T10:00:00.000Z",
      updatedAt: "2026-06-22T10:00:00.000Z",
    };
  },
  async upsertForBookingHotelId(hotelId, domain) {
    if (hotelId !== "booking_hotel_alpenrose") return null;
    return {
      hotelId,
      propertyId: "f6853000-0000-0000-0000-000000000001",
      domain,
      verificationStatus: "pending",
      verifiedAt: null,
      updatedAt: "2026-06-22T10:00:00.000Z",
    };
  },
  async deleteForBookingHotelId(hotelId) {
    return hotelId === "booking_hotel_alpenrose";
  },
};

const bookingAddonItem: BookingAddonItem = {
  addonItemId: "0f840001-0000-4000-8000-000000000001",
  hotelId: "booking_hotel_alpenrose",
  propertyId: "property_alpenrose",
  name: "Airport transfer",
  description: "Private pickup from the airport.",
  price: "45.00",
  currency: "EUR",
  category: "transport",
  imageUrl: null,
  duration: "45 min",
  pricingModel: "per_stay",
  publicVisible: true,
  status: "active",
  sortOrder: 0,
  ownershipKind: "property",
  partnerCommissionRate: null,
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-01T10:00:00.000Z",
};

const commissionPropertyPlan = {
  propertyId: "property_alpenrose",
  plan: "commission" as const,
  limits: {
    maxRoomPhotosPerType: 10,
    maxAddons: 3,
    guestContactAccess: "after_acceptance" as const,
  },
};

function addonItemFromBody(
  body: CreateBookingAddonItemBody | UpdateBookingAddonItemBody,
): BookingAddonItem {
  const ownershipKind = body.ownershipKind ?? bookingAddonItem.ownershipKind;
  const economicTerms =
    ownershipKind === "partner"
      ? {
          ownershipKind: "partner" as const,
          partnerCommissionRate:
            body.partnerCommissionRate ?? bookingAddonItem.partnerCommissionRate ?? "0",
        }
      : { ownershipKind: "property" as const, partnerCommissionRate: null };
  return {
    ...bookingAddonItem,
    addonItemId: "0f840001-0000-4000-8000-000000000002",
    name: body.name ?? bookingAddonItem.name,
    description: body.description ?? bookingAddonItem.description,
    price: body.price ?? bookingAddonItem.price,
    currency: body.currency ?? bookingAddonItem.currency,
    category: body.category ?? bookingAddonItem.category,
    imageUrl: body.imageUrl ?? bookingAddonItem.imageUrl,
    duration: body.duration ?? bookingAddonItem.duration,
    pricingModel: body.pricingModel ?? bookingAddonItem.pricingModel,
    publicVisible: body.publicVisible ?? bookingAddonItem.publicVisible,
    status: body.status ?? bookingAddonItem.status,
    sortOrder: body.sortOrder ?? bookingAddonItem.sortOrder,
    ...economicTerms,
    updatedAt: "2026-06-01T11:00:00.000Z",
  };
}

const bookingAddonItemsRepository: BookingAddonItemsRepository = {
  async listAddonItemsByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") return null;
    return { addonItems: [bookingAddonItem], propertyPlan: commissionPropertyPlan };
  },
  async createAddonItemByHotelId(hotelId, body) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return { outcome: "created", addonItem: addonItemFromBody(body) };
  },
  async updateAddonItemByHotelId(hotelId, addonItemId, body) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    if (addonItemId !== bookingAddonItem.addonItemId) return null;
    return {
      ...addonItemFromBody(body),
      addonItemId,
    };
  },
  async retireAddonItemByHotelId(hotelId, addonItemId) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return addonItemId === bookingAddonItem.addonItemId;
  },
};

const bookingPromoCode: BookingPromoCode = {
  promoCodeId: "0f850001-0000-4000-8000-000000000001",
  hotelId: "booking_hotel_alpenrose",
  propertyId: "property_alpenrose",
  code: "SUMMER20",
  discountType: "percentage",
  discountValue: "20.00",
  minBookingValue: "500.00",
  applicableRoomIds: ["0f850001-0000-4000-8000-000000000010"],
  validFrom: "2026-07-01",
  validUntil: "2026-08-31",
  stayDateFrom: "2026-08-01",
  stayDateUntil: "2026-09-30",
  isActive: true,
  maxUses: 50,
  currentUses: 3,
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-01T10:00:00.000Z",
};

function promoCodeFromBody(
  body: CreateBookingPromoCodeBody | UpdateBookingPromoCodeBody,
): BookingPromoCode {
  return {
    ...bookingPromoCode,
    promoCodeId: "0f850001-0000-4000-8000-000000000002",
    code: body.code ?? bookingPromoCode.code,
    discountType: body.discountType ?? bookingPromoCode.discountType,
    discountValue: body.discountValue ?? bookingPromoCode.discountValue,
    minBookingValue: body.minBookingValue ?? bookingPromoCode.minBookingValue,
    applicableRoomIds: body.applicableRoomIds ?? bookingPromoCode.applicableRoomIds,
    validFrom: body.validFrom ?? bookingPromoCode.validFrom,
    validUntil: body.validUntil ?? bookingPromoCode.validUntil,
    stayDateFrom: body.stayDateFrom ?? bookingPromoCode.stayDateFrom,
    stayDateUntil: body.stayDateUntil ?? bookingPromoCode.stayDateUntil,
    isActive: body.isActive ?? bookingPromoCode.isActive,
    maxUses: body.maxUses ?? bookingPromoCode.maxUses,
    updatedAt: "2026-06-01T11:00:00.000Z",
  };
}

const bookingPromoCodesRepository: BookingPromoCodesRepository = {
  async listPromoCodesByHotelId(hotelId) {
    if (hotelId !== "booking_hotel_alpenrose") return null;
    return [bookingPromoCode];
  },
  async createPromoCodeByHotelId(hotelId, body) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return promoCodeFromBody(body);
  },
  async updatePromoCodeByHotelId(hotelId, promoCodeId, body) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    if (promoCodeId !== bookingPromoCode.promoCodeId) return null;
    return {
      ...promoCodeFromBody(body),
      promoCodeId,
    };
  },
  async retirePromoCodeByHotelId(hotelId, promoCodeId) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    return promoCodeId === bookingPromoCode.promoCodeId;
  },
};

const reservation: BookingReservationReadModel = {
  id: "reservation_1",
  bookingReference: "VAY-2026-0001",
  roomTypeId: "room_type_suite",
  roomName: "Suite",
  roomMaxOccupancy: 2,
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.com",
  guestPhone: "+15555550123",
  guestCountry: "GB",
  guestGender: "",
  guestDateOfBirth: null,
  guestPassportNumber: "",
  specialRequests: "Late arrival",
  estimatedArrivalTime: "21:00",
  numberOfGuests: 2,
  checkIn: "2026-07-10",
  checkOut: "2026-07-12",
  nights: 2,
  adults: 2,
  children: 0,
  nightlyRate: 120.5,
  numberOfRooms: 2,
  totalRoomCapacity: 4,
  totalAmount: 241,
  currency: "EUR",
  status: "confirmed",
  roomId: "room_101",
  roomNumber: "101",
  assignedRooms: [
    { roomId: "room_101", roomNumber: "101", position: 0 },
    { roomId: "room_102", roomNumber: "102", position: 1 },
  ],
  channel: "direct",
  paymentMethod: "card",
  paymentStatus: "captured",
  depositRequired: false,
  depositPercentage: null,
  depositAmount: 0,
  balanceAmount: 241,
  checkInPendingFlags: [],
  checkedInAt: null,
  checkedOutAt: null,
  hostResponseDeadline: null,
  platformFeeAmount: null,
  affiliateCommissionAmount: null,
  propertyPayoutAmount: null,
  addonIds: ["addon_breakfast"],
  addonNames: ["Breakfast"],
  addonTotal: 30,
  addonQuantities: { addon_breakfast: 2 },
  addonDates: { addon_breakfast: ["2026-07-10"] },
  guestWithdrawn: false,
  promoCode: null,
  promoDiscount: 0,
  lastMinuteDiscountPercent: 0,
  lastMinuteDiscountAmount: 0,
  createdAt: "2026-06-01T12:00:00.000Z",
  updatedAt: "2026-06-02T12:00:00.000Z",
};

const bookingReservationsRepository: BookingReservationsReadRepository = {
  async listReservationsByHotelId(hotelId, filters) {
    expect(hotelId).toBe("booking_hotel_alpenrose");
    expect(filters).toEqual({
      status: undefined,
      search: undefined,
      limit: 50,
      offset: 0,
    });

    return {
      reservations: [reservation],
      total: 1,
    };
  },
};

const pmsPropertyId = "f6853000-0000-0000-0000-000000000001";

const financeCancellationPolicy: CancellationPolicy = {
  freeCancellationDays: 5,
  partialRefundPercent: 50,
  refundMethod: "original_payment",
  appliesTo: "direct_booking",
  updatedAt: "2026-06-12T10:00:00.000Z",
};

const financeRepository: FinancePropertyReadRepository = {
  async getPaymentSettings(requestedPropertyId) {
    expect(requestedPropertyId).toBe(pmsPropertyId);
    return setupIncompletePaymentSettings(requestedPropertyId, "2026-06-12T10:00:00.000Z", "CHF");
  },
  async getCancellationPolicy(requestedPropertyId) {
    expect(requestedPropertyId).toBe(pmsPropertyId);
    return financeCancellationPolicy;
  },
};

const pmsRoomTypes: PmsRoomType[] = [
  {
    roomTypeId: "f6855000-0000-0000-0000-000000000001",
    name: "Alpine Suite",
    description: "Suite with mountain view.",
    category: "suite",
    occupancyLimits: { adults: 2, children: 1, total: 3 },
    attributes: { view: "mountain", balcony: true },
    amenities: ["wifi", "breakfast"],
    media: [{ url: "https://cdn.vayada.example/alpine-suite.jpg", altText: "Alpine Suite" }],
    baseRate: { amountDecimal: "180.00", currency: "EUR" },
    active: true,
    sortOrder: 1,
    ratePlans: [
      {
        ratePlanId: "f6855200-0000-0000-0000-000000000001",
        code: "FLEX",
        name: "Flexible",
        rateType: "flexible",
        mealPlan: "breakfast",
        baseRate: { amountDecimal: "180.00", currency: "EUR" },
        active: true,
      },
    ],
    rateRulesSummary: {
      minStayNights: 2,
      maxStayNights: null,
      closedToArrival: false,
      closedToDeparture: false,
      activeRuleCount: 1,
    },
    roomCount: 2,
  },
  {
    roomTypeId: "f6855000-0000-0000-0000-000000000002",
    name: "Garden Room",
    description: "Quiet room facing the garden.",
    category: "double",
    occupancyLimits: { adults: 2, total: 2 },
    attributes: { view: "garden" },
    amenities: ["wifi"],
    media: [],
    baseRate: { amountDecimal: "120.00", currency: "EUR" },
    active: true,
    sortOrder: 2,
    ratePlans: [],
    rateRulesSummary: {
      minStayNights: null,
      maxStayNights: null,
      closedToArrival: false,
      closedToDeparture: false,
      activeRuleCount: 0,
    },
    roomCount: 1,
  },
];

const pmsRooms: PmsRoom[] = [
  {
    roomId: "f6855100-0000-0000-0000-000000000001",
    roomTypeId: pmsRoomTypes[0].roomTypeId,
    roomNumber: "101",
    floor: "1",
    status: "available",
    sortOrder: 1,
    metadata: { wing: "north" },
  },
  {
    roomId: "f6855100-0000-0000-0000-000000000002",
    roomTypeId: pmsRoomTypes[0].roomTypeId,
    roomNumber: "102",
    floor: "1",
    status: "maintenance",
    sortOrder: 2,
    metadata: {},
  },
  {
    roomId: "f6855100-0000-0000-0000-000000000003",
    roomTypeId: pmsRoomTypes[1].roomTypeId,
    roomNumber: "201",
    floor: "2",
    status: "out_of_order",
    sortOrder: 3,
    metadata: {},
  },
];

const pmsRoomBlocks: PmsRoomBlockSummary[] = [
  {
    blockId: "f6855400-0000-0000-0000-000000000001",
    version: "room-block-v1",
    roomTypeId: pmsRoomTypes[0].roomTypeId,
    roomId: pmsRooms[1].roomId,
    startsOn: "2026-08-15",
    endsOn: "2026-08-15",
    blockedCount: 1,
    reason: "Maintenance inspection",
    status: "active",
  },
  {
    blockId: "f6855400-0000-0000-0000-000000000002",
    version: "room-block-v1",
    roomTypeId: pmsRoomTypes[0].roomTypeId,
    roomId: null,
    startsOn: "2026-08-16",
    endsOn: "2026-08-16",
    blockedCount: 1,
    reason: "Soft refurbishment",
    status: "active",
  },
];

const pmsCalendarDays: PmsCalendarDay[] = [
  {
    stayDate: "2026-08-15",
    roomTypeId: pmsRoomTypes[0].roomTypeId,
    totalCount: 2,
    assignedCount: 1,
    occupiedCount: 1,
    blockedCount: 1,
    availableCount: 0,
    status: "limited",
    blocks: [pmsRoomBlocks[0]],
    assignmentRefs: ["f6855500-0000-0000-0000-000000000001"],
    sourceFreshness: { owner: "pms", status: "fresh" },
  },
  {
    stayDate: "2026-08-16",
    roomTypeId: pmsRoomTypes[0].roomTypeId,
    totalCount: 2,
    assignedCount: 1,
    occupiedCount: 1,
    blockedCount: 1,
    availableCount: 0,
    status: "limited",
    blocks: [pmsRoomBlocks[1]],
    assignmentRefs: ["f6855500-0000-0000-0000-000000000001"],
    sourceFreshness: { pms: { status: "fresh" } },
  },
  {
    stayDate: "2026-08-17",
    roomTypeId: pmsRoomTypes[1].roomTypeId,
    totalCount: 1,
    assignedCount: 0,
    occupiedCount: 0,
    blockedCount: 0,
    availableCount: 1,
    status: "open",
    blocks: [],
    assignmentRefs: [],
    sourceFreshness: { owner: "pms", status: "fresh" },
  },
];

const pmsReservations: PmsOperationalReservation[] = [
  {
    guestBookingId: "f6854000-0000-0000-0000-000000000001",
    bookingReference: "B-PMS-685",
    status: "checked_out",
    source: "channel",
    stay: { checkIn: "2026-08-15", checkOut: "2026-08-18", adults: 2, children: 0 },
    primaryGuest: {
      displayName: "Nora Ops",
      email: "nora.ops@example.test",
      phone: "+43111222333",
      countryCode: "AT",
      specialRequests: null,
    },
    addOns: [],
    assignments: [
      {
        assignmentId: "f6855500-0000-0000-0000-000000000001",
        roomTypeId: pmsRoomTypes[0].roomTypeId,
        ratePlanId: pmsRoomTypes[0].ratePlans[0].ratePlanId,
        roomId: pmsRooms[0].roomId,
        roomNumber: pmsRooms[0].roomNumber,
        position: 1,
        assignmentStatus: "assigned",
        channel: "booking_com",
        assignedAt: "2026-08-14T15:00:00.000Z",
      },
    ],
    checkin: { completedAt: "2026-08-15T15:35:00.000Z", pendingFlags: [] },
    checkout: { completedAt: "2026-08-18T10:15:00.000Z", pendingFlags: [] },
    privateNoteCount: 1,
    additionalGuestCount: 0,
  },
  {
    guestBookingId: "f6854000-0000-0000-0000-000000000002",
    bookingReference: "B-PMS-686",
    status: "confirmed",
    source: "direct_booking",
    stay: { checkIn: "2026-08-16", checkOut: "2026-08-17", adults: 1, children: 0 },
    primaryGuest: {
      displayName: "Una Assigned",
      email: "una@example.test",
      phone: null,
      countryCode: null,
      specialRequests: null,
    },
    addOns: [],
    assignments: [
      {
        assignmentId: "f6855500-0000-0000-0000-000000000002",
        roomTypeId: pmsRoomTypes[1].roomTypeId,
        ratePlanId: null,
        roomId: null,
        roomNumber: null,
        position: 1,
        assignmentStatus: "pending",
        channel: "direct",
        assignedAt: null,
      },
    ],
    checkin: { completedAt: null, pendingFlags: ["id_document"] },
    checkout: { completedAt: null, pendingFlags: [] },
    privateNoteCount: 0,
    additionalGuestCount: 0,
  },
];

const pmsPrivateNotes: PmsPrivateNote[] = [
  {
    noteId: "f6855900-0000-0000-0000-000000000001",
    body: "Guest asked not to mention the anniversary surprise at check-in.",
    authorUserId: "user_hotel_owner",
    authorDisplayName: "owner@example.com",
    createdAt: "2026-08-14T16:00:00.000Z",
    auditMetadata: {
      source: "pms",
      createdByUserId: "user_hotel_owner",
      createdByDisplayName: "owner@example.com",
      createdAt: "2026-08-14T16:00:00.000Z",
      editedByUserId: null,
      editedByDisplayName: null,
      editedAt: null,
      privacyScope: "internal",
    },
  },
];

const bookingPrimaryGuestPii: BookingGuestPii = {
  guestId: "f6855800-0000-0000-0000-000000000001",
  guestBookingId: pmsReservations[0].guestBookingId,
  role: "booker",
  displayName: "Nora Ops",
  firstName: "Nora",
  lastName: "Ops",
  email: "nora.ops@example.test",
  phone: "+43111222333",
  countryCode: "AT",
  countryCodeRaw: null,
  countryCodeReviewRequired: false,
  arrivalTime: "15:30",
  specialRequests: null,
};

function createBookingGuestPiiPort(): BookingGuestPiiPort & {
  creates: BookingAdditionalGuestCreateCommand[];
  updates: BookingAdditionalGuestUpdateCommand[];
  deletes: BookingAdditionalGuestDeleteCommand[];
  corrections: BookingPrimaryGuestNationalityCorrectionCommand[];
} {
  const guestsByReservation = new Map<string, BookingGuestPii[]>([
    [pmsReservations[0].guestBookingId, [bookingPrimaryGuestPii]],
    [pmsReservations[1].guestBookingId, []],
  ]);
  const creates: BookingAdditionalGuestCreateCommand[] = [];
  const updates: BookingAdditionalGuestUpdateCommand[] = [];
  const deletes: BookingAdditionalGuestDeleteCommand[] = [];
  const corrections: BookingPrimaryGuestNationalityCorrectionCommand[] = [];
  const projection = (
    propertyId: string,
    guestBookingId: string,
  ): BookingGuestPiiProjection | null => {
    const guests = guestsByReservation.get(guestBookingId);
    if (!guests) return null;
    return {
      propertyId,
      guestBookingId,
      primaryGuest: guests.find((guest) => guest.role !== "additional_guest") ?? null,
      additionalGuests: guests.filter((guest) => guest.role === "additional_guest"),
    };
  };
  const commandMeta = (
    command:
      | BookingAdditionalGuestCreateCommand
      | BookingAdditionalGuestUpdateCommand
      | BookingAdditionalGuestDeleteCommand
      | BookingPrimaryGuestNationalityCorrectionCommand,
  ): BookingGuestPiiCommandMeta => ({
    contractVersion: "booking-guest-pii.v1",
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt: "2026-08-14T17:10:00.000Z",
    sideEffects: ["audit_event"],
  });

  return {
    creates,
    updates,
    deletes,
    corrections,
    async listGuestPiiForPmsOperations(input) {
      expect(input.propertyId).toBe(pmsPropertyId);
      return projection(input.propertyId, input.guestBookingId);
    },
    async correctPrimaryGuestNationalityForPmsOperations(command) {
      corrections.push(command);
      const guests = guestsByReservation.get(command.guestBookingId);
      const primaryGuest = guests?.find((guest) => guest.role !== "additional_guest");
      if (guests && primaryGuest) {
        const corrected = {
          ...primaryGuest,
          countryCode: command.countryCode,
          countryCodeRaw: null,
          countryCodeReviewRequired: false,
        };
        guests.splice(guests.indexOf(primaryGuest), 1, corrected);
        return {
          ok: true,
          primaryGuest: corrected,
          projection: {
            ...projection(command.propertyId, command.guestBookingId)!,
            primaryGuest: {
              ...corrected,
              email: "Hidden until you accept",
              phone: "Hidden until you accept",
            },
          },
          commandMeta: commandMeta(command),
        };
      }
      return {
        ok: false,
        statusCode: 404,
        code: "primary_guest_not_found",
        message: "Primary guest not found.",
      };
    },
    async createAdditionalGuestForPmsOperations(command) {
      creates.push(command);
      const guests = guestsByReservation.get(command.guestBookingId);
      if (!guests) {
        return {
          ok: false,
          statusCode: 404,
          code: "reservation_not_found",
          message: "Booking reservation not found.",
        };
      }
      const additionalGuest: BookingGuestPii = {
        guestId: "f6855800-0000-0000-0000-000000000002",
        guestBookingId: command.guestBookingId,
        role: "additional_guest",
        displayName: `${command.guest.firstName} ${command.guest.lastName}`,
        firstName: command.guest.firstName,
        lastName: command.guest.lastName,
        email: command.guest.email ?? null,
        phone: command.guest.phone ?? null,
        countryCode: command.guest.countryCode ?? null,
        countryCodeRaw: null,
        countryCodeReviewRequired: false,
        arrivalTime: command.guest.arrivalTime ?? null,
        specialRequests: command.guest.specialRequests ?? null,
      };
      guests.push(additionalGuest);
      return {
        ok: true,
        additionalGuest,
        projection: projection(command.propertyId, command.guestBookingId)!,
        commandMeta: commandMeta(command),
      };
    },
    async updateAdditionalGuestForPmsOperations(command) {
      updates.push(command);
      return {
        ok: false,
        statusCode: 404,
        code: "additional_guest_not_found",
        message: "Additional guest not found.",
      };
    },
    async deleteAdditionalGuestForPmsOperations(command) {
      deletes.push(command);
      return {
        ok: true,
        guestId: command.guestId,
        projection: projection(command.propertyId, command.guestBookingId)!,
        commandMeta: commandMeta(command),
      };
    },
  };
}

const pmsOperationsRepository: PmsOperationsReadRepository = {
  async listRoomsByPropertyId(propertyId) {
    expect(propertyId).toBe(pmsPropertyId);
    return { items: pmsRooms, sourceFreshness: { owner: "pms", status: "fresh" } };
  },
  async listRoomTypesByPropertyId(propertyId) {
    expect(propertyId).toBe(pmsPropertyId);
    return { items: pmsRoomTypes, sourceFreshness: { owner: "pms", status: "fresh" } };
  },
  async findRoomTypeById(propertyId, roomTypeId) {
    expect(propertyId).toBe(pmsPropertyId);
    return pmsRoomTypes.find((roomType) => roomType.roomTypeId === roomTypeId) ?? null;
  },
  async listCalendarDaysByPropertyId(propertyId, range) {
    expect(propertyId).toBe(pmsPropertyId);
    expect(range).toEqual({ from: "2026-08-15", to: "2026-08-17" });
    return { items: pmsCalendarDays, sourceFreshness: { owner: "pms", status: "fresh" } };
  },
  async listRoomBlocksByPropertyId(propertyId, range) {
    expect(propertyId).toBe(pmsPropertyId);
    expect(range).toEqual({ from: "2026-08-15", to: "2026-08-21" });
    return { items: pmsRoomBlocks, sourceFreshness: { owner: "pms", status: "fresh" } };
  },
  async listReservationsByPropertyId(propertyId, filters) {
    expect(propertyId).toBe(pmsPropertyId);
    expect(filters).toEqual({
      status: undefined,
      arrivalFrom: undefined,
      arrivalTo: undefined,
      search: undefined,
      limit: 50,
      offset: 0,
    });
    return { items: pmsReservations, total: pmsReservations.length };
  },
  async findReservationByGuestBookingId(propertyId, guestBookingId) {
    expect(propertyId).toBe(pmsPropertyId);
    return (
      pmsReservations.find((reservation) => reservation.guestBookingId === guestBookingId) ?? null
    );
  },
};

function roomBlockCommandMeta(
  command: { commandId: string; idempotencyKey: string },
  acceptedAt: string,
): PmsCommandMeta {
  return {
    contractVersion: "pms-operations.v1" as const,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    acceptedAt,
    sideEffects: ["calendar_refresh", "ari_changed", "audit_event"],
  };
}

function createPmsOperationsCommandRepository(
  roomTypes: PmsRoomType[] = structuredClone(pmsRoomTypes),
): PmsOperationsCommandRepository & {
  commands: Array<
    | PmsAssignmentCommand
    | PmsOperationalStatusCommand
    | PmsCheckInCommand
    | PmsNoShowCommand
    | PmsBookingLifecycleCommand
    | PmsCheckOutCommand
  >;
  checkOutCommands: PmsCheckOutCommand[];
  checkoutChargeCreates: PmsCheckoutChargeCreateCommand[];
  checkoutChargeMarkPaids: PmsCheckoutChargeMarkPaidCommand[];
  checkoutChargeWaives: PmsCheckoutChargeWaiveCommand[];
  noteCreates: PmsPrivateNoteCreateCommand[];
  noteDeletes: PmsPrivateNoteDeleteCommand[];
  noteUpdates: PmsPrivateNoteUpdateCommand[];
  roomTypeCreates: PmsRoomTypeCreateCommand[];
  roomTypeUpdates: PmsRoomTypeUpdateCommand[];
  roomBlockCreates: PmsRoomBlockCreateCommand[];
  roomOrderCommands: PmsRoomOrderCommand[];
  templateUpdates: PmsOperationalTemplateUpdateCommand[];
  outboxEnqueues: string[];
  auditEvents: string[];
} {
  const commands: Array<
    | PmsAssignmentCommand
    | PmsOperationalStatusCommand
    | PmsCheckInCommand
    | PmsNoShowCommand
    | PmsBookingLifecycleCommand
    | PmsCheckOutCommand
  > = [];
  const checkOutCommands: PmsCheckOutCommand[] = [];
  const checkoutChargeCreates: PmsCheckoutChargeCreateCommand[] = [];
  const checkoutChargeMarkPaids: PmsCheckoutChargeMarkPaidCommand[] = [];
  const checkoutChargeWaives: PmsCheckoutChargeWaiveCommand[] = [];
  const noteCreates: PmsPrivateNoteCreateCommand[] = [];
  const noteDeletes: PmsPrivateNoteDeleteCommand[] = [];
  const noteUpdates: PmsPrivateNoteUpdateCommand[] = [];
  const roomTypeCreates: PmsRoomTypeCreateCommand[] = [];
  const roomTypeUpdates: PmsRoomTypeUpdateCommand[] = [];
  const roomBlockCreates: PmsRoomBlockCreateCommand[] = [];
  const roomOrderCommands: PmsRoomOrderCommand[] = [];
  const roomBlocks = structuredClone(pmsRoomBlocks);
  const templateUpdates: PmsOperationalTemplateUpdateCommand[] = [];
  const outboxEnqueues: string[] = [];
  const auditEvents: string[] = [];
  const notesByReservation = new Map<string, PmsPrivateNote[]>([
    [pmsReservations[0].guestBookingId, structuredClone(pmsPrivateNotes)],
    [pmsReservations[1].guestBookingId, []],
  ]);
  const checkoutChargesByReservation = new Map<string, PmsCheckoutCharge[]>([
    [
      pmsReservations[0].guestBookingId,
      [
        {
          chargeId: "f6855700-0000-0000-0000-000000000001",
          propertyId: pmsPropertyId,
          guestBookingId: pmsReservations[0].guestBookingId,
          assignmentId: pmsReservations[0].assignments[0]!.assignmentId,
          label: "Late checkout",
          amount: { amountDecimal: "25.00", currency: "EUR" },
          originalAmount: { amountDecimal: "25.00", currency: "EUR" },
          status: "paid",
          createdByUserId: "user_hotel_owner",
          createdAt: "2026-08-14T16:45:00.000Z",
          settledAt: "2026-08-14T16:55:00.000Z",
          waivedAt: null,
          operationalOwnership: {
            owner: "pms",
            financeSettlementOwner: "finance",
            providerSettlement: false,
          },
        },
      ],
    ],
  ]);
  const templates = new Map<PmsOperationalTemplateKind, PmsOperationalTemplate>([
    [
      "check_in_checklist",
      {
        propertyId: pmsPropertyId,
        templateKind: "check_in_checklist",
        steps: [
          { stepId: "passport", label: "Verify passport", required: true },
          { stepId: "deposit", label: "Review deposit", required: false },
        ],
        updatedByUserId: "user_hotel_owner",
        updatedAt: "2026-08-14T16:30:00.000Z",
      },
    ],
    [
      "check_out_inspection",
      {
        propertyId: pmsPropertyId,
        templateKind: "check_out_inspection",
        steps: [
          { stepId: "minibar", label: "Check minibar", required: false },
          { stepId: "damage", label: "Inspect damage", required: true },
        ],
        updatedByUserId: "user_hotel_owner",
        updatedAt: "2026-08-14T16:35:00.000Z",
      },
    ],
  ]);
  const replayResponses = new Map<string, PmsAssignmentCommandResult>();
  const operationalReplayResponses = new Map<string, PmsOperationalCommandResult>();

  return {
    commands,
    checkOutCommands,
    checkoutChargeCreates,
    checkoutChargeMarkPaids,
    checkoutChargeWaives,
    noteCreates,
    noteDeletes,
    noteUpdates,
    roomTypeCreates,
    roomTypeUpdates,
    roomBlockCreates,
    roomOrderCommands,
    templateUpdates,
    outboxEnqueues,
    auditEvents,
    async reorderRooms(command) {
      roomOrderCommands.push(command);
      return {
        ok: true as const,
        orderedRoomIds: command.orderedRoomIds,
        orderVersion: pmsRoomOrderVersion(command.orderedRoomIds),
        commandMeta: {
          contractVersion: "pms-operations.v1" as const,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T17:55:00.000Z",
          sideEffects: ["audit_event" as const],
        },
      };
    },
    async createRoomBlocks(command) {
      roomBlockCreates.push(command);
      const items = command.roomIds.map((roomId, index) => ({
        blockId: `f6855400-0000-0000-0000-${String(index + 10).padStart(12, "0")}`,
        version: "room-block-v1",
        roomTypeId: command.roomTypeId,
        roomId,
        startsOn: command.startsOn,
        endsOn: command.endsOn,
        blockedCount: 1,
        reason: command.reason,
        status: "active" as const,
      }));
      roomBlocks.push(...items);
      return {
        ok: true as const,
        items,
        commandMeta: roomBlockCommandMeta(command, "2026-08-14T18:00:00.000Z"),
      };
    },
    async updateRoomBlock(command) {
      const item = roomBlocks.find((block) => block.blockId === command.blockId);
      if (!item) {
        return {
          ok: false as const,
          statusCode: 404 as const,
          code: "room_block_not_found" as const,
          message: "Room block not found.",
        };
      }
      if (item.version !== command.expectedVersion) {
        return {
          ok: false as const,
          statusCode: 409 as const,
          code: "version_conflict" as const,
          message: "Room block changed. Refresh and try again.",
        };
      }
      Object.assign(item, {
        startsOn: command.startsOn ?? item.startsOn,
        endsOn: command.endsOn ?? item.endsOn,
        reason: command.reason ?? item.reason,
        version: "room-block-v2",
      });
      return {
        ok: true as const,
        items: [structuredClone(item)],
        commandMeta: roomBlockCommandMeta(command, "2026-08-14T18:01:00.000Z"),
      };
    },
    async releaseRoomBlock(command) {
      const item = roomBlocks.find((block) => block.blockId === command.blockId);
      if (!item || item.status !== "active") {
        return {
          ok: false as const,
          statusCode: 404 as const,
          code: "room_block_not_found" as const,
          message: "Room block not found.",
        };
      }
      if (item.version !== command.expectedVersion) {
        return {
          ok: false as const,
          statusCode: 409 as const,
          code: "version_conflict" as const,
          message: "Room block changed. Refresh and try again.",
        };
      }
      item.status = "released";
      item.version = "room-block-v2";
      return {
        ok: true as const,
        items: [structuredClone(item)],
        commandMeta: roomBlockCommandMeta(command, "2026-08-14T18:02:00.000Z"),
      };
    },
    async createRoomType(command) {
      roomTypeCreates.push(command);
      if (command.idempotencyKey === "room-type-create-conflict") {
        return {
          ok: false,
          statusCode: 409,
          code: "idempotency_conflict",
          message: "Room type create idempotency key was already used.",
        };
      }
      const ratePlans: PmsRoomType["ratePlans"] = [
        {
          ratePlanId: "f6855200-0000-0000-0000-000000000003",
          code: "FLEX",
          name: "Flexible",
          rateType: "flexible",
          mealPlan: null,
          baseRate: command.baseRate,
          active: true,
        },
      ];
      if (command.nonRefundableRate) {
        ratePlans.push({
          ratePlanId: "f6855200-0000-0000-0000-000000000004",
          code: "NRF",
          name: "Non-refundable",
          rateType: "non_refundable",
          mealPlan: null,
          baseRate: command.nonRefundableRate,
          active: true,
        });
      }
      const roomType: PmsRoomType = {
        roomTypeId: "f6855000-0000-0000-0000-000000000003",
        name: command.name,
        description: command.description,
        category: command.category,
        occupancyLimits: command.occupancyLimits,
        attributes: command.attributes,
        amenities: command.amenities,
        media: command.media,
        baseRate: command.baseRate,
        active: command.active,
        sortOrder: command.sortOrder,
        ratePlans,
        rateRulesSummary: {
          minStayNights: null,
          maxStayNights: null,
          closedToArrival: false,
          closedToDeparture: false,
          activeRuleCount: 0,
        },
        roomCount: command.roomCount,
      };
      auditEvents.push(`room_type_created:${roomType.roomTypeId}`);
      outboxEnqueues.push(`ari_changed:${roomType.roomTypeId}`);
      return {
        ok: true,
        roomType,
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T17:40:00.000Z",
          sideEffects: ["ari_changed", "audit_event"],
        },
      };
    },
    async updateRoomTypeLocation(command) {
      roomTypeUpdates.push(command);
      const roomType = roomTypes.find((item) => item.roomTypeId === command.roomTypeId);
      if (!roomType) {
        return {
          ok: false,
          statusCode: 404,
          code: "room_type_not_found",
          message: "PMS room type not found.",
        };
      }
      roomType.attributes = { ...roomType.attributes, ...command.attributes };
      auditEvents.push(`room_type_updated:${roomType.roomTypeId}`);
      return {
        ok: true,
        roomType: structuredClone(roomType),
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T17:45:00.000Z",
          sideEffects: ["audit_event"],
        },
      };
    },
    async getOperationalTemplate(propertyId, templateKind) {
      expect(propertyId).toBe(pmsPropertyId);
      return structuredClone(
        templates.get(templateKind) ?? {
          propertyId,
          templateKind,
          steps: [],
          updatedByUserId: null,
          updatedAt: null,
        },
      );
    },
    async updateOperationalTemplate(command) {
      templateUpdates.push(command);
      const template: PmsOperationalTemplate = {
        propertyId: command.propertyId,
        templateKind: command.templateKind,
        steps: structuredClone(command.steps),
        updatedByUserId: command.actorUserId,
        updatedAt: "2026-08-14T17:10:00.000Z",
      };
      templates.set(command.templateKind, template);
      auditEvents.push(`template_updated:${command.templateKind}`);
      return {
        ok: true,
        template: structuredClone(template),
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T17:10:00.000Z",
          sideEffects: ["audit_event"],
        },
      };
    },
    async listCheckoutCharges(propertyId, guestBookingId) {
      expect(propertyId).toBe(pmsPropertyId);
      return checkoutChargesByReservation.has(guestBookingId)
        ? structuredClone(checkoutChargesByReservation.get(guestBookingId)!)
        : null;
    },
    async createCheckoutCharge(command) {
      checkoutChargeCreates.push(command);
      const charges = checkoutChargesByReservation.get(command.guestBookingId);
      if (!charges) {
        return {
          ok: false,
          statusCode: 404,
          code: "reservation_not_found",
          message: "PMS reservation not found.",
        };
      }
      const charge: PmsCheckoutCharge = {
        chargeId: "f6855700-0000-0000-0000-000000000002",
        propertyId: command.propertyId,
        guestBookingId: command.guestBookingId,
        assignmentId: command.assignmentId ?? null,
        label: command.label,
        amount: { amountDecimal: command.amountDecimal, currency: command.currency },
        originalAmount: { amountDecimal: command.amountDecimal, currency: command.currency },
        status: "pending",
        createdByUserId: "user_hotel_owner",
        createdAt: "2026-08-14T17:20:00.000Z",
        settledAt: null,
        waivedAt: null,
        operationalOwnership: {
          owner: "pms",
          financeSettlementOwner: "finance",
          providerSettlement: false,
        },
      };
      charges.unshift(charge);
      auditEvents.push(`checkout_charge_created:${charge.chargeId}`);
      return {
        ok: true,
        charge,
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T17:20:00.000Z",
          sideEffects: ["audit_event"],
        },
      };
    },
    async markCheckoutChargePaid(command) {
      checkoutChargeMarkPaids.push(command);
      const charges = checkoutChargesByReservation.get(command.guestBookingId);
      const charge = charges?.find((item) => item.chargeId === command.chargeId);
      if (!charge) {
        return {
          ok: false,
          statusCode: 404,
          code: "charge_not_found",
          message: "PMS checkout charge not found.",
        };
      }
      charge.status = "paid";
      charge.settledAt = "2026-08-14T17:25:00.000Z";
      charge.waivedAt = null;
      auditEvents.push(`checkout_charge_marked_paid:${charge.chargeId}`);
      return {
        ok: true,
        charge: structuredClone(charge),
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T17:25:00.000Z",
          sideEffects: ["audit_event"],
        },
      };
    },
    async waiveCheckoutCharge(command) {
      checkoutChargeWaives.push(command);
      const charges = checkoutChargesByReservation.get(command.guestBookingId);
      const charge = charges?.find((item) => item.chargeId === command.chargeId);
      if (!charge) {
        return {
          ok: false,
          statusCode: 404,
          code: "charge_not_found",
          message: "PMS checkout charge not found.",
        };
      }
      charge.status = "waived";
      charge.settledAt = null;
      charge.waivedAt = "2026-08-14T17:30:00.000Z";
      auditEvents.push(`checkout_charge_waived:${charge.chargeId}`);
      return {
        ok: true,
        charge: structuredClone(charge),
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T17:30:00.000Z",
          sideEffects: ["audit_event"],
        },
      };
    },
    async executeCheckOutCommand(command) {
      commands.push(command);
      checkOutCommands.push(command);
      const reservation = pmsReservations.find(
        (item) => item.guestBookingId === command.guestBookingId,
      );
      const charges = checkoutChargesByReservation.get(command.guestBookingId);
      if (!reservation || !charges) {
        return {
          ok: false,
          statusCode: 404,
          code: "reservation_not_found",
          message: "PMS reservation not found.",
        };
      }
      if (command.expectedVersion === "reservation-v6") {
        return {
          ok: false,
          statusCode: 409,
          code: "version_conflict",
          message: "Reservation check-out version is stale.",
        };
      }
      if (command.expectedVersion === "reservation-invalid-transition") {
        return {
          ok: false,
          statusCode: 400,
          code: "invalid_status_transition",
          message: "Cannot transition PMS reservation from assigned to checked_out.",
        };
      }
      const settled = charges.filter((charge) => command.chargesSettled.includes(charge.chargeId));
      const pendingChargeIds = charges
        .filter(
          (charge) =>
            charge.status === "pending" && !command.chargesSettled.includes(charge.chargeId),
        )
        .map((charge) => charge.chargeId);
      const unsettledPaidChargeIds = charges
        .filter((charge) => charge.status === "paid")
        .map((charge) => charge.chargeId);
      const pendingFlags = [
        ...new Set([
          ...command.pendingFlags,
          ...(pendingChargeIds.length > 0 ? ["checkout_charges_unsettled"] : []),
          ...(unsettledPaidChargeIds.length > 0 ? ["finance_settlement_handoff_required"] : []),
        ]),
      ].sort();
      const checkout: PmsCheckOutRecord = {
        checkoutRecordId: "f6855a00-0000-0000-0000-000000000001",
        propertyId: command.propertyId,
        guestBookingId: command.guestBookingId,
        assignmentId: command.assignmentId ?? null,
        completedByUserId: "user_hotel_owner",
        completedAt: "2026-08-18T10:15:00.000Z",
        inspectionResults: structuredClone(command.inspectionResults),
        chargesSettled: structuredClone(settled),
        pendingFlags,
        checkoutNotes: command.checkoutNotes ?? null,
        financeHandoff: {
          financeSettlementOwner: "finance",
          providerSettlement: false,
          pendingChargeIds,
          unsettledPaidChargeIds,
        },
      };
      const checkedOutReservation: PmsOperationalReservation = {
        ...structuredClone(reservation),
        checkout: { completedAt: checkout.completedAt, pendingFlags },
        assignments: reservation.assignments.map((assignment) => ({
          ...assignment,
          assignmentStatus: "checked_out",
        })),
      };
      auditEvents.push(`checkout_completed:${checkout.checkoutRecordId}`);
      return {
        ok: true,
        reservation: checkedOutReservation,
        checkout,
        charges: structuredClone(charges),
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: checkout.completedAt,
          sideEffects: ["audit_event"],
        },
      };
    },
    async listPrivateNotes(propertyId, guestBookingId) {
      expect(propertyId).toBe(pmsPropertyId);
      return notesByReservation.has(guestBookingId)
        ? structuredClone(notesByReservation.get(guestBookingId)!)
        : null;
    },
    async createPrivateNote(command) {
      noteCreates.push(command);
      const notes = notesByReservation.get(command.guestBookingId);
      if (!notes) {
        return {
          ok: false,
          statusCode: 404,
          code: "reservation_not_found",
          message: "PMS reservation not found.",
        };
      }
      const note: PmsPrivateNote = {
        noteId: "f6855900-0000-0000-0000-000000000002",
        body: command.body,
        authorUserId: command.actorUserId,
        authorDisplayName: command.authorDisplayName,
        createdAt: "2026-08-14T17:00:00.000Z",
        auditMetadata: {
          source: "pms",
          createdByUserId: command.actorUserId,
          createdByDisplayName: command.authorDisplayName,
          createdAt: "2026-08-14T17:00:00.000Z",
          editedByUserId: null,
          editedByDisplayName: null,
          editedAt: null,
          privacyScope: "internal",
        },
      };
      notes.unshift(note);
      auditEvents.push(`private_note_created:${note.noteId}`);
      return {
        ok: true,
        note,
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T17:00:00.000Z",
          sideEffects: ["audit_event"],
        },
      };
    },
    async deletePrivateNote(command) {
      noteDeletes.push(command);
      const notes = notesByReservation.get(command.guestBookingId);
      if (!notes) {
        return {
          ok: false,
          statusCode: 404,
          code: "reservation_not_found",
          message: "PMS reservation not found.",
        };
      }
      const index = notes.findIndex((note) => note.noteId === command.noteId);
      if (index === -1) {
        return {
          ok: false,
          statusCode: 404,
          code: "note_not_found",
          message: "PMS private note not found.",
        };
      }
      const [deleted] = notes.splice(index, 1);
      auditEvents.push(`private_note_deleted:${deleted!.noteId}`);
      return {
        ok: true,
        noteId: command.noteId,
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T17:05:00.000Z",
          sideEffects: ["audit_event"],
        },
      };
    },
    async updatePrivateNote(command) {
      noteUpdates.push(command);
      const notes = notesByReservation.get(command.guestBookingId);
      const note = notes?.find((candidate) => candidate.noteId === command.noteId);
      if (!note) {
        return {
          ok: false,
          statusCode: 404,
          code: notes ? "note_not_found" : "reservation_not_found",
          message: notes ? "PMS private note not found." : "PMS reservation not found.",
        };
      }
      note.body = command.body;
      note.auditMetadata.editedByUserId = command.actorUserId;
      note.auditMetadata.editedByDisplayName = command.editorDisplayName;
      note.auditMetadata.editedAt = "2026-08-14T17:03:00.000Z";
      auditEvents.push(`private_note_edited:${note.noteId}`);
      return {
        ok: true,
        note: structuredClone(note),
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: note.auditMetadata.editedAt,
          sideEffects: ["audit_event"],
        },
      };
    },
    async executeAssignmentCommand(command) {
      commands.push(command);

      const replay = replayResponses.get(command.idempotencyKey);
      if (replay) return replay;

      const conflict = assignmentCommandConflict(command);
      if (conflict) return conflict;

      const reservation = reservationForAssignmentCommand(command);
      const result: PmsAssignmentCommandResult = {
        ok: true,
        reservation,
        commandMeta: {
          contractVersion: "pms-operations.v1",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          acceptedAt: "2026-08-14T16:00:00.000Z",
          sideEffects: ["calendar_refresh", "audit_event"],
        },
      };
      replayResponses.set(command.idempotencyKey, result);
      outboxEnqueues.push(`calendar_refresh:${command.guestBookingId}`);
      return result;
    },
    async executeOperationalStatusCommand(command) {
      commands.push(command);
      return executeOperationalTestCommand(
        command,
        operationalReplayResponses,
        auditEvents,
        reservationForOperationalStatusCommand,
      );
    },
    async executeCheckInCommand(command) {
      commands.push(command);
      return executeOperationalTestCommand(
        command,
        operationalReplayResponses,
        auditEvents,
        reservationForCheckInCommand,
      );
    },
    async executeNoShowCommand(command) {
      commands.push(command);
      return executeOperationalTestCommand(
        command,
        operationalReplayResponses,
        auditEvents,
        reservationForNoShowCommand,
      );
    },
    async acceptBooking(command) {
      commands.push(command);
      return bookingLifecycleTestResult(command, "confirmed", "unpaid");
    },
    async markBookingPaid(command) {
      commands.push(command);
      return bookingLifecycleTestResult(command, "confirmed", "paid");
    },
  };
}

function bookingLifecycleTestResult(
  command: PmsBookingLifecycleCommand,
  status: string,
  paymentStatus: string,
): PmsOperationalCommandResult {
  const reservation = pmsReservations.find(
    (candidate) => candidate.guestBookingId === command.guestBookingId,
  );
  if (!reservation) {
    return {
      ok: false,
      statusCode: 404,
      code: "reservation_not_found",
      message: "PMS reservation not found.",
    };
  }
  return {
    ok: true,
    reservation: {
      ...structuredClone(reservation),
      status,
      payment: { method: "bank_transfer", status: paymentStatus },
    },
    commandMeta: {
      contractVersion: "pms-operations.v1",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      acceptedAt: "2026-08-14T17:10:00.000Z",
      sideEffects: ["guest_notification", "audit_event"],
    },
  };
}

function executeOperationalTestCommand<
  TCommand extends PmsOperationalStatusCommand | PmsCheckInCommand | PmsNoShowCommand,
>(
  command: TCommand,
  replayResponses: Map<string, PmsOperationalCommandResult>,
  auditEvents: string[],
  mutate: (command: TCommand) => PmsOperationalCommandResult,
): PmsOperationalCommandResult {
  const commandType = "status" in command ? "status" : "reason" in command ? "no_show" : "check_in";
  const replayKey = `${command.guestBookingId}:${command.idempotencyKey}:${commandType}`;
  const replay = replayResponses.get(replayKey);
  if (replay) return replay;

  const conflict = operationalCommandConflict(command);
  if (conflict) return conflict;

  const result = mutate(command);
  replayResponses.set(replayKey, result);
  auditEvents.push(`audit_event:${command.guestBookingId}:${command.commandId}`);
  return result;
}

function assignmentCommandConflict(
  command: PmsAssignmentCommand,
): Exclude<PmsAssignmentCommandResult, { ok: true }> | undefined {
  if (command.expectedVersion === "reservation-v6") {
    return {
      ok: false,
      statusCode: 409,
      code: "version_conflict",
      message: "Reservation assignment version is stale.",
    };
  }
  if (command.roomId === "f6855100-0000-0000-0000-000000000099") {
    return {
      ok: false,
      statusCode: 409,
      code: "room_unavailable",
      message: "Requested room is unavailable for this stay.",
    };
  }
  if (command.targetAssignmentId === "f6855500-0000-0000-0000-000000009999") {
    return {
      ok: false,
      statusCode: 409,
      code: "assignment_conflict",
      message: "Target assignment does not belong to this reservation.",
    };
  }
  return undefined;
}

function operationalCommandConflict(
  command: PmsOperationalStatusCommand | PmsCheckInCommand | PmsNoShowCommand,
): Exclude<PmsOperationalCommandResult, { ok: true }> | undefined {
  if (command.expectedVersion === "reservation-v6") {
    return {
      ok: false,
      statusCode: 409,
      code: "version_conflict",
      message: "Reservation operational version is stale.",
    };
  }
  if ("status" in command && command.status === "checked_out") {
    return {
      ok: false,
      statusCode: 400,
      code: "invalid_status_transition",
      message: "Cannot transition PMS reservation from assigned to checked_out.",
    };
  }
  return undefined;
}

function reservationForAssignmentCommand(command: PmsAssignmentCommand): PmsOperationalReservation {
  const base =
    pmsReservations.find((reservation) => reservation.guestBookingId === command.guestBookingId) ??
    pmsReservations[0];
  const reservation = structuredClone(base);
  const assignment = reservation.assignments[0]!;

  if (command.action === "unassign") {
    assignment.roomId = null;
    assignment.roomNumber = null;
    assignment.assignmentStatus = "pending";
    assignment.assignedAt = null;
    return reservation;
  }

  if (command.action === "swap") {
    reservation.assignments = [
      {
        ...assignment,
        assignmentId: command.assignmentId ?? assignment.assignmentId,
        roomId: "f6855100-0000-0000-0000-000000000002",
        roomNumber: "102",
        assignmentStatus: "assigned",
      },
      {
        ...assignment,
        assignmentId: command.targetAssignmentId ?? "f6855500-0000-0000-0000-000000000003",
        roomId: "f6855100-0000-0000-0000-000000000001",
        roomNumber: "101",
        position: 2,
        assignmentStatus: "assigned",
      },
    ];
    return reservation;
  }

  assignment.assignmentId = command.assignmentId ?? assignment.assignmentId;
  assignment.roomId = command.roomId ?? null;
  assignment.roomNumber = command.roomId === pmsRooms[2].roomId ? "201" : "102";
  assignment.assignmentStatus = "assigned";
  assignment.assignedAt = "2026-08-14T16:00:00.000Z";
  return reservation;
}

function reservationForOperationalStatusCommand(
  command: PmsOperationalStatusCommand,
): PmsOperationalCommandResult {
  const reservation = cloneOperationalReservation(command);
  reservation.status = command.status;
  for (const assignment of reservation.assignments) {
    assignment.assignmentStatus = command.status;
  }
  return acceptedOperationalCommand(command, reservation);
}

function reservationForCheckInCommand(command: PmsCheckInCommand): PmsOperationalCommandResult {
  const reservation = cloneOperationalReservation(command);
  reservation.status = "checked_in";
  reservation.checkin = {
    completedAt: "2026-08-15T15:45:00.000Z",
    pendingFlags: command.pendingFlags,
  };
  for (const assignment of reservation.assignments) {
    assignment.assignmentStatus = "checked_in";
  }
  return acceptedOperationalCommand(command, reservation);
}

function reservationForNoShowCommand(command: PmsNoShowCommand): PmsOperationalCommandResult {
  const reservation = cloneOperationalReservation(command);
  reservation.status = "no_show";
  for (const assignment of reservation.assignments) {
    assignment.assignmentStatus = "released";
    assignment.roomId = null;
    assignment.roomNumber = null;
    assignment.assignedAt = null;
  }
  return acceptedOperationalCommand(command, reservation);
}

function cloneOperationalReservation(
  command: PmsOperationalStatusCommand | PmsCheckInCommand | PmsNoShowCommand,
): PmsOperationalReservation {
  const base =
    pmsReservations.find((reservation) => reservation.guestBookingId === command.guestBookingId) ??
    pmsReservations[0];
  return structuredClone(base);
}

function acceptedOperationalCommand(
  command: PmsOperationalStatusCommand | PmsCheckInCommand | PmsNoShowCommand,
  reservation: PmsOperationalReservation,
): PmsOperationalCommandResult {
  return {
    ok: true,
    reservation,
    commandMeta: {
      contractVersion: "pms-operations.v1",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      acceptedAt: "2026-08-15T15:45:00.000Z",
      sideEffects: ["audit_event"],
    },
  };
}

const seededPublicProfile = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "bookable",
)!.profile;
const seededPublicQuote = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "bookable",
)!.quote!;
const seededUnavailableQuote = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "unavailable",
)!.quote!;
const seededCustomDomainProfile = PUBLIC_BOOKABILITY_FIXTURES.find(
  (fixture) => fixture.caseId === "custom_domain",
)!.profile;

const publicHotelProfileRepository: PublicHotelProfileRepository = {
  async findProfileBySlug(slug) {
    return slug === seededPublicProfile.hotel.slug ? seededPublicProfile : null;
  },
  async findProfileByCustomDomain(domain) {
    return domain === "book.alpenrose.example" ? seededCustomDomainProfile : null;
  },
};

function targetPublicHotelProfileRow(): QueryResultRow {
  return {
    propertyId: "f6893000-0000-0000-0000-000000000001",
    contractVersion: "public-bookability.v1",
    publicVisibility: "public_safe",
    publicId: "prop_distribution_alpenrose",
    canonicalSlug: "distribution-alpenrose",
    canonicalUrl: "https://distribution-alpenrose.booking.localhost/en",
    bookingBaseUrl: "https://distribution-alpenrose.booking.localhost",
    customDomainUrl: null,
    timezone: "Europe/Vienna",
    defaultLocale: "en",
    supportedLocales: ["en", "de"],
    defaultCurrency: "EUR",
    supportedCurrencies: ["EUR", "USD"],
    profileStatus: "public",
    publicIdentity: {
      propertyId: "prop_distribution_alpenrose",
      slug: "distribution-alpenrose",
      name: "Distribution Alpenrose",
      summary: "Independent alpine hotel near the old town.",
    },
    location: {
      country: "AT",
      city: "Innsbruck",
      region: "Tyrol",
      latitude: 47.2692,
      longitude: 11.4041,
    },
    media: [
      {
        url: "https://cdn.vayada.example/hotels/distribution-alpenrose/front.jpg",
        alt: "Distribution Alpenrose exterior",
      },
    ],
    amenities: ["wifi", "breakfast"],
    policies: {
      checkInFrom: "15:00",
      checkOutUntil: "11:00",
      cancellationSummary: "Free cancellation until 7 days before arrival.",
      termsUrl: "https://distribution-alpenrose.booking.localhost/en/terms",
    },
    capabilities: {
      instantBook: true,
      onlinePayment: true,
      payAtProperty: true,
      promoCodes: true,
      referralCodes: true,
      bookingDeepLinks: true,
    },
    supportedQuoteParameters: {
      minRooms: 1,
      maxRooms: 4,
      minAdults: 1,
      maxAdults: 6,
      childrenSupported: true,
      adultAgeThreshold: 18,
      supportedCurrencies: ["EUR", "USD"],
      supportedLocales: ["en", "de"],
    },
    bookingHeaderLogo: "https://cdn.vayada.example/hotels/distribution-alpenrose/header-logo.webp",
    bookingHeroImage: "https://cdn.vayada.example/hotels/distribution-alpenrose/booking.jpg",
    bookingHeroHeading: "Stay in the heart of the Alps",
    bookingHeroSubtext: "Book direct for our best available rates.",
    bookingPrimaryColor: "#3157D5",
    bookingFontPairing: "grand-classic",
    publicSetupCompleteness: { status: "ready", missing: [] },
    sourceFreshness: {
      hotel_catalog: { status: "fresh", generatedAt: "2026-06-09T08:50:00.000Z" },
      booking: { status: "fresh", generatedAt: "2026-06-09T08:55:00.000Z" },
      pms: { status: "fresh", generatedAt: "2026-06-09T08:58:00.000Z" },
      finance: { status: "fresh", generatedAt: "2026-06-09T08:57:00.000Z" },
      distribution: { status: "fresh", generatedAt: "2026-06-09T09:00:00.000Z" },
    },
    freshnessStatus: "fresh",
    dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
    generatedAt: "2026-06-09T09:00:00.000Z",
    expiresAt: null,
  };
}

const publicHotelQuoteRepository: PublicHotelQuoteRepository = {
  async findQuoteBySlug(slug, query) {
    if (slug !== seededPublicQuote.request.hotelSlug) return null;
    if (query.check_in === "2026-09-12" && query.check_out === "2026-09-15") {
      return seededPublicQuote;
    }
    return seededUnavailableQuote;
  },
};

function identityRepositoryWithResources(
  hotelId: string | null = "booking_hotel_alpenrose",
  linkedPmsPropertyId: string | null = pmsPropertyId,
  linkedPmsRelationship: "owner" | "operator" | "front_desk" = "operator",
): IdentityRepository {
  return {
    ...identityRepository,
    async findLinkedResources() {
      const resources: Awaited<ReturnType<IdentityRepository["findLinkedResources"]>> = [];
      if (hotelId) {
        resources.push({
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: hotelId,
          relationship: "owner",
          status: "active",
        });
      }
      if (linkedPmsPropertyId) {
        resources.push({
          product: "pms",
          resourceType: "pms_property",
          resourceId: linkedPmsPropertyId,
          relationship: linkedPmsRelationship,
          status: "active",
        });
      }
      return resources;
    },
  };
}

function buildAuthenticatedApp(
  options: {
    permissions?: PermissionKey[];
    entitlements?: ProductEntitlement[];
    linkedHotelId?: string | null;
    reservationsRepository?: BookingReservationsReadRepository;
    changeRequestRepository?: BookingHotelChangeRequestRepository;
    settingsRepository?: BookingSettingsReadRepository;
    settingsWriteRepository?: BookingSettingsWriteRepository;
    publicBookabilityPublisher?: PublicBookabilityPublicationCommandPort;
    pmsInventoryPublicOfferProjector?: PmsInventoryPublicOfferProjectionPort;
    customDomainRepository?: BookingCustomDomainRepository;
    bookingAddonItemsRepository?: BookingAddonItemsRepository;
    bookingPromoCodesRepository?: BookingPromoCodesRepository;
    pmsOperationsRepository?: PmsOperationsReadRepository;
    pmsCheckoutChargeMarkPaidFreezeEnabled?: boolean;
    pmsOperationsCommandRepository?: PmsOperationsCommandRepository;
    bookingAcceptanceSettings?: BookingAcceptanceSettingsPort;
    pmsRoomAssignmentSettings?: PmsRoomAssignmentSettingsPort;
    pmsRoomAssignmentHistory?: PmsRoomAssignmentOptimizationHistoryPort;
    bookingGuestPiiPort?: BookingGuestPiiPort;
    pmsOperationsAllowedOrigins?: string[];
    propertyPlanReadRepository?: PropertyPlanReadRepository;
    financeRepository?: FinancePropertyReadRepository;
    pmsFinanceCompatibilityRepository?: FinancePropertyReadRepository;
    browserAllowedOrigins?: string[];
    linkedPmsPropertyId?: string | null;
    linkedPmsRelationship?: "owner" | "operator" | "front_desk";
  } = {},
): ReturnType<typeof buildApp> {
  return buildApp({
    logger: false,
    browserAllowedOrigins: options.browserAllowedOrigins,
    bookingReservationsRepository: options.reservationsRepository ?? bookingReservationsRepository,
    bookingChangeRequestRepository: options.changeRequestRepository,
    pmsOperationsRepository: options.pmsOperationsRepository ?? pmsOperationsRepository,
    pmsCheckoutChargeMarkPaidFreezeEnabled: options.pmsCheckoutChargeMarkPaidFreezeEnabled,
    pmsOperationsCommandRepository: options.pmsOperationsCommandRepository,
    bookingAcceptanceSettings: options.bookingAcceptanceSettings,
    pmsRoomAssignmentSettings: options.pmsRoomAssignmentSettings,
    pmsRoomAssignmentHistory: options.pmsRoomAssignmentHistory,
    bookingGuestPiiPort: options.bookingGuestPiiPort,
    pmsOperationsAllowedOrigins: options.pmsOperationsAllowedOrigins,
    propertyPlanReadRepository: options.propertyPlanReadRepository,
    financeRepository: options.financeRepository,
    pmsFinanceCompatibilityRepository: options.pmsFinanceCompatibilityRepository,
    bookingAddonItemsRepository: options.bookingAddonItemsRepository ?? bookingAddonItemsRepository,
    bookingPromoCodesRepository: options.bookingPromoCodesRepository ?? bookingPromoCodesRepository,
    bookingSettingsRepository: options.settingsRepository ?? bookingSettingsRepository,
    bookingSettingsWriteRepository:
      options.settingsWriteRepository ?? bookingSettingsWriteRepository,
    publicBookabilityPublisher: options.publicBookabilityPublisher,
    pmsInventoryPublicOfferProjector: options.pmsInventoryPublicOfferProjector,
    bookingCustomDomainRepository: options.customDomainRepository ?? bookingCustomDomainRepository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepositoryWithResources(
        options.linkedHotelId,
        options.linkedPmsPropertyId,
        options.linkedPmsRelationship,
      ),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["booking.settings.manage", "booking.reservation.read"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return (
            options.entitlements ?? [
              {
                product: "booking",
                key: "booking-engine",
                status: "active",
              },
            ]
          );
        },
      },
    },
  });
}

function readContractPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === undefined || current === null) return undefined;
    const match = /^([^\[]+)(?:\[(\d+)])?$/.exec(segment);
    if (!match) return undefined;
    const [, key, index] = match;
    if (typeof current !== "object" || !(key in current)) return undefined;
    const next = (current as Record<string, unknown>)[key];
    if (index === undefined) return next;
    return Array.isArray(next) ? next[Number(index)] : undefined;
  }, value);
}

describe("vayada-api", () => {
  let app: ReturnType<typeof buildApp> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("returns health status without binding a port", async () => {
    app = buildApp({ logger: false });
    const response = await injectJson(app, {
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      service: "vayada-api",
      status: "ok",
    });
  });

  it("registers product route group placeholders", async () => {
    app = buildApp({ logger: false });
    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      group: "booking",
      status: "ok",
    });
  });

  it("allows configured browser CORS origins on authenticated booking routes", async () => {
    app = buildAuthenticatedApp({
      browserAllowedOrigins: ["https://next-booking-admin.vayada.com"],
    });

    const url = "/api/booking/hotels/booking_hotel_alpenrose/reservations";
    const preflight = await app.inject({
      method: "OPTIONS",
      url,
      headers: {
        origin: "https://next-booking-admin.vayada.com",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type,x-hotel-id",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "https://next-booking-admin.vayada.com",
    );
    expect(preflight.headers["access-control-allow-headers"]).toBe(
      "authorization,content-type,x-hotel-id",
    );
    expect(preflight.headers["access-control-allow-methods"]).toBe(
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );

    const unauthenticated = await app.inject({
      method: "GET",
      url,
      headers: {
        origin: "https://next-booking-admin.vayada.com",
      },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["access-control-allow-origin"]).toBe(
      "https://next-booking-admin.vayada.com",
    );
  });

  it("returns platform admin bookings through platform organization scope", async () => {
    const observedInputs: unknown[] = [];
    app = buildPlatformAdminApp({
      repository: {
        async listBookings(input) {
          observedInputs.push(input);
          return [
            {
              id: "booking_1",
              bookingReference: "VAY-2026-0001",
              hotelId: "property_1",
              hotelName: "Hotel Alpenrose",
              hotelSlug: "hotel-alpenrose",
              guestName: "Ada Lovelace",
              guestEmail: "ada@example.com",
              checkIn: "2026-07-10",
              checkOut: "2026-07-12",
              nights: 2,
              totalAmount: 241,
              currency: "EUR",
              status: "accepted",
              rawStatus: "confirmed",
              channel: "direct",
              requestedAt: "2026-06-01T12:00:00.000Z",
              respondedAt: "2026-06-02T12:00:00.000Z",
            },
          ];
        },
        async listGrowthProperties() {
          return [];
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/platform/admin/bookings?limit=500",
      headers: {
        authorization: "Bearer platform-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      bookings: [
        {
          bookingReference: "VAY-2026-0001",
          hotelName: "Hotel Alpenrose",
          status: "accepted",
        },
      ],
    });
    expect(observedInputs).toEqual([{ status: undefined, limit: 500, offset: 0 }]);
  });

  it("returns platform admin growth empty state without a missing endpoint", async () => {
    app = buildPlatformAdminApp({
      repository: {
        async listBookings() {
          return [];
        },
        async listGrowthProperties() {
          return [
            {
              id: "property_1",
              name: "Hotel Alpenrose",
              slug: "hotel-alpenrose",
              status: "live",
              lifecycleStatus: "active",
              lifecycleRevision: 1,
              ownerAccountUserIds: [],
              createdAt: "2026-06-01T12:00:00.000Z",
            },
          ];
        },
      },
    });

    const response = await injectJson<PlatformAdminGrowthDashboard>(app, {
      method: "GET",
      url: "/api/platform/admin/growth?granularity=weekly&exclude_test_data=true",
      headers: {
        authorization: "Bearer platform-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      properties: [{ id: "property_1", status: "live" }],
      selectedPropertyIds: ["property_1"],
      bookingPropertyId: null,
      emptyMessage: "Target growth telemetry is not available yet for the selected properties.",
    });
    expect(response.body.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "live_properties", rawValue: 1, value: "1" }),
        expect.objectContaining({ key: "page_views", rawValue: null, value: "N/A" }),
        expect.objectContaining({ key: "booking_requests", rawValue: null, value: "N/A" }),
      ]),
    );
  });

  it("scopes platform admin growth metrics to the selected target properties", async () => {
    app = buildPlatformAdminApp({
      repository: {
        async listBookings() {
          return [];
        },
        async listGrowthProperties() {
          return [
            {
              id: "property_1",
              name: "Hotel Alpenrose",
              slug: "hotel-alpenrose",
              status: "live",
              lifecycleStatus: "active",
              lifecycleRevision: 1,
              ownerAccountUserIds: [],
              createdAt: "2026-06-01T12:00:00.000Z",
            },
            {
              id: "property_2",
              name: "Demo Lodge",
              slug: "demo-lodge",
              status: "demo",
              lifecycleStatus: "provisioning",
              lifecycleRevision: 1,
              ownerAccountUserIds: [],
              createdAt: "2026-06-02T12:00:00.000Z",
            },
          ];
        },
      },
    });

    const response = await injectJson<PlatformAdminGrowthDashboard>(app, {
      method: "GET",
      url: "/api/platform/admin/growth?property_ids=property_2&property_ids=property_2&booking_property_id=property_1",
      headers: {
        authorization: "Bearer platform-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      selectedPropertyIds: ["property_2"],
      bookingPropertyId: null,
    });
    expect(response.body.metrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "live_properties", rawValue: 0, value: "0" }),
      ]),
    );
  });

  it("rejects platform admin reads without the platform resource link", async () => {
    app = buildPlatformAdminApp({ resourceAccess: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/platform/admin/bookings?limit=500",
      headers: {
        authorization: "Bearer platform-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("does not expose booking addon settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose booking guest-form settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose booking benefits settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose booking localization settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose booking room-filter settings until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose booking reservations until a read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose public AI hotel profiles until a distribution read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose",
    });

    expect(response.statusCode).toBe(404);
  });

  it("does not expose public AI hotel quotes until a distribution read model is configured", async () => {
    app = buildApp({ logger: false });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-09-12&check_out=2026-09-15&adults=2",
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns the public AI hotel profile contract from the distribution read model", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
    expect(response.headers["x-vayada-ratelimit-policy"]).toBe("public-ai-profile-read");
    expect(body).toMatchObject({
      contractVersion: "public-bookability.v1",
      publicVisibility: "public_safe",
      hotel: {
        slug: "hotel-alpenrose",
        canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
        timezone: "Europe/Vienna",
        defaultCurrency: "EUR",
        trust: {
          profileComplete: true,
          profileVerified: true,
          bookabilityStatus: "bookable",
        },
      },
      dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
    });
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("returns the public AI hotel quote contract from the distribution read model", async () => {
    app = buildApp({
      logger: false,
      publicHotelQuoteRepository,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&currency=EUR&locale=en&referral_code=creator-anna",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=15, stale-while-revalidate=60");
    expect(response.headers["x-vayada-ratelimit-policy"]).toBe("public-ai-quote-read");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
    expect(body).toMatchObject({
      contractVersion: "public-bookability.v1",
      publicVisibility: "public_safe",
      request: {
        hotelSlug: "hotel-alpenrose",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        nights: 3,
        adults: 2,
        currency: "EUR",
        locale: "en",
      },
      status: "bookable",
      quote: {
        priceGuarantee: "expires_at",
        offers: [
          {
            roomTypeId: "room_deluxe",
            totals: {
              roomTotal: 540,
              taxesAndFees: 54,
              grandTotal: 594,
            },
            paymentOptions: ["card", "pay_at_property"],
          },
        ],
      },
      deepLink: {
        url: "https://hotel-alpenrose.booking.localhost/en/book?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&referral_code=creator-anna&quote_id=quote_alpenrose_001",
      },
      dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
    });
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("requires the target checkout adapter when Booking Web public routes are mounted", () => {
    expect(() =>
      buildApp({
        logger: false,
        publicHotelProfileRepository,
      }),
    ).toThrow("Booking Web checkout adapter is required when public routes are mounted");
  });

  it("returns stable unavailable reason codes for public AI hotel quotes", async () => {
    app = buildApp({
      logger: false,
      publicHotelQuoteRepository,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-10-01&check_out=2026-10-02&adults=2",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      status: "unavailable",
      unavailableReasons: [
        { code: "sold_out", detail: "No public inventory for requested dates." },
      ],
    });
    expect(body).not.toHaveProperty("quote");
  });

  it("returns Booking Web host resolution for known booking subdomains", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hosts/hotel-alpenrose.booking.localhost",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=60, stale-while-revalidate=300",
    );
    expect(response.headers["x-vayada-ratelimit-policy"]).toBe("public-booking-web-host-read");
    expect(body).toMatchObject({
      contractVersion: "public-bookability.v1",
      publicVisibility: "public_safe",
      host: "hotel-alpenrose.booking.localhost",
      slug: "hotel-alpenrose",
      canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
      shouldRedirect: false,
      redirectUrl: null,
      redirectStatus: null,
      hotel: {
        slug: "hotel-alpenrose",
        defaultLocale: "en",
        supportedLocales: ["en", "de"],
      },
      dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
    });
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("returns Booking Web host resolution for known next booking subdomains", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hosts/hotel-alpenrose.next-booking.vayada.com",
      headers: {
        origin: "https://hotel-alpenrose.next-booking.vayada.com",
      },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://hotel-alpenrose.next-booking.vayada.com",
    );
    expect(body).toMatchObject({
      contractVersion: "public-bookability.v1",
      publicVisibility: "public_safe",
      host: "hotel-alpenrose.next-booking.vayada.com",
      slug: "hotel-alpenrose",
      hotel: {
        slug: "hotel-alpenrose",
        defaultLocale: "en",
      },
    });
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("returns Booking Web custom-domain resolution and canonical redirect policy", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository: {
        async findProfileBySlug(slug) {
          return slug === "hotel-alpenrose" ? seededCustomDomainProfile : null;
        },
        async findProfileByCustomDomain(domain) {
          return domain === "book.alpenrose.example" ? seededCustomDomainProfile : null;
        },
      },
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hosts/legacy-alpenrose.booking.localhost",
    });

    expect(response.statusCode).toBe(404);

    const customDomainResponse = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hosts/book.alpenrose.example",
    });

    expect(customDomainResponse.statusCode).toBe(200);
    expect(customDomainResponse.body).toMatchObject({
      host: "book.alpenrose.example",
      slug: "hotel-alpenrose",
      canonicalUrl: "https://book.alpenrose.example/en",
      bookingBaseUrl: "https://book.alpenrose.example",
      customDomainUrl: "https://book.alpenrose.example",
      shouldRedirect: false,
      redirectUrl: null,
    });
    expect(findForbiddenPublicBookabilityKeys(customDomainResponse.body)).toEqual([]);
  });

  it("resolves Booking Web custom domains from the target repository without legacy Booking", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository: {
        async findProfileBySlug(slug) {
          return slug === "hotel-alpenrose" ? seededCustomDomainProfile : null;
        },
        async findProfileByCustomDomain(domain) {
          return domain === "book.alpenrose.example" ? seededCustomDomainProfile : null;
        },
      },
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hosts/book.alpenrose.example",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      host: "book.alpenrose.example",
      slug: "hotel-alpenrose",
      canonicalUrl: "https://book.alpenrose.example/en",
      bookingBaseUrl: "https://book.alpenrose.example",
      customDomainUrl: "https://book.alpenrose.example",
      shouldRedirect: false,
      redirectUrl: null,
    });
    expect(findForbiddenPublicBookabilityKeys(response.body)).toEqual([]);
  });

  it("mounts public profile and known-host routes in target mode", async () => {
    const config = loadConfig({
      TARGET_DATABASE_URL: "postgresql://target-db",
      PUBLIC_HOTEL_PROFILE_SOURCE: "target",
    });
    const pool: PublicHotelProfileReadPool = {
      async query<T extends QueryResultRow>() {
        return { rows: [targetPublicHotelProfileRow()] as T[] };
      },
      async end() {},
    };
    const targetRepository = createTargetPublicHotelProfileRepository({
      connectionString: config.targetDatabaseUrl!,
      pool,
    });
    app = buildApp({
      logger: false,
      publicHotelProfileRepository: targetRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const aiProfile = await injectJson(app, {
      method: "GET",
      url: "/api/ai/hotels/distribution-alpenrose",
    });
    const bookingWebProfile = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hotels/distribution-alpenrose",
    });
    const knownHost = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hosts/distribution-alpenrose.booking.localhost",
    });

    expect(aiProfile.statusCode).toBe(200);
    expect(bookingWebProfile.statusCode).toBe(200);
    expect(knownHost.statusCode).toBe(200);
    expect(aiProfile.body).toMatchObject({
      hotel: { slug: "distribution-alpenrose", name: "Distribution Alpenrose" },
    });
    expect(bookingWebProfile.body).toMatchObject({
      hotel: { slug: "distribution-alpenrose", name: "Distribution Alpenrose" },
    });
    expect(knownHost.body).toMatchObject({
      host: "distribution-alpenrose.booking.localhost",
      slug: "distribution-alpenrose",
      shouldRedirect: false,
    });
  });

  it("returns not found for custom domains absent from the target repository", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository: {
        async findProfileBySlug(slug) {
          return slug === "hotel-alpenrose" ? seededCustomDomainProfile : null;
        },
        async findProfileByCustomDomain() {
          return null;
        },
      },
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking-web/hosts/book.alpenrose.example",
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns Booking Web hotel projections from the public distribution contract", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-vayada-ratelimit-policy"]).toBe("public-booking-web-profile-read");
    expect(body).toMatchObject({
      contractVersion: "public-bookability.v1",
      publicVisibility: "public_safe",
      hotel: {
        slug: "hotel-alpenrose",
        canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
        capabilities: {
          instantBook: true,
          onlinePayment: true,
          payAtProperty: true,
        },
      },
    });
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("reflects booking-web CORS origins on public hotel routes", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/booking-web/hotels/hotel-alpenrose",
      headers: {
        origin: "https://hotel-alpenrose.booking.vayada.com",
        "access-control-request-method": "GET",
      },
    });
    const read = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose",
      headers: {
        origin: "https://hotel-alpenrose.booking.vayada.com",
      },
    });
    const denied = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose",
      headers: {
        origin: "https://example.com",
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "https://hotel-alpenrose.booking.vayada.com",
    );
    expect(preflight.headers["access-control-allow-methods"]).toBe("GET,POST,OPTIONS");
    expect(read.statusCode).toBe(200);
    expect(read.headers["access-control-allow-origin"]).toBe(
      "https://hotel-alpenrose.booking.vayada.com",
    );
    expect(denied.statusCode).toBe(200);
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reflects next booking-web tenant CORS origins on public hotel routes", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/api/booking-web/hotels/hotel-alpenrose",
      headers: {
        origin: "https://hotel-alpenrose.next-booking.vayada.com",
        "access-control-request-method": "GET",
      },
    });
    const read = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose",
      headers: {
        origin: "https://hotel-alpenrose.next-booking.vayada.com",
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "https://hotel-alpenrose.next-booking.vayada.com",
    );
    expect(read.statusCode).toBe(200);
    expect(read.headers["access-control-allow-origin"]).toBe(
      "https://hotel-alpenrose.next-booking.vayada.com",
    );
  });

  it("returns Booking Web offers from the public quote contract", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/offers?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&currency=EUR&locale=en",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-vayada-ratelimit-policy"]).toBe("public-booking-web-offers-read");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
    expect(body).toMatchObject({
      contractVersion: "public-bookability.v1",
      publicVisibility: "public_safe",
      status: "bookable",
      request: {
        hotelSlug: "hotel-alpenrose",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
      },
      quote: {
        offers: [
          {
            roomTypeId: "room_deluxe",
          },
        ],
      },
    });
    expect(body.quote.offers[0].bookingUrl).toContain(
      "https://hotel-alpenrose.booking.localhost/en/book?",
    );
    expect(body.quote.offers[0].bookingUrl).toContain("room_type=room_deluxe");
    expect(body.quote.offers[0].bookingUrl).toContain("quote_id=quote_alpenrose_001");
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("returns unavailable Booking Web calendar when no target calendar read model is configured", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
      bookingWebPublicNow: () => new Date("2026-06-06T11:00:00.000Z"),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/calendar?start=2026-09-12&end=2026-09-20",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-vayada-ratelimit-policy"]).toBe("public-booking-web-calendar-read");
    expect(body).toEqual({
      contractVersion: "public-bookability.v1",
      generatedAt: "2026-06-06T11:00:00.000Z",
      publicVisibility: "public_safe",
      request: {
        hotelSlug: "hotel-alpenrose",
        start: "2026-09-12",
        end: "2026-09-20",
      },
      calendar: {
        unavailableDates: [
          "2026-09-12",
          "2026-09-13",
          "2026-09-14",
          "2026-09-15",
          "2026-09-16",
          "2026-09-17",
          "2026-09-18",
          "2026-09-19",
        ],
        minStayByArrival: {},
        maxStayByArrival: {},
      },
      freshness: {
        status: "unavailable",
        generatedAt: "2026-06-06T11:00:00.000Z",
        sources: [
          {
            owner: "pms",
            status: "unavailable",
            reasonCode: "source_unavailable",
          },
          {
            owner: "distribution",
            lastUpdatedAt: "2026-06-06T11:00:00.000Z",
            status: "fresh",
          },
        ],
      },
      dataSources: ["pms", "distribution"],
    });
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("serves quote, offers, and calendar routes from target repositories with PMS public API unset", async () => {
    app = buildApp({
      logger: false,
      publicHotelProfileRepository,
      publicHotelQuoteRepository,
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
      bookingWebCalendarRepository: {
        async findCalendarByHotel(hotel, query) {
          return {
            contractVersion: "public-bookability.v1",
            generatedAt: "2026-06-09T09:00:00.000Z",
            publicVisibility: "public_safe",
            request: {
              hotelSlug: hotel.slug,
              start: query.start ?? "",
              end: query.end ?? "",
            },
            calendar: {
              unavailableDates: ["2026-09-14"],
              minStayByArrival: {},
              maxStayByArrival: {},
            },
            freshness: {
              status: "fresh",
              generatedAt: "2026-06-09T09:00:00.000Z",
              sources: [
                {
                  owner: "pms",
                  lastUpdatedAt: "2026-06-09T09:00:00.000Z",
                  status: "fresh",
                },
                {
                  owner: "distribution",
                  lastUpdatedAt: "2026-06-09T09:00:00.000Z",
                  status: "fresh",
                },
              ],
            },
            dataSources: ["pms", "distribution"],
          };
        },
      },
    });

    const quote = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&currency=EUR&locale=en&referral_code=creator-anna",
    });
    const offers = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/offers?check_in=2026-09-12&check_out=2026-09-15&adults=2&children=0&rooms=1&currency=EUR&locale=en&referral_code=creator-anna",
    });
    const calendar = await app.inject({
      method: "GET",
      url: "/api/booking-web/hotels/hotel-alpenrose/calendar?start=2026-09-12&end=2026-09-15",
    });

    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({ status: "bookable" });
    expect(offers.statusCode).toBe(200);
    expect(offers.json()).toMatchObject({ status: "bookable" });
    expect(calendar.statusCode).toBe(200);
    expect(calendar.json()).toMatchObject({
      calendar: { unavailableDates: ["2026-09-14"] },
      freshness: { status: "fresh" },
    });
  });

  it("strips non-contract fields before returning public AI hotel quotes", async () => {
    const pollutedQuote = {
      ...seededPublicQuote,
      quote: {
        ...seededPublicQuote.quote!,
        providerAccountId: "acct_private",
        offers: [
          {
            ...seededPublicQuote.quote!.offers[0],
            internalRatePlanPayload: "private",
          },
        ],
      },
      debugPayload: { webhookPayload: "private" },
    } as unknown as typeof seededPublicQuote;
    app = buildApp({
      logger: false,
      publicHotelQuoteRepository: {
        async findQuoteBySlug() {
          return pollutedQuote;
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose/quote?check_in=2026-09-12&check_out=2026-09-15&adults=2",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).not.toHaveProperty("debugPayload");
    expect(body.quote).not.toHaveProperty("providerAccountId");
    expect(body.quote.offers[0]).not.toHaveProperty("internalRatePlanPayload");
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("strips non-contract fields before returning public AI hotel profiles", async () => {
    const pollutedProfile = {
      ...seededPublicProfile,
      hotel: {
        ...seededPublicProfile.hotel,
        searchScore: 0.99,
        images: [
          {
            ...seededPublicProfile.hotel.images[0],
            internalCdnKey: "private",
          },
        ],
      },
      debugPayload: { providerAccountId: "acct_private" },
    } as unknown as typeof seededPublicProfile;
    app = buildApp({
      logger: false,
      publicHotelProfileRepository: {
        async findProfileBySlug() {
          return pollutedProfile;
        },
      },
      bookingWebCheckoutAdapter: unusedBookingWebCheckoutAdapter,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/ai/hotels/hotel-alpenrose",
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).not.toHaveProperty("debugPayload");
    expect(body.hotel).not.toHaveProperty("searchScore");
    expect(body.hotel.images[0]).not.toHaveProperty("internalCdnKey");
    expect(findForbiddenPublicBookabilityKeys(body)).toEqual([]);
  });

  it("builds a public profile projection from the legacy Booking compatibility adapter", () => {
    const projection = toPublicHotelProfileProjection(
      {
        id: "booking_hotel_alpenrose",
        name: "Hotel Alpenrose",
        slug: "hotel-alpenrose",
        description: "A public alpine profile.",
        location: "Innsbruck",
        country: "AT",
        currency: "EUR",
        supported_currencies: ["USD"],
        hero_image: "https://cdn.vayada.example/hotel.jpg",
        images: ["https://cdn.vayada.example/room.jpg"],
        amenities: ["wifi", "breakfast"],
        check_in_time: "15:00",
        check_out_time: "11:00",
        timezone: "Europe/Vienna",
        default_language: "en",
        supported_languages: ["de"],
        custom_domain: "book.alpenrose.example",
        instant_book: true,
        online_card_payment: true,
        pay_at_property_enabled: true,
        free_cancellation_days: 7,
        terms_text: "Public terms",
        cancellation_policy_text: "",
        updated_at: "2026-06-06T10:00:00.000Z",
      },
      "2026-06-06T11:00:00.000Z",
    );

    expect(projection).toMatchObject({
      contractVersion: "public-bookability.v1",
      hotel: {
        propertyId: "booking_hotel_alpenrose",
        slug: "hotel-alpenrose",
        canonicalUrl: "https://book.alpenrose.example/en",
        bookingBaseUrl: "https://book.alpenrose.example",
        customDomainUrl: "https://book.alpenrose.example",
        timezone: "Europe/Vienna",
        defaultLocale: "en",
        supportedLocales: ["en", "de"],
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR", "USD"],
        location: { country: "AT", city: "Innsbruck" },
        capabilities: {
          instantBook: true,
          onlinePayment: true,
          payAtProperty: true,
        },
        trust: {
          profileComplete: true,
          profileVerified: true,
          domainVerified: true,
          bookabilityStatus: "unavailable",
          reasonCodes: ["unavailable_data"],
        },
      },
    });
    expect(serializePublicHotelProfileProjection(projection)).toEqual(projection);
  });

  it("normalizes invalid public AI quote requests through the compatibility adapter", () => {
    const projection = toUnavailablePublicHotelQuoteProjection(
      seededPublicProfile.hotel,
      {
        check_in: "2026-09-15",
        check_out: "2026-09-12",
        adults: "2",
        currency: "EUR",
        locale: "en",
      },
      new Date("2026-06-06T11:00:00.000Z"),
    );

    expect(projection).toMatchObject({
      status: "unavailable",
      request: {
        hotelSlug: "hotel-alpenrose",
        checkIn: "2026-09-15",
        checkOut: "2026-09-12",
        nights: 0,
        adults: 2,
        currency: "EUR",
        locale: "en",
      },
      unavailableReasons: [{ code: "invalid_request" }],
    });
    expect(serializePublicHotelQuoteProjection(projection)).toEqual(projection);
  });

  it("uses hotel quote limits for public AI quote unavailable reasons", () => {
    const projection = toUnavailablePublicHotelQuoteProjection(
      seededPublicProfile.hotel,
      {
        check_in: "2026-06-07",
        check_out: "2026-06-09",
        adults: "20",
        children: "1",
        rooms: "6",
        currency: "USD",
        locale: "it",
      },
      new Date("2026-06-06T11:00:00.000Z"),
    );

    expect(projection.unavailableReasons.map((reason) => reason.code)).toEqual([
      "unsupported_occupancy",
      "currency_not_supported",
      "locale_not_supported",
    ]);
    expect(findForbiddenPublicBookabilityKeys(projection)).toEqual([]);
  });

  it("does not silently default malformed public AI quote counts", () => {
    const projection = toUnavailablePublicHotelQuoteProjection(
      seededPublicProfile.hotel,
      {
        check_in: "2026-09-12",
        check_out: "2026-09-15",
        adults: "two",
        children: "-1",
        rooms: "1.5",
      },
      new Date("2026-06-06T11:00:00.000Z"),
    );

    expect(projection.unavailableReasons).toEqual([
      {
        code: "invalid_request",
        detail: "adults, children, and rooms must be non-negative integers.",
      },
    ]);
  });

  it("wires authorization into authenticated API context resolution", async () => {
    app = buildApp({
      logger: false,
      auth: {
        verifier: createFakeVerifier(new Map([["valid-token", session]])),
        repository: identityRepository,
        rolePermissionRepository: {
          async findPermissionsForRole(kind, roleKey) {
            expect(kind).toBe("hotel_group");
            expect(roleKey).toBe("hotel_owner");
            return ["booking.settings.manage"];
          },
        },
        entitlementRepository: {
          async findEntitlementsForContext(context) {
            expect(context.selectedOrganization.organizationId).toBe("org_hotel_group");
            return [
              {
                product: "booking",
                key: "booking-engine",
                status: "active",
              },
            ];
          },
        },
      },
    });

    app.get("/protected-context", async (request) => {
      const context = requireAuthContext(request);
      return {
        userId: context.actor.internalUserId,
        permissions: context.membership.permissions,
        entitlements: context.entitlements,
      };
    });

    const response = await injectJson<{
      userId: string;
      permissions: string[];
      entitlements: Array<{ product: string; key: string; status: string }>;
    }>(app, {
      method: "GET",
      url: "/protected-context",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      userId: "user_hotel_owner",
      permissions: ["booking.settings.manage"],
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "active",
        },
      ],
    });
  });

  it("returns unavailable data instead of shifting quote dates for an invalid timezone", () => {
    const projection = toUnavailablePublicHotelQuoteProjection(
      { ...seededPublicProfile.hotel, timezone: "Mars/Olympus_Mons" },
      {
        check_in: "2026-09-12",
        check_out: "2026-09-15",
        adults: "2",
      },
      new Date("2026-06-06T11:00:00.000Z"),
    );

    expect(projection).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: "unavailable_data" }],
    });
  });

  it("returns booking addon settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      showAddonsStep: false,
      groupAddonsByCategory: true,
    });
  });

  it("resolves the canonical property link for a booking hotel", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/property-link",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      hotelId: "booking_hotel_alpenrose",
      propertyId: pmsPropertyId,
      resourceLinks: {
        bookingHotel: true,
        pmsProperty: true,
        financeProperty: true,
      },
    });
  });

  it("reads and updates canonical booking acceptance through Booking Admin", async () => {
    let acceptanceMode: "instant" | "request" = "request";
    const published: string[] = [];
    app = buildAuthenticatedApp({
      linkedPmsPropertyId: null,
      bookingAcceptanceSettings: {
        async findAcceptanceMode(propertyId) {
          expect(propertyId).toBe(pmsPropertyId);
          return acceptanceMode;
        },
        async updateAcceptanceMode(propertyId, nextMode) {
          expect(propertyId).toBe(pmsPropertyId);
          acceptanceMode = nextMode;
          return acceptanceMode;
        },
      },
      publicBookabilityPublisher: {
        async publish({ propertyId }) {
          published.push(propertyId);
          return null;
        },
      },
    });

    const read = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/booking-acceptance",
      headers: { authorization: "Bearer valid-token" },
    });
    const update = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/booking-acceptance",
      payload: { acceptanceMode: "instant" },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(read.statusCode).toBe(200);
    expect(read.body).toEqual({
      contractVersion: "booking-acceptance.v1",
      propertyId: pmsPropertyId,
      acceptanceMode: "request",
      instantBook: false,
    });
    expect(update.statusCode).toBe(200);
    expect(update.body).toMatchObject({ acceptanceMode: "instant", instantBook: true });
    expect(published).toEqual([pmsPropertyId]);
  });

  it("publishes Booking setup through the canonical Distribution command boundary", async () => {
    const publishedPropertyIds: string[] = [];
    const projectedPropertyIds: string[] = [];
    app = buildAuthenticatedApp({
      publicBookabilityPublisher: {
        async publish({ propertyId }) {
          publishedPropertyIds.push(propertyId);
          return {
            propertyId,
            canonicalSlug: "hotel-alpenrose",
            canonicalUrl: "https://hotel-alpenrose.booking.localhost/de",
            bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
            profileStatus: "public",
            freshnessStatus: publishedPropertyIds.length === 1 ? "unavailable" : "fresh",
            missingReadiness: publishedPropertyIds.length === 1 ? ["availability"] : [],
          };
        },
      },
      pmsInventoryPublicOfferProjector: {
        async projectPending({ propertyId }) {
          projectedPropertyIds.push(propertyId);
          return {
            profileAvailable: true,
            pendingEvents: 1,
            projectedOfferDays: 2,
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/public-bookability",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(publishedPropertyIds).toEqual([pmsPropertyId, pmsPropertyId]);
    expect(projectedPropertyIds).toEqual([pmsPropertyId]);
    expect(response.body).toEqual({
      propertyId: pmsPropertyId,
      canonicalSlug: "hotel-alpenrose",
      canonicalUrl: "https://hotel-alpenrose.booking.localhost/de",
      bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
      profileStatus: "public",
      freshnessStatus: "fresh",
      missingReadiness: [],
    });
  });

  it("returns booking property settings with auth, policy, and the legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/property",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      id: "booking_hotel_alpenrose",
      slug: "hotel-alpenrose",
      property_name: "Hotel Alpenrose",
      reservation_email: "reservations@alpenrose.example",
      phone_number: "+43 1 2345",
      whatsapp_number: "+43 1 6789",
      address: "Alpenweg 1, Innsbruck",
      city: "Innsbruck",
      country: "AT",
      default_currency: "CHF",
      default_language: "de",
      supported_currencies: ["CHF", "EUR"],
      supported_languages: ["de", "en"],
      check_in_time: "15:00",
      check_out_time: "11:00",
      pay_at_property_enabled: true,
      pay_at_hotel_methods: ["cash"],
      online_card_payment: true,
      bank_transfer: true,
      special_requests_enabled: false,
      arrival_time_enabled: true,
      guest_count_enabled: true,
      terms_text: "Alpenrose booking terms.",
      cancellation_policy_text: "Free cancellation until seven days before arrival.",
    });
  });

  it("updates booking property settings from the legacy-compatible admin payload", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/property",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        property_name: "Updated Alpenrose",
        reservation_email: "new-reservations@alpenrose.example",
        phone_number: "+43 1 9999",
        whatsapp_number: "+43 1 8888",
        address: "Updated street 1",
        city: "Innsbruck",
        country: "AT",
        instagram: "https://instagram.com/updated-alpenrose",
        facebook: "https://facebook.com/updated-alpenrose",
        tiktok: "https://tiktok.com/@updated-alpenrose",
        youtube: "https://youtube.com/@updated-alpenrose",
        default_currency: " eur ",
        default_language: "en-US",
        supported_currencies: ["CHF", "EUR"],
        supported_languages: ["de", "en-US"],
        check_in_time: "16:00",
        check_out_time: "10:00",
        special_requests_enabled: true,
        arrival_time_enabled: false,
        guest_count_enabled: false,
        terms_text: "Updated Alpenrose booking terms.",
        cancellation_policy_text: "Free cancellation until one day before arrival.",
        pay_at_property_enabled: true,
        pay_at_hotel_methods: ["cash", "card"],
        online_card_payment: true,
        bank_transfer: true,
        paypal_enabled: false,
        billing_pending_switch: "",
        points_of_interest: [],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      id: "booking_hotel_alpenrose",
      property_name: "Updated Alpenrose",
      reservation_email: "new-reservations@alpenrose.example",
      phone_number: "+43 1 9999",
      whatsapp_number: "+43 1 8888",
      address: "Updated street 1",
      city: "Innsbruck",
      country: "AT",
      instagram: "https://instagram.com/updated-alpenrose",
      facebook: "https://facebook.com/updated-alpenrose",
      tiktok: "https://tiktok.com/@updated-alpenrose",
      youtube: "https://youtube.com/@updated-alpenrose",
      default_currency: "EUR",
      default_language: "en-US",
      supported_currencies: ["CHF"],
      supported_languages: ["de"],
      check_in_time: "16:00",
      check_out_time: "10:00",
      pay_at_property_enabled: true,
      pay_at_hotel_methods: ["cash", "card"],
      online_card_payment: true,
      bank_transfer: true,
      special_requests_enabled: true,
      arrival_time_enabled: false,
      guest_count_enabled: false,
      terms_text: "Updated Alpenrose booking terms.",
      cancellation_policy_text: "Free cancellation until one day before arrival.",
    });
  });

  it("rejects invalid booking property settings payloads", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/property",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        property_name: " ",
        default_currency: "euro",
        check_in_time: "25:00",
        instagram: "@alpenrose",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({
      code: "invalid_payload",
      category: "validation",
    });
  });

  it("reads and updates Booking design settings independently from shared hotel fields", async () => {
    app = buildAuthenticatedApp();
    const url = "/api/booking/hotels/booking_hotel_alpenrose/settings/design";

    const readResponse = await injectJson(app, {
      method: "GET",
      url,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(readResponse.statusCode).toBe(200);
    expect(readResponse.body).toEqual({
      headerLogo: "https://cdn.vayada.example/alpenrose/header-logo.webp",
      headerLogoMediaObjectId: bookingHeaderLogoMediaObjectId,
      heroImage: "https://cdn.vayada.example/alpenrose/booking-hero.jpg",
      heroHeading: "Stay above the clouds",
      heroSubtext: "An independent alpine escape.",
      primaryColor: "#2563EB",
      fontPairing: "modern-minimalist",
    });

    const writeResponse = await injectJson(app, {
      method: "PATCH",
      url,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        headerLogoMediaObjectId: bookingHeaderLogoMediaObjectId,
        heroHeading: "Book the mountain directly",
        primaryColor: "#0F766E",
        fontPairing: "grand-classic",
      },
    });
    expect(writeResponse.statusCode).toBe(200);
    expect(writeResponse.body).toEqual({
      headerLogo: "https://cdn.vayada.example/alpenrose/new-logo.webp",
      headerLogoMediaObjectId: bookingHeaderLogoMediaObjectId,
      heroImage: "https://cdn.vayada.example/alpenrose/booking-hero.jpg",
      heroHeading: "Book the mountain directly",
      heroSubtext: "An independent alpine escape.",
      primaryColor: "#0F766E",
      fontPairing: "grand-classic",
    });
  });

  it("rejects invalid Booking design settings", async () => {
    app = buildAuthenticatedApp();
    const response = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/design",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        headerLogo: "https://tracker.example/logo.svg",
        headerLogoMediaObjectId: "not-a-media-id",
        heroImage: "javascript:alert(document.domain)",
        primaryColor: "blue",
        fontPairing: "comic-sans",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({
      code: "invalid_payload",
      category: "validation",
      details: expect.arrayContaining([
        "headerLogo is not allowed.",
        "headerLogoMediaObjectId must be a UUID or null.",
        "heroImage must be an http or https URL.",
      ]),
    });
  });

  it("returns booking guest-form settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      specialRequestsEnabled: false,
      arrivalTimeEnabled: true,
      guestCountEnabled: true,
      phoneRequired: false,
      adultAgeThreshold: 21,
      childrenEnabled: false,
    });
  });

  it("returns booking benefits settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: ["Free breakfast", "Late checkout"],
    });
  });

  it("returns booking localization settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      defaultCurrency: "CHF",
      defaultLanguage: "de",
      supportedCurrencies: ["CHF", "EUR"],
      supportedLanguages: ["de", "en"],
    });
  });

  it("returns booking room-filter settings with auth, policy, and the documented legacy-compatible shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: ["oceanView", "spa_access"],
      customFilters: {
        spa_access: "Spa access",
      },
      filterRooms: {
        oceanView: ["room_101", "room_102"],
        spa_access: ["room_102"],
      },
    });
  });

  it("returns booking last-minute settings with auth, policy, and the documented shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/last-minute",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      enabled: true,
      stackWithPromo: false,
      tiers: [{ daysBeforeMin: 0, daysBeforeMax: 2, discountPercent: 30 }],
      updatedAt: "2026-06-22T10:00:00.000Z",
    });
  });

  it("rejects booking last-minute settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/last-minute",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  const settingsWriteCases = [
    {
      name: "add-on display",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      payload: {
        showAddonsStep: false,
        groupAddonsByCategory: true,
      },
      expected: {
        showAddonsStep: false,
        groupAddonsByCategory: true,
      },
    },
    {
      name: "guest-form",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      payload: {
        specialRequestsEnabled: true,
        arrivalTimeEnabled: false,
        guestCountEnabled: true,
        phoneRequired: false,
        adultAgeThreshold: 21,
        childrenEnabled: false,
      },
      expected: {
        specialRequestsEnabled: true,
        arrivalTimeEnabled: false,
        guestCountEnabled: true,
        phoneRequired: false,
        adultAgeThreshold: 21,
        childrenEnabled: false,
      },
    },
    {
      name: "benefits",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      payload: {
        benefits: [" Free breakfast ", "Late checkout"],
      },
      expected: {
        benefits: ["Free breakfast", "Late checkout"],
      },
    },
    {
      name: "localization",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      payload: {
        defaultCurrency: " eur ",
        defaultLanguage: " en ",
        supportedCurrencies: ["eur", " usd "],
        supportedLanguages: ["en", "de"],
      },
      expected: {
        defaultCurrency: "EUR",
        defaultLanguage: "en",
        supportedCurrencies: ["USD"],
        supportedLanguages: ["de"],
      },
    },
    {
      name: "last-minute",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/last-minute",
      payload: {
        enabled: true,
        stackWithPromo: false,
        tiers: [
          { daysBeforeMin: 7, daysBeforeMax: 13, discountPercent: 10 },
          { daysBeforeMin: 0, daysBeforeMax: 2, discountPercent: 30 },
        ],
      },
      expected: {
        enabled: true,
        stackWithPromo: false,
        tiers: [
          { daysBeforeMin: 7, daysBeforeMax: 13, discountPercent: 10 },
          { daysBeforeMin: 0, daysBeforeMax: 2, discountPercent: 30 },
        ],
        updatedAt: "2026-06-22T10:00:00.000Z",
      },
    },
    {
      name: "room-filter",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      payload: {
        bookingFilters: [" oceanView ", "spa_access"],
        customFilters: {
          " spa_access ": " Spa access ",
        },
        filterRooms: {
          " oceanView ": [" room_101 "],
          spa_access: [" room_102 "],
        },
      },
      expected: {
        bookingFilters: ["oceanView", "spa_access"],
        customFilters: {
          spa_access: "Spa access",
        },
        filterRooms: {
          oceanView: ["room_101"],
          spa_access: ["room_102"],
        },
      },
    },
  ] as const;

  for (const writeCase of settingsWriteCases) {
    it(`updates booking ${writeCase.name} settings with the typed write contract`, async () => {
      app = buildAuthenticatedApp();

      const response = await injectJson(app, {
        method: "PUT",
        url: writeCase.url,
        headers: {
          authorization: "Bearer valid-token",
        },
        payload: writeCase.payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual(writeCase.expected);
    });
  }

  it("refreshes public Distribution after the canonical booking currency changes", async () => {
    const published: string[] = [];
    app = buildAuthenticatedApp({
      publicBookabilityPublisher: {
        async publish({ propertyId }) {
          published.push(propertyId);
          return {
            propertyId,
            canonicalSlug: "hotel-alpenrose",
            canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
            bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
            profileStatus: "public",
            freshnessStatus: "fresh",
            missingReadiness: [],
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        defaultCurrency: "USD",
        defaultLanguage: "en",
        supportedCurrencies: ["USD"],
        supportedLanguages: ["en"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(published).toEqual([pmsPropertyId]);
  });

  it("preserves guest-form phoneRequired when older clients save five-field payloads", async () => {
    let written: unknown;
    app = buildAuthenticatedApp({
      settingsWriteRepository: {
        ...bookingSettingsWriteRepository,
        async updateGuestFormSettingsByHotelId(hotelId, settings) {
          expect(hotelId).toBe("booking_hotel_alpenrose");
          written = settings;
          return { ...settings, phoneRequired: false };
        },
      },
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        specialRequestsEnabled: true,
        arrivalTimeEnabled: false,
        guestCountEnabled: true,
        adultAgeThreshold: 18,
        childrenEnabled: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(written).toEqual({
      specialRequestsEnabled: true,
      arrivalTimeEnabled: false,
      guestCountEnabled: true,
      adultAgeThreshold: 18,
      childrenEnabled: true,
    });
    expect(response.body).toEqual({
      specialRequestsEnabled: true,
      arrivalTimeEnabled: false,
      guestCountEnabled: true,
      phoneRequired: false,
      adultAgeThreshold: 18,
      childrenEnabled: true,
    });
  });

  it("saves guest-form phoneRequired without reading current settings", async () => {
    let written: unknown;
    app = buildAuthenticatedApp({
      settingsRepository: {
        ...bookingSettingsRepository,
        async findGuestFormSettingsByHotelId() {
          throw new Error("read repository should not be used for guest-form writes");
        },
      },
      settingsWriteRepository: {
        ...bookingSettingsWriteRepository,
        async updateGuestFormSettingsByHotelId(hotelId, settings) {
          expect(hotelId).toBe("booking_hotel_alpenrose");
          written = settings;
          return settings;
        },
      },
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        specialRequestsEnabled: true,
        arrivalTimeEnabled: false,
        guestCountEnabled: true,
        phoneRequired: true,
        adultAgeThreshold: 18,
        childrenEnabled: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(written).toMatchObject({ phoneRequired: true });
    expect(response.body).toMatchObject({ phoneRequired: true });
  });

  const invalidSettingsWriteCases = [
    {
      name: "add-on display",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      payload: {
        showAddonsStep: true,
      },
    },
    {
      name: "guest-form",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      payload: {
        specialRequestsEnabled: true,
        arrivalTimeEnabled: false,
        guestCountEnabled: true,
        phoneRequired: true,
        adultAgeThreshold: 18,
        childrenEnabled: true,
        legacyField: true,
      },
    },
    {
      name: "guest-form guest-type",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      payload: {
        specialRequestsEnabled: true,
        arrivalTimeEnabled: false,
        guestCountEnabled: true,
        phoneRequired: true,
        adultAgeThreshold: 0,
        childrenEnabled: "yes",
      },
    },
    {
      name: "benefits",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      payload: {
        benefits: ["Free breakfast", " Free breakfast "],
      },
    },
    {
      name: "localization",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      payload: {
        defaultCurrency: "euro",
        defaultLanguage: "en",
        supportedCurrencies: [],
        supportedLanguages: [],
      },
    },
    {
      name: "last-minute",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/last-minute",
      payload: {
        enabled: true,
        stackWithPromo: false,
        tiers: [
          { daysBeforeMin: 0, daysBeforeMax: 4, discountPercent: 20 },
          { daysBeforeMin: 4, daysBeforeMax: 7, discountPercent: 15 },
        ],
      },
    },
    {
      name: "room-filter",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      payload: {
        bookingFilters: [],
        customFilters: {
          hidden: "Hidden filter",
        },
        filterRooms: {},
      },
    },
  ] as const;

  for (const writeCase of invalidSettingsWriteCases) {
    it(`rejects invalid booking ${writeCase.name} settings write payloads`, async () => {
      app = buildAuthenticatedApp();

      const response = await injectJson<Record<string, unknown>>(app, {
        method: "PUT",
        url: writeCase.url,
        headers: {
          authorization: "Bearer valid-token",
        },
        payload: writeCase.payload,
      });

      expect(response.statusCode).toBe(422);
      expect(response.body).toMatchObject({
        statusCode: 422,
        code: "invalid_payload",
        category: "validation",
        message: "Booking settings payload is invalid.",
      });
      expect(response.body.details).toEqual(expect.any(Array));
    });
  }

  const addonWritePayload = {
    showAddonsStep: true,
    groupAddonsByCategory: false,
  };

  it("rejects booking settings writes without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      payload: addonWritePayload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking settings writes with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer invalid-token",
      },
      payload: addonWritePayload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking settings writes when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: addonWritePayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking settings writes when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: addonWritePayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking settings writes when entitlement is suspended", async () => {
    app = buildAuthenticatedApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: addonWritePayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking settings writes when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_other/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: addonWritePayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("returns the booking settings write-model not-found contract", async () => {
    app = buildAuthenticatedApp({
      settingsWriteRepository: {
        async updateAddonSettingsByHotelId() {
          return null;
        },
        async updateGuestFormSettingsByHotelId() {
          return null;
        },
        async updateBenefitsSettingsByHotelId() {
          return null;
        },
        async updateLocalizationSettingsByHotelId() {
          return null;
        },
        async updateRoomFilterSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: addonWritePayload,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "not_found",
      category: "write_model",
      message: "Booking settings target not found.",
    });
  });

  it("returns the booking settings write-model unavailable contract", async () => {
    app = buildAuthenticatedApp({
      settingsWriteRepository: {
        async updateAddonSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async updateGuestFormSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async updateBenefitsSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async updateLocalizationSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async updateRoomFilterSettingsByHotelId() {
          throw new Error("database unavailable");
        },
      },
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: addonWritePayload,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "write_model_unavailable",
      category: "write_model",
      message: "Booking settings could not be saved.",
    });
  });

  it("returns an actionable conflict instead of publishing shared private contacts", async () => {
    app = buildAuthenticatedApp({
      settingsWriteRepository: {
        ...bookingSettingsWriteRepository,
        async updatePropertySettingsByHotelId() {
          throw new BookingContactPublicationConflictError();
        },
      },
    });

    const response = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/property",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: { phone_number: "+43 1 2345" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      code: "private_contact_conflict",
      category: "validation",
      message:
        "That contact is stored as private hotel information. Publish it from Hotel setup or use a different Booking contact.",
    });
  });

  it("returns booking custom-domain verification state with auth, policy, and property linkage", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/custom-domain",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      hotelId: "booking_hotel_alpenrose",
      propertyId: "f6853000-0000-0000-0000-000000000001",
      configured: true,
      domain: "book.alpenrose.example",
      status: "verified",
      sslStatus: "active",
      dnsRecords: [
        {
          type: "CNAME",
          name: "book.alpenrose.example",
          value: "custom.booking.vayada.com",
          status: "verified",
        },
      ],
      verificationErrors: [],
      checkedAt: "2026-06-22T10:00:00.000Z",
      updatedAt: "2026-06-22T10:00:00.000Z",
    });
  });

  it("connects booking custom-domain through the typed write contract", async () => {
    const writes: Array<{ hotelId: string; domain: string }> = [];
    app = buildAuthenticatedApp({
      customDomainRepository: {
        ...bookingCustomDomainRepository,
        async upsertForBookingHotelId(hotelId, domain) {
          writes.push({ hotelId, domain });
          return {
            hotelId,
            propertyId: "f6853000-0000-0000-0000-000000000001",
            domain,
            verificationStatus: "pending",
            verifiedAt: null,
            updatedAt: "2026-06-22T10:00:00.000Z",
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/custom-domain",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        domain: " Book.Alpenrose.Example ",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(writes).toEqual([
      {
        hotelId: "booking_hotel_alpenrose",
        domain: "book.alpenrose.example",
      },
    ]);
    expect(response.body).toMatchObject({
      configured: true,
      domain: "book.alpenrose.example",
      status: "pending",
      sslStatus: "pending",
      dnsRecords: [
        {
          type: "CNAME",
          name: "book.alpenrose.example",
          value: "custom.booking.vayada.com",
          status: "pending",
        },
      ],
    });
  });

  it("rejects invalid booking custom-domain payloads", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "PUT",
      url: "/api/booking/hotels/booking_hotel_alpenrose/custom-domain",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        domain: "https://book.alpenrose.example/path",
      },
    });

    expect(response.statusCode).toBe(422);
    const body = response.body as { details: string[] };
    expect(body).toMatchObject({
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      message: "Booking custom-domain payload is invalid.",
    });
    expect(body.details).toContain(
      "domain must be a hostname, not a URL, path, wildcard, localhost, or IP.",
    );
  });

  it("rejects booking custom-domain access when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: null });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/custom-domain",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("disconnects booking custom-domain with the typed write contract", async () => {
    const deletes: string[] = [];
    app = buildAuthenticatedApp({
      customDomainRepository: {
        ...bookingCustomDomainRepository,
        async deleteForBookingHotelId(hotelId) {
          deletes.push(hotelId);
          return true;
        },
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/booking/hotels/booking_hotel_alpenrose/custom-domain",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(deletes).toEqual(["booking_hotel_alpenrose"]);
  });

  it("resolves booking custom-domain target property ids through property_source_links", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: BookingCustomDomainPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ) {
        queries.push({ text, values });
        return {
          rows: [
            {
              hotelId: "booking_hotel_alpenrose",
              propertyId: "f6853000-0000-0000-0000-000000000001",
              domain: null,
              verificationStatus: null,
              verifiedAt: null,
              updatedAt: null,
            } as unknown as T,
          ],
        };
      },
      async end() {},
    };
    const repository = createTargetBookingCustomDomainRepository({
      connectionString: "postgres://target",
      pool,
    });

    await expect(repository.findByBookingHotelId("booking_hotel_alpenrose")).resolves.toMatchObject(
      {
        hotelId: "booking_hotel_alpenrose",
        propertyId: "f6853000-0000-0000-0000-000000000001",
        domain: null,
      },
    );

    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("hotel_catalog.property_source_links");
    expect(queries[0]!.text).toContain("source_table = 'booking_hotels'");
    expect(queries[0]!.values).toEqual(["booking_hotel_alpenrose"]);
  });

  it("resolves booking custom-domain target property ids from direct property UUIDs", async () => {
    const propertyId = "43303cea-963c-445a-9522-a05145fe0918";
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: BookingCustomDomainPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ) {
        queries.push({ text, values });
        return {
          rows: [
            {
              hotelId: propertyId,
              propertyId,
              domain: null,
              verificationStatus: null,
              verifiedAt: null,
              updatedAt: null,
            } as unknown as T,
          ],
        };
      },
      async end() {},
    };
    const repository = createTargetBookingCustomDomainRepository({
      connectionString: "postgres://target",
      pool,
    });

    await expect(repository.findByBookingHotelId(propertyId)).resolves.toMatchObject({
      hotelId: propertyId,
      propertyId,
      domain: null,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]!.text).toContain("hotel_catalog.properties");
    expect(queries[0]!.text).toContain("property.id::text = $1");
    expect(queries[0]!.values).toEqual([propertyId]);
  });

  it("lists booking add-on items with the typed target route", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      addonItems: [bookingAddonItem],
      propertyPlan: commissionPropertyPlan,
    });
  });

  it("returns the booking add-on item read-model not-found contract", async () => {
    app = buildAuthenticatedApp({
      bookingAddonItemsRepository: {
        ...bookingAddonItemsRepository,
        async listAddonItemsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      message: "Booking add-on item target not found.",
    });
  });

  it("returns the booking add-on item read-model unavailable contract", async () => {
    app = buildAuthenticatedApp({
      bookingAddonItemsRepository: {
        ...bookingAddonItemsRepository,
        async listAddonItemsByHotelId() {
          throw new Error("database unavailable");
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking add-on items could not be loaded.",
    });
  });

  it("creates booking add-on items with the typed target route", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        name: "Spa ritual",
        description: "Private treatment.",
        price: "125.50",
        currency: "EUR",
        category: "wellness",
        imageUrl: "https://images.example/spa.jpg",
        duration: "90 min",
        pricingModel: "per_guest",
        publicVisible: false,
        status: "disabled",
        sortOrder: 3,
        ownershipKind: "partner",
        partnerCommissionRate: "18.7500",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      addonItemId: "0f840001-0000-4000-8000-000000000002",
      hotelId: "booking_hotel_alpenrose",
      propertyId: "property_alpenrose",
      name: "Spa ritual",
      description: "Private treatment.",
      price: "125.50",
      currency: "EUR",
      category: "wellness",
      imageUrl: "https://images.example/spa.jpg",
      duration: "90 min",
      pricingModel: "per_guest",
      publicVisible: false,
      status: "disabled",
      sortOrder: 3,
      ownershipKind: "partner",
      partnerCommissionRate: "18.7500",
    });
  });

  it("rejects add-on creation when the property plan limit is reached", async () => {
    app = buildAuthenticatedApp({
      bookingAddonItemsRepository: {
        ...bookingAddonItemsRepository,
        async createAddonItemByHotelId() {
          return {
            outcome: "plan_limit_reached",
            currentCount: 3,
            propertyPlan: commissionPropertyPlan,
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        name: "Spa ritual",
        price: "125.50",
        currency: "EUR",
        category: "wellness",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      code: "plan_limit_reached",
      category: "validation",
      message: "You've reached the 3 add-on limit. Upgrade to the paid plan for up to 9 add-ons.",
      details: {
        feature: "addons",
        plan: "commission",
        currentCount: 3,
        maxAllowed: 3,
      },
    });
  });

  it("updates booking add-on items with the typed target route", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "PATCH",
      url: `/api/booking/hotels/booking_hotel_alpenrose/addon-items/${bookingAddonItem.addonItemId}`,
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        name: "Private transfer",
        price: "55.00",
        pricingModel: "per_guest",
        publicVisible: false,
        ownershipKind: "property",
        partnerCommissionRate: null,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      addonItemId: bookingAddonItem.addonItemId,
      hotelId: "booking_hotel_alpenrose",
      name: "Private transfer",
      price: "55.00",
      pricingModel: "per_guest",
      publicVisible: false,
      ownershipKind: "property",
      partnerCommissionRate: null,
    });
  });

  it("retires booking add-on items instead of deleting historical selections", async () => {
    app = buildAuthenticatedApp();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/booking/hotels/booking_hotel_alpenrose/addon-items/${bookingAddonItem.addonItemId}`,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(204);
  });

  it("returns not found for malformed booking add-on item ids", async () => {
    app = buildAuthenticatedApp();

    const patchResponse = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items/not-a-uuid",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        name: "Private transfer",
      },
    });

    expect(patchResponse.statusCode).toBe(404);
    expect(patchResponse.body).toMatchObject({
      code: "not_found",
      category: "write_model",
    });

    const deleteResponse = await injectJson(app, {
      method: "DELETE",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items/not-a-uuid",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(deleteResponse.statusCode).toBe(404);
    expect(deleteResponse.body).toMatchObject({
      code: "not_found",
      category: "write_model",
    });
  });

  it("rejects booking add-on item reads without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking add-on item writes when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        name: "Spa ritual",
        price: "125.50",
        currency: "EUR",
        category: "wellness",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects invalid booking add-on item payloads", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/addon-items",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        name: "",
        price: "12.345",
        currency: "eur",
        category: "legacy",
        status: "retired",
        legacyField: true,
        ownershipKind: "partner",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      message: "Booking add-on item payload is invalid.",
    });
    expect(response.body.details).toEqual(expect.any(Array));
    expect(response.body.details).toContain(
      "ownershipKind and partnerCommissionRate must be property/null or partner/a 0..100 decimal with at most four decimal places.",
    );
  });

  it("lists booking promo codes with the typed target route", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/promo-codes",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      promoCodes: [bookingPromoCode],
    });
  });

  it("creates booking promo codes with normalized codes through the typed target route", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/promo-codes",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        code: " summer25 ",
        discountType: "percentage",
        discountValue: "25.00",
        validFrom: "2026-07-01",
        validUntil: "2026-08-31",
        isActive: true,
        maxUses: 25,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({
      promoCodeId: "0f850001-0000-4000-8000-000000000002",
      hotelId: "booking_hotel_alpenrose",
      propertyId: "property_alpenrose",
      code: "SUMMER25",
      discountType: "percentage",
      discountValue: "25.00",
      validFrom: "2026-07-01",
      validUntil: "2026-08-31",
      isActive: true,
      maxUses: 25,
    });
  });

  it("updates booking promo codes with the typed target route", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "PATCH",
      url: `/api/booking/hotels/booking_hotel_alpenrose/promo-codes/${bookingPromoCode.promoCodeId}`,
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        code: "EARLY30",
        discountType: "fixed",
        discountValue: "30.00",
        minBookingValue: "250.00",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      promoCodeId: bookingPromoCode.promoCodeId,
      hotelId: "booking_hotel_alpenrose",
      code: "EARLY30",
      discountType: "fixed",
      discountValue: "30.00",
      minBookingValue: "250.00",
    });
  });

  it("accepts booking promo-code patches that are valid against the stored state", async () => {
    const fixedPromoCode: BookingPromoCode = {
      ...bookingPromoCode,
      discountType: "fixed",
    };
    app = buildAuthenticatedApp({
      bookingPromoCodesRepository: {
        ...bookingPromoCodesRepository,
        async listPromoCodesByHotelId(hotelId) {
          expect(hotelId).toBe("booking_hotel_alpenrose");
          return [fixedPromoCode];
        },
        async updatePromoCodeByHotelId(hotelId, promoCodeId, body) {
          expect(hotelId).toBe("booking_hotel_alpenrose");
          expect(promoCodeId).toBe(bookingPromoCode.promoCodeId);
          expect(body).toEqual({ discountType: "fixed" });
          return {
            ...fixedPromoCode,
            ...body,
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "PATCH",
      url: `/api/booking/hotels/booking_hotel_alpenrose/promo-codes/${bookingPromoCode.promoCodeId}`,
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        discountType: "fixed",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      promoCodeId: bookingPromoCode.promoCodeId,
      discountType: "fixed",
    });
  });

  it("rejects booking promo-code patches that violate the stored effective state", async () => {
    app = buildAuthenticatedApp({
      bookingPromoCodesRepository: {
        ...bookingPromoCodesRepository,
        async updatePromoCodeByHotelId() {
          throw new Error("update should not be called");
        },
      },
    });

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "PATCH",
      url: `/api/booking/hotels/booking_hotel_alpenrose/promo-codes/${bookingPromoCode.promoCodeId}`,
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        discountValue: "101.00",
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      message: "Booking promo-code payload is invalid.",
    });
    expect(response.body.details).toEqual(
      expect.arrayContaining(["percentage discountValue must be less than or equal to 100."]),
    );
  });

  it("retires booking promo codes instead of deleting usage history", async () => {
    app = buildAuthenticatedApp();

    const response = await app.inject({
      method: "DELETE",
      url: `/api/booking/hotels/booking_hotel_alpenrose/promo-codes/${bookingPromoCode.promoCodeId}`,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(204);
  });

  it("rejects booking promo-code writes when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/promo-codes",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        code: "SUMMER20",
        discountType: "percentage",
        discountValue: "20.00",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects invalid booking promo-code payloads", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/promo-codes",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        code: "",
        discountType: "percentage",
        discountValue: "101.00",
        validFrom: "2026-08-31",
        validUntil: "2026-07-01",
        maxUses: 0,
        currency: "EUR",
        legacyField: true,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      message: "Booking promo-code payload is invalid.",
    });
    expect(response.body.details).toEqual(
      expect.arrayContaining(["currency is not allowed.", "legacyField is not allowed."]),
    );
  });

  it("rejects oversized booking promo-code numeric fields before target persistence", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson<Record<string, unknown>>(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/promo-codes",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        code: "FIXEDBIG",
        discountType: "fixed",
        discountValue: "10000000000000.00",
        maxUses: 2147483648,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({
      statusCode: 422,
      code: "invalid_payload",
      category: "validation",
      message: "Booking promo-code payload is invalid.",
    });
    expect(response.body.details).toEqual(
      expect.arrayContaining([
        "discountValue must fit NUMERIC(15,2).",
        "maxUses must be an integer from 1 to 2147483647.",
      ]),
    );
  });

  it("returns a conflict when booking promo-code codes are duplicated", async () => {
    app = buildAuthenticatedApp({
      bookingPromoCodesRepository: {
        ...bookingPromoCodesRepository,
        async createPromoCodeByHotelId() {
          throw { code: "23505" };
        },
      },
    });

    const response = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/promo-codes",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        code: "SUMMER20",
        discountType: "percentage",
        discountValue: "20.00",
        maxUses: 1,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      statusCode: 409,
      code: "conflict",
      category: "validation",
      message: "Booking promo-code already exists for this hotel.",
    });
  });

  it("returns booking reservations with auth, policy, and the documented product list shape", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookings: [
        {
          id: "reservation_1",
          bookingReference: "VAY-2026-0001",
          roomTypeId: "room_type_suite",
          roomName: "Suite",
          roomMaxOccupancy: 2,
          totalRoomCapacity: 4,
          guestFirstName: "Ada",
          guestLastName: "Lovelace",
          guestEmail: "ada@example.com",
          guestPhone: "+15555550123",
          guestCountry: "GB",
          guestGender: "",
          guestDateOfBirth: null,
          guestPassportNumber: "",
          specialRequests: "Late arrival",
          estimatedArrivalTime: "21:00",
          numberOfGuests: 2,
          checkIn: "2026-07-10",
          checkOut: "2026-07-12",
          nights: 2,
          adults: 2,
          children: 0,
          nightlyRate: 120.5,
          numberOfRooms: 2,
          totalAmount: 241,
          currency: "EUR",
          status: "confirmed",
          roomId: "room_101",
          roomNumber: "101",
          assignedRooms: [
            {
              roomId: "room_101",
              roomNumber: "101",
              position: 0,
            },
            {
              roomId: "room_102",
              roomNumber: "102",
              position: 1,
            },
          ],
          channel: "direct",
          paymentMethod: "card",
          paymentStatus: "captured",
          depositRequired: false,
          depositPercentage: null,
          depositAmount: 0,
          balanceAmount: 241,
          checkInPendingFlags: [],
          checkedInAt: null,
          checkedOutAt: null,
          hostResponseDeadline: null,
          platformFeeAmount: null,
          affiliateCommissionAmount: null,
          propertyPayoutAmount: null,
          addonIds: ["addon_breakfast"],
          addonNames: ["Breakfast"],
          addonTotal: 30,
          addonQuantities: { addon_breakfast: 2 },
          addonDates: { addon_breakfast: ["2026-07-10"] },
          guestWithdrawn: false,
          promoCode: null,
          promoDiscount: 0,
          lastMinuteDiscountPercent: 0,
          lastMinuteDiscountAmount: 0,
          createdAt: "2026-06-01T12:00:00.000Z",
          updatedAt: "2026-06-02T12:00:00.000Z",
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  it("scopes hotel booking change reads and decisions through Booking authorization", async () => {
    const calls: string[] = [];
    const fingerprints: string[] = [];
    const changeRequest = {
      id: "change-1",
      bookingId: "booking_hotel_alpenrose",
      status: "pending",
    };
    const changeRequestRepository: BookingHotelChangeRequestRepository = {
      async findLatestChangeRequest(propertyId, bookingId) {
        calls.push(`read:${propertyId}:${bookingId}`);
        return changeRequest;
      },
      async acceptChangeRequest(propertyId, bookingId, changeRequestId, context) {
        calls.push(`accept:${propertyId}:${bookingId}:${changeRequestId}:${context.actorUserId}`);
        fingerprints.push(context.fingerprint);
        return { ...changeRequest, status: "approved" };
      },
      async declineChangeRequest(propertyId, bookingId, changeRequestId, note, context) {
        calls.push(
          `decline:${propertyId}:${bookingId}:${changeRequestId}:${note}:${context.actorUserId}`,
        );
        fingerprints.push(context.fingerprint);
        return { ...changeRequest, status: "declined", declineReason: note };
      },
    };
    app = buildAuthenticatedApp({
      changeRequestRepository,
      permissions: ["booking.reservation.read", "pms.booking.update"],
    });

    const read = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations/booking-1/change-request",
      headers: { authorization: "Bearer valid-token" },
    });
    const accept = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations/booking-1/change-request/change-1/accept",
      headers: { authorization: "Bearer valid-token", "idempotency-key": "accept-change-1" },
    });
    const decline = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations/booking-1/change-request/change-1/decline",
      headers: { authorization: "Bearer valid-token", "idempotency-key": "decline-change-1" },
      payload: { reason: " Dates are closed " },
    });
    const ambiguousAccept = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations/booking-1/change-request/accept",
      headers: { authorization: "Bearer valid-token", "idempotency-key": "ambiguous-change" },
    });

    expect(read.statusCode).toBe(200);
    expect(accept.statusCode).toBe(200);
    expect(decline.statusCode).toBe(200);
    expect(ambiguousAccept.statusCode).toBe(404);
    expect(calls).toEqual([
      "read:booking_hotel_alpenrose:booking-1",
      "accept:booking_hotel_alpenrose:booking-1:change-1:user_hotel_owner",
      "decline:booking_hotel_alpenrose:booking-1:change-1:Dates are closed:user_hotel_owner",
    ]);
    expect(fingerprints).toEqual([
      createHash("sha256")
        .update(
          JSON.stringify(["booking_hotel_alpenrose", "booking-1", "change-1", "accept", null]),
        )
        .digest("hex"),
      createHash("sha256")
        .update(
          JSON.stringify([
            "booking_hotel_alpenrose",
            "booking-1",
            "change-1",
            "decline",
            "Dates are closed",
          ]),
        )
        .digest("hex"),
    ]);
  });

  it("denies booking change requests without permission or linked hotel access", async () => {
    const repository: BookingHotelChangeRequestRepository = {
      async findLatestChangeRequest() {
        return null;
      },
      async acceptChangeRequest() {
        return null;
      },
      async declineChangeRequest() {
        return null;
      },
    };
    app = buildAuthenticatedApp({
      changeRequestRepository: repository,
      permissions: ["booking.reservation.read"],
    });

    const missingWritePermission = await injectJson(app, {
      method: "POST",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations/booking-1/change-request/change-1/accept",
      headers: { authorization: "Bearer valid-token" },
    });
    const wrongHotel = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/another-hotel/reservations/booking-1/change-request",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(missingWritePermission.statusCode).toBe(403);
    expect(wrongHotel.statusCode).toBe(403);
  });

  it("sanitizes invalid reservation numeric and date values from read models", () => {
    const response = toBookingReservationReadModel({
      ...reservation,
      roomMaxOccupancy: Number.NaN,
      nightlyRate: "N/A",
      totalAmount: "",
      depositAmount: "not-a-number",
      balanceAmount: Number.POSITIVE_INFINITY,
      checkedInAt: "not-a-date",
      createdAt: "not-a-date",
      updatedAt: new Date("not-a-date"),
    });

    expect(response.roomMaxOccupancy).toBe(1);
    expect(response.totalRoomCapacity).toBe(2);
    expect(response.nightlyRate).toBe(0);
    expect(response.totalAmount).toBe(0);
    expect(response.depositAmount).toBe(0);
    expect(response.balanceAmount).toBe(0);
    expect(response.checkedInAt).toBeNull();
    expect(response.createdAt).toBe("");
    expect(response.updatedAt).toBe("");
  });

  it("returns an empty booking reservation list for an authorized hotel with no rows", async () => {
    app = buildAuthenticatedApp({
      reservationsRepository: {
        async listReservationsByHotelId() {
          return {
            reservations: [],
            total: 0,
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookings: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it("applies booking reservation query defaults and coercion through the route", async () => {
    const observedFilters: BookingReservationListFilters[] = [];

    app = buildAuthenticatedApp({
      reservationsRepository: {
        async listReservationsByHotelId(hotelId, filters) {
          expect(hotelId).toBe("booking_hotel_alpenrose");
          observedFilters.push(filters);

          return {
            reservations: [],
            total: 0,
          };
        },
      },
    });

    const clampedResponse = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations?status=%20confirmed%20&search=%20Ada%20&limit=9999&offset=-5",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(clampedResponse.statusCode).toBe(200);
    expect(clampedResponse.body).toEqual({
      bookings: [],
      total: 0,
      limit: 500,
      offset: 0,
    });

    const defaultedResponse = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations?status=%20%20&search=%20%20&limit=not-a-number&offset=not-a-number",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(defaultedResponse.statusCode).toBe(200);
    expect(defaultedResponse.body).toEqual({
      bookings: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    expect(observedFilters).toEqual([
      {
        status: "confirmed",
        search: "Ada",
        limit: 500,
        offset: 0,
      },
      {
        status: undefined,
        search: undefined,
        limit: 50,
        offset: 0,
      },
    ]);
  });

  it("returns the booking reservation read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      reservationsRepository: {
        async listReservationsByHotelId() {
          throw new Error("database unavailable");
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking reservations are unavailable.",
    });
  });

  it("serves booking reservations from the target read model without the legacy PMS URL", async () => {
    const queries: { text: string; values?: readonly unknown[] }[] = [];
    let poolClosed = false;
    const targetReservation: BookingReservationReadModelRow & {
      propertyId: string;
      guestContactAccepted: boolean;
    } = {
      ...reservation,
      id: "d6000000-0000-0000-0000-000000000682",
      propertyId: "d3000000-0000-0000-0000-000000000682",
      guestContactAccepted: false,
      bookingReference: "B-CHK-682",
      roomTypeId: "f6855000-0000-0000-0000-000000000001",
      roomName: "Alpine Suite",
      roomMaxOccupancy: 3,
      guestFirstName: "Mira",
      guestEmail: "mira.guest@example.test",
      checkIn: "2026-07-01",
      checkOut: "2026-07-04",
      children: 1,
      nightlyRate: "140.00",
      totalAmount: "420.00",
      status: "checked_out",
      roomId: "f6855100-0000-0000-0000-000000000001",
      roomNumber: "301",
      assignedRooms: [
        {
          roomId: "f6855100-0000-0000-0000-000000000002",
          roomNumber: "302",
          position: 1,
        },
      ],
      paymentStatus: "paid",
      depositRequired: true,
      depositPercentage: "30.00",
      depositAmount: "126.00",
      balanceAmount: "0.00",
      checkedInAt: "2026-07-01T15:35:00.000Z",
      checkedOutAt: "2026-07-04T10:15:00.000Z",
      platformFeeAmount: "12.60",
      propertyPayoutAmount: "407.40",
      addonIds: ["addon_breakfast_checkout_682"],
      addonNames: ["Breakfast basket"],
      addonTotal: "45.00",
      addonQuantities: { addon_breakfast_checkout_682: 1 },
      addonDates: { addon_breakfast_checkout_682: ["2026-07-02"] },
      guestWithdrawn: true,
      promoCode: "SUMMER30",
      promoDiscount: "30.00",
    };
    const pool: BookingReservationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<Pick<QueryResult<T>, "rows">> {
        queries.push({ text, values });
        if (text.includes("SELECT plan_key AS plan")) {
          return { rows: [{ plan: "fixed" }] as unknown as T[] };
        }
        if (text.includes("SELECT COUNT(*)::text AS total")) {
          return { rows: [{ total: "1" }] as unknown as T[] };
        }

        return { rows: [targetReservation] as unknown as T[] };
      },
      async end() {
        poolClosed = true;
      },
    };

    app = buildAuthenticatedApp({
      linkedHotelId: "booking_hotel_checkout_alpenrose",
      reservationsRepository: createTargetBookingReservationsReadRepository({
        connectionString: "postgresql://target-db",
        pool,
      }),
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_checkout_alpenrose/reservations?status=checked_out&search=Mira&limit=25&offset=5",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      bookings: [
        {
          id: "d6000000-0000-0000-0000-000000000682",
          bookingReference: "B-CHK-682",
          roomTypeId: "f6855000-0000-0000-0000-000000000001",
          roomName: "Alpine Suite",
          roomMaxOccupancy: 3,
          totalRoomCapacity: 6,
          guestFirstName: "Mira",
          guestEmail: "mira.guest@example.test",
          checkIn: "2026-07-01",
          checkOut: "2026-07-04",
          nights: 3,
          numberOfRooms: 2,
          totalAmount: 420,
          status: "checked_out",
          roomId: "f6855100-0000-0000-0000-000000000001",
          roomNumber: "301",
          assignedRooms: [
            {
              roomId: "f6855100-0000-0000-0000-000000000001",
              roomNumber: "301",
              position: 0,
            },
            {
              roomId: "f6855100-0000-0000-0000-000000000002",
              roomNumber: "302",
              position: 1,
            },
          ],
          paymentMethod: "card",
          paymentStatus: "paid",
          depositRequired: true,
          depositPercentage: 30,
          depositAmount: 126,
          balanceAmount: 0,
          checkedInAt: "2026-07-01T15:35:00.000Z",
          checkedOutAt: "2026-07-04T10:15:00.000Z",
          platformFeeAmount: 12.6,
          propertyPayoutAmount: 407.4,
          addonIds: ["addon_breakfast_checkout_682"],
          addonNames: ["Breakfast basket"],
          addonTotal: 45,
          addonQuantities: { addon_breakfast_checkout_682: 1 },
          addonDates: { addon_breakfast_checkout_682: ["2026-07-02"] },
          guestWithdrawn: true,
          promoCode: "SUMMER30",
          promoDiscount: 30,
        },
      ],
      total: 1,
      limit: 25,
      offset: 5,
    });

    expect(queries).toHaveLength(3);
    const sql = queries.map((query) => query.text).join("\n");
    expect(sql).toContain("FROM booking.guest_bookings booking");
    expect(sql).toContain("hotel_catalog.property_source_links source");
    expect(sql).toContain("pms.operational_booking_assignments");
    expect(sql).toContain("booking.booking_addon_selections");
    expect(sql).toContain("finance.payments");
    expect(sql).toContain("assignment_status IN ('checked_in', 'in_house', 'checked_out')");
    expect(sql).toContain("row_number() OVER");
    expect(sql).toContain("SUM(payment.fee_amount)");
    expect(sql).toContain("jsonb_object_agg(grouped.addon_key, grouped.quantity)");
    expect(sql).not.toContain("FROM bookings b");
    expect(sql).not.toContain("booking_rooms");
    expect(queries[0]?.values).toEqual([
      "booking_hotel_checkout_alpenrose",
      "checked_out",
      "%Mira%",
      25,
      5,
    ]);
    expect(queries[1]?.values).toEqual([
      "booking_hotel_checkout_alpenrose",
      "checked_out",
      "%Mira%",
    ]);
    expect(queries[2]?.text).toContain("FROM finance.billing_entitlements");
    expect(queries[2]?.values).toEqual(["d3000000-0000-0000-0000-000000000682"]);

    await app.close();
    app = null;
    expect(poolClosed).toBe(true);
  });

  it("rejects empty target booking reservations repository connection strings", async () => {
    expect(() => createTargetBookingReservationsReadRepository({ connectionString: " " })).toThrow(
      "Booking reservations repository connectionString must not be empty",
    );
  });

  it("does not close injected public hotel profile pools", async () => {
    let targetPoolClosed = false;
    const targetPool: PublicHotelProfileReadPool = {
      async query<T extends QueryResultRow>() {
        return { rows: [] as T[] };
      },
      async end() {
        targetPoolClosed = true;
      },
    };

    const targetRepository = createTargetPublicHotelProfileRepository({
      connectionString: "postgresql://target-db",
      pool: targetPool,
    });

    await targetRepository.close?.();

    expect(targetPoolClosed).toBe(false);
  });

  it("reads target public hotel profiles from the distribution projection", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: PublicHotelProfileReadPool = {
      async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return {
          rows: [targetPublicHotelProfileRow()] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetPublicHotelProfileRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const profile = await repository.findProfileBySlug("distribution-alpenrose");

    expect(profile).toMatchObject({
      contractVersion: "public-bookability.v1",
      generatedAt: "2026-06-09T09:00:00.000Z",
      hotel: {
        propertyId: "prop_distribution_alpenrose",
        slug: "distribution-alpenrose",
        name: "Distribution Alpenrose",
        canonicalUrl: "https://distribution-alpenrose.booking.localhost/en",
        bookingBaseUrl: "https://distribution-alpenrose.booking.localhost",
        defaultCurrency: "EUR",
        supportedCurrencies: ["EUR", "USD"],
        branding: {
          logoUrl: "https://cdn.vayada.example/hotels/distribution-alpenrose/header-logo.webp",
          heroImage: "https://cdn.vayada.example/hotels/distribution-alpenrose/booking.jpg",
          heroHeading: "Stay in the heart of the Alps",
          heroSubtext: "Book direct for our best available rates.",
          primaryColor: "#3157D5",
          fontPairing: "grand-classic",
        },
        capabilities: {
          instantBook: true,
          onlinePayment: true,
          payAtProperty: true,
          bookingDeepLinks: true,
        },
        supportedQuoteParameters: {
          minRooms: 1,
          maxRooms: 4,
          minAdults: 1,
          maxAdults: 6,
          childrenSupported: true,
          adultAgeThreshold: 18,
          supportedCurrencies: ["EUR", "USD"],
          supportedLocales: ["en", "de"],
        },
        trust: {
          profileComplete: true,
          profileVerified: true,
          bookabilityStatus: "bookable",
          reasonCodes: [],
        },
      },
      dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
    });
    expect(queries[0]?.text).toContain("distribution.public_hotel_bookability_profiles");
    expect(queries[0]?.text).toContain("hotel_catalog.property_slugs");
    expect(queries[0]?.text).toContain("booking.booking_settings");
    expect(queries[0]?.text).toContain('booking_header_logo.public_cdn_url AS "bookingHeaderLogo"');
    expect(queries[0]?.text).toContain("booking_branding.header_logo_media_object_id");
    expect(queries[0]?.text).toContain("media.purpose = 'booking.header_logo'");
    expect(queries[0]?.text).toContain('booking_branding.hero_image_url AS "bookingHeroImage"');
    expect(queries[0]?.text).not.toContain("booking_branding.*");
    expect(queries[0]?.text).not.toContain("booking_branding.benefits");
    expect(queries[0]?.text).toContain("slug_alias.purpose = 'redirect'");
    expect(queries[0]?.values).toEqual(["distribution-alpenrose"]);
    expect(serializePublicHotelProfileProjection(profile!).hotel.branding).toEqual({
      logoUrl: "https://cdn.vayada.example/hotels/distribution-alpenrose/header-logo.webp",
      heroImage: "https://cdn.vayada.example/hotels/distribution-alpenrose/booking.jpg",
      heroHeading: "Stay in the heart of the Alps",
      heroSubtext: "Book direct for our best available rates.",
      primaryColor: "#3157D5",
      fontPairing: "grand-classic",
    });
    expect(findForbiddenPublicBookabilityKeys(profile)).toEqual([]);
  });

  it("reads target public quotes from distribution read models without PMS public API", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: PublicHotelQuoteReadPool = {
      async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return {
          rows: [
            {
              quoteSessionId: "f6898100-0000-0000-0000-000000000001",
              publicQuoteReference: "quote_target_alpenrose",
              quoteHash: "sha256:target-alpenrose",
              requestSnapshot: {},
              quoteStatus: "bookable",
              unavailableReasons: [],
              offers: [
                {
                  offerId: "offer_deluxe_flexible",
                  roomTypeId: "room_deluxe",
                  ratePlanId: "rate_flexible",
                  name: "Deluxe Double Room",
                  locationAddress: "Seestrasse 12, Innsbruck",
                  latitude: 47.2692,
                  longitude: 11.4041,
                  availableRooms: 2,
                  paymentOptions: ["card", "pay_at_property"],
                  totals: {
                    currency: "EUR",
                    roomTotal: 540,
                    taxesAndFees: 54,
                    discounts: 0,
                    grandTotal: 594,
                  },
                  bookingUrl:
                    "https://hotel-alpenrose.booking.localhost/en/book?quote_id=quote_target_alpenrose",
                },
              ],
              totals: {},
              deepLinkUrl:
                "https://hotel-alpenrose.booking.localhost/en/book?quote_id=quote_target_alpenrose",
              priceGuarantee: "expires_at",
              currency: "EUR",
              sourceFreshness: {
                sources: [
                  {
                    owner: "hotel_catalog",
                    status: "fresh",
                    lastUpdatedAt: "2026-06-09T09:00:00.000Z",
                  },
                  {
                    owner: "booking",
                    status: "fresh",
                    lastUpdatedAt: "2026-06-09T09:00:00.000Z",
                  },
                  {
                    owner: "pms",
                    status: "fresh",
                    lastUpdatedAt: "2026-06-09T09:00:00.000Z",
                  },
                  {
                    owner: "finance",
                    status: "fresh",
                    lastUpdatedAt: "2026-06-09T09:00:00.000Z",
                  },
                  {
                    owner: "distribution",
                    status: "fresh",
                    lastUpdatedAt: "2026-06-09T09:00:00.000Z",
                  },
                ],
              },
              freshnessStatus: "fresh",
              dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
              generatedAt: "2026-06-09T09:00:00.000Z",
              expiresAt: "2026-06-09T09:15:00.000Z",
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetPublicHotelQuoteRepository({
      connectionString: "postgresql://target-db",
      profileRepository: publicHotelProfileRepository,
      pool,
      now: () => new Date("2026-06-09T09:00:00.000Z"),
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
      children: "0",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      contractVersion: "public-bookability.v1",
      generatedAt: "2026-06-09T09:00:00.000Z",
      request: {
        hotelSlug: "hotel-alpenrose",
        checkIn: "2026-09-12",
        checkOut: "2026-09-15",
        adults: 2,
        children: 0,
        rooms: 1,
      },
      status: "bookable",
      quote: {
        quoteId: "quote_target_alpenrose",
        offers: [
          {
            offerId: "offer_deluxe_flexible",
            roomTypeId: "room_deluxe",
            locationAddress: "Seestrasse 12, Innsbruck",
            latitude: 47.2692,
            longitude: 11.4041,
            paymentOptions: ["card", "pay_at_property"],
            totals: {
              grandTotal: 594,
            },
          },
        ],
      },
      freshness: {
        status: "fresh",
      },
    });
    expect(queries[0]?.text).toContain("distribution.public_quote_read_models");
    expect(queries[0]?.text).toContain("read_model.expires_at > $11::timestamptz");
    expect(queries[0]?.text).toContain("profile.profile_status = 'public'");
    expect(queries[0]?.text).toContain("profile.expires_at IS NULL");
    expect(queries[0]?.text).toContain("read_model.freshness_status = 'fresh'");
    expect(queries[0]?.text).not.toContain("PMS_PUBLIC_API_URL");
    expect(findForbiddenPublicBookabilityKeys(quote)).toEqual([]);
  });

  it("builds target public quotes from offer snapshots when no quote read model exists", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: PublicHotelQuoteReadPool = {
      async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        if (queries.length === 1) {
          return { rows: [] as unknown as T[] };
        }
        return {
          rows: [
            {
              publicOfferKey: "rt:deluxe:flex",
              roomTypeId: "room_deluxe",
              ratePlanId: "rate_flexible",
              roomSummary: {
                name: "Deluxe Double Room",
                locationAddress: "Seestrasse 12, Innsbruck",
                latitude: 47.2692,
                longitude: 11.4041,
              },
              rateSummary: { refundable: true },
              occupancy: { maxAdults: 2, maxChildren: 1 },
              publicPolicy: { cancellation: "Free cancellation" },
              paymentOptions: ["pay_at_property"],
              availableRooms: "2",
              roomTotal: "540.00",
              taxesAndFees: "54.00",
              discounts: "0.00",
              currency: "EUR",
              sourceFreshness: {
                sources: [{ owner: "pms", status: "fresh" }],
              },
              generatedAt: "2026-06-09T09:00:00.000Z",
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetPublicHotelQuoteRepository({
      connectionString: "postgresql://target-db",
      profileRepository: publicHotelProfileRepository,
      pool,
      now: () => new Date("2026-06-09T09:00:00.000Z"),
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
      children: "0",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "bookable",
      quote: {
        offers: [
          {
            offerId: "rt:deluxe:flex",
            roomTypeId: "room_deluxe",
            ratePlanId: "rate_flexible",
            name: "Deluxe Double Room",
            locationAddress: "Seestrasse 12, Innsbruck",
            latitude: 47.2692,
            longitude: 11.4041,
            availableRooms: 2,
            paymentOptions: ["pay_at_property"],
            totals: {
              roomTotal: 540,
              taxesAndFees: 54,
              grandTotal: 594,
            },
          },
        ],
      },
      freshness: {
        status: "fresh",
      },
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain("distribution.public_quote_read_models");
    expect(queries[1]?.text).toContain("distribution.public_room_offer_snapshots");
    expect(queries[1]?.text).toContain(
      "jsonb_agg(offer.payment_options ORDER BY offer.stay_date)->0",
    );
    expect(queries[1]?.text).not.toContain("array_agg(offer.payment_options");
    expect(queries[1]?.text).toContain("offer.sellable_publicly = TRUE");
    expect(queries[1]?.text).toContain("offer.availability_status IN ('available', 'limited')");
    expect(queries[1]?.text).toContain("offer.available_rooms > 0");
    expect(queries[1]?.text).toContain("offer.freshness_status = 'fresh'");
    expect(queries[1]?.values).toEqual([
      "hotel-alpenrose",
      "2026-09-12",
      "2026-09-15",
      "EUR",
      2,
      0,
      1,
      3,
      "2026-06-09T09:00:00.000Z",
    ]);
    expect(findForbiddenPublicBookabilityKeys(quote)).toEqual([]);
  });

  it("does not serve a cached bookable quote when profile readiness is unavailable", async () => {
    let queryCount = 0;
    const repository = createTargetPublicHotelQuoteRepository({
      connectionString: "postgresql://target-db",
      profileRepository: {
        async findProfileBySlug() {
          return {
            ...seededPublicProfile,
            hotel: {
              ...seededPublicProfile.hotel,
              trust: {
                ...seededPublicProfile.hotel.trust,
                bookabilityStatus: "unavailable",
                reasonCodes: ["payment_disabled"],
              },
            },
          };
        },
      },
      pool: {
        async query<T extends QueryResultRow>() {
          queryCount += 1;
          return { rows: [] as T[] };
        },
        async end() {},
      },
      now: () => new Date("2026-06-09T09:00:00.000Z"),
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
    });

    expect(queryCount).toBe(0);
    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: "payment_disabled" }],
    });
  });

  it("does not expose cached online payment options when only pay-at-property is ready", async () => {
    const repository = createTargetPublicHotelQuoteRepository({
      connectionString: "postgresql://target-db",
      profileRepository: {
        async findProfileBySlug() {
          return {
            ...seededPublicProfile,
            hotel: {
              ...seededPublicProfile.hotel,
              capabilities: {
                ...seededPublicProfile.hotel.capabilities,
                onlinePayment: false,
                payAtProperty: true,
              },
            },
          };
        },
      },
      pool: {
        async query<T extends QueryResultRow>() {
          return {
            rows: [
              {
                quoteSessionId: "f6898100-0000-0000-0000-000000000001",
                publicQuoteReference: "quote_pay_at_property",
                quoteHash: "sha256:pay-at-property",
                requestSnapshot: {},
                quoteStatus: "bookable",
                unavailableReasons: [],
                offers: [
                  {
                    offerId: "offer_deluxe",
                    roomTypeId: "room_deluxe",
                    name: "Deluxe Room",
                    availableRooms: 1,
                    paymentOptions: ["card", "pay_at_property"],
                    totals: {
                      currency: "EUR",
                      roomTotal: 180,
                      taxesAndFees: 18,
                      discounts: 0,
                      grandTotal: 198,
                    },
                  },
                ],
                totals: {},
                deepLinkUrl: "https://hotel-alpenrose.booking.localhost/en/book",
                priceGuarantee: "expires_at",
                currency: "EUR",
                sourceFreshness: {
                  hotel_catalog: { status: "fresh" },
                  booking: { status: "fresh" },
                  pms: { status: "fresh" },
                  finance: { status: "fresh" },
                  distribution: { status: "fresh" },
                },
                freshnessStatus: "fresh",
                dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
                generatedAt: "2026-06-09T09:00:00.000Z",
                expiresAt: "2026-06-09T09:15:00.000Z",
              },
            ] as unknown as T[],
          };
        },
        async end() {},
      },
      now: () => new Date("2026-06-09T09:00:00.000Z"),
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
    });

    expect(quote?.quote?.offers[0]?.paymentOptions).toEqual(["pay_at_property"]);
  });

  it.each([
    {
      caseName: "required source freshness is missing",
      sourceFreshness: {},
      paymentOptions: ["card"],
      reasonCode: "unavailable_data",
    },
    {
      caseName: "the producer supplies no valid payment method",
      sourceFreshness: {
        hotel_catalog: { status: "fresh" },
        booking: { status: "fresh" },
        pms: { status: "fresh" },
        finance: { status: "fresh" },
        distribution: { status: "fresh" },
      },
      paymentOptions: [],
      reasonCode: "payment_disabled",
    },
  ])("fails cached bookable quotes closed when $caseName", async (fixture) => {
    const repository = createTargetPublicHotelQuoteRepository({
      connectionString: "postgresql://target-db",
      profileRepository: publicHotelProfileRepository,
      pool: {
        async query<T extends QueryResultRow>() {
          return {
            rows: [
              {
                quoteSessionId: "f6898100-0000-0000-0000-000000000004",
                publicQuoteReference: "quote_fail_closed",
                quoteHash: "sha256:fail-closed",
                requestSnapshot: {},
                quoteStatus: "bookable",
                unavailableReasons: [],
                offers: [
                  {
                    offerId: "offer_deluxe",
                    roomTypeId: "room_deluxe",
                    name: "Deluxe Room",
                    availableRooms: 1,
                    paymentOptions: fixture.paymentOptions,
                    totals: {
                      currency: "EUR",
                      roomTotal: 180,
                      taxesAndFees: 18,
                      discounts: 0,
                      grandTotal: 198,
                    },
                  },
                ],
                totals: {},
                deepLinkUrl: "https://hotel-alpenrose.booking.localhost/en/book",
                priceGuarantee: "expires_at",
                currency: "EUR",
                sourceFreshness: fixture.sourceFreshness,
                freshnessStatus: "fresh",
                dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
                generatedAt: "2026-06-09T09:00:00.000Z",
                expiresAt: "2026-06-09T09:15:00.000Z",
              },
            ] as unknown as T[],
          };
        },
        async end() {},
      },
      now: () => new Date("2026-06-09T09:00:00.000Z"),
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
    });

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [{ code: fixture.reasonCode }],
    });
    expect(quote?.quote).toBeUndefined();
  });

  it("builds target offer fallback booking URLs from the hotel booking base URL", async () => {
    const customDomainProfile = {
      ...seededPublicProfile,
      hotel: {
        ...seededPublicProfile.hotel,
        bookingBaseUrl: "https://book.alpenrose.example",
      },
    };
    const pool: PublicHotelQuoteReadPool = {
      async query<T extends QueryResultRow>() {
        return {
          rows: [
            {
              quoteSessionId: "f6898100-0000-0000-0000-000000000003",
              publicQuoteReference: "quote_target_fallback_url",
              quoteHash: "sha256:target-fallback-url",
              requestSnapshot: {},
              quoteStatus: "bookable",
              unavailableReasons: [],
              offers: [
                {
                  offerId: "offer_deluxe_flexible",
                  roomTypeId: "room_deluxe",
                  name: "Deluxe Double Room",
                  availableRooms: 2,
                  paymentOptions: ["card"],
                  totals: {
                    currency: "EUR",
                    roomTotal: 540,
                    taxesAndFees: 54,
                    discounts: 0,
                    grandTotal: 594,
                  },
                },
              ],
              totals: {},
              deepLinkUrl: null,
              priceGuarantee: "expires_at",
              currency: "EUR",
              sourceFreshness: {
                hotel_catalog: { status: "fresh" },
                booking: { status: "fresh" },
                pms: { status: "fresh" },
                finance: { status: "fresh" },
                distribution: { status: "fresh" },
              },
              freshnessStatus: "fresh",
              dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
              generatedAt: "2026-06-09T09:00:00.000Z",
              expiresAt: "2026-06-09T09:15:00.000Z",
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetPublicHotelQuoteRepository({
      connectionString: "postgresql://target-db",
      profileRepository: {
        async findProfileBySlug(slug) {
          return slug === customDomainProfile.hotel.slug ? customDomainProfile : null;
        },
      },
      pool,
      now: () => new Date("2026-06-09T09:00:00.000Z"),
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
      children: "0",
      rooms: "1",
      currency: "EUR",
      locale: "en",
      referral_code: "creator-anna",
    });

    const bookingUrl = quote?.quote?.offers[0]?.bookingUrl;
    expect(bookingUrl).toMatch(/^https:\/\/book\.alpenrose\.example\/en\/book\?/);
    expect(bookingUrl).toContain("check_in=2026-09-12");
    expect(bookingUrl).toContain("referral_code=creator-anna");
    expect(bookingUrl).not.toContain("booking.localhost");
  });

  it("preserves public detail for target unavailable quote reasons", async () => {
    const pool: PublicHotelQuoteReadPool = {
      async query<T extends QueryResultRow>() {
        return {
          rows: [
            {
              quoteSessionId: "f6898100-0000-0000-0000-000000000002",
              publicQuoteReference: "quote_target_unavailable_alpenrose",
              quoteHash: "sha256:target-unavailable-alpenrose",
              requestSnapshot: {},
              quoteStatus: "stale",
              unavailableReasons: [
                {
                  code: "stale_data",
                  publicDetail: {
                    sourceOwner: "pms",
                    maximumAgeSeconds: 300,
                  },
                },
              ],
              offers: [],
              totals: {},
              deepLinkUrl: null,
              priceGuarantee: "none",
              currency: "EUR",
              sourceFreshness: {
                sources: [{ owner: "pms", status: "stale", reasonCode: "source_stale" }],
              },
              freshnessStatus: "stale",
              dataSources: ["hotel_catalog", "booking", "pms", "finance", "distribution"],
              generatedAt: "2026-06-09T09:00:00.000Z",
              expiresAt: "2026-06-09T09:15:00.000Z",
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetPublicHotelQuoteRepository({
      connectionString: "postgresql://target-db",
      profileRepository: publicHotelProfileRepository,
      pool,
      now: () => new Date("2026-06-09T09:00:00.000Z"),
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
      children: "0",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "stale",
      unavailableReasons: [
        {
          code: "stale_data",
          detail: '{"sourceOwner":"pms","maximumAgeSeconds":300}',
        },
      ],
      freshness: {
        status: "stale",
      },
    });
    expect(findForbiddenPublicBookabilityKeys(quote)).toEqual([]);
  });

  it("returns unavailable target public quotes when the read model query fails", async () => {
    const pool: PublicHotelQuoteReadPool = {
      async query<T extends QueryResultRow>() {
        throw new Error("target database unavailable");
      },
      async end() {},
    };
    const repository = createTargetPublicHotelQuoteRepository({
      connectionString: "postgresql://target-db",
      profileRepository: publicHotelProfileRepository,
      pool,
      now: () => new Date("2026-06-09T09:00:00.000Z"),
    });

    const quote = await repository.findQuoteBySlug("hotel-alpenrose", {
      check_in: "2026-09-12",
      check_out: "2026-09-15",
      adults: "2",
      children: "0",
      rooms: "1",
      currency: "EUR",
      locale: "en",
    });

    expect(quote).toMatchObject({
      status: "unavailable",
      unavailableReasons: [
        {
          code: "unavailable_data",
          detail: "Public quote read model is not ready yet.",
        },
      ],
      freshness: {
        status: "unavailable",
      },
    });
  });

  it("reads target Booking Web calendar from distribution offer snapshots", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: BookingWebCalendarReadPool = {
      async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return {
          rows: [
            {
              stayDate: "2026-09-12",
              hasAvailability: true,
              hasUnavailableState: false,
              sourceFreshnessValues: [
                JSON.stringify({
                  sources: [{ owner: "pms", status: "fresh" }],
                }),
              ],
              freshnessStatuses: ["fresh"],
              dataSources: ["pms", "distribution"],
              generatedAt: "2026-06-09T09:00:00.000Z",
            },
            {
              stayDate: "2026-09-13",
              hasAvailability: true,
              hasUnavailableState: false,
              sourceFreshnessValues: [
                JSON.stringify({
                  sources: [{ owner: "pms", status: "fresh" }],
                }),
              ],
              freshnessStatuses: ["fresh"],
              dataSources: ["pms", "distribution"],
              generatedAt: "2026-06-09T09:00:00.000Z",
            },
            {
              stayDate: "2026-09-14",
              hasAvailability: false,
              hasUnavailableState: true,
              sourceFreshnessValues: [
                JSON.stringify({
                  sources: [{ owner: "pms", status: "fresh" }],
                }),
              ],
              freshnessStatuses: ["fresh"],
              dataSources: ["pms", "distribution"],
              generatedAt: "2026-06-09T09:00:00.000Z",
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetBookingWebCalendarRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const calendar = await repository.findCalendarByHotel(seededPublicProfile.hotel, {
      start: "2026-09-12",
      end: "2026-09-15",
    });

    expect(calendar).toMatchObject({
      contractVersion: "public-bookability.v1",
      generatedAt: "2026-06-09T09:00:00.000Z",
      request: {
        hotelSlug: "hotel-alpenrose",
        start: "2026-09-12",
        end: "2026-09-15",
      },
      calendar: {
        unavailableDates: ["2026-09-14"],
      },
      freshness: {
        status: "fresh",
      },
      dataSources: ["pms", "distribution"],
    });
    expect(queries[0]?.text).toContain("distribution.public_room_offer_snapshots");
    expect(queries[0]?.text).toContain("profile.profile_status = 'public'");
    expect(queries[0]?.text).toContain("profile.expires_at IS NULL");
    expect(queries[0]?.text).toContain("offer.freshness_status = 'fresh'");
    expect(queries[0]?.values).toEqual([
      seededPublicProfile.hotel.propertyId,
      "hotel-alpenrose",
      "2026-09-12",
      "2026-09-15",
    ]);
    expect(findForbiddenPublicBookabilityKeys(calendar)).toEqual([]);
  });

  it("returns unavailable target Booking Web calendar when the read model query fails", async () => {
    const pool: BookingWebCalendarReadPool = {
      async query<T extends QueryResultRow>() {
        throw new Error("target database unavailable");
      },
      async end() {},
    };
    const repository = createTargetBookingWebCalendarRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const calendar = await repository.findCalendarByHotel(seededPublicProfile.hotel, {
      start: "2026-09-12",
      end: "2026-09-15",
    });

    expect(calendar).toMatchObject({
      request: {
        hotelSlug: "hotel-alpenrose",
        start: "2026-09-12",
        end: "2026-09-15",
      },
      calendar: {
        unavailableDates: ["2026-09-12", "2026-09-13", "2026-09-14"],
      },
      freshness: {
        status: "unavailable",
      },
    });
  });

  it("treats covered but non-sellable Booking Web inventory as unavailable", async () => {
    const pool: BookingWebCalendarReadPool = {
      async query<T extends QueryResultRow>() {
        return {
          rows: [
            {
              stayDate: "2026-09-12",
              hasAvailability: false,
              hasUnavailableState: false,
              sourceFreshnessValues: [
                JSON.stringify({ sources: [{ owner: "pms", status: "fresh" }] }),
              ],
              freshnessStatuses: ["fresh"],
              dataSources: ["pms", "distribution"],
              generatedAt: "2026-06-09T09:00:00.000Z",
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetBookingWebCalendarRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const calendar = await repository.findCalendarByHotel(seededPublicProfile.hotel, {
      start: "2026-09-12",
      end: "2026-09-13",
    });

    expect(calendar.calendar.unavailableDates).toEqual(["2026-09-12"]);
  });

  it("marks target Booking Web calendar unavailable when snapshot coverage is partial", async () => {
    const pool: BookingWebCalendarReadPool = {
      async query<T extends QueryResultRow>() {
        return {
          rows: [
            {
              stayDate: "2026-09-12",
              hasAvailability: true,
              hasUnavailableState: false,
              sourceFreshnessValues: [
                JSON.stringify({ sources: [{ owner: "pms", status: "fresh" }] }),
              ],
              freshnessStatuses: ["fresh"],
              dataSources: ["pms", "distribution"],
              generatedAt: "2026-06-09T09:00:00.000Z",
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetBookingWebCalendarRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const calendar = await repository.findCalendarByHotel(seededPublicProfile.hotel, {
      start: "2026-09-12",
      end: "2026-09-14",
    });

    expect(calendar).toMatchObject({
      request: {
        hotelSlug: "hotel-alpenrose",
        start: "2026-09-12",
        end: "2026-09-14",
      },
      calendar: {
        unavailableDates: ["2026-09-13"],
      },
      freshness: {
        status: "unavailable",
      },
    });
  });

  it("looks up target custom domains through verified property-domain ownership", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool: PublicHotelProfileReadPool = {
      async query<T extends QueryResultRow>(text: string, values?: readonly unknown[]) {
        queries.push({ text, values });
        return { rows: [] as T[] };
      },
      async end() {},
    };
    const repository = createTargetPublicHotelProfileRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    await repository.findProfileByCustomDomain?.("https://Book.Alpenrose.Example/de");

    expect(queries[0]?.text).toContain("hotel_catalog.property_domains");
    expect(queries[0]?.text).toContain("verification_status = 'verified'");
    expect(queries[0]?.text).not.toContain("regexp_replace");
    expect(queries[0]?.values).toEqual(["book.alpenrose.example"]);
  });

  it("rejects empty target public hotel profile repository connection strings", async () => {
    expect(() => createTargetPublicHotelProfileRepository({ connectionString: " " })).toThrow(
      "Target public hotel profile repository connectionString must not be empty",
    );
  });

  it("rejects empty target booking settings repository connection strings", async () => {
    expect(() => createPgTargetBookingSettingsRepository({ connectionString: " " })).toThrow(
      "Target booking settings repository connectionString must not be empty",
    );
  });

  it("rejects empty target booking add-on item repository connection strings", async () => {
    expect(() => createPgTargetBookingAddonItemsRepository({ connectionString: " " })).toThrow(
      "Target booking add-on items repository connectionString must not be empty",
    );
  });

  it("rejects empty target booking promo-code repository connection strings", async () => {
    expect(() => createPgTargetBookingPromoCodesRepository({ connectionString: " " })).toThrow(
      "Target booking promo codes repository connectionString must not be empty",
    );
  });

  it("serves booking settings contracts from the target repository without legacy queries", async () => {
    const queries: { text: string; values?: readonly unknown[] }[] = [];
    let poolClosed = false;
    const state: {
      show_addons_step: boolean;
      group_addons_by_category: boolean;
      special_requests_enabled: boolean;
      arrival_time_enabled: boolean;
      guest_count_enabled: boolean;
      phone_required: boolean;
      adult_age_threshold: number;
      children_enabled: boolean;
      benefits: string[];
      default_currency: string;
      default_language: string;
      supported_currencies: string[];
      supported_languages: string[];
      booking_filters: string[];
      custom_filters: Record<string, string>;
      filter_rooms: Record<string, string[]>;
      header_logo_media_object_id: string | null;
      header_logo_url: string | null;
      hero_image_url: string | null;
      hero_heading: string | null;
      hero_subtext: string | null;
      primary_color: string;
      font_pairing: string;
      last_minute_discount: {
        enabled: boolean;
        stackWithPromo: boolean;
        tiers: Array<{
          daysBeforeMin: number;
          daysBeforeMax: number | null;
          discountPercent: number;
        }>;
      };
      updated_at: string;
    } = {
      show_addons_step: false,
      group_addons_by_category: true,
      special_requests_enabled: false,
      arrival_time_enabled: true,
      guest_count_enabled: true,
      phone_required: true,
      adult_age_threshold: 18,
      children_enabled: true,
      benefits: ["Free breakfast"],
      default_currency: "CHF",
      default_language: "de",
      supported_currencies: ["EUR"],
      supported_languages: ["en"],
      booking_filters: ["oceanView"],
      custom_filters: { oceanView: "Ocean view" },
      filter_rooms: { oceanView: ["room_101"] },
      header_logo_media_object_id: bookingHeaderLogoMediaObjectId,
      header_logo_url: "https://cdn.vayada.example/alpenrose/header-logo.webp",
      hero_image_url: "https://cdn.vayada.example/alpenrose/booking-hero.jpg",
      hero_heading: "Stay above the clouds",
      hero_subtext: "An independent alpine escape.",
      primary_color: "#2563EB",
      font_pairing: "modern-minimalist",
      last_minute_discount: {
        enabled: false,
        stackWithPromo: false,
        tiers: [],
      },
      updated_at: "2026-06-22T10:00:00.000Z",
    };
    const propertyState: {
      id: string;
      property_id: string;
      booking_hotel_id: string | null;
      slug: string;
      property_name: string;
      reservation_email: string | null;
      phone_number: string | null;
      whatsapp_number: string | null;
      address: string | null;
      city: string | null;
      country: string | null;
      instagram: string | null;
      facebook: string | null;
      tiktok: string | null;
      youtube: string | null;
      check_in_time: string | null;
      check_out_time: string | null;
      terms_and_conditions: string | null;
      cancellation_policy_text: string | null;
      accepted_payment_methods: string[];
    } = {
      id: "booking_hotel_alpenrose",
      property_id: "d3000000-0000-0000-0000-000000000682",
      booking_hotel_id: "booking_hotel_alpenrose",
      slug: "hotel-alpenrose",
      property_name: "Hotel Alpenrose",
      reservation_email: "reservations@alpenrose.example",
      phone_number: "+43 1 2345",
      whatsapp_number: "+43 1 6789",
      address: "Alpenweg 1, Innsbruck, AT",
      city: "Innsbruck",
      country: "AT",
      instagram: null as string | null,
      facebook: null as string | null,
      tiktok: null as string | null,
      youtube: null as string | null,
      check_in_time: "15:00",
      check_out_time: "11:00",
      terms_and_conditions: "Hotel Alpenrose booking terms.",
      cancellation_policy_text: "Free cancellation until seven days before arrival.",
      accepted_payment_methods: ["pay_at_property", "manual_card"],
    };
    const pool: BookingSettingsPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<Pick<QueryResult<T>, "rows">> {
        queries.push({ text, values });
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) {
          return { rows: [] };
        }
        if (
          text.includes('source_link_status.property_id::text AS "propertyId"') &&
          !text.includes("finance.payment_settings")
        ) {
          return {
            rows: [
              {
                source_link_count: 1,
                propertyId: propertyState.property_id,
              },
            ] as unknown as T[],
          };
        }
        if (text.includes("FOR UPDATE OF property")) {
          return {
            rows: [
              {
                propertyId: propertyState.property_id,
                publicId: propertyState.id,
                displayName: propertyState.property_name,
                defaultLocale: state.default_language,
                canonicalSlug: propertyState.slug,
              },
            ] as unknown as T[],
          };
        }
        if (
          text.includes("FROM marketplace.marketplace_offers offer") &&
          text.includes('offer.id::text AS "offerId"')
        ) {
          return { rows: [] };
        }
        if (text.includes("INSERT INTO hotel_catalog.property_public_profile_read_model")) {
          return { rows: [] };
        }
        if (text.includes("property.display_name AS property_name")) {
          return {
            rows: [
              {
                source_link_count: 1,
                ...propertyState,
                ...state,
              },
            ] as unknown as T[],
          };
        }
        if (
          text.includes("UPDATE hotel_catalog.properties property") &&
          !text.includes("upserted_booking_description")
        ) {
          const contacts = JSON.parse(values?.[1] as string) as {
            channel_type: string;
            value: string;
          }[];
          for (const contact of contacts) {
            const value = contact.value || null;
            if (contact.channel_type === "email") propertyState.reservation_email = value;
            if (contact.channel_type === "phone") propertyState.phone_number = value;
            if (contact.channel_type === "whatsapp") propertyState.whatsapp_number = value;
            if (contact.channel_type === "instagram") propertyState.instagram = value;
            if (contact.channel_type === "facebook") propertyState.facebook = value;
            if (contact.channel_type === "tiktok") propertyState.tiktok = value;
            if (contact.channel_type === "youtube") propertyState.youtube = value;
          }
          propertyState.check_in_time = values?.[2] as string;
          propertyState.check_out_time = values?.[3] as string;
          propertyState.terms_and_conditions = values?.[4] as string;
          propertyState.cancellation_policy_text = values?.[5] as string;
          state.default_language = values?.[6] as string;
          state.default_currency = values?.[7] as string;
          state.supported_currencies = values?.[8] as string[];
          state.supported_languages = values?.[9] as string[];
          state.special_requests_enabled = values?.[10] as boolean;
          state.arrival_time_enabled = values?.[11] as boolean;
          state.guest_count_enabled = values?.[12] as boolean;
          return {
            rows: [
              {
                source_link_count: 1,
                id: propertyState.id,
                propertyId: propertyState.property_id,
                privateContactConflict: false,
              },
            ] as unknown as T[],
          };
        }
        if (text.includes("finance.payment_settings")) {
          return {
            rows: [
              {
                source_link_count: 1,
                propertyId: "d3000000-0000-0000-0000-000000000682",
                pmsProperty: true,
                financeProperty: true,
              },
            ] as unknown as T[],
          };
        }

        if (text.includes("SET header_logo_media_object_id = CASE")) {
          const design = JSON.parse(values?.[1] as string) as Record<string, string | null>;
          if (
            design.headerLogoMediaObjectId &&
            design.headerLogoMediaObjectId !== bookingHeaderLogoMediaObjectId
          ) {
            return {
              rows: [
                {
                  source_link_count: 1,
                  header_logo_valid: false,
                  settings_property_id: null,
                },
              ] as unknown as T[],
            };
          }
          if (Object.hasOwn(design, "headerLogoMediaObjectId")) {
            state.header_logo_media_object_id = design.headerLogoMediaObjectId;
            state.header_logo_url = design.headerLogoMediaObjectId
              ? "https://cdn.vayada.example/alpenrose/new-logo.webp"
              : null;
          }
          if (Object.hasOwn(design, "heroImage")) state.hero_image_url = design.heroImage || null;
          if (Object.hasOwn(design, "heroHeading")) state.hero_heading = design.heroHeading || null;
          if (Object.hasOwn(design, "heroSubtext")) state.hero_subtext = design.heroSubtext || null;
          if (typeof design.primaryColor === "string") state.primary_color = design.primaryColor;
          if (typeof design.fontPairing === "string") state.font_pairing = design.fontPairing;
        } else if (text.includes("show_addons_step = $2")) {
          state.show_addons_step = values?.[1] as boolean;
          state.group_addons_by_category = values?.[2] as boolean;
        } else if (text.includes("special_requests_enabled = $2")) {
          state.special_requests_enabled = values?.[1] as boolean;
          state.arrival_time_enabled = values?.[2] as boolean;
          state.guest_count_enabled = values?.[3] as boolean;
          state.phone_required = values?.[4] as boolean;
          state.adult_age_threshold = values?.[5] as number;
          state.children_enabled = values?.[6] as boolean;
        } else if (text.includes("benefits = $2::jsonb")) {
          state.benefits = JSON.parse(values?.[1] as string) as string[];
        } else if (text.includes("default_currency = $2")) {
          state.default_currency = values?.[1] as string;
          state.default_language = values?.[2] as string;
          state.supported_currencies = values?.[3] as string[];
          state.supported_languages = values?.[4] as string[];
        } else if (text.includes("booking_filters = $2::jsonb")) {
          state.booking_filters = JSON.parse(values?.[1] as string) as string[];
          state.custom_filters = JSON.parse(values?.[2] as string) as Record<string, string>;
          state.filter_rooms = JSON.parse(values?.[3] as string) as Record<string, string[]>;
        } else if (
          [
            "header_logo_url",
            "hero_image_url",
            "hero_heading",
            "hero_subtext",
            "primary_color",
            "font_pairing",
          ].some((column) => text.includes(`${column} = $`))
        ) {
          for (const [column, stateKey] of [
            ["header_logo_url", "header_logo_url"],
            ["hero_image_url", "hero_image_url"],
            ["hero_heading", "hero_heading"],
            ["hero_subtext", "hero_subtext"],
            ["primary_color", "primary_color"],
            ["font_pairing", "font_pairing"],
          ] as const) {
            const parameter = text.match(new RegExp(`${column} = \\$(\\d+)`));
            if (parameter) {
              Object.assign(state, { [stateKey]: values?.[Number(parameter[1]) - 1] });
            }
          }
        } else if (text.includes("last_minute_discount = $2::jsonb")) {
          state.last_minute_discount = JSON.parse(
            values?.[1] as string,
          ) as typeof state.last_minute_discount;
        }

        return {
          rows: [
            {
              source_link_count: 1,
              header_logo_valid: true,
              settings_property_id: "d3000000-0000-0000-0000-000000000682",
              ...state,
            },
          ] as unknown as T[],
        };
      },
      async connect() {
        return {
          query: pool.query.bind(pool),
          release() {},
        };
      },
      async end() {
        poolClosed = true;
      },
    };

    const targetRepository = createPgTargetBookingSettingsRepository({
      connectionString: "postgresql://target-db",
      pool,
    });
    app = buildAuthenticatedApp({
      settingsRepository: targetRepository,
      settingsWriteRepository: targetRepository,
    });

    const propertySettingsResponse = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/property",
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    expect(propertySettingsResponse.statusCode).toBe(200);
    expect(propertySettingsResponse.body).toMatchObject({
      id: "booking_hotel_alpenrose",
      property_id: "d3000000-0000-0000-0000-000000000682",
      booking_hotel_id: "booking_hotel_alpenrose",
      slug: "hotel-alpenrose",
      property_name: "Hotel Alpenrose",
      default_currency: "CHF",
      default_language: "de",
      pay_at_property_enabled: true,
      pay_at_hotel_methods: ["card"],
      online_card_payment: false,
      bank_transfer: false,
      special_requests_enabled: false,
      arrival_time_enabled: true,
      guest_count_enabled: true,
    });

    const propertyLinkResponse = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/property-link",
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    expect(propertyLinkResponse.statusCode).toBe(200);
    expect(propertyLinkResponse.body).toEqual({
      hotelId: "booking_hotel_alpenrose",
      propertyId: "d3000000-0000-0000-0000-000000000682",
      resourceLinks: {
        bookingHotel: true,
        pmsProperty: true,
        financeProperty: true,
      },
    });

    const bookingOnlyPatchResponse = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/property",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        whatsapp_number: "+43 1 7777",
        default_currency: "EUR",
      },
    });
    expect(bookingOnlyPatchResponse.statusCode).toBe(200);
    expect(bookingOnlyPatchResponse.body).toMatchObject({
      property_name: "Hotel Alpenrose",
      reservation_email: "reservations@alpenrose.example",
      phone_number: "+43 1 2345",
      whatsapp_number: "+43 1 7777",
      address: "Alpenweg 1, Innsbruck, AT",
      city: "Innsbruck",
      country: "AT",
      default_currency: "EUR",
    });

    const propertyPatchResponse = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/property",
      headers: {
        authorization: "Bearer valid-token",
      },
      payload: {
        property_name: "Target Alpenrose",
        reservation_email: "target@alpenrose.example",
        phone_number: "+43 1 1111",
        whatsapp_number: "+43 1 2222",
        address: "Target lane 1",
        city: "Vienna",
        country: "AT",
        instagram: "https://instagram.com/target-alpenrose",
        facebook: "https://facebook.com/target-alpenrose",
        tiktok: "https://tiktok.com/@target-alpenrose",
        youtube: "https://youtube.com/@target-alpenrose",
        check_in_time: "14:00",
        check_out_time: "10:00",
        terms_text: "Target booking terms.",
        cancellation_policy_text: "Target cancellation policy.",
        default_currency: "EUR",
        default_language: "en-US",
        supported_currencies: ["CHF", "EUR"],
        supported_languages: ["de", "en-US"],
        special_requests_enabled: true,
        arrival_time_enabled: false,
        guest_count_enabled: false,
      },
    });
    expect(propertyPatchResponse.statusCode).toBe(200);
    expect(propertyPatchResponse.body).toMatchObject({
      property_name: "Hotel Alpenrose",
      reservation_email: "target@alpenrose.example",
      address: "Alpenweg 1, Innsbruck, AT",
      city: "Innsbruck",
      instagram: "https://instagram.com/target-alpenrose",
      facebook: "https://facebook.com/target-alpenrose",
      tiktok: "https://tiktok.com/@target-alpenrose",
      youtube: "https://youtube.com/@target-alpenrose",
      default_currency: "EUR",
      default_language: "en-US",
      supported_currencies: ["CHF"],
      supported_languages: ["de"],
      pay_at_property_enabled: true,
      pay_at_hotel_methods: ["card"],
      online_card_payment: false,
      bank_transfer: false,
      terms_text: "Target booking terms.",
      cancellation_policy_text: "Target cancellation policy.",
    });
    const propertyUpdateQuery = queries.find(
      (query) =>
        query.text.includes("UPDATE hotel_catalog.properties property") &&
        query.text.includes("upserted_contacts"),
    );
    expect(propertyUpdateQuery?.text).not.toContain("display_name =");
    expect(propertyUpdateQuery?.text).not.toContain("INSERT INTO hotel_catalog.property_locations");
    expect(propertyUpdateQuery?.text).not.toContain("UPDATE hotel_catalog.property_locations");
    expect(propertyUpdateQuery?.text).toContain("profile_revision = property.profile_revision + 1");
    expect(propertyUpdateQuery?.text).toContain("default_currency = EXCLUDED.default_currency");
    expect(propertyUpdateQuery?.text).toContain(
      "guest_count_enabled = EXCLUDED.guest_count_enabled",
    );
    expect(propertyUpdateQuery?.text).toContain("contact.source_system = 'booking'");
    expect(propertyUpdateQuery?.text).toContain(
      "contact.channel_type IN ('email', 'phone', 'whatsapp')",
    );
    expect(propertyUpdateQuery?.text).toContain("WHERE input.channel_type = contact.channel_type");
    expect(propertyUpdateQuery?.text).toContain(
      "CROSS JOIN (SELECT count(*) FROM deleted_contacts) deleted_contact_status",
    );
    expect(propertyUpdateQuery?.text).toContain(
      "hotel_catalog.property_contact_channels.source_system = 'booking'",
    );
    expect(propertyUpdateQuery?.text).not.toContain("address_public = TRUE");
    expect(queries.some((query) => query.text === "BEGIN")).toBe(true);
    expect(queries.some((query) => query.text === "COMMIT")).toBe(true);
    const transactionStart = queries.findIndex((query) => query.text === "BEGIN");
    const propertyLock = queries.findIndex(
      (query, index) =>
        index > transactionStart &&
        query.text.includes("FROM hotel_catalog.properties") &&
        query.text.includes("FOR UPDATE"),
    );
    const bookingSettingsLock = queries.findIndex(
      (query, index) =>
        index > propertyLock &&
        query.text.includes("FROM booking.booking_settings") &&
        query.text.includes("FOR UPDATE"),
    );
    const mergedSettingsRead = queries.findIndex(
      (query, index) =>
        index > bookingSettingsLock &&
        query.text.includes("property.display_name AS property_name"),
    );
    const transactionalUpdate = queries.findIndex(
      (query, index) => index > mergedSettingsRead && query === propertyUpdateQuery,
    );
    expect(transactionStart).toBeGreaterThanOrEqual(0);
    expect(propertyLock).toBeGreaterThan(transactionStart);
    expect(bookingSettingsLock).toBeGreaterThan(propertyLock);
    expect(mergedSettingsRead).toBeGreaterThan(bookingSettingsLock);
    expect(transactionalUpdate).toBeGreaterThan(mergedSettingsRead);
    expect(
      queries.some((query) =>
        query.text.includes("INSERT INTO hotel_catalog.property_public_profile_read_model"),
      ),
    ).toBe(true);

    const designResponse = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/design",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        headerLogoMediaObjectId: bookingHeaderLogoMediaObjectId,
        heroHeading: "Book the mountain directly",
        primaryColor: "#0F766E",
        fontPairing: "grand-classic",
      },
    });
    expect(designResponse.statusCode).toBe(200);
    expect(designResponse.body).toEqual({
      headerLogo: "https://cdn.vayada.example/alpenrose/new-logo.webp",
      headerLogoMediaObjectId: bookingHeaderLogoMediaObjectId,
      heroImage: "https://cdn.vayada.example/alpenrose/booking-hero.jpg",
      heroHeading: "Book the mountain directly",
      heroSubtext: "An independent alpine escape.",
      primaryColor: "#0F766E",
      fontPairing: "grand-classic",
    });
    const firstDesignUpdateQuery = queries.find(
      (query) =>
        query.text.includes("UPDATE booking.booking_settings settings") &&
        query.text.includes("SET header_logo_media_object_id = CASE"),
    );
    expect(firstDesignUpdateQuery?.text).toContain("$2::jsonb ? 'heroHeading'");
    expect(firstDesignUpdateQuery?.text).toContain("$2::jsonb ? 'headerLogoMediaObjectId'");
    expect(firstDesignUpdateQuery?.text).toContain("media.owner_organization_id = $3::uuid");
    expect(firstDesignUpdateQuery?.text).toContain("media.purpose = 'booking.header_logo'");
    expect(firstDesignUpdateQuery?.text).toContain("media.resource_id = $1");
    expect(firstDesignUpdateQuery?.text).toContain("variant.public_cdn_url LIKE 'https://%'");
    expect(firstDesignUpdateQuery?.text).toContain("$2::jsonb ? 'primaryColor'");
    expect(firstDesignUpdateQuery?.text).toContain("$2::jsonb ? 'fontPairing'");
    expect(firstDesignUpdateQuery?.text).not.toContain("INSERT INTO hotel_catalog.property_media");
    expect(firstDesignUpdateQuery?.text).not.toContain("UPDATE hotel_catalog.property_media");
    expect(firstDesignUpdateQuery?.text).not.toContain("hotel_catalog.property_descriptions");
    expect(firstDesignUpdateQuery?.text).not.toContain("UPDATE hotel_catalog.properties property");
    expect(firstDesignUpdateQuery?.text).not.toContain(
      "hotel_catalog.property_public_profile_read_model",
    );
    expect(firstDesignUpdateQuery?.values).toEqual([
      "booking_hotel_alpenrose",
      JSON.stringify({
        headerLogoMediaObjectId: bookingHeaderLogoMediaObjectId,
        heroHeading: "Book the mountain directly",
        primaryColor: "#0F766E",
        fontPairing: "grand-classic",
      }),
      "org_hotel_group",
    ]);

    const invalidLogoResponse = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/design",
      headers: { authorization: "Bearer valid-token" },
      payload: { headerLogoMediaObjectId: "b1000000-0000-4000-8000-000000001218" },
    });
    expect(invalidLogoResponse.statusCode).toBe(422);
    expect(invalidLogoResponse.body).toMatchObject({
      code: "invalid_header_logo_media",
      category: "validation",
    });

    state.header_logo_url = null;
    const invalidatedLogoRead = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/design",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(invalidatedLogoRead.body).toMatchObject({
      headerLogo: "",
      headerLogoMediaObjectId: null,
    });
    const unrelatedSaveAfterInvalidation = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/design",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        headerLogoMediaObjectId: null,
        heroHeading: "Book the mountain directly",
      },
    });
    expect(unrelatedSaveAfterInvalidation.statusCode).toBe(200);
    state.header_logo_media_object_id = bookingHeaderLogoMediaObjectId;
    state.header_logo_url = "https://cdn.vayada.example/alpenrose/new-logo.webp";

    const partialDesignResponse = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/design",
      headers: { authorization: "Bearer valid-token" },
      payload: { heroSubtext: "Come for the mountains. Stay for the quiet." },
    });
    expect(partialDesignResponse.statusCode).toBe(200);
    expect(partialDesignResponse.body).toEqual({
      headerLogo: "https://cdn.vayada.example/alpenrose/new-logo.webp",
      headerLogoMediaObjectId: bookingHeaderLogoMediaObjectId,
      heroImage: "https://cdn.vayada.example/alpenrose/booking-hero.jpg",
      heroHeading: "Book the mountain directly",
      heroSubtext: "Come for the mountains. Stay for the quiet.",
      primaryColor: "#0F766E",
      fontPairing: "grand-classic",
    });
    const partialDesignUpdateQuery = queries.find(
      (query) =>
        query.text.includes("UPDATE booking.booking_settings settings") &&
        query.values?.[1] ===
          JSON.stringify({ heroSubtext: "Come for the mountains. Stay for the quiet." }),
    );
    expect(partialDesignUpdateQuery?.text).not.toContain("hotel_catalog.property_descriptions");
    expect(partialDesignUpdateQuery?.text).toContain(
      "WHEN booking_header_logo.public_cdn_url IS NULL THEN NULL",
    );

    const clearedDesignResponse = await injectJson(app, {
      method: "PATCH",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/design",
      headers: { authorization: "Bearer valid-token" },
      payload: { headerLogoMediaObjectId: null, heroImage: "", heroSubtext: "" },
    });
    expect(clearedDesignResponse.statusCode).toBe(200);
    expect(clearedDesignResponse.body).toMatchObject({
      headerLogo: "",
      headerLogoMediaObjectId: null,
      heroImage: "",
      heroSubtext: "",
    });
    const clearedDesignUpdateQuery = queries.find(
      (query) =>
        query.text.includes("UPDATE booking.booking_settings settings") &&
        query.values?.[1] ===
          JSON.stringify({ headerLogoMediaObjectId: null, heroImage: "", heroSubtext: "" }),
    );
    expect(clearedDesignUpdateQuery?.text).not.toContain(
      "INSERT INTO hotel_catalog.property_media",
    );
    expect(clearedDesignUpdateQuery?.text).not.toContain("UPDATE hotel_catalog.property_media");
    expect(clearedDesignUpdateQuery?.text).not.toContain("completeness_reasons");

    const cases = [
      {
        path: "/addons",
        update: { showAddonsStep: true, groupAddonsByCategory: false },
        expected: { showAddonsStep: true, groupAddonsByCategory: false },
      },
      {
        path: "/guest-form",
        update: {
          specialRequestsEnabled: true,
          arrivalTimeEnabled: false,
          guestCountEnabled: false,
          phoneRequired: false,
          adultAgeThreshold: 21,
          childrenEnabled: false,
        },
        expected: {
          specialRequestsEnabled: true,
          arrivalTimeEnabled: false,
          guestCountEnabled: false,
          phoneRequired: false,
          adultAgeThreshold: 21,
          childrenEnabled: false,
        },
      },
      {
        path: "/benefits",
        update: { benefits: ["Late checkout"] },
        expected: { benefits: ["Late checkout"] },
      },
      {
        path: "/localization",
        update: {
          defaultCurrency: " eur ",
          defaultLanguage: "en-US",
          supportedCurrencies: ["CHF", "EUR"],
          supportedLanguages: ["de", "en-US"],
        },
        expected: {
          defaultCurrency: "EUR",
          defaultLanguage: "en-US",
          supportedCurrencies: ["CHF"],
          supportedLanguages: ["de"],
        },
      },
      {
        path: "/room-filters",
        update: {
          bookingFilters: ["spa_access"],
          customFilters: { spa_access: "Spa access" },
          filterRooms: { spa_access: ["room_102"] },
        },
        expected: {
          bookingFilters: ["spa_access"],
          customFilters: { spa_access: "Spa access" },
          filterRooms: { spa_access: ["room_102"] },
        },
      },
      {
        path: "/last-minute",
        update: {
          enabled: true,
          stackWithPromo: true,
          tiers: [{ daysBeforeMin: 0, daysBeforeMax: 1, discountPercent: 25 }],
        },
        expected: {
          enabled: true,
          stackWithPromo: true,
          tiers: [{ daysBeforeMin: 0, daysBeforeMax: 1, discountPercent: 25 }],
          updatedAt: "2026-06-22T10:00:00.000Z",
        },
      },
    ];

    for (const testCase of cases) {
      const url = `/api/booking/hotels/booking_hotel_alpenrose/settings${testCase.path}`;
      const putResponse = await injectJson(app, {
        method: "PUT",
        url,
        headers: {
          authorization: "Bearer valid-token",
        },
        payload: testCase.update,
      });
      expect(putResponse.statusCode).toBe(200);
      expect(putResponse.body).toEqual(testCase.expected);

      const getResponse = await injectJson(app, {
        method: "GET",
        url,
        headers: {
          authorization: "Bearer valid-token",
        },
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.body).toEqual(testCase.expected);
    }

    expect(queries.length).toBeGreaterThanOrEqual(10);
    expect(
      queries
        .filter((query) => query.values && query.values.length > 0)
        .every((query) =>
          [
            "booking_hotel_alpenrose",
            "d3000000-0000-0000-0000-000000000682",
            "org_hotel_group",
          ].includes(String(query.values?.[0])),
        ),
    ).toBe(true);
    const settingsQueries = queries.filter((query) =>
      query.text.includes("booking.booking_settings"),
    );
    expect(
      settingsQueries.every(
        (query) =>
          query.text.includes("scoped_property_candidates") ||
          (query.text.includes("WHERE property_id = $1::uuid") &&
            query.text.includes("FOR UPDATE")),
      ),
    ).toBe(true);
    const sql = queries.map((query) => query.text).join("\n");
    expect(sql).toContain("relationship = 'canonical_input'");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("finance.payment_settings");
    expect(sql).toContain("hotel_catalog.property_source_links pms_link");
    expect(sql).not.toMatch(/\b(FROM|UPDATE)\s+booking_hotels\b/i);

    await app.close();
    app = null;
    expect(poolClosed).toBe(true);
  });

  it("loads target booking property settings when the booking resource id is already a property UUID", async () => {
    const propertyId = "d3000000-0000-0000-0000-000000000682";
    const queries: { text: string; values?: readonly unknown[] }[] = [];
    const pool: BookingSettingsPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ): Promise<Pick<QueryResult<T>, "rows">> {
        queries.push({ text, values });
        return {
          rows: [
            {
              source_link_count: 1,
              id: propertyId,
              property_id: propertyId,
              booking_hotel_id: null,
              slug: "hotel-alpenrose",
              property_name: "Hotel Alpenrose",
              reservation_email: null,
              phone_number: null,
              whatsapp_number: null,
              address: null,
              city: null,
              country: null,
              timezone: "Europe/Vienna",
              instagram: null,
              facebook: null,
              tiktok: null,
              youtube: null,
              check_in_time: null,
              check_out_time: null,
              terms_and_conditions: null,
              cancellation_policy_text: null,
              accepted_payment_methods: [],
              show_addons_step: true,
              group_addons_by_category: true,
              special_requests_enabled: true,
              arrival_time_enabled: false,
              guest_count_enabled: false,
              adult_age_threshold: 18,
              children_enabled: true,
              benefits: [],
              default_currency: "EUR",
              default_language: "en",
              supported_currencies: [],
              supported_languages: ["en"],
              booking_filters: [],
              custom_filters: {},
              filter_rooms: {},
              last_minute_discount: { enabled: false, stackWithPromo: false, tiers: [] },
              updated_at: "2026-06-22T10:00:00.000Z",
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const targetRepository = createPgTargetBookingSettingsRepository({
      connectionString: "postgresql://target-db",
      pool,
    });
    app = buildAuthenticatedApp({
      linkedHotelId: propertyId,
      settingsRepository: targetRepository,
      settingsWriteRepository: targetRepository,
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/booking/hotels/${propertyId}/settings/property`,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      id: propertyId,
      property_id: propertyId,
      time_zone: "Europe/Vienna",
      booking_hotel_id: null,
      slug: "hotel-alpenrose",
      property_name: "Hotel Alpenrose",
    });
    expect(queries[0]?.values?.[0]).toBe(propertyId);
    expect(queries[0]?.text).toContain("property.id::text = $1");
    expect(queries[0]?.text).not.toMatch(/\bFROM\s+booking_hotels\b/i);
  });

  it.each([
    ["canonical property id", "d3000000-0000-0000-0000-000000000682"],
    ["legacy booking-hotel id", "booking_hotel_alpenrose"],
  ])("serves and updates target booking add-on items by %s", async (_label, hotelId) => {
    const queries: { text: string; values?: unknown[] }[] = [];
    const canonicalPropertyId = "d3000000-0000-0000-0000-000000000682";
    async function query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<Pick<QueryResult<T>, "rows">> {
      queries.push({ text, values });
      if (text.includes("WITH direct_property AS")) {
        return {
          rows: [{ propertyId: canonicalPropertyId }] as unknown as T[],
        };
      }
      if (text.includes("SELECT plan_key AS plan")) {
        return { rows: [] as T[] };
      }
      return {
        rows: [
          {
            addonItemId: "0f840001-0000-4000-8000-000000000001",
            propertyId: "d3000000-0000-0000-0000-000000000682",
            name: "Migrated add-on",
            description: null,
            category: "food",
            pricingModel: "per_stay",
            price: "45.00",
            currency: "EUR",
            publicVisible: true,
            status: "active",
            ownershipKind: "property",
            partnerCommissionRate: null,
            metadata: {},
            createdAt: "2026-06-01T10:00:00.000Z",
            updatedAt: "2026-06-01T10:00:00.000Z",
          },
        ] as unknown as T[],
      };
    }
    const pool: BookingAddonItemsPool = {
      query,
      async connect() {
        return { query, release() {} };
      },
      async end() {},
    };
    const repository = createPgTargetBookingAddonItemsRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const items = await repository.listAddonItemsByHotelId(hotelId);

    expect(items).toEqual({
      addonItems: [
        {
          addonItemId: "0f840001-0000-4000-8000-000000000001",
          hotelId,
          propertyId: "d3000000-0000-0000-0000-000000000682",
          name: "Migrated add-on",
          description: "",
          price: "45.00",
          currency: "EUR",
          category: "dining",
          imageUrl: null,
          duration: null,
          pricingModel: "per_stay",
          publicVisible: true,
          status: "active",
          sortOrder: 0,
          ownershipKind: "property",
          partnerCommissionRate: null,
          createdAt: "2026-06-01T10:00:00.000Z",
          updatedAt: "2026-06-01T10:00:00.000Z",
        },
      ],
      propertyPlan: {
        ...commissionPropertyPlan,
        propertyId: canonicalPropertyId,
      },
    });
    await expect(
      repository.updateAddonItemByHotelId(hotelId, "not-a-uuid", {
        partnerCommissionRate: "15.5000",
      } as unknown as UpdateBookingAddonItemBody),
    ).rejects.toThrow("Add-on economic updates require a complete valid ownership pair");
    const updated = await repository.updateAddonItemByHotelId(hotelId, "not-a-uuid", {
      name: "Updated",
      ownershipKind: "partner",
      partnerCommissionRate: "15.5000",
    });
    await repository.createAddonItemByHotelId(hotelId, {
      name: "Partner transfer",
      description: "Private transfer",
      price: "50.00",
      currency: "EUR",
      category: "transport",
      imageUrl: null,
      duration: null,
      pricingModel: "per_stay",
      publicVisible: true,
      status: "active",
      sortOrder: 1,
      ownershipKind: "partner",
      partnerCommissionRate: "12.5000",
    });

    expect(updated?.hotelId).toBe(hotelId);
    const listQuery = queries.find((query) =>
      query.text.includes("addon_definitions.status <> 'retired'"),
    );
    expect(listQuery?.text).toContain("COALESCE(addon_definitions.category, 'other') AS category");
    expect(listQuery?.text).toContain('addon_definitions.ownership_kind AS "ownershipKind"');
    const updateQuery = queries.find((query) => query.text.includes("WITH updated AS ("));
    expect(updateQuery?.text).toContain("partner_commission_rate");
    expect(updateQuery?.values).toContain("15.5000");
    const insertQuery = queries.find((query) =>
      query.text.includes("INSERT INTO booking.addon_definitions ("),
    );
    expect(insertQuery?.text).toContain("ownership_kind, partner_commission_rate");
    expect(insertQuery?.values).toContain("12.5000");
    expect(queries[0]?.text).toContain("property.id::text = $1");
    expect(queries[0]?.text).toContain("UNION ALL");
    expect(queries[0]?.text).toContain("NOT EXISTS (SELECT 1 FROM direct_property)");
    expect(queries[0]?.values).toEqual([hotelId]);
    expect(queries.filter((query) => query.text.includes("WITH direct_property AS"))).toHaveLength(
      3,
    );
    expect(queries.map((query) => query.text).join("\n")).not.toContain("$2::uuid");
  });

  it.each([
    ["canonical property id", "d3000000-0000-0000-0000-000000000682"],
    ["legacy booking-hotel id", "booking_hotel_alpenrose"],
  ])("serves target booking promo codes by %s", async (_label, hotelId) => {
    const queries: { text: string; values?: unknown[] }[] = [];
    const canonicalPropertyId = "d3000000-0000-0000-0000-000000000682";
    const pool: BookingPromoCodesPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<Pick<QueryResult<T>, "rows">> {
        queries.push({ text, values });
        if (text.includes("hotel_catalog.property_source_links")) {
          return {
            rows: [{ propertyId: canonicalPropertyId }] as unknown as T[],
          };
        }
        if (text.includes("RETURNING id::text AS id")) {
          return { rows: [{ id: "0f850001-0000-4000-8000-000000000001" }] as unknown as T[] };
        }
        return {
          rows: [
            {
              promoCodeId: "0f850001-0000-4000-8000-000000000001",
              propertyId: "d3000000-0000-0000-0000-000000000682",
              code: "SUMMER20",
              discountType: "percentage",
              discountValue: "20.00",
              minBookingValue: "500.00",
              applicableRoomIds: ["0f850001-0000-4000-8000-000000000010"],
              validFrom: "2026-07-01",
              validUntil: "2026-08-31",
              stayDateFrom: "2026-08-01",
              stayDateUntil: "2026-09-30",
              isActive: true,
              maxUses: 50,
              currentUses: 3,
              createdAt: "2026-06-01T10:00:00.000Z",
              updatedAt: "2026-06-01T10:00:00.000Z",
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createPgTargetBookingPromoCodesRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    const items = await repository.listPromoCodesByHotelId(hotelId);
    const created = await repository.createPromoCodeByHotelId(hotelId, {
      code: "SUMMER20",
      discountType: "percentage",
      discountValue: "20.00",
      minBookingValue: "500.00",
      applicableRoomIds: ["0f850001-0000-4000-8000-000000000010"],
      validFrom: "2026-07-01",
      validUntil: "2026-08-31",
      stayDateFrom: "2026-08-01",
      stayDateUntil: "2026-09-30",
      isActive: true,
      maxUses: 50,
    });
    const retired = await repository.retirePromoCodeByHotelId(
      hotelId,
      "0f850001-0000-4000-8000-000000000001",
    );

    expect(items).toEqual([
      {
        promoCodeId: "0f850001-0000-4000-8000-000000000001",
        hotelId,
        propertyId: "d3000000-0000-0000-0000-000000000682",
        code: "SUMMER20",
        discountType: "percentage",
        discountValue: "20.00",
        minBookingValue: "500.00",
        applicableRoomIds: ["0f850001-0000-4000-8000-000000000010"],
        validFrom: "2026-07-01",
        validUntil: "2026-08-31",
        stayDateFrom: "2026-08-01",
        stayDateUntil: "2026-09-30",
        isActive: true,
        maxUses: 50,
        currentUses: 3,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
    ]);
    expect(created?.promoCodeId).toBe("0f850001-0000-4000-8000-000000000001");
    expect(retired).toBe(true);
    const sql = queries.map((query) => query.text).join("\n");
    expect(sql).toContain("booking.promo_definitions");
    expect(sql).toContain("promo_definitions.status <> 'retired'");
    expect(sql).toContain("property.id::text = $1");
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM direct_property)");
    expect(sql).not.toContain("promo_applications");
    expect(
      queries
        .filter((query) => query.text.includes("WITH direct_property AS"))
        .map((query) => query.values),
    ).toEqual([[hotelId], [hotelId], [hotelId]]);
  });

  it("defaults missing booking addon settings fields to the legacy response defaults", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return {};
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      showAddonsStep: true,
      groupAddonsByCategory: true,
    });
  });

  it("defaults missing booking guest-form settings fields to the legacy response defaults", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return {
            specialRequestsEnabled: null,
            arrivalTimeEnabled: null,
            guestCountEnabled: null,
          };
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      specialRequestsEnabled: true,
      arrivalTimeEnabled: false,
      guestCountEnabled: false,
      phoneRequired: true,
      adultAgeThreshold: 18,
      childrenEnabled: true,
    });
  });

  it("defaults unset booking benefits to the legacy empty list", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return { benefits: null };
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: [],
    });
  });

  it("defaults malformed and non-list booking benefits values to the legacy empty list", async () => {
    const malformedValues: unknown[] = ['{"not": "a list"}', "not json", 42, { nested: true }];

    for (const benefits of malformedValues) {
      const malformedApp = buildAuthenticatedApp({
        settingsRepository: {
          async findAddonSettingsByHotelId() {
            return null;
          },
          async findGuestFormSettingsByHotelId() {
            return null;
          },
          async findBenefitsSettingsByHotelId() {
            return { benefits };
          },
          async findLocalizationSettingsByHotelId() {
            return null;
          },
        },
      });

      const response = await injectJson(malformedApp, {
        method: "GET",
        url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        benefits: [],
      });

      await malformedApp.close();
    }
  });

  it("drops non-string booking benefits entries instead of failing the read", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return { benefits: ["Free breakfast", 42, null, { label: "Spa" }, "Late checkout"] };
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: ["Free breakfast", "Late checkout"],
    });
  });

  it("parses JSON-encoded booking benefits strings like the legacy read path", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return { benefits: '["Free parking", "Welcome drink"]' };
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: ["Free parking", "Welcome drink"],
    });
  });

  it("defaults missing booking localization settings fields to the contract defaults", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return {
            defaultCurrency: null,
            defaultLanguage: null,
            supportedCurrencies: null,
            supportedLanguages: null,
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      defaultCurrency: "EUR",
      defaultLanguage: "en",
      supportedCurrencies: [],
      supportedLanguages: ["en"],
    });
  });

  it("defaults malformed booking localization lists to the contract defaults", async () => {
    const malformedValues: unknown[] = ['{"not": "a list"}', "not json", 42, { nested: true }];

    for (const malformedValue of malformedValues) {
      const malformedApp = buildAuthenticatedApp({
        settingsRepository: {
          async findAddonSettingsByHotelId() {
            return null;
          },
          async findGuestFormSettingsByHotelId() {
            return null;
          },
          async findBenefitsSettingsByHotelId() {
            return null;
          },
          async findLocalizationSettingsByHotelId() {
            return {
              defaultCurrency: "EUR",
              defaultLanguage: "en",
              supportedCurrencies: malformedValue,
              supportedLanguages: malformedValue,
            };
          },
        },
      });

      const response = await injectJson(malformedApp, {
        method: "GET",
        url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        defaultCurrency: "EUR",
        defaultLanguage: "en",
        supportedCurrencies: [],
        supportedLanguages: ["en"],
      });

      await malformedApp.close();
    }
  });

  it("parses JSON-encoded booking localization lists like the legacy read path", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return {
            defaultCurrency: "EUR",
            defaultLanguage: "en",
            supportedCurrencies: '["EUR", "USD"]',
            supportedLanguages: '["en", "de"]',
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      defaultCurrency: "EUR",
      defaultLanguage: "en",
      supportedCurrencies: ["EUR", "USD"],
      supportedLanguages: ["en", "de"],
    });
  });

  it("defaults missing booking room-filter settings fields to the contract defaults", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
        async findRoomFilterSettingsByHotelId() {
          return {
            bookingFilters: null,
            customFilters: null,
            filterRooms: null,
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: [],
      customFilters: {},
      filterRooms: {},
    });
  });

  it("returns empty room-filter settings when the authorized hotel has no settings row", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: [],
      customFilters: {},
      filterRooms: {},
    });
  });

  it("hardens malformed booking room-filter values to contract defaults", async () => {
    const malformedValues: unknown[] = ["not json", 42, null, ["not", 1]];

    for (const malformedValue of malformedValues) {
      const malformedApp = buildAuthenticatedApp({
        settingsRepository: {
          async findAddonSettingsByHotelId() {
            return null;
          },
          async findGuestFormSettingsByHotelId() {
            return null;
          },
          async findBenefitsSettingsByHotelId() {
            return null;
          },
          async findLocalizationSettingsByHotelId() {
            return null;
          },
          async findRoomFilterSettingsByHotelId() {
            return {
              bookingFilters: malformedValue,
              customFilters: malformedValue,
              filterRooms: malformedValue,
            };
          },
        },
      });

      const response = await injectJson(malformedApp, {
        method: "GET",
        url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        bookingFilters:
          typeof malformedValue === "object" && Array.isArray(malformedValue) ? ["not"] : [],
        customFilters: {},
        filterRooms: {},
      });

      await malformedApp.close();
    }
  });

  it("drops invalid room-filter entries instead of failing the read", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
        async findRoomFilterSettingsByHotelId() {
          return {
            bookingFilters: ["oceanView", 42, null, "suite"],
            customFilters: {
              oceanView: "Ocean view",
              bad: 42,
            },
            filterRooms: {
              oceanView: ["room_101", null, 123, "room_102"],
              broken: "room_999",
            },
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: ["oceanView", "suite"],
      customFilters: {
        oceanView: "Ocean view",
      },
      filterRooms: {
        oceanView: ["room_101", "room_102"],
        broken: [],
      },
    });
  });

  it("parses JSON-encoded booking room-filter values like the legacy read path", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
        async findRoomFilterSettingsByHotelId() {
          return {
            bookingFilters: '["oceanView", "spa_access"]',
            customFilters: '{"spa_access": "Spa access"}',
            filterRooms: '{"oceanView": ["room_101"], "spa_access": ["room_102"]}',
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      bookingFilters: ["oceanView", "spa_access"],
      customFilters: {
        spa_access: "Spa access",
      },
      filterRooms: {
        oceanView: ["room_101"],
        spa_access: ["room_102"],
      },
    });
  });

  it("rejects booking addon settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking addon settings with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking addon settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking addon settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking addon settings when entitlement is suspended", async () => {
    app = buildAuthenticatedApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking addon settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("rejects booking guest-form settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking guest-form settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking guest-form settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking guest-form settings when entitlement is suspended", async () => {
    app = buildAuthenticatedApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking guest-form settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("rejects booking benefits settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking benefits settings with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking benefits settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking benefits settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking benefits settings when entitlement is suspended", async () => {
    app = buildAuthenticatedApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking benefits settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("rejects booking localization settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking localization settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking localization settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking localization settings when entitlement is suspended", async () => {
    app = buildAuthenticatedApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking localization settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("rejects booking room-filter settings without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking room-filter settings with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking room-filter settings when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking settings permission.",
    });
  });

  it("rejects booking room-filter settings when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking room-filter settings when entitlement is suspended", async () => {
    app = buildAuthenticatedApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking room-filter settings when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("returns the booking addon settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking add-on settings are unavailable.",
    });
  });

  it("returns the booking guest-form settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking guest-form settings are unavailable.",
    });
  });

  it("returns the booking benefits settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          throw new Error("database unavailable");
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking benefits settings are unavailable.",
    });
  });

  it("returns the booking localization settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          throw new Error("database unavailable");
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking localization settings are unavailable.",
    });
  });

  it("returns the booking room-filter settings read-model error contract when the repository fails", async () => {
    app = buildAuthenticatedApp({
      settingsRepository: {
        async findAddonSettingsByHotelId() {
          return null;
        },
        async findGuestFormSettingsByHotelId() {
          return null;
        },
        async findBenefitsSettingsByHotelId() {
          return null;
        },
        async findLocalizationSettingsByHotelId() {
          return null;
        },
        async findRoomFilterSettingsByHotelId() {
          throw new Error("database unavailable");
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/settings/room-filters",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      statusCode: 500,
      code: "read_model_unavailable",
      category: "read_model",
      message: "Booking room-filter settings are unavailable.",
    });
  });

  it("rejects booking reservations without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking reservations with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("rejects booking reservations when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: ["booking.settings.manage"] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_permission",
      category: "authorization",
      message: "Missing required booking reservation permission.",
    });
  });

  it("rejects booking reservations when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_entitlement",
      category: "authorization",
      message: "Missing active booking engine entitlement.",
    });
  });

  it("rejects booking reservations when entitlement is suspended", async () => {
    app = buildAuthenticatedApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "inactive_entitlement",
      category: "authorization",
      message: "Booking engine entitlement is not active.",
    });
  });

  it("rejects booking reservations when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/reservations",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      statusCode: 403,
      code: "missing_resource_access",
      category: "authorization",
      message: "Missing booking hotel access.",
    });
  });

  it("returns PMS room-types using the P1a route contract fixture", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsRoomTypesReadCase.request),
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    const body = response.body as PmsOperationsTestListResponse<PmsRoomType>;
    expect(response.statusCode).toBe(pmsRoomTypesReadCase.expected.status);
    expect(body.contractVersion).toBe("pms-operations.v1");
    expect(body.items).toHaveLength(pmsRoomTypesReadCase.expected.itemCount!);
    for (const path of pmsRoomTypesReadCase.expected.mustInclude ?? []) {
      expect(readContractPath(body, path), path).not.toBeUndefined();
    }
    for (const key of pmsRoomTypesReadCase.expected.mustExclude ?? []) {
      expect(JSON.stringify(body)).not.toContain(key);
    }
    expect(body.items.map((item) => item.name)).toEqual(["Alpine Suite", "Garden Room"]);
  });

  it("returns centralized property plan limits to PMS clients", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      propertyPlanReadRepository: {
        async getPropertyPlan(propertyId) {
          return {
            propertyId,
            plan: "commission",
            limits: {
              maxRoomPhotosPerType: 10,
              maxAddons: 3,
              guestContactAccess: "after_acceptance",
            },
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/plan-limits`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      contractVersion: "pms-operations.v1",
      propertyId: pmsPropertyId,
      propertyPlan: {
        propertyId: pmsPropertyId,
        plan: "commission",
        limits: {
          maxRoomPhotosPerType: 10,
          maxAddons: 3,
          guestContactAccess: "after_acceptance",
        },
      },
    });
  });

  it("reads and updates the Booking-owned acceptance mode through PMS", async () => {
    let acceptanceMode: "instant" | "request" = "request";
    const published: string[] = [];
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read", "pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      bookingAcceptanceSettings: {
        async findAcceptanceMode(propertyId) {
          expect(propertyId).toBe(pmsPropertyId);
          return acceptanceMode;
        },
        async updateAcceptanceMode(propertyId, nextMode) {
          expect(propertyId).toBe(pmsPropertyId);
          acceptanceMode = nextMode;
          return acceptanceMode;
        },
      },
      publicBookabilityPublisher: {
        async publish({ propertyId }) {
          published.push(propertyId);
          return null;
        },
      },
    });

    const read = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/booking-acceptance`,
      headers: { authorization: "Bearer valid-token" },
    });
    const update = await injectJson(app, {
      method: "PUT",
      url: `/api/pms/properties/${pmsPropertyId}/booking-acceptance`,
      payload: { acceptanceMode: "instant" },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(read.statusCode).toBe(200);
    expect(read.body).toMatchObject({ acceptanceMode: "request", instantBook: false });
    expect(update.statusCode).toBe(200);
    expect(update.body).toMatchObject({ acceptanceMode: "instant", instantBook: true });
    expect(published).toEqual([pmsPropertyId]);
  });

  it("uses centralized property plan limits in PMS room photo errors", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
      propertyPlanReadRepository: {
        async getPropertyPlan(propertyId) {
          return {
            propertyId,
            plan: "commission",
            limits: {
              maxRoomPhotosPerType: 1,
              maxAddons: 3,
              guestContactAccess: "after_acceptance",
            },
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/pms/properties/${pmsPropertyId}/room-types`,
      payload: {
        commandId: "cmd-room-type-photo-limit",
        idempotencyKey: "room-type-photo-limit",
        name: "Loft Suite",
        bathroomType: "private",
        bathrooms: 1,
        baseRate: 240,
        currency: "EUR",
        operatingPeriods: [{ from: "01-01", to: "12-31" }],
        seasons: [{ name: "Default", rate: "240", from: "01-01", to: "12-31", minStay: 1 }],
        images: [
          "https://cdn.vayada.example/loft.jpg",
          "https://cdn.vayada.example/loft-balcony.jpg",
        ],
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: "room_photo_plan_limit_reached",
      message:
        "You've reached the 1-photo limit. Upgrade to the paid plan for up to 15 photos per room.",
    });
    expect(commandRepository.roomTypeCreates).toHaveLength(0);
  });

  it("returns PMS rooms using the P1a route contract fixture", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsRoomsReadCase.request),
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    const body = response.body as PmsOperationsTestListResponse<PmsRoom>;
    expect(response.statusCode).toBe(pmsRoomsReadCase.expected.status);
    expect(body.contractVersion).toBe("pms-operations.v1");
    expect(body.items).toHaveLength(pmsRoomsReadCase.expected.itemCount!);
    expect(body.items.map((item) => item.status)).toEqual([
      "available",
      "maintenance",
      "out_of_order",
    ]);
    expect(body.items.map((item) => item.roomNumber)).toEqual(["101", "102", "201"]);
    expect(body.orderVersion).toBe(pmsRoomOrderVersion(pmsRooms.map(({ roomId }) => roomId)));
  });

  it("allows PMS Web browser preflight and read requests from configured origins", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsAllowedOrigins: ["https://pms.localhost"],
    });

    const preflight = await app.inject({
      method: "OPTIONS",
      url: pmsRoomsReadCase.request.path,
      headers: {
        origin: "https://pms.localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type,x-hotel-id",
      },
    });
    const read = await app.inject({
      method: "GET",
      url: pmsRoomsReadCase.request.path,
      headers: {
        authorization: "Bearer valid-token",
        origin: "https://pms.localhost",
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://pms.localhost");
    expect(preflight.headers["access-control-allow-headers"]).toBe(
      "authorization,content-type,x-hotel-id",
    );
    expect(preflight.headers["access-control-allow-methods"]).toBe(
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    expect(read.statusCode).toBe(200);
    expect(read.headers["access-control-allow-origin"]).toBe("https://pms.localhost");
  });

  it("boots PMS operations with the finance payment-settings facade", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read", "pms.finance.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      financeRepository,
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/payment-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      paymentSettings: {
        defaultCurrency: "CHF",
        onlineCardPayment: false,
        payAtPropertyEnabled: false,
        bankTransfer: false,
      },
      cancellationPolicy: {
        freeCancellationDays: 5,
        partialRefundPct: 50,
      },
    });
  });

  it("mounts only the PMS payment-settings facade for the PMS compatibility repository", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read", "pms.finance.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      pmsFinanceCompatibilityRepository: financeRepository,
    });

    const pmsFacade = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/payment-settings`,
      headers: { authorization: "Bearer valid-token" },
    });
    const canonicalFinanceRoute = await app.inject({
      method: "GET",
      url: `/api/finance/properties/${pmsPropertyId}/payment-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(pmsFacade.statusCode).toBe(200);
    expect(pmsFacade.body).toMatchObject({
      paymentSettings: { defaultCurrency: "CHF" },
    });
    expect(canonicalFinanceRoute.statusCode).toBe(404);
  });

  it("does not register retired PMS Web legacy admin helper routes", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsAllowedOrigins: ["https://pms.localhost"],
    });

    const retiredRoutes = [
      "/admin/setup-status",
      "/admin/messaging/unread-count",
      "/admin/bookings",
      "/admin/hotel",
      "/admin/hotels",
      "/admin/payment-settings",
      "/admin/calendar",
      "/admin/calendar-settings",
      "/admin/channex/status",
      "/admin/channex/channels",
      "/admin/channex/provision",
    ];

    for (const url of retiredRoutes) {
      for (const method of ["GET", "OPTIONS"] as const) {
        const response = await app.inject({
          method,
          url,
          headers: {
            authorization: "Bearer valid-token",
            origin: "https://pms.localhost",
            "access-control-request-method": "GET",
            "access-control-request-headers": "authorization,content-type,x-hotel-id",
          },
        });

        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    }
  });

  it("rejects retired PMS Web property listing when PMS read permission is missing", async () => {
    app = buildAuthenticatedApp({
      permissions: [],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsAllowedOrigins: ["https://pms.localhost"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/pms/properties",
      headers: {
        authorization: "Bearer valid-token",
        origin: "https://pms.localhost",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBe("https://pms.localhost");
    expect(response.json()).toMatchObject({
      code: "missing_permission",
      category: "authorization",
      message: "Missing required PMS operations permission.",
    });
  });

  it("manages room-packing settings and paginates its audit log", async () => {
    let enabled = true;
    const historyPages: unknown[] = [];
    const nextCursor = {
      occurredAt: "2026-08-18T10:00:00.123456Z",
      shuffleId: "10000000-0000-4000-8000-000000000001",
    };
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      pmsOperationsAllowedOrigins: ["https://pms.localhost"],
      pmsRoomAssignmentSettings: {
        async find(propertyId) {
          return { propertyId, autoRearrangeEnabled: enabled, updatedAt: null };
        },
        async update(propertyId, value) {
          enabled = value;
          return {
            propertyId,
            autoRearrangeEnabled: enabled,
            updatedAt: "2026-08-18T10:01:00.000Z",
          };
        },
      },
      pmsRoomAssignmentHistory: {
        async list(_propertyId, page) {
          historyPages.push(page);
          return {
            items: [],
            nextCursor: historyPages.length === 1 ? nextCursor : null,
          };
        },
      },
    });
    const headers = { authorization: "Bearer valid-token", origin: "https://pms.localhost" };

    const initial = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/calendar-settings`,
      headers,
    });
    const updated = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/calendar-settings`,
      headers,
      payload: { autoRearrangeEnabled: false },
    });
    const firstPage = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/calendar-shuffles?limit=25`,
      headers,
    });
    const opaqueCursor = (firstPage.body as { nextCursor: string }).nextCursor;
    const secondPage = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/calendar-shuffles?limit=25&cursor=${opaqueCursor}`,
      headers,
    });

    expect(initial.body).toMatchObject({ autoRearrangeEnabled: true, updatedAt: null });
    expect(updated.body).toMatchObject({ autoRearrangeEnabled: false });
    expect(opaqueCursor).toEqual(expect.any(String));
    expect((secondPage.body as { nextCursor: null }).nextCursor).toBeNull();
    expect(historyPages).toEqual([{ limit: 25 }, { limit: 25, before: nextCursor }]);

    const invalid = await app.inject({
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/calendar-shuffles?cursor=invalid`,
      headers,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_query" });
    expect(historyPages).toHaveLength(2);
  });

  it("reserves room-packing settings and history for owners and operators", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      linkedPmsRelationship: "front_desk",
      pmsRoomAssignmentSettings: {
        async find(propertyId) {
          return { propertyId, autoRearrangeEnabled: true, updatedAt: null };
        },
        async update() {
          throw new Error("unreachable");
        },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/calendar-settings`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "missing_resource_access" });
  });

  it("returns explicit unavailable errors for retired PMS Web placeholder facades", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read", "pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsAllowedOrigins: ["https://pms.localhost"],
    });

    const targetHeaders = {
      authorization: "Bearer valid-token",
      origin: "https://pms.localhost",
      "x-hotel-id": "legacy-booking-hotel-should-be-ignored",
    };

    const properties = await app.inject({
      method: "GET",
      url: "/api/pms/properties",
      headers: targetHeaders,
    });
    const profile = await app.inject({
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/profile`,
      headers: targetHeaders,
    });
    const profilePatch = await app.inject({
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/profile`,
      headers: targetHeaders,
      payload: {
        timezone: "Europe/Vienna",
        country: "AT",
        instant_book: true,
      },
    });
    const paymentSettings = await app.inject({
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/payment-settings`,
      headers: targetHeaders,
      payload: {
        defaultCurrency: "CHF",
        onlineCardPayment: true,
        paymentProvider: "vayada",
      },
    });
    const calendarSettingsRead = await app.inject({
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/calendar-settings`,
      headers: targetHeaders,
    });
    const calendarSettings = await app.inject({
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/calendar-settings`,
      headers: targetHeaders,
      payload: {
        autoRearrangeEnabled: false,
        autoOpenEnabled: true,
        autoOpenMode: "fixed",
        autoOpenMonths: 24,
      },
    });
    const unread = await app.inject({
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/messaging/unread-count`,
      headers: targetHeaders,
    });

    for (const response of [
      properties,
      profile,
      profilePatch,
      calendarSettingsRead,
      calendarSettings,
      unread,
    ]) {
      expect(response.statusCode).toBe(500);
      expect(response.headers["access-control-allow-origin"]).toBe("https://pms.localhost");
      expect(response.json()).toMatchObject({
        code: "read_model_unavailable",
        category: "read_model",
      });
    }

    expect(paymentSettings.statusCode).toBe(404);
    expect(properties.json()).toMatchObject({
      message: "PMS property summary read model is unavailable.",
    });
    expect(profile.json()).toMatchObject({
      message: "PMS property profile read model is unavailable.",
    });
    expect(profilePatch.json()).toMatchObject({
      message: "PMS property profile write model is unavailable.",
    });
    expect(calendarSettingsRead.json()).toMatchObject({
      message: "PMS calendar settings read model is unavailable.",
    });
    expect(calendarSettings.json()).toMatchObject({
      message: "PMS calendar settings write model is unavailable.",
    });
    expect(unread.json()).toMatchObject({
      message: "PMS messaging unread count read model is unavailable.",
    });
  });

  it("rejects PMS Web target property facades when the PMS property is not linked", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      linkedPmsPropertyId: null,
      pmsOperationsAllowedOrigins: ["https://pms.localhost"],
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/messaging/unread-count`,
      headers: {
        authorization: "Bearer valid-token",
        origin: "https://pms.localhost",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBe("https://pms.localhost");
    expect(response.json()).toMatchObject({
      code: "missing_resource_access",
      category: "authorization",
    });
  });

  it("does not expose retired Channex placeholder routes", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      pmsOperationsAllowedOrigins: ["https://pms.localhost"],
    });

    for (const suffix of ["status", "channels"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/pms/properties/${pmsPropertyId}/channex/${suffix}`,
        headers: {
          authorization: "Bearer valid-token",
          origin: "https://pms.localhost",
        },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it("returns PMS room-type detail through the P1a route contract", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/room-types/${pmsRoomTypes[0].roomTypeId}`,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body as PmsOperationsTestDetailResponse<PmsRoomType>).toMatchObject({
      contractVersion: "pms-operations.v1",
      propertyId: pmsPropertyId,
      item: {
        roomTypeId: pmsRoomTypes[0].roomTypeId,
        name: "Alpine Suite",
      },
    });
  });

  it("creates a PMS room type through the target property-scoped route", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    for (const bathroomType of [null, "", "ensuite"]) {
      const invalid = await injectJson(app, {
        method: "POST",
        url: `/api/pms/properties/${pmsPropertyId}/room-types`,
        payload: {
          commandId: "cmd-room-type-invalid-bathroom",
          idempotencyKey: "room-type-invalid-bathroom",
          name: "Invalid Bathroom Suite",
          bathroomType,
          baseRate: "240.00",
          operatingPeriods: [{ from: "01-01", to: "12-31" }],
          seasons: [{ name: "Default", rate: "240", from: "01-01", to: "12-31" }],
        },
        headers: { authorization: "Bearer valid-token" },
      });
      expect(invalid.statusCode).toBe(400);
    }
    expect(commandRepository.roomTypeCreates).toHaveLength(0);

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/pms/properties/${pmsPropertyId}/room-types`,
      payload: {
        commandId: "cmd-room-type-create-001",
        idempotencyKey: "room-type-create-001",
        initialSetupOnly: true,
        name: "Loft Suite",
        category: "suite",
        description: "Top-floor suite.",
        maxAdults: 2,
        maxChildren: 2,
        maxOccupancy: 4,
        bedType: "1 King Bed",
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: 32,
        baseRate: 0,
        currency: "eur",
        operatingPeriods: [{ from: "01-01", to: "12-31" }],
        seasons: [{ name: "Default", rate: "240", from: "01-01", to: "12-31", minStay: 1 }],
        nonRefundableEnabled: true,
        nonRefundableRate: 216,
        amenities: ["wifi", "terrace"],
        images: [
          { url: "https://cdn.vayada.example/loft.jpg", altText: "Loft Suite" },
          "https://cdn.vayada.example/loft-balcony.jpg",
        ],
        totalRooms: 3,
        sortOrder: 7,
      },
      headers: {
        authorization: "Bearer valid-token",
        "x-hotel-id": "legacy-booking-hotel-should-be-ignored",
      },
    });
    const body = response.body as PmsRoomTypeCommandResponse;

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      contractVersion: "pms-operations.v1",
      propertyId: pmsPropertyId,
      item: {
        name: "Loft Suite",
        category: "suite",
        baseRate: { amountDecimal: "240.00", currency: "EUR" },
        ratePlans: [
          { code: "FLEX", baseRate: { amountDecimal: "240.00", currency: "EUR" } },
          { code: "NRF", baseRate: { amountDecimal: "216.00", currency: "EUR" } },
        ],
        media: [
          { url: "https://cdn.vayada.example/loft.jpg", altText: "Loft Suite" },
          { url: "https://cdn.vayada.example/loft-balcony.jpg" },
        ],
        roomCount: 3,
      },
      commandMeta: {
        commandId: "cmd-room-type-create-001",
        idempotencyKey: "room-type-create-001",
        sideEffects: ["ari_changed", "audit_event"],
      },
    });
    expect(commandRepository.roomTypeCreates).toHaveLength(1);
    expect(commandRepository.roomTypeCreates[0]).toMatchObject({
      propertyId: pmsPropertyId,
      initialSetupOnly: true,
      name: "Loft Suite",
      baseRate: { amountDecimal: "240.00", currency: "EUR" },
      nonRefundableRate: { amountDecimal: "216.00", currency: "EUR" },
      attributes: {
        bedType: "1 King Bed",
        bedrooms: 1,
        bathrooms: 1,
        bathroomType: "private",
        size: 32,
      },
      roomCount: 3,
      operatingPeriods: [{ from: "01-01", to: "12-31" }],
      seasons: [
        {
          from: "01-01",
          to: "12-31",
          rate: { amountDecimal: "240.00", currency: "EUR" },
          minStayNights: 1,
        },
      ],
      audit: {
        actor: {
          kind: "user",
          userId: "user_hotel_owner",
        },
      },
    });
    expect(commandRepository.outboxEnqueues).toEqual([
      "ari_changed:f6855000-0000-0000-0000-000000000003",
    ]);
    expect(commandRepository.auditEvents).toEqual([
      "room_type_created:f6855000-0000-0000-0000-000000000003",
    ]);
  });

  it("defaults omitted bathroom facts for room-type create clients", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/pms/properties/${pmsPropertyId}/room-types`,
      payload: {
        commandId: "cmd-room-type-default-bathroom",
        idempotencyKey: "room-type-default-bathroom",
        name: "Simple Room",
        baseRate: "120.00",
        operatingPeriods: [{ from: "01-01", to: "12-31" }],
        seasons: [{ name: "Default", rate: "120", from: "01-01", to: "12-31" }],
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(commandRepository.roomTypeCreates).toHaveLength(1);
    expect(commandRepository.roomTypeCreates[0]?.attributes).toMatchObject({
      bathroomType: "private",
      bathrooms: 1,
    });
  });

  it("creates, updates, and releases target room blocks with refresh and ARI metadata", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });
    const headers = { authorization: "Bearer valid-token" };
    const create = await injectJson(app, {
      method: "POST",
      url: `/api/pms/properties/${pmsPropertyId}/room-blocks`,
      headers,
      payload: {
        commandId: "cmd-room-block-create",
        idempotencyKey: "room-block-create",
        roomTypeId: pmsRoomTypes[0].roomTypeId,
        roomIds: [pmsRooms[0].roomId, pmsRooms[1].roomId],
        startsOn: "2026-08-20",
        endsOn: "2026-08-22",
        reason: "Renovation",
      },
    });
    expect(create.statusCode).toBe(200);
    expect(create.body).toMatchObject({
      items: [
        { version: "room-block-v1", startsOn: "2026-08-20", endsOn: "2026-08-22" },
        { version: "room-block-v1", startsOn: "2026-08-20", endsOn: "2026-08-22" },
      ],
      commandMeta: { sideEffects: ["calendar_refresh", "ari_changed", "audit_event"] },
    });
    expect(commandRepository.roomBlockCreates[0]).toMatchObject({
      propertyId: pmsPropertyId,
      roomIds: [pmsRooms[0].roomId, pmsRooms[1].roomId],
      audit: { actor: { kind: "user", userId: "user_hotel_owner" } },
    });

    const block = (create.body as { items: PmsRoomBlockSummary[] }).items[0]!;
    const update = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/room-blocks/${block.blockId}`,
      headers,
      payload: {
        commandId: "cmd-room-block-update",
        idempotencyKey: "room-block-update",
        expectedVersion: block.version,
        endsOn: "2026-08-23",
        reason: "Extended renovation",
      },
    });
    expect(update.statusCode).toBe(200);
    expect(update.body).toMatchObject({
      items: [{ version: "room-block-v2", endsOn: "2026-08-23" }],
    });

    const release = await injectJson(app, {
      method: "DELETE",
      url: `/api/pms/properties/${pmsPropertyId}/room-blocks/${block.blockId}`,
      headers,
      payload: {
        commandId: "cmd-room-block-release",
        idempotencyKey: "room-block-release",
        expectedVersion: "room-block-v2",
      },
    });
    expect(release.statusCode).toBe(200);
    expect(release.body).toMatchObject({ items: [{ status: "released" }] });
  });

  it("validates and routes a property-scoped room reorder command", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });
    const orderedRoomIds = pmsRooms.map(({ roomId }) => roomId).reverse();
    const expectedVersion = pmsRoomOrderVersion(pmsRooms.map(({ roomId }) => roomId));
    const response = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/rooms/reorder`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        commandId: "cmd-room-reorder",
        idempotencyKey: "room-reorder",
        expectedVersion,
        orderedRoomIds: orderedRoomIds.map((roomId) => roomId.toUpperCase()),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      propertyId: pmsPropertyId,
      orderedRoomIds,
      orderVersion: pmsRoomOrderVersion(orderedRoomIds),
      commandMeta: { sideEffects: ["audit_event"] },
    });
    expect(commandRepository.roomOrderCommands).toMatchObject([
      {
        propertyId: pmsPropertyId,
        expectedVersion,
        orderedRoomIds,
        audit: { actor: { kind: "user", userId: "user_hotel_owner" } },
      },
    ]);

    const duplicate = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/rooms/reorder`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        commandId: "cmd-room-reorder-duplicate",
        idempotencyKey: "room-reorder-duplicate",
        expectedVersion,
        orderedRoomIds: [pmsRooms[0].roomId, pmsRooms[0].roomId],
      },
    });
    expect(duplicate.statusCode).toBe(400);

    const mixed = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/rooms/reorder`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        commandId: "cmd-room-reorder-mixed",
        idempotencyKey: "room-reorder-mixed",
        expectedVersion,
        orderedRoomIds: [pmsRooms[0].roomId, 42],
      },
    });
    expect(mixed.statusCode).toBe(400);
    expect(commandRepository.roomOrderCommands).toHaveLength(1);
  });

  it("rejects stale and unauthorized room-block writes before mutation", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    const entitlement: ProductEntitlement = {
      product: "pms",
      key: "property-management",
      status: "active",
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: pmsPropertyId,
      },
    };
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [entitlement],
      pmsOperationsCommandRepository: commandRepository,
    });
    const stale = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/room-blocks/${pmsRoomBlocks[0].blockId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        commandId: "cmd-room-block-stale",
        idempotencyKey: "room-block-stale",
        expectedVersion: "room-block-v0",
        reason: "Stale edit",
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).toMatchObject({ code: "version_conflict", category: "conflict" });

    const malformedDate = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/room-blocks/${pmsRoomBlocks[0].blockId}`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        commandId: "cmd-room-block-malformed-date",
        idempotencyKey: "room-block-malformed-date",
        expectedVersion: pmsRoomBlocks[0].version,
        startsOn: 123,
        reason: "Must not silently drop the date",
      },
    });
    expect(malformedDate.statusCode).toBe(400);
    expect(malformedDate.body).toMatchObject({ code: "invalid_body", category: "validation" });
    await app.close();

    app = buildAuthenticatedApp({
      permissions: [] as PermissionKey[],
      entitlements: [entitlement],
      pmsOperationsCommandRepository: commandRepository,
    });
    const forbidden = await injectJson(app, {
      method: "POST",
      url: `/api/pms/properties/${pmsPropertyId}/room-blocks`,
      headers: { authorization: "Bearer valid-token" },
      payload: {
        commandId: "cmd-room-block-forbidden",
        idempotencyKey: "room-block-forbidden",
        roomTypeId: pmsRoomTypes[0].roomTypeId,
        roomIds: [pmsRooms[0].roomId],
        startsOn: "2026-08-20",
        endsOn: "2026-08-20",
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.body).toMatchObject({ code: "missing_permission" });
    expect(commandRepository.roomBlockCreates).toHaveLength(0);
  });

  it("rejects stale currency before creating an onboarding room", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      settingsRepository: {
        ...bookingSettingsRepository,
        async findPropertySettingsByHotelId(propertyId) {
          expect(propertyId).toBe(pmsPropertyId);
          return { id: propertyId, defaultCurrency: "IDR" };
        },
      },
      pmsOperationsCommandRepository: commandRepository,
    });

    const payload = {
      commandId: "cmd-onboarding-room-type-create",
      idempotencyKey: "onboarding-room-type-create",
      onboardingSetup: true,
      initialSetupOnly: false,
      name: "Pool Villa",
      bathroomType: "private",
      bathrooms: 1,
      maxOccupancy: 4,
      baseRate: "280.00",
      currency: "USD",
      operatingPeriods: [{ from: "01-01", to: "12-31" }],
      seasons: [{ name: "Year-round", rate: "280.00", from: "01-01", to: "12-31", minStay: 1 }],
      totalRooms: 2,
    };
    const staleResponse = await injectJson(app, {
      method: "POST",
      url: `/api/pms/properties/${pmsPropertyId}/room-types`,
      payload,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.body).toMatchObject({ code: "property_currency_conflict" });
    expect(commandRepository.roomTypeCreates).toHaveLength(0);

    const currentResponse = await injectJson(app, {
      method: "POST",
      url: `/api/pms/properties/${pmsPropertyId}/room-types`,
      payload: {
        ...payload,
        commandId: "cmd-onboarding-room-type-create-idr",
        idempotencyKey: "onboarding-room-type-create-idr",
        currency: "IDR",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(currentResponse.statusCode).toBe(200);
    expect(commandRepository.roomTypeCreates).toHaveLength(1);
    expect(commandRepository.roomTypeCreates[0]).toMatchObject({
      initialSetupOnly: false,
      baseRate: { amountDecimal: "280.00", currency: "IDR" },
      seasons: [
        expect.objectContaining({
          rate: { amountDecimal: "280.00", currency: "IDR" },
          minStayNights: 1,
        }),
      ],
    });
  });

  it("updates and reads back PMS room-type location through the target route", async () => {
    const roomTypes = structuredClone(pmsRoomTypes);
    const commandRepository = createPmsOperationsCommandRepository(roomTypes);
    const readRepository: PmsOperationsReadRepository = {
      ...pmsOperationsRepository,
      async listRoomTypesByPropertyId(propertyId) {
        expect(propertyId).toBe(pmsPropertyId);
        return { items: roomTypes, sourceFreshness: { owner: "pms", status: "fresh" } };
      },
      async findRoomTypeById(propertyId, roomTypeId) {
        expect(propertyId).toBe(pmsPropertyId);
        return roomTypes.find((roomType) => roomType.roomTypeId === roomTypeId) ?? null;
      },
    };
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage", "pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      pmsOperationsRepository: readRepository,
      pmsOperationsCommandRepository: commandRepository,
    });

    const update = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/room-types/${pmsRoomTypes[0].roomTypeId}`,
      payload: {
        commandId: "cmd-room-type-location-update",
        idempotencyKey: "room-type-location-update",
        locationAddress: "Seestrasse 12, Innsbruck",
        latitude: 47.2692,
        longitude: 11.4041,
        name: "Ignored by location update",
      },
      headers: { authorization: "Bearer valid-token" },
    });
    const readback = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/room-types/${pmsRoomTypes[0].roomTypeId}`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(update.statusCode).toBe(200);
    expect(update.body as PmsRoomTypeCommandResponse).toMatchObject({
      item: {
        roomTypeId: pmsRoomTypes[0].roomTypeId,
        name: "Alpine Suite",
        attributes: {
          locationAddress: "Seestrasse 12, Innsbruck",
          latitude: 47.2692,
          longitude: 11.4041,
        },
      },
      commandMeta: {
        commandId: "cmd-room-type-location-update",
        idempotencyKey: "room-type-location-update",
        sideEffects: ["audit_event"],
      },
    });
    expect(readback.statusCode).toBe(200);
    expect(
      (readback.body as PmsOperationsTestDetailResponse<PmsRoomType>).item.attributes,
    ).toMatchObject({
      locationAddress: "Seestrasse 12, Innsbruck",
      latitude: 47.2692,
      longitude: 11.4041,
    });
    expect(commandRepository.roomTypeUpdates).toHaveLength(1);
    expect(commandRepository.roomTypeUpdates[0]).toMatchObject({
      attributes: {
        locationAddress: "Seestrasse 12, Innsbruck",
        latitude: 47.2692,
        longitude: 11.4041,
      },
    });
  });

  it("rejects invalid PMS room-type location coordinates before update", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const response = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/room-types/${pmsRoomTypes[0].roomTypeId}`,
      payload: {
        commandId: "cmd-room-type-location-invalid",
        idempotencyKey: "room-type-location-invalid",
        latitude: 91,
        longitude: 11.4041,
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_body",
      message: "Room type update latitude must be between -90 and 90.",
    });

    const booleanResponse = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/room-types/${pmsRoomTypes[0].roomTypeId}`,
      payload: {
        commandId: "cmd-room-type-location-boolean-invalid",
        idempotencyKey: "room-type-location-boolean-invalid",
        latitude: true,
        longitude: 11.4041,
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(booleanResponse.statusCode).toBe(400);
    expect(booleanResponse.body).toMatchObject({
      code: "invalid_body",
      message: "Room type update latitude must be between -90 and 90.",
    });
    expect(commandRepository.roomTypeUpdates).toHaveLength(0);
  });

  it("rejects PMS room-type create payloads without command metadata", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
    });

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/pms/properties/${pmsPropertyId}/room-types`,
      payload: { name: "Loft Suite", baseRate: 240, currency: "EUR" },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_body",
      message: "Room type create requires commandId, idempotencyKey, and name.",
    });
  });

  it("rejects invalid PMS room-type create numeric inputs", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: pmsPropertyId,
          },
        },
      ],
      pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
    });

    const cases = [
      {
        patch: { totalRooms: "1.5" },
        message: "Room type create totalRooms must be a non-negative integer.",
      },
      {
        patch: { nonRefundableEnabled: true },
        message:
          "Room type create non-refundable rate requires a valid nonRefundableRate or nonRefundableDiscount.",
      },
      {
        patch: {
          baseRate: "240.999",
          seasons: [{ name: "Default", rate: "240.999", from: "01-01", to: "12-31", minStay: 1 }],
        },
        message: "Room type create requires a valid baseRate.",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const response = await injectJson(app, {
        method: "POST",
        url: `/api/pms/properties/${pmsPropertyId}/room-types`,
        payload: {
          commandId: `cmd-room-type-invalid-${index}`,
          idempotencyKey: `room-type-invalid-${index}`,
          name: "Loft Suite",
          baseRate: "240.00",
          currency: "EUR",
          operatingPeriods: [{ from: "01-01", to: "12-31" }],
          seasons: [{ name: "Default", rate: "240", from: "01-01", to: "12-31", minStay: 1 }],
          ...testCase.patch,
        },
        headers: { authorization: "Bearer valid-token" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toMatchObject({
        code: "invalid_body",
        message: testCase.message,
      });
    }
  });

  it("returns idempotency conflicts from PMS room-type create", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
    });

    const response = await injectJson(app, {
      method: "POST",
      url: `/api/pms/properties/${pmsPropertyId}/room-types`,
      payload: {
        commandId: "cmd-room-type-create-conflict",
        idempotencyKey: "room-type-create-conflict",
        name: "Loft Suite",
        bathroomType: "private",
        bathrooms: 1,
        baseRate: 240,
        currency: "EUR",
        operatingPeriods: [{ from: "01-01", to: "12-31" }],
        seasons: [{ name: "Default", rate: "240", from: "01-01", to: "12-31", minStay: 1 }],
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: "idempotency_conflict",
      category: "conflict",
    });
  });

  it("enforces the PMS room-type create authorization matrix", async () => {
    const pmsEntitlement: ProductEntitlement = {
      product: "pms",
      key: "property-management",
      status: "active",
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: pmsPropertyId,
      },
    };
    const payload = {
      commandId: "cmd-room-type-auth",
      idempotencyKey: "room-type-auth",
      name: "Loft Suite",
      baseRate: 240,
      currency: "EUR",
      operatingPeriods: [{ from: "01-01", to: "12-31" }],
      seasons: [{ name: "Default", rate: "240", from: "01-01", to: "12-31", minStay: 1 }],
    };
    const cases = [
      {
        name: "missing auth",
        appOptions: { pmsOperationsCommandRepository: createPmsOperationsCommandRepository() },
        headers: undefined,
        status: 401,
        code: "unauthenticated",
      },
      {
        name: "invalid auth",
        appOptions: { pmsOperationsCommandRepository: createPmsOperationsCommandRepository() },
        headers: { authorization: "Bearer invalid-token" },
        status: 401,
        code: "unauthenticated",
      },
      {
        name: "missing permission",
        appOptions: {
          permissions: [] as PermissionKey[],
          pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
        },
        headers: { authorization: "Bearer valid-token" },
        status: 403,
        code: "missing_permission",
      },
      {
        name: "missing entitlement",
        appOptions: {
          permissions: ["pms.operations.manage"] as PermissionKey[],
          entitlements: [] as ProductEntitlement[],
          pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
        },
        headers: { authorization: "Bearer valid-token" },
        status: 403,
        code: "missing_entitlement",
      },
      {
        name: "inactive entitlement",
        appOptions: {
          permissions: ["pms.operations.manage"] as PermissionKey[],
          entitlements: [{ ...pmsEntitlement, status: "suspended" as const }],
          pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
        },
        headers: { authorization: "Bearer valid-token" },
        status: 403,
        code: "inactive_entitlement",
      },
      {
        name: "missing property link",
        appOptions: {
          permissions: ["pms.operations.manage"] as PermissionKey[],
          entitlements: [pmsEntitlement],
          linkedPmsPropertyId: "f6853000-0000-0000-0000-000000000099",
          pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
        },
        headers: { authorization: "Bearer valid-token" },
        status: 403,
        code: "missing_resource_access",
      },
    ];

    for (const testCase of cases) {
      app = buildAuthenticatedApp(testCase.appOptions);
      const response = await injectJson(app, {
        method: "POST",
        url: `/api/pms/properties/${pmsPropertyId}/room-types`,
        payload,
        headers: testCase.headers,
      });
      await app.close();
      app = null;

      expect(response.statusCode, testCase.name).toBe(testCase.status);
      expect((response.body as { code: string }).code, testCase.name).toBe(testCase.code);
    }
  });

  it("returns PMS calendar days and room blocks using the P1b route contract fixture", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsCalendarBlocksReadCase.request),
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    const body = response.body as PmsOperationsTestCalendarResponse;
    expect(response.statusCode).toBe(pmsCalendarBlocksReadCase.expected.status);
    expect(body.contractVersion).toBe("pms-operations.v1");
    expect(body.days).toHaveLength(pmsCalendarBlocksReadCase.expected.dayCount!);
    for (const path of pmsCalendarBlocksReadCase.expected.mustInclude ?? []) {
      expect(readContractPath(body, path), path).not.toBeUndefined();
    }
    expect(
      body.days.every(
        (day) => day.availableCount + day.assignedCount + day.blockedCount === day.totalCount,
      ),
    ).toBe(true);
    expect(body.days.flatMap((day) => day.blocks)).toEqual(
      expect.arrayContaining([pmsRoomBlocks[0], pmsRoomBlocks[1]]),
    );
    expect(body.days[0].assignmentRefs).toEqual(["f6855500-0000-0000-0000-000000000001"]);
    expect(body.days[0].occupiedCount).toBe(1);
    expect(body.days[1].sourceFreshness).toEqual({ pms: { status: "fresh" } });
  });

  it("preserves nested PMS calendar source freshness from target rows", async () => {
    const pool: PmsOperationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<T>> {
        expect(text).toContain('inventory.source_freshness AS "sourceFreshness"');
        expect(values).toEqual([pmsPropertyId, "2026-08-15", "2026-08-17"]);
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [
            {
              stayDate: "2026-08-15",
              roomTypeId: pmsRoomTypes[0].roomTypeId,
              totalCount: 2,
              assignedCount: 1,
              occupiedCount: 1,
              blockedCount: 1,
              availableCount: 0,
              status: "limited",
              blocks: [pmsRoomBlocks[0]],
              assignmentRefs: ["f6855500-0000-0000-0000-000000000001"],
              sourceFreshness: { pms: { status: "fresh" } },
            },
          ] as unknown as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetPmsOperationsReadRepository({
      connectionString: "postgresql://pms-operations-read",
      pool,
    });

    const result = await repository.listCalendarDaysByPropertyId(pmsPropertyId, {
      from: "2026-08-15",
      to: "2026-08-17",
    });

    expect(result.items[0]?.sourceFreshness).toEqual({ pms: { status: "fresh" } });
  });

  it("builds status-filtered PMS reservation count queries with assignment payload status data", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool: PmsOperationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<T>> {
        queries.push({ text, values });
        if (text.includes("FROM finance.billing_entitlements")) {
          expect(values).toEqual([pmsPropertyId]);
          return {
            command: "SELECT",
            rowCount: 1,
            oid: 0,
            fields: [],
            rows: [{ plan: "fixed" }] as unknown as T[],
          };
        }
        const isCountQuery = text.includes("COUNT(*)::text AS total");
        if (isCountQuery) {
          expect(values).toEqual([pmsPropertyId, "no_show"]);
          expect(text).toContain("assignment.assignment_payload");
          expect(text).toContain("primary_assignment.assignment_payload ->> 'operationalStatus'");
          return {
            command: "SELECT",
            rowCount: 1,
            oid: 0,
            fields: [],
            rows: [{ total: "0" }] as unknown as T[],
          };
        }
        expect(values).toEqual([pmsPropertyId, "no_show", 25, 0]);
        expect(text).toContain("SELECT assignment.*");
        return {
          command: "SELECT",
          rowCount: 0,
          oid: 0,
          fields: [],
          rows: [] as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetPmsOperationsReadRepository({
      connectionString: "postgresql://pms-operations-read",
      pool,
    });

    const result = await repository.listReservationsByPropertyId(pmsPropertyId, {
      status: "no_show",
      limit: 25,
      offset: 0,
    });

    expect(result).toMatchObject({ items: [], total: 0 });
    expect(queries).toHaveLength(3);
  });

  it("checks command-wide physical-room availability against exact stay windows", async () => {
    const pool: PmsOperationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<T>> {
        expect(text).toContain(
          "COALESCE(assignment.check_in, booking.check_in) < requested.check_out",
        );
        expect(text).toContain(
          "COALESCE(assignment.check_out, booking.check_out) > requested.check_in",
        );
        expect(text).toContain("assignment.assignment_status NOT IN ('canceled', 'released')");
        expect(text).toContain("room.operational_label_status = 'verified'");
        expect(text).toContain("room.room_number IS NOT NULL");
        expect(text).toContain("sibling.room_id = requested.room_id");
        expect(text).toContain("FROM pms.inventory_days inventory");
        expect(text).toContain("inventory.status <> 'closed'");
        expect(text).toContain("inventory.effective_sellable_limit_count IS NOT NULL");
        expect(text).toContain("inventory.available_count >= (");
        expect(text).toContain("FROM requested sibling");
        expect(values).toEqual([
          pmsPropertyId,
          JSON.stringify([
            { roomId: pmsRooms[0].roomId, checkIn: "2027-07-01", checkOut: "2027-07-03" },
            { roomId: pmsRooms[1].roomId, checkIn: "2027-07-02", checkOut: "2027-07-04" },
          ]),
        ]);
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [{ available: true }, { available: false }] as unknown as T[],
        };
      },
    };
    const repository = createTargetPmsOperationsReadRepository({
      connectionString: "postgresql://pms-operations-read",
      pool,
    });

    await expect(
      repository.getPhysicalRoomAvailability(pmsPropertyId, [
        { roomId: pmsRooms[0].roomId, checkIn: "2027-07-01", checkOut: "2027-07-03" },
        { roomId: pmsRooms[1].roomId, checkIn: "2027-07-02", checkOut: "2027-07-04" },
      ]),
    ).resolves.toEqual([true, false]);
  });

  it("builds PMS calendar reservation overlap queries without arrival pagination", async () => {
    const pool: PmsOperationsReadPool = {
      async query<T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: unknown[],
      ): Promise<QueryResult<T>> {
        expect(values).toEqual([pmsPropertyId, "2026-08-18", "2026-08-15"]);
        expect(text).toContain("booking.check_in < $2::date");
        expect(text).toContain("booking.check_out > $3::date");
        expect(text).not.toMatch(/\bLIMIT\s+\$/);
        expect(text).not.toMatch(/\bOFFSET\s+\$/);
        return {
          command: "SELECT",
          rowCount: 0,
          oid: 0,
          fields: [],
          rows: [] as T[],
        };
      },
      async end() {},
    };
    const repository = createTargetPmsOperationsReadRepository({
      connectionString: "postgresql://pms-operations-read",
      pool,
    });

    const result = await repository.listReservationsOverlappingStayRangeByPropertyId?.(
      pmsPropertyId,
      {
        from: "2026-08-15",
        to: "2026-08-18",
      },
    );

    expect(result).toMatchObject({ items: [], total: 0 });
  });

  it("rejects PMS calendar ranges over the documented maximum", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsCalendarRangeTooLargeCase.request),
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(pmsCalendarRangeTooLargeCase.expected.status);
    expect((response.body as { code: string }).code).toBe(
      pmsCalendarRangeTooLargeCase.expected.errorCode,
    );
  });

  it("fails PMS calendar reads explicitly when the read model is unavailable", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsRepository: {
        ...pmsOperationsRepository,
        async listCalendarDaysByPropertyId() {
          throw new Error("projection unavailable");
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsCalendarReadModelUnavailableCase.request),
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(pmsCalendarReadModelUnavailableCase.expected.status);
    expect(response.body).toMatchObject({
      code: pmsCalendarReadModelUnavailableCase.expected.errorCode,
      category: "read_model",
      message: pmsCalendarReadModelUnavailableCase.expected.message,
    });
  });

  it.each([
    { name: "over-capacity", override: { availableCount: 1 } },
    {
      name: "closed with availability",
      override: { totalCount: 3, status: "closed" as const, availableCount: 1 },
    },
  ])("rejects $name PMS calendar rows", async ({ override }) => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsRepository: {
        ...pmsOperationsRepository,
        async listCalendarDaysByPropertyId() {
          return {
            items: [{ ...pmsCalendarDays[0], ...override }],
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsCalendarBlocksReadCase.request),
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      code: "read_model_unavailable",
      category: "read_model",
      message: "PMS calendar read model is unavailable.",
    });
  });

  it("rejects PMS calendar rows whose occupied count exceeds reserved inventory", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      pmsOperationsRepository: {
        ...pmsOperationsRepository,
        async listCalendarDaysByPropertyId() {
          return { items: [{ ...pmsCalendarDays[0], occupiedCount: 2 }] };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsCalendarBlocksReadCase.request),
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      code: "read_model_unavailable",
      category: "read_model",
    });
  });

  it.each([
    { name: "reduced sellable inventory", status: "open" as const, availableCount: 0 },
    { name: "closed inventory", status: "closed" as const, availableCount: 0 },
  ])("accepts valid $name calendar rows", async ({ status, availableCount }) => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      pmsOperationsRepository: {
        ...pmsOperationsRepository,
        async listCalendarDaysByPropertyId() {
          return {
            items: [{ ...pmsCalendarDays[0], totalCount: 3, status, availableCount }],
          };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsCalendarBlocksReadCase.request),
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("returns PMS room blocks using the P1b route contract fixture", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsRoomBlocksReadCase.request),
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    const body = response.body as PmsOperationsTestListResponse<PmsRoomBlockSummary>;
    expect(response.statusCode).toBe(pmsRoomBlocksReadCase.expected.status);
    expect(body.items).toHaveLength(pmsRoomBlocksReadCase.expected.itemCount!);
    for (const path of pmsRoomBlocksReadCase.expected.mustInclude ?? []) {
      expect(readContractPath(body, path), path).not.toBeUndefined();
    }
    expect(body.items.some((block) => block.roomId)).toBe(true);
    expect(body.items.some((block) => block.roomId === null)).toBe(true);
  });

  it("returns PMS operational reservations with assigned and unassigned positions", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsReservationsAssignedUnassignedCase.request),
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    const body = response.body as PmsOperationsTestReservationListResponse;
    expect(response.statusCode).toBe(pmsReservationsAssignedUnassignedCase.expected.status);
    expect(body.items).toHaveLength(pmsReservationsAssignedUnassignedCase.expected.itemCount!);
    for (const path of pmsReservationsAssignedUnassignedCase.expected.mustInclude ?? []) {
      expect(readContractPath(body, path), path).not.toBeUndefined();
    }
    expect(body.pagination).toEqual({ total: 2, limit: 50, offset: 0 });
    expect(
      body.items.flatMap((item) =>
        item.assignments.map((assignment) => assignment.assignmentStatus),
      ),
    ).toEqual(["assigned", "pending"]);
    expect(body.items[1].assignments[0].roomId).toBeNull();
  });

  it("returns PMS reservation empty states and forwards pagination/search filters", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsRepository: {
        ...pmsOperationsRepository,
        async listReservationsByPropertyId(propertyId, filters) {
          expect(propertyId).toBe(pmsPropertyId);
          expect(filters).toEqual({
            status: "confirmed",
            arrivalFrom: "2026-08-01",
            arrivalTo: "2026-08-31",
            search: "Nora",
            limit: 500,
            offset: 10,
          });
          return { items: [], total: 0 };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/reservations`,
      query: {
        status: " confirmed ",
        arrivalFrom: "2026-08-01",
        arrivalTo: "2026-08-31",
        search: " Nora ",
        limit: "999",
        offset: "10",
      },
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      contractVersion: "pms-operations.v1",
      propertyId: pmsPropertyId,
      items: [],
      pagination: { total: 0, limit: 500, offset: 10 },
    });
  });

  it("returns PMS reservations overlapping the requested stay range for calendar reads", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsRepository: {
        ...pmsOperationsRepository,
        async listReservationsByPropertyId() {
          throw new Error("expected overlapping stay range query");
        },
        async listReservationsOverlappingStayRangeByPropertyId(propertyId, range) {
          expect(propertyId).toBe(pmsPropertyId);
          expect(range).toEqual({ from: "2026-08-15", to: "2026-08-18" });
          return { items: pmsReservations, total: pmsReservations.length };
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/reservations`,
      query: {
        stayFrom: "2026-08-15",
        stayTo: "2026-08-18",
        limit: "1",
        offset: "1",
      },
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      contractVersion: "pms-operations.v1",
      propertyId: pmsPropertyId,
      pagination: { total: pmsReservations.length, limit: 1, offset: 1 },
    });
    expect((response.body as PmsOperationsTestReservationListResponse).items).toHaveLength(1);
    expect(
      (response.body as PmsOperationsTestReservationListResponse).items[0].guestBookingId,
    ).toBe(pmsReservations[1].guestBookingId);
  });

  it("rejects PMS reservation stay ranges mixed with list filters", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsRepository: {
        ...pmsOperationsRepository,
        async listReservationsByPropertyId() {
          throw new Error("expected mixed stay range query to be rejected before list query");
        },
        async listReservationsOverlappingStayRangeByPropertyId() {
          throw new Error("expected mixed stay range query to be rejected before overlap query");
        },
      },
    });

    const response = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/reservations`,
      query: {
        stayFrom: "2026-08-15",
        stayTo: "2026-08-18",
        status: "confirmed",
        arrivalFrom: "2026-08-01",
        search: "Nora",
      },
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_query",
      category: "validation",
    });
  });

  it("returns PMS reservation detail and not-found errors", async () => {
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
    });

    const detail = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/reservations/${pmsReservations[0].guestBookingId}`,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const missing = await injectJson(app, {
      method: "GET",
      url: `/api/pms/properties/${pmsPropertyId}/reservations/f6854000-0000-0000-0000-000000009999`,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.body as PmsOperationsTestDetailResponse<PmsOperationalReservation>).toMatchObject(
      {
        contractVersion: "pms-operations.v1",
        propertyId: pmsPropertyId,
        item: {
          guestBookingId: pmsReservations[0].guestBookingId,
          assignments: [{ assignmentStatus: "assigned", roomNumber: "101" }],
          primaryGuest: {
            countryCode: "AT",
            countryCodeRaw: null,
            countryCodeReviewRequired: false,
          },
        },
      },
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toMatchObject({
      code: "reservation_not_found",
      category: "not_found",
    });
  });

  it("lists PMS private notes only through the authorized PMS notes route", async () => {
    const noteCase = pmsPrivateNoteCases["private-notes-excluded-from-public"]!;
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const response = await injectJson(app, {
      method: noteCase.request.method ?? "GET",
      url: noteCase.request.path,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const body = response.body as PmsOperationsTestPrivateNotesResponse;

    expect(response.statusCode).toBe(noteCase.expected.status);
    expect(body.items).toHaveLength(noteCase.expected.itemCount!);
    for (const path of noteCase.expected.mustInclude ?? []) {
      expect(readContractPath(body, path), path).not.toBeUndefined();
    }
    expect(body.items[0]).toMatchObject({
      noteId: pmsPrivateNotes[0].noteId,
      body: pmsPrivateNotes[0].body,
      authorDisplayName: "owner@example.com",
      auditMetadata: {
        source: "pms",
        privacyScope: "internal",
      },
    });

    const publicProfilePayload = JSON.stringify(seededPublicProfile);
    const publicQuotePayload = JSON.stringify(seededPublicQuote);
    for (const forbidden of [
      ...(noteCase.expected.publicPayloadMustExclude ?? []),
      pmsPrivateNotes[0].noteId,
      pmsPrivateNotes[0].body,
    ]) {
      const rawForbidden = forbidden.replace("items[].", "");
      expect(publicProfilePayload, forbidden).not.toContain(rawForbidden);
      expect(publicQuotePayload, forbidden).not.toContain(rawForbidden);
    }
    expect(findForbiddenPublicBookabilityKeys(seededPublicProfile)).toEqual([]);
    expect(findForbiddenPublicBookabilityKeys(seededPublicQuote)).toEqual([]);
  });

  it("creates, edits, and deletes PMS private notes with audit-only command side effects", async () => {
    const createCase = pmsPrivateNoteCases["private-note-create"]!;
    const deleteCase = pmsPrivateNoteCases["private-note-delete"]!;
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const created = await injectJson(app, {
      method: createCase.request.method ?? "POST",
      url: createCase.request.path,
      payload: createCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const createBody = created.body as PmsPrivateNoteCommandResponse;
    const updated = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/reservations/${pmsReservations[0].guestBookingId}/notes/${createBody.note.noteId}`,
      payload: {
        commandId: "f6855d00-0000-4000-8000-000000000010",
        idempotencyKey: "pms-note-update-1",
        body: "Updated note body",
      },
      headers: { authorization: "Bearer valid-token" },
    });
    const updateBody = updated.body as PmsPrivateNoteCommandResponse;
    const deleted = await injectJson(app, {
      method: deleteCase.request.method ?? "DELETE",
      url: deleteCase.request.path,
      payload: deleteCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const deleteBody = deleted.body as PmsPrivateNoteDeleteResponse;

    expect(created.statusCode).toBe(createCase.expected.status);
    expect(createBody.note).toMatchObject({
      body: createCase.request.body?.body,
      authorUserId: "user_hotel_owner",
      authorDisplayName: "Harper Owner",
      auditMetadata: {
        createdByUserId: "user_hotel_owner",
        createdByDisplayName: "Harper Owner",
        privacyScope: "internal",
      },
    });
    expect(createBody.commandMeta).toMatchObject({
      contractVersion: "pms-operations.v1",
      idempotencyKey: createCase.request.body?.idempotencyKey,
      sideEffects: createCase.expected.commandMeta?.sideEffects,
    });
    expect(updated.statusCode).toBe(200);
    expect(updateBody.note).toMatchObject({
      body: "Updated note body",
      authorUserId: createBody.note.authorUserId,
      createdAt: createBody.note.createdAt,
      auditMetadata: {
        editedByUserId: "user_hotel_owner",
        editedByDisplayName: "Harper Owner",
        editedAt: "2026-08-14T17:03:00.000Z",
      },
    });
    expect(deleted.statusCode).toBe(deleteCase.expected.status);
    expect(deleteBody).toMatchObject({
      noteId: "f6855900-0000-0000-0000-000000000001",
      commandMeta: {
        contractVersion: "pms-operations.v1",
        idempotencyKey: deleteCase.request.body?.idempotencyKey,
        sideEffects: deleteCase.expected.commandMeta?.sideEffects,
      },
    });
    expect(commandRepository.noteCreates).toHaveLength(1);
    expect(commandRepository.noteUpdates).toHaveLength(1);
    expect(commandRepository.noteDeletes).toHaveLength(1);
    expect(commandRepository.auditEvents).toEqual([
      "private_note_created:f6855900-0000-0000-0000-000000000002",
      "private_note_edited:f6855900-0000-0000-0000-000000000002",
      "private_note_deleted:f6855900-0000-0000-0000-000000000001",
    ]);
    expect(commandRepository.outboxEnqueues).toEqual([]);
  });

  it("maps PMS private note not-found and manage authorization errors", async () => {
    const missingCase = pmsPrivateNoteCases["private-note-not-found"]!;
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
    });

    const missing = await injectJson(app, {
      method: missingCase.request.method ?? "DELETE",
      url: missingCase.request.path,
      payload: missingCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    await app.close();

    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
    });
    const denied = await injectJson(app, {
      method: "POST",
      url: pmsPrivateNoteCases["private-note-create"]!.request.path,
      payload: pmsPrivateNoteCases["private-note-create"]!.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(missing.statusCode).toBe(missingCase.expected.status);
    expect(missing.body).toMatchObject({
      code: missingCase.expected.errorCode,
      category: "not_found",
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatchObject({
      code: "missing_permission",
      category: "authorization",
    });
  });

  it("routes PMS additional guest PII writes through the Booking-owned port", async () => {
    const boundaryCase = pmsAdditionalGuestCases["additional-guests-booking-pii-boundary"]!;
    const bookingGuestPiiPort = createBookingGuestPiiPort();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      bookingGuestPiiPort,
    });

    const response = await injectJson(app, {
      method: boundaryCase.request.method ?? "POST",
      url: boundaryCase.request.path,
      payload: boundaryCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const body = response.body as {
      additionalGuest: BookingGuestPii;
      reservation: PmsOperationalReservation & { additionalGuests: BookingGuestPii[] };
      commandMeta: BookingGuestPiiCommandMeta;
    };

    expect(response.statusCode).toBe(boundaryCase.expected.status);
    expect(bookingGuestPiiPort.creates).toHaveLength(1);
    expect(bookingGuestPiiPort.creates[0]).toMatchObject({
      commandId: boundaryCase.request.body?.commandId,
      idempotencyKey: boundaryCase.request.body?.idempotencyKey,
      audit: {
        actorUserId: "user_hotel_owner",
        actorOrganizationId: "org_hotel_group",
        source: "pms_operations",
      },
    });
    expect(body.additionalGuest).toMatchObject({
      guestId: "f6855800-0000-0000-0000-000000000002",
      role: "additional_guest",
      firstName: "Mira",
      email: "mira@example.test",
    });
    expect(body.reservation.additionalGuestCount).toBe(1);
    expect(body.reservation.additionalGuests).toEqual([body.additionalGuest]);
    expect(body.commandMeta).toMatchObject({
      contractVersion: boundaryCase.expected.commandMeta?.contractVersion,
      sideEffects: boundaryCase.expected.commandMeta?.sideEffects,
    });
    for (const expectedCall of boundaryCase.expected.mustCall ?? []) {
      expect(expectedCall).toBe("BookingGuestPiiCommandPort.createAdditionalGuest");
    }
    for (const forbiddenWrite of boundaryCase.expected.mustNotWrite ?? []) {
      expect(forbiddenWrite).not.toBe("pms.booking_guests");
    }
  });

  it("routes authorized primary guest nationality correction through Booking ownership", async () => {
    const bookingGuestPiiPort = createBookingGuestPiiPort();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      bookingGuestPiiPort,
      pmsOperationsRepository: {
        ...pmsOperationsRepository,
        async findReservationByGuestBookingId() {
          throw new Error("post-commit PMS read must not be required");
        },
      },
    });

    const response = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/reservations/${pmsReservations[0].guestBookingId}/primary-guest/nationality`,
      payload: {
        commandId: "command-primary-nationality",
        idempotencyKey: "idempotency-primary-nationality",
        countryCode: "NL",
      },
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(bookingGuestPiiPort.corrections).toHaveLength(1);
    expect(bookingGuestPiiPort.corrections[0]).toMatchObject({
      propertyId: pmsPropertyId,
      countryCode: "NL",
      audit: {
        actorUserId: "user_hotel_owner",
        actorOrganizationId: "org_hotel_group",
        source: "pms_operations",
      },
    });
    expect(response.body).toMatchObject({
      primaryGuest: {
        countryCode: "NL",
        countryCodeRaw: null,
        countryCodeReviewRequired: false,
        email: "Hidden until you accept",
        phone: "Hidden until you accept",
      },
      commandMeta: { contractVersion: "booking-guest-pii.v1" },
    });
  });

  it("rejects primary guest nationality correction without PMS manage permission", async () => {
    const bookingGuestPiiPort = createBookingGuestPiiPort();
    app = buildAuthenticatedApp({
      permissions: [],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      bookingGuestPiiPort,
    });
    const response = await injectJson(app, {
      method: "PATCH",
      url: `/api/pms/properties/${pmsPropertyId}/reservations/${pmsReservations[0].guestBookingId}/primary-guest/nationality`,
      payload: {
        commandId: "command-primary-nationality-denied",
        idempotencyKey: "idempotency-primary-nationality-denied",
        countryCode: "NL",
      },
      headers: { authorization: "Bearer valid-token" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ code: "missing_permission" });
    expect(bookingGuestPiiPort.corrections).toEqual([]);
  });

  it("freezes PMS checkout-charge mark-paid when the F1a finance bridge is disabled", async () => {
    const freezeRequest = checkoutChargeMarkPaidFreezeCase.request!;
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      linkedPmsPropertyId: "f3000000-0000-0000-0000-000000000686",
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsCheckoutChargeMarkPaidFreezeEnabled: freezeRequest.simulate?.rehearsalFreeze ?? true,
    });

    const response = await injectJson(app, {
      method: "POST",
      url: freezeRequest.path,
      body: freezeRequest.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(checkoutChargeMarkPaidFreezeCase.expected.status);
    expect(response.body).toMatchObject({
      code: checkoutChargeMarkPaidFreezeCase.expected.errorCode,
      category: "conflict",
    });
  });

  it("lists, creates, marks paid, and waives PMS checkout charges as operational state only", async () => {
    const chargeCase = pmsCheckoutChargeCases["checkout-charge-create-mark-paid-waive"]!;
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage", "pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsCheckoutChargeMarkPaidFreezeEnabled: false,
      pmsOperationsCommandRepository: commandRepository,
    });

    const listed = await injectJson(app, {
      method: "GET",
      url: chargeCase.request.path,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const created = await injectJson(app, {
      method: chargeCase.request.method ?? "POST",
      url: chargeCase.request.path,
      payload: chargeCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const createdBody = created.body as PmsCheckoutChargeCommandResponse;
    const paid = await injectJson(app, {
      method: "POST",
      url: `${chargeCase.request.path}/${createdBody.charge.chargeId}/mark-paid`,
      payload: {
        commandId: "cmd-checkout-charge-mark-paid-001",
        idempotencyKey: "pms-checkout-charge-mark-paid-001",
      },
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const waived = await injectJson(app, {
      method: "POST",
      url: `${chargeCase.request.path}/${createdBody.charge.chargeId}/waive`,
      payload: {
        commandId: "cmd-checkout-charge-waive-001",
        idempotencyKey: "pms-checkout-charge-waive-001",
        reason: "service recovery",
      },
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(listed.statusCode).toBe(200);
    expect(created.statusCode).toBe(chargeCase.expected.status);
    expect(paid.statusCode).toBe(chargeCase.expected.status);
    expect(waived.statusCode).toBe(chargeCase.expected.status);
    expect(createdBody.charge).toMatchObject({
      label: chargeCase.request.body?.label,
      amount: { amountDecimal: "12.00", currency: "EUR" },
      status: "pending",
      operationalOwnership: {
        owner: "pms",
        financeSettlementOwner: "finance",
        providerSettlement: false,
      },
    });
    expect((paid.body as PmsCheckoutChargeCommandResponse).charge).toMatchObject({
      status: "paid",
      settledAt: "2026-08-14T17:25:00.000Z",
      operationalOwnership: { financeSettlementOwner: "finance", providerSettlement: false },
    });
    expect((waived.body as PmsCheckoutChargeCommandResponse).charge).toMatchObject({
      status: "waived",
      waivedAt: "2026-08-14T17:30:00.000Z",
      operationalOwnership: { financeSettlementOwner: "finance", providerSettlement: false },
    });
    for (const response of [created, paid, waived]) {
      expect((response.body as PmsCheckoutChargeCommandResponse).commandMeta).toMatchObject({
        contractVersion: "pms-operations.v1",
        sideEffects: ["audit_event"],
      });
      expect(
        (response.body as PmsCheckoutChargeCommandResponse).commandMeta.sideEffects,
      ).not.toEqual(expect.arrayContaining(["finance_reconciliation", "payout_dispatch"]));
    }
    for (const forbiddenCall of chargeCase.expected.mustNotCall ?? []) {
      expect(forbiddenCall).not.toBe("PMS checkout charge command repository");
    }
    expect(commandRepository.checkoutChargeCreates).toHaveLength(1);
    expect(commandRepository.checkoutChargeMarkPaids).toHaveLength(1);
    expect(commandRepository.checkoutChargeWaives).toHaveLength(1);
    expect(commandRepository.auditEvents).toEqual([
      "checkout_charge_created:f6855700-0000-0000-0000-000000000002",
      "checkout_charge_marked_paid:f6855700-0000-0000-0000-000000000002",
      "checkout_charge_waived:f6855700-0000-0000-0000-000000000002",
    ]);
    expect(commandRepository.outboxEnqueues).toEqual([]);
  });

  it("checks out PMS reservations with inspection results, pending flags, charge snapshots, and no finance side effects", async () => {
    const checkoutCase = pmsCheckOutCases["checkout-charges-and-checkout"]!;
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const response = await injectJson(app, {
      method: checkoutCase.request.method ?? "POST",
      url: checkoutCase.request.path,
      payload: checkoutCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const body = response.body as PmsCheckOutCommandResponse;

    expect(response.statusCode).toBe(checkoutCase.expected.status);
    expect(body.commandMeta).toMatchObject({
      contractVersion: "pms-operations.v1",
      idempotencyKey: checkoutCase.request.body?.idempotencyKey,
      sideEffects: ["audit_event"],
    });
    for (const path of checkoutCase.expected.mustInclude ?? []) {
      expect(readContractPath(body, path), path).not.toBeUndefined();
    }
    expect(body.reservation.assignments).toEqual(
      expect.arrayContaining([expect.objectContaining({ assignmentStatus: "checked_out" })]),
    );
    expect(body.checkout).toMatchObject({
      inspectionResults: checkoutCase.request.body?.inspectionResults,
      chargesSettled: [expect.objectContaining({ status: "paid" })],
      checkoutNotes: checkoutCase.request.body?.checkoutNotes,
      financeHandoff: {
        financeSettlementOwner: "finance",
        providerSettlement: false,
        unsettledPaidChargeIds: ["f6855700-0000-0000-0000-000000000001"],
      },
    });
    expect(body.reservation.checkout.pendingFlags).toContain("finance_settlement_handoff_required");
    expect(body.commandMeta.sideEffects).not.toEqual(
      expect.arrayContaining(["finance_reconciliation", "payout_dispatch"]),
    );
    expect(commandRepository.checkOutCommands).toHaveLength(1);
    expect(commandRepository.auditEvents).toContain(
      "checkout_completed:f6855a00-0000-0000-0000-000000000001",
    );
    expect(commandRepository.outboxEnqueues).toEqual([]);
  });

  it("surfaces checkout pending flags for unresolved checkout charges", async () => {
    const checkoutCase = pmsCheckOutCases["checkout-charges-and-checkout"]!;
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const response = await injectJson(app, {
      method: "POST",
      url: checkoutCase.request.path,
      payload: {
        ...checkoutCase.request.body,
        commandId: "cmd-checkout-pending-001",
        idempotencyKey: "pms-checkout-pending-001",
        chargesSettled: [],
        pendingFlags: ["manual_review"],
      },
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const body = response.body as PmsCheckOutCommandResponse;

    expect(response.statusCode).toBe(200);
    expect(body.checkout.pendingFlags).toEqual([
      "finance_settlement_handoff_required",
      "manual_review",
    ]);
    expect(body.checkout.chargesSettled).toEqual([]);
    expect(body.checkout.financeHandoff.unsettledPaidChargeIds).toEqual([
      "f6855700-0000-0000-0000-000000000001",
    ]);
  });

  it("rejects malformed PMS check-out settled charge ids before dispatch", async () => {
    const checkoutCase = pmsCheckOutCases["checkout-charges-and-checkout"]!;
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const response = await injectJson(app, {
      method: "POST",
      url: checkoutCase.request.path,
      payload: {
        ...checkoutCase.request.body,
        chargesSettled: [123],
      },
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_body",
      message: "chargesSettled entries must be UUIDs.",
    });
    expect(commandRepository.checkOutCommands).toEqual([]);
  });

  it("maps PMS check-out version conflicts and replays without finance side effects", async () => {
    const conflictCase = pmsCheckOutCases["checkout-version-conflict"]!;
    const successCase = pmsCheckOutCases["checkout-charges-and-checkout"]!;
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const conflict = await injectJson(app, {
      method: conflictCase.request.method ?? "POST",
      url: conflictCase.request.path,
      payload: conflictCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const first = await injectJson(app, {
      method: "POST",
      url: successCase.request.path,
      payload: successCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const replay = await injectJson(app, {
      method: "POST",
      url: successCase.request.path,
      payload: successCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(conflict.statusCode).toBe(conflictCase.expected.status);
    expect(conflict.body).toMatchObject({ code: conflictCase.expected.errorCode });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(commandRepository.outboxEnqueues).toEqual([]);
  });

  it("executes PMS assignment assign/move/unassign/swap commands through the P1c contract", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    for (const caseId of [
      "assignment-command-assign",
      "assignment-command-move",
      "assignment-command-unassign",
      "assignment-command-swap",
    ]) {
      const commandCase = pmsAssignmentCommandCases[caseId]!;
      const response = await injectJson(app, {
        method: commandCase.request.method ?? "PATCH",
        url: commandCase.request.path,
        payload: commandCase.request.body,
        headers: {
          authorization: "Bearer valid-token",
        },
      });
      const body = response.body as PmsOperationsCommandResponse;

      expect(response.statusCode, caseId).toBe(commandCase.expected.status);
      expect(body.contractVersion, caseId).toBe("pms-operations.v1");
      expect(body.commandMeta).toMatchObject({
        contractVersion: "pms-operations.v1",
        idempotencyKey: commandCase.request.body?.idempotencyKey,
        sideEffects: commandCase.expected.commandMeta?.sideEffects,
      });
      expect(body.commandMeta.sideEffects, caseId).not.toContain("ari_changed");
      expect(body.reservation.guestBookingId, caseId).toBe(
        commandCase.request.path.split("/reservations/")[1]!.split("/")[0],
      );
    }

    expect(
      commandRepository.commands
        .filter((command): command is PmsAssignmentCommand => "action" in command)
        .map((command) => command.action),
    ).toEqual(["assign", "move", "unassign", "swap"]);
    expect(commandRepository.outboxEnqueues).toHaveLength(4);
  });

  it("maps PMS assignment command conflicts without queueing side effects", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    for (const caseId of [
      "assignment-command-conflict",
      "assignment-command-version-conflict",
      "assignment-command-assignment-conflict",
    ]) {
      const commandCase = pmsAssignmentCommandCases[caseId]!;
      const response = await injectJson(app, {
        method: commandCase.request.method ?? "PATCH",
        url: commandCase.request.path,
        payload: commandCase.request.body,
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      expect(response.statusCode, caseId).toBe(commandCase.expected.status);
      expect(response.body, caseId).toMatchObject({
        statusCode: 409,
        code: commandCase.expected.errorCode,
        category: "conflict",
      });
    }

    expect(commandRepository.outboxEnqueues).toEqual([]);
  });

  it("replays PMS assignment idempotency without duplicate calendar refresh outbox work", async () => {
    const commandCase = pmsAssignmentCommandCases["assignment-command-idempotency-replay"]!;
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const first = await injectJson(app, {
      method: commandCase.request.method ?? "PATCH",
      url: commandCase.request.path,
      payload: commandCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    const replay = await injectJson(app, {
      method: commandCase.request.method ?? "PATCH",
      url: commandCase.request.path,
      payload: commandCase.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(first.statusCode).toBe(commandCase.expected.status);
    expect(replay.statusCode).toBe(commandCase.expected.status);
    expect(replay.body).toEqual(first.body);
    expect(commandRepository.commands).toHaveLength(2);
    expect(commandRepository.outboxEnqueues).toHaveLength(1);
  });

  it("executes PMS check-in, operational status, and no-show commands with audit metadata", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    for (const caseId of ["checkin-command", "operational-status-transition", "no-show-command"]) {
      const commandCase = pmsOperationalCommandCases[caseId]!;
      const response = await injectJson(app, {
        method: commandCase.request.method ?? "POST",
        url: commandCase.request.path,
        payload: commandCase.request.body,
        headers: {
          authorization: "Bearer valid-token",
        },
      });
      const body = response.body as PmsOperationsCommandResponse;

      expect(response.statusCode, caseId).toBe(commandCase.expected.status);
      expect(body.contractVersion, caseId).toBe("pms-operations.v1");
      expect(body.commandMeta, caseId).toMatchObject({
        contractVersion: "pms-operations.v1",
        idempotencyKey: commandCase.request.body?.idempotencyKey,
        sideEffects: ["audit_event"],
      });
      for (const path of commandCase.expected.mustInclude ?? []) {
        expect(readContractPath(body, path), `${caseId}: ${path}`).not.toBeUndefined();
      }
    }

    const [checkInCommand, statusCommand, noShowCommand] = commandRepository.commands.slice(-3);
    expect(checkInCommand).toMatchObject({
      commandId: "cmd-checkin-001",
      audit: {
        actor: { kind: "user", userId: "user_hotel_owner", organizationId: "org_hotel_group" },
      },
    });
    expect(statusCommand).toMatchObject({ commandId: "cmd-status-001", status: "in_house" });
    expect(noShowCommand).toMatchObject({
      commandId: "cmd-no-show-001",
      reason: "guest did not arrive",
    });
    expect(commandRepository.auditEvents).toHaveLength(3);
  });

  it("accepts manual-payment bookings and marks received payments through target PMS commands", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [{ product: "pms", key: "property-management", status: "active" }],
      pmsOperationsCommandRepository: commandRepository,
    });
    const baseUrl = `/api/pms/properties/${pmsPropertyId}/reservations/${pmsReservations[0].guestBookingId}`;

    for (const action of ["accept", "mark-paid"] as const) {
      const response = await injectJson(app, {
        method: "POST",
        url: `${baseUrl}/${action}`,
        headers: { authorization: "Bearer valid-token" },
        payload: {
          commandId: `cmd-${action}-001`,
          idempotencyKey: `idem-${action}-001`,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        contractVersion: "pms-operations.v1",
        propertyId: pmsPropertyId,
        commandMeta: { sideEffects: ["guest_notification", "audit_event"] },
      });
    }

    expect(commandRepository.commands.slice(-2)).toMatchObject([
      { commandId: "cmd-accept-001", audit: { actor: { kind: "user" } } },
      { commandId: "cmd-mark-paid-001", audit: { actor: { kind: "user" } } },
    ]);
  });

  it("rejects assignment-scoped PMS no-show commands", async () => {
    const commandCase = pmsOperationalCommandCases["no-show-command"]!;
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    const response = await injectJson(app, {
      method: "POST",
      url: commandCase.request.path,
      payload: {
        ...commandCase.request.body,
        assignmentId: "f6855500-0000-0000-0000-000000000001",
      },
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      statusCode: 400,
      code: "invalid_body",
    });
    expect(commandRepository.commands).toHaveLength(0);
    expect(commandRepository.auditEvents).toHaveLength(0);
  });

  it("maps PMS operational invalid status transitions and version conflicts", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    for (const caseId of [
      "operational-status-invalid-transition",
      "operational-status-version-conflict",
      "no-show-version-conflict",
    ]) {
      const commandCase = pmsOperationalCommandCases[caseId]!;
      const response = await injectJson(app, {
        method: commandCase.request.method ?? "POST",
        url: commandCase.request.path,
        payload: commandCase.request.body,
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      expect(response.statusCode, caseId).toBe(commandCase.expected.status);
      expect(response.body, caseId).toMatchObject({
        code: commandCase.expected.errorCode,
      });
    }

    expect(commandRepository.auditEvents).toEqual([]);
  });

  it("reads PMS operational templates with read policy", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    for (const caseId of ["checklist-template-read", "inspection-template-read"]) {
      const templateCase = pmsOperationalTemplateCases[caseId]!;
      const response = await injectJson(app, {
        method: templateCase.request.method ?? "GET",
        ...pmsOperationsRequestOptions(templateCase.request),
        headers: {
          authorization: "Bearer valid-token",
        },
      });
      const body = response.body as PmsOperationalTemplateResponse;

      expect(response.statusCode, caseId).toBe(templateCase.expected.status);
      expect(body.contractVersion, caseId).toBe("pms-operations.v1");
      for (const path of templateCase.expected.mustInclude ?? []) {
        expect(readContractPath(body, path), `${caseId}: ${path}`).not.toBeUndefined();
      }
    }
  });

  it("writes PMS operational templates with manage policy and validation fixtures", async () => {
    const commandRepository = createPmsOperationsCommandRepository();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.manage"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: commandRepository,
    });

    for (const caseId of ["checklist-template-write", "inspection-template-write"]) {
      const templateCase = pmsOperationalTemplateCases[caseId]!;
      const response = await injectJson(app, {
        method: templateCase.request.method ?? "PUT",
        ...pmsOperationsRequestOptions(templateCase.request),
        payload: templateCase.request.body,
        headers: {
          authorization: "Bearer valid-token",
        },
      });
      const body = response.body as PmsOperationalTemplateCommandResponse;

      expect(response.statusCode, caseId).toBe(templateCase.expected.status);
      expect(body.contractVersion, caseId).toBe("pms-operations.v1");
      expect(body.commandMeta, caseId).toMatchObject({
        contractVersion: "pms-operations.v1",
        idempotencyKey: templateCase.request.body?.idempotencyKey,
        sideEffects: ["audit_event"],
      });
      for (const path of templateCase.expected.mustInclude ?? []) {
        expect(readContractPath(body, path), `${caseId}: ${path}`).not.toBeUndefined();
      }
    }

    expect(commandRepository.templateUpdates).toHaveLength(2);
    expect(commandRepository.templateUpdates.map((command) => command.templateKind)).toEqual([
      "check_in_checklist",
      "check_out_inspection",
    ]);

    for (const caseId of [
      "template-validation-non-array",
      "template-validation-oversized",
      "template-validation-missing-label",
    ]) {
      const templateCase = pmsOperationalTemplateCases[caseId]!;
      const response = await injectJson(app, {
        method: templateCase.request.method ?? "PUT",
        ...pmsOperationsRequestOptions(templateCase.request),
        payload: templateCase.request.body,
        headers: {
          authorization: "Bearer valid-token",
        },
      });

      expect(response.statusCode, caseId).toBe(templateCase.expected.status);
      expect(response.body, caseId).toMatchObject({
        code: templateCase.expected.errorCode,
      });
    }

    expect(commandRepository.templateUpdates).toHaveLength(2);

    await app.close();
    app = buildAuthenticatedApp({
      permissions: ["pms.operations.read"],
      entitlements: [
        {
          product: "pms",
          key: "property-management",
          status: "active",
        },
      ],
      pmsOperationsCommandRepository: createPmsOperationsCommandRepository(),
    });
    const readOnlyWrite = await injectJson(app, {
      method: "PUT",
      ...pmsOperationsRequestOptions(
        pmsOperationalTemplateCases["checklist-template-write"]!.request,
      ),
      payload: pmsOperationalTemplateCases["checklist-template-write"]!.request.body,
      headers: {
        authorization: "Bearer valid-token",
      },
    });
    expect(readOnlyWrite.statusCode).toBe(403);
    expect(readOnlyWrite.body).toMatchObject({ code: "missing_permission" });
  });

  it("rejects PMS operations reads with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      ...pmsOperationsRequestOptions(pmsRoomTypesReadCase.request),
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toEqual({
      statusCode: 401,
      code: "unauthenticated",
      category: "authentication",
      message: "A valid access token is required.",
    });
  });

  it("passes the PMS operations authorization denial matrix", async () => {
    type AuthenticatedAppOptions = NonNullable<Parameters<typeof buildAuthenticatedApp>[0]>;
    type PmsAuthorizationRuntimeCase = {
      condition: string;
      appOptions: AuthenticatedAppOptions;
      requestHeaders?: { authorization: string };
    };
    const pmsEntitlement: ProductEntitlement = {
      product: "pms",
      key: "property-management",
      status: "active",
      resource: {
        product: "pms",
        resourceType: "pms_property",
        resourceId: pmsPropertyId,
      },
    };
    function authorizationCases(permission: PermissionKey): PmsAuthorizationRuntimeCase[] {
      const commandOptions =
        permission === "pms.operations.manage"
          ? { pmsOperationsCommandRepository: createPmsOperationsCommandRepository() }
          : {};
      return [
        {
          condition: "missing auth",
          appOptions: commandOptions,
          requestHeaders: undefined,
        },
        {
          condition: "missing permission",
          appOptions: { ...commandOptions, permissions: [] },
          requestHeaders: { authorization: "Bearer valid-token" },
        },
        {
          condition: "missing entitlement",
          appOptions: { ...commandOptions, permissions: [permission], entitlements: [] },
          requestHeaders: { authorization: "Bearer valid-token" },
        },
        {
          condition: "inactive entitlement",
          appOptions: {
            ...commandOptions,
            permissions: [permission],
            entitlements: [{ ...pmsEntitlement, status: "suspended" as const }],
          },
          requestHeaders: { authorization: "Bearer valid-token" },
        },
        {
          condition: "missing linked property",
          appOptions: {
            ...commandOptions,
            permissions: [permission],
            entitlements: [pmsEntitlement],
            linkedPmsPropertyId: "f6853000-0000-0000-0000-000000000099",
          },
          requestHeaders: { authorization: "Bearer valid-token" },
        },
      ];
    }

    expect(pmsAuthorizationDenialCases).toHaveLength(4);

    for (const denialCase of pmsAuthorizationDenialCases) {
      const requestMethod = denialCase.request.method ?? "GET";
      const requiredPermission: PermissionKey =
        requestMethod === "GET" ? "pms.operations.read" : "pms.operations.manage";
      const pmsAuthorizationCases = authorizationCases(requiredPermission);
      for (const matrixCase of denialCase.expected.denials ?? []) {
        const runtimeCase = pmsAuthorizationCases.find(
          (candidate) => candidate.condition === matrixCase.condition,
        );
        const assertionContext = `${denialCase.caseId}: ${matrixCase.condition}`;
        expect(runtimeCase, assertionContext).toBeDefined();

        app = buildAuthenticatedApp(runtimeCase!.appOptions);
        const response = await injectJson(app, {
          method: requestMethod,
          ...pmsOperationsRequestOptions(denialCase.request),
          payload: denialCase.request.body,
          headers: runtimeCase!.requestHeaders,
        });
        await app.close();
        app = null;

        expect(response.statusCode, assertionContext).toBe(matrixCase.status);
        expect((response.body as { code: string }).code, assertionContext).toBe(
          matrixCase.errorCode,
        );
      }
    }
  });

  it("returns 404 when the authorized booking hotel has no settings record", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/addons",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      message: "Booking hotel addon settings not found.",
    });
  });

  it("returns 404 when the authorized booking hotel has no guest-form settings record", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/guest-form",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      message: "Booking hotel guest-form settings not found.",
    });
  });

  it("returns the legacy empty benefits list when the authorized booking hotel has no benefits record", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/benefits",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      benefits: [],
    });
  });

  it("returns 404 when the authorized booking hotel has no localization settings record", async () => {
    app = buildAuthenticatedApp({ linkedHotelId: "booking_hotel_missing" });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_missing/settings/localization",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      statusCode: 404,
      code: "not_found",
      category: "read_model",
      message: "Booking hotel localization settings not found.",
    });
  });

  it("allows the booking policy route with auth, permission, entitlement, and linked resource", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson<{
      group: string;
      authorized: boolean;
      hotelId: string;
      userId: string;
    }>(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      group: "booking",
      authorized: true,
      hotelId: "booking_hotel_alpenrose",
      userId: "user_hotel_owner",
    });
  });

  it("rejects the booking policy route without authentication", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects the booking policy route with an invalid token", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer invalid-token",
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects the booking policy route when permission is missing", async () => {
    app = buildAuthenticatedApp({ permissions: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects the booking policy route when entitlement is missing", async () => {
    app = buildAuthenticatedApp({ entitlements: [] });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects the booking policy route when entitlement is suspended", async () => {
    app = buildAuthenticatedApp({
      entitlements: [
        {
          product: "booking",
          key: "booking-engine",
          status: "suspended",
        },
      ],
    });

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_alpenrose/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects the booking policy route when linked-resource access is missing", async () => {
    app = buildAuthenticatedApp();

    const response = await injectJson(app, {
      method: "GET",
      url: "/api/booking/hotels/booking_hotel_other/policy-check",
      headers: {
        authorization: "Bearer valid-token",
      },
    });

    expect(response.statusCode).toBe(403);
  });
});
