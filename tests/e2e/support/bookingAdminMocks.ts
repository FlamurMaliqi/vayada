import type { Page } from "@playwright/test";
import { createAdaptiveHotelSetupStatusMock } from "./sharedHotelSetupMocks";

export const BOOKING_ADMIN_HOTEL_ID = "booking_hotel_alpenrose";
export const BOOKING_ADMIN_PROPERTY_ID = "f6853000-0000-4000-8000-000000000001";
export const BOOKING_ADMIN_ORGANIZATION_ID = "org_hotel_group";
export const BOOKING_ADMIN_HOTEL_SLUG = "hotel-alpenrose";
export const BOOKING_ADMIN_ROOMS_PATH = `/api/pms/properties/${BOOKING_ADMIN_HOTEL_ID}/rooms`;
export const BOOKING_ADMIN_ROOM_TYPES_PATH = `/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/room-types`;
export const BOOKING_ADMIN_ADDON_ITEMS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/addon-items`;
export const BOOKING_ADMIN_PROMO_CODES_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/promo-codes`;
export const BOOKING_ADMIN_PROPERTY_LINK_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/property-link`;
export const BOOKING_ADMIN_PROPERTY_PROFILE_PATH = `/api/hotel-setup/properties/${BOOKING_ADMIN_PROPERTY_ID}/profile`;
export const BOOKING_ADMIN_PROPERTY_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/property`;
export const BOOKING_ADMIN_PUBLIC_BOOKABILITY_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/public-bookability`;
export const BOOKING_ADMIN_ADDON_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/addons`;
export const BOOKING_ADMIN_BENEFITS_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/benefits`;
export const BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/guest-form`;
export const BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/localization`;
export const BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/last-minute`;
export const BOOKING_ADMIN_ROOM_FILTER_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/room-filters`;
export const BOOKING_ADMIN_DESIGN_SETTINGS_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/settings/design`;
export const BOOKING_ADMIN_CUSTOM_DOMAIN_PATH = `/api/booking/hotels/${BOOKING_ADMIN_HOTEL_ID}/custom-domain`;
export const BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH = `/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/payment-settings`;
export const BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH = `/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/plan-status`;

export interface BookingAdminPropertySettingsFixture {
  id: string;
  slug: string;
  property_name?: string;
  instagram?: string;
  facebook?: string;
  tiktok?: string;
  youtube?: string;
  default_currency: string;
  time_zone?: string;
  default_language: string;
  supported_currencies: string[];
  supported_languages: string[];
  pay_at_hotel_methods: string[];
  special_requests_enabled: boolean;
  arrival_time_enabled: boolean;
  guest_count_enabled: boolean;
}

export interface BookingAdminAddonSettingsFixture {
  showAddonsStep: boolean;
  groupAddonsByCategory: boolean;
}

