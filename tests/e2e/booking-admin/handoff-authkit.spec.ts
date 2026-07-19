import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_ORGANIZATION_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import {
  createSharedHotelSetupStatusMock,
  sharedHotelSetupProduct,
} from "../support/sharedHotelSetupMocks";

const TARGET_WORKOS_ORGANIZATION_ID = "org_workos_hotel_group";
const OTHER_ORGANIZATION_ID = "org_other_hotel_group";
const OTHER_WORKOS_ORGANIZATION_ID = "org_workos_other_hotel_group";
const OTHER_HOTEL_ID = "booking_hotel_bergwald";
const OTHER_PROPERTY_ID = "f6853000-0000-0000-0000-000000000002";

test.describe("booking-admin AuthKit handoff", () => {
  test("selects the organization hinted by the handoff and keeps the property context", async ({
    page,
  }) => {
    await mockBookingAdminShellRoutes(page);
    const refreshRequests = await mockOrganizationSelection(page);

    await page.goto(
      `/handoff#organization_id=${BOOKING_ADMIN_ORGANIZATION_ID}&workos_organization_id=${TARGET_WORKOS_ORGANIZATION_ID}&property_id=${BOOKING_ADMIN_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/dashboard$/);
    expect(refreshRequests).toEqual([
      { organizationId: TARGET_WORKOS_ORGANIZATION_ID, surface: "booking-admin" },
    ]);
    expect(
      await page.evaluate(() => ({
        propertyId: localStorage.getItem("selectedSharedPropertyId"),
        hotelId: localStorage.getItem("selectedHotelId"),
      })),
    ).toEqual({ propertyId: BOOKING_ADMIN_PROPERTY_ID, hotelId: BOOKING_ADMIN_HOTEL_ID });
  });

  test("switches a normal session that belongs to the wrong organization", async ({ page }) => {
    await mockBookingAdminShellRoutes(page);
    const refreshRequests: unknown[] = [];
    await page.route("**/auth/session/refresh", (route) => {
      refreshRequests.push(route.request().postDataJSON());
      return route.fulfill({ json: authenticatedSession() });
    });
    await page.route("**/auth/session?surface=booking-admin", (route) =>
      route.fulfill({
        json: authenticatedSession(
          OTHER_HOTEL_ID,
          OTHER_ORGANIZATION_ID,
          OTHER_WORKOS_ORGANIZATION_ID,
        ),
      }),
    );

    await page.goto(
      `/handoff#organization_id=${BOOKING_ADMIN_ORGANIZATION_ID}&workos_organization_id=${TARGET_WORKOS_ORGANIZATION_ID}&property_id=${BOOKING_ADMIN_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/dashboard$/);
    expect(refreshRequests).toEqual([
      { organizationId: TARGET_WORKOS_ORGANIZATION_ID, surface: "booking-admin" },
    ]);
    expect(
      await page.evaluate(() => ({
        propertyId: localStorage.getItem("selectedSharedPropertyId"),
        hotelId: localStorage.getItem("selectedHotelId"),
      })),
    ).toEqual({ propertyId: BOOKING_ADMIN_PROPERTY_ID, hotelId: BOOKING_ADMIN_HOTEL_ID });
  });

  test("shows a terminal error when a wrong-org session lacks the WorkOS hint", async ({
    page,
  }) => {
    await page.route("**/auth/session?surface=booking-admin", (route) =>
      route.fulfill({
        json: authenticatedSession(
          OTHER_HOTEL_ID,
          OTHER_ORGANIZATION_ID,
          OTHER_WORKOS_ORGANIZATION_ID,
        ),
      }),
    );
    await page.goto(
      `/handoff#organization_id=${BOOKING_ADMIN_ORGANIZATION_ID}&property_id=${BOOKING_ADMIN_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/login\?auth_error=/);
    const loginUrl = new URL(page.url());
    expect(loginUrl.searchParams.has("auth")).toBe(false);
    expect(loginUrl.searchParams.has("returnTo")).toBe(false);
    await expect(page.getByRole("heading", { name: "Sign in to vayada" })).toBeVisible();
    await expect(
      page.getByText(
        "This handoff is missing hotel-group context. Return to the previous app and try again.",
      ),
    ).toBeVisible();
  });

  test("preserves the exact handoff when credential sign-in is required", async ({ page }) => {
    await page.route("**/auth/session?surface=booking-admin", (route) =>
      route.fulfill({ status: 401, json: { error: "missing_session" } }),
    );
    const redirect = "/setup?mode=add";
    const query = new URLSearchParams({ redirect }).toString();
    const hash = new URLSearchParams({
      organization_id: BOOKING_ADMIN_ORGANIZATION_ID,
      workos_organization_id: TARGET_WORKOS_ORGANIZATION_ID,
      property_id: BOOKING_ADMIN_PROPERTY_ID,
      hotel_id: BOOKING_ADMIN_HOTEL_ID,
    }).toString();
    const returnTo = `/handoff?${query}#${hash}`;

    await page.goto(returnTo);

    await expect(page).toHaveURL(/\/login\?auth=callback/);
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(returnTo);
    await expect(page.getByRole("heading", { name: "Sign in to vayada" })).toBeVisible();
    await expect(page.getByLabel("Email address")).toBeVisible();
  });

  test("uses the existing organization selector and preserves the handoff when no candidate matches", async ({
    page,
  }) => {
    await mockBookingAdminShellRoutes(page);
    const refreshRequests = await mockOrganizationSelection(page);
    const hash = new URLSearchParams({
      organization_id: "org_not_available",
      property_id: BOOKING_ADMIN_PROPERTY_ID,
      hotel_id: BOOKING_ADMIN_HOTEL_ID,
    }).toString();
    const returnTo = `/handoff#${hash}`;

    await page.goto(returnTo);

    await expect(page).toHaveURL(/\/login\?auth=callback/);
    await expect(page.getByRole("heading", { name: "Choose hotel group" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(returnTo);
    expect(refreshRequests).toEqual([]);

    await page.getByRole("button", { name: "Alpenrose Hotel Group" }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    expect(refreshRequests).toEqual([
      { organizationId: TARGET_WORKOS_ORGANIZATION_ID, surface: "booking-admin" },
    ]);
    expect(
      await page.evaluate(() => ({
        propertyId: localStorage.getItem("selectedSharedPropertyId"),
        hotelId: localStorage.getItem("selectedHotelId"),
      })),
    ).toEqual({ propertyId: BOOKING_ADMIN_PROPERTY_ID, hotelId: BOOKING_ADMIN_HOTEL_ID });
  });

  test("does not replace an inaccessible explicit property with another singleton", async ({
    page,
  }) => {
    await mockBookingAdminShellRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) => {
      const requestedPropertyId = new URL(route.request().url()).searchParams.get("propertyId");
      if (requestedPropertyId === BOOKING_ADMIN_PROPERTY_ID) {
        return route.fulfill({ status: 404, json: { detail: "Property not found" } });
      }
      return route.fulfill({ json: bookingStatus(OTHER_PROPERTY_ID) });
    });
    await page.route("**/api/booking/hotels/*/property-link", (route) =>
      route.fulfill({
        json: {
          hotelId: OTHER_HOTEL_ID,
          propertyId: OTHER_PROPERTY_ID,
          resourceLinks: { bookingHotel: true, pmsProperty: true, financeProperty: true },
        },
      }),
    );
    await mockOrganizationSelection(page, OTHER_HOTEL_ID);

    await page.goto(
      `/handoff#organization_id=${BOOKING_ADMIN_ORGANIZATION_ID}&property_id=${BOOKING_ADMIN_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(
      new RegExp(
        `/setup\\?entryProduct=booking&propertyId=${encodeURIComponent(BOOKING_ADMIN_PROPERTY_ID)}$`,
      ),
    );
    expect(
      await page.evaluate(() => ({
        propertyId: localStorage.getItem("selectedSharedPropertyId"),
        hotelId: localStorage.getItem("selectedHotelId"),
      })),
    ).toEqual({ propertyId: null, hotelId: null });
  });
});

async function mockOrganizationSelection(page: Page, hotelId = BOOKING_ADMIN_HOTEL_ID) {
  let selected = false;
  const refreshRequests: unknown[] = [];
  await page.route("**/auth/session/refresh", (route) => {
    selected = true;
    refreshRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: authenticatedSession(hotelId) });
  });
  await page.route("**/auth/session?surface=booking-admin", (route) =>
    route.fulfill({
      json: selected ? authenticatedSession(hotelId) : organizationSelectionResponse(),
    }),
  );
  return refreshRequests;
}

function organizationSelectionResponse() {
  return {
    organizationSelectionRequired: true,
    csrfToken: "e2e-booking-csrf-token",
    organizations: [
      {
        organizationId: OTHER_ORGANIZATION_ID,
        workosOrganizationId: OTHER_WORKOS_ORGANIZATION_ID,
        displayName: "Other Hotel Group",
        kind: "hotel_group",
      },
      {
        organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
        workosOrganizationId: TARGET_WORKOS_ORGANIZATION_ID,
        displayName: "Alpenrose Hotel Group",
        kind: "hotel_group",
      },
    ],
    user: sessionUser(),
  };
}

function authenticatedSession(
  hotelId = BOOKING_ADMIN_HOTEL_ID,
  organizationId = BOOKING_ADMIN_ORGANIZATION_ID,
  workosOrganizationId = TARGET_WORKOS_ORGANIZATION_ID,
) {
  return {
    accessToken: "e2e-booking-authkit-token",
    csrfToken: "e2e-booking-csrf-token",
    organizationId,
    workosOrganizationId,
    resources: { "booking:booking_hotel": [hotelId] },
    user: sessionUser(),
  };
}

function sessionUser() {
  return {
    id: "user_booking_owner",
    email: "owner@example.com",
    name: "Booking Owner",
    status: "active",
    workosUserId: "workos_user_booking_owner",
  };
}

function bookingStatus(propertyId: string) {
  return createSharedHotelSetupStatusMock({
    entryProduct: "booking",
    returnTo: "/dashboard",
    organizationId: BOOKING_ADMIN_ORGANIZATION_ID,
    organizationDisplayName: "Alpenrose Hotel Group",
    propertyId,
    publicId: `public-${propertyId}`,
    propertyDisplayName: "Bergwald",
    locationSummary: "Garmisch-Partenkirchen, DE",
    products: {
      booking: sharedHotelSetupProduct("booking", "active"),
      pms: sharedHotelSetupProduct("pms", "not_selected"),
      marketplace: sharedHotelSetupProduct("marketplace", "not_selected"),
    },
    nextAction: {
      action: "enter_product",
      propertyId,
      product: "booking",
      returnTo: "/dashboard",
      reasonCodes: ["ready"],
    },
  });
}
