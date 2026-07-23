import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  defaultBookingAdminDesignSettings,
  defaultBookingAdminPropertySettings,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminDesignSettings,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import {
  createSharedHotelSetupStatusMock,
  sharedHotelSetupProduct,
} from "../support/sharedHotelSetupMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";
const SECOND_HOTEL_ID = "booking_hotel_bergwald";
const SECOND_PROPERTY_ID = "f6853000-0000-0000-0000-000000000002";
const SHARED_HOTEL_SETTING_FIELDS = new Set([
  "property_name",
  "reservation_email",
  "phone_number",
  "address",
  "city",
  "country",
]);

test.describe("booking-admin shared setup", () => {
  test("uses the shared hotel personal-account step when the saved photo is missing", async ({
    page,
  }) => {
    await page.route("**/auth/session?surface=booking-admin", (route) =>
      route.fulfill({
        json: {
          accessToken: "e2e-booking-authkit-token",
          csrfToken: "e2e-booking-csrf-token",
          organizationId: "org_hotel_group",
          user: {
            id: "user_booking_owner",
            email: "owner@example.com",
            name: "Booking Owner",
            phone: "+49 89 123456",
            profilePictureUrl: null,
            profilePictureMediaObjectId: null,
            status: "active",
          },
        },
      }),
    );

    await page.goto("/setup?entryProduct=booking");

    await expect(page.getByRole("heading", { name: "Let’s create your profile" })).toBeVisible();
    await expect(
      page.getByText("Start with your details. Next, we’ll set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByLabel("First name")).toHaveValue("Booking");
    await expect(page.getByLabel("Last name")).toHaveValue("Owner");
    await expect(page.getByLabel("Email address")).toHaveValue("owner@example.com");
    await expect(page.getByLabel("Phone number")).toHaveValue("+49 89 123456");
    await expect(page.getByLabel("Profile photo file")).toHaveAttribute("required", "");
    await expect(page.getByRole("button", { name: "Continue to hotel setup" })).toBeVisible();
  });

  test("hands PMS and Marketplace tasks off with the selected hotel group", async ({
    page,
    baseURL,
  }) => {
    const workosOrganizationId = "org_workos_hotel_group";
    let target: "pms" | "marketplace" = "pms";
    await page.route("**/auth/session?surface=booking-admin", (route) =>
      route.fulfill({
        json: {
          accessToken: "e2e-booking-authkit-token",
          csrfToken: "e2e-booking-csrf-token",
          organizationId: "org_hotel_group",
          workosOrganizationId,
          resources: { "booking:booking_hotel": [BOOKING_ADMIN_HOTEL_ID] },
          user: {
            id: "user_booking_owner",
            email: "owner@example.com",
            name: "Booking Owner",
            phone: "+49 89 123456",
            profilePictureUrl: "https://media.example/booking-owner.webp",
            profilePictureMediaObjectId: "media-booking-owner",
            status: "active",
          },
        },
      }),
    );
    await mockBookingAdminShellRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) => {
      const product = sharedHotelSetupProduct(target, "selected_incomplete");
      product.missingSteps = target === "pms" ? ["roomTypes"] : ["creatorPitch"];
      return route.fulfill({
        json: createSharedHotelSetupStatusMock({
          entryProduct: target,
          returnTo: "/dashboard",
          organizationId: "org_hotel_group",
          organizationDisplayName: "Alpenrose Hotel Group",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          publicId: "prop_alpenrose",
          propertyDisplayName: "Alpenrose",
          locationSummary: "Munich, DE",
          products: {
            booking: sharedHotelSetupProduct("booking", "active"),
            pms: target === "pms" ? product : sharedHotelSetupProduct("pms", "selected_incomplete"),
            marketplace:
              target === "marketplace"
                ? product
                : sharedHotelSetupProduct("marketplace", "selected_incomplete"),
          },
          nextAction: {
            action: "complete_product_activation",
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            product: target,
            returnTo: "/dashboard",
            reasonCodes: ["entry_product_activation_incomplete"],
          },
        }),
      });
    });
    await page.route(/\/handoff(?:\?.*)?$/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Handoff</title>" }),
    );

    for (target of ["pms", "marketplace"] as const) {
      await page.goto(
        new URL(
          `/setup?entryProduct=${target}&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`,
          baseURL,
        ).toString(),
      );
      await expect.poll(() => new URL(page.url()).pathname).toBe("/handoff");

      const handoffUrl = new URL(page.url());
      expect(handoffUrl.hostname).toContain(target === "pms" ? "pms" : "marketplace");
      expect(handoffUrl.pathname).toBe("/handoff");
      expect(handoffUrl.searchParams.get("redirect")).toBe(
        target === "marketplace"
          ? `/profile/complete?activation=marketplace&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`
          : null,
      );
      const fragment = new URLSearchParams(handoffUrl.hash.slice(1));
      expect(fragment.get("property_id")).toBe(BOOKING_ADMIN_PROPERTY_ID);
      expect(fragment.get("organization_id")).toBe("org_hotel_group");
      expect(fragment.get("workos_organization_id")).toBe(workosOrganizationId);
    }
  });

  test("honors a setup-intent handoff and opens the Booking Admin wizard", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 789 });
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    const booking = sharedHotelSetupProduct("booking", "selected_incomplete");
    booking.missingSteps = ["bookingSettings", "publicBookability", "paymentReadiness"];
    booking.statusReasons = ["booking_activation_incomplete"];
    await page.route("**/api/hotel-setup/status**", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: createSharedHotelSetupStatusMock({
          entryProduct: "booking",
          returnTo: "/dashboard",
          organizationId: "org_hotel_group",
          organizationDisplayName: "Alpenrose Hotel Group",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          publicId: "prop_alpenrose",
          propertyDisplayName: "Alpenrose",
          locationSummary: "Munich, DE",
          products: {
            booking,
            pms: sharedHotelSetupProduct("pms", "not_selected"),
            marketplace: sharedHotelSetupProduct("marketplace", "not_selected"),
          },
          nextAction: {
            action: "complete_product_activation",
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            product: "booking",
            returnTo: "/dashboard",
            reasonCodes: ["entry_product_activation_incomplete"],
          },
        }),
      });
    });

    const setupPath = `/setup?entryProduct=booking&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`;
    const handoffQuery = new URLSearchParams({ redirect: setupPath }).toString();
    await page.goto("/login");
    const legacyAuth = await page.evaluate(() => ({
      token: localStorage.getItem("access_token"),
      expiresAt: localStorage.getItem("token_expires_at"),
    }));
    expect(legacyAuth.token).toBeTruthy();
    expect(legacyAuth.expiresAt).toBeTruthy();
    const handoffHash = new URLSearchParams({
      token: legacyAuth.token ?? "",
      expires_at: legacyAuth.expiresAt ?? "",
      property_id: BOOKING_ADMIN_PROPERTY_ID,
    }).toString();
    await page.goto(`/handoff?${handoffQuery}#${handoffHash}`);

    await expect(page).toHaveURL(
      new RegExp(`/setup\\?legacy=booking&propertyId=${BOOKING_ADMIN_PROPERTY_ID}$`),
    );
    await expect(page.getByRole("heading", { name: "Your Property" })).toBeVisible();
    await expect(page.getByText("Property Name", { exact: false })).toHaveCount(0);
    await expect(page.getByText("City", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Country", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Full Address", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Hotel contact email", { exact: false })).toHaveCount(0);
    await expect(page.getByText("Hotel phone", { exact: false })).toHaveCount(0);
    await expect(page.getByText("WhatsApp", { exact: false })).toBeVisible();
    await expect(page.getByText("Default Currency", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= document.documentElement.clientHeight,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("blocks activation when existing Booking settings cannot be loaded", async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route("**/api/booking/hotels/*/settings/property*", (route) =>
      route.fulfill({ status: 500, json: { message: "Unavailable" } }),
    );

    await page.goto(`/setup?legacy=booking&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`);

    await expect(page.getByRole("heading", { name: "Your Property" })).toBeVisible();
    await expect(
      page.getByText("We couldn't load your Booking settings. Refresh the page to try again."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  test("keeps Design Studio read-only until saved branding loads", async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    let designReads = 0;
    await page.route("**/api/booking/hotels/*/settings/design", (route) => {
      designReads += 1;
      return designReads === 1
        ? route.fulfill({ status: 500, json: { message: "Unavailable" } })
        : route.fulfill({ json: defaultBookingAdminDesignSettings });
    });

    await page.goto("/design-studio");

    await expect(page.getByRole("heading", { name: "Design Studio" })).toBeVisible();
    await expect(
      page.getByText("Failed to load design settings. Your saved design has not been changed."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save Changes" })).toHaveCount(0);

    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("textbox", { name: "Hero heading" })).toHaveValue(
      defaultBookingAdminDesignSettings.heroHeading,
    );
    await expect(page.getByRole("button", { name: "Save Changes" })).toBeEnabled();
  });

  test("targets the native Booking hotel for the requested property in a multi-hotel account", async ({
    page,
  }) => {
    const patchedHotelIds = await mockMultiHotelActivation(page);

    await page.goto(`/setup?entryProduct=booking&propertyId=${SECOND_PROPERTY_ID}`);

    await expect(page).toHaveURL(
      new RegExp(`/setup\\?legacy=booking&propertyId=${SECOND_PROPERTY_ID}$`),
    );
    await expect(page.getByRole("heading", { name: "Your Property" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("selectedHotelId")))
      .toBe(SECOND_HOTEL_ID);
    expect(patchedHotelIds).toEqual([]);
  });

  test("replaces a stale native hotel before entering an active Booking product", async ({
    page,
  }) => {
    await mockMultiHotelActivation(page, "active");

    await page.goto(`/setup?entryProduct=booking&propertyId=${SECOND_PROPERTY_ID}`);

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("selectedHotelId")))
      .toBe(SECOND_HOTEL_ID);
    expect(await page.evaluate(() => localStorage.getItem("selectedSharedPropertyId"))).toBe(
      SECOND_PROPERTY_ID,
    );
  });

  test("saves Booking branding for the captured activation hotel and reuses it in Design Studio", async ({
    page,
  }) => {
    const patchedPayloads: Record<string, unknown>[] = [];
    const patchedHotelIds = await mockMultiHotelActivation(page, "selected_incomplete", (payload) =>
      patchedPayloads.push(payload),
    );
    const design = await mockBookingAdminDesignSettings(page);
    await page.goto(`/setup?legacy=booking&propertyId=${SECOND_PROPERTY_ID}`);
    await expect(page.getByRole("heading", { name: "Your Property" })).toBeVisible();

    await page.evaluate(
      (hotelId) => localStorage.setItem("selectedHotelId", hotelId),
      BOOKING_ADMIN_HOTEL_ID,
    );
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Brand & Media" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Hero heading" })).toHaveValue(
      defaultBookingAdminDesignSettings.heroHeading,
    );
    await expect(page.getByRole("textbox", { name: "Hero subtext" })).toHaveValue(
      defaultBookingAdminDesignSettings.heroSubtext,
    );
    await expect(page.getByRole("textbox", { name: "Hero subtext" })).toHaveAttribute(
      "aria-required",
      "true",
    );
    await expect(page.locator('input[aria-label="Hero image"]')).toHaveAttribute(
      "aria-required",
      "true",
    );
    await expect(
      page.getByRole("textbox", { name: "Primary brand color", exact: true }),
    ).toHaveValue(defaultBookingAdminDesignSettings.primaryColor);
    await expect(page.getByRole("button", { name: /Modern Minimalist/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const savedBranding = {
      ...defaultBookingAdminDesignSettings,
      heroHeading: "Bergwald, your alpine hideaway",
      heroSubtext: "A quiet mountain stay designed for booking direct.",
      primaryColor: "#0F766E",
      fontPairing: "grand-classic",
    };
    await page.getByRole("textbox", { name: "Hero heading" }).fill(savedBranding.heroHeading);
    const heroSubtext = page.getByRole("textbox", { name: "Hero subtext" });
    await heroSubtext.fill("");
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    await heroSubtext.fill(savedBranding.heroSubtext);
    await page
      .getByRole("textbox", { name: "Primary brand color", exact: true })
      .fill(savedBranding.primaryColor);
    await page.getByRole("button", { name: /Grand Classic/ }).click();

    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Skip for Now/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Launch Property/ }).click();

    await expect.poll(() => patchedHotelIds).toEqual([SECOND_HOTEL_ID]);
    expect(patchedPayloads).toHaveLength(1);
    expect(
      Object.keys(patchedPayloads[0] ?? {}).filter((key) => SHARED_HOTEL_SETTING_FIELDS.has(key)),
    ).toEqual([]);

    await expect(page).toHaveURL(/\/dashboard$/);
    expect(design.requests.filter((request) => request.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        hotelId: SECOND_HOTEL_ID,
        body: savedBranding,
      },
    ]);

    await expect(page.getByRole("link", { name: "Design Studio" })).toBeVisible();
    await page.getByRole("link", { name: "Design Studio" }).click();
    await expect(page.getByRole("heading", { name: "Design Studio" })).toBeVisible();
    await expect(page.getByRole("main").getByText("Bergwald", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Hero heading" })).toHaveValue(
      savedBranding.heroHeading,
    );
    await expect(page.getByRole("textbox", { name: "Hero subtext" })).toHaveValue(
      savedBranding.heroSubtext,
    );
    await expect(page.getByRole("img", { name: "Hero" })).toHaveAttribute(
      "src",
      savedBranding.heroImage,
    );
    await page.getByRole("button", { name: "Colors" }).click();
    await expect(
      page.getByRole("textbox", { name: "Primary brand color", exact: true }),
    ).toHaveValue(savedBranding.primaryColor);
    await page.getByRole("button", { name: "Fonts" }).click();
    await expect(page.getByRole("button", { name: /Grand Classic/ })).toHaveClass(/ring-1/);
    const designReads = design.requests.filter((request) => request.method === "GET");
    expect(designReads.length).toBeGreaterThanOrEqual(2);
    expect(designReads.every((request) => request.hotelId === SECOND_HOTEL_ID)).toBe(true);

    await page.evaluate(
      (hotelId) => localStorage.setItem("selectedHotelId", hotelId),
      BOOKING_ADMIN_HOTEL_ID,
    );
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText("Design settings saved successfully")).toBeVisible();
    expect(design.requests.filter((request) => request.method === "PATCH")).toEqual([
      { method: "PATCH", hotelId: SECOND_HOTEL_ID, body: savedBranding },
      { method: "PATCH", hotelId: SECOND_HOTEL_ID, body: savedBranding },
    ]);
  });

  test("keeps the activation draft when public readiness is incomplete", async ({ page }) => {
    await mockMultiHotelActivation(page, "selected_incomplete", undefined, {
      profileStatus: "incomplete",
      freshnessStatus: "unavailable",
      missingReadiness: ["availability", "payments"],
    });

    await page.goto(`/setup?legacy=booking&propertyId=${SECOND_PROPERTY_ID}`);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Skip for Now/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Launch Property/ }).click();

    await expect(page).toHaveURL(
      new RegExp(`/setup\\?legacy=booking&propertyId=${SECOND_PROPERTY_ID}$`),
    );
    await expect(
      page.getByText(
        "Your Booking settings were saved, but the booking page is not ready to go live.",
        { exact: false },
      ),
    ).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("setupComplete"))).toBeNull();
    await expect
      .poll(() =>
        page.evaluate(
          (propertyId) =>
            localStorage.getItem(
              `booking-setup:draft:v2:${["user_1", "org_hotel_group", propertyId]
                .map((part) => encodeURIComponent(part))
                .join(":")}`,
            ),
          SECOND_PROPERTY_ID,
        ),
      )
      .not.toBeNull();
  });
});

