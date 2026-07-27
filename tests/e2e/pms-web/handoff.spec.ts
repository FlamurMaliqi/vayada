import { expect, test, type Page, type Route } from "@playwright/test";

import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";

const HANDOFF_CODE = "A".repeat(43);
const LOGIN_RESUME_CODE = "B".repeat(43);
const USED_CODE = "C".repeat(43);
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKOS_ORGANIZATION_ID = "org_workos_target_hotel_group";

test.describe("pms-web opaque setup handoff", () => {
  test("exchanges the code and opens the exact rooms task without property context in the URL", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    await mockPmsStatus(page);
    const exchangeRequests = await mockHandoffExchange(page);
    await interceptRoomsDestination(page);

    await page.goto(`/handoff?code=${HANDOFF_CODE}`);

    await expect.poll(() => new URL(page.url()).pathname).toBe("/rooms/new");
    const destination = new URL(page.url());
    expect(destination.searchParams.get("taskId")).toBe("rooms_rates_availability");
    expect(destination.searchParams.get("destinationRouteKey")).toBe(
      "pms.rooms_rates_availability",
    );
    expect(destination.searchParams.get("planRevision")).toBe("e2e-plan-1");
    expect(destination.searchParams.get("returnUrl")).toBe(
      marketplaceSetupReturnUrl(PMS_WEB_PROPERTY_ID),
    );
    expect(destination.searchParams.has("propertyId")).toBe(false);
    expect(destination.hash).toBe("");
    expect(exchangeRequests).toEqual([{ code: HANDOFF_CODE }]);
    expect(
      await page.evaluate(() => ({
        selectedHotelId: localStorage.getItem("selectedHotelId"),
        selectedSharedPropertyId: localStorage.getItem("selectedSharedPropertyId"),
      })),
    ).toEqual({
      selectedHotelId: PMS_WEB_PROPERTY_ID,
      selectedSharedPropertyId: PMS_WEB_PROPERTY_ID,
    });
  });

  test("preserves only the opaque code when authentication is required", async ({ page }) => {
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        status: 401,
        headers: corsHeaders(route),
        json: { error: "session_expired" },
      });
    });

    await page.goto(`/handoff?code=${LOGIN_RESUME_CODE}`);

    await expect(page).toHaveURL(/\/login\?auth=callback/);
    const loginUrl = new URL(page.url());
    expect(loginUrl.searchParams.get("returnTo")).toBe(`/handoff?code=${LOGIN_RESUME_CODE}`);
    expect(loginUrl.searchParams.get("returnTo")).not.toContain("#");
    expect(loginUrl.searchParams.get("returnTo")).not.toContain("property");
  });

  test("keeps the exact opaque return path through hotel-group selection without retaining the consumed handoff", async ({
    page,
  }) => {
    let selected = false;
    const refreshRequests: unknown[] = [];
    await page.route(/\/history-start$/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Start</title>" }),
    );
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
      refreshRequests.push(route.request().postDataJSON());
      return route.fulfill({ headers: corsHeaders(route), json: authenticatedSession() });
    });
    await mockPmsStatus(page);
    const exchangeRequests = await mockHandoffExchange(page);
    await interceptRoomsDestination(page);

    await page.goto("/history-start");
    await page.goto(`/handoff?code=${HANDOFF_CODE}`);

    await expect(page).toHaveURL(/\/login\?auth=callback/);
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(`/handoff?code=${HANDOFF_CODE}`);
    await page.getByRole("button", { name: "Target Hotel Group" }).click();

    await expect.poll(() => new URL(page.url()).pathname).toBe("/rooms/new");
    expect(refreshRequests).toEqual([
      { organizationId: WORKOS_ORGANIZATION_ID, surface: "pms-web" },
    ]);

    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/history-start");
    expect(exchangeRequests).toEqual([{ code: HANDOFF_CODE }]);
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

    await page.goto(`/handoff?code=${USED_CODE}&extra=untrusted#untrusted=value`);

    await expect(page.getByRole("heading", { name: "Setup link unavailable" })).toBeVisible();
    await expect(
      page.getByText("This setup link is invalid, expired, or has already been used."),
    ).toBeVisible();
    expect(authRequests).toBe(0);
    expect(exchangeRequests).toBe(0);
  });

  test("returns to the exact setup property after a post-exchange property lookup failure", async ({
    page,
  }) => {
    await mockAuthenticatedSession(page);
    const exchangeRequests = await mockHandoffExchange(page);
    await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        status: 503,
        headers: corsHeaders(route),
        json: { code: "setup_status_unavailable" },
      });
    });
    await page.route(/\/handoff-history-start$/, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Before handoff</title>",
      }),
    );
    await page.route(marketplaceSetupReturnUrl(PMS_WEB_PROPERTY_ID), (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Setup wizard</title>",
      }),
    );

    await page.goto("/handoff-history-start");
    await page.goto(`/handoff?code=${HANDOFF_CODE}`);

    await expect(page.getByRole("heading", { name: "Setup link unavailable" })).toBeVisible();
    await page.getByRole("button", { name: "Return to setup" }).click();
    await expect.poll(() => page.url()).toBe(marketplaceSetupReturnUrl(PMS_WEB_PROPERTY_ID));

    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/handoff-history-start");
    expect(exchangeRequests).toEqual([{ code: HANDOFF_CODE }]);
  });

  test("rejects untrusted context on the exchanged PMS task route", async ({ page }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    const params = pmsTaskParams("https://attacker.example/setup");

    await page.goto(`/rooms/new?${params.toString()}`);

    await expect(page.getByRole("heading", { name: "Setup task unavailable" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Return to setup plan" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your first room type" })).toHaveCount(0);
  });

  test("keeps ordinary room creation outside the setup flow", async ({ page }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);

    await page.goto("/rooms/new");

    await expect(page.getByRole("heading", { name: "New Room Type" })).toBeVisible();
    await expect(page.getByText("Hotel setup", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create Room Type" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/rooms");
  });

  test("returns to the canonical setup wizard after the room task is saved", async ({ page }) => {
    await mockPmsWebAuthenticatedSession(page);
    await page.addInitScript((propertyId) => {
      localStorage.setItem("selectedSharedPropertyId", propertyId);
    }, PMS_WEB_PROPERTY_ID);
    await mockPmsWebTargetRoutes(page);
    const returnUrl = marketplaceSetupReturnUrl(PMS_WEB_PROPERTY_ID);
    const createRequests: unknown[] = [];
    await page.route(`**/api/pms/properties/${PMS_WEB_PROPERTY_ID}/room-types`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      createRequests.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          contractVersion: "pms-operations.v1",
          propertyId: PMS_WEB_PROPERTY_ID,
          item: {
            roomTypeId: "room_type_setup",
            name: "Alpine Double",
            description: "",
            category: null,
            occupancyLimits: { total: 2, adults: null, children: null },
            attributes: {},
            amenities: [],
            media: [],
            baseRate: { amountDecimal: "120.00", currency: "EUR" },
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
            roomCount: 2,
          },
          commandMeta: {
            contractVersion: "pms-operations.v1",
            commandId: "room-type-setup",
            idempotencyKey: "room-type-setup",
            acceptedAt: "2026-07-27T10:00:00.000Z",
            sideEffects: ["calendar_refresh"],
          },
        },
      });
    });
    await page.route(returnUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Canonical setup wizard</title>",
      }),
    );

    await page.goto(`/rooms/new?${pmsTaskParams(returnUrl).toString()}`);

    await expect(page.getByRole("heading", { name: "Your first room type" })).toBeVisible();
    await expect(page.getByText("Hotel setup", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Exit setup" })).toBeVisible();
    await page.getByPlaceholder("e.g. Two-Bedroom Villa").fill("Alpine Double");
    await page.getByRole("button", { name: "Pricing & Rates" }).click();
    await page.getByRole("button", { name: "Add season" }).click();

    const seasonCard = page.getByPlaceholder("Season name").locator("xpath=../..");
    await seasonCard.getByPlaceholder("Season name").fill("All year");
    const seasonSelects = seasonCard.locator("select");
    await seasonSelects.nth(1).selectOption("1");
    await seasonSelects.nth(2).selectOption("1");
    await seasonSelects.nth(3).selectOption("31");
    await seasonSelects.nth(4).selectOption("12");
    await page.locator('input[placeholder="0"][required]').fill("120");

    const finishButton = page.getByRole("button", { name: "Save and return to setup" });
    await expect(finishButton).toBeEnabled();
    await finishButton.click();

    await expect.poll(() => page.url()).toBe(returnUrl);
    expect(createRequests).toHaveLength(1);
  });
});

