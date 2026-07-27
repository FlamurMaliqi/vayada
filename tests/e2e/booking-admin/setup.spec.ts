import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  defaultBookingAdminDesignSettings,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";

const TASK_DESTINATIONS = [
  {
    code: "L".repeat(43),
    taskId: "guest_settings_policies",
    destinationRouteKey: "booking.guest_settings_policies",
    pathname: "/settings",
    activeSection: "Booking",
  },
  {
    code: "M".repeat(43),
    taskId: "payment",
    destinationRouteKey: "finance.payment",
    pathname: "/settings",
    activeSection: "Payments",
  },
  {
    code: "N".repeat(43),
    taskId: "direct_booking_publication",
    destinationRouteKey: "distribution.direct_booking_publication",
    pathname: "/design-studio",
    activeSection: null,
  },
] as const;

const PMS_TASK_CODE = "K".repeat(43);
const USED_CODE = "O".repeat(43);

test.describe("booking-admin adaptive setup", () => {
  test("uses the shared hotel personal-account step when the saved photo is missing", async ({
    page,
  }) => {
    await page.route("**/auth/session?surface=booking-admin", (route) =>
      route.fulfill({
        json: bookingAuthSession({
          profilePictureUrl: null,
          profilePictureMediaObjectId: null,
        }),
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
  });

  test("creates an opaque single-use handoff for the recommended task", async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, "Playwright base URL is required.");
    await page.route("**/auth/session?surface=booking-admin", (route) =>
      route.fulfill({ json: bookingAuthSession() }),
    );
    await mockBookingAdminShellRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({
        json: actionableStatus("pms", "rooms_rates_availability"),
      }),
    );

    const requests: Array<Record<string, unknown>> = [];
    await page.route("**/api/hotel-setup/handoffs", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders() });
        return;
      }
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        headers: corsHeaders(),
        json: {
          launchUrl: new URL(`/handoff?code=${PMS_TASK_CODE}`, baseURL).toString(),
          expiresAt: "2026-07-26T20:00:00.000Z",
        },
      });
    });
    await page.route(`**/handoff?code=${PMS_TASK_CODE}`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Handoff</title>" }),
    );

    await page.goto(`/setup?entryProduct=pms&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`);
    await page.getByRole("button", { name: "Continue recommended step" }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("code")).toBe(PMS_TASK_CODE);

    expect(requests).toEqual([
      {
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        taskId: "rooms_rates_availability",
        planRevision: "e2e-plan-1",
      },
    ]);
    const launchUrl = new URL(page.url());
    expect([...launchUrl.searchParams.keys()]).toEqual(["code"]);
    expect(launchUrl.hash).toBe("");
  });

  for (const destination of TASK_DESTINATIONS) {
    test(`exchanges an opaque code and opens ${destination.taskId}`, async ({ page }) => {
      await mockBookingAdminAuthenticatedSession(page);
      await page.route("**/auth/session?surface=booking-admin", (route) =>
        route.fulfill({ json: bookingAuthSession() }),
      );
      await mockBookingAdminShellRoutes(page);
      await mockFinancePaymentSettings(page);

      const exchangeRequests: Array<Record<string, unknown>> = [];
      await page.route("**/api/hotel-setup/handoffs/exchange", async (route) => {
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers: corsHeaders() });
          return;
        }
        exchangeRequests.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({
          headers: corsHeaders(),
          json: {
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            taskId: destination.taskId,
            issuedPlanRevision: "e2e-plan-1",
            destinationRouteKey: destination.destinationRouteKey,
            returnUrl: marketplaceSetupReturnUrl(),
          },
        });
      });

      await page.goto(`/handoff?code=${destination.code}`);

      await expect.poll(() => new URL(page.url()).pathname).toBe(destination.pathname);
      const taskUrl = new URL(page.url());
      expect(taskUrl.searchParams.get("taskId")).toBe(destination.taskId);
      expect(taskUrl.searchParams.get("destinationRouteKey")).toBe(destination.destinationRouteKey);
      expect(taskUrl.searchParams.get("planRevision")).toBe("e2e-plan-1");
      expect(taskUrl.searchParams.get("returnUrl")).toBe(marketplaceSetupReturnUrl());
      expect(taskUrl.searchParams.has("propertyId")).toBe(false);
      expect(exchangeRequests).toEqual([{ code: destination.code }]);
      expect(await page.evaluate(() => localStorage.getItem("selectedSharedPropertyId"))).toBe(
        BOOKING_ADMIN_PROPERTY_ID,
      );
      expect(await page.evaluate(() => localStorage.getItem("selectedHotelId"))).toBe(
        BOOKING_ADMIN_HOTEL_ID,
      );

      if (destination.activeSection) {
        await expect(
          page.getByRole("button", { name: destination.activeSection, exact: true }).first(),
        ).toHaveAttribute("aria-current", "page");
      } else {
        await expect(page.getByRole("heading", { name: "Design Studio" })).toBeVisible();
      }
    });
  }

  test("rejects a reused or expired handoff without exposing task context", async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await page.route("**/auth/session?surface=booking-admin", (route) =>
      route.fulfill({ json: bookingAuthSession() }),
    );
    await page.route("**/api/hotel-setup/handoffs/exchange", (route) =>
      route.request().method() === "OPTIONS"
        ? route.fulfill({ status: 204, headers: corsHeaders() })
        : route.fulfill({
            status: 410,
            headers: corsHeaders(),
            json: {
              code: "invalid_handoff",
            },
          }),
    );

    await page.goto(`/handoff?code=${USED_CODE}`);

    await expect(page.getByRole("heading", { name: "Setup link unavailable" })).toBeVisible();
    await expect(
      page.getByText("This setup link is invalid, expired, or has already been used."),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.toString()).toBe(`code=${USED_CODE}`);
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
});

