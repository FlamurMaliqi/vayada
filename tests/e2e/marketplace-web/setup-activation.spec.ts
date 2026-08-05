import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AdaptiveHotelSetupStatus, SetupTaskId } from "@vayada/domain-hotels";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test.describe("marketplace-web shared setup activation", () => {
  test("uses the shared hotel personal-account step when the saved photo is missing", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          accessToken: "test-access-token",
          csrfToken: "test-csrf-token",
          organizationId: "11111111-1111-4111-8111-111111111111",
          organizationKind: "hotel_group",
          user: {
            id: "user-hotel-owner",
            email: "owner@alpenrose.example",
            name: "Hotel Owner",
            phone: "+49 89 123456",
            profilePictureUrl: null,
            profilePictureMediaObjectId: null,
            status: "active",
          },
        },
      });
    });
    await page.goto(setupUrl(baseURL));

    await expect(page.getByRole("heading", { name: "Let’s create your profile" })).toBeVisible();
    await expect(
      page.getByText("Start with your details. Next, we’ll set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByLabel("First name")).toHaveValue("Hotel");
    await expect(page.getByLabel("Last name")).toHaveValue("Owner");
    await expect(page.getByLabel("Email address")).toHaveValue("owner@alpenrose.example");
    await expect(page.getByLabel("Phone number")).toHaveValue("+49 89 123456");
    await expect(page.getByLabel("Phone number")).toHaveAttribute("required", "");
    await expect(page.getByLabel("Profile photo file")).toHaveAttribute("required", "");
    await expect(page.getByText("Optional", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue to hotel setup" })).toBeVisible();
  });

  test("makes the unsupported hotel external-creator action explicit", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus([], "ready"));
    await routeJson(page, /\/api\/marketplace\/collaborations\/me(?:\?|$)/, {
      contractVersion: "marketplace-collaboration-reads.v1",
      authorizationMode: "hotel_group_resource_link",
      items: [],
    });

    await page.goto(calendarUrl(baseURL));

    const unavailableAction = page.getByRole("button", {
      name: "External creators coming soon",
    });
    await expect(unavailableAction).toBeVisible();
    await expect(unavailableAction).toBeDisabled();
    await expect(unavailableAction).toHaveAttribute(
      "title",
      "Adding creators outside Vayada isn’t available yet.",
    );
    await expect(page.getByRole("button", { name: "Add External Creator" })).toHaveCount(0);
  });

  test("creates the first hotel with the complete shared minimum", async ({ page, baseURL }) => {
    await mockGooglePlaces(page);
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockMarketplaceProfileApis(page, [], [canonicalHeroMedia()]);
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });

    let created = false;
    let creatorTrackSelected = false;
    await page.route(/\/api\/hotel-setup\/status/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: created
          ? sharedSetupStatus([], "ready")
          : creatorTrackSelected
            ? createAdaptiveHotelSetupStatusMock({
                entryProduct: "marketplace",
                organizationId: "11111111-1111-4111-8111-111111111111",
                organizationDisplayName: "Alpenrose Hotel Group",
                selectedTracks: ["creator_marketplace"],
                propertyId: null,
              })
            : emptySharedSetupStatus(),
      });
    });
    await page.route(/\/api\/hotel-setup\/tracks$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      expect(route.request().postDataJSON()).toEqual({
        selectedTracks: ["creator_marketplace"],
        expectedRevision: 0,
      });
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      creatorTrackSelected = true;
      const status = createAdaptiveHotelSetupStatusMock({
        entryProduct: "marketplace",
        organizationId: "11111111-1111-4111-8111-111111111111",
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks: ["creator_marketplace"],
        propertyId: null,
      });
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          trackRevision: 1,
          selectedTracks: ["creator_marketplace"],
          tracks: status.organization.tracks,
        },
      });
    });
    await page.route(/\/api\/hotel-setup\/properties$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const payload = route.request().postDataJSON();
      expect(payload).toMatchObject({
        displayName: "Hotel Alpenrose",
        propertyType: "hotel",
        location: {
          streetAddress: "Marienplatz 1",
          postalCode: "80331",
          city: "Munich",
          countryCode: "DE",
          localityPublic: false,
          geoPublic: false,
          mapDisplayMode: "hidden",
        },
        contacts: [
          {
            channelType: "email",
            value: "owner@alpenrose.example",
            purpose: "general",
            isPublic: false,
          },
          {
            channelType: "phone",
            value: "+49 89 123456",
            purpose: "general",
            isPublic: false,
          },
          {
            channelType: "website",
            value: "https://alpenrose.example",
            purpose: "general",
            isPublic: false,
          },
        ],
      });
      expect(payload.location.timezone).toMatch(/\//);
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      created = true;
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: sharedPropertyProfile(payload),
      });
    });

    await page.goto(setupUrl(baseURL));

    await expect(page.getByRole("heading", { name: "Choose how you’ll use Vayada" })).toBeVisible();
    await page.getByLabel("Creator Marketplace").locator("xpath=ancestor::label").click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Let’s get to know your hotel" })).toBeVisible();
    const hotelName = page.getByRole("textbox", { name: /Hotel name/ });
    await hotelName.fill("Hotel Alpenrose");
    await expect(hotelName).toHaveValue("Hotel Alpenrose");
    await page.locator('label:has(input[type="radio"][value="hotel"])').click();
    await expect(page.getByRole("radio", { name: "Hotel", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Continue" }).click();

    const locationSearchPanel = page.getByTestId("location-search-panel");
    const locationActionBar = page.getByTestId("location-action-bar");
    const locationHeading = locationSearchPanel.getByRole("heading", {
      name: "Where is your property?",
      level: 1,
    });
    await expect(locationHeading).toBeVisible();
    await expect(locationHeading).toBeFocused();
    const locationContinueButton = locationActionBar.getByRole("button", {
      name: "Continue",
    });
    await expect(locationContinueButton).toBeEnabled();
    await expect(locationActionBar.getByText("Is this the right location?")).toHaveCount(0);
    await expect(page.getByText("Search for your hotel address", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText(
        "Start with a street name. Add the house number or city to narrow the suggestions.",
        { exact: true },
      ),
    ).toHaveCount(0);
    const manualAddressButton = locationSearchPanel.getByRole("button", {
      name: "Enter address manually",
    });
    const streetAddress = page.getByRole("textbox", { name: /Street address/ });
    const searchFirst = await manualAddressButton.isVisible();
    if (
      process.env.CI === "true" ||
      process.env.E2E_START_SERVERS === "1" ||
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
    ) {
      expect(searchFirst).toBe(true);
    }
    if (searchFirst) {
      await expect(streetAddress).toHaveCount(0);
      const addressSearch = locationSearchPanel.getByPlaceholder("Search for an address");
      await expect(addressSearch).toBeVisible();
      const googleAddressSearch = page.locator(".vayada-google-place-autocomplete");
      await expect(googleAddressSearch).toHaveAttribute(
        "data-included-primary-types",
        "street_address,route",
      );
      await selectExactGoogleAddress(googleAddressSearch);
      await expect(locationHeading).toBeInViewport();
      await expect(locationActionBar.getByText("Is this the right location?")).toBeVisible();
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-center",
        "48.1373932,11.5754485",
      );
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-zoom",
        "17",
      );
      await expect(page.getByTestId("google-address-map-canvas")).toHaveAttribute(
        "data-marker",
        "48.1373932,11.5754485",
      );
      await expect(locationContinueButton).toBeEnabled();

      await page.setViewportSize({ width: 390, height: 844 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await expect(locationContinueButton).toBeInViewport();
      await addressSearch.focus();
      await googleAddressSearch.dispatchEvent("gmp-error");
      await expect(streetAddress).toBeFocused();
      await expect(streetAddress).toBeInViewport();
    }

    if (searchFirst) await expect(streetAddress).toBeFocused();
    await streetAddress.fill("Marienplatz 1");
    await page.getByRole("textbox", { name: /Postal code/ }).fill("80331");
    await page.getByRole("textbox", { name: /City/ }).fill("Munich");
    const countrySelect = page.getByRole("combobox", { name: /Country/ });
    await expect(countrySelect.locator('option[value="PR"]')).toHaveCount(1);
    await countrySelect.selectOption("DE");
    await expect(locationContinueButton).toBeEnabled();

    if (searchFirst) {
      await locationSearchPanel.getByRole("button", { name: "Done editing" }).click();
      await expect(locationActionBar.getByText("Address details entered")).toBeVisible();
      await expect(
        locationActionBar.getByText("Marienplatz 1, 80331 Munich, Germany"),
      ).toBeVisible();
      await locationSearchPanel.getByRole("button", { name: "Edit address details" }).click();
      await expect(streetAddress).toBeFocused();
    }

    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("textbox", { name: /Contact email/ }).fill("owner@alpenrose.example");
    await page.getByRole("textbox", { name: /Phone number/ }).fill("+49 89 123456");
    await page.getByRole("textbox", { name: /Website/ }).fill("https://alpenrose.example");
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(page.getByRole("img", { name: "vayada" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Review and next steps", level: 1 }),
    ).toBeVisible();
    const marketplaceProgress = page.getByRole("progressbar", {
      name: "Hotel setup progress",
    });
    await expect(marketplaceProgress).toHaveAttribute("aria-valuemin", "1");
    await expect(marketplaceProgress).toHaveAttribute("aria-valuemax", "4");
    await expect(marketplaceProgress).toHaveAttribute("aria-valuenow", "4");
    await expect(marketplaceProgress).toHaveAttribute(
      "aria-valuetext",
      "Step 4 of 4: Review and next steps",
    );
    await expect(marketplaceProgress.locator('[data-state="reached"]')).toHaveCount(4);
    await expect(marketplaceProgress.locator('[data-state="upcoming"]')).toHaveCount(0);
    await expect(page.getByText("Step 4 of 4", { exact: true })).toBeVisible();
    const review = page.locator('section[aria-labelledby="setup-review-title"]');
    await expect(review).toBeVisible();
    await expect(
      review.locator("dt", { hasText: /^Creator Marketplace$/ }).locator("xpath=../.."),
    ).toContainText("Ready");
    await expect(
      review.locator("dt", { hasText: /^Hotel operations$/ }).locator("xpath=../.."),
    ).toContainText("Not selected");
    await expect(
      review.locator("dt", { hasText: /^Direct booking$/ }).locator("xpath=../.."),
    ).toContainText("Not selected");
    await review.getByRole("button", { name: "Back" }).click();
    await expect(
      page.getByRole("heading", { name: "Prepare your collaboration offer" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Return to review" }).click();
    await expect(review).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("shows both selected tracks as one inline property-scoped setup flow", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedRoadmapStatus());
    await mockMarketplaceProfileApis(page, [], [canonicalHeroMedia()]);

    await page.goto(setupUrl(baseURL));

    await expect(page.getByRole("img", { name: "vayada" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Describe your hotel" }),
    ).toBeVisible();
    await expect(page.getByText("Setting up", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Alpenrose Munich", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Hotel Operations", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Creator Marketplace", { exact: true })).toHaveCount(0);
    const setupProgress = page.getByRole("progressbar", { name: "Hotel setup progress" });
    await expect(setupProgress).toHaveAttribute("aria-valuemax", "8");
    await expect(setupProgress).toHaveAttribute("aria-valuenow", "2");
    await expect(setupProgress).toHaveAttribute(
      "aria-valuetext",
      "Step 2 of 8: Describe your hotel",
    );
    await expect(setupProgress.locator('[data-state="reached"]')).toHaveCount(2);
    await expect(setupProgress.locator('[data-state="upcoming"]')).toHaveCount(6);
    await expect(page.getByText("Step 2 of 8", { exact: true })).toBeVisible();
    await expect(page.locator("aside")).toHaveCount(0);
    const currentStep = page.locator('section[aria-labelledby="current-setup-step-title"]');
    const formCard = page.getByTestId("hotel-setup-form-card");
    await expect(currentStep.getByRole("textbox", { name: "Hotel description" })).toBeVisible();
    await expect(formCard.getByRole("textbox", { name: "Hotel description" })).toBeVisible();
    await expect(formCard.getByRole("heading", { name: "Describe your hotel" })).toHaveCount(0);
    await expect(formCard.getByText("Step 2 of 8", { exact: true })).toHaveCount(0);
    await expect(formCard.locator("form")).toHaveCount(1);
    await expect(currentStep.getByRole("button", { name: "Save hotel profile" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue setup" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/setup\?/);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const progressBox = await setupProgress.boundingBox();
    const stepHeadingBox = await currentStep
      .getByRole("heading", { name: "Describe your hotel" })
      .boundingBox();
    const formCardBox = await formCard.boundingBox();
    expect(progressBox?.y).toBeLessThan(stepHeadingBox?.y ?? Number.POSITIVE_INFINITY);
    expect(stepHeadingBox?.y).toBeLessThan(formCardBox?.y ?? Number.POSITIVE_INFINITY);
  });

  test("keeps future Operations forms in the guided sequence", async ({ page, baseURL }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedRoadmapStatus());
    await mockMarketplaceProfileApis(page, [], [canonicalHeroMedia()]);
    let handoffRequests = 0;
    await page.route(/\/api\/hotel-setup\/handoffs(?:\?|$)/, async (route) => {
      handoffRequests += 1;
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 500,
        headers: corsHeaders(route),
        json: { error: "Inline setup must not create a handoff." },
      });
    });

    await page.goto(setupUrl(baseURL));

    const currentStep = page.locator('section[aria-labelledby="current-setup-step-title"]');
    await expect(currentStep.getByRole("heading", { name: "Describe your hotel" })).toBeVisible();
    await expect(currentStep.getByRole("textbox", { name: "Hotel description" })).toBeVisible();
    const inlineSetupUrl = page.url();

    const setupProgress = page.getByRole("progressbar", {
      name: "Hotel setup progress",
    });
    await expect(setupProgress).toHaveAttribute("aria-valuemax", "8");
    await expect(setupProgress).toHaveAttribute("aria-valuenow", "2");
    await expect(
      page.getByRole("heading", { name: "Set up rooms, rates, and availability" }),
    ).toHaveCount(0);
    expect(page.url()).toBe(inlineSetupUrl);
    expect(handoffRequests).toBe(0);
  });

  test("renders the recommended Operations form inline without leaving setup", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedRoadmapStatus("rooms_rates_availability"));
    await mockOperationsApis(page);
    let handoffRequests = 0;
    await page.route(/\/api\/hotel-setup\/handoffs(?:\?|$)/, async (route) => {
      handoffRequests += 1;
      await route.fulfill({
        status: 500,
        headers: corsHeaders(route),
        json: { error: "Inline setup must not create a handoff." },
      });
    });

    await page.goto(setupUrl(baseURL));

    const inlineSetupUrl = page.url();
    const currentStep = page.locator('section[aria-labelledby="current-setup-step-title"]');
    await expect(
      currentStep.getByRole("heading", { name: "Set up rooms, rates, and availability" }),
    ).toBeVisible();
    await expect(currentStep.getByLabel("Room type name")).toBeVisible();
    await expect(currentStep.getByLabel("Number of rooms")).toBeVisible();
    await expect(currentStep.getByLabel("Nightly rate")).toBeVisible();
    await expect(currentStep.getByRole("button", { name: "Save rooms and rates" })).toBeVisible();
    expect(page.url()).toBe(inlineSetupUrl);
    expect(handoffRequests).toBe(0);
  });

  test("does not submit room setup twice when progress refresh fails", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    const status = sharedRoadmapStatus("rooms_rates_availability");
    let roomPostCount = 0;
    let roomSaved = false;

    await page.route(/\/api\/hotel-setup\/status/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill(
        roomSaved
          ? {
              status: 503,
              headers: corsHeaders(route),
              json: { detail: "Setup status is temporarily unavailable." },
            }
          : {
              status: 200,
              headers: corsHeaders(route),
              json: status,
            },
      );
    });
    await page.route(
      new RegExp(`/api/pms/properties/${propertyId}/room-types(?:\\?|$)`),
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            headers: corsHeaders(route),
            json: {
              contractVersion: "pms-operations.v1",
              propertyId,
              items: [],
              sourceFreshness: {},
            },
          });
          return;
        }
        roomPostCount += 1;
        roomSaved = true;
        await route.fulfill({
          status: 201,
          headers: corsHeaders(route),
          json: {
            contractVersion: "pms-operations.v1",
            propertyId,
            item: {},
            commandMeta: {},
          },
        });
      },
    );

    await page.goto(setupUrl(baseURL));
    const currentStep = page.locator('section[aria-labelledby="current-setup-step-title"]');
    await currentStep.getByLabel("Room type name").fill("Alpine Suite");
    await currentStep.getByRole("button", { name: "Save rooms and rates" }).click();

    await expect(currentStep.getByText("Rooms and rates were saved.")).toBeVisible();
    const refresh = currentStep.getByRole("button", { name: "Refresh setup progress" });
    await expect(refresh).toBeVisible();
    expect(roomPostCount).toBe(1);

    await refresh.click();
    await expect(currentStep.getByText("Rooms and rates were saved.")).toBeVisible();
    expect(roomPostCount).toBe(1);
  });

  test("shows only Hotel Operations steps when Marketplace is not selected", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, operationsOnlyStatus());
    await mockOperationsApis(page);

    await page.goto(setupUrl(baseURL));

    const setupProgress = page.getByRole("progressbar", { name: "Hotel setup progress" });
    await expect(setupProgress).toHaveAttribute("aria-valuemax", "6");
    await expect(setupProgress.locator('[data-state="reached"]')).toHaveCount(2);
    await expect(setupProgress.locator('[data-state="upcoming"]')).toHaveCount(4);
    await expect(
      page.getByRole("heading", { name: "Set up rooms, rates, and availability" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Describe your hotel" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Prepare your collaboration offer" }),
    ).toHaveCount(0);
  });

  for (const returnCase of [
    {
      source: "Booking",
      entryProduct: "pms",
      returnProduct: "booking",
      returnTo: "/settings?section=booking",
      requestedProductCanOpen: true,
    },
    {
      source: "PMS",
      entryProduct: "marketplace",
      returnProduct: "pms",
      returnTo: "/reservations?view=arrivals",
      requestedProductCanOpen: false,
    },
  ] as const) {
    test(`exits to the exact ${returnCase.source} path independently of the requested product`, async ({
      page,
      baseURL,
    }) => {
      await primeBrowserState(page, true);
      await mockAuthSession(page);
      await mockSharedSetupStatus(
        page,
        operationsOnlyStatus(returnCase.entryProduct, returnCase.requestedProductCanOpen),
      );
      await mockOperationsApis(page);

      const expectedReturnUrl = new URL(
        returnCase.returnTo,
        productAppOrigin(returnCase.returnProduct),
      ).toString();
      await page.route(/\/__before-canonical-setup$/, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Before setup</title><h1>Before setup</h1>",
        }),
      );
      await page.route(
        (url) => url.toString() === expectedReturnUrl,
        (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><title>${returnCase.source}</title><h1>${returnCase.source} return</h1>`,
          }),
      );

      await page.goto("/__before-canonical-setup");
      await page.goto(
        productSetupUrl(baseURL, {
          entryProduct: returnCase.entryProduct,
          returnProduct: returnCase.returnProduct,
          returnTo: returnCase.returnTo,
        }),
      );
      await page.getByRole("button", { name: "Exit setup" }).click();

      await expect.poll(() => page.url()).toBe(expectedReturnUrl);
      await expect(
        page.getByRole("heading", { name: `${returnCase.source} return` }),
      ).toBeVisible();
      await page.goBack();
      await expect(page.getByRole("heading", { name: "Before setup" })).toBeVisible();
    });
  }

  test("uploads a canonical hotel cover, saves both profiles, and advances to the collaboration offer", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    const publicProfileUpdates: unknown[] = [];
    const marketplaceProfileUpdates: unknown[] = [];
    const propertyPresentationUpdates: unknown[] = [];
    const uploadedMediaObjectId = "00000000-0000-4000-8000-000000000099";
    let uploadSessionRequest: Record<string, unknown> | null = null;
    let uploadFinalized = false;
    await page.route(/\/api\/hotel-setup\/status/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const profileSaved = publicProfileUpdates.length > 0 && marketplaceProfileUpdates.length > 0;
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: profileSaved
          ? sharedSetupStatus(["marketplaceOffer"])
          : sharedSetupStatus(["publicProfile"]),
      });
    });
    await mockMarketplaceProfileApis(page, [], [], {
      publicProfile: publicProfileUpdates,
      marketplaceProfile: marketplaceProfileUpdates,
      propertyPresentation: propertyPresentationUpdates,
    });
    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().url().endsWith("/finalize")) {
        uploadFinalized = true;
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            mediaObjects: [
              {
                mediaId: uploadedMediaObjectId,
                storageKey: "private/media/uploaded-cover.webp",
                contentType: "image/webp",
                sizeBytes: 11,
                originalFilename: "hotel-cover.webp",
                variants: [
                  {
                    publicCdnUrl: null,
                    storageKey: "private/media/uploaded-cover.webp",
                  },
                ],
              },
            ],
          },
        });
        return;
      }
      uploadSessionRequest = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: {
          uploadSession: { sessionId: "hotel-cover-e2e" },
          uploadTargets: [
            {
              uploadTargetId: "hotel-cover-target-e2e",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/hotel-cover-e2e",
              headers: {},
            },
          ],
        },
      });
    });

    await page.goto(setupUrl(baseURL));

    const setupProgress = page.getByTestId("hotel-setup-progress");
    await expect(setupProgress.getByRole("button", { name: "Exit setup" })).toBeVisible();
    await expect(page.getByText("Setting up", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Alpenrose Munich", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add another service" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open Creator Marketplace" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { level: 1, name: "Describe your hotel" }),
    ).toBeVisible();

    const description = page.getByLabel("Hotel description", { exact: true });
    await expect(description).toHaveCount(1);
    await expect(page.locator("textarea")).toHaveCount(1);
    const sharedCopy =
      "An independent Munich stay that gives guests and creators a memorable city base.";
    await description.fill(sharedCopy);
    await page.getByLabel("Hotel cover photo file").setInputFiles({
      name: "hotel-cover.webp",
      mimeType: "image/webp",
      buffer: Buffer.from("hotel-cover"),
    });
    const saveProfile = page.getByRole("button", { name: "Save hotel profile" });
    await expect(saveProfile).toBeEnabled();
    await saveProfile.click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Prepare your collaboration offer" }),
    ).toBeVisible();
    expect(publicProfileUpdates).toEqual([
      {
        expectedProfileRevision: 2,
        patch: { shortDescription: sharedCopy },
      },
    ]);
    expect(uploadSessionRequest).toMatchObject({
      purpose: "property.hero_image",
      visibility: "private",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
      },
    });
    expect(uploadSessionRequest).not.toHaveProperty("expectedProfileRevision");
    expect(uploadFinalized).toBe(true);
    expect(propertyPresentationUpdates).toEqual([
      {
        expectedProfileRevision: 1,
        assignments: [
          {
            mediaObjectId: uploadedMediaObjectId,
            role: "cover",
            altText: null,
            sortOrder: 0,
          },
        ],
      },
    ]);
    expect(marketplaceProfileUpdates).toEqual([{ hostSummary: sharedCopy }]);
    await expect(page.getByLabel("Hotel description", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: /Show city and country on public Vayada surfaces/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Public hotel cover/ })).toHaveCount(0);
    await expect(page.getByLabel("Offer title", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/setup\?/);
  });

  test("keeps Marketplace pages accessible while Marketplace setup tasks remain", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["publicProfile"]));
    await mockMarketplaceProfileApis(page, [marketplaceOffer("pending")]);
    await routeJson(page, /\/api\/marketplace\/collaborations\/me/, {
      contractVersion: "marketplace-collaboration-reads.v1",
      authorizationMode: "hotel_group_resource_link",
      items: [],
    });

    await page.goto(calendarUrl(baseURL));

    await expect(page).toHaveURL(/\/calendar$/);
    await expect(page.getByRole("button", { name: "External creators coming soon" })).toBeVisible();
  });

  test("reuses the shared hotel hero for a replacement offer", async ({ page, baseURL }) => {
    test.skip(!baseURL, "Playwright base URL is required.");
    await page.setViewportSize({ width: 2048, height: 1125 });
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["offerDeliverables"]));
    const sharedHeroUrl = "https://media.example/alpenrose.webp";
    await mockMarketplaceProfileApis(
      page,
      [marketplaceOffer("rejected")],
      [
        {
          mediaType: "hero_image",
          url: sharedHeroUrl,
          altText: "Hotel Alpenrose",
          sortOrder: 0,
        },
      ],
    );
    await page.route(sharedHeroUrl, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders(route), "content-type": "image/webp" },
        body: Buffer.from("shared-hotel-photo"),
      });
    });
    let createdOfferPayload: Record<string, unknown> | null = null;
    let updatedOfferPayload: Record<string, unknown> | null = null;
    let uploadFinalized = false;
    await page.route(
      new RegExp(`/api/marketplace/properties/${propertyId}/offers(?:\\?|$)`),
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        if (route.request().method() === "POST") {
          createdOfferPayload = route.request().postDataJSON() as Record<string, unknown>;
          await route.fulfill({
            status: 201,
            headers: corsHeaders(route),
            json: createdMarketplaceOffer(createdOfferPayload),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: { offers: [marketplaceOffer("rejected")] },
        });
      },
    );
    await page.route(
      new RegExp(`/api/marketplace/properties/${propertyId}/offers/created-offer$`),
      async (route) => {
        if (route.request().method() === "OPTIONS") {
          await fulfillCorsPreflight(route);
          return;
        }
        updatedOfferPayload = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            ...createdMarketplaceOffer(createdOfferPayload ?? {}),
            media: [
              {
                mediaObjectId: "offer-media-e2e",
                url: "https://media.example/offer.png",
              },
            ],
          },
        });
      },
    );
    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().url().endsWith("/finalize")) {
        uploadFinalized = true;
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            mediaObjects: [
              {
                mediaId: "offer-media-e2e",
                storageKey: "private/marketplace/offers/offer-media-e2e/original-safe.webp",
                contentType: "image/webp",
                sizeBytes: 11,
                originalFilename: "shared-hotel-photo-1.webp",
                variants: [
                  {
                    publicCdnUrl: null,
                    storageKey: "private/marketplace/offers/offer-media-e2e/original-safe.webp",
                  },
                ],
              },
            ],
          },
        });
        return;
      }
      expect(route.request().postDataJSON()).toMatchObject({
        purpose: "marketplace.offer.media",
        files: [
          expect.objectContaining({
            filename: "shared-hotel-photo-1.webp",
            contentType: "image/webp",
          }),
        ],
        resource: {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: "created-offer",
        },
      });
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: {
          uploadSession: { sessionId: "offer-e2e" },
          uploadTargets: [
            {
              uploadTargetId: "offer-target-e2e",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/offer-e2e",
              headers: {},
            },
          ],
        },
      });
    });

    await page.goto(setupUrl(baseURL));
    const inlineSetupUrl = page.url();

    await expect(
      page.getByRole("heading", { level: 1, name: "Prepare your collaboration offer" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Offer details" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Offerings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Looking For", exact: true })).toBeVisible();
    await expect(page.getByText("Your collaboration offer is already saved")).toHaveCount(0);
    const completeSetup = page.getByRole("button", { name: "Save collaboration offer" });
    await expect(completeSetup).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.getByLabel("Offer title", { exact: true }).fill("Three-night creator stay");
    await page
      .getByLabel(/Description/)
      .fill("A memorable city stay with breakfast and a guided local experience.");
    await expect(page.getByAltText("Three-night creator stay main photo")).toHaveAttribute(
      "src",
      sharedHeroUrl,
    );
    const offerings = page
      .getByRole("heading", { name: "Offerings" })
      .locator("xpath=ancestor::section[1]");
    const requirements = page
      .getByRole("heading", { name: "Looking For", exact: true })
      .locator("xpath=ancestor::section[1]");
    await offerings.getByText("Affiliate", { exact: true }).click();
    await offerings.getByRole("button", { name: "Select All Year" }).click();
    await offerings.getByText("Instagram", { exact: true }).click();
    await requirements.getByText("TikTok", { exact: true }).click();
    await expect(completeSetup).toBeEnabled();
    await expect(offerings.getByRole("checkbox", { name: "Affiliate" })).toBeChecked();
    await expect(offerings.getByRole("checkbox", { name: "Instagram" })).toBeChecked();
    await expect(requirements.getByRole("checkbox", { name: "TikTok" })).toBeChecked();

    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await completeSetup.click();
    await expect.poll(() => createdOfferPayload).not.toBeNull();
    expect(createdOfferPayload).toMatchObject({
      deliverables: [
        {
          platform: "instagram",
          deliverableType: "content",
          quantity: 1,
          timingGuidance: null,
        },
      ],
      compensationOptions: [expect.objectContaining({ platforms: ["instagram"] })],
      creatorRequirements: expect.objectContaining({ platforms: ["tiktok"] }),
    });
    await expect.poll(() => uploadFinalized).toBe(true);
    await expect.poll(() => updatedOfferPayload).not.toBeNull();
    expect(page.url()).toBe(inlineSetupUrl);
  });

  test("autosaves an unfinished collaboration draft before exiting the canonical flow", async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, "Playwright base URL is required.");
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["marketplaceOffer"]));
    await mockMarketplaceProfileApis(page, []);

    await page.goto(setupUrl(baseURL));
    await expect(
      page.getByRole("heading", { level: 1, name: "Prepare your collaboration offer" }),
    ).toBeVisible();
    await expect(page.getByTestId("marketplace-offer-draft-note")).toContainText(
      "you may need to select them again",
    );
    await page.getByLabel("Offer title", { exact: true }).fill("Draft creator stay");
    await page
      .getByLabel(/Description/)
      .fill("A draft collaboration stay that can be completed after returning.");

    await expect
      .poll(() =>
        page.evaluate((draftPropertyId) => {
          const value = localStorage.getItem(`vayada_hotel_marketplace_draft:${draftPropertyId}`);
          return value ? JSON.parse(value) : null;
        }, propertyId),
      )
      .toMatchObject({
        currentStep: 1,
        listings: [
          {
            name: "Draft creator stay",
            description: "A draft collaboration stay that can be completed after returning.",
          },
        ],
      });

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Exit setup" }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/marketplace");
  });

  test("restores a hotel offer draft after a reload and asks only for local photos again", async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, "Playwright base URL is required.");
    await primeBrowserState(page, true);
    await page.addInitScript(
      ({ draftPropertyId }) => {
        localStorage.setItem(
          `vayada_hotel_marketplace_draft:${draftPropertyId}`,
          JSON.stringify({
            version: 3,
            savedAt: Date.now(),
            currentStep: 4,
            form: {
              about:
                "Alpenrose gives travel creators a welcoming base for memorable Munich stories.",
              localityPublic: true,
            },
            listings: [
              {
                name: "Restored creator stay",
                location: "Munich, DE",
                description: "A restored city stay with breakfast and a local experience.",
                accommodation_type: "hotel",
                images: [],
                imageMediaObjectIds: [],
                collaborationTypes: ["Free Stay"],
                availability: ["Jan"],
                platforms: ["Instagram"],
                freeStayMinNights: 2,
                freeStayMaxNights: 3,
                lookingForPlatforms: ["TikTok"],
                targetGroupCountries: [],
                targetGroupAgeGroups: [],
              },
            ],
            omittedLocalPhotos: true,
          }),
        );
      },
      { draftPropertyId: propertyId },
    );
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["marketplaceOffer"]));
    await mockMarketplaceProfileApis(page, []);

    await page.goto(setupUrl(baseURL));

    await expect(
      page.getByRole("alert").filter({ hasText: "Your saved offer details were restored" }),
    ).toContainText("Select the local photos again");
    await expect(page.getByLabel("Offer title", { exact: true })).toHaveValue(
      "Restored creator stay",
    );
    await expect(page.getByLabel(/Description/)).toHaveValue(
      "A restored city stay with breakfast and a local experience.",
    );
    await expect(page.getByRole("button", { name: "Save collaboration offer" })).toBeDisabled();
    await expect(page.getByLabel("Hotel description", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("checkbox", { name: /Show city and country on public Vayada surfaces/ }),
    ).toHaveCount(0);
  });

  test("asks for a replacement offer when the existing Marketplace offer was rejected", async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, "Playwright base URL is required.");
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["marketplaceOffer"]));
    await mockMarketplaceProfileApis(page, [marketplaceOffer("rejected")]);

    await page.goto(setupUrl(baseURL));

    await expect(
      page.getByRole("heading", { level: 1, name: "Prepare your collaboration offer" }),
    ).toBeVisible();
    await expect(page.getByLabel("Offer title", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Hotel description", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Your collaboration offer is already saved")).toHaveCount(0);
  });

  test("blocks suspended Marketplace activation instead of opening profile tools", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus([], "suspended"));

    await page.goto(setupUrl(baseURL));

    await expect(
      page.getByText("Creator Marketplace is not available for this hotel right now.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue setup" })).toHaveCount(0);
  });

  test("blocks a direct suspended activation URL before loading Marketplace profile data", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus([], "suspended"));
    let loadedMarketplaceProfile = false;
    await page.route(/\/api\/marketplace\/properties\/.*\/(?:profile|offers)/, async (route) => {
      loadedMarketplaceProfile = true;
      await route.abort();
    });

    await page.goto(profileActivationUrl(baseURL));

    await expect(page).toHaveURL(new RegExp(`/setup\\?.*propertyId=${propertyId}`));
    await expect(
      page.getByText("Creator Marketplace is not available for this hotel right now.", {
        exact: false,
      }),
    ).toBeVisible();
    expect(loadedMarketplaceProfile).toBe(false);
  });

  test("rejects property and organization hints on a Marketplace task URL", async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, "Playwright base URL is required.");
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["publicProfile"]));
    let loadedMarketplaceProfile = false;
    await page.route(/\/api\/marketplace\/properties\/.*\/(?:profile|offers)/, async (route) => {
      loadedMarketplaceProfile = true;
      await route.abort();
    });

    const url = new URL(profileActivationUrl(baseURL), baseURL);
    url.searchParams.set("propertyId", propertyId);
    url.searchParams.set("organizationId", "untrusted");
    await page.goto(url.toString());

    await expect(page).toHaveURL(new RegExp("/setup\\?"));
    expect(loadedMarketplaceProfile).toBe(false);
  });

  test("shows Marketplace verification as pending without asking for more setup", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus([], "pending_review"));

    await page.goto(setupUrl(baseURL));

    const review = page.locator('section[aria-labelledby="setup-review-title"]');
    await expect(
      review.locator("dt", { hasText: /^Creator Marketplace$/ }).locator("xpath=../.."),
    ).toContainText("Pending");
    await expect(page.getByRole("button", { name: "Continue setup" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open Creator Marketplace" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Add another service" })).toBeVisible();
    const setupProgress = page.getByTestId("hotel-setup-progress");
    await expect(setupProgress.getByRole("button", { name: "Exit setup" })).toBeVisible();
    await expect(setupProgress.getByRole("button", { name: "Add another service" })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });
});

async function mockGooglePlaces(page: Page) {
  await page.route(/https:\/\/maps\.googleapis\.com\/maps\/api\/js/, async (route) => {
    expect(new URL(route.request().url()).searchParams.get("language")).toBe("en");
    await route.fulfill({
      contentType: "application/javascript",
      body: `
        const elementName = "vayada-e2e-place-autocomplete";
        let PlaceAutocompleteElement = customElements.get(elementName);
        if (!PlaceAutocompleteElement) {
          PlaceAutocompleteElement = class extends HTMLElement {
            constructor(options) {
              super();
              const root = this.attachShadow({ mode: "open" });
              const input = document.createElement("input");
              input.setAttribute("part", "input");
              input.setAttribute("aria-label", options.description);
              input.placeholder = options.placeholder;
              root.append(input);
              this.dataset.includedPrimaryTypes = options.includedPrimaryTypes.join(",");
            }
          };
          customElements.define(elementName, PlaceAutocompleteElement);
        }
        class GoogleMap {
          constructor(element, options) {
            this.element = element;
            this.setCenter(options.center);
            this.setZoom(options.zoom);
          }
          setCenter(position) {
            this.element.dataset.center = position.lat + "," + position.lng;
          }
          setZoom(zoom) {
            this.element.dataset.zoom = String(zoom);
          }
        }
        class GoogleMarker {
          constructor(options) {
            this.element = options.map.element;
            this.setPosition(options.position);
          }
          setPosition(position) {
            if (position) {
              this.element.dataset.marker = position.lat + "," + position.lng;
            } else {
              delete this.element.dataset.marker;
            }
          }
        }
        window.google = {
          maps: {
            importLibrary: async (library) =>
              library === "maps"
                ? { Map: GoogleMap }
                : library === "marker"
                  ? { Marker: GoogleMarker }
                  : { PlaceAutocompleteElement },
          },
        };
        window.__vayadaGoogleMapsReady?.();
      `,
    });
  });
}

async function selectExactGoogleAddress(autocomplete: Locator) {
  await autocomplete.evaluate((element) => {
    const event = new Event("gmp-select");
    Object.defineProperty(event, "placePrediction", {
      value: {
        types: ["street_address"],
        toPlace: () => ({
          fetchFields: async () => undefined,
          location: { lat: () => 48.1373932, lng: () => 11.5754485 },
          postalAddress: {
            addressLines: ["Marienplatz 1"],
            administrativeArea: "Bavaria",
            locality: "Munich",
            postalCode: "80331",
            regionCode: "DE",
          },
        }),
      },
    });
    element.dispatchEvent(event);
  });
}

function setupUrl(baseURL: string | undefined) {
  const path = "/setup?entryProduct=marketplace&returnProduct=marketplace&returnTo=/marketplace";
  if (!baseURL) return path;

  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") {
    url.hostname = "localhost";
    url.pathname = "/setup";
    url.search = "?entryProduct=marketplace&returnProduct=marketplace&returnTo=/marketplace";
    return url.toString();
  }
  return path;
}

function productSetupUrl(
  baseURL: string | undefined,
  input: {
    entryProduct: "booking" | "marketplace" | "pms";
    returnProduct: "booking" | "marketplace" | "pms";
    returnTo: string;
  },
): string {
  const query = new URLSearchParams(input);
  if (!baseURL) return `/setup?${query.toString()}`;

  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") {
    url.hostname = "localhost";
  }
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}

function productAppOrigin(product: "booking" | "pms"): string {
  const startServers = process.env.CI === "true" || process.env.E2E_START_SERVERS === "1";
  if (product === "booking") {
    return (
      process.env.E2E_BOOKING_ADMIN_BASE_URL ||
      (startServers ? "http://admin.booking.localhost:3003" : "https://admin.booking.localhost")
    );
  }
  return (
    process.env.E2E_PMS_BASE_URL ||
    (startServers ? "http://pms.localhost:3004" : "https://pms.localhost")
  );
}

function profileActivationUrl(baseURL: string | undefined) {
  const url = new URL(baseURL ?? "https://marketplace.localhost");
  if (url.hostname === "127.0.0.1" && url.port === "3000") {
    url.hostname = "localhost";
  }
  const returnUrl = new URL("/setup", url.origin);
  returnUrl.searchParams.set("propertyId", propertyId);
  url.pathname = "/profile/complete";
  url.search = new URLSearchParams({
    activation: "marketplace",
    taskId: "creator_offer",
    destinationRouteKey: "marketplace.creator_offer",
    planRevision: "e2e-plan-1",
    returnUrl: returnUrl.toString(),
  }).toString();
  return baseURL ? url.toString() : `${url.pathname}${url.search}`;
}

function calendarUrl(baseURL: string | undefined) {
  if (!baseURL) return "/calendar";

  const url = new URL(baseURL);
  url.pathname = "/calendar";
  return url.toString();
}

async function primeBrowserState(page: Page, hotelProfile = false) {
  await page.addInitScript(
    ({ primeHotelProfile, selectedPropertyId }) => {
      localStorage.setItem(
        "vayada_cookie_consent",
        JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
      );
      if (primeHotelProfile) {
        localStorage.setItem("userType", "hotel");
        localStorage.setItem("selectedSharedPropertyId", selectedPropertyId);
      }
    },
    { primeHotelProfile: hotelProfile, selectedPropertyId: propertyId },
  );
}

async function mockAuthSession(page: Page) {
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId: "11111111-1111-4111-8111-111111111111",
        workosOrganizationId: "org_workos_hotel_group",
        organizationKind: "hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@alpenrose.example",
          name: "Owner Example",
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/owner.webp",
          profilePictureMediaObjectId: "media-owner",
          status: "active",
          workosUserId: "user_workos_hotel_owner",
        },
      },
    });
  });
}

async function mockSharedSetupStatus(page: Page, status: AdaptiveHotelSetupStatus) {
  await page.route(/\/api\/hotel-setup\/status/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: status,
    });
  });
}

async function mockOperationsApis(page: Page) {
  await page.route(
    new RegExp(`/api/pms/properties/${propertyId}/room-types(?:\\?|$)`),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            contractVersion: "pms-operations.v1",
            propertyId,
            items: [],
            sourceFreshness: {},
          },
        });
        return;
      }
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: {
          contractVersion: "pms-operations.v1",
          propertyId,
          item: {},
          commandMeta: {},
        },
      });
    },
  );
}

async function mockMarketplaceProfileApis(
  page: Page,
  offers: unknown[] = [],
  media: unknown[] = [],
  writes?: {
    publicProfile?: unknown[];
    marketplaceProfile?: unknown[];
    propertyPresentation?: unknown[];
  },
) {
  await routeJson(page, new RegExp(`/api/marketplace/properties/${propertyId}/profile-status`), {
    profile_complete: false,
    missing_fields: ["profile"],
    has_defaults: { location: false },
    missing_offers: false,
    completion_steps: ["Complete your marketplace hotel profile"],
  });
  let canonicalProfile = sharedPropertyProfile({
    displayName: "Alpenrose Munich",
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      city: "Munich",
      streetAddress: "Marienplatz 1",
      postalCode: "80331",
      timezone: "Europe/Berlin",
      latitude: null,
      longitude: null,
      localityPublic: true,
      geoPublic: true,
      mapDisplayMode: "exact",
    },
    contacts: [
      {
        channelType: "website",
        value: "https://alpenrose.example",
        purpose: "general",
        isPublic: true,
      },
      {
        channelType: "email",
        value: "owner@alpenrose.example",
        purpose: "general",
        isPublic: false,
      },
      {
        channelType: "phone",
        value: "+49 89 123456",
        purpose: "general",
        isPublic: false,
      },
    ],
  });
  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/profile`),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") {
        const request = route.request().postDataJSON() as Record<string, unknown>;
        expect(request).toEqual({
          expectedProfileRevision: canonicalProfile.profileRevision,
          patch: expect.any(Object),
        });
        const patch = request.patch as Record<string, unknown>;
        canonicalProfile = {
          propertyId,
          profileRevision: canonicalProfile.profileRevision + 1,
          profile: {
            ...canonicalProfile.profile,
            ...patch,
            location:
              patch.location && typeof patch.location === "object"
                ? { ...canonicalProfile.profile.location, ...patch.location }
                : canonicalProfile.profile.location,
          },
        };
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: canonicalProfile,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: canonicalProfile,
      });
    },
  );
  let publicProfile = {
    propertyId,
    profileRevision: 1,
    publicProfile: {
      locale: "en",
      shortDescription: "A city hotel close to the old town.",
      longDescription: null,
      media: media.map((item, index) => {
        const candidate = item as {
          mediaType?: unknown;
          url?: unknown;
          altText?: unknown;
          sortOrder?: unknown;
        };
        return {
          mediaObjectId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          mediaType: candidate.mediaType ?? "gallery_image",
          url: candidate.url ?? `https://media.example/canonical-${index + 1}.webp`,
          altText: candidate.altText ?? null,
          sortOrder: candidate.sortOrder ?? index,
        };
      }),
    },
  };
  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/public-profile`),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") {
        const request = route.request().postDataJSON() as Record<string, unknown>;
        writes?.publicProfile?.push(request);
        expect(request).toEqual({
          expectedProfileRevision: publicProfile.profileRevision,
          patch: expect.any(Object),
        });
        const patch = request.patch as Record<string, unknown>;
        publicProfile = {
          propertyId,
          profileRevision: publicProfile.profileRevision + 1,
          publicProfile: {
            ...publicProfile.publicProfile,
            ...patch,
            media: publicProfile.publicProfile.media,
          },
        };
        canonicalProfile = {
          ...canonicalProfile,
          profileRevision: publicProfile.profileRevision,
        };
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: publicProfile,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: publicProfile,
      });
    },
  );
  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/media/presentation`),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const request = route.request().postDataJSON() as {
        expectedProfileRevision: number;
        assignments: Array<{
          mediaObjectId: string;
          role: "cover" | "gallery";
          altText: string | null;
          sortOrder: number;
        }>;
      };
      writes?.propertyPresentation?.push(request);
      expect(request.expectedProfileRevision).toBe(publicProfile.profileRevision);
      const existingMedia = new Map(
        publicProfile.publicProfile.media.map((item) => [item.mediaObjectId, item]),
      );
      publicProfile = {
        propertyId,
        profileRevision: publicProfile.profileRevision + 1,
        publicProfile: {
          ...publicProfile.publicProfile,
          media: request.assignments.map((assignment) => ({
            mediaObjectId: assignment.mediaObjectId,
            mediaType: assignment.role === "cover" ? "hero_image" : "gallery_image",
            url:
              existingMedia.get(assignment.mediaObjectId)?.url ??
              "https://media.example/uploaded-cover.webp",
            altText: assignment.altText,
            sortOrder: assignment.sortOrder,
          })),
        },
      };
      canonicalProfile = {
        ...canonicalProfile,
        profileRevision: publicProfile.profileRevision,
      };
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          outcome: "updated",
          profileRevision: publicProfile.profileRevision,
          logoAssignment: null,
          presentationAssignments: request.assignments,
        },
      });
    },
  );
  const marketplaceProfile = {
    propertyId,
    profileStatus: "pending",
    profileComplete: false,
    hostSummary: "A city hotel close to the old town.",
    collaborationGuidelines: null,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
  await page.route(
    new RegExp(`/api/marketplace/properties/${propertyId}/profile(?:\\?|$)`),
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      if (route.request().method() === "PUT") {
        const request = route.request().postDataJSON() as Record<string, unknown>;
        writes?.marketplaceProfile?.push(request);
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            ...marketplaceProfile,
            hostSummary:
              typeof request.hostSummary === "string"
                ? request.hostSummary
                : marketplaceProfile.hostSummary,
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: marketplaceProfile,
      });
    },
  );
  await routeJson(page, new RegExp(`/api/marketplace/properties/${propertyId}/offers`), {
    offers,
  });
}

