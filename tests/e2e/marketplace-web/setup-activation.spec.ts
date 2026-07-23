import { expect, test, type Locator, type Page } from "@playwright/test";
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
    const setupStatus = sharedSetupStatus([], "selected_incomplete");
    setupStatus.nextAction.action = "enter_product";
    await mockSharedSetupStatus(page, setupStatus);
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
    await primeBrowserState(page);
    await mockAuthSession(page);
    await routeJson(page, /\/api\/hotel-setup\/property-types/, {
      contractVersion: "shared-hotel-setup-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    });

    let created = false;
    await page.route(/\/api\/hotel-setup\/status/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: created ? sharedSetupStatusForProductSelection() : emptySharedSetupStatus(),
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
        },
        contactEmail: "owner@alpenrose.example",
        phone: "+49 89 123456",
        website: "https://alpenrose.example",
      });
      expect(payload.location.timezone).toMatch(/\//);
      created = true;
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: sharedPropertyProfile(payload),
      });
    });

    await page.goto(setupUrl(baseURL));

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
      await expect(locationActionBar.getByText("This matches your device.")).toBeVisible();
      await locationSearchPanel.getByRole("button", { name: "Edit address details" }).click();
      await expect(streetAddress).toBeFocused();
    }

    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("textbox", { name: /Contact email/ })).toHaveValue(
      "owner@alpenrose.example",
    );
    await expect(page.getByRole("textbox", { name: /Phone number/ })).toHaveValue("+49 89 123456");
    await page.getByRole("textbox", { name: /Website/ }).fill("https://alpenrose.example");
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(
      page.getByRole("heading", { name: "How would you like to use Vayada?", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Choose account systems", level: 2 }),
    ).toBeVisible();
    await expect(page.getByLabel("Booking Engine", { exact: true })).toHaveAccessibleDescription(
      "Unavailable",
    );
    const marketplaceSystem = page.getByLabel("Creator Marketplace", { exact: true });
    const marketplaceSystemCard = marketplaceSystem.locator("xpath=ancestor::label");
    const continueSetup = page.getByRole("button", { name: "Continue setup" });
    await expect(marketplaceSystem).toBeChecked();
    await marketplaceSystemCard.click();
    await expect(marketplaceSystem).not.toBeChecked();
    await expect(
      page.getByText("Select at least one available product to continue.", { exact: true }),
    ).toBeVisible();
    await expect(continueSetup).toBeDisabled();
    await marketplaceSystemCard.click();
    await expect(marketplaceSystem).toBeChecked();
    await expect(continueSetup).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("shows the selected products as an actionable setup roadmap", async ({ page, baseURL }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedRoadmapStatus());

    await page.goto(setupUrl(baseURL));

    await expect(
      page.getByRole("heading", { level: 1, name: "Finish setting up Alpenrose Munich" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hotel details saved" })).toBeVisible();
    await expect(page.getByText("0 of 3 products ready")).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Selected products ready" }),
    ).toHaveAttribute("aria-valuenow", "0");

    await expect(page.getByRole("heading", { level: 2, name: "Booking Engine" })).toBeVisible();
    await expect(page.getByText("Configure booking settings")).toBeVisible();
    await expect(page.getByText("Prepare to accept direct bookings")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue in Booking Admin" })).toBeVisible();

    await expect(page.getByRole("heading", { level: 2, name: "PMS" })).toBeVisible();
    await expect(page.getByText("Set up rooms & rates")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue in PMS" })).toBeVisible();

    await expect(
      page.getByRole("heading", { level: 2, name: "Creator Marketplace" }),
    ).toBeVisible();
    await expect(page.getByText("Introduce your hotel to creators")).toBeVisible();
    await expect(page.getByText("Prepare your collaboration offer")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue Marketplace setup" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Hotel Name" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Website" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Phone" })).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("hands Booking and PMS tasks off with the selected property", async ({ page, baseURL }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedRoadmapStatus());
    await page.route(/\/handoff(?:\?.*)?$/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Handoff</title>" }),
    );

    await page.goto(setupUrl(baseURL));
    await page.getByRole("button", { name: "Continue in Booking Admin" }).click();

    let handoffUrl = new URL(page.url());
    expect(handoffUrl.hostname).toContain("admin.booking");
    expect(handoffUrl.pathname).toBe("/handoff");
    expect(handoffUrl.searchParams.get("redirect")).toBe(
      `/setup?entryProduct=booking&propertyId=${propertyId}`,
    );
    let handoffFragment = new URLSearchParams(handoffUrl.hash.slice(1));
    expect(handoffFragment.get("property_id")).toBe(propertyId);
    expect(handoffFragment.get("organization_id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(handoffFragment.get("workos_organization_id")).toBe("org_workos_hotel_group");

    await page.goto(setupUrl(baseURL));
    await page.getByRole("button", { name: "Continue in PMS" }).click();

    handoffUrl = new URL(page.url());
    expect(handoffUrl.hostname).toMatch(/^pms\./);
    expect(handoffUrl.pathname).toBe("/handoff");
    expect(handoffUrl.searchParams.has("redirect")).toBe(false);
    handoffFragment = new URLSearchParams(handoffUrl.hash.slice(1));
    expect(handoffFragment.get("property_id")).toBe(propertyId);
    expect(handoffFragment.get("organization_id")).toBe("11111111-1111-4111-8111-111111111111");
    expect(handoffFragment.get("workos_organization_id")).toBe("org_workos_hotel_group");
  });

  test("opens profile tools for creatorPitch even when legacy status reports profile missing", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["creatorPitch"]));
    await mockMarketplaceProfileApis(page, [marketplaceOffer("pending")]);

    await page.goto(setupUrl(baseURL));
    await page.getByRole("button", { name: "Continue Marketplace setup" }).click();

    await expectMarketplaceActivationIntro(page, 1);

    const introduction = page.getByLabel("Creator-facing introduction", { exact: true });
    await introduction.fill(
      "Tell creators why an independent stay at Alpenrose makes a memorable collaboration.",
    );
    await expect(page.getByRole("button", { name: "Complete Marketplace setup" })).toBeEnabled();
    await expect(page.getByLabel("Offer title", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Hotel location", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Property type", { exact: true })).toHaveCount(0);
  });

  test("routes protected Marketplace pages into the activation form", async ({ page, baseURL }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["creatorPitch"]));
    await mockMarketplaceProfileApis(page, [marketplaceOffer("pending")]);
    await routeJson(page, /\/api\/marketplace\/collaborations\/me/, {
      contractVersion: "marketplace-collaboration-reads.v1",
      authorizationMode: "hotel_group_resource_link",
      items: [],
    });

    await page.goto(calendarUrl(baseURL));

    await expectMarketplaceActivationIntro(page, 1);
  });

  test("reuses the shared hotel hero for a replacement offer", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 2048, height: 1125 });
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["offerDeliverables"]));
    const sharedHeroUrl = "https://media.example/alpenrose.webp";
    await mockMarketplaceProfileApis(
      page,
      [marketplaceOffer("verified")],
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
          json: { offers: [marketplaceOffer("verified")] },
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

    await expect(page.getByText("Prepare your collaboration offer")).toBeVisible();
    const continueSetup = page.getByRole("button", { name: "Continue Marketplace setup" });
    await expect(continueSetup).toBeEnabled();
    await continueSetup.click();

    await expectMarketplaceActivationIntro(page);
    await page
      .getByLabel("Creator-facing introduction", { exact: true })
      .fill("Tell creators why a stay at Alpenrose makes a memorable collaboration experience.");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Step 2 of 4", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Describe your offer" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Offer details" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Offerings" })).toHaveCount(0);
    await expect(page.getByText("Your collaboration offer is already saved")).toHaveCount(0);
    const continueButton = page.getByRole("button", { name: "Continue", exact: true });
    await expect(continueButton).toBeDisabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= document.documentElement.clientHeight,
      ),
    ).toBe(true);

    await page.getByLabel("Offer title", { exact: true }).fill("Three-night creator stay");
    await page
      .getByLabel(/Description/)
      .fill("A memorable city stay with breakfast and a guided local experience.");
    await expect(page.getByAltText("Three-night creator stay - Main photo")).toHaveAttribute(
      "src",
      sharedHeroUrl,
    );
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    await expect(page.getByText("Step 3 of 4", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "What are you offering?" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Offerings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Offer details" })).toHaveCount(0);
    await expect(continueButton).toBeDisabled();
    await page.getByText("Affiliate", { exact: true }).click();
    await page.getByRole("button", { name: "Select All Year" }).click();
    await page.getByText("Instagram", { exact: true }).click();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    await expect(page.getByText("Step 4 of 4", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Who are you looking for?" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Looking For", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Offerings" })).toHaveCount(0);
    const completeSetup = page.getByRole("button", { name: "Complete Marketplace setup" });
    await expect(completeSetup).toBeDisabled();
    await page.getByText("TikTok", { exact: true }).click();
    await expect(completeSetup).toBeEnabled();

    await page.getByRole("button", { name: "Previous" }).click();
    await expect(page.getByLabel("Affiliate", { exact: true })).toBeChecked();
    await expect(page.getByLabel("Instagram", { exact: true })).toBeChecked();
    await continueButton.click();
    await expect(page.getByLabel("TikTok", { exact: true })).toBeChecked();

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
  });

  test("restores a hotel offer draft after a reload and asks only for local photos again", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await page.addInitScript(
      ({ draftPropertyId }) => {
        localStorage.setItem(
          `vayada_hotel_marketplace_draft:${draftPropertyId}`,
          JSON.stringify({
            version: 1,
            savedAt: Date.now(),
            currentStep: 4,
            form: {
              about:
                "Alpenrose gives travel creators a welcoming base for memorable Munich stories.",
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

    await page.goto(profileActivationUrl(baseURL));

    await expect(page.getByText("Step 2 of 4", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "Your Marketplace setup details were restored" }),
    ).toContainText("Please select your offer photos again");
    await expect(page.getByLabel("Offer title", { exact: true })).toHaveValue(
      "Restored creator stay",
    );
    await expect(page.getByLabel(/Description/)).toHaveValue(
      "A restored city stay with breakfast and a local experience.",
    );
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Previous" }).click();
    await expect(page.getByLabel("Creator-facing introduction", { exact: true })).toHaveValue(
      "Alpenrose gives travel creators a welcoming base for memorable Munich stories.",
    );
  });

  test("asks for a replacement offer when the existing Marketplace offer was rejected", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["marketplaceOffer"]));
    await mockMarketplaceProfileApis(page, [marketplaceOffer("rejected")]);

    await page.goto(setupUrl(baseURL));
    await page.getByRole("button", { name: "Continue Marketplace setup" }).click();
    await page
      .getByLabel("Creator-facing introduction", { exact: true })
      .fill("Tell creators why a stay at Alpenrose makes a memorable collaboration experience.");
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await expect(page.getByLabel("Offer title", { exact: true })).toBeVisible();
    await expect(page.getByText("Your collaboration offer is already saved")).toHaveCount(0);
  });

  test("blocks suspended Marketplace activation instead of opening profile tools", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const setupStatus = sharedSetupStatus([], "suspended");
    setupStatus.hotelGroup.selectedProducts = [];
    await mockSharedSetupStatus(page, setupStatus);

    await page.goto(setupUrl(baseURL));

    await expect(page.getByRole("heading", { name: "Creator Marketplace" })).toBeVisible();
    await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
    await expect(
      page.locator("p", { hasText: "Marketplace access is currently suspended" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Creator Marketplace unavailable" }),
    ).toBeDisabled();
    await expect(page.getByRole("button", { name: "Continue Marketplace setup" })).toHaveCount(0);
  });

  test("blocks a direct suspended activation URL before loading Marketplace profile data", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    const setupStatus = sharedSetupStatus([], "suspended");
    setupStatus.hotelGroup.selectedProducts = [];
    await mockSharedSetupStatus(page, setupStatus);
    let loadedMarketplaceProfile = false;
    await page.route(/\/api\/marketplace\/properties\/.*\/(?:profile|offers)/, async (route) => {
      loadedMarketplaceProfile = true;
      await route.abort();
    });

    await page.goto(profileActivationUrl(baseURL));

    await expect(page).toHaveURL(new RegExp(`/setup\\?.*propertyId=${propertyId}`));
    await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
    expect(loadedMarketplaceProfile).toBe(false);
  });

  test("opens a direct pending activation without asking for more setup", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus([], "selected_incomplete"));
    let loadedMarketplaceProfile = false;
    await page.route(/\/api\/marketplace\/properties\/.*\/(?:profile|offers)/, async (route) => {
      loadedMarketplaceProfile = true;
      await route.abort();
    });

    await page.goto(profileActivationUrl(baseURL));

    await expect(page).toHaveURL(/\/marketplace$/);
    expect(loadedMarketplaceProfile).toBe(false);
  });

  test("shows Marketplace verification as pending without asking for more setup", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus([], "selected_incomplete"));

    await page.goto(setupUrl(baseURL));

    await expect(page.getByText("Verification pending", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "Your Marketplace profile is under review. You can still open the workspace and manage it.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Creator Marketplace" })).toBeEnabled();
  });
});