export interface BookingAdminAddonItemsFixture {
  addonItems: Array<{
    addonItemId: string;
    hotelId: string;
    propertyId: string;
    name: string;
    description: string;
    price: string;
    currency: string;
    category: string;
    imageUrl: string | null;
    duration: string | null;
    pricingModel: string;
    publicVisible: boolean;
    status: string;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface BookingAdminPromoCodesFixture {
  promoCodes: Array<{
    promoCodeId: string;
    hotelId: string;
    propertyId: string;
    code: string;
    discountType: string;
    discountValue: string;
    minBookingValue: string | null;
    applicableRoomIds: string[] | null;
    validFrom: string | null;
    validUntil: string | null;
    stayDateFrom: string | null;
    stayDateUntil: string | null;
    isActive: boolean;
    maxUses: number;
    currentUses: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface BookingAdminBenefitsSettingsFixture {
  benefits: string[];
}

export interface BookingAdminGuestFormSettingsFixture {
  specialRequestsEnabled: boolean;
  arrivalTimeEnabled: boolean;
  guestCountEnabled: boolean;
  adultAgeThreshold: number;
  childrenEnabled: boolean;
}

export interface BookingAdminLocalizationSettingsFixture {
  defaultCurrency: string;
  defaultLanguage: string;
  supportedCurrencies: string[];
  supportedLanguages: string[];
}

export interface BookingAdminRoomFilterSettingsFixture {
  bookingFilters: string[];
  customFilters: Record<string, string>;
  filterRooms: Record<string, string[]>;
}

export interface BookingAdminDesignSettingsFixture {
  headerLogo: string;
  headerLogoMediaObjectId: string | null;
  heroImage: string;
  heroHeading: string;
  heroSubtext: string;
  primaryColor: string;
  fontPairing: string;
}

export interface BookingAdminDesignSettingsRequest {
  method: string;
  hotelId: string;
  body: Partial<BookingAdminDesignSettingsFixture> | null;
}

export interface BookingAdminLastMinuteSettingsFixture {
  enabled: boolean;
  stackWithPromo: boolean;
  tiers: Array<{
    daysBeforeMin: number;
    daysBeforeMax: number | null;
    discountPercent: number;
  }>;
  updatedAt: string;
}

export interface BookingAdminCustomDomainFixture {
  hotelId: string;
  propertyId: string;
  configured: boolean;
  domain: string | null;
  status: "not_configured" | "pending" | "verified" | "failed";
  sslStatus: "not_configured" | "pending" | "active" | "failed";
  dnsRecords: Array<{
    type: "CNAME" | "TXT";
    name: string;
    value: string;
    status: "pending" | "verified" | "failed";
  }>;
  verificationErrors: string[];
  checkedAt: string | null;
  updatedAt: string | null;
}

export interface BookingAdminShellMocksOptions {
  propertySettings?: BookingAdminPropertySettingsFixture;
  customDomain?: BookingAdminCustomDomainFixture;
}

export interface BookingAdminBookingFlowMocksOptions {
  addonItems?: BookingAdminAddonItemsFixture;
  promoCodes?: BookingAdminPromoCodesFixture;
  addonSettings?: BookingAdminAddonSettingsFixture;
  benefitsSettings?: BookingAdminBenefitsSettingsFixture;
  guestFormSettings?: BookingAdminGuestFormSettingsFixture;
  localizationSettings?: BookingAdminLocalizationSettingsFixture;
  lastMinuteSettings?: BookingAdminLastMinuteSettingsFixture;
  roomFilterSettings?: BookingAdminRoomFilterSettingsFixture;
}

export const defaultBookingAdminPropertySettings: BookingAdminPropertySettingsFixture = {
  id: BOOKING_ADMIN_HOTEL_ID,
  slug: BOOKING_ADMIN_HOTEL_SLUG,
  default_currency: "EUR",
  time_zone: "Europe/Berlin",
  default_language: "en",
  supported_currencies: [],
  supported_languages: [],
  pay_at_hotel_methods: ["cash", "card"],
  special_requests_enabled: false,
  arrival_time_enabled: false,
  guest_count_enabled: false,
};

export const defaultBookingAdminPropertyProfile = {
  propertyId: BOOKING_ADMIN_PROPERTY_ID,
  profileRevision: 1,
  profile: {
    displayName: "Alpenrose",
    propertyType: "hotel",
    location: {
      streetAddress: "Alpenstrasse 12",
      postalCode: "80331",
      city: "Munich",
      countryCode: "DE",
      timezone: "Europe/Berlin",
      latitude: 48.1372,
      longitude: 11.5756,
      localityPublic: true,
      geoPublic: true,
      mapDisplayMode: "exact",
    },
    contacts: [
      {
        channelType: "email",
        value: "reservations@alpenrose.example",
        purpose: "guest",
        isPublic: false,
      },
    ],
  },
};

const defaultAddonSettings: BookingAdminAddonSettingsFixture = {
  showAddonsStep: true,
  groupAddonsByCategory: true,
};

const defaultAddonItems: BookingAdminAddonItemsFixture = {
  addonItems: [
    {
      addonItemId: "addon_airport_transfer",
      hotelId: BOOKING_ADMIN_HOTEL_ID,
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
      createdAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    },
  ],
};

const defaultPromoCodes: BookingAdminPromoCodesFixture = {
  promoCodes: [
    {
      promoCodeId: "promo_summer20",
      hotelId: BOOKING_ADMIN_HOTEL_ID,
      propertyId: BOOKING_ADMIN_PROPERTY_ID,
      code: "SUMMER20",
      discountType: "percentage",
      discountValue: "20.00",
      minBookingValue: "500.00",
      applicableRoomIds: ["f6853000-0000-4000-8000-000000000010"],
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
  ],
};

const defaultBenefitsSettings: BookingAdminBenefitsSettingsFixture = {
  benefits: [],
};

const defaultGuestFormSettings: BookingAdminGuestFormSettingsFixture = {
  specialRequestsEnabled: true,
  arrivalTimeEnabled: false,
  guestCountEnabled: false,
  adultAgeThreshold: 18,
  childrenEnabled: true,
};

const defaultLocalizationSettings: BookingAdminLocalizationSettingsFixture = {
  defaultCurrency: "EUR",
  defaultLanguage: "en",
  supportedCurrencies: [],
  supportedLanguages: [],
};

const defaultRoomFilterSettings: BookingAdminRoomFilterSettingsFixture = {
  bookingFilters: [],
  customFilters: {},
  filterRooms: {},
};

export const defaultBookingAdminDesignSettings: BookingAdminDesignSettingsFixture = {
  headerLogo: "",
  headerLogoMediaObjectId: null,
  heroImage: "/hotel-hero.JPG",
  heroHeading: "Stay above the clouds",
  heroSubtext: "An independent alpine escape made for memorable direct stays.",
  primaryColor: "#2563EB",
  fontPairing: "modern-minimalist",
};

const defaultLastMinuteSettings: BookingAdminLastMinuteSettingsFixture = {
  enabled: false,
  stackWithPromo: false,
  tiers: [],
  updatedAt: "2026-06-22T10:00:00.000Z",
};

export const defaultCustomDomain: BookingAdminCustomDomainFixture = {
  hotelId: BOOKING_ADMIN_HOTEL_ID,
  propertyId: BOOKING_ADMIN_PROPERTY_ID,
  configured: false,
  domain: null,
  status: "not_configured",
  sslStatus: "not_configured",
  dnsRecords: [],
  verificationErrors: [],
  checkedAt: null,
  updatedAt: null,
};

export async function mockBookingAdminAuthenticatedSession(
  page: Page,
  hotelIds: string[] = [BOOKING_ADMIN_HOTEL_ID],
): Promise<void> {
  await page.addInitScript(
    ({ hotelId, token }) => {
      const oneHourFromNow = Date.now() + 60 * 60 * 1000;
      window.localStorage.setItem("access_token", token);
      window.localStorage.setItem("token_expires_at", String(oneHourFromNow));
      window.localStorage.setItem("isLoggedIn", "true");
      window.localStorage.setItem("userName", "Booking Owner");
      window.localStorage.setItem("userEmail", "owner@example.com");
      window.localStorage.setItem("userType", "hotel");
      window.localStorage.setItem("isSuperAdmin", "false");
      window.localStorage.setItem("selectedHotelId", hotelId);
      window.localStorage.setItem(
        "user",
        JSON.stringify({
          id: "user_1",
          email: "owner@example.com",
          name: "Booking Owner",
          type: "hotel",
        }),
      );
    },
    {
      hotelId: hotelIds[0] ?? BOOKING_ADMIN_HOTEL_ID,
      token: fakeBookingAdminJwt(hotelIds),
    },
  );
}

export async function mockBookingAdminShellRoutes(
  page: Page,
  options: BookingAdminShellMocksOptions = {},
): Promise<void> {
  const propertySettings = options.propertySettings ?? defaultBookingAdminPropertySettings;
  await page.route("**/api/pms/properties/*/module-activations", (route) =>
    route.fulfill({
      json: {
        hotelId: BOOKING_ADMIN_PROPERTY_ID,
        canManage: true,
        supportedModules: ["affiliates"],
        activeModules: [],
        activations: [],
      },
    }),
  );
  await page.route("**/admin/hotels", (route) =>
    route.fulfill({
      json: [
        {
          id: BOOKING_ADMIN_HOTEL_ID,
          name: "Alpenrose",
          slug: BOOKING_ADMIN_HOTEL_SLUG,
        },
      ],
    }),
  );
  await page.route("**/admin/superadmin/hotels", (route) => route.fulfill({ json: [] }));
  await page.route(`**${BOOKING_ADMIN_PROPERTY_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: propertySettings }),
  );
  await page.route("**/api/booking/hotels/*/settings/design", (route) =>
    route.fulfill({ json: defaultBookingAdminDesignSettings }),
  );
  await page.route("**/api/hotel-setup/status**", (route) =>
    route.fulfill({
      json: createAdaptiveHotelSetupStatusMock({
        entryProduct: "booking",
        organizationId: "org_hotel_group",
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        publicId: "prop_alpenrose",
        propertyDisplayName: "Alpenrose",
        locationSummary: "Munich, DE",
        entryDecision: {
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          decision: "enter",
          destinationRouteKey: "booking.workspace",
          reasonCode: null,
        },
      }),
    }),
  );
  await page.route(`**${BOOKING_ADMIN_PROPERTY_LINK_PATH}*`, (route) =>
    route.fulfill({
      json: {
        hotelId: BOOKING_ADMIN_HOTEL_ID,
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        resourceLinks: {
          bookingHotel: true,
          pmsProperty: true,
          financeProperty: true,
        },
      },
    }),
  );
  await page.route(`**${BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH}*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "finance-subscriptions.v1",
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        planStatus: {
          plan: "commission",
          status: "commission",
          currency: "EUR",
          activeRoomCount: 3,
          amountMinor: 4_000,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          nextBillingDate: null,
          cancelAtPeriodEnd: false,
          checkoutPending: false,
          customerPortalAvailable: false,
          activatedAt: null,
          updatedAt: "2026-08-11T12:00:00.000Z",
        },
      },
    }),
  );
  await page.route(`**${BOOKING_ADMIN_PROPERTY_PROFILE_PATH}*`, (route) =>
    route.fulfill({ json: defaultBookingAdminPropertyProfile }),
  );
  await page.route(`**${BOOKING_ADMIN_PUBLIC_BOOKABILITY_PATH}*`, (route) =>
    route.fulfill({
      json: {
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        canonicalSlug: BOOKING_ADMIN_HOTEL_SLUG,
        canonicalUrl: `https://${BOOKING_ADMIN_HOTEL_SLUG}.booking.localhost/en`,
        bookingBaseUrl: `https://${BOOKING_ADMIN_HOTEL_SLUG}.booking.localhost`,
        profileStatus: "public",
        freshnessStatus: "fresh",
        missingReadiness: [],
      },
    }),
  );
  await page.route(`**${BOOKING_ADMIN_ROOMS_PATH}*`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: BOOKING_ADMIN_HOTEL_ID,
        items: [],
        sourceFreshness: {},
      },
    }),
  );
  await page.route(`**${BOOKING_ADMIN_CUSTOM_DOMAIN_PATH}*`, (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 204 })
      : route.fulfill({ json: options.customDomain ?? defaultCustomDomain }),
  );
  await page.route("**/api/booking/properties/*/dashboard/stats**", (route) =>
    route.fulfill({
      json: {
        metrics: {
          current: {
            totalRevenue: { amountDecimal: "0.00", currency: "EUR" },
            bookingCount: 0,
            avgNightlyRate: { amountDecimal: "0.00", currency: "EUR" },
            pageViewCount: 0,
          },
          previous: {
            totalRevenue: { amountDecimal: "0.00", currency: "EUR" },
            bookingCount: 0,
            avgNightlyRate: { amountDecimal: "0.00", currency: "EUR" },
            pageViewCount: 0,
          },
          nextArrivalDate: null,
          liveSinceDate: null,
        },
      },
    }),
  );
  await page.route("**/api/booking/properties/*/dashboard/bookings-by-source**", (route) =>
    route.fulfill({
      json: {
        sourceMix: {
          totalRevenue: { amountDecimal: "0.00", currency: "EUR" },
          items: [],
        },
      },
    }),
  );
  await page.route("**/api/booking/properties/*/dashboard/sparklines**", (route) =>
    route.fulfill({ json: { sparklines: { points: [] } } }),
  );
  await page.route("**/api/booking/properties/*/dashboard/page-views**", (route) =>
    route.fulfill({
      json: {
        pageViews: {
          timeZone: "Europe/Berlin",
          windowStart: "2026-08-07",
          windowEnd: "2026-08-13",
          previousWindowStart: "2026-07-31",
          previousWindowEnd: "2026-08-06",
          buckets: Array.from({ length: 7 }, (_, index) => ({
            date: `2026-08-${String(index + 7).padStart(2, "0")}`,
            count: 0,
          })),
          previousBuckets: [],
          total: 0,
          previousTotal: 0,
        },
      },
    }),
  );
}