function canonicalHeroMedia() {
  return {
    mediaType: "hero_image",
    url: "https://media.example/alpenrose-hero.webp",
    altText: "Hotel Alpenrose",
    sortOrder: 0,
  };
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
function sharedSetupStatus(
  missingSteps = [
    "publicProfile",
    "marketplaceOffer",
    "offerDeliverables",
    "compensationOptions",
    "creatorRequirements",
  ],
  marketplaceState: "setup_required" | "suspended" | "pending_review" | "ready" = "setup_required",
): AdaptiveHotelSetupStatus {
  const taskId: SetupTaskId = missingSteps.includes("publicProfile")
    ? "public_profile"
    : "creator_offer";
  if (marketplaceState === "suspended") {
    return createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId: "11111111-1111-4111-8111-111111111111",
      organizationDisplayName: "Alpenrose Hotel Group",
      selectedTracks: ["creator_marketplace"],
      propertyId,
      publicId: "alpenrose-munich",
      propertyDisplayName: "Alpenrose Munich",
      locationSummary: "Munich, DE",
      componentAccess: { marketplace: "suspended" },
      taskOverrides: {
        [taskId]: {
          callerCapability: "forbidden",
          ownerProgress: "not_started",
          readiness: "blocked",
          actionableBy: "support",
          reasonCodes: ["marketplace_suspended"],
        },
      },
      recommendedTaskId: null,
      entryDecision: {
        propertyId,
        decision: "unavailable",
        destinationRouteKey: null,
        reasonCode: "marketplace_suspended",
      },
    });
  }
  if (marketplaceState === "pending_review") {
    return createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId: "11111111-1111-4111-8111-111111111111",
      organizationDisplayName: "Alpenrose Hotel Group",
      selectedTracks: ["creator_marketplace"],
      propertyId,
      publicId: "alpenrose-munich",
      propertyDisplayName: "Alpenrose Munich",
      locationSummary: "Munich, DE",
      taskOverrides: {
        creator_offer: {
          callerCapability: "waiting",
          ownerProgress: "owner_complete",
          readiness: "pending_review",
          actionableBy: "operator",
          reasonCodes: ["marketplace_review_pending"],
        },
      },
      recommendedTaskId: null,
      entryDecision: {
        propertyId,
        decision: "enter",
        destinationRouteKey: "marketplace.workspace",
        reasonCode: null,
      },
    });
  }
  if (marketplaceState === "ready" || missingSteps.length === 0) {
    return createAdaptiveHotelSetupStatusMock({
      entryProduct: "marketplace",
      organizationId: "11111111-1111-4111-8111-111111111111",
      organizationDisplayName: "Alpenrose Hotel Group",
      selectedTracks: ["creator_marketplace"],
      propertyId,
      publicId: "alpenrose-munich",
      propertyDisplayName: "Alpenrose Munich",
      locationSummary: "Munich, DE",
      recommendedTaskId: null,
      entryDecision: {
        propertyId,
        decision: "enter",
        destinationRouteKey: "marketplace.workspace",
        reasonCode: null,
      },
    });
  }
  return createAdaptiveHotelSetupStatusMock({
    entryProduct: "marketplace",
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks: ["creator_marketplace"],
    propertyId,
    publicId: "alpenrose-munich",
    propertyDisplayName: "Alpenrose Munich",
    locationSummary: "Munich, DE",
    taskOverrides: {
      ...(missingSteps.includes("publicProfile")
        ? {
            public_profile: {
              ownerProgress: "not_started" as const,
              readiness: "actionable" as const,
              actionableBy: "owner" as const,
              reasonCodes: ["public_profile_required"],
            },
          }
        : {}),
      ...(missingSteps.some((step) => step !== "publicProfile")
        ? {
            creator_offer: {
              ownerProgress: "not_started" as const,
              readiness: "actionable" as const,
              actionableBy: "owner" as const,
              reasonCodes: ["creator_offer_required"],
            },
          }
        : {}),
    },
    recommendedTaskId: taskId,
    entryDecision: {
      propertyId,
      decision: "enter",
      destinationRouteKey: "marketplace.workspace",
      reasonCode: null,
    },
  });
}

