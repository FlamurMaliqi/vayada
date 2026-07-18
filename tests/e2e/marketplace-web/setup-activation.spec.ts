import { expect, test, type Locator, type Page } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test.describe("marketplace-web shared setup activation", () => {
  test("creates the first hotel with the complete shared minimum", async ({ page, baseURL }) => {
    await mockGooglePlaces(page);
    await primeBrowserState(page);
    await mockAuthSession(page);
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "shared-hotel-setup-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });

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
    const hotelName = page.getByRole("textbox", { name: /Hotel name/ });
    await hotelName.fill("Hotel Alpenrose");
    await expect(hotelName).toHaveValue("Hotel Alpenrose");
    await page.locator('label:has(input[type="radio"][value="hotel"])').click();
    await expect(page.getByRole("radio", { name: "Hotel", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Where can guests find you?", level: 3 }),
    ).toBeVisible();
    const locationContinueButton = page.getByRole("button", { name: "Continue" });
    await expect(locationContinueButton).toBeDisabled();
    await expect(page.getByText("Map preview", { exact: true })).toBeVisible();
    const manualAddressButton = page.getByRole("button", { name: "Enter address manually" });
    const searchFirst = await manualAddressButton.isVisible();
    if (
      process.env.CI === "true" ||
      process.env.E2E_START_SERVERS === "1" ||
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
    ) {
      expect(searchFirst).toBe(true);
    }
    if (searchFirst) {
      await expect(page.getByRole("textbox", { name: /Street address/ })).toHaveCount(0);
      const addressSearch = page.getByPlaceholder("Start with a street name");
      await expect(addressSearch).toBeVisible();
      const googleAddressSearch = page.locator(".vayada-google-place-autocomplete");
      await expect(googleAddressSearch).toHaveAttribute(
        "data-included-primary-types",
        "street_address,route",
      );
      await selectExactGoogleAddress(googleAddressSearch);
      await expect(page.getByText("Is this the right location?")).toBeVisible();
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-center",
        "48.1373932,11.5754485",
      );
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-zoom",
        "17",
      );
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-marker",
        "48.1373932,11.5754485",
      );
      await expect(locationContinueButton).toBeEnabled();

      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await addressSearch.focus();
      await googleAddressSearch.dispatchEvent("gmp-error");
    }

    const streetAddress = page.getByRole("textbox", { name: /Street address/ });
    if (searchFirst) await expect(streetAddress).toBeFocused();
    await streetAddress.fill("Marienplatz 1");
    await page.getByRole("textbox", { name: /Postal code/ }).fill("80331");
    await page.getByRole("textbox", { name: /City/ }).fill("Munich");
    const countrySelect = page.getByRole("combobox", { name: /Country/ });
    await expect(countrySelect.locator('option[value="PR"]')).toHaveCount(1);
    await countrySelect.selectOption("DE");
    await expect(locationContinueButton).toBeEnabled();

    if (searchFirst) {
      await page.getByRole("button", { name: "Done editing" }).click();
      await expect(page.getByText("Address details entered")).toBeVisible();
      await expect(page.getByText("Marienplatz 1")).toBeVisible();
      await expect(page.getByText("80331 Munich, Germany")).toBeVisible();
      await expect(page.getByText("This matches your device.")).toBeVisible();
      await page.getByRole("button", { name: "Edit address details" }).click();
      await expect(streetAddress).toBeFocused();
    }

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

async function mockGooglePlaces(page: Page) {
  await page.route(/https:\/\/maps\.googleapis\.com\/maps\/api\/js/, async (route) => {
    expect(new URL(route.request().url()).searchParams.get("language")).toBe("en");
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        const elementName = "vayada-e2e-place-autocomplete";
        let PlaceAutocompleteElement = customElements.get(elementName);
        if (!PlaceAutocompleteElement) {
          PlaceAutocompleteElement = class extends HTMLElement {
            constructor(options) {
              super();
              const root = this.attachShadow({ mode: "open" });
              const input = document.createElement("input");
              input.setAttribute("aria-label", options.description);
              input.placeholder = options.placeholder;
              root.append(input);
              this.dataset.includedPrimaryTypes = options.includedPrimaryTypes.join(",");
            }
          };
          customElements.define(elementName, PlaceAutocompleteElement);
        }
        class GoogleMap {
          constructor(element, options) {
            this.element = element;
            this.setCenter(options.center);
            this.setZoom(options.zoom);
          }
          setCenter(position) {
            this.element.dataset.center = position.lat + "," + position.lng;
          }
          setZoom(zoom) {
            this.element.dataset.zoom = String(zoom);
          }
        }
        class GoogleMarker {
          constructor(options) {
            this.element = options.map.element;
            this.setPosition(options.position);
          }
          setPosition(position) {
            if (position) {
              this.element.dataset.marker = position.lat + "," + position.lng;
            } else {
              delete this.element.dataset.marker;
            }
          }
        }
        window.google = {
          maps: {
            importLibrary: async (library) =>
              library === "maps"
                ? { Map: GoogleMap }
                : library === "marker"
                  ? { Marker: GoogleMarker }
                  : { PlaceAutocompleteElement },
          },
        };
        window.__vayadaGoogleMapsReady?.();
      `,
    });
  });
}

async function selectExactGoogleAddress(autocomplete: Locator) {
  await autocomplete.evaluate((element) => {
    const event = new Event("gmp-select");
    Object.defineProperty(event, "placePrediction", {
      value: {
        types: ["street_address"],
        toPlace: () => ({
          fetchFields: async () => undefined,
          location: { lat: () => 48.1373932, lng: () => 11.5754485 },
          postalAddress: {
            addressLines: ["Marienplatz 1"],
            administrativeArea: "Bavaria",
            locality: "Munich",
            postalCode: "80331",
            regionCode: "DE",
          },
        }),
      },
    });
    element.dispatchEvent(event);
  });
}

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
  await routeJson(page, new RegExp(`/api/marketplace/properties/${propertyId}/profile-status`), {
    profile_complete: false,
    missing_fields: ["profile"],
    has_defaults: { location: false },
    missing_offers: false,
    completion_steps: ["Complete your marketplace hotel profile"],
  });
  await routeJson(
    page,
    new RegExp(`/api/hotel-setup/properties/${propertyId}/profile`),
    sharedPropertyProfile({
      displayName: "Alpenrose Munich",
      propertyType: "hotel",
      location: {
        countryCode: "DE",
        region: "Bavaria",
        city: "Munich",
        streetAddress: "Marienplatz 1",
        postalCode: "80331",
        rawMarketplaceLocation: "Munich, DE",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        addressPublic: true,
        mapDisplayMode: "exact",
      },
      website: "https://alpenrose.example",
      contactEmail: "owner@alpenrose.example",
      phone: "+49 89 123456",
      shortDescription: "A city hotel close to the old town.",
      longDescription: null,
      media: [],
    }),
  );
  await routeJson(page, new RegExp(`/api/marketplace/properties/${propertyId}/profile(?:\\?|$)`), {
    propertyId,
    profileStatus: "pending",
    profileComplete: false,
    hostSummary: "A city hotel close to the old town.",
    collaborationGuidelines: null,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  });
  await routeJson(page, new RegExp(`/api/marketplace/properties/${propertyId}/offers`), {
    offers: [],
  });
}

async function routeJson(page: Page, pattern: RegExp, json: unknown) {
  await page.route(pattern, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json });
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
