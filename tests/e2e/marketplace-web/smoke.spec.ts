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
    await expect(page.getByRole("heading", { name: "Thank you for signing up" })).toBeVisible();
    await expect(
      page.getByText("Welcome to Vayada — we’re glad you’re here. Let’s get you set up."),
    ).toBeVisible();
    await expect(page.getByText("Your account is ready")).toBeVisible();
    await expect(
      page.getByText("We’ll start with your profile and guide you through the rest."),
    ).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    // Guard the user-controlled welcome against the former 1.8-second auto-advance.
    await page.waitForTimeout(2_000);
    await expect(page.getByRole("heading", { name: "Thank you for signing up" })).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await page.getByRole("button", { name: "Let’s get you set up" }).click();

    await expect(page.getByRole("heading", { name: "Which best describes you?" })).toBeVisible();
    await expect(page.getByText("Choose your role so we can tailor your setup.")).toBeVisible();
    const continueButton = page.getByRole("button", { name: "Continue", exact: true });
    await expect(continueButton).toBeDisabled();
    await page.getByRole("radio", { name: /i manage a hotel/i }).click();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    const profileHeading = page.getByRole("heading", { name: "Let’s create your profile" });
    await expect(profileHeading).toBeVisible();
    await expect(profileHeading).toBeFocused();
    await expect(
      page.getByText("Start with your details. Next, we’ll set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByLabel("Email address")).toHaveValue("owner@example.test");
    await expect(page.getByLabel("Phone number")).toHaveValue("+49 89 123456");
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
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
    await expect(page.getByRole("button", { name: "Remove photo" })).toBeVisible();
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();

    await expect(page).toHaveURL(/\/setup\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("entryProduct")).toBe("marketplace");
    expect(url.searchParams.has("selectedProducts")).toBe(false);
    await expect(page.getByRole("heading", { name: "Let’s get to know your hotel" })).toBeVisible();
    await expect(page.getByLabel("Hotel name")).toBeVisible();
    await expect(page.getByText("We'd like to get to know you better")).toHaveCount(0);
    await expect(page.getByText("Which systems do you want to use?")).toHaveCount(0);
  });

  test("creator onboarding reuses account details and keeps the profile photo optional", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 830 });
    await primeBrowserState(page);
    await mockOnboardingAuth(page, "creator", "Mary");
    let creatorProfile = {
      creatorProfileId: "creator-profile-e2e",
      displayName: null as string | null,
      creatorType: "lifestyle",
      locationText: null,
      shortDescription: null,
      portfolioUrl: null,
      phone: null as string | null,
      profilePictureUrl: null as string | null,
      profileComplete: false,
      profileStatus: "pending",
      platforms: [],
      audienceSize: 0,
      rating: { averageRating: 0, totalReviews: 0 },
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    };
    await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") {
        const payload = route.request().postDataJSON() as {
          displayName?: string;
          phone?: string;
          profilePictureUrl?: string;
          profilePictureMediaObjectId?: string;
        };
        expect(payload).toEqual({
          displayName: "Mary Watson",
          phone: "+49 89 123456",
          profilePictureMediaObjectId: "media-profile-e2e",
        });
        creatorProfile = {
          ...creatorProfile,
          displayName: payload.displayName ?? null,
          phone: payload.phone ?? null,
        };
      }
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: creatorProfile });
    });
    await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
      profileComplete: false,
      missingFields: [],
      missingPlatforms: true,
      completionSteps: [],
    });

    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "Thank you for signing up" })).toBeVisible();
    await page.getByRole("button", { name: "Let’s get you set up" }).click();
    await expect(page.getByRole("heading", { name: "Which best describes you?" })).toBeVisible();
    await page.getByRole("radio", { name: /i’m a creator/i }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByText("Your profile", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(
        "Start with your details. Next, we’ll build the creator profile hotels will see.",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await expect(page.getByText("Personal account", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Marketplace, Booking Admin, and PMS/)).toHaveCount(0);
    await expect(page.getByLabel("Profile photo file")).not.toHaveAttribute("required", "");
    await expect(page.getByRole("button", { name: "Upload profile photo" })).toBeVisible();

    await page.getByLabel("Profile photo file").setInputFiles({
      name: "mary.png",
      mimeType: "image/png",
      buffer: Buffer.from("profile-image"),
    });
    await expect(page.getByRole("img", { name: "Selected profile preview" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change profile photo" })).toBeVisible();

    await page.getByLabel("First name").fill("Mary");
    await page.getByLabel("Last name").fill("Watson");
    await page.getByRole("button", { name: "Continue to creator profile" }).click();

    await expect(page).toHaveURL(/\/profile\/complete$/);
    await expect(
      page.getByRole("heading", { name: "Hi, Mary! What kind of creator are you?" }),
    ).toBeVisible();
    const lifestyleCard = page.getByRole("button", { name: /^Lifestyle/ });
    await expect(lifestyleCard).toBeVisible();
    await expect(lifestyleCard).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect((await lifestyleCard.boundingBox())?.width).toBeGreaterThan(280);
    await lifestyleCard.click();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("heading", { name: "Tell hotels about your work" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Mary Watson profile photo" })).toHaveCount(0);
    await expect(page.getByLabel("Location")).toBeVisible();
    await expect(page.getByLabel("Creator bio")).toBeVisible();
    await expect(page.getByLabel("Portfolio link")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload photo" })).toBeVisible();
    await expect(page.getByText("Name", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Email", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Phone", { exact: true })).toHaveCount(0);

    const creatorPhotoInput = page.getByLabel("Creator profile photo file");
    await creatorPhotoInput.setInputFiles({
      name: "too-large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
    });
    await expect(page.getByText("Image must be less than 20MB")).toBeVisible();
    await expect(page.getByRole("img", { name: "Mary Watson profile photo" })).toHaveCount(0);

    await creatorPhotoInput.setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from("replacement-image"),
    });
    await expect(page.getByRole("img", { name: "Mary Watson profile photo" })).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );
    await expect(page.getByText("Image must be less than 20MB")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change photo" })).toBeVisible();

    const continueButton = page.getByRole("button", { name: "Continue" });
    await expect(continueButton).toBeInViewport({ ratio: 1 });

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await continueButton.scrollIntoViewIfNeeded();
    await expect(continueButton).toBeInViewport({ ratio: 1 });
  });

  test("creator onboarding preserves an existing public profile and hydrates its platforms", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await mockOnboardingAuth(page, "creator", "Mary", "");
    let creatorPutCount = 0;
    const existingCreatorProfile = {
      creatorProfileId: "creator-profile-existing",
      displayName: "Established Creator",
      creatorType: "travel",
      locationText: "Berlin",
      shortDescription: "Independent travel stories for thoughtful explorers.",
      portfolioUrl: "https://creator.example/portfolio",
      phone: "+41 44 555 0101",
      profilePictureUrl: "https://media.example/existing-creator.png",
      profileComplete: false,
      profileStatus: "pending",
      platforms: [
        {
          platformId: "platform-existing-instagram",
          platform: "instagram",
          handle: "established",
          profileUrl: null,
          followerCount: 12345,
          engagementRate: 4.6,
          audienceCountries: [{ country: "Germany", percentage: 60 }],
          audienceAgeGroups: [{ ageRange: "25-34", percentage: 70 }],
          audienceGenderSplit: { male: 35, female: 60, other: 5 },
        },
      ],
      audienceSize: 12345,
      rating: { averageRating: 0, totalReviews: 0 },
      createdAt: "2026-07-14T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    };
    await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") creatorPutCount += 1;
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: existingCreatorProfile,
      });
    });
    await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
      profileComplete: false,
      missingFields: [],
      missingPlatforms: false,
      completionSteps: [],
    });

    await page.goto("/onboarding");
    await page.getByRole("button", { name: "Let’s get you set up" }).click();
    await page.getByRole("radio", { name: /i’m a creator/i }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("First name").fill("Mary");
    await page.getByLabel("Last name").fill("Watson");
    await page.getByLabel("Phone number").clear();
    await page.getByLabel("Profile photo file").setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from("replacement-profile-image"),
    });
    await page.getByRole("button", { name: "Continue to creator profile" }).click();

    await expect(page).toHaveURL(/\/profile\/complete$/);
    await expect(
      page.getByRole("heading", { name: "Hi, Established! What kind of creator are you?" }),
    ).toBeVisible();
    expect(creatorPutCount).toBe(0);
    const travelCard = page.getByRole("button", { name: /^Travel/ });
    await expect(travelCard).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByLabel("Location")).toHaveValue("Berlin");
    await expect(
      page.getByRole("img", { name: "Established Creator profile photo" }),
    ).toHaveAttribute("src", "https://media.example/existing-creator.png");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.locator('input[placeholder="@ username"]')).toHaveValue("established");
    await expect(page.locator('input[placeholder="0"]')).toHaveValue("12345");
    await expect(page.locator('input[placeholder="0.00"]')).toHaveValue("4.6");
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

async function mockOnboardingAuth(
  page: Page,
  accountType: "hotel" | "creator" = "hotel",
  expectedFirstName = "Mary Jane",
  expectedPhone = accountType === "creator" ? "+49 89 123456" : "",
) {
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
  const onboardedSession = {
    ...guestSession,
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationKind: accountType === "creator" ? "creator_workspace" : "hotel_group",
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
        ...(onboarded ? onboardedSession : guestSession),
        user: {
          ...(onboarded ? onboardedSession.user : guestSession.user),
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
    expect(route.request().postDataJSON()).toEqual({
      type: accountType,
      surface: "marketplace-web",
    });
    onboarded = true;
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        ...onboardedSession,
        user: { ...onboardedSession.user, name: accountName, phone: accountPhone },
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
      firstName: expectedFirstName,
      lastName: "Watson",
      phone: expectedPhone,
    });
    expect(payload).toMatchObject({
      profilePictureUrl:
        accountType === "hotel"
          ? "https://media.example/profile.png"
          : "staging/profile-e2e/ada.png",
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
              variants: [
                {
                  publicCdnUrl:
                    accountType === "hotel" ? "https://media.example/profile.png" : null,
                },
              ],
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