async function expectMarketplaceActivationIntro(page: Page, totalSteps = 4) {
  await expect(page).toHaveURL(
    new RegExp(`/profile/complete\\?activation=marketplace&propertyId=${propertyId}$`),
  );
  await expect(page.getByText("Creator Marketplace Setup", { exact: true })).toBeVisible();
  await expect(page.getByText(`Step 1 of ${totalSteps}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Introduce your hotel" })).toBeVisible();
  await expect(page.getByLabel("Creator-facing introduction", { exact: true })).toBeVisible();
  for (const field of ["Hotel Name", "Creator-facing location", "Location", "Website", "Phone"]) {
    await expect(page.getByLabel(field, { exact: true })).toHaveCount(0);
  }
}

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
  const path = "/setup?entryProduct=marketplace&returnTo=/marketplace";
  if (!baseURL) return path;

  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") {
    url.hostname = "localhost";
    url.pathname = "/setup";
    url.search = "?entryProduct=marketplace&returnTo=/marketplace";
    return url.toString();
  }
  return path;
}

function profileActivationUrl(baseURL: string | undefined) {
  const path = `/profile/complete?activation=marketplace&propertyId=${propertyId}`;
  if (!baseURL) return path;

  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") {
    url.hostname = "localhost";
    url.pathname = "/profile/complete";
    url.search = `?activation=marketplace&propertyId=${propertyId}`;
    return url.toString();
  }
  return path;
}

function calendarUrl(baseURL: string | undefined) {
  if (!baseURL) return "/calendar";

  const url = new URL(baseURL);
  url.pathname = "/calendar";
  return url.toString();
}

async function primeBrowserState(page: Page, hotelProfile = false) {
  await page.addInitScript((primeHotelProfile) => {
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
    if (primeHotelProfile) localStorage.setItem("userType", "hotel");
  }, hotelProfile);
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

async function mockSharedSetupStatus(page: Page, status: ReturnType<typeof sharedSetupStatus>) {
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

async function mockMarketplaceProfileApis(
  page: Page,
  offers: unknown[] = [],
  media: unknown[] = [],
) {
  await routeJson(page, new RegExp(`/api/marketplace/properties/${propertyId}/profile-status`), {
    profile_complete: false,
    missing_fields: ["profile"],
    has_defaults: { location: false },
    missing_offers: false,
    completion_steps: ["Complete your marketplace hotel profile"],
  });
  await routeJson(
    page,
    new RegExp(`/api/hotel-setup/properties/${propertyId}/profile`),
    sharedPropertyProfile({
      displayName: "Alpenrose Munich",
      propertyType: "hotel",
      location: {
        countryCode: "DE",
        region: "Bavaria",
        city: "Munich",
        streetAddress: "Marienplatz 1",
        postalCode: "80331",
        rawMarketplaceLocation: "Munich, DE",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        addressPublic: true,
        mapDisplayMode: "exact",
      },
      website: "https://alpenrose.example",
      contactEmail: "owner@alpenrose.example",
      phone: "+49 89 123456",
      shortDescription: "A city hotel close to the old town.",
      longDescription: null,
      media,
    }),
  );
  await routeJson(page, new RegExp(`/api/marketplace/properties/${propertyId}/profile(?:\\?|$)`), {
    propertyId,
    profileStatus: "pending",
    profileComplete: false,
    hostSummary: "A city hotel close to the old town.",
    collaborationGuidelines: null,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  });
  await routeJson(page, new RegExp(`/api/marketplace/properties/${propertyId}/offers`), {
    offers,
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
function sharedSetupStatus(
  missingSteps = [
    "creatorPitch",
    "marketplaceOffer",
    "offerDeliverables",
    "compensationOptions",
    "creatorRequirements",
  ],
  marketplaceStatus = "selected_incomplete",
) {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "marketplace", returnTo: "/marketplace" },
    hotelGroup: {
      organizationId: "11111111-1111-4111-8111-111111111111",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedProducts: ["marketplace"],
    },
    selection: { state: "single_property", selectedPropertyId: propertyId },
    properties: [
      {
        propertyId,
        publicId: "alpenrose-munich",
        displayName: "Alpenrose Munich",
        locationSummary: "Munich, DE",
        sharedProfile: {
          status: "complete",
          source: "canonical",
          completionPercent: 100,
          missingFields: [],
        },
        products: {
          booking: activation("booking", "active", []),
          pms: activation("pms", "not_selected", []),
          marketplace: activation("marketplace", marketplaceStatus, missingSteps),
        },
      },
    ],
    nextAction: {
      action: "complete_product_activation",
      propertyId,
      product: "marketplace",
      missingSteps,
      reasonCodes: ["entry_product_activation_incomplete"],
    },
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function sharedRoadmapStatus() {
  const status = sharedSetupStatus();
  status.hotelGroup.selectedProducts = ["booking", "pms", "marketplace"];
  status.properties[0]!.products.booking = activation("booking", "selected_incomplete", [
    "bookingSettings",
    "publicBookability",
    "paymentReadiness",
  ]);
  status.properties[0]!.products.pms = activation("pms", "selected_incomplete", [
    "roomTypes",
    "rooms",
    "ratePlans",
  ]);
  return status;
}

function activation(product: string, status: string, missingSteps: string[]) {
  return {
    product,
    status,
    missingSteps,
    statusReasons:
      status === "selected_incomplete"
        ? [`${product}_activation_incomplete`]
        : [`${product}_${status}`],
    updatedAt: status === "not_selected" ? null : "2026-06-30T00:00:00.000Z",
  };
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

function emptySharedSetupStatus() {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "marketplace", returnTo: "/marketplace" },
    hotelGroup: {
      organizationId: "11111111-1111-4111-8111-111111111111",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedProducts: [],
    },
    selection: { state: "no_property", selectedPropertyId: null },
    properties: [],
    nextAction: { action: "create_property", reasonCodes: ["no_property"] },
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function sharedSetupStatusForProductSelection() {
  const status = sharedSetupStatus();
  return {
    ...status,
    hotelGroup: { ...status.hotelGroup, selectedProducts: [] },
    properties: [
      {
        ...status.properties[0],
        displayName: "Hotel Alpenrose",
        sharedProfile: {
          status: "incomplete",
          source: "canonical",
          completionPercent: 67,
          missingFields: ["description", "media"],
        },
        products: {
          booking: activation("booking", "unavailable", []),
          pms: activation("pms", "not_selected", []),
          marketplace: activation("marketplace", "not_selected", []),
        },
      },
    ],
    nextAction: {
      action: "select_products",
      propertyId,
      reasonCodes: ["no_products_selected"],
    },
  };
}

function sharedPropertyProfile(payload: Record<string, unknown>) {
  return {
    propertyId,
    publicId: "prop_alpenrose",
    ...payload,
    sharedProfile: {
      status: "incomplete",
      source: "canonical",
      completionPercent: 67,
      missingFields: ["description", "media"],
    },
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}
