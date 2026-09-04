import { expect, test, type Page } from "@playwright/test";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
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

  test("hotel onboarding saves manager details with initials before shared setup", async ({
    page,
  }) => {
    await primeBrowserState(page);
    const onboarding = await mockOnboardingAuth(page);
    await mockSharedSetupStatus(page);

    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { name: "Welcome to vayada — what brings you here?" }),
    ).toBeVisible();
    await expect(page.getByText("Account created", { exact: true })).toBeVisible();
    await expect(page.getByText("Choose your role so we can tailor your setup.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
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
    await expect(page.getByLabel("Phone number")).toHaveAttribute("required", "");
    await expect(page.getByLabel("Profile photo file")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Manager initials: ?" })).toBeVisible();
    await expect(page.getByText("Optional", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByText("Enter your first name.")).toBeVisible();
    await expect(page.getByText("Enter your last name.")).toBeVisible();
    await expect(page.getByText("Profile photo is required.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload profile photo" })).toHaveCount(0);
    await page.getByLabel("First name").fill("Mary Jane");
    await page.getByLabel("Last name").fill("Watson");
    await page.getByLabel("Phone number").fill("sdfdsfsfsdfdsf");
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByText("Enter a valid phone number.")).toBeVisible();
    await page.getByLabel("Phone number").clear();
    await expect(page.getByRole("img", { name: "Manager initials: MW" })).toBeVisible();
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByText("Enter your phone number.")).toBeVisible();
    await page.getByLabel("Phone number").fill("+49 89 123456");
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    expect(onboarding.personalMediaRequestCount()).toBe(0);
    await expect(
      page.getByText("Your account details are saved. Next, let’s set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up my first hotel" })).toBeFocused();
    expect(
      await page.getByTestId("signup-success-ring").evaluate((element) => ({
        name: getComputedStyle(element).animationName,
        iterations: getComputedStyle(element).animationIterationCount,
      })),
    ).toEqual({ name: "ping", iterations: "2" });
    expect(
      await page.getByTestId("signup-success-check").evaluate((element) => ({
        name: getComputedStyle(element).animationName,
        iterations: getComputedStyle(element).animationIterationCount,
      })),
    ).toEqual({ name: "bounce", iterations: "1" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page
        .getByTestId("signup-success-ring")
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    await page.getByRole("button", { name: "Set up my first hotel" }).click();

    await expect(page).toHaveURL(/\/setup\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("entryProduct")).toBe("marketplace");
    await expect(page.getByRole("heading", { name: "Choose how you’ll use vayada" })).toBeVisible();
    await expect(page.getByLabel("Creator Marketplace")).toBeVisible();
    await expect(page.getByLabel("Hotel Operations")).toBeVisible();
    await expect(page.getByText("We'd like to get to know you better")).toHaveCount(0);
    await expect(page.getByText("Which systems do you want to use?")).toHaveCount(0);
  });

  test("hotel invitation survives first-run signup and hands off only after redemption", async ({
    page,
  }, testInfo) => {
    const inviteCode = "VAY-browser-invite-1050";
    const inviteRequests: Array<{ path: string; body: unknown; authorization?: string }> = [];
    const requestedUrls: string[] = [];
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "marketplace-web-hotel-invites");
    page.on("request", (request) => requestedUrls.push(request.url()));

    await primeBrowserState(page);
    await mockCookieConsent(page);
    const onboarding = await mockOnboardingAuth(
      page,
      "hotel",
      "Mary Jane",
      "+49 89 123456",
      inviteCode,
    );
    await page.route(
      /\/api\/marketplace\/hotel-account-invites\/(lookup|redeem)$/,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        const url = new URL(route.request().url());
        const body = route.request().postDataJSON();
        inviteRequests.push({
          path: url.pathname,
          body,
          authorization: route.request().headers().authorization,
        });
        expect(body).toEqual({ code: inviteCode });
        if (url.pathname.endsWith("/lookup")) {
          await route.fulfill({
            status: 200,
            headers: corsHeaders(route),
            json: {
              contractVersion: "hotel-account-invite.v1",
              identity: { emailHint: "o****@example.test" },
              organization: { displayName: "Alpenrose Hospitality" },
              property: { displayName: "Hotel Alpenrose" },
              selectedTracks: ["creator_marketplace"],
              handoffPath: "/setup",
              expiresAt: "2026-08-20T12:00:00.000Z",
            },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            contractVersion: "hotel-account-invite.v1",
            status: "redeemed",
            selectedTracks: ["creator_marketplace"],
            handoffPath: "/setup",
          },
        });
      },
    );
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });
    await routeJson(
      page,
      /\/api\/hotel-setup\/status/,
      createAdaptiveHotelSetupStatusMock({
        entryProduct: "marketplace",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationDisplayName: "Alpenrose Hospitality",
        selectedTracks: ["creator_marketplace"],
        trackRevision: 1,
        propertyId: null,
        updatedAt: "2026-08-02T12:00:00.000Z",
      }),
    );

    await page.goto(`/invite#code=${inviteCode}`);
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(
      page.getByRole("heading", { name: "Create your invited hotel account" }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: /i manage a hotel/i })).toBeChecked();
    await expect(page.getByRole("radio", { name: /i’m a creator/i })).toHaveCount(0);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await page.getByLabel("First name").fill("Mary Jane");
    await page.getByLabel("Last name").fill("Watson");
    await expect(page.getByLabel("Profile photo file")).toHaveCount(0);
    await expect(page.getByRole("img", { name: "Manager initials: MW" })).toBeVisible();
    await page.getByRole("button", { name: "Continue to hotel setup" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    await page.getByRole("button", { name: "Set up my first hotel" }).click();

    await expect(page).toHaveURL(/\/invite$/);
    await expect(page.getByRole("heading", { name: "Hotel Alpenrose" })).toBeVisible();
    await expect(page.getByText("Creator Marketplace", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Accept and continue to setup" }).click();

    await expect(page).toHaveURL(/\/setup\?entryProduct=marketplace&returnProduct=marketplace$/);
    const lookups = inviteRequests.filter((request) => request.path.endsWith("/lookup"));
    expect(lookups).toHaveLength(2);
    expect(lookups.every((request) => request.authorization === undefined)).toBe(true);
    const redemption = inviteRequests.find((request) => request.path.endsWith("/redeem"));
    expect(redemption).toEqual({
      path: "/api/marketplace/hotel-account-invites/redeem",
      body: { code: inviteCode },
      authorization: "Bearer test-access-token",
    });
    expect(requestedUrls.some((url) => url.includes(inviteCode))).toBe(false);
    expect(onboarding.personalMediaRequestCount()).toBe(0);
    await assertNoLegacyCalls();
    await assertHealthy();
  });

  for (const scenario of [
    {
      label: "Hotel Operations",
      selectedTracks: ["hotel_operations"],
      entryProduct: "pms",
    },
    {
      label: "combined",
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      entryProduct: "marketplace",
    },
  ] as const) {
    test(`hotel invitation preserves the ${scenario.label} route intent`, async ({ page }) => {
      const inviteCode = `VAY-browser-${scenario.entryProduct}-invite`;
      await primeBrowserState(page);
      await mockInviteAuthenticatedHotel(page, inviteCode);
      await page.route(
        /\/api\/marketplace\/hotel-account-invites\/(lookup|redeem)$/,
        async (route) => {
          if (route.request().method() === "OPTIONS") {
            await fulfillCorsPreflight(route);
            return;
          }
          const url = new URL(route.request().url());
          const response = {
            contractVersion: "hotel-account-invite.v1",
            selectedTracks: [...scenario.selectedTracks],
            handoffPath: "/setup",
          };
          await route.fulfill({
            status: 200,
            headers: corsHeaders(route),
            json: url.pathname.endsWith("/lookup")
              ? {
                  ...response,
                  identity: { emailHint: "o****@example.test" },
                  organization: { displayName: "Alpenrose Hospitality" },
                  property: { displayName: "Hotel Alpenrose" },
                  expiresAt: "2026-08-20T12:00:00.000Z",
                }
              : { ...response, status: "redeemed" },
          });
        },
      );
      await routeJson(page, /\/api\/hotel-setup\/property-types/, {
        contractVersion: "adaptive-hotel-property-types.v1",
        propertyTypes: [{ value: "hotel", label: "Hotel" }],
      });
      await routeJson(
        page,
        /\/api\/hotel-setup\/status/,
        createAdaptiveHotelSetupStatusMock({
          entryProduct: scenario.entryProduct,
          organizationId: "11111111-1111-4111-8111-111111111111",
          organizationDisplayName: "Alpenrose Hospitality",
          selectedTracks: [...scenario.selectedTracks],
          trackRevision: 1,
          propertyId: null,
          updatedAt: "2026-08-02T12:00:00.000Z",
        }),
      );

      await page.goto(`/invite#code=${inviteCode}`);
      await page.getByRole("button", { name: "Accept and continue to setup" }).click();

      await expect(page).toHaveURL(
        new RegExp(
          `/setup\\?entryProduct=${scenario.entryProduct}&returnProduct=${scenario.entryProduct}$`,
        ),
      );
      await expect(
        page.getByRole("heading", { name: "Let’s get to know your hotel" }),
      ).toBeVisible();
    });
  }

  test("hotel invitation resumes an authenticated replay after a lost redemption response", async ({
    page,
  }) => {
    const inviteCode = "VAY-browser-lost-response";
    const requestedUrls: string[] = [];
    let lookupCalls = 0;
    let redemptionCalls = 0;
    let canonicalRedemptionCommitted = false;
    page.on("request", (request) => requestedUrls.push(request.url()));

    await primeBrowserState(page);
    await mockInviteAuthenticatedHotel(page, inviteCode);
    await page.route(
      /\/api\/marketplace\/hotel-account-invites\/(lookup|redeem)$/,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        const url = new URL(route.request().url());
        expect(route.request().postDataJSON()).toEqual({ code: inviteCode });
        if (url.pathname.endsWith("/lookup")) {
          expect(route.request().headers().authorization).toBeUndefined();
          lookupCalls += 1;
          await route.fulfill({
            status: canonicalRedemptionCommitted ? 404 : 200,
            headers: corsHeaders(route),
            json: canonicalRedemptionCommitted
              ? {
                  code: "invite_not_available",
                  detail: "This hotel account invitation is invalid or no longer available.",
                }
              : {
                  contractVersion: "hotel-account-invite.v1",
                  identity: { emailHint: "o****@example.test" },
                  organization: { displayName: "Alpenrose Hospitality" },
                  property: { displayName: "Hotel Alpenrose" },
                  selectedTracks: ["creator_marketplace"],
                  handoffPath: "/setup",
                  expiresAt: "2026-08-20T12:00:00.000Z",
                },
          });
          return;
        }
        redemptionCalls += 1;
        if (!canonicalRedemptionCommitted) {
          canonicalRedemptionCommitted = true;
          await route.fulfill({
            status: 502,
            headers: corsHeaders(route),
            json: { code: "upstream_response_lost" },
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            contractVersion: "hotel-account-invite.v1",
            status: "already_redeemed",
            selectedTracks: ["creator_marketplace"],
            handoffPath: "/setup",
          },
        });
      },
    );
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });
    await routeJson(
      page,
      /\/api\/hotel-setup\/status/,
      createAdaptiveHotelSetupStatusMock({
        entryProduct: "marketplace",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationDisplayName: "Alpenrose Hospitality",
        selectedTracks: ["creator_marketplace"],
        trackRevision: 1,
        propertyId: null,
        updatedAt: "2026-08-02T12:00:00.000Z",
      }),
    );

    await page.goto(`/invite#code=${inviteCode}`);
    await page.getByRole("button", { name: "Accept and continue to setup" }).click();
    await expect(
      page.getByText("The invitation could not be accepted.", { exact: false }),
    ).toBeVisible();

    await page.reload();

    await expect(page).toHaveURL(/\/setup\?entryProduct=marketplace&returnProduct=marketplace$/);
    expect(lookupCalls).toBe(2);
    expect(redemptionCalls).toBe(2);
    expect(requestedUrls.some((url) => url.includes(inviteCode))).toBe(false);
  });

  test("restored profile-ready sessions still show the onboarding handoff", async ({ page }) => {
    await primeBrowserState(page);
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          accessToken: "restored-hotel-token",
          csrfToken: "restored-hotel-csrf",
          organizationId: "11111111-1111-4111-8111-111111111111",
          organizationKind: "hotel_group",
          user: {
            id: "user-restored-hotel",
            email: "returning-owner@example.test",
            name: "Returning Owner",
            phone: "+49 89 123456",
            profilePictureUrl: "https://media.example/returning-owner.webp",
            profilePictureMediaObjectId: "media-returning-owner",
            status: "active",
          },
        },
      });
    });
    await page.goto("/onboarding");

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    await expect(
      page.getByText("Your account details are saved. Next, let’s set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Set up my first hotel" })).toBeVisible();
  });

  test("creator onboarding uses creator copy and requires phone and profile photo", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 830 });
    await primeBrowserState(page);
    await mockOnboardingAuth(page, "creator", "Mary");
    const creatorProfile = {
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
    let creatorProfileUpdates = 0;
    await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") {
        creatorProfileUpdates += 1;
      }
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: creatorProfile });
    });
    let creatorStatusRequests = 0;
    await page.route(/\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      creatorStatusRequests += 1;
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
    await routeJson(page, /\/api\/marketplace\/creators\/me\/platform-connections(?:\?|$)/, {
      connections: [],
    });

    await page.goto("/onboarding");
    await expect(
      page.getByRole("heading", { name: "Welcome to vayada — what brings you here?" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await page.getByRole("radio", { name: /i’m a creator/i }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByText("Your profile", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(
        "Start with your details. Next, we’ll build the creator profile hotels will see.",
      ),
    ).toHaveCount(0);
    await expect(page.getByText("Personal account", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Marketplace, Booking Admin, and PMS/)).toHaveCount(0);
    await expect(page.getByLabel("Email address")).toHaveValue("owner@example.test");
    await expect(page.getByLabel("Phone number")).toHaveValue("+49 89 123456");
    await expect(page.getByLabel("Profile photo file")).toHaveAttribute("required", "");
    await expect(page.getByLabel("Phone number")).toHaveAttribute("required", "");
    await expect(page.getByText("Optional", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload profile photo" })).toBeVisible();
    expect(creatorStatusRequests).toBe(0);

    await page.getByLabel("First name").fill("Mary");
    await page.getByLabel("Last name").fill("Watson");
    await page.getByLabel("Phone number").clear();
    await page.getByRole("button", { name: "Continue to creator profile" }).click();
    await expect(page.getByText("Enter your phone number.")).toBeVisible();
    await expect(page.getByText("Profile photo is required.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload profile photo" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await page.getByLabel("Phone number").fill("+49 89 123456");

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

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    await expect(
      page.getByText(
        "Your account details are saved. Next, let’s create the public creator profile hotels will see.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create my public creator profile" }).click();

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

    await page.setViewportSize({ width: 1280, height: 900 });
    const aboutHeading = page.getByRole("heading", { name: "Tell hotels about your work" });
    const continueButton = page.getByRole("button", { name: "Continue" });
    await expect(aboutHeading).toBeVisible();
    await expect(
      page.getByText(
        "Your account details are already saved. Add what hotels need to understand your content.",
      ),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change photo" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Upload photo" })).toHaveCount(0);
    await expect(page.getByLabel("Creator profile photo file")).toHaveCount(0);
    const location = page.getByLabel("Location");
    const bio = page.getByLabel("Creator bio");
    const portfolio = page.getByLabel("Portfolio link");
    await expect(location).toBeVisible();
    await expect(bio).toBeVisible();
    await expect(portfolio).toBeVisible();
    const [headingBox, centeredContinueBox] = await Promise.all([
      aboutHeading.boundingBox(),
      continueButton.boundingBox(),
    ]);
    const contentCenter =
      ((headingBox?.y ?? 0) + (centeredContinueBox?.y ?? 0) + (centeredContinueBox?.height ?? 0)) /
      2;
    expect(Math.abs(contentCenter - 450)).toBeLessThan(60);

    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(continueButton).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= document.documentElement.clientHeight,
      ),
    ).toBe(true);
    const [locationBox, bioBox, portfolioBox, continueBox] = await Promise.all(
      [location, bio, portfolio, continueButton].map((locator) => locator.boundingBox()),
    );
    expect(locationBox?.y).toBeLessThan(bioBox?.y ?? 0);
    expect(bioBox?.y).toBeLessThan(portfolioBox?.y ?? 0);
    expect(portfolioBox?.y).toBeLessThan(continueBox?.y ?? 0);
    await expect(page.getByText("Name", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Email", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Phone", { exact: true })).toHaveCount(0);
    expect(creatorProfileUpdates).toBe(1);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await continueButton.scrollIntoViewIfNeeded();
    await expect(continueButton).toBeInViewport({ ratio: 1 });

    await page.setViewportSize({ width: 1280, height: 720 });
    await location.fill("Berlin, Germany");
    await bio.fill("I create practical city guides for independent travelers.");
    await continueButton.click();

    const reachHeading = page.getByRole("heading", { name: "Show hotels your reach" });
    const connectAccountButtons = page.getByRole("button", {
      name: /^Connect (Instagram|TikTok|YouTube|Facebook) account$/,
    });
    const manualAccountButtons = page.getByRole("button", {
      name: /^Enter (Instagram|TikTok|YouTube|Facebook) account manually$/,
    });
    const addAnotherPlatformButton = page.getByRole("button", {
      name: "Add another platform",
    });
    const submitButton = page.getByRole("button", { name: "Submit for review" });
    await expect(reachHeading).toHaveCount(1);
    await expect(connectAccountButtons).toHaveCount(4);
    await expect(manualAccountButtons).toHaveCount(4);
    await expect(addAnotherPlatformButton).toHaveCount(1);
    await expect(submitButton).toBeInViewport({ ratio: 1 });
    const addButtonBoxes = await Promise.all(
      [0, 1, 2, 3].map((index) => connectAccountButtons.nth(index).boundingBox()),
    );
    expect(addButtonBoxes[0]?.y).toBeLessThan(addButtonBoxes[1]?.y ?? 0);
    expect(addButtonBoxes[1]?.y).toBeLessThan(addButtonBoxes[2]?.y ?? 0);
    expect(addButtonBoxes[2]?.y).toBeLessThan(addButtonBoxes[3]?.y ?? 0);
    await expect(
      page.getByText(
        "Connected accounts use a consistent 30-day window. Enter anything unavailable manually.",
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= document.documentElement.clientHeight,
      ),
    ).toBe(true);

    await page.getByRole("button", { name: "Enter Instagram account manually" }).click();
    await expect(page.getByPlaceholder("@ username")).toBeVisible();
    await expect(page.getByPlaceholder("0", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("0.00")).toBeVisible();

    await addAnotherPlatformButton.click();
    await expect(page.getByLabel("Platform name")).toBeVisible();
    await expect(page.getByLabel("Profile link")).toBeVisible();
    await expect(page.getByLabel("Followers").last()).toBeVisible();
    await expect(page.getByLabel("Engagement rate (%)").last()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("creator platform callback restores the wizard and shows imported and missing data", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await primeBrowserState(page);
    await primeCreatorProfileState(page, "Lina Creator");
    await mockCreatorSession(page, "Lina Creator", "+49 89 123456");
    await page.addInitScript(() => {
      sessionStorage.setItem(
        "vayada_creator_platform_connection_draft",
        JSON.stringify({
          form: {
            name: "Lina Creator",
            location: "Berlin, Germany",
            short_description: "I create practical city guides for independent travelers.",
            portfolio_link: "",
            phone: "+49 89 123456",
            creator_type: "Travel",
          },
          platforms: [
            {
              id: "platform-instagram",
              name: "Instagram",
              handle: "@lina",
              followers: 1000,
              engagement_rate: 3,
              top_countries: [{ country: "Germany", percentage: 60 }],
              top_age_groups: [{ ageRange: "25-34", percentage: 50 }],
              gender_split: { male: 40, female: 60 },
            },
            {
              name: "Other",
              handle: "LinkedIn",
              profile_url: "https://www.linkedin.com/in/lina",
              followers: 500,
              engagement_rate: 2,
            },
          ],
        }),
      );
    });
    await routeJson(page, /\/api\/marketplace\/creators\/me(?:\?|$)/, {
      creatorProfileId: "creator-profile-connected",
      displayName: "Lina Creator",
      creatorType: "travel",
      locationText: "Berlin, Germany",
      shortDescription: "I create practical city guides for independent travelers.",
      portfolioUrl: null,
      phone: "+49 89 123456",
      profilePictureUrl: "https://media.example/lina.png",
      profilePictureMediaObjectId: "media-lina",
      profileComplete: false,
      profileStatus: "pending",
      platforms: [
        {
          platformId: "platform-instagram",
          platform: "instagram",
          handle: "@lina",
          profileUrl: "https://instagram.com/lina",
          followerCount: 1200,
          engagementRate: 1_000,
          audienceCountries: [],
          audienceAgeGroups: [],
          audienceGenderSplit: null,
          verificationStatus: "verified",
        },
      ],
      audienceSize: 1200,
      rating: { averageRating: 0, totalReviews: 0 },
      createdAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
      profilePhotoRequired: true,
      profileComplete: false,
      missingFields: [],
      missingPlatforms: false,
      completionSteps: [],
    });
    await routeJson(page, /\/api\/marketplace\/creators\/me\/platform-connections(?:\?|$)/, {
      connections: [
        {
          connectionId: "connection-instagram",
          platformId: "platform-instagram",
          platform: "instagram",
          provider: "meta",
          externalAccountId: "instagram-account-1",
          status: "active",
          lastSyncAttemptAt: "2026-07-19T12:00:00.000Z",
          lastSuccessfulSyncAt: "2026-07-19T12:00:00.000Z",
          lastErrorCode: null,
          capabilities: [
            "followerCount",
            "engagementRate",
            "audienceCountries",
            "audienceAgeGroups",
            "audienceGenderSplit",
          ],
          importedFields: ["followerCount", "engagementRate"],
          unavailableFields: [
            { field: "audienceCountries", reason: "privacy_threshold" },
            { field: "audienceAgeGroups", reason: "privacy_threshold" },
            { field: "audienceGenderSplit", reason: "privacy_threshold" },
          ],
        },
      ],
    });

    await page.goto(
      "/profile/complete?connection=success&platform=instagram&connection_id=connection-instagram",
    );

    await expect(page.getByRole("heading", { name: "Show hotels your reach" })).toBeVisible();
    await expect(page.getByText("Instagram is connected. vayada is importing")).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    const connectedUsername = page.locator('input[placeholder="@ username"]');
    await expect(connectedUsername).toHaveValue("@lina");
    await expect(connectedUsername).toBeDisabled();
    await expect(page.getByText("Instagram supplies the username while connected.")).toBeVisible();
    const importedEngagementRate = page.locator('input[placeholder="0.00"]').first();
    await expect(importedEngagementRate).toHaveValue("1000");
    expect(await importedEngagementRate.evaluate((input) => input.validity.valid)).toBe(true);
    await expect(page.getByText(/did not provide countries, age groups/)).toBeVisible();
    await page
      .getByRole("button", { name: /Audience demographics/ })
      .first()
      .click();
    await expect(page.getByText("Germany", { exact: true })).toBeVisible();
    await expect(page.locator('input[placeholder="45"]')).toHaveValue("40");
    await expect(page.locator('input[placeholder="55"]')).toHaveValue("60");
    await expect(page.getByLabel("Platform name")).toHaveValue("LinkedIn");
    await expect(page.getByLabel("Profile link")).toHaveValue("https://www.linkedin.com/in/lina");
    await expect(page).toHaveURL(/\/profile\/complete$/);

    await page.route(
      /\/api\/marketplace\/creators\/me\/platform-connections\/connection-instagram$/,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        await route.fulfill({ status: 204, headers: corsHeaders(route) });
      },
    );
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Disconnect @lina from Instagram" }).click();
    await expect(connectedUsername).toBeEnabled();
    await expect(connectedUsername).toHaveValue("@lina");
    await expect(
      page.getByRole("button", { name: "Connect saved @lina Instagram account" }),
    ).toBeVisible();

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("creator can select one account after platform authorization", async ({ page }) => {
    await primeBrowserState(page);
    await primeCreatorProfileState(page, "Lina Creator");
    await mockCreatorSession(page, "Lina Creator", "+49 89 123456");
    let platformConnected = false;
    const creatorProfile = () => ({
      creatorProfileId: "creator-profile-select",
      displayName: "Lina Creator",
      creatorType: "travel",
      locationText: "Berlin, Germany",
      shortDescription: "I create practical city guides for independent travelers.",
      portfolioUrl: null,
      phone: "+49 89 123456",
      profilePictureUrl: "https://media.example/lina.png",
      profilePictureMediaObjectId: "media-lina",
      profileComplete: false,
      profileStatus: "pending",
      platforms: platformConnected
        ? [
            {
              platformId: "platform-facebook",
              platform: "facebook",
              handle: "vayada.travel",
              profileUrl: "https://facebook.com/vayada.travel",
              followerCount: 800,
              engagementRate: 3.1,
              audienceCountries: [],
              audienceAgeGroups: [],
              audienceGenderSplit: null,
              verificationStatus: "verified",
            },
          ]
        : [],
      audienceSize: platformConnected ? 800 : 0,
      rating: { averageRating: 0, totalReviews: 0 },
      createdAt: "2026-07-19T10:00:00.000Z",
      updatedAt: "2026-07-19T10:00:00.000Z",
    });
    await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: creatorProfile() });
    });
    await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
      profilePhotoRequired: true,
      profileComplete: false,
      missingFields: [],
      missingPlatforms: true,
      completionSteps: ["add_platform"],
    });
    await page.route(
      /\/api\/marketplace\/creators\/me\/platform-connections(?:\?|$)/,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            connections: platformConnected
              ? [
                  {
                    connectionId: "connection-facebook",
                    platformId: "platform-facebook",
                    platform: "facebook",
                    provider: "meta",
                    externalAccountId: "facebook-page-1",
                    status: "active",
                    lastSyncAttemptAt: "2026-07-19T12:00:00.000Z",
                    lastSuccessfulSyncAt: "2026-07-19T12:00:00.000Z",
                    lastErrorCode: null,
                    capabilities: ["followerCount", "engagementRate"],
                    importedFields: ["followerCount", "engagementRate"],
                    unavailableFields: [],
                  },
                ]
              : [],
          },
        });
      },
    );
    await routeJson(
      page,
      /\/api\/marketplace\/creators\/me\/platform-authorizations\/pending(?:\?|$)/,
      {
        authorizationId: "authorization-facebook",
        platform: "facebook",
        accounts: [
          {
            externalAccountId: "facebook-page-1",
            displayName: "Vayada Travel",
            handle: "vayada.travel",
            profileUrl: "https://facebook.com/vayada.travel",
          },
        ],
      },
    );
    await page.route(
      /\/api\/marketplace\/creators\/me\/platform-authorizations\/authorization-facebook\/accounts$/,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        expect(route.request().postDataJSON()).toEqual({ externalAccountId: "facebook-page-1" });
        platformConnected = true;
        await route.fulfill({ status: 200, headers: corsHeaders(route), json: null });
      },
    );

    await page.goto(
      "/profile/complete?connection=select&platform=facebook&authorization_id=authorization-facebook",
    );
    await expect(
      page.getByText("Choose the Facebook account to connect", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Vayada Travel/ }).click();

    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.locator('input[placeholder="@ username"]')).toHaveValue("vayada.travel");
    await expect(page.getByText(/Facebook is connected/)).toBeVisible();
  });

  test("returning creators only skip account details when phone and photo are complete", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await mockCreatorSession(page, "Returning Creator", "+49 89 123456");
    let profilePictureUrl: string | null = null;
    let profilePictureMediaObjectId: string | null = null;
    await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          creatorProfileId: "creator-profile-returning",
          displayName: "Returning Creator",
          creatorType: "travel",
          locationText: "Berlin",
          shortDescription: "Independent travel stories.",
          portfolioUrl: null,
          phone: "+49 89 123456",
          profilePictureUrl,
          profilePictureMediaObjectId,
          profileComplete: false,
          profileStatus: "pending",
          platforms: [],
          audienceSize: 0,
          rating: { averageRating: 0, totalReviews: 0 },
          createdAt: "2026-07-15T10:00:00.000Z",
          updatedAt: "2026-07-15T10:00:00.000Z",
        },
      });
    });

    await page.goto("/onboarding");
    await expect(page.getByLabel("Profile photo file")).toHaveAttribute("required", "");
    await expect(page.getByLabel("Phone number")).toHaveAttribute("required", "");

    profilePictureUrl = "https://media.example/returning-creator.png";
    profilePictureMediaObjectId = "media-returning-creator";
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
  });

  test("creator account-detail lookup failures show retry instead of required photo setup", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await primeCreatorProfileState(page, "Returning Creator");
    await mockCreatorSession(page, "Returning Creator", "+49 89 123456");
    let profileRequests = 0;
    await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      profileRequests += 1;
      if (profileRequests === 1) {
        await route.fulfill({
          status: 503,
          headers: corsHeaders(route),
          json: { detail: "Creator profile unavailable" },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          creatorProfileId: "creator-profile-returning",
          displayName: "Returning Creator",
          creatorType: "travel",
          locationText: "Berlin",
          shortDescription: "Independent travel stories.",
          portfolioUrl: null,
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/returning-creator.png",
          profilePictureMediaObjectId: "media-returning-creator",
          profileComplete: true,
          profileStatus: "active",
          platforms: [],
          audienceSize: 0,
          rating: { averageRating: 0, totalReviews: 0 },
          createdAt: "2026-07-15T10:00:00.000Z",
          updatedAt: "2026-07-15T10:00:00.000Z",
        },
      });
    });

    await page.goto("/onboarding");

    await expect(
      page.getByRole("alert").filter({ hasText: "Creator profile unavailable" }),
    ).toBeVisible();
    await expect(page.getByLabel("Profile photo file")).toHaveCount(0);
    await page.getByRole("button", { name: "Retry account details" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    expect(profileRequests).toBe(2);
  });

  test("direct creator profile setup returns a missing phone to required account details", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await primeCreatorProfileState(page, "Returning Creator");
    let sessionPhone: string | null = null;
    await mockCreatorSession(page, "Returning Creator", () => sessionPhone);
    await routeJson(page, /\/api\/marketplace\/creators\/me(?:\?|$)/, {
      creatorProfileId: "creator-profile-direct",
      displayName: "Returning Creator",
      creatorType: "travel",
      locationText: "Berlin",
      shortDescription: "Independent travel stories.",
      portfolioUrl: null,
      phone: "+49 89 123456",
      profilePictureUrl: "https://media.example/returning-creator.png",
      profilePictureMediaObjectId: "media-returning-creator",
      profileComplete: true,
      profileStatus: "active",
      platforms: [],
      audienceSize: 0,
      rating: { averageRating: 0, totalReviews: 0 },
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z",
    });
    await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
      profilePhotoRequired: true,
      profileComplete: true,
      missingFields: [],
      missingPlatforms: false,
      completionSteps: [],
    });
    await page.route(/\/auth\/profile$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      expect(payload).toMatchObject({ phone: "+49 89 123456" });
      expect(payload).not.toHaveProperty("profilePictureUrl");
      expect(payload).not.toHaveProperty("profilePictureMediaObjectId");
      sessionPhone = "+49 89 123456";
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: { updated: true } });
    });

    await page.goto("/profile/complete");

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByLabel("Phone number")).toHaveAttribute("required", "");
    await expect(page.getByRole("img", { name: "Existing profile photo" })).toHaveAttribute(
      "src",
      "https://media.example/returning-creator.png",
    );
    await expect(page.getByLabel("Profile photo file")).not.toHaveAttribute("required", "");
    await page.getByLabel("Phone number").fill("+49 89 123456");
    await page.getByRole("button", { name: "Continue to creator profile" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
  });

  test("creator onboarding preserves an existing public profile and hydrates its platforms", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await mockOnboardingAuth(page, "creator", "Mary");
    let creatorPutCount = 0;
    let existingCreatorProfile = {
      creatorProfileId: "creator-profile-existing",
      displayName: "Established Creator",
      creatorType: "travel",
      locationText: "Berlin",
      shortDescription: "Independent travel stories for thoughtful explorers.",
      portfolioUrl: "https://creator.example/portfolio",
      phone: "+41 44 555 0101",
      profilePictureUrl: "https://media.example/existing-creator.png",
      profilePictureMediaObjectId: null as string | null,
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
      if (route.request().method() === "PUT") {
        creatorPutCount += 1;
        expect(route.request().postDataJSON()).toEqual({
          profilePictureMediaObjectId: "media-profile-e2e",
        });
        existingCreatorProfile = {
          ...existingCreatorProfile,
          profilePictureUrl: "https://media.example/profile.png",
          profilePictureMediaObjectId: "media-profile-e2e",
        };
      }
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
    await page.getByRole("radio", { name: /i’m a creator/i }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByLabel("First name").fill("Mary");
    await page.getByLabel("Last name").fill("Watson");
    await page.getByLabel("Profile photo file").setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from("replacement-profile-image"),
    });
    await page.getByRole("button", { name: "Continue to creator profile" }).click();

    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    await page.getByRole("button", { name: "Create my public creator profile" }).click();

    await expect(page).toHaveURL(/\/profile\/complete$/);
    await expect(
      page.getByRole("heading", { name: "Hi, Established! What kind of creator are you?" }),
    ).toBeVisible();
    expect(creatorPutCount).toBe(1);
    const travelCard = page.getByRole("button", { name: /^Travel/ });
    await expect(travelCard).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByLabel("Location")).toHaveValue("Berlin");
    await expect(page.getByRole("button", { name: "Change photo" })).toHaveCount(0);
    await expect(page.getByLabel("Creator profile photo file")).toHaveCount(0);
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.locator('input[placeholder="@ username"]')).toHaveValue("established");
    await expect(page.locator('input[placeholder="0"]')).toHaveValue("12345");
    await expect(page.locator('input[placeholder="0.00"]')).toHaveValue("4.6");
  });

  test("legacy URL-only creators reuse the shared account photo without another upload", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await primeCreatorProfileState(page, "Lina Creator");
    const sharedProfilePicture = "https://media.example/shared-creator.png";
    const sharedProfileMediaObjectId = "media-shared-creator";
    await mockCreatorSession(page, "Lina Creator", {
      phone: "+49 30 123456",
      profilePictureUrl: sharedProfilePicture,
      profilePictureMediaObjectId: sharedProfileMediaObjectId,
    });

    let updateAttempts = 0;
    let uploadSessionRequests = 0;
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
          phone?: string;
          profilePictureMediaObjectId?: string;
          platforms?: Array<{ platform: string; handle: string; followerCount: number }>;
        };
        expect(payload).toMatchObject({
          creatorType: "travel",
          portfolioUrl: null,
          phone: "+49 30 123456",
          profilePictureMediaObjectId: sharedProfileMediaObjectId,
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
          phone: "+49 30 123456",
          profilePictureUrl: sharedProfilePicture,
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
    await routeJson(page, /\/api\/marketplace\/creators\/me\/platform-connections(?:\?|$)/, {
      connections: [],
    });
    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      uploadSessionRequests += 1;
      await route.abort();
    });
    await page.route(/\/auth\/profile$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      identityPhotoUpdates += 1;
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: { updated: true } });
    });

    await page.goto("/profile/complete");

    await expect(
      page.getByRole("heading", { name: "Hi, Lina! What kind of creator are you?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Tell hotels about your work" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change photo" })).toHaveCount(0);
    await expect(page.getByLabel("Creator profile photo file")).toHaveCount(0);
    await expect(page.getByLabel("Location")).toHaveValue("Berlin, Germany");
    await page.getByLabel("Portfolio link").clear();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByPlaceholder("@ username")).toHaveValue("@lina");
    await expect(page.getByRole("spinbutton").first()).toHaveValue("1200");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Temporary profile update failure" }),
    ).toBeVisible();
    expect(uploadSessionRequests).toBe(0);
    expect(identityPhotoUpdates).toBe(0);

    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByRole("heading", { name: "Your profile is complete" })).toBeVisible();
    expect(updateAttempts).toBe(2);
    expect(uploadSessionRequests).toBe(0);
    expect(identityPhotoUpdates).toBe(0);
  });

  test("legacy creators must save a missing photo even when the old policy says optional", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
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
      phone: "+49 89 123456",
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
          profilePictureMediaObjectId?: string;
        };
        expect(payload).toEqual({
          profilePictureMediaObjectId: "media-creator-replacement",
        });
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
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          profilePhotoRequired: true,
          profileComplete: true,
          missingFields: [],
          missingPlatforms: false,
          completionSteps: [],
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

    await page.goto("/marketplace");

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Let’s create your profile" })).toBeVisible();
    await expect(page.getByLabel("Profile photo file")).toHaveAttribute("required", "");
    await expect(page.getByRole("button", { name: "Upload profile photo" })).toBeVisible();
    await page.getByLabel("Profile photo file").setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: Buffer.from("replacement-image"),
    });
    const continueButton = page.getByRole("button", { name: "Continue to creator profile" });
    await continueButton.click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Temporary profile update failure" }),
    ).toBeVisible();
    expect(uploadSessionRequests).toBe(1);
    expect(uploadFinalizeRequests).toBe(1);
    expect(identityPhotoUpdates).toBe(0);

    await continueButton.click();
    await expect(page.getByRole("heading", { name: "Your profile is ready" })).toBeVisible();
    await page.getByRole("button", { name: "Create my public creator profile" }).click();
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
        {
          platformId: "platform-linkedin",
          platform: "other",
          handle: "LinkedIn",
          profileUrl: "https://www.linkedin.com/in/lina",
          followerCount: 900,
          engagementRate: 2.8,
          audienceCountries: [],
          audienceAgeGroups: [],
          audienceGenderSplit: null,
        },
      ],
      audienceSize: 2100,
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
    await page.getByRole("button", { name: "Platforms", exact: true }).click();
    await expect(page.getByRole("button", { name: "Manage connections" })).toBeDisabled();
    await expect(
      page.getByText("Save or cancel your profile details before managing platform connections."),
    ).toBeVisible();
    await expect(page.getByText("LinkedIn", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save Changes" }).click();

    await expect.poll(() => savedPayload).not.toBeNull();
    expect(savedPayload).toMatchObject({ displayName: "Lina Updated" });
    expect(savedPayload).not.toHaveProperty("platforms");
  });

  test("a completed creator can manage connections without reopening onboarding", async ({
    page,
  }) => {
    await primeBrowserState(page);
    await primeCreatorProfileState(page, "Lina Creator");
    await mockCreatorSession(page, "Lina Creator");

    const creatorProfile = {
      creatorProfileId: "creator-profile-manage-connections",
      displayName: "Lina Creator",
      creatorType: "travel",
      locationText: "Berlin, Germany",
      shortDescription: "I create thoughtful city guides for independent travelers.",
      portfolioUrl: "https://creator.example/portfolio",
      phone: "+49 89 123456",
      profilePictureUrl: "https://media.example/lina.png",
      profilePictureMediaObjectId: "media-lina",
      profileComplete: true,
      profileStatus: "active",
      platforms: [
        {
          platformId: "platform-manual-instagram",
          platform: "instagram",
          handle: "@lina",
          profileUrl: "https://instagram.com/lina",
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
      updatedAt: "2026-07-19T10:00:00.000Z",
    };

    await routeJson(page, /\/api\/marketplace\/creators\/me(?:\?|$)/, creatorProfile);
    await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
      profilePhotoRequired: true,
      profileComplete: true,
      missingFields: [],
      missingPlatforms: false,
      completionSteps: [],
    });
    let connectionRequests = 0;
    await page.route(
      /\/api\/marketplace\/creators\/me\/platform-connections(?:\?|$)/,
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        connectionRequests += 1;
        await route.fulfill({
          status: connectionRequests === 1 ? 503 : 200,
          headers: corsHeaders(route),
          json:
            connectionRequests === 1
              ? { detail: "Connection list unavailable" }
              : { connections: [] },
        });
      },
    );

    await page.goto("/profile");
    await page.getByRole("button", { name: "Platforms", exact: true }).click();
    await page.getByRole("button", { name: "Manage connections" }).click();

    await expect(page).toHaveURL(/\/profile\/complete\?manage-platforms=1$/);
    await expect(page.getByRole("heading", { name: "Show hotels your reach" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Your profile is complete" })).toHaveCount(0);
    const connectSavedAccount = page.getByRole("button", {
      name: "Connect saved @lina Instagram account",
    });
    const savePlatformChanges = page.getByRole("button", { name: "Save platform changes" });
    await expect(
      page.getByRole("alert").filter({ hasText: "Connected accounts could not be loaded." }),
    ).toBeVisible();
    await expect(connectSavedAccount).toBeDisabled();
    await expect(savePlatformChanges).toBeDisabled();

    await page.getByRole("button", { name: "Retry" }).click();
    await expect(connectSavedAccount).toBeEnabled();
    await expect(savePlatformChanges).toBeEnabled();

    await savePlatformChanges.click();
    await expect(page).toHaveURL(/\/profile$/);
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
    await page.goto("/onboarding");

    await expect(
      page.getByText("Loading your session took too long. Please try again."),
    ).toBeVisible({ timeout: 7_000 });
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Retry session" }).click();
    await expect(
      page.getByRole("heading", { name: "Welcome to vayada — what brings you here?" }),
    ).toBeVisible();
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

async function mockCreatorSession(
  page: Page,
  name: string,
  account:
    | string
    | null
    | (() => string | null)
    | {
        phone?: string | null;
        profilePictureUrl?: string | null;
        profilePictureMediaObjectId?: string | null;
      } = "+49 89 123456",
) {
  const sessionResponse = () => ({
    accessToken: "creator-authkit-token",
    csrfToken: "creator-csrf-token",
    organizationId: "22222222-2222-4222-8222-222222222222",
    organizationKind: "creator_workspace",
    user: {
      id: "user-legacy-creator",
      email: "creator@example.test",
      name,
      phone:
        typeof account === "function"
          ? account()
          : typeof account === "object" && account !== null
            ? (account.phone ?? null)
            : account,
      profilePictureUrl:
        typeof account === "object" && account !== null
          ? (account.profilePictureUrl ?? null)
          : null,
      profilePictureMediaObjectId:
        typeof account === "object" && account !== null
          ? (account.profilePictureMediaObjectId ?? null)
          : null,
      status: "active",
    },
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: sessionResponse(),
    });
  });
  await page.route(/\/auth\/session\/refresh$/, (route) =>
    route.fulfill({ status: 200, headers: corsHeaders(route), json: sessionResponse() }),
  );
  await routeJson(page, /\/api\/marketplace\/creators\/me\/platform-connections(?:\?|$)/, {
    connections: [],
  });
  await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
    profilePhotoRequired: true,
    profileComplete: false,
    missingFields: [],
    missingPlatforms: false,
    completionSteps: [],
  });
}

