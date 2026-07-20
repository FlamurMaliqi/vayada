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
  test("uses the shared hotel personal-account step when the saved photo is missing", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/auth/session?surface=pms-web", (route) =>
      route.fulfill({
        json: {
          accessToken: "e2e-pms-token",
          csrfToken: "e2e-pms-csrf-token",
          organizationId: "org_pms_owner",
          user: {
            id: "user_pms_owner",
            email: "owner@example.com",
            name: "PMS Owner",
            phone: "+49 89 123456",
            profilePictureUrl: null,
            profilePictureMediaObjectId: null,
            status: "active",
          },
        },
      }),
    );

    await page.goto("/setup?entryProduct=pms");

    await expect(page.getByRole("heading", { name: "Let’s create your profile" })).toBeVisible();
    await expect(
      page.getByText("Start with your details. Next, we’ll set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByLabel("First name")).toHaveValue("PMS");
    await expect(page.getByLabel("Last name")).toHaveValue("Owner");
    await expect(page.getByLabel("Email address")).toHaveValue("owner@example.com");
    await expect(page.getByLabel("Phone number")).toHaveValue("+49 89 123456");
    await expect(page.getByLabel("Profile photo file")).toHaveAttribute("required", "");
    await expect(page.getByRole("button", { name: "Continue to hotel setup" })).toBeVisible();
  });

  test("hands Booking and Marketplace tasks off with the selected hotel group", async ({
    page,
    baseURL,
  }) => {
    let target: "booking" | "marketplace" = "booking";
    await page.addInitScript(() => {
      localStorage.setItem("access_token", "e2e-pms-compatibility-token");
      localStorage.setItem("token_expires_at", String(Date.now() + 60 * 60 * 1000));
      localStorage.setItem("isLoggedIn", "true");
      localStorage.setItem("userName", "PMS Owner");
      localStorage.setItem("userEmail", "owner@example.com");
      localStorage.setItem("userType", "hotel");
      localStorage.setItem("selectedWorkosOrganizationId", "org_workos_pms_owner");
    });
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) => {
      const status = pmsActivationStatus("selected_incomplete", ["roomTypes"]);
      status.entry.entryProduct = target;
      status.hotelGroup.organizationId = "org_pms_owner";
      const targetProduct = product(target, "selected_incomplete");
      targetProduct.missingSteps = target === "booking" ? ["bookingSettings"] : ["creatorPitch"];
      status.properties[0]!.products[target] = targetProduct;
      status.nextAction = {
        action: "complete_product_activation",
        propertyId: PMS_WEB_PROPERTY_ID,
        product: target,
        missingSteps: targetProduct.missingSteps,
        reasonCodes: ["entry_product_activation_incomplete"],
      };
      return route.fulfill({ json: status });
    });
    await page.route(/\/handoff(?:\?.*)?$/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Handoff</title>" }),
    );

    for (target of ["booking", "marketplace"] as const) {
      await page.goto(
        new URL(
          `/setup?entryProduct=${target}&propertyId=${PMS_WEB_PROPERTY_ID}`,
          baseURL,
        ).toString(),
      );
      await expect.poll(() => new URL(page.url()).pathname).toBe("/handoff");

      const handoffUrl = new URL(page.url());
      expect(handoffUrl.hostname).toContain(target === "booking" ? "admin.booking" : "marketplace");
      expect(handoffUrl.pathname).toBe("/handoff");
      expect(handoffUrl.searchParams.get("redirect")).toBe(
        target === "booking"
          ? `/setup?entryProduct=booking&propertyId=${PMS_WEB_PROPERTY_ID}`
          : `/profile/complete?activation=marketplace&propertyId=${PMS_WEB_PROPERTY_ID}`,
      );
      const fragment = new URLSearchParams(handoffUrl.hash.slice(1));
      expect(fragment.get("property_id")).toBe(PMS_WEB_PROPERTY_ID);
      expect(fragment.get("organization_id")).toBe("org_pms_owner");
      expect(fragment.get("workos_organization_id")).toBe("org_workos_pms_owner");
    }
  });

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
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({ json: pmsActivationStatus("suspended") }),
    );

    await page.goto(`/setup?entryProduct=pms&propertyId=${PMS_WEB_PROPERTY_ID}`);

    await expect(page).toHaveURL(/\/setup\?/);
    await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "PMS unavailable" })).toBeDisabled();
  });

  test("walks first-property setup into the selected-products roadmap", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    let created = false;
    let finishCreateRequest: (() => void) | undefined;
    const createRequestBarrier = new Promise<void>((resolve) => {
      finishCreateRequest = resolve;
    });
    const statusRequests: URL[] = [];
    const selectedProducts: SharedHotelSetupProduct[] = [];

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route("**/auth/compat/pms-web-token", (route) =>
      route.fulfill({ json: { accessToken: "e2e-pms-compatibility-token", expiresIn: 900 } }),
    );
    await mockSharedSetupApi(
      page,
      () => created,
      () => {
        created = true;
      },
      () => createRequestBarrier,
      statusRequests,
      selectedProducts,
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
    const bookingSystem = page.getByLabel("Booking Engine", { exact: true });
    const marketplaceSystem = page.getByLabel("Creator Marketplace", { exact: true });
    await bookingSystem.locator("xpath=ancestor::label").click();
    await marketplaceSystem.locator("xpath=ancestor::label").click();
    await expect(bookingSystem).toBeChecked();
    await expect(marketplaceSystem).toBeChecked();
    const continueSetup = page.getByRole("button", { name: "Continue setup" });
    await expect(continueSetup).toBeEnabled();
    await continueSetup.click();

    expect(selectedProducts).toEqual(["pms", "booking", "marketplace"]);
    await expect(page).toHaveURL(/\/setup\?/);
    const roadmapUrl = new URL(page.url());
    expect(roadmapUrl.searchParams.get("entryProduct")).toBe("pms");
    expect(roadmapUrl.searchParams.get("returnTo")).toBe("/dashboard");
    await expect(
      page.getByRole("heading", { level: 1, name: "Finish setting up Alpenrose Munich" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Booking Engine" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "PMS" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Creator Marketplace" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue in Booking Admin" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue in PMS" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue Marketplace setup" })).toBeVisible();
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
  selectedProducts: SharedHotelSetupProduct[],
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
        json: isCreated()
          ? selectedProducts.length > 0
            ? selectedProductsRoadmapStatus(selectedProducts)
            : completeStatus()
          : emptyStatus(),
      });
    }

    if (url.pathname === "/api/hotel-setup/products" && request.method() === "PUT") {
      const payload = request.postDataJSON() as {
        selectedProducts: SharedHotelSetupProduct[];
      };
      selectedProducts.splice(0, selectedProducts.length, ...payload.selectedProducts);
      return route.fulfill({
        headers: corsHeaders(),
        json: {
          organizationId: "org_alpenrose",
          selectedProducts,
          updatedAt: "2026-06-30T00:00:00.000Z",
        },
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

function selectedProductsRoadmapStatus(
  selectedProducts: SharedHotelSetupProduct[],
): SharedHotelSetupStatus {
  const base = completeStatus();
  const booking = product("booking", "selected_incomplete");
  booking.missingSteps = ["bookingSettings", "publicBookability", "paymentReadiness"];
  const pms = product("pms", "selected_incomplete");
  pms.missingSteps = ["roomTypes", "rooms", "ratePlans"];
  const marketplace = product("marketplace", "selected_incomplete");
  marketplace.missingSteps = ["creatorPitch", "marketplaceOffer"];

  return {
    ...base,
    hotelGroup: { ...base.hotelGroup, selectedProducts },
    properties: [
      {
        ...base.properties[0]!,
        products: { booking, pms, marketplace },
      },
    ],
    nextAction: {
      action: "complete_product_activation",
      propertyId,
      product: "pms",
      missingSteps: pms.missingSteps,
      reasonCodes: ["entry_product_activation_incomplete"],
    },
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
