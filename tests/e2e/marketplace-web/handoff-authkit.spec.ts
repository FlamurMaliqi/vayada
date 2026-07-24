import { expect, test, type Page } from "@playwright/test";
import {
  createSharedHotelSetupStatusMock,
  sharedHotelSetupProduct,
} from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const PROPERTY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_PROPERTY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const WORKOS_ORGANIZATION_ID = "org_workos_hotel_group";

test.describe("marketplace-web AuthKit handoff", () => {
  test("ignores legacy credentials, selects the hinted hotel group, and opens activation", async ({
    page,
  }) => {
    const refreshRequests: unknown[] = [];
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        headers: corsHeaders(route),
        json: {
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
        },
      });
    });
    await page.route(/\/auth\/session\/refresh$/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      refreshRequests.push(route.request().postDataJSON());
      return route.fulfill({ headers: corsHeaders(route), json: authenticatedSession() });
    });
    await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        headers: corsHeaders(route),
        json: marketplaceStatus(PROPERTY_ID),
      });
    });
    await page.route(/\/profile\/complete\?activation=marketplace&propertyId=/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Activation</title>" }),
    );

    const redirect = `/profile/complete?activation=marketplace&propertyId=${PROPERTY_ID}`;
    const handoffQuery = new URLSearchParams({ redirect }).toString();
    const handoffFragment = new URLSearchParams({
      token: "untrusted-legacy-token",
      expires_at: String(Date.now() + 60_000),
      user: JSON.stringify({
        id: "attacker-controlled-id",
        email: "attacker@example.test",
        type: "creator",
      }),
      organization_id: ORGANIZATION_ID,
      workos_organization_id: WORKOS_ORGANIZATION_ID,
      property_id: PROPERTY_ID,
    }).toString();
    await page.goto(`/handoff?${handoffQuery}#${handoffFragment}`);

    await expect(page).toHaveURL(new RegExp(`/profile/complete\\?activation=marketplace`));
    expect(refreshRequests).toEqual([
      { organizationId: WORKOS_ORGANIZATION_ID, surface: "marketplace-web" },
    ]);
    expect(await page.evaluate(() => localStorage.getItem("access_token"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("userEmail"))).toBe(
      "owner@alpenrose.example",
    );
    expect(page.url()).not.toContain("/login");
  });

  test("does not replace an unavailable explicit property with another singleton", async ({
    page,
  }) => {
    await mockDirectAuthSession(page);
    await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        headers: corsHeaders(route),
        json: marketplaceStatus(OTHER_PROPERTY_ID),
      });
    });
    await stubMarketplaceSetup(page);

    await page.goto(`/handoff#${handoffFragment(PROPERTY_ID)}`);

    await expect(page).toHaveURL(
      new RegExp(`/setup\\?entryProduct=marketplace&propertyId=${PROPERTY_ID}$`),
    );
    expect(await page.evaluate(() => localStorage.getItem("selectedSharedPropertyId"))).toBeNull();
  });

  test("keeps an authenticated user in setup when status loading fails", async ({ page }) => {
    await mockDirectAuthSession(page);
    await page.route(/\/api\/hotel-setup\/status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      return route.fulfill({
        status: 503,
        headers: corsHeaders(route),
        json: { message: "Unavailable" },
      });
    });
    await stubMarketplaceSetup(page);

    await page.goto(`/handoff#${handoffFragment(PROPERTY_ID)}`);

    await expect(page).toHaveURL(
      new RegExp(`/setup\\?entryProduct=marketplace&propertyId=${PROPERTY_ID}$`),
    );
    expect(page.url()).not.toContain("/login");
  });
});

async function mockDirectAuthSession(page: Page) {
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    return route.fulfill({ headers: corsHeaders(route), json: authenticatedSession() });
  });
}

async function stubMarketplaceSetup(page: Page) {
  await page.route(/\/setup\?entryProduct=marketplace&propertyId=/, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Setup</title>" }),
  );
}

function handoffFragment(propertyId: string) {
  return new URLSearchParams({
    organization_id: ORGANIZATION_ID,
    workos_organization_id: WORKOS_ORGANIZATION_ID,
    property_id: propertyId,
  }).toString();
}

function marketplaceStatus(propertyId: string) {
  return createSharedHotelSetupStatusMock({
    entryProduct: "marketplace",
    returnTo: "/marketplace",
    organizationId: ORGANIZATION_ID,
    organizationDisplayName: "Alpenrose Hotel Group",
    propertyId,
    publicId: `public-${propertyId}`,
    propertyDisplayName: "Alpenrose",
    locationSummary: "Munich, DE",
    products: {
      booking: sharedHotelSetupProduct("booking", "active"),
      pms: sharedHotelSetupProduct("pms", "active"),
      marketplace: sharedHotelSetupProduct("marketplace", "selected_incomplete"),
    },
    nextAction: {
      action: "complete_product_activation",
      propertyId,
      product: "marketplace",
      returnTo: "/marketplace",
      reasonCodes: ["entry_product_activation_incomplete"],
    },
  });
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
