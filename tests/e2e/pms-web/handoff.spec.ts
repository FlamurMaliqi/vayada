import { expect, test, type Page } from "@playwright/test";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { PMS_WEB_PROPERTY_ID, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";

const TARGET_ORGANIZATION_ID = "org_target_hotel_group";
const TARGET_WORKOS_ORGANIZATION_ID = "org_workos_target_hotel_group";
const OTHER_ORGANIZATION_ID = "org_other_hotel_group";
const OTHER_WORKOS_ORGANIZATION_ID = "org_workos_other_hotel_group";
const OTHER_PROPERTY_ID = "f6853000-0000-0000-0000-000000000002";

test.describe("pms-web handoff", () => {
  test("opens the dashboard with a saved-progress notice after exiting setup", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) => {
      const requestedPropertyId = new URL(route.request().url()).searchParams.get("propertyId");
      const setupStatus = createAdaptiveHotelSetupStatusMock({
        entryProduct: "pms",
        organizationId: TARGET_ORGANIZATION_ID,
        organizationDisplayName: "Target Hotel Group",
        propertyId: PMS_WEB_PROPERTY_ID,
        taskOverrides: {
          rooms_rates_availability: {
            ownerProgress: "in_progress",
            readiness: "actionable",
            actionableBy: "owner",
            reasonCodes: ["rooms_missing"],
          },
        },
      });
      return route.fulfill({
        json: {
          ...setupStatus,
          propertySelection: {
            state: "multiple_properties",
            selectedPropertyId: requestedPropertyId ?? PMS_WEB_PROPERTY_ID,
            availableProperties: [
              ...setupStatus.propertySelection.availableProperties,
              {
                propertyId: OTHER_PROPERTY_ID,
                publicId: `public-${OTHER_PROPERTY_ID}`,
                displayName: "Other Hotel",
                locationSummary: "Vienna, AT",
              },
            ],
          },
        },
      });
    });

    await page.goto(
      `/handoff?redirect=${encodeURIComponent(`/dashboard?setup=incomplete&propertyId=${PMS_WEB_PROPERTY_ID}`)}#property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(
      new RegExp(`/dashboard\\?setup=incomplete&propertyId=${PMS_WEB_PROPERTY_ID}$`),
    );
    await expect(
      page.getByText("Your property setup isn't complete. Your progress is saved."),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Resume setup" })).toHaveAttribute(
      "href",
      `/setup?entryProduct=pms&returnTo=%2Fdashboard&propertyId=${PMS_WEB_PROPERTY_ID}`,
    );
  });

  test("opens the property picker when setup is exited before a property exists", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({
        json: createAdaptiveHotelSetupStatusMock({
          entryProduct: "pms",
          organizationId: TARGET_ORGANIZATION_ID,
          organizationDisplayName: "Target Hotel Group",
          propertyId: null,
        }),
      }),
    );

    await page.goto(`/handoff?redirect=${encodeURIComponent("/choose-property?setup=incomplete")}`);

    await expect(page).toHaveURL(/\/choose-property\?setup=incomplete$/);
    await expect(
      page.getByText("No property has been created yet. Start or resume setup when you're ready."),
    ).toBeVisible();
  });

  test("keeps a setup exit in PMS when the property list is temporarily unavailable", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({ status: 503, json: { detail: "Temporarily unavailable" } }),
    );

    await page.goto(
      `/handoff?redirect=${encodeURIComponent(`/dashboard?setup=incomplete&propertyId=${PMS_WEB_PROPERTY_ID}`)}#property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/handoff\?redirect=/);
    await expect(page.getByText("Your session transfer is temporarily unavailable.")).toBeVisible();
  });

  test("does not substitute another property for an invalid setup-exit property", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({
        json: createAdaptiveHotelSetupStatusMock({
          entryProduct: "pms",
          organizationId: TARGET_ORGANIZATION_ID,
          organizationDisplayName: "Target Hotel Group",
          propertyId: OTHER_PROPERTY_ID,
        }),
      }),
    );

    await page.goto(
      `/handoff?redirect=${encodeURIComponent(`/dashboard?setup=incomplete&propertyId=${PMS_WEB_PROPERTY_ID}`)}#property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/handoff\?redirect=/);
    await expect(
      page.getByText(
        "The property you were setting up is no longer available in this hotel group.",
      ),
    ).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("selectedSharedPropertyId"))).toBeNull();
  });

  test("rejects conflicting setup-exit and session-transfer property hints", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    await page.addInitScript((propertyId) => {
      localStorage.setItem("selectedHotelId", propertyId);
      localStorage.setItem("selectedSharedPropertyId", propertyId);
    }, OTHER_PROPERTY_ID);

    await page.goto(
      `/handoff?redirect=${encodeURIComponent(`/dashboard?setup=incomplete&propertyId=${PMS_WEB_PROPERTY_ID}`)}#property_id=${OTHER_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/handoff\?redirect=/);
    await expect(
      page.getByText("The setup exit does not match the property from your session transfer."),
    ).toBeVisible();
    expect(
      await page.evaluate(() => [
        localStorage.getItem("selectedHotelId"),
        localStorage.getItem("selectedSharedPropertyId"),
      ]),
    ).toEqual([null, null]);
  });

  test("rejects a property hint for a no-property setup exit", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);

    await page.goto(
      `/handoff?redirect=${encodeURIComponent("/choose-property?setup=incomplete")}#property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/handoff\?redirect=/);
    await expect(
      page.getByText("The setup exit does not match the property from your session transfer."),
    ).toBeVisible();
    expect(
      await page.evaluate(() => [
        localStorage.getItem("selectedHotelId"),
        localStorage.getItem("selectedSharedPropertyId"),
      ]),
    ).toEqual([null, null]);
  });

  test("selects the hinted organization and opens PMS for incomplete setup", async ({ page }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({ json: pmsSetupStatus(PMS_WEB_PROPERTY_ID, "selected_incomplete") }),
    );
    const refreshRequests = await mockOrganizationSelection(page, PMS_WEB_PROPERTY_ID);

    await page.goto(
      `/handoff#organization_id=${TARGET_ORGANIZATION_ID}&property_id=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect(page).toHaveURL(/\/dashboard$/);
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
      const selectedPropertyId = requestedPropertyId ?? PMS_WEB_PROPERTY_ID;
      const status = selectedPropertyId === PMS_WEB_PROPERTY_ID ? targetStatus : firstStatus;
      return route.fulfill({
        json: {
          ...status,
          propertySelection: {
            state: "multiple_properties",
            selectedPropertyId,
            availableProperties: [
              ...firstStatus.propertySelection.availableProperties,
              ...targetStatus.propertySelection.availableProperties,
            ],
          },
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
  return createAdaptiveHotelSetupStatusMock({
    entryProduct: "pms",
    organizationId: TARGET_ORGANIZATION_ID,
    organizationDisplayName: "Target Hotel Group",
    propertyId,
    publicId: `public-${propertyId}`,
    propertyDisplayName: "Target Hotel",
    locationSummary: "Munich, DE",
    taskOverrides:
      status === "selected_incomplete"
        ? {
            rooms_rates_availability: {
              ownerProgress: "in_progress",
              readiness: "actionable",
              actionableBy: "owner",
              reasonCodes: ["rooms_missing"],
            },
          }
        : undefined,
  });
}