export async function mockBookingAdminDesignSettings(
  page: Page,
  initial: BookingAdminDesignSettingsFixture = defaultBookingAdminDesignSettings,
): Promise<{ requests: BookingAdminDesignSettingsRequest[] }> {
  const settings = { ...initial };
  const requests: BookingAdminDesignSettingsRequest[] = [];

  await page.route("**/api/booking/hotels/*/settings/design", (route) => {
    const request = route.request();
    const hotelId = decodeURIComponent(
      new URL(request.url()).pathname.match(/\/hotels\/([^/]+)\/settings\/design$/)?.[1] ?? "",
    );
    const body =
      request.method() === "PATCH"
        ? (request.postDataJSON() as Partial<BookingAdminDesignSettingsFixture>)
        : null;
    requests.push({ method: request.method(), hotelId, body });

    if (body) Object.assign(settings, body);
    return route.fulfill({ json: settings });
  });

  return { requests };
}

function fakeBookingAdminJwt(hotelIds: string[] = [BOOKING_ADMIN_HOTEL_ID]): string {
  return `header.${Buffer.from(
    JSON.stringify({
      org: BOOKING_ADMIN_ORGANIZATION_ID,
      resources: { "booking:booking_hotel": hotelIds },
    }),
  ).toString("base64url")}.signature`;
}