function sharedRoadmapStatus(
  recommendedTaskId: SetupTaskId = "public_profile",
): AdaptiveHotelSetupStatus {
  const orderedTaskIds: SetupTaskId[] = [
    "public_profile",
    "creator_offer",
    "rooms_rates_availability",
    "guest_settings_policies",
    "payment",
    "direct_booking_publication",
  ];
  const recommendedIndex = orderedTaskIds.indexOf(recommendedTaskId);
  return createAdaptiveHotelSetupStatusMock({
    entryProduct: "marketplace",
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks: ["hotel_operations", "creator_marketplace"],
    propertyId,
    publicId: "alpenrose-munich",
    propertyDisplayName: "Alpenrose Munich",
    locationSummary: "Munich, DE",
    taskOverrides: Object.fromEntries(
      orderedTaskIds.map((taskId, index) => [
        taskId,
        index < recommendedIndex
          ? {
              ownerProgress: "owner_complete",
              readiness: "complete",
              actionableBy: null,
              reasonCodes: [],
            }
          : {
              ownerProgress: "not_started",
              readiness: "actionable",
              actionableBy: "owner",
              reasonCodes:
                taskId === "rooms_rates_availability"
                  ? [
                      "missing_active_room_type",
                      "missing_non_retired_room",
                      "missing_active_rate_plan",
                      "missing_future_inventory",
                    ]
                  : [`${taskId}_required`],
            },
      ]),
    ),
    recommendedTaskId,
    entryDecision: {
      propertyId,
      decision: "enter",
      destinationRouteKey: "marketplace.workspace",
      reasonCode: null,
    },
  });
}

