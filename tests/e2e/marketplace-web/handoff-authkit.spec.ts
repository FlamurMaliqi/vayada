import { expect, test, type Page } from "@playwright/test";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const PROPERTY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKOS_ORGANIZATION_ID = "org_workos_hotel_group";
const HANDOFF_CODE = "D".repeat(43);
const LOGIN_RESUME_CODE = "E".repeat(43);
const USED_CODE = "F".repeat(43);
const SHARED_IDENTITY_CODE = "J".repeat(43);

test.describe("marketplace-web opaque setup handoff", () => {
  test("selects the only hotel group, exchanges the code, and opens the exact task", async ({
    page,
  }) => {
    const refreshRequests: unknown[] = [];
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        headers: corsHeaders(route),
        json: organizationSelectionResponse(),
      });
    });
    await page.route(/\/auth\/session\/refresh$/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      refreshRequests.push(route.request().postDataJSON());
      return route.fulfill({ headers: corsHeaders(route), json: authenticatedSession() });
    });
    await mockMarketplaceStatus(page);

    const exchangeRequests: unknown[] = [];
    await page.route(/\/api\/hotel-setup\/handoffs\/exchange$/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      exchangeRequests.push(route.request().postDataJSON());
      return route.fulfill({
        headers: corsHeaders(route),
        json: exchangedHandoff(),
      });
    });
    await page.route(/\/profile\/complete\?activation=marketplace/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Activation</title>" }),
    );

    await page.goto(`/handoff?code=${HANDOFF_CODE}`);

    await expect(page).toHaveURL(/\/profile\/complete\?activation=marketplace/);
    const destination = new URL(page.url());
    expect(destination.searchParams.get("taskId")).toBe("creator_profile");
    expect(destination.searchParams.get("destinationRouteKey")).toBe("marketplace.creator_profile");
    expect(destination.searchParams.get("planRevision")).toBe("e2e-plan-1");
    expect(destination.searchParams.get("returnUrl")).toBe(marketplaceSetupReturnUrl());
    expect(destination.searchParams.has("propertyId")).toBe(false);
    expect(destination.hash).toBe("");
    expect(exchangeRequests).toEqual([{ code: HANDOFF_CODE }]);
    expect(refreshRequests).toEqual([
      { organizationId: WORKOS_ORGANIZATION_ID, surface: "marketplace-web" },
    ]);
    expect(await page.evaluate(() => localStorage.getItem("selectedSharedPropertyId"))).toBe(
      PROPERTY_ID,
    );
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

  test("routes the shared identity task back to the canonical setup hub", async ({ page }) => {
    await mockDirectAuthSession(page);
    await mockMarketplaceStatus(page);
    const exchangeRequests: unknown[] = [];
    await page.route(/\/api\/hotel-setup\/handoffs\/exchange$/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      exchangeRequests.push(route.request().postDataJSON());
      return route.fulfill({
        headers: corsHeaders(route),
        json: {
          ...exchangedHandoff(),
          taskId: "shared_identity",
          destinationRouteKey: "hotel_catalog.shared_identity",
        },
      });
    });
    await page.route(/\/setup\?propertyId=/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Setup</title>" }),
    );

    await page.goto(`/handoff?code=${SHARED_IDENTITY_CODE}`);

    await expect(page).toHaveURL(marketplaceSetupReturnUrl());
    expect(exchangeRequests).toEqual([{ code: SHARED_IDENTITY_CODE }]);
    const destination = new URL(page.url());
    expect([...destination.searchParams.keys()]).toEqual(["propertyId"]);
    expect(destination.hash).toBe("");
  });

  test("shows a terminal error for an invalid, expired, or reused code", async ({ page }) => {
    await mockDirectAuthSession(page);
    await page.route(/\/api\/hotel-setup\/handoffs\/exchange$/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        status: 410,
        headers: corsHeaders(route),
        json: { code: "invalid_handoff" },
      });
    });

    await page.goto(`/handoff?code=${USED_CODE}`);

    await expect(page.getByRole("heading", { name: "Setup link unavailable" })).toBeVisible();
    await expect(
      page.getByText("This setup link is invalid, expired, or has already been used."),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.toString()).toBe(`code=${USED_CODE}`);
  });

  test("rejects query and fragment context that is not the opaque code", async ({ page }) => {
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
    expect(authRequests).toBe(0);
    expect(exchangeRequests).toBe(0);
  });
});

async function mockMarketplaceStatus(page: Page) {
  await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    return route.fulfill({
      headers: corsHeaders(route),
      json: marketplaceStatus(),
    });
  });
}

async function mockDirectAuthSession(page: Page) {
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    return route.fulfill({ headers: corsHeaders(route), json: authenticatedSession() });
  });
}

function organizationSelectionResponse() {
  return {
    organizationSelectionRequired: true,
    csrfToken: "e2e-marketplace-csrf-token",
    organizations: [
      {
        organizationId: ORGANIZATION_ID,
        workosOrganizationId: WORKOS_ORGANIZATION_ID,
        displayName: "Alpenrose Hotel Group",
        kind: "hotel_group",
      },
    ],
    user: sessionUser(),
  };
}

function marketplaceStatus() {
  return createAdaptiveHotelSetupStatusMock({
    entryProduct: "marketplace",
    organizationId: ORGANIZATION_ID,
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks: ["creator_marketplace"],
    propertyId: PROPERTY_ID,
    publicId: `public-${PROPERTY_ID}`,
    propertyDisplayName: "Alpenrose",
    locationSummary: "Munich, DE",
    taskOverrides: {
      creator_profile: {
        ownerProgress: "not_started",
        readiness: "actionable",
        actionableBy: "owner",
        reasonCodes: ["creator_profile_required"],
      },
    },
    recommendedTaskId: "creator_profile",
    entryDecision: {
      propertyId: PROPERTY_ID,
      decision: "enter",
      destinationRouteKey: "marketplace.workspace",
      reasonCode: null,
    },
  });
}

function exchangedHandoff() {
  return {
    propertyId: PROPERTY_ID,
    taskId: "creator_profile",
    issuedPlanRevision: "e2e-plan-1",
    destinationRouteKey: "marketplace.creator_profile",
    returnUrl: marketplaceSetupReturnUrl(),
  };
}

function marketplaceSetupReturnUrl() {
  const origin =
    process.env.E2E_MARKETPLACE_BASE_URL ||
    (process.env.E2E_START_SERVERS === "1"
      ? "http://127.0.0.1:3000"
      : "https://marketplace.localhost");
  const url = new URL("/setup", origin);
  url.searchParams.set("propertyId", PROPERTY_ID);
  return url.toString();
}

function authenticatedSession() {
  return {
    accessToken: "e2e-marketplace-authkit-token",
    csrfToken: "e2e-marketplace-csrf-token",
    organizationId: ORGANIZATION_ID,
    workosOrganizationId: WORKOS_ORGANIZATION_ID,
    organizationKind: "hotel_group",
    user: sessionUser(),
  };
}

function sessionUser() {
  return {
    id: "user_hotel_owner",
    email: "owner@alpenrose.example",
    name: "Owner Example",
    status: "active",
    workosUserId: "user_workos_hotel_owner",
  };
}