export async function mockBookingAdminBookingFlow(
  page: Page,
  options: BookingAdminBookingFlowMocksOptions = {},
): Promise<void> {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  await page.route(`**${BOOKING_ADMIN_ADDON_ITEMS_PATH}**`, (route) =>
    route.fulfill({ json: options.addonItems ?? defaultAddonItems }),
  );
  await page.route(`**${BOOKING_ADMIN_PROMO_CODES_PATH}**`, (route) =>
    route.fulfill({ json: options.promoCodes ?? defaultPromoCodes }),
  );
  await page.route(`**${BOOKING_ADMIN_ROOM_TYPES_PATH}**`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        items: [
          {
            roomTypeId: "f6853000-0000-4000-8000-000000000010",
            name: "Sea View Suite",
          },
          {
            roomTypeId: "f6853000-0000-4000-8000-000000000011",
            name: "Pool Villa",
          },
        ],
      },
    }),
  );
  await page.route(`**${BOOKING_ADMIN_ADDON_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.addonSettings ?? defaultAddonSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_BENEFITS_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.benefitsSettings ?? defaultBenefitsSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_GUEST_FORM_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.guestFormSettings ?? defaultGuestFormSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.localizationSettings ?? defaultLocalizationSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.lastMinuteSettings ?? defaultLastMinuteSettings }),
  );
  await page.route(`**${BOOKING_ADMIN_ROOM_FILTER_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ json: options.roomFilterSettings ?? defaultRoomFilterSettings }),
  );
}