function operationsOnlyStatus(
  entryProduct: "booking" | "marketplace" | "pms" = "marketplace",
  requestedProductCanOpen = false,
): AdaptiveHotelSetupStatus {
  return createAdaptiveHotelSetupStatusMock({
    entryProduct,
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks: ["hotel_operations"],
    propertyId,
    publicId: "alpenrose-munich",
    propertyDisplayName: "Alpenrose Munich",
    locationSummary: "Munich, DE",
    taskOverrides: {
      rooms_rates_availability: {
        ownerProgress: "not_started",
        readiness: "actionable",
        actionableBy: "operator",
        reasonCodes: [
          "missing_active_room_type",
          "missing_non_retired_room",
          "missing_active_rate_plan",
          "missing_future_inventory",
        ],
      },
    },
    recommendedTaskId: "rooms_rates_availability",
    entryDecision: requestedProductCanOpen
      ? {
          propertyId,
          decision: "enter",
          destinationRouteKey: `${entryProduct}.workspace`,
          reasonCode: null,
        }
      : {
          propertyId,
          decision: "setup_required",
          destinationRouteKey: "hotel_setup",
          reasonCode: "track_not_selected",
        },
  });
}

function marketplaceOffer(status: "pending" | "verified" | "rejected") {
  return {
    offerId: `${status}-offer`,
    mediaResourceId: `${status}-offer`,
    propertyId,
    offerStatus: status,
    title: `${status} offer`,
    offerSummary: "A creator collaboration offer.",
    media: [],
    deliverables: [],
    compensationOptions: [],
    creatorRequirements: null,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function createdMarketplaceOffer(payload: Record<string, unknown>) {
  const compensationOptions = (payload.compensationOptions ?? []) as Array<Record<string, unknown>>;
  return {
    offerId: "created-offer",
    mediaResourceId: "created-offer",
    propertyId,
    offerStatus: "pending",
    title: payload.title ?? "Created offer",
    offerSummary: payload.offerSummary ?? null,
    media: [],
    deliverables: payload.deliverables ?? [],
    compensationOptions: compensationOptions.map((option, index) => ({
      compensationOptionId: `compensation-${index + 1}`,
      ...option,
    })),
    creatorRequirements: payload.creatorRequirements ?? null,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function emptySharedSetupStatus(): AdaptiveHotelSetupStatus {
  return createAdaptiveHotelSetupStatusMock({
    entryProduct: "marketplace",
    organizationId: "11111111-1111-4111-8111-111111111111",
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks: [],
    trackRevision: 0,
    propertyId: null,
  });
}

function sharedPropertyProfile(payload: Record<string, unknown>) {
  return {
    propertyId,
    profileRevision: 1,
    profile: payload,
  };
}
