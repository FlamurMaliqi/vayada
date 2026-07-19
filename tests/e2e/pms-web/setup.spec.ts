import { expect, test } from "@playwright/test";
import type {
  SharedHotelSetupProduct,
  SharedHotelSetupProductStatus,
  SharedHotelSetupStatus,
  SharedPropertyProfile,
} from "@vayada/product-onboarding";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

const propertyId = "f6853000-0000-0000-0000-000000000970";
const stalePropertyId = "f6853000-0000-0000-0000-000000000969";

test.describe("pms-web shared setup", () => {
  test("forwards actionable PMS setup to rooms without a second interstitial", async ({ page }) => {
    await mockPmsWebAuthenticatedSession(page, stalePropertyId);
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", async (route) => {
      if (route.request().method() === "OPTIONS" || new URL(page.url()).pathname !== "/setup") {
        await route.fallback();
        return;
      }
      await route.fulfill({ json: pmsActivationStatus("selected_incomplete") });
    });

    await page.goto(`/setup?entryProduct=pms&propertyId=${PMS_WEB_PROPERTY_ID}`);

    await expect(page).toHaveURL(/\/rooms$/);
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

  test("keeps an additive PMS requirement in the Rooms workspace", async ({ page }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({
        json: pmsActivationStatus("selected_incomplete", ["futurePmsRequirement"]),
      }),
    );

    await page.goto(`/setup?entryProduct=pms&propertyId=${PMS_WEB_PROPERTY_ID}`);

    await expect(page).toHaveURL(/\/rooms$/);
    await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
    await expect(page).toHaveURL(/\/rooms$/);
  });

  test("keeps a suspended PMS activation on setup with a disabled action", async ({ page }) => {
    await mockPmsWebAuthenticatedSession(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({ json: pmsActivationStatus("suspended") }),
    );

    await page.goto(`/setup?entryProduct=pms&propertyId=${PMS_WEB_PROPERTY_ID}`);

    await expect(page).toHaveURL(/\/setup\?/);
    await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "PMS unavailable" })).toBeDisabled();
  });

  test("walks first-property setup into product selection", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    let created = false;
    let finishCreateRequest: (() => void) | undefined;
    const createRequestBarrier = new Promise<void>((resolve) => {
      finishCreateRequest = resolve;
    });
    const statusRequests: URL[] = [];

    await mockPmsWebAuthenticatedSession(page);
    await mockSharedSetupApi(
      page,
      () => created,
      () => {
        created = true;
      },
      () => createRequestBarrier,
      statusRequests,
    );

    await page.goto("/setup?entryProduct=pms&returnTo=/dashboard");

    await expect(
      page.getByRole("heading", { level: 1, name: "Let’s get to know your hotel" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 3, name: "What should we call your hotel?" }),
    ).toBeVisible();
    await expect(page.getByText("Step 1 of 3")).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(2);
    await expect(page.getByRole("radio", { name: "Hotel from API", exact: true })).toBeVisible();
    await expect(
      page.getByRole("radio", { name: "Future type from API", exact: true }),
    ).toBeVisible();
    const continueButton = page.getByRole("button", { name: "Continue" });
    await expect(continueButton).toBeInViewport();
    await continueButton.click();
    await expect(page.getByText("Hotel name is required.")).toBeVisible();
    await expect(page.getByText("Property type is required.")).toBeVisible();
    const propertyNameField = page.getByLabel("Hotel name");
    await expect(propertyNameField).toHaveAttribute("aria-invalid", "true");
    const describedBy = await propertyNameField.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const propertyNameError = page.getByText("Hotel name is required.");
    const propertyNameErrorId = await propertyNameError.getAttribute("id");
    expect(propertyNameErrorId).toBeTruthy();
    expect(describedBy!.split(/\s+/)).toContain(propertyNameErrorId!);
    await expect(propertyNameError).toHaveAttribute("role", "alert");

    await page.getByLabel("Hotel name").fill("Alpenrose Munich");
    const hotelPropertyType = page.getByRole("radio", { name: "Hotel from API", exact: true });
    await hotelPropertyType.check();
    await expect(hotelPropertyType).toBeChecked();
    await page.getByRole("button", { name: "Continue" }).click();

    const locationHeading = page.getByRole("heading", {
      level: 1,
      name: "Where is your property?",
    });
    await expect(locationHeading).toBeVisible();
    await expect(locationHeading).toBeFocused();
    await expect(
      page.getByRole("heading", { level: 3, name: "Where is your property?" }),
    ).toHaveCount(0);
    await expect(page.getByText("Step 2 of 3")).toBeVisible();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();
    await expect(page.getByText("Street address is required.")).toBeVisible();
    await expect(page.getByText("Postal code is required.")).toBeVisible();

    await page.getByLabel("Street address").fill("Marienplatz 1");
    await page.getByLabel("Postal code").fill("80331");
    await page.getByLabel("City").fill("Munich");
    await page.getByLabel("Country").selectOption("DE");
    await page.getByLabel("Time zone").fill("Europe/Not_A_Real_Place");
    await continueButton.click();
    await expect(page.getByText("Enter a valid IANA time zone.")).toBeVisible();
    await page.getByLabel("Time zone").fill("Europe/Berlin");
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    await expect(
      page.getByRole("heading", { level: 3, name: "How can guests reach you?" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Let’s get to know your hotel" }),
    ).toBeVisible();
    await expect(page.getByText("Step 3 of 3")).toBeVisible();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(locationHeading).toBeVisible();
    await expect(locationHeading).toBeFocused();
    await expect(page.getByLabel("Street address")).toHaveValue("Marienplatz 1");
    await page.getByRole("button", { name: "Back" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Let’s get to know your hotel" }),
    ).toBeVisible();
    await expect(page.getByLabel("Hotel name")).toHaveValue("Alpenrose Munich");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Phone number").fill("+49 89 123456");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
    await expect(page.getByRole("status")).toHaveText("Saving hotel details.");
    await expect(
      page.getByLabel("Phone number").locator("xpath=ancestor::section"),
    ).toHaveAttribute("inert", "");
    finishCreateRequest?.();

    await expect(
      page.getByRole("heading", { level: 1, name: "How would you like to use Vayada?" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Choose account systems" }),
    ).toBeVisible();
    await expect(page.getByText("Alpenrose Munich")).toBeVisible();
    await expect(page.getByLabel("PMS")).toBeChecked();
    await expect(page.getByRole("button", { name: "Continue setup" })).toBeEnabled();
    expect(statusRequests.length).toBeGreaterThan(0);
    expect(
      statusRequests.every(
        (url) =>
          url.searchParams.get("entryProduct") === "pms" &&
          url.searchParams.get("returnTo") === "/dashboard",
      ),
    ).toBe(true);
    expect(statusRequests.some((url) => !url.searchParams.has("propertyId"))).toBe(true);
    expect(statusRequests.some((url) => url.searchParams.get("propertyId") === propertyId)).toBe(
      true,
    );

    await assertHealthy();
  });
});

async function mockSharedSetupApi(
  page: Parameters<typeof mockPmsWebAuthenticatedSession>[0],
  isCreated: () => boolean,
  markCreated: () => void,
  waitForCreate: () => Promise<void>,
  statusRequests: URL[],
) {
  await page.route("**/api/hotel-setup/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url());
    if (url.pathname === "/api/hotel-setup/property-types") {
      return route.fulfill({
        headers: corsHeaders(),
        json: {
          contractVersion: "shared-hotel-setup-property-types.v1",
          propertyTypes: [
            { value: "hotel", label: "Hotel from API" },
            { value: "constructor", label: "Future type from API" },
          ],
        },
      });
    }

    if (url.pathname === "/api/hotel-setup/status") {
      statusRequests.push(url);
      return route.fulfill({
        headers: corsHeaders(),
        json: isCreated() ? completeStatus() : emptyStatus(),
      });
    }

    if (url.pathname === "/api/hotel-setup/properties" && request.method() === "POST") {
      await waitForCreate();
      markCreated();
      return route.fulfill({
        status: 201,
        headers: corsHeaders(),
        json: propertyProfile(),
      });
    }

    return route.fulfill({ status: 404, headers: corsHeaders(), json: { detail: "Not found" } });
  });
}

function emptyStatus(): SharedHotelSetupStatus {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "pms", returnTo: "/dashboard" },
    hotelGroup: {
      organizationId: "org_alpenrose",
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

function completeStatus(): SharedHotelSetupStatus {
  return {
    ...emptyStatus(),
    selection: { state: "single_property", selectedPropertyId: propertyId },
    properties: [
      {
        propertyId,
        publicId: "prop_alpenrose",
        displayName: "Alpenrose Munich",
        locationSummary: "Munich, DE",
        sharedProfile: {
          status: "complete",
          source: "canonical",
          completionPercent: 100,
          missingFields: [],
        },
        products: {
          booking: product("booking", "not_selected"),
          pms: product("pms", "not_selected"),
          marketplace: product("marketplace", "not_selected"),
        },
      },
    ],
    nextAction: { action: "select_products", propertyId, reasonCodes: ["no_products_selected"] },
  };
}

function pmsActivationStatus(
  status: "selected_incomplete" | "suspended",
  requestedMissingSteps?: string[],
): SharedHotelSetupStatus {
  const base = completeStatus();
  const missingSteps =
    status === "selected_incomplete"
      ? (requestedMissingSteps ?? ["roomTypes", "rooms", "ratePlans"])
      : [];
  return {
    ...base,
    selection: { state: "single_property", selectedPropertyId: PMS_WEB_PROPERTY_ID },
    hotelGroup: { ...base.hotelGroup, selectedProducts: ["pms"] },
    properties: [
      {
        ...base.properties[0]!,
        propertyId: PMS_WEB_PROPERTY_ID,
        products: {
          ...base.properties[0]!.products,
          pms: {
            product: "pms",
            status,
            missingSteps,
            statusReasons: [status === "suspended" ? "pms_suspended" : "pms_activation_incomplete"],
            updatedAt: "2026-06-30T00:00:00.000Z",
          },
        },
      },
    ],
    nextAction: {
      action: "complete_product_activation",
      propertyId: PMS_WEB_PROPERTY_ID,
      product: "pms",
      missingSteps,
      reasonCodes: [
        status === "suspended" ? "pms_suspended" : "entry_product_activation_incomplete",
      ],
    },
  };
}

function propertyProfile(): SharedPropertyProfile {
  return {
    propertyId,
    publicId: "prop_alpenrose",
    displayName: "Alpenrose Munich",
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      region: null,
      city: "Munich",
      streetAddress: null,
      postalCode: null,
      rawMarketplaceLocation: null,
      timezone: null,
      latitude: null,
      longitude: null,
      addressPublic: true,
      mapDisplayMode: "hidden",
    },
    website: "https://alpenrose.example/",
    contactEmail: "hello@alpenrose.example",
    phone: "+49 89 123456",
    shortDescription: "A city hotel close to the old town.",
    longDescription: null,
    media: [
      {
        mediaType: "gallery_image",
        url: "https://images.example/alpenrose.jpg",
        altText: null,
        sortOrder: 0,
      },
    ],
    sharedProfile: {
      status: "complete",
      source: "canonical",
      completionPercent: 100,
      missingFields: [],
    },
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function product(productName: SharedHotelSetupProduct, status: SharedHotelSetupProductStatus) {
  return {
    product: productName,
    status,
    missingSteps: [],
    statusReasons: [],
    updatedAt: null,
  };
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  };
}
