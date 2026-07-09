import { expect, test, type Page } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

test.describe("marketplace-web smoke", () => {
  test("login page renders the custom auth form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
  });

  test("@signup unified signup renders the custom form", async ({ page }) => {
    await page.goto("/signup");

    await expect(page.getByRole("heading", { name: /create your vayada account/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.getByText(/hotel \/ property/i)).toHaveCount(0);
    await expect(page.getByText(/^creator$/i)).toHaveCount(0);
  });

  test("hotel onboarding allows multiple product selections", async ({ page }) => {
    await primeBrowserState(page);
    await mockOnboardingAuth(page);
    await mockSharedSetupStatus(page);

    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "Welcome to Vayada" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Which products do you want to use?" }),
    ).toBeVisible();
    await page.getByText("PMS", { exact: true }).click();
    await page.getByText("Booking Admin", { exact: true }).click();

    await expect(page.locator('input[value="marketplace"]')).toBeChecked();
    await expect(page.locator('input[value="pms"]')).toBeChecked();
    await expect(page.locator('input[value="booking"]')).toBeChecked();

    await page
      .getByRole("button", { name: "Continue with Creator Marketplace, PMS, Booking Admin" })
      .click();

    await expect(page).toHaveURL(/\/setup\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("entryProduct")).toBe("marketplace");
    expect(url.searchParams.getAll("selectedProducts")).toEqual(["marketplace", "pms", "booking"]);
  });
});

async function primeBrowserState(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  });
}

async function mockOnboardingAuth(page: Page) {
  const guestSession = {
    accessToken: "test-access-token",
    csrfToken: "test-csrf-token",
    user: {
      id: "user-pending-onboarding",
      email: "owner@example.test",
      status: "active",
    },
  };
  const hotelSession = {
    ...guestSession,
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationKind: "hotel_group",
  };

  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: guestSession });
  });
  await page.route(/\/auth\/onboarding$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: hotelSession });
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

async function mockSharedSetupStatus(page: Page) {
  await page.route(/\/api\/hotel-setup\/status/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        contractVersion: "shared-hotel-setup-status.v1",
        entry: { entryProduct: "marketplace", returnTo: null },
        hotelGroup: {
          organizationId: "11111111-1111-4111-8111-111111111111",
          displayName: "Test Hotel Group",
        },
        selection: { state: "no_property", selectedPropertyId: null },
        properties: [],
        nextAction: { action: "create_property", reasonCodes: ["no_property"] },
        updatedAt: "2026-07-08T00:00:00.000Z",
      },
    });
  });
}
