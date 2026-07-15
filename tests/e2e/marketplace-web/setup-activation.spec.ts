import { expect, test, type Page } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test.describe("marketplace-web shared setup activation", () => {
  test("creates the first hotel with the complete shared minimum", async ({ page, baseURL }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);

    let created = false;
    await page.route(/\/api\/hotel-setup\/status/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: created ? sharedSetupStatusForProductSelection() : emptySharedSetupStatus(),
      });
    });
    await page.route(/\/api\/hotel-setup\/properties$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const payload = route.request().postDataJSON();
      expect(payload).toMatchObject({
        displayName: "Hotel Alpenrose",
        propertyType: "hotel",
        location: {
          streetAddress: "Marienplatz 1",
          postalCode: "80331",
          city: "Munich",
          countryCode: "DE",
        },
        contactEmail: "owner@alpenrose.example",
        phone: "+49 89 123456",
        website: "https://alpenrose.example",
      });
      expect(payload.location.timezone).toMatch(/\//);
      created = true;
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: sharedPropertyProfile(payload),
      });
    });

    await page.goto(setupUrl(baseURL));

    await expect(page.getByRole("heading", { name: "Let’s get to know your hotel" })).toBeVisible();
    await page.getByRole("textbox", { name: /Hotel name/ }).fill("Hotel Alpenrose");
    await page.getByRole("radio", { name: "Hotel", exact: true }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Where can guests find you?", level: 3 }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: /Street address/ }).fill("Marienplatz 1");
    await page.getByRole("textbox", { name: /Postal code/ }).fill("80331");
    await page.getByRole("textbox", { name: /City/ }).fill("Munich");
    const countrySelect = page.getByRole("combobox", { name: /Country/ });
    await expect(countrySelect.locator('option[value="PR"]')).toHaveCount(1);
    await countrySelect.selectOption("DE");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("textbox", { name: /Contact email/ })).toHaveValue(
      "owner@alpenrose.example",
    );
    await expect(page.getByRole("textbox", { name: /Phone number/ })).toHaveValue("+49 89 123456");
    await page.getByRole("textbox", { name: /Website/ }).fill("https://alpenrose.example");
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(
      page.getByRole("heading", { name: "How would you like to use Vayada?", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Choose account systems", level: 2 }),
    ).toBeVisible();
  });

  test("shows the shared launch step before opening Marketplace tools", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus());

    await page.goto(setupUrl(baseURL));

    await expect(page.getByRole("heading", { name: "Activate Creator Marketplace" })).toBeVisible();
    await expect(page.getByText("Creator-facing pitch")).toBeVisible();
    await expect(page.getByText("Collaboration offer")).toBeVisible();
    await expect(page.getByText("Requested content")).toBeVisible();
    await expect(page.getByText("Compensation options")).toBeVisible();
    await expect(page.getByText("Creator requirements")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Hotel Name" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Website" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Phone" })).toHaveCount(0);
  });

  test("opens profile tools for creatorPitch even when legacy status reports profile missing", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["creatorPitch"]));
    await mockMarketplaceProfileApis(page);

    await page.goto(setupUrl(baseURL));
    await page.getByRole("button", { name: "Open Marketplace offer tools" }).click();

    await expect(page).toHaveURL(/\/profile$/);
  });

  test("blocks suspended Marketplace activation instead of opening profile tools", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus([], "suspended"));

    await page.goto(setupUrl(baseURL));

    await expect(
      page.getByRole("heading", { name: "Marketplace activation unavailable" }),
    ).toBeVisible();
    await expect(
      page.locator("p", { hasText: "Marketplace access is currently suspended" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Marketplace unavailable" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Open Marketplace offer tools" })).toHaveCount(0);
  });
});

function setupUrl(baseURL: string | undefined) {
  const path = "/setup?entryProduct=marketplace&returnTo=/marketplace";
  if (!baseURL) return path;

  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") {
    url.hostname = "localhost";
    url.pathname = "/setup";
    url.search = "?entryProduct=marketplace&returnTo=/marketplace";
    return url.toString();
  }
  return path;
}

async function primeBrowserState(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  });
}

