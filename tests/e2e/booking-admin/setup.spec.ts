import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  defaultBookingAdminPropertySettings,
  mockBookingAdminAuthenticatedSession,
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

test.describe("booking-admin shared setup", () => {
  test("honors a setup-intent handoff and opens the Booking Admin wizard", async ({ page }) => {
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

  test("keeps the captured activation hotel when another tab changes local storage", async ({
    page,
  }) => {
    const patchedHotelIds = await mockMultiHotelActivation(page);
    await page.goto(`/setup?legacy=booking&propertyId=${SECOND_PROPERTY_ID}`);
    await expect(page.getByRole("heading", { name: "Your Property" })).toBeVisible();

    await page.evaluate(
      (hotelId) => localStorage.setItem("selectedHotelId", hotelId),
      BOOKING_ADMIN_HOTEL_ID,
    );
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Skip for Now/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: /Launch Property/ }).click();

    await expect.poll(() => patchedHotelIds).toEqual([SECOND_HOTEL_ID]);
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

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});

async function mockMultiHotelActivation(
  page: Page,
  activationStatus: "active" | "selected_incomplete" = "selected_incomplete",
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

  const patchedHotelIds: string[] = [];
  await page.route("**/api/booking/hotels/*/settings/property*", (route) => {
    const hotelId = bookingHotelIdFromPath(route.request().url());
    if (route.request().method() === "PATCH") patchedHotelIds.push(hotelId);
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
