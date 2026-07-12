import { expect, test, type Page } from "@playwright/test";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";
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

  test("public properties render canonical collaboration offers", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(
      page,
      testInfo,
      "marketplace-web-offer-discovery",
    );

    await primeBrowserState(page);
    await mockCookieConsent(page);
    await routeJson(page, /\/api\/marketplace\/offers(?:\?|$)/, {
      items: [
        {
          offerId: "offer-target-1",
          offerPublicId: "offer-alpine-stay",
          offerTitle: "Alpine creator stay",
          offerSummary: "Create a winter city guide for our hotel.",
          hotelName: "Marketplace Alpenrose",
          hotelSlug: "marketplace-alpenrose",
          hotelAccommodationType: "hotel",
          hotelLocation: { displayText: "Innsbruck, Austria", countryCode: "AT" },
          hotelCoverImageUrl: null,
          hotelImageUrls: [],
          deliverables: [
            {
              deliverableId: "deliverable-1",
              platform: "instagram",
              deliverableType: "reel",
              quantity: 1,
              timingGuidance: "Within seven days of departure",
            },
          ],
          compensationOptions: [
            {
              compensationOptionId: "compensation-1",
              compensationType: "free_stay",
              availabilityMonths: ["January", "February"],
              platforms: ["instagram"],
              freeStayMinNights: 2,
              freeStayMaxNights: 3,
              paidMaxAmount: null,
              currency: null,
              discountPercentage: null,
              commissionPercentage: null,
              minFollowers: null,
              termsSummary: null,
            },
          ],
          creatorRequirements: {
            platforms: ["instagram"],
            targetCountries: ["AT", "DE"],
            targetAgeMin: null,
            targetAgeMax: null,
            targetAgeGroups: null,
            creatorTypes: ["travel"],
          },
          createdAt: "2026-07-01T10:00:00.000Z",
          projectedAt: "2026-07-01T10:00:00.000Z",
        },
      ],
      pagination: { limit: 200, offset: 0, total: 1 },
    });

    await page.goto("/properties");

    await expect(page.getByText("Alpine creator stay", { exact: true })).toBeVisible();
    await expect(page.getByText("Innsbruck, Austria", { exact: true })).toBeVisible();
    await expect(page.getByText("Free stay", { exact: true })).toBeVisible();
    await expect(page.getByText("Open Offers", { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText("Alpine creator stay", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await assertNoLegacyCalls();
    await assertHealthy();
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

  await routeJson(page, /\/auth\/session(?:\?|$)/, guestSession);
  await routeJson(page, /\/auth\/onboarding$/, hotelSession);
  await routeJson(page, /\/auth\/compat\/marketplace-web-token/, {
    accessToken: "legacy-marketplace-token",
    expiresIn: 900,
  });
}

async function mockSharedSetupStatus(page: Page) {
  await routeJson(page, /\/api\/hotel-setup\/status/, {
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
  });
}

async function mockCookieConsent(page: Page) {
  await routeJson(page, /\/api\/identity\/consent\/cookies(?:\?|$)/, {
    id: "consent-e2e",
    visitor_id: "visitor-e2e",
    user_id: null,
    necessary: true,
    functional: true,
    analytics: false,
    marketing: false,
    created_at: "2026-07-01T10:00:00.000Z",
    updated_at: "2026-07-01T10:00:00.000Z",
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
