import type { Page, Route } from "@playwright/test";
import { createAdaptiveHotelSetupStatusMock } from "./sharedHotelSetupMocks";

export const PMS_WEB_PROPERTY_ID = "f6853000-0000-4000-8000-000000000001";
export const PMS_WEB_ROOM_TYPE_ID = "room_type_alpine_suite";
export const PMS_WEB_ROOM_ID = "room_101";
export const PMS_WEB_RESERVATION_ID = "guest_booking_ada";
export const PMS_WEB_INBOX_THREAD_ID = "thread_ada";

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

export const pmsWebInboxThread = {
  id: PMS_WEB_INBOX_THREAD_ID,
  version: 3,
  attentionState: "needs_attention",
  followUpAt: null,
  assignedTo: null,
  channel: "ota",
  providerChannel: "booking_com",
  guest: {
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    phone: "+431234567",
  },
  conversationContext: {
    state: "linked",
    bookingId: PMS_WEB_RESERVATION_ID,
    reference: "VAY-ADA",
    stay: {
      checkIn: "2026-08-15",
      checkOut: "2026-08-17",
      nights: 2,
      adults: 2,
      children: 0,
      roomCount: 1,
      roomName: "Alpine Suite",
      roomNumber: "101",
      status: "confirmed",
    },
  },
  unreadCount: 1,
  activityAt: "2026-09-04T08:12:00.000Z",
  lastMessage: {
    preview: "Could we arrive a little early?",
    at: "2026-09-04T08:12:00.000Z",
    hasAttachments: false,
  },
  replyRoute: {
    state: "ready",
    channel: "ota",
    providerChannel: "booking_com",
    reasonCode: null,
  },
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
  await page.route("**/api/identity/staff/members", (route) =>
    route.fulfill({
      json: {
        members: [
          {
            id: "staff_membership_ada",
            name: "Ada Lovelace",
            email: "ada@example.com",
            roleKey: "front_desk",
            propertyIds: [PMS_WEB_PROPERTY_ID],
            status: "active",
            lastActiveAt: "2026-08-24T12:00:00.000Z",
          },
        ],
      },
    }),
  );
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
      json: {
        hotelId: PMS_WEB_PROPERTY_ID,
        canManage: true,
        supportedModules: ["affiliates"],
        activeModules: [],
        activations: [],
      },
    }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/linked-inventory-groups`,
    (route) => route.fulfill({ json: { propertyId: PMS_WEB_PROPERTY_ID, items: [] } }),
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
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations*`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(`/reservations/${PMS_WEB_RESERVATION_ID}`)) {
      return route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          item: pmsWebReservation,
          sourceFreshness: {},
        },
      });
    }
    return route.fulfill({
      json: {
        ...targetList([pmsWebReservation]),
        pagination: { total: 1, limit: 500, offset: 0 },
      },
    });
  });
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
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/same-day-booking`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "same-day-booking-policy.v1",
        propertyId: PMS_WEB_PROPERTY_ID,
        enabled: true,
        cutoffLocalTime: "18:00",
        propertyTimeZone: "Europe/Berlin",
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
  let autoOpenSetting = {
    contractVersion: "pms-calendar-auto-open.v1" as const,
    propertyId: PMS_WEB_PROPERTY_ID,
    revision: 3,
    enabled: false,
    mode: "rolling" as "rolling" | "fixed",
    rollingMonths: 18 as number | null,
    fixedEndMonth: null as string | null,
    updatedAt: "2026-09-03T08:00:00.000Z",
  };
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/calendar-auto-open`, (route) => {
    const isUpdate = route.request().method() === "PATCH";
    if (isUpdate) {
      const body = readJson(route);
      autoOpenSetting = {
        ...autoOpenSetting,
        revision: autoOpenSetting.revision + 1,
        enabled: Boolean(body["enabled"]),
        mode: body["mode"] === "fixed" ? "fixed" : "rolling",
        rollingMonths: typeof body["rollingMonths"] === "number" ? body["rollingMonths"] : null,
        fixedEndMonth: typeof body["fixedEndMonth"] === "string" ? body["fixedEndMonth"] : null,
        updatedAt: "2026-09-03T08:05:00.000Z",
      };
    }
    const targetOpenThrough = autoOpenSetting.enabled
      ? autoOpenSetting.mode === "rolling" && autoOpenSetting.rollingMonths === 24
        ? "2028-09-30"
        : "2028-03-31"
      : null;
    return route.fulfill({
      json: {
        contractVersion: "pms-calendar-auto-open.v1",
        setting: autoOpenSetting,
        horizon: {
          propertyTimeZone: "Europe/Berlin",
          propertyLocalDate: "2026-09-03",
          targetOpenThrough,
        },
        warnings: autoOpenSetting.enabled
          ? [
              {
                code: "missing_rate",
                roomTypeId: PMS_WEB_ROOM_TYPE_ID,
                from: "2028-09-01",
                through: "2028-09-30",
              },
            ]
          : [],
        setupError: null,
        ...(isUpdate ? { outcome: "updated", enqueueIntentId: "calendar-auto-open-intent-1" } : {}),
      },
    });
  });
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/channex`, (route) =>
    route.fulfill({ json: pmsWebChannexSnapshot }),
  );
  let inboxThread = { ...pmsWebInboxThread };
  let providerActionAccepted = false;
  let inboxTimeline: Array<Record<string, unknown>> = [
    {
      kind: "message",
      message: {
        id: "message_inbound_ada",
        direction: "inbound",
        sender: { type: "guest", name: "Ada Lovelace" },
        text: "Could we arrive a little early?",
        occurredAt: "2026-09-04T08:12:00.000Z",
        readAt: null,
        attachments: [],
        delivery: null,
      },
    },
  ];
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/unread-count`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "native-guest-inbox.v2",
        propertyId: PMS_WEB_PROPERTY_ID,
        threadCount: inboxThread.unreadCount > 0 ? 1 : 0,
        messageCount: inboxThread.unreadCount,
      },
    }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/direct-bookings`,
    (route) =>
      route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: [
            {
              guestBookingId: PMS_WEB_RESERVATION_ID,
              bookingReference: pmsWebReservation.bookingReference,
              source: "direct_booking",
              status: "confirmed",
              primaryGuest: {
                displayName: pmsWebReservation.primaryGuest.displayName,
              },
              stay: pmsWebReservation.stay,
            },
          ],
        },
      }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/quick-replies**`,
    (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/preview")) {
        return route.fulfill({
          json: {
            contractVersion: "native-guest-inbox.v2",
            propertyId: PMS_WEB_PROPERTY_ID,
            threadId: PMS_WEB_INBOX_THREAD_ID,
            quickReplyId: "quick_reply_arrival",
            renderedText: "Early check-in is subject to availability. We will let you know.",
            unresolvedVariables: [],
            composerUseAllowed: true,
          },
        });
      }
      return route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          items: [
            {
              id: "quick_reply_arrival",
              name: "Early arrival",
              text: "Early check-in is subject to availability. We will let you know.",
              approvedVariables: [],
              version: 1,
              createdAt: "2026-09-04T08:00:00.000Z",
              updatedAt: "2026-09-04T08:00:00.000Z",
            },
          ],
        },
      });
    },
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/threads**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const basePath = `/api/pms/properties/${PMS_WEB_PROPERTY_ID}/messaging/threads`;
    const suffix = url.pathname.slice(basePath.length);

    if (request.method() === "GET" && suffix === "") {
      const attentionState = url.searchParams.get("attentionState") ?? "needs_attention";
      return route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          items: inboxThread.attentionState === attentionState ? [inboxThread] : [],
          nextCursor: null,
        },
      });
    }
    if (request.method() === "POST" && suffix === "") {
      return route.fulfill({
        status: 200,
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          bookingId: PMS_WEB_RESERVATION_ID,
          created: false,
          thread: inboxThread,
        },
      });
    }
    if (request.method() === "GET" && suffix === `/${PMS_WEB_INBOX_THREAD_ID}`) {
      return route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          thread: inboxThread,
          availableProviderActions: providerActionAccepted ? [] : ["booking_com_no_reply_needed"],
          timeline: inboxTimeline,
          previousCursor: null,
        },
      });
    }
    if (request.method() === "POST" && suffix.endsWith("/read")) {
      inboxThread = { ...inboxThread, unreadCount: 0 };
      return route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          threadId: PMS_WEB_INBOX_THREAD_ID,
          readThroughMessageId: "message_inbound_ada",
          unreadCount: 0,
        },
      });
    }
    if (request.method() === "POST" && suffix.endsWith("/done")) {
      inboxThread = {
        ...inboxThread,
        attentionState: "done",
        followUpAt: null,
        version: inboxThread.version + 1,
      };
      return route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          threadId: PMS_WEB_INBOX_THREAD_ID,
          attentionState: inboxThread.attentionState,
          followUpAt: null,
          threadVersion: inboxThread.version,
        },
      });
    }
    if (request.method() === "POST" && suffix.endsWith("/reopen")) {
      inboxThread = {
        ...inboxThread,
        attentionState: "needs_attention",
        followUpAt: null,
        version: inboxThread.version + 1,
      };
      return route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          threadId: PMS_WEB_INBOX_THREAD_ID,
          attentionState: inboxThread.attentionState,
          followUpAt: null,
          threadVersion: inboxThread.version,
        },
      });
    }
    if (request.method() === "POST" && suffix.endsWith("/notes")) {
      const body = readJson(route);
      const note = {
        id: `note_${inboxTimeline.length}`,
        author: { membershipId: "staff_membership_ada", displayName: "PMS Owner" },
        text: String(body["text"] ?? ""),
        occurredAt: "2026-09-04T08:20:00.000Z",
      };
      inboxThread = { ...inboxThread, version: inboxThread.version + 1 };
      inboxTimeline = [...inboxTimeline, { kind: "internal_note", note }];
      return route.fulfill({
        status: 201,
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          threadId: PMS_WEB_INBOX_THREAD_ID,
          note,
          threadVersion: inboxThread.version,
        },
      });
    }
    if (request.method() === "POST" && suffix.endsWith("/messages")) {
      const body = readJson(route);
      inboxThread = { ...inboxThread, version: inboxThread.version + 1 };
      const messageId = `message_outbound_${inboxThread.version}`;
      const delivery = {
        state: "queued",
        channel: "ota",
        reasonCode: null,
        providerAcknowledgedAt: null,
      };
      inboxTimeline = [
        ...inboxTimeline,
        {
          kind: "message",
          message: {
            id: messageId,
            direction: "outbound",
            sender: { type: "property_user", name: "You" },
            text: String(body["text"] ?? ""),
            occurredAt: "2026-09-04T08:25:00.000Z",
            readAt: null,
            attachments: [],
            delivery,
          },
        },
      ];
      return route.fulfill({
        status: 202,
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          threadId: PMS_WEB_INBOX_THREAD_ID,
          messageId,
          threadVersion: inboxThread.version,
          delivery,
          acceptedAt: "2026-09-04T08:25:00.000Z",
          echoedText: body["text"],
        },
      });
    }
    if (request.method() === "POST" && suffix.endsWith("/assist")) {
      const body = readJson(route);
      const kind = String(body["kind"]);
      return route.fulfill({
        json: {
          contractVersion: "native-guest-inbox.v2",
          propertyId: PMS_WEB_PROPERTY_ID,
          threadId: PMS_WEB_INBOX_THREAD_ID,
          kind,
          assistedText:
            kind === "summarize"
              ? "The guest is asking about early arrival."
              : "We will gladly check early-arrival availability for you.",
          attribution: "ai_assisted",
          reviewRequired: true,
          basedThroughMessageId: "message_inbound_ada",
        },
      });
    }
    if (request.method() === "POST" && suffix.endsWith("/provider-actions/no-reply-needed")) {
      providerActionAccepted = true;
    }
    return route.fulfill({
      status: 202,
      json: {
        contractVersion: "native-guest-inbox.v2",
        propertyId: PMS_WEB_PROPERTY_ID,
        threadId: PMS_WEB_INBOX_THREAD_ID,
        acceptedAt: "2026-09-04T08:30:00.000Z",
      },
    });
  });
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