async function mockAuthenticatedSession(page: Page) {
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    return route.fulfill({ headers: corsHeaders(route), json: authenticatedSession() });
  });
}

async function mockPmsStatus(page: Page) {
  await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    return route.fulfill({
      headers: corsHeaders(route),
      json: createAdaptiveHotelSetupStatusMock({
        entryProduct: "pms",
        organizationId: ORGANIZATION_ID,
        organizationDisplayName: "Target Hotel Group",
        selectedTracks: ["hotel_operations"],
        propertyId: PMS_WEB_PROPERTY_ID,
        publicId: "public-alpenrose",
        propertyDisplayName: "Alpenrose Munich",
        locationSummary: "Munich, DE",
        taskOverrides: {
          rooms_rates_availability: {
            ownerProgress: "not_started",
            readiness: "actionable",
            actionableBy: "owner",
            reasonCodes: ["rooms_rates_availability_required"],
          },
        },
        recommendedTaskId: "rooms_rates_availability",
        entryDecision: {
          propertyId: PMS_WEB_PROPERTY_ID,
          decision: "enter",
          destinationRouteKey: "pms.workspace",
          reasonCode: null,
        },
      }),
    });
  });
}

async function mockHandoffExchange(page: Page) {
  const requests: unknown[] = [];
  await page.route(/\/api\/hotel-setup\/handoffs\/exchange$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      headers: corsHeaders(route),
      json: {
        propertyId: PMS_WEB_PROPERTY_ID,
        taskId: "rooms_rates_availability",
        issuedPlanRevision: "e2e-plan-1",
        destinationRouteKey: "pms.rooms_rates_availability",
        returnUrl: marketplaceSetupReturnUrl(PMS_WEB_PROPERTY_ID),
      },
    });
  });
  return requests;
}