async function mockOnboardingAuth(
  page: Page,
  accountType: "hotel" | "creator" = "hotel",
  expectedFirstName = "Mary Jane",
  expectedPhone = "+49 89 123456",
  expectedInviteCode?: string,
) {
  let personalMediaRequests = 0;
  let onboarded = false;
  let accountName: string | null = null;
  let accountPhone: string | null = "+49 89 123456";
  let accountProfilePictureUrl: string | null = null;
  let accountProfilePictureMediaObjectId: string | null = null;
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
          profilePictureUrl: accountProfilePictureUrl,
          profilePictureMediaObjectId: accountProfilePictureMediaObjectId,
        },
      },
    });
  });
  await page.route(/\/auth\/session\/refresh$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        ...onboardedSession,
        user: {
          ...onboardedSession.user,
          name: accountName,
          phone: accountPhone,
          profilePictureUrl: accountProfilePictureUrl,
          profilePictureMediaObjectId: accountProfilePictureMediaObjectId,
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
      ...(expectedInviteCode ? { inviteCode: expectedInviteCode } : {}),
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
    if (accountType === "creator") {
      expect(payload).toMatchObject({
        profilePictureUrl: "https://media.example/profile.png",
        profilePictureMediaObjectId: "media-profile-e2e",
      });
    } else {
      expect(payload).not.toHaveProperty("profilePictureUrl");
      expect(payload).not.toHaveProperty("profilePictureMediaObjectId");
    }
    accountName =
      payload.firstName && payload.lastName ? `${payload.firstName} ${payload.lastName}` : null;
    accountPhone = payload.phone?.trim() || null;
    accountProfilePictureUrl = payload.profilePictureUrl?.trim() || null;
    accountProfilePictureMediaObjectId = payload.profilePictureMediaObjectId?.trim() || null;
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: { updated: true } });
  });
  await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    personalMediaRequests += 1;
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
  await routeJson(page, /\/api\/marketplace\/creators\/me\/platform-connections(?:\?|$)/, {
    connections: [],
  });
  return { personalMediaRequestCount: () => personalMediaRequests };
}

