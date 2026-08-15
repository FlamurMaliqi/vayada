import { expect, test } from "@playwright/test";
import {
  PMS_WEB_PROPERTY_ID,
  PMS_WEB_RESERVATION_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
  pmsWebReservation,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";

test("hydrates the selected property on direct booking navigation without a reload", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  await mockPmsWebAuthenticatedSession(page);
  await page.addInitScript(() => {
    window.localStorage.removeItem("selectedHotelId");
    window.localStorage.removeItem("selectedSharedPropertyId");
  });
  await mockPmsWebTargetRoutes(page);

  let releaseDiscovery!: () => void;
  const discoveryGate = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  let statusRequests = 0;
  await page.route("**/api/hotel-setup/status**", async (route) => {
    statusRequests += 1;
    if (statusRequests > 1) await discoveryGate;
    await route.fulfill({
      json: createAdaptiveHotelSetupStatusMock({
        entryProduct: "pms",
        organizationId: "org_pms_owner",
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: PMS_WEB_PROPERTY_ID,
        propertyDisplayName: "Alpenrose Munich",
      }),
    });
  });
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) => route.fulfill({ json: { item: pmsWebReservation } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/notes`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/additional-guests`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/booking/hotels/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/change-request`,
    (route) => route.fulfill({ json: null }),
  );

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  await expect(page.getByText("No properties", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
  releaseDiscovery();
  await expect(page.getByRole("button", { name: "Alpenrose Munich" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/bookings/${PMS_WEB_RESERVATION_ID}$`));
  await assertHealthy();
});

