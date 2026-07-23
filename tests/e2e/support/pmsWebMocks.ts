import type { Page, Route } from "@playwright/test";
import { createSharedHotelSetupStatusMock, sharedHotelSetupProduct } from "./sharedHotelSetupMocks";

export const PMS_WEB_PROPERTY_ID = "f6853000-0000-0000-0000-000000000001";
export const PMS_WEB_ROOM_TYPE_ID = "room_type_alpine_suite";
export const PMS_WEB_ROOM_ID = "room_101";
export const PMS_WEB_RESERVATION_ID = "guest_booking_ada";

const propertySummary = {
  id: PMS_WEB_PROPERTY_ID,
  name: PMS_WEB_PROPERTY_ID,
  slug: PMS_WEB_PROPERTY_ID,
  location: "",
  country: "",
};

const propertyProfile = {
  ...propertySummary,
  timezone: "Europe/Vienna",
  instant_book: true,
  instantBook: true,
  same_day_bookings_enabled: true,
  sameDayBookingsEnabled: true,
  same_day_booking_cutoff_time: "18:00",
  sameDayBookingCutoffTime: "18:00",
};

const sharedPropertyProfile = {
  propertyId: PMS_WEB_PROPERTY_ID,
  publicId: "prop_alpenrose",
  displayName: "Alpenrose Munich",
  propertyType: "hotel",
  location: {
    countryCode: "DE",
    region: "Bavaria",
    city: "Munich",
    streetAddress: "Alpenstrasse 12",
    postalCode: "80331",
    rawMarketplaceLocation: "Munich, Germany",
    timezone: "Europe/Berlin",
    latitude: 48.1372,
    longitude: 11.5756,
    addressPublic: true,
    mapDisplayMode: "exact",
  },
  website: "https://alpenrose.example",
  contactEmail: "reservations@alpenrose.example",
  phone: "+4989123456",
  shortDescription: "An alpine stay in Munich.",
  longDescription: "An alpine stay in the center of Munich.",
  media: [],
  sharedProfile: {
    status: "complete",
    source: "canonical",
    completionPercent: 100,
    missingFields: [],
  },
  updatedAt: "2026-07-22T10:00:00.000Z",
};

const roomType = {
  roomTypeId: PMS_WEB_ROOM_TYPE_ID,
  name: "Alpine Suite",
  description: "Mountain-facing suite",
  category: "suite",
  occupancyLimits: { total: 3, adults: 2, children: 1 },
  attributes: {},
  amenities: [],
  media: [],
  baseRate: { amountDecimal: "180.00", currency: "EUR" },
  active: true,
  sortOrder: 0,
  ratePlans: [],
  rateRulesSummary: {
    minStayNights: 1,
    maxStayNights: null,
    closedToArrival: false,
    closedToDeparture: false,
    activeRuleCount: 0,
  },
  roomCount: 1,
};

const room = {
  roomId: PMS_WEB_ROOM_ID,
  roomTypeId: PMS_WEB_ROOM_TYPE_ID,
  roomNumber: "101",
  floor: "1",
  status: "available",
  sortOrder: 0,
  metadata: { roomTypeName: "Alpine Suite" },
};

export const pmsWebReservation = {
  guestBookingId: PMS_WEB_RESERVATION_ID,
  bookingReference: "VAY-ADA",
  status: "confirmed",
  source: "direct_booking",
  stay: { checkIn: "2026-08-15", checkOut: "2026-08-17", adults: 2, children: 0 },
  primaryGuest: {
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+431234567",
  },
  assignments: [
    {
      assignmentId: "assignment_ada",
      roomTypeId: PMS_WEB_ROOM_TYPE_ID,
      ratePlanId: null,
      roomId: PMS_WEB_ROOM_ID,
      roomNumber: "101",
      position: 0,
      assignmentStatus: "assigned",
      channel: "direct",
      assignedAt: "2026-08-01T10:00:00.000Z",
    },
  ],
  checkin: { completedAt: null, pendingFlags: [] },
  checkout: { completedAt: null, pendingFlags: [] },
  privateNoteCount: 0,
  additionalGuestCount: 0,
};

export async function mockPmsWebAuthenticatedSession(
  page: Page,
  propertyId = PMS_WEB_PROPERTY_ID,
): Promise<void> {
  await page.addInitScript((propertyId) => {
    const oneHourFromNow = Date.now() + 60 * 60 * 1000;
    window.localStorage.setItem("access_token", "e2e-pms-token");
    window.localStorage.setItem("token_expires_at", String(oneHourFromNow));
    window.localStorage.setItem("isLoggedIn", "true");
    window.localStorage.setItem("userId", "user_pms_owner");
    window.localStorage.setItem("userName", "PMS Owner");
    window.localStorage.setItem("userEmail", "owner@example.com");
    window.localStorage.setItem("userType", "hotel");
    window.localStorage.setItem("userStatus", "active");
    window.localStorage.setItem("selectedHotelId", propertyId);
    window.localStorage.setItem("pmsSetupComplete", "true");
    window.localStorage.setItem(
      "user",
      JSON.stringify({ id: "user_pms_owner", email: "owner@example.com", type: "hotel" }),
    );
  }, propertyId);
}