test.describe("booking-admin setup no-legacy guard", () => {
  test("hydrates manual setup without migrated helper calls", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-setup");

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    await page.goto("/setup?mode=add");
    await page.getByRole("button", { name: "Set up manually" }).click();

    await expect(page.getByRole("heading", { name: "Your Property" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Basic Information" })).toBeVisible();
    await expect(page.getByText("Hotel contact email", { exact: false })).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});

async function mockMultiHotelActivation(
  page: Page,
  activationStatus: "active" | "selected_incomplete" = "selected_incomplete",
  onPatch?: (payload: Record<string, unknown>) => void,
  publication: {
    profileStatus: "public" | "incomplete" | "unpublished" | "stale" | "unavailable";
    freshnessStatus: "fresh" | "stale" | "unavailable" | "unknown";
    missingReadiness: string[];
  } = { profileStatus: "public", freshnessStatus: "fresh", missingReadiness: [] },
): Promise<string[]> {
  await mockBookingAdminAuthenticatedSession(page, [BOOKING_ADMIN_HOTEL_ID, SECOND_HOTEL_ID]);
  await mockBookingAdminShellRoutes(page);

  const booking = sharedHotelSetupProduct("booking", activationStatus);
  if (activationStatus === "selected_incomplete") {
    booking.missingSteps = ["bookingSettings", "publicBookability", "paymentReadiness"];
    booking.statusReasons = ["booking_activation_incomplete"];
  }
  const status = createSharedHotelSetupStatusMock({
    entryProduct: "booking",
    returnTo: "/dashboard",
    organizationId: "org_hotel_group",
    organizationDisplayName: "Alpenrose Hotel Group",
    propertyId: SECOND_PROPERTY_ID,
    publicId: "prop_bergwald",
    propertyDisplayName: "Bergwald",
    locationSummary: "Garmisch-Partenkirchen, DE",
    products: {
      booking,
      pms: sharedHotelSetupProduct("pms", "not_selected"),
      marketplace: sharedHotelSetupProduct("marketplace", "not_selected"),
    },
    nextAction:
      activationStatus === "active"
        ? {
            action: "enter_product",
            propertyId: SECOND_PROPERTY_ID,
            product: "booking",
            returnTo: "/dashboard",
            reasonCodes: ["ready"],
          }
        : {
            action: "complete_product_activation",
            propertyId: SECOND_PROPERTY_ID,
            product: "booking",
            returnTo: "/dashboard",
            reasonCodes: ["entry_product_activation_incomplete"],
          },
  });
  status.properties.unshift({
    ...status.properties[0]!,
    propertyId: BOOKING_ADMIN_PROPERTY_ID,
    publicId: "prop_alpenrose",
    displayName: "Alpenrose",
    locationSummary: "Munich, DE",
  });
  await page.route("**/api/hotel-setup/status**", (route) => route.fulfill({ json: status }));
  await page.route("**/api/booking/hotels/*/property-link", (route) => {
    const hotelId = bookingHotelIdFromPath(route.request().url());
    return route.fulfill({
      json: {
        hotelId,
        propertyId: hotelId === SECOND_HOTEL_ID ? SECOND_PROPERTY_ID : BOOKING_ADMIN_PROPERTY_ID,
        resourceLinks: {
          bookingHotel: true,
          pmsProperty: true,
          financeProperty: true,
        },
      },
    });
  });
  await page.route("**/api/booking/hotels/*/public-bookability", (route) => {
    const hotelId = bookingHotelIdFromPath(route.request().url());
    const propertyId = hotelId === SECOND_HOTEL_ID ? SECOND_PROPERTY_ID : BOOKING_ADMIN_PROPERTY_ID;
    const canonicalSlug = hotelId === SECOND_HOTEL_ID ? "bergwald" : "hotel-alpenrose";
    const bookingBaseUrl = `https://${canonicalSlug}.booking.localhost`;
    return route.fulfill({
      json: {
        propertyId,
        canonicalSlug,
        canonicalUrl: `${bookingBaseUrl}/en`,
        bookingBaseUrl,
        ...publication,
      },
    });
  });

  const patchedHotelIds: string[] = [];
  await page.route("**/api/booking/hotels/*/settings/property*", (route) => {
    const hotelId = bookingHotelIdFromPath(route.request().url());
    if (route.request().method() === "PATCH") {
      patchedHotelIds.push(hotelId);
      onPatch?.(route.request().postDataJSON() as Record<string, unknown>);
      booking.status = "active";
      booking.missingSteps = [];
      booking.statusReasons = [];
      status.nextAction = {
        action: "enter_product",
        propertyId: SECOND_PROPERTY_ID,
        product: "booking",
        returnTo: "/dashboard",
        reasonCodes: ["ready"],
      };
    }
    return route.fulfill({
      json: {
        ...defaultBookingAdminPropertySettings,
        id: hotelId,
        property_name: hotelId === SECOND_HOTEL_ID ? "Bergwald" : "Alpenrose",
        reservation_email: "reservations@example.com",
        phone_number: "+49 89 123456",
        whatsapp_number: "",
        address: "Bergweg 1",
        city: "Garmisch-Partenkirchen",
        country: "DE",
      },
    });
  });
  await page.route(`**/api/finance/properties/${SECOND_PROPERTY_ID}/payment-settings`, (route) =>
    route.fulfill({ json: { propertyId: SECOND_PROPERTY_ID } }),
  );

  return patchedHotelIds;
}

function bookingHotelIdFromPath(url: string): string {
  return decodeURIComponent(new URL(url).pathname.match(/\/hotels\/([^/]+)\//)?.[1] ?? "");
}