async function mockInviteAuthenticatedHotel(page: Page, inviteCode: string) {
  const session = {
    accessToken: "invite-hotel-access-token",
    csrfToken: "invite-hotel-csrf-token",
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationKind: "hotel_group",
    user: {
      id: "user-invited-owner",
      email: "owner@example.test",
      name: "Invited Owner",
      phone: "+49 89 123456",
      profilePictureUrl: "https://media.example/invited-owner.png",
      profilePictureMediaObjectId: "media-invited-owner",
      status: "active",
    },
  };
  await routeJson(page, /\/auth\/session(?:\?|$)/, session);
  await page.route(/\/auth\/onboarding$/, async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      type: "hotel",
      surface: "marketplace-web",
      inviteCode,
    });
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: session });
  });
}

async function mockSharedSetupStatus(page: Page) {
  await routeJson(page, /\/api\/hotel-setup\/property-types/, {
    contractVersion: "adaptive-hotel-property-types.v1",
    propertyTypes: [{ value: "hotel", label: "Hotel" }],
  });
  await routeJson(
    page,
    /\/api\/hotel-setup\/status/,
    createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId: "11111111-1111-4111-8111-111111111111",
      organizationDisplayName: "Test Hotel Group",
      selectedTracks: [],
      trackRevision: 0,
      propertyId: null,
      updatedAt: "2026-07-08T00:00:00.000Z",
    }),
  );
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