export async function mockPmsWebTargetRoutes(page: Page): Promise<void> {
  await page.route("**/auth/compat/pms-web-token", (route) =>
    route.fulfill({
      json: {
        accessToken: "e2e-pms-compatibility-token",
        expiresIn: 900,
        tokenType: "Bearer",
      },
    }),
  );
  await page.route("**/auth/session?surface=pms-web", (route) =>
    route.fulfill({
      json: {
        accessToken: "e2e-pms-token",
        csrfToken: "e2e-pms-csrf-token",
        organizationId: "org_pms_owner",
        workosOrganizationId: "org_workos_pms_owner",
        user: {
          id: "user_pms_owner",
          email: "owner@example.com",
          name: "PMS Owner",
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/pms-owner.webp",
          profilePictureMediaObjectId: "media-pms-owner",
          status: "active",
          workosUserId: "workos_user_pms_owner",
        },
      },
    }),
  );
  await page.route("**/api/hotel-setup/status**", (route) =>
    route.fulfill({
      json: createSharedHotelSetupStatusMock({
        entryProduct: "pms",
        returnTo: "/dashboard",
        organizationId: "org_pms_owner",
        organizationDisplayName: "Alpenrose Hotel Group",
        propertyId: PMS_WEB_PROPERTY_ID,
        publicId: "prop_alpenrose",
        propertyDisplayName: "Alpenrose Munich",
        locationSummary: "Munich, DE",
        products: {
          booking: sharedHotelSetupProduct("booking", "not_selected"),
          pms: sharedHotelSetupProduct("pms", "active"),
          marketplace: sharedHotelSetupProduct("marketplace", "not_selected"),
        },
        nextAction: {
          action: "enter_product",
          propertyId: PMS_WEB_PROPERTY_ID,
          product: "pms",
          returnTo: "/dashboard",
          reasonCodes: ["ready"],
        },
      }),
    }),
  );
  await page.route(`**/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/profile`, (route) =>
    route.fulfill({
      json: {
        ...sharedPropertyProfile,
        ...readJson(route),
        propertyId: PMS_WEB_PROPERTY_ID,
        publicId: sharedPropertyProfile.publicId,
        sharedProfile: sharedPropertyProfile.sharedProfile,
      },
    }),
  );
  await page.route("**/admin/module-activations", (route) =>
    route.fulfill({ json: { activations: [] } }),
  );
  await page.route("**/admin/settings/property", (route) =>
    route.fulfill({
      json: {
        default_currency: "EUR",
        check_in_from: "14:00",
        check_in_until: "22:00",
        check_out_from: "07:00",
        check_out_until: "11:00",
      },
    }),
  );

  await page.route("**/api/pms/properties", (route) => route.fulfill({ json: [propertySummary] }));
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/module-activations*`, (route) =>
    route.fulfill({
      json: { hotelId: PMS_WEB_PROPERTY_ID, activeModules: [], activations: [] },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/rooms*`, (route) =>
    route.fulfill({ json: targetList([room]) }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types*`, (route) =>
    route.fulfill({ json: targetList([roomType]) }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-blocks*`, (route) =>
    route.fulfill({ json: targetList([]) }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`, (route) =>
    route.fulfill({
      json: {
        ...targetList([pmsWebReservation]),
        pagination: { total: 1, limit: 500, offset: 0 },
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/profile`, async (route) => {
    if (route.request().method() === "PATCH") {
      return route.fulfill({ json: { ...propertyProfile, ...readJson(route) } });
    }
    return route.fulfill({ json: propertyProfile });
  });
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/payment-settings`, async (route) =>
    route.fulfill({
      json: {
        paymentSettings: {
          stripeConnectAccountId: null,
          stripeConnectOnboarded: false,
          platformFeeType: "percentage",
          platformFeeValue: 0,
          platformFeeWithAffiliate: 0,
          payAtPropertyEnabled: true,
          onlineCardPayment: false,
          bankTransfer: false,
          xenditPaymentsEnabled: false,
          paymentProvider: "stripe",
          xenditChannelCode: null,
          xenditAccountNumber: null,
          xenditAccountHolderName: null,
          defaultCurrency: "EUR",
          ...readJson(route),
        },
        cancellationPolicy: {
          freeCancellationDays: 7,
          partialRefundPct: 50,
        },
      },
    }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/calendar-settings`,
    async (route) =>
      route.fulfill({
        json: {
          autoRearrangeEnabled: true,
          autoOpenEnabled: false,
          autoOpenMode: "rolling",
          autoOpenMonths: 18,
          autoOpenFixedMonth: null,
          autoOpenThrough: null,
          autoOpenWarnings: [],
          ...readJson(route),
        },
      }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channex/status`, (route) =>
    route.fulfill({
      json: {
        isConnected: false,
        channexPropertyId: null,
        roomTypesProvisioned: 0,
        ratePlansProvisioned: 0,
        lastBookingSyncAt: null,
        lastAriSyncAt: null,
        lastAriSyncError: null,
        lastAriSyncFailedAt: null,
        messagingAppInstalled: false,
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channex/channels`, (route) =>
    route.fulfill({ json: { channels: [] } }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/unread-count`, (route) =>
    route.fulfill({ json: { unreadCount: 0 } }),
  );
}

function targetList<T>(items: T[]) {
  return {
    contractVersion: "pms-operations.v1",
    propertyId: PMS_WEB_PROPERTY_ID,
    items,
    sourceFreshness: {},
  };
}

function readJson(route: Route): Record<string, unknown> {
  try {
    return route.request().postDataJSON() as Record<string, unknown>;
  } catch {
    return {};
  }
}
