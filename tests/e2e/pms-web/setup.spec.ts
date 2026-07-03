import { expect, test } from "@playwright/test";
import type {
  SharedHotelSetupProduct,
  SharedHotelSetupProductStatus,
  SharedHotelSetupStatus,
  SharedPropertyProfile,
} from "@vayada/hotel-setup-wizard";
import { mockPmsWebAuthenticatedSession } from "../support/pmsWebMocks";
import { watchPageHealth } from "../support/pageHealth";

const propertyId = "f6853000-0000-0000-0000-000000000970";

test.describe("pms-web shared setup", () => {
  test("walks first-property setup into product selection", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    let created = false;
    const statusRequests: URL[] = [];

    await mockPmsWebAuthenticatedSession(page);
    await mockSharedSetupApi(
      page,
      () => created,
      () => {
        created = true;
      },
      statusRequests,
    );

    await page.goto("/setup?entryProduct=pms&returnTo=/dashboard");

    await expect(page.getByRole("heading", { level: 1, name: "Add property" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Property details" })).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Property name is required.")).toBeVisible();
    await expect(page.getByText("Website is required to complete setup.")).toBeVisible();
    await expect(page.getByText("Photo URL is required to complete setup.")).toBeVisible();
    await expect(page.getByLabel("Property name")).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("Property name").fill("Alpenrose Munich");
    await page.getByLabel("Country code").fill("DE");
    await page.getByLabel("City").fill("Munich");
    await page.getByLabel("Website").fill("https://alpenrose.example");
    await page.getByLabel("Phone").fill("+49 89 123456");
    await page.getByLabel("Short description").fill("A city hotel close to the old town.");
    await page.getByLabel("Photo URL").fill("https://images.example/alpenrose.jpg");
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(page.getByRole("heading", { level: 2, name: "Choose products" })).toBeVisible();
    await expect(page.getByText("Alpenrose Munich")).toBeVisible();
    await expect(page.getByLabel("PMS")).toBeChecked();
    await expect(
      page.locator("label").filter({ hasText: "PMS" }).getByText("Selected"),
    ).toBeVisible();
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
  statusRequests: URL[],
) {
  await page.route("**/api/hotel-setup/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url());
    if (url.pathname === "/api/hotel-setup/status") {
      statusRequests.push(url);
      return route.fulfill({
        headers: corsHeaders(),
        json: isCreated() ? completeStatus() : emptyStatus(),
      });
    }

    if (url.pathname === "/api/hotel-setup/properties" && request.method() === "POST") {
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
    hotelGroup: { organizationId: "org_alpenrose", displayName: "Alpenrose Hotel Group" },
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

function propertyProfile(): SharedPropertyProfile {
  return {
    propertyId,
    publicId: "prop_alpenrose",
    displayName: "Alpenrose Munich",
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