function actionableStatus(
  entryProduct: "booking" | "marketplace" | "pms",
  taskId:
    | "rooms_rates_availability"
    | "guest_settings_policies"
    | "payment"
    | "direct_booking_publication",
) {
  return createAdaptiveHotelSetupStatusMock({
    entryProduct,
    organizationId: "org_hotel_group",
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks: ["hotel_operations"],
    propertyId: BOOKING_ADMIN_PROPERTY_ID,
    publicId: "prop_alpenrose",
    propertyDisplayName: "Alpenrose",
    locationSummary: "Munich, DE",
    taskOverrides: {
      [taskId]: {
        ownerProgress: "not_started",
        readiness: "actionable",
        actionableBy: "owner",
        reasonCodes: [`${taskId}_required`],
      },
    },
    recommendedTaskId: taskId,
    entryDecision: {
      propertyId: BOOKING_ADMIN_PROPERTY_ID,
      decision: "enter",
      destinationRouteKey: `${entryProduct}.workspace`,
      reasonCode: null,
    },
  });
}

function bookingAuthSession(
  overrides: {
    profilePictureUrl?: string | null;
    profilePictureMediaObjectId?: string | null;
  } = {},
) {
  return {
    accessToken: "e2e-booking-authkit-token",
    csrfToken: "e2e-booking-csrf-token",
    organizationId: "org_hotel_group",
    workosOrganizationId: "org_workos_hotel_group",
    resources: { "booking:booking_hotel": [BOOKING_ADMIN_HOTEL_ID] },
    user: {
      id: "user_booking_owner",
      email: "owner@example.com",
      name: "Booking Owner",
      phone: "+49 89 123456",
      profilePictureUrl:
        overrides.profilePictureUrl === undefined
          ? "https://media.example/booking-owner.webp"
          : overrides.profilePictureUrl,
      profilePictureMediaObjectId:
        overrides.profilePictureMediaObjectId === undefined
          ? "media-booking-owner"
          : overrides.profilePictureMediaObjectId,
      status: "active",
    },
  };
}

async function mockFinancePaymentSettings(page: Page) {
  await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
    route.fulfill({
      json: {
        contractVersion: "finance-route-contracts.v1",
        propertyId: BOOKING_ADMIN_PROPERTY_ID,
        paymentSettings: {
          paymentsEnabled: false,
          paymentProvider: "vayada",
          acceptedMethods: [],
          defaultCurrency: "EUR",
          supportedCurrencies: ["EUR"],
          requiresManualReview: false,
          providerAccount: {
            providerAccountId: null,
            provider: null,
            status: "not_configured",
            onboardingStatus: "not_started",
            chargesEnabled: false,
            payoutsEnabled: false,
            capabilities: [],
          },
        },
      },
    }),
  );
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  };
}

function marketplaceSetupReturnUrl(): string {
  const origin =
    process.env.E2E_MARKETPLACE_BASE_URL ||
    (process.env.E2E_START_SERVERS === "1"
      ? "http://marketplace.localhost:3000"
      : "https://marketplace.localhost");
  const url = new URL("/setup", origin);
  url.searchParams.set("propertyId", BOOKING_ADMIN_PROPERTY_ID);
  return url.toString();
}
