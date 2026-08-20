import type { Page, Route } from "@playwright/test";
import { createAdaptiveHotelSetupStatusMock } from "./sharedHotelSetupMocks";

export const PMS_WEB_PROPERTY_ID = "f6853000-0000-4000-8000-000000000001";
export const PMS_WEB_ROOM_TYPE_ID = "room_type_alpine_suite";
export const PMS_WEB_ROOM_ID = "room_101";
export const PMS_WEB_RESERVATION_ID = "guest_booking_ada";

export const pmsWebChannexSnapshot = {
  contractVersion: "pms-channex-management.v1",
  propertyId: PMS_WEB_PROPERTY_ID,
  connection: {
    status: "disconnected",
    externalPropertyId: null,
    messagingAppInstalled: false,
  },
  mappings: { roomTypes: [], ratePlans: [] },
  channels: [],
  markups: [],
  sync: Object.fromEntries(
    ["booking", "ari", "message", "mapping"].map((domain) => [
      domain,
      {
        status: "idle",
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        retryAfter: null,
      },
    ]),
  ),
  capabilityModes: {
    connection: "observe_only",
    provisioning: "observe_only",
    ariSync: "observe_only",
    bookingSync: "observe_only",
    markups: "observe_only",
    messaging: "observe_only",
    iframe: "observe_only",
  },
  activeOperation: null,
};

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

export const sharedPropertyProfile = {
  propertyId: PMS_WEB_PROPERTY_ID,
  profileRevision: 1,
  profile: {
    displayName: "Alpenrose Munich",
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Alpenstrasse 12",
      postalCode: "80331",
      timezone: "Europe/Berlin",
      latitude: 48.1372,
      longitude: 11.5756,
      localityPublic: true,
      geoPublic: true,
      mapDisplayMode: "exact",
    },
    contacts: [
      {
        channelType: "website",
        value: "https://alpenrose.example",
        purpose: "general",
        isPublic: true,
      },
      {
        channelType: "email",
        value: "reservations@alpenrose.example",
        purpose: "guest",
        isPublic: false,
      },
      {
        channelType: "phone",
        value: "+4989123456",
        purpose: "guest",
        isPublic: false,
      },
    ],
  },
};

export const pmsWebRoomType = {
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
    countryCode: "AT",
    countryCodeRaw: null,
    countryCodeReviewRequired: false,
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
      json: createAdaptiveHotelSetupStatusMock({
        entryProduct: "pms",
        organizationId: "org_pms_owner",
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: PMS_WEB_PROPERTY_ID,
        publicId: "prop_alpenrose",
        propertyDisplayName: "Alpenrose Munich",
        locationSummary: "Munich, DE",
        entryDecision: {
          propertyId: PMS_WEB_PROPERTY_ID,
          decision: "enter",
          destinationRouteKey: "pms.workspace",
          reasonCode: null,
        },
      }),
    }),
  );
  await page.route(`**/api/hotel-setup/properties/${PMS_WEB_PROPERTY_ID}/profile`, (route) => {
    if (route.request().method() !== "PUT") {
      return route.fulfill({ json: sharedPropertyProfile });
    }
    const request = readJson(route);
    if (request["expectedProfileRevision"] !== sharedPropertyProfile.profileRevision) {
      return route.fulfill({
        status: 409,
        json: {
          code: "profile_revision_conflict",
          currentRevision: sharedPropertyProfile.profileRevision,
        },
      });
    }
    const patch = isRecord(request["patch"]) ? request["patch"] : {};
    const locationPatch = isRecord(patch["location"]) ? patch["location"] : {};
    return route.fulfill({
      json: {
        propertyId: PMS_WEB_PROPERTY_ID,
        profileRevision: sharedPropertyProfile.profileRevision + 1,
        profile: {
          ...sharedPropertyProfile.profile,
          ...patch,
          location: {
            ...sharedPropertyProfile.profile.location,
            ...locationPatch,
          },
        },
      },
    });
  });
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
  await page.route(
    `**/api/finance/properties/${PMS_WEB_PROPERTY_ID}/financials/ota-commission-settings**`,
    async (route) => {
      if (route.request().method() === "PUT") {
        const request = readJson(route);
        const channel = new URL(route.request().url()).pathname.split("/").pop();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return route.fulfill({
          status: 201,
          json: {
            contractVersion: "finance-route-contracts.v1",
            propertyId: PMS_WEB_PROPERTY_ID,
            outcome: "created",
            setting: {
              channel,
              status: "configured",
              ruleId: `rule-${channel}`,
              percentageRate: Number(request["percentageRate"]).toFixed(4),
              effectiveFrom: request["effectiveFrom"],
              effectiveTo: null,
              revision: 1,
            },
          },
        });
      }
      return route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          settings: [
            {
              channel: "booking_com",
              status: "configured",
              ruleId: "rule-booking",
              percentageRate: "15.0000",
              effectiveFrom: "2026-08-01T10:00:00.000Z",
              effectiveTo: null,
              revision: 1,
            },
            ...["airbnb", "expedia", "agoda", "other_ota"].map((channel) => ({
              channel,
              status: "unconfigured",
              reason: "not_configured",
            })),
          ],
        },
      });
    },
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
    route.fulfill({ json: targetList([pmsWebRoomType]) }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/plan-limits`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        propertyPlan: {
          propertyId: PMS_WEB_PROPERTY_ID,
          plan: "commission",
          limits: {
            maxRoomPhotosPerType: 10,
            maxAddons: 3,
            guestContactAccess: "after_acceptance",
          },
        },
      },
    }),
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/calendar?*`, (route) => {
    const stayDate = new URL(route.request().url()).searchParams.get("from") ?? "2026-08-15";
    return route.fulfill({
      json: {
        contractVersion: "pms-operations.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        days: [
          {
            stayDate,
            roomTypeId: PMS_WEB_ROOM_TYPE_ID,
            totalCount: 1,
            assignedCount: 1,
            occupiedCount: 1,
            blockedCount: 0,
            availableCount: 0,
            assignmentRefs: ["assignment_ada"],
            status: "open",
          },
        ],
        sourceFreshness: {},
      },
    });
  });
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
  let bookingAcceptanceMode = "instant";
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/booking-acceptance`,
    async (route) => {
      if (route.request().method() === "PUT") {
        bookingAcceptanceMode = String(readJson(route)["acceptanceMode"]);
      }
      return route.fulfill({
        json: {
          propertyId: PMS_WEB_PROPERTY_ID,
          acceptanceMode: bookingAcceptanceMode,
        },
      });
    },
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
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channex`, (route) =>
    route.fulfill({ json: pmsWebChannexSnapshot }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
