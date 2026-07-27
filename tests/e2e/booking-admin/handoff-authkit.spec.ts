import { expect, test, type Page, type Route } from "@playwright/test";

import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_ORGANIZATION_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const HANDOFF_CODE = "G".repeat(43);
const LOGIN_RESUME_CODE = "H".repeat(43);
const INVALID_CONTEXT_CODE = "I".repeat(43);
const WORKOS_ORGANIZATION_ID = "org_workos_hotel_group";

test.describe("booking-admin opaque AuthKit handoff", () => {
  test("preserves only the opaque code when credential sign-in is required", async ({ page }) => {
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        status: 401,
        headers: corsHeaders(route),
        json: { error: "missing_session" },
      });
    });

    await page.goto(`/handoff?code=${LOGIN_RESUME_CODE}`);

    await expect(page).toHaveURL(/\/login\?auth=callback/);
    const loginUrl = new URL(page.url());
    expect(loginUrl.searchParams.get("returnTo")).toBe(`/handoff?code=${LOGIN_RESUME_CODE}`);
    expect(loginUrl.searchParams.get("returnTo")).not.toContain("#");
    expect(loginUrl.searchParams.get("returnTo")).not.toContain("property");
    await expect(page.getByLabel("Email address")).toBeVisible();
  });

  test("keeps the exact opaque return path through explicit hotel-group selection", async ({
    page,
  }) => {
    await mockBookingAdminShellRoutes(page);
    let selected = false;
    const refreshRequests: unknown[] = [];
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        headers: corsHeaders(route),
        json: selected ? authenticatedSession() : organizationSelectionResponse(),
      });
    });
    await page.route(/\/auth\/session\/refresh$/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      selected = true;
      const request = route.request().postDataJSON();
      if (request && typeof request === "object" && "organizationId" in request) {
        refreshRequests.push(request);
      }
      return route.fulfill({ headers: corsHeaders(route), json: authenticatedSession() });
    });
    const exchangeRequests: unknown[] = [];
    await page.route(/\/api\/hotel-setup\/handoffs\/exchange$/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      exchangeRequests.push(route.request().postDataJSON());
      return route.fulfill({
        headers: corsHeaders(route),
        json: {
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          taskId: "guest_settings_policies",
          issuedPlanRevision: "e2e-plan-1",
          destinationRouteKey: "booking.guest_settings_policies",
          returnUrl: marketplaceSetupReturnUrl(),
        },
      });
    });
    await page.route(/\/settings\?/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Settings</title>" }),
    );

    await page.goto(`/handoff?code=${HANDOFF_CODE}`);

    await expect(page).toHaveURL(/\/login\?auth=callback/);
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(`/handoff?code=${HANDOFF_CODE}`);
    await page.getByRole("button", { name: "Alpenrose Hotel Group" }).click();

    await expect.poll(() => new URL(page.url()).pathname).toBe("/settings");
    expect(refreshRequests).toEqual([
      { organizationId: WORKOS_ORGANIZATION_ID, surface: "booking-admin" },
    ]);
    expect(exchangeRequests).toEqual([{ code: HANDOFF_CODE }]);
    expect(
      await page.evaluate(() => ({
        propertyId: localStorage.getItem("selectedSharedPropertyId"),
        hotelId: localStorage.getItem("selectedHotelId"),
      })),
    ).toEqual({
      propertyId: BOOKING_ADMIN_PROPERTY_ID,
      hotelId: BOOKING_ADMIN_HOTEL_ID,
    });
  });

  test("rejects extra query or fragment context before authentication or exchange", async ({
    page,
  }) => {
    let authRequests = 0;
    let exchangeRequests = 0;
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      authRequests += 1;
      return route.fulfill({ headers: corsHeaders(route), json: authenticatedSession() });
    });
    await page.route(/\/api\/hotel-setup\/handoffs\/exchange$/, async (route) => {
      exchangeRequests += 1;
      return route.fulfill({
        status: 409,
        headers: corsHeaders(route),
        json: { code: "invalid_handoff" },
      });
    });

    await page.goto(`/handoff?code=${INVALID_CONTEXT_CODE}&extra=untrusted#untrusted=value`);

    await expect(page.getByRole("heading", { name: "Setup link unavailable" })).toBeVisible();
    await expect(
      page.getByText("This setup link is invalid, expired, or has already been used."),
    ).toBeVisible();
    expect(authRequests).toBe(0);
    expect(exchangeRequests).toBe(0);
  });
});

function organizationSelectionResponse() {
  return {
    organizationSelectionRequired: true,
    csrfToken: "e2e-booking-csrf-token",
    organizations: [
      {
        organizationId: "22222222-2222-4222-8222-222222222222",
        workosOrganizationId: "org_workos_other_hotel_group",
        displayName: "Other Hotel Group",
        kind: "hotel_group",
      },
      {
        organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
        workosOrganizationId: WORKOS_ORGANIZATION_ID,
        displayName: "Alpenrose Hotel Group",
        kind: "hotel_group",
      },
    ],
    user: sessionUser(),
  };
}

function authenticatedSession() {
  return {
    accessToken: fakeBookingAdminJwt(),
    csrfToken: "e2e-booking-csrf-token",
    organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
    workosOrganizationId: WORKOS_ORGANIZATION_ID,
    resources: { "booking:booking_hotel": [BOOKING_ADMIN_HOTEL_ID] },
    user: sessionUser(),
  };
}

function sessionUser() {
  return {
    id: "user_booking_owner",
    email: "owner@example.com",
    name: "Booking Owner",
    phone: "+49 89 123456",
    profilePictureUrl: "https://media.example/booking-owner.webp",
    profilePictureMediaObjectId: "media-booking-owner",
    status: "active",
    workosUserId: "workos_user_booking_owner",
  };
}

function fakeBookingAdminJwt(): string {
  return `header.${Buffer.from(
    JSON.stringify({
      org: BOOKING_ADMIN_ORGANIZATION_ID,
      resources: { "booking:booking_hotel": [BOOKING_ADMIN_HOTEL_ID] },
    }),
  ).toString("base64url")}.signature`;
}

function marketplaceSetupReturnUrl(): string {
  const origin =
    process.env.E2E_MARKETPLACE_BASE_URL ||
    (process.env.E2E_START_SERVERS === "1"
      ? "http://marketplace.localhost:3000"
      : "https://marketplace.localhost");
  const url = new URL("/setup", origin);
  url.searchParams.set("propertyId", BOOKING_ADMIN_PROPERTY_ID);
  return url.toString();
}

function corsHeaders(route: Route) {
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type, x-vayada-csrf",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": route.request().headers().origin ?? "http://127.0.0.1:3003",
    "content-type": "application/json",
  };
}

async function fulfillCorsPreflight(route: Route) {
  await route.fulfill({ status: 204, headers: corsHeaders(route) });
}