async function mockAuthSession(page: Page) {
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationKind: "hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@alpenrose.example",
          name: "Owner Example",
          phone: "+49 89 123456",
          status: "active",
          workosUserId: "user_workos_hotel_owner",
        },
      },
    });
  });
  await page.route(/\/auth\/compat\/marketplace-web-token/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: { accessToken: "legacy-marketplace-token", expiresIn: 900 },
    });
  });
}

async function mockSharedSetupStatus(page: Page, status: ReturnType<typeof sharedSetupStatus>) {
  await page.route(/\/api\/hotel-setup\/status/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: status,
    });
  });
}

async function mockMarketplaceProfileApis(page: Page) {
  await page.route(/\/api\/marketplace\/hotels\/me\/profile-status/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        profile_complete: false,
        missing_fields: ["profile"],
        has_defaults: { location: false },
        missing_offers: false,
        completion_steps: ["Complete your marketplace hotel profile"],
      },
    });
  });
  await page.route(/\/hotels\/me$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        id: "hotel-profile-1",
        user_id: "user-hotel-owner",
        name: "Alpenrose Munich",
        category: "Boutique",
        location: "Munich, DE",
        picture: null,
        website: "https://alpenrose.example",
        about: "A city hotel close to the old town.",
        email: "owner@alpenrose.example",
        phone: "+49 89 123456",
        status: "pending",
        created_at: "2026-06-30T00:00:00.000Z",
        updated_at: "2026-06-30T00:00:00.000Z",
        listings: [],
      },
    });
  });
}
function sharedSetupStatus(
  missingSteps = [
    "creatorPitch",
    "marketplaceOffer",
    "offerDeliverables",
    "compensationOptions",
    "creatorRequirements",
  ],
  marketplaceStatus = "selected_incomplete",
) {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "marketplace", returnTo: "/marketplace" },
    hotelGroup: {
      organizationId: "11111111-1111-4111-8111-111111111111",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedProducts: ["marketplace"],
    },
    selection: { state: "single_property", selectedPropertyId: propertyId },
    properties: [
      {
        propertyId,
        publicId: "alpenrose-munich",
        displayName: "Alpenrose Munich",
        locationSummary: "Munich, DE",
        sharedProfile: {
          status: "complete",
          source: "canonical",
          completionPercent: 100,
          missingFields: [],
        },
        products: {
          booking: activation("booking", "active", []),
          pms: activation("pms", "not_selected", []),
          marketplace: activation("marketplace", marketplaceStatus, missingSteps),
        },
      },
    ],
    nextAction: {
      action: "complete_product_activation",
      propertyId,
      product: "marketplace",
      missingSteps,
      reasonCodes: ["entry_product_activation_incomplete"],
    },
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function activation(product: string, status: string, missingSteps: string[]) {
  return {
    product,
    status,
    missingSteps,
    statusReasons:
      status === "selected_incomplete"
        ? [`${product}_activation_incomplete`]
        : [`${product}_${status}`],
    updatedAt: status === "not_selected" ? null : "2026-06-30T00:00:00.000Z",
  };
}

function emptySharedSetupStatus() {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "marketplace", returnTo: "/marketplace" },
    hotelGroup: {
      organizationId: "11111111-1111-4111-8111-111111111111",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedProducts: [],
    },
    selection: { state: "no_property", selectedPropertyId: null },
    properties: [],
    nextAction: { action: "create_property", reasonCodes: ["no_property"] },
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function sharedSetupStatusForProductSelection() {
  const status = sharedSetupStatus();
  return {
    ...status,
    hotelGroup: { ...status.hotelGroup, selectedProducts: [] },
    properties: [
      {
        ...status.properties[0],
        displayName: "Hotel Alpenrose",
        sharedProfile: {
          status: "incomplete",
          source: "canonical",
          completionPercent: 67,
          missingFields: ["description", "media"],
        },
        products: {
          booking: activation("booking", "not_selected", []),
          pms: activation("pms", "not_selected", []),
          marketplace: activation("marketplace", "not_selected", []),
        },
      },
    ],
    nextAction: {
      action: "select_products",
      propertyId,
      reasonCodes: ["no_products_selected"],
    },
  };
}

function sharedPropertyProfile(payload: Record<string, unknown>) {
  return {
    propertyId,
    publicId: "prop_alpenrose",
    ...payload,
    sharedProfile: {
      status: "incomplete",
      source: "canonical",
      completionPercent: 67,
      missingFields: ["description", "media"],
    },
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}
