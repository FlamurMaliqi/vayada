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

  test("creator onboarding uses creator copy and requires a profile photo", async ({ page }) => {
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
      profilePictureMediaObjectId: null as string | null,
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
          profilePictureUrl: "https://media.example/profile.png",
          profilePictureMediaObjectId: payload.profilePictureMediaObjectId ?? null,
        };
      }
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: creatorProfile });
    });
    await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
      profilePhotoRequired: true,
      profileComplete: false,
      missingFields: [],
      missingPlatforms: true,
      completionSteps: [],
    });

    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "Thank you for signing up" })).toBeVisible();
    await page.getByRole("button", { name: "Let’s get you set up" }).click();
    await expect(page.getByRole("heading", { name: "Which best describes you?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
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
    await expect(page.getByLabel("Profile photo file")).toHaveAttribute("required", "");
    await expect(page.getByRole("button", { name: "Upload profile photo" })).toBeVisible();

    await page.getByLabel("First name").fill("Mary");
    await page.getByLabel("Last name").fill("Watson");
    await page.getByRole("button", { name: "Continue to creator profile" }).click();
    await expect(page.getByText("Profile photo is required.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload profile photo" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );

    const profilePhotoChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload profile photo" }).click();
    const profilePhotoChooser = await profilePhotoChooserPromise;
    await profilePhotoChooser.setFiles({
      name: "mary.png",
      mimeType: "image/png",
      buffer: Buffer.from("profile-image"),
    });
    await expect(page.getByRole("button", { name: "Change profile photo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove profile photo" })).toHaveCount(0);
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
    await expect(page.getByRole("img", { name: "Mary Watson profile photo" })).toHaveAttribute(
      "src",
      "https://media.example/profile.png",
    );
    await expect(page.getByText("Account details saved", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Location")).toBeVisible();
    await expect(page.getByLabel("Creator bio")).toBeVisible();
    await expect(page.getByLabel("Portfolio link")).toBeVisible();
    await expect(page.getByRole("button", { name: "Change photo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload photo" })).toHaveCount(0);
    await expect(page.getByText("Name", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Email", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Phone", { exact: true })).toHaveCount(0);

    const creatorPhotoInput = page.getByLabel("Creator profile photo file");
    await creatorPhotoInput.setInputFiles({
      name: "too-large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
    });
    await expect(page.getByText("Choose an image smaller than 5 MB.")).toBeVisible();
    await expect(page.getByRole("img", { name: "Mary Watson profile photo" })).toHaveAttribute(
      "src",
      "https://media.example/profile.png",
    );

    await creatorPhotoInput.setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from("replacement-image"),
    });
    await expect(page.getByRole("img", { name: "Mary Watson profile photo" })).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );
    await expect(page.getByText("Choose an image smaller than 5 MB.")).toHaveCount(0);
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

  test("creator onboarding recovers when the photo policy request times out", async ({ page }) => {
    await primeBrowserState(page);
    await mockOnboardingAuth(page, "creator");
    let statusRequests = 0;
    await page.route(/\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      statusRequests += 1;
      if (statusRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        await route.abort().catch(() => undefined);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          profilePhotoRequired: true,
          profileComplete: false,
          missingFields: [],
          missingPlatforms: true,
          completionSteps: [],
        },
      });
    });

    await page.goto("/onboarding");
    await page.getByRole("button", { name: "Let’s get you set up" }).click();
    await page.getByRole("radio", { name: /i’m a creator/i }).click();
    const continueButton = page.getByRole("button", { name: "Continue", exact: true });
    await continueButton.click();

    await expect(
      page.getByText("Loading the creator photo requirement took too long. Please try again."),
    ).toBeVisible({ timeout: 7_000 });
    await expect(page.getByRole("radio")).toHaveCount(0);
    await page.getByRole("button", { name: "Retry creator requirements" }).click();
    await expect(page.getByLabel("Profile photo file")).toHaveAttribute("required", "");
    expect(statusRequests).toBe(2);
  });

  test("returning onboarding users do not see the signup welcome again", async ({ page }) => {
    await primeBrowserState(page);
    await page.addInitScript(() => {
      sessionStorage.setItem("vayada:onboarding-welcome:user-pending-onboarding", "complete");
    });
    await mockOnboardingAuth(page);

    await page.goto("/onboarding");

    await expect(page.getByRole("heading", { name: "Which best describes you?" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Thank you for signing up" })).toHaveCount(0);
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
      profilePictureMediaObjectId: "media-existing-creator",
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
      profilePhotoRequired: true,
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

  test("legacy complete creators must save a missing photo without losing profile data", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await primeCreatorProfileState(page, "Lina Creator");
    await mockCreatorSession(page, "Lina Creator");

    const uploadedProfilePicture = "https://media.example/creator-replacement.png";
    let updateAttempts = 0;
    let uploadSessionRequests = 0;
    let uploadFinalizeRequests = 0;
    let identityPhotoUpdates = 0;
    let creatorProfile = {
      creatorProfileId: "creator-profile-legacy",
      displayName: "Lina Creator",
      creatorType: "travel",
      locationText: "Berlin, Germany",
      shortDescription: "I create thoughtful city guides for independent travelers.",
      portfolioUrl: "https://creator.example/portfolio" as string | null,
      phone: null,
      profilePictureUrl: "https://legacy.example/creator.png" as string | null,
      profilePictureMediaObjectId: null as string | null,
      profileComplete: true,
      profileStatus: "active",
      platforms: [
        {
          platformId: "platform-instagram",
          platform: "instagram",
          handle: "@lina",
          profileUrl: null,
          followerCount: 1200,
          engagementRate: 4.2,
          audienceCountries: [],
          audienceAgeGroups: [],
          audienceGenderSplit: null,
        },
      ],
      audienceSize: 1200,
      rating: { averageRating: 0, totalReviews: 0 },
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    };

    await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") {
        updateAttempts += 1;
        const payload = route.request().postDataJSON() as {
          creatorType?: string;
          portfolioUrl?: string | null;
          profilePictureMediaObjectId?: string;
          platforms?: Array<{ platform: string; handle: string; followerCount: number }>;
        };
        expect(payload).toMatchObject({
          creatorType: "travel",
          portfolioUrl: null,
          profilePictureMediaObjectId: "media-creator-replacement",
        });
        expect(payload.platforms).toBeUndefined();
        if (updateAttempts === 1) {
          await route.fulfill({
            status: 503,
            headers: corsHeaders(route),
            json: { detail: "Temporary profile update failure" },
          });
          return;
        }
        creatorProfile = {
          ...creatorProfile,
          portfolioUrl: payload.portfolioUrl ?? null,
          profilePictureUrl: uploadedProfilePicture,
          profilePictureMediaObjectId: payload.profilePictureMediaObjectId ?? null,
        };
      }
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: creatorProfile });
    });
    await page.route(/\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const profileComplete = Boolean(creatorProfile.profilePictureMediaObjectId);
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          profilePhotoRequired: true,
          profileComplete,
          missingFields: profileComplete ? [] : ["profilePicture"],
          missingPlatforms: false,
          completionSteps: profileComplete ? [] : ["add_profile_picture"],
        },
      });
    });
    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().url().endsWith("/finalize")) {
        uploadFinalizeRequests += 1;
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            mediaObjects: [
              {
                mediaId: "media-creator-replacement",
                storageKey: uploadedProfilePicture,
                contentType: "image/png",
                sizeBytes: 17,
                originalFilename: "replacement.png",
                variants: [
                  {
                    publicCdnUrl: uploadedProfilePicture,
                    storageKey: "staging/creator-replacement/original.png",
                  },
                ],
              },
            ],
          },
        });
        return;
      }
      uploadSessionRequests += 1;
      expect(route.request().postDataJSON()).toMatchObject({
        purpose: "identity.user.profile_image",
        resource: {
          product: "platform",
          resourceType: "user_profile",
          resourceId: "user-legacy-creator",
        },
      });
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: {
          uploadSession: { sessionId: "creator-replacement" },
          uploadTargets: [
            {
              uploadTargetId: "creator-replacement-target",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/creator-replacement",
              headers: {},
            },
          ],
        },
      });
    });
    await page.route(/\/auth\/profile$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      identityPhotoUpdates += 1;
      expect(route.request().postDataJSON()).toMatchObject({
        profilePictureUrl: uploadedProfilePicture,
        profilePictureMediaObjectId: "media-creator-replacement",
      });
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: { updated: true } });
    });

    await page.goto("/profile/complete");

    await expect(
      page.getByRole("heading", { name: "Hi, Lina! What kind of creator are you?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Tell hotels about your work" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload photo" })).toBeVisible();
    await expect(page.getByLabel("Location")).toHaveValue("Berlin, Germany");
    await page.getByLabel("Portfolio link").clear();
    await page.getByLabel("Creator profile photo file").setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from("replacement-image"),
    });
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByPlaceholder("@ username")).toHaveValue("@lina");
    await expect(page.getByRole("spinbutton").first()).toHaveValue("1200");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Temporary profile update failure" }),
    ).toBeVisible();
    expect(uploadSessionRequests).toBe(1);
    expect(uploadFinalizeRequests).toBe(1);
    expect(identityPhotoUpdates).toBe(1);

    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is complete" })).toBeVisible();
    expect(updateAttempts).toBe(2);
    expect(uploadSessionRequests).toBe(1);
    expect(uploadFinalizeRequests).toBe(1);
    expect(identityPhotoUpdates).toBe(1);
  });

  test("an unrelated creator profile edit does not rewrite platform demographics", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await primeCreatorProfileState(page, "Lina Creator");
    await mockCreatorSession(page, "Lina Creator");

    let savedPayload: Record<string, unknown> | null = null;
    const creatorProfile = {
      creatorProfileId: "creator-profile-preserved-platform",
      displayName: "Lina Creator",
      creatorType: "travel",
      locationText: "Berlin, Germany",
      shortDescription: "I create thoughtful city guides for independent travelers.",
      portfolioUrl: "https://creator.example/portfolio",
      phone: null,
      profilePictureUrl: "https://media.example/lina.png",
      profilePictureMediaObjectId: "media-lina",
      profileComplete: true,
      profileStatus: "active",
      platforms: [
        {
          platformId: "platform-instagram",
          platform: "instagram",
          handle: "@lina",
          profileUrl: null,
          followerCount: 1200,
          engagementRate: 4.2,
          audienceCountries: [],
          audienceAgeGroups: [],
          audienceGenderSplit: null,
        },
      ],
      audienceSize: 1200,
      rating: { averageRating: 0, totalReviews: 0 },
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    };

    await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") {
        savedPayload = route.request().postDataJSON() as Record<string, unknown>;
      }
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: creatorProfile });
    });
    await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
      profilePhotoRequired: true,
      profileComplete: true,
      missingFields: [],
      missingPlatforms: false,
      completionSteps: [],
    });

    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: "Profile", exact: true })).toBeVisible();
    await page.getByTitle("Edit Profile").click();
    await page.getByPlaceholder("Your full name").fill("Lina Updated");
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect.poll(() => savedPayload).not.toBeNull();
    expect(savedPayload).toMatchObject({ displayName: "Lina Updated" });
    expect(savedPayload).not.toHaveProperty("platforms");
  });

  test("creator profile hydration failures show a retryable error", async ({ page }) => {
    await primeBrowserState(page);
    await primeCreatorProfileState(page, "Lina Creator");
    await mockCreatorSession(page, "Lina Creator");
    await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 503,
        headers: corsHeaders(route),
        json: { detail: "Creator profile unavailable" },
      });
    });

    await page.goto("/profile/complete");

    await expect(
      page.getByText("Failed to load your creator profile. Please refresh and try again.", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("onboarding surfaces a stalled cold session instead of hanging", async ({ page }) => {
    await primeBrowserState(page);
    let sessionRequests = 0;
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      sessionRequests += 1;
      if (sessionRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        await route.abort().catch(() => undefined);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          accessToken: "test-access-token",
          csrfToken: "test-csrf-token",
          user: {
            id: "user-pending-onboarding",
            email: "owner@example.test",
            status: "active",
          },
        },
      });
    });
    await routeJson(page, /\/auth\/compat\/marketplace-web-token(?:\?|$)/, {
      accessToken: "legacy-marketplace-token",
      expiresIn: 900,
    });

    await page.goto("/onboarding");

    await expect(
      page.getByText("Loading your session took too long. Please try again."),
    ).toBeVisible({ timeout: 7_000 });
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Retry session" }).click();
    await expect(page.getByRole("heading", { name: "Thank you for signing up" })).toBeVisible();
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

async function primeCreatorProfileState(page: Page, name: string) {
  await page.addInitScript((creatorName) => {
    localStorage.setItem("userType", "creator");
    localStorage.setItem("userName", creatorName);
    localStorage.setItem("isLoggedIn", "true");
  }, name);
}

async function mockCreatorSession(page: Page, name: string) {
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "creator-authkit-token",
        csrfToken: "creator-csrf-token",
        organizationId: "22222222-2222-4222-8222-222222222222",
        organizationKind: "creator_workspace",
        user: {
          id: "user-legacy-creator",
          email: "creator@example.test",
          name,
          phone: null,
          status: "active",
        },
      },
    });
  });
  await routeJson(page, /\/auth\/compat\/marketplace-web-token(?:\?|$)/, {
    accessToken: "legacy-marketplace-token",
    expiresIn: 900,
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
              variants: [
                {
                  publicCdnUrl: "https://media.example/profile.png",
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