async function interceptRoomsDestination(page: Page) {
  await page.route(/\/rooms\/new\?/, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Rooms</title>" }),
  );
}

function marketplaceSetupReturnUrl(propertyId: string): string {
  const origin =
    process.env.E2E_MARKETPLACE_BASE_URL ||
    (process.env.E2E_START_SERVERS === "1"
      ? "http://marketplace.localhost:3000"
      : "https://marketplace.localhost");
  const url = new URL("/setup", origin);
  url.searchParams.set("propertyId", propertyId);
  return url.toString();
}

function pmsTaskParams(returnUrl: string): URLSearchParams {
  return new URLSearchParams({
    onboarding: "pms-activation",
    taskId: "rooms_rates_availability",
    destinationRouteKey: "pms.rooms_rates_availability",
    planRevision: "e2e-plan-1",
    returnUrl,
  });
}

function organizationSelectionResponse() {
  return {
    organizationSelectionRequired: true,
    csrfToken: "e2e-pms-csrf-token",
    organizations: [
      {
        organizationId: "22222222-2222-4222-8222-222222222222",
        workosOrganizationId: "org_workos_other_hotel_group",
        displayName: "Other Hotel Group",
        kind: "hotel_group",
      },
      {
        organizationId: ORGANIZATION_ID,
        workosOrganizationId: WORKOS_ORGANIZATION_ID,
        displayName: "Target Hotel Group",
        kind: "hotel_group",
      },
    ],
    user: sessionUser(),
  };
}

function authenticatedSession() {
  return {
    accessToken: "e2e-pms-token",
    csrfToken: "e2e-pms-csrf-token",
    organizationId: ORGANIZATION_ID,
    workosOrganizationId: WORKOS_ORGANIZATION_ID,
    resources: { "pms:pms_property": [PMS_WEB_PROPERTY_ID] },
    user: sessionUser(),
  };
}

function sessionUser() {
  return {
    id: "user_pms_owner",
    email: "owner@example.com",
    name: "PMS Owner",
    phone: "+49 89 123456",
    profilePictureUrl: "https://media.example/pms-owner.webp",
    profilePictureMediaObjectId: "media-pms-owner",
    status: "active",
    workosUserId: "workos_user_pms_owner",
  };
}

function corsHeaders(route: Route) {
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type, x-vayada-csrf",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": route.request().headers().origin ?? "http://127.0.0.1:3004",
    "content-type": "application/json",
  };
}

async function fulfillCorsPreflight(route: Route) {
  await route.fulfill({ status: 204, headers: corsHeaders(route) });
}