test("shows the exact connected-account payment breakdown to the host", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  let vayadaCommission = "5.00";
  let netPayout = "91.80";
  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) =>
      route.fulfill({
        json: {
          item: {
            ...pmsWebReservation,
            pricing: {
              totalAmount: { amountDecimal: "100.00", currency: "EUR" },
              balanceAmount: { amountDecimal: "0.00", currency: "EUR" },
            },
            payment: {
              method: "card",
              expectedMethod: "manual_card",
              status: "paid",
              breakdown: {
                grossAmount: { amountDecimal: "100.00", currency: "EUR" },
                stripeFee: { amountDecimal: "3.20", currency: "EUR" },
                vayadaCommission: { amountDecimal: vayadaCommission, currency: "EUR" },
                netPayout: { amountDecimal: netPayout, currency: "EUR" },
              },
            },
          },
        },
      }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/notes`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/additional-guests`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/booking/hotels/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/change-request`,
    (route) => route.fulfill({ json: null }),
  );

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  await expect(page.getByText("Gross amount")).toBeVisible();
  await expect(page.getByText("Stripe fee")).toBeVisible();
  await expect(page.getByText("Vayada commission")).toBeVisible();
  await expect(page.getByText("Net payout")).toBeVisible();
  await expect(page.getByText("€91.80")).toBeVisible();
  await expect(page.getByText(/Stripe processing fees may not be returned/i)).toBeVisible();

  vayadaCommission = "0.00";
  netPayout = "96.80";
  await page.reload();
  await expect(page.getByText("Gross amount")).toBeVisible();
  await expect(page.getByText("Vayada commission")).toHaveCount(0);
  await expect(page.getByText("€96.80")).toBeVisible();
  await assertHealthy();
});

test("gates legacy booking writes while keeping supported hotel actions active", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  let approvals = 0;
  let createdGuest: Record<string, unknown> | null = null;

  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);

  const changeRequest = {
    id: "change_ada",
    bookingId: PMS_WEB_RESERVATION_ID,
    status: "pending",
    oldCheckIn: "2026-08-15",
    oldCheckOut: "2026-08-17",
    oldAddonIds: [],
    oldAddonQuantities: {},
    oldAddonDates: {},
    oldTotal: 360,
    requestedCheckIn: "2026-08-16",
    requestedCheckOut: "2026-08-18",
    requestedAddonIds: [],
    requestedAddonQuantities: {},
    requestedAddonDates: {},
    requestedAddonNames: [],
    newTotal: 360,
    priceDifference: 0,
    currency: "EUR",
    declineReason: null,
    decidedAt: null,
    createdAt: "2026-08-02T10:00:00.000Z",
  };

  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) => route.fulfill({ json: { item: pmsWebReservation } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/notes`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/additional-guests`,
    (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { guest: Record<string, unknown> };
        createdGuest = body.guest;
        return route.fulfill({
          json: {
            additionalGuest: {
              guestId: "guest_grace",
              guestBookingId: PMS_WEB_RESERVATION_ID,
              displayName: "Grace Hopper",
              firstName: "Grace",
              lastName: "Hopper",
              email: null,
              phone: null,
              countryCode: null,
            },
          },
        });
      }
      return route.fulfill({ json: { items: [] } });
    },
  );
  await page.route(
    `**/api/booking/hotels/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/change-request**`,
    (route) => {
      if (route.request().url().endsWith("/accept")) {
        approvals += 1;
        return route.fulfill({ json: { ...changeRequest, status: "accepted" } });
      }
      return route.fulfill({ json: changeRequest });
    },
  );

  await page.goto(`/bookings/${PMS_WEB_RESERVATION_ID}`);

  await expect(page.getByRole("heading", { name: "Booking VAY-ADA" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /modify booking.*not available yet/i }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /edit booker.*not available yet/i }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancellation unavailable" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Check in guest" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add note" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add guest" })).toBeEnabled();
  await page.getByRole("button", { name: "Add guest" }).click();
  await expect(page.getByLabel("First name")).toBeEditable();
  await expect(page.getByLabel("Last name")).toBeEditable();
  await expect(page.getByLabel("Gender")).toHaveCount(0);
  await expect(page.getByLabel("Date of birth")).toHaveCount(0);
  await expect(page.getByLabel(/passport/i)).toHaveCount(0);
  await page.getByLabel("First name").fill("Grace");
  await page.getByLabel("Last name").fill("Hopper");
  await page.getByLabel("Nationality").fill("Netherlands");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => createdGuest).not.toBeNull();
  expect(createdGuest).toMatchObject({
    firstName: "Grace",
    lastName: "Hopper",
    countryCode: "NL",
  });
  expect(createdGuest).not.toHaveProperty("gender");
  expect(createdGuest).not.toHaveProperty("dateOfBirth");
  expect(createdGuest).not.toHaveProperty("passportNumber");

  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("button", { name: /resend confirmation email/i })).toBeDisabled();

  await expect(page.getByRole("button", { name: "Approve Change" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Decline Change" })).toBeEnabled();
  await page.getByRole("button", { name: "Approve Change" }).click();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(() => approvals).toBe(1);
  await expect(page.getByText(/last change request was approved/i)).toBeVisible();

  await assertHealthy();
});

test("keeps check-in guest CRUD active without presenting unsupported identity fields", async ({
  page,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const guestWrites: Record<string, unknown>[] = [];
  let checkIns = 0;

  await mockPmsWebAuthenticatedSession(page);
  await mockPmsWebTargetRoutes(page);
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}`,
    (route) =>
      route.fulfill({
        json: {
          item: {
            ...pmsWebReservation,
            source: "channel",
            assignments: pmsWebReservation.assignments.map((assignment) => ({
              ...assignment,
              channel: "booking_com",
            })),
          },
        },
      }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/notes`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/additional-guests**`,
    (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          json: {
            items: [
              {
                guestId: "guest_grace",
                guestBookingId: PMS_WEB_RESERVATION_ID,
                displayName: "Grace Hopper",
                firstName: "Grace",
                lastName: "Hopper",
                email: "grace@example.com",
                phone: null,
                countryCode: "US",
              },
            ],
          },
        });
      }
      const body = route.request().postDataJSON() as { guest: Record<string, unknown> };
      guestWrites.push(body.guest);
      return route.fulfill({
        json: {
          additionalGuest: {
            guestId: "guest_grace",
            guestBookingId: PMS_WEB_RESERVATION_ID,
            displayName: "Grace Hopper",
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
            phone: body.guest.phone ?? null,
            countryCode: "US",
          },
        },
      });
    },
  );
  await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/check-in-checklist`, (route) =>
    route.fulfill({
      json: { template: { steps: [], updatedAt: null, updatedByUserId: null } },
    }),
  );
  await page.route(
    `**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/reservations/${PMS_WEB_RESERVATION_ID}/check-in`,
    (route) => {
      checkIns += 1;
      return route.fulfill({ json: {} });
    },
  );

  await page.goto(`/check-in/${PMS_WEB_RESERVATION_ID}`);

  await expect(
    page.getByText(/gender, date of birth, and passport details are not stored/i),
  ).toHaveCount(2);
  await expect(page.getByLabel("Gender")).toHaveCount(0);
  await expect(page.getByLabel("Date of birth")).toHaveCount(0);
  await expect(page.getByLabel(/passport/i)).toHaveCount(0);
  await expect(page.getByLabel("First name").first()).toBeDisabled();
  await expect(page.getByLabel("First name").nth(1)).toBeDisabled();
  await expect(page.getByLabel("Nationality").nth(1)).toHaveValue("United States");
  await expect(page.getByLabel("Nationality").nth(1)).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save booker" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save guest" })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: /mark as paid.*not available yet/i }),
  ).toBeDisabled();

  await page.getByLabel("Phone").nth(1).fill("+1 555 0100");
  await page.getByRole("button", { name: "Save guest" }).click();
  await expect.poll(() => guestWrites.length).toBeGreaterThan(0);
  expect(guestWrites[0]).not.toHaveProperty("gender");
  expect(guestWrites[0]).not.toHaveProperty("dateOfBirth");
  expect(guestWrites[0]).not.toHaveProperty("passportNumber");

  await page.getByRole("button", { name: "Complete check-in" }).click();
  await expect.poll(() => checkIns).toBe(1);
  await assertHealthy();
});
