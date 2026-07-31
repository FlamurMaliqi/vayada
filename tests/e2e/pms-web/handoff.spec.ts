import { expect, test, type Page } from "@playwright/test";
import {
  createSharedHotelSetupStatusMock,
  sharedHotelSetupProduct,
} from "../support/sharedHotelSetupMocks";
import { PMS_WEB_PROPERTY_ID, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";

const TARGET_ORGANIZATION_ID = "org_target_hotel_group";
const TARGET_WORKOS_ORGANIZATION_ID = "org_workos_target_hotel_group";
const OTHER_ORGANIZATION_ID = "org_other_hotel_group";
const OTHER_WORKOS_ORGANIZATION_ID = "org_workos_other_hotel_group";
const OTHER_PROPERTY_ID = "f6853000-0000-0000-0000-000000000002";

test.describe("pms-web handoff", () => {
  test("selects the hinted organization and opens Rooms for incomplete PMS setup", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({ json: pmsSetupStatus(PMS_WEB_PROPERTY_ID, "selected_incomplete") }),
    );
    const refreshRequests = await mockOrganizationSelection(page, PMS_WEB_PROPERTY_ID);

    await page.goto(
      `/handoff#organization_id=${TARGET_ORGANIZATION_ID}&property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/rooms$/);
    expect(refreshRequests).toEqual([
      { organizationId: TARGET_WORKOS_ORGANIZATION_ID, surface: "pms-web" },
    ]);
  });

  test("honors a WorkOS-only organization hint for a normal session", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    const refreshRequests: unknown[] = [];
    let selected = false;
    await page.route("**/auth/session/refresh", (route) => {
      selected = true;
      refreshRequests.push(route.request().postDataJSON());
      return route.fulfill({ json: authenticatedSession(PMS_WEB_PROPERTY_ID) });
    });
    await page.route("**/auth/session?surface=pms-web", (route) =>
      route.fulfill({
        json: selected
          ? authenticatedSession(PMS_WEB_PROPERTY_ID)
          : authenticatedSession(
              OTHER_PROPERTY_ID,
              OTHER_ORGANIZATION_ID,
              OTHER_WORKOS_ORGANIZATION_ID,
            ),
      }),
    );

    await page.goto(
      `/handoff#workos_organization_id=${TARGET_WORKOS_ORGANIZATION_ID}&property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/dashboard$/);
    expect(refreshRequests).toEqual([
      { organizationId: TARGET_WORKOS_ORGANIZATION_ID, surface: "pms-web" },
    ]);
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

  test("shows a terminal error when a wrong-org session lacks the WorkOS hint", async ({
    page,
  }) => {
    await page.route("**/auth/session?surface=pms-web", (route) =>
      route.fulfill({
        json: authenticatedSession(
          OTHER_PROPERTY_ID,
          OTHER_ORGANIZATION_ID,
          OTHER_WORKOS_ORGANIZATION_ID,
        ),
      }),
    );
    await page.goto(
      `/handoff#organization_id=${TARGET_ORGANIZATION_ID}&property_id=${PMS_WEB_PROPERTY_ID}`,
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

  test("shows the existing organization selector when the handoff is ambiguous", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    let refreshCount = 0;
    await page.route("**/auth/session/refresh", (route) => {
      refreshCount += 1;
      return route.fulfill({ json: authenticatedSession(PMS_WEB_PROPERTY_ID) });
    });
    await page.route("**/auth/session?surface=pms-web", (route) =>
      route.fulfill({ json: organizationSelectionResponse() }),
    );

    await page.goto(`/handoff#property_id=${PMS_WEB_PROPERTY_ID}`);

    await expect(page).toHaveURL(/\/login\?auth=callback/);
    await expect(page.getByRole("heading", { name: "Choose hotel group" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    expect(refreshCount).toBe(0);
  });

  test("resumes a hinted second property after AuthKit reauthentication", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    await page.addInitScript((propertyId) => {
      if (sessionStorage.getItem("seededPropertySelection")) return;
      localStorage.setItem("selectedHotelId", propertyId);
      localStorage.setItem("selectedSharedPropertyId", propertyId);
      sessionStorage.setItem("seededPropertySelection", "true");
    }, OTHER_PROPERTY_ID);

    const firstStatus = pmsSetupStatus(OTHER_PROPERTY_ID, "selected_incomplete");
    const targetStatus = pmsSetupStatus(PMS_WEB_PROPERTY_ID, "active");
    await page.route("**/api/hotel-setup/status**", (route) => {
      const requestedPropertyId = new URL(route.request().url()).searchParams.get("propertyId");
      const status = requestedPropertyId === PMS_WEB_PROPERTY_ID ? targetStatus : firstStatus;
      return route.fulfill({
        json: {
          ...status,
          selection: {
            state: "multiple_properties",
            selectedPropertyId: requestedPropertyId,
          },
          properties: [firstStatus.properties[0], targetStatus.properties[0]],
        },
      });
    });

    let sessionRequests = 0;
    await page.route("**/auth/session?surface=pms-web", (route) => {
      sessionRequests += 1;
      if (sessionRequests === 1) {
        return route.fulfill({ status: 401, json: { error: "session_expired" } });
      }
      return route.fulfill({
        json:
          sessionRequests === 2
            ? organizationSelectionResponse()
            : authenticatedSession([OTHER_PROPERTY_ID, PMS_WEB_PROPERTY_ID]),
      });
    });
    await page.route("**/auth/session/refresh", (route) =>
      route.fulfill({
        json: authenticatedSession([OTHER_PROPERTY_ID, PMS_WEB_PROPERTY_ID]),
      }),
    );

    await page.goto(
      `/handoff#organization_id=${TARGET_ORGANIZATION_ID}&workos_organization_id=${TARGET_WORKOS_ORGANIZATION_ID}&property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/login\?auth=callback/);
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
      `/handoff#organization_id=${TARGET_ORGANIZATION_ID}&workos_organization_id=${TARGET_WORKOS_ORGANIZATION_ID}&property_id=${PMS_WEB_PROPERTY_ID}`,
    );
    await page.getByRole("button", { name: "Target Hotel Group" }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    expect(sessionRequests).toBeGreaterThanOrEqual(3);
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

  test("does not replace an explicit requested property with another singleton", async ({
    page,
  }) => {
    await page.route("**/api/hotel-setup/status**", (route) => {
      const requestedPropertyId = new URL(route.request().url()).searchParams.get("propertyId");
      if (requestedPropertyId === PMS_WEB_PROPERTY_ID) {
        return route.fulfill({ status: 404, json: { detail: "Property not found" } });
      }
      return route.fulfill({ json: pmsSetupStatus(OTHER_PROPERTY_ID, "active") });
    });
    await mockOrganizationSelection(page, PMS_WEB_PROPERTY_ID);

    await page.goto(
      `/handoff#organization_id=${TARGET_ORGANIZATION_ID}&property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(
      new RegExp(
        `/setup\\?entryProduct=pms&propertyId=${encodeURIComponent(PMS_WEB_PROPERTY_ID)}$`,
      ),
    );
    const storedPropertyIds = await page.evaluate(() => [
      localStorage.getItem("selectedHotelId"),
      localStorage.getItem("selectedSharedPropertyId"),
    ]);
    expect(storedPropertyIds).not.toContain(OTHER_PROPERTY_ID);
  });

  test("preserves the requested property when the property list is temporarily unavailable", async ({
    page,
  }) => {
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({ status: 503, json: { detail: "Temporarily unavailable" } }),
    );
    await mockOrganizationSelection(page, PMS_WEB_PROPERTY_ID);

    await page.goto(
      `/handoff#organization_id=${TARGET_ORGANIZATION_ID}&property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(
      new RegExp(
        `/setup\\?entryProduct=pms&propertyId=${encodeURIComponent(PMS_WEB_PROPERTY_ID)}$`,
      ),
    );
  });
});

async function mockOrganizationSelection(page: Page, propertyId: string) {
  let selected = false;
  const refreshRequests: unknown[] = [];
  await page.route("**/auth/session/refresh", (route) => {
    selected = true;
    refreshRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: authenticatedSession(propertyId) });
  });
  await page.route("**/auth/session?surface=pms-web", (route) =>
    route.fulfill({
      json: selected ? authenticatedSession(propertyId) : organizationSelectionResponse(),
    }),
  );
  return refreshRequests;
}

function organizationSelectionResponse() {
  return {
    organizationSelectionRequired: true,
    csrfToken: "e2e-pms-csrf-token",
    organizations: [
      {
        organizationId: "org_other_hotel_group",
        workosOrganizationId: OTHER_WORKOS_ORGANIZATION_ID,
        displayName: "Other Hotel Group",
        kind: "hotel_group",
      },
      {
        organizationId: TARGET_ORGANIZATION_ID,
        workosOrganizationId: TARGET_WORKOS_ORGANIZATION_ID,
        displayName: "Target Hotel Group",
        kind: "hotel_group",
      },
    ],
    user: {
      id: "user_pms_owner",
      email: "owner@example.com",
      name: "PMS Owner",
      phone: "+49 89 123456",
      profilePictureUrl: "https://media.example/pms-owner.webp",
      profilePictureMediaObjectId: "media-pms-owner",
      status: "active",
      workosUserId: "workos_user_pms_owner",
    },
  };
}

function authenticatedSession(
  propertyId: string | string[],
  organizationId = TARGET_ORGANIZATION_ID,
  workosOrganizationId = TARGET_WORKOS_ORGANIZATION_ID,
) {
  return {
    accessToken: "e2e-pms-token",
    csrfToken: "e2e-pms-csrf-token",
    organizationId,
    workosOrganizationId,
    resources: {
      "pms:pms_property": Array.isArray(propertyId) ? propertyId : [propertyId],
    },
    user: {
      id: "user_pms_owner",
      email: "owner@example.com",
      name: "PMS Owner",
      phone: "+49 89 123456",
      profilePictureUrl: "https://media.example/pms-owner.webp",
      profilePictureMediaObjectId: "media-pms-owner",
      status: "active",
      workosUserId: "workos_user_pms_owner",
    },
  };
}

function pmsSetupStatus(propertyId: string, status: "active" | "selected_incomplete") {
  const missingSteps = status === "selected_incomplete" ? ["roomTypes", "rooms", "ratePlans"] : [];
  const result = createSharedHotelSetupStatusMock({
    entryProduct: "pms",
    returnTo: "/dashboard",
    organizationId: TARGET_ORGANIZATION_ID,
    organizationDisplayName: "Target Hotel Group",
    propertyId,
    publicId: `public-${propertyId}`,
    propertyDisplayName: "Target Hotel",
    locationSummary: "Munich, DE",
    products: {
      booking: sharedHotelSetupProduct("booking", "not_selected"),
      pms: {
        ...sharedHotelSetupProduct("pms", status),
        missingSteps,
        statusReasons: status === "active" ? [] : ["pms_activation_incomplete"],
      },
      marketplace: sharedHotelSetupProduct("marketplace", "not_selected"),
    },
    nextAction:
      status === "active"
        ? {
            action: "enter_product",
            propertyId,
            product: "pms",
            returnTo: "/dashboard",
            reasonCodes: ["ready"],
          }
        : {
            action: "complete_product_activation",
            propertyId,
            product: "pms",
            returnTo: "/dashboard",
            reasonCodes: ["entry_product_activation_incomplete"],
          },
  });
  return {
    ...result,
    hotelGroup: { ...result.hotelGroup, selectedProducts: ["pms"] },
  };
}
