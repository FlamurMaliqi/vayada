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

  test("hotel onboarding saves shared personal details before shared setup", async ({ page }) => {
    await primeBrowserState(page);
    await mockOnboardingAuth(page);
    await mockSharedSetupStatus(page);

    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { name: "Thank you for signing up to Vayada" }),
    ).toBeVisible();
    await expect(
      page.getByText("Let's set up your profile in a little more detail."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);

    await expect(page.getByRole("heading", { name: "Welcome to Vayada" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /manage a hotel/i })).toBeVisible();
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();

    await expect(page.getByRole("heading", { name: "Tell us about you" })).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveValue("owner@example.test");
    await expect(page.getByLabel("Phone number")).toHaveValue("+49 89 123456");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await expect(page.getByText("Enter your first name.")).toBeVisible();
    await expect(page.getByText("Enter your last name.")).toBeVisible();
    await page.getByLabel("First name").fill("Mary Jane");
    await page.getByLabel("Last name").fill("Watson");
    await page.getByLabel("Phone number").clear();
    await page.getByLabel("Profile photo file").setInputFiles({
      name: "ada.png",
      mimeType: "image/png",
      buffer: Buffer.from("profile-image"),
    });
    await expect(page.getByRole("img", { name: "Selected profile preview" })).toBeVisible();
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(page).toHaveURL(/\/setup\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("entryProduct")).toBe("marketplace");
    expect(url.searchParams.has("selectedProducts")).toBe(false);
    await expect(page.getByRole("heading", { name: "Let’s get to know your hotel" })).toBeVisible();
    await expect(page.getByLabel("Hotel name")).toBeVisible();
    await expect(page.getByText("We'd like to get to know you better")).toHaveCount(0);
    await expect(page.getByText("Which systems do you want to use?")).toHaveCount(0);
  });

  test("redirects to login and blocks onboarding actions when the session check fails", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 503,
        headers: corsHeaders(route),
        json: { error: "session_unavailable" },
      });
    });

    await page.goto("/onboarding");

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue to hotel setup" })).toHaveCount(0);
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
  let onboarded = false;
  let accountName: string | null = null;
  let accountPhone: string | null = "+49 89 123456";
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
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        ...(onboarded ? hotelSession : guestSession),
        user: {
          ...(onboarded ? hotelSession.user : guestSession.user),
          name: accountName,
          phone: accountPhone,
        },
      },
    });
  });
  await page.route(/\/auth\/onboarding$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    onboarded = true;
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        ...hotelSession,
        user: { ...hotelSession.user, name: accountName, phone: accountPhone },
      },
    });
  });
  await page.route(/\/auth\/profile$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    const payload = route.request().postDataJSON() as {
      firstName?: string;
      lastName?: string;
      phone?: string;
      profilePictureUrl?: string;
      profilePictureMediaObjectId?: string;
    };
    expect(payload).toMatchObject({
      firstName: "Mary Jane",
      lastName: "Watson",
      phone: "",
      profilePictureUrl: "https://media.example/profile.png",
      profilePictureMediaObjectId: "media-profile-e2e",
    });
    accountName =
      payload.firstName && payload.lastName ? `${payload.firstName} ${payload.lastName}` : null;
    accountPhone = payload.phone?.trim() || null;
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: { updated: true } });
  });
  await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    if (route.request().url().endsWith("/finalize")) {
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          mediaObjects: [
            {
              mediaId: "media-profile-e2e",
              storageKey: "staging/profile-e2e/ada.png",
              variants: [{ publicCdnUrl: "https://media.example/profile.png" }],
            },
          ],
        },
      });
      return;
    }
    expect(route.request().postDataJSON()).toMatchObject({
      purpose: "identity.user.profile_image",
      resource: {
        product: "platform",
        resourceType: "user_profile",
        resourceId: "user-pending-onboarding",
      },
    });
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        uploadSession: { sessionId: "profile-e2e" },
        uploadTargets: [
          {
            uploadTargetId: "profile-target-e2e",
            method: "PUT",
            uploadUrl: "https://uploads.vayada.localhost/profile-e2e",
            headers: {},
          },
        ],
      },
    });
  });
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
