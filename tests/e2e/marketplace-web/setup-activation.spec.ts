import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AdaptiveHotelSetupStatus, SetupTaskId } from "@vayada/domain-hotels";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_HANDOFF_CODES: Partial<Record<SetupTaskId, string>> = {
  guest_settings_policies: "S".repeat(43),
  rooms_rates_availability: "T".repeat(43),
};

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

    await expect(
      page.getByRole("heading", { name: "Set up your Vayada tools", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Create your public hotel profile" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Introduce your hotel to creators" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Prepare your collaboration offer" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Set up rooms, rates, and availability" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  });

  test("shows both selected tracks as one property-scoped setup plan", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedRoadmapStatus());

    await page.goto(setupUrl(baseURL));

    await expect(
      page.getByRole("heading", { level: 1, name: "Set up your Vayada tools" }),
    ).toBeVisible();
    await expect(page.getByText("1 of 8 setup tasks complete")).toBeVisible();
    await expect(page.getByText("Hotel Operations", { exact: true })).toBeVisible();
    await expect(page.getByText("Creator Marketplace", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Set up rooms, rates, and availability" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Review guest settings and policies" }),
    ).toBeVisible();
    await expect(page.getByText("Introduce your hotel to creators")).toBeVisible();
    await expect(page.getByText("Prepare your collaboration offer")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue recommended step" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open task" })).toHaveCount(6);
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
    test.skip(!baseURL, "Playwright base URL is required.");
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedRoadmapStatus());
    const handoffRequests: Array<Record<string, unknown>> = [];
    await page.route(/\/api\/hotel-setup\/handoffs$/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      handoffRequests.push(body);
      const code = TASK_HANDOFF_CODES[body.taskId as SetupTaskId];
      if (!code) throw new Error(`Missing handoff code for ${String(body.taskId)}`);
      const launchUrl = new URL(`/handoff?code=${code}`, baseURL);
      launchUrl.hostname =
        body.taskId === "guest_settings_policies" ? "admin.booking.localhost" : "pms.localhost";
      await route.fulfill({
        status: 201,
        headers: corsHeaders(route),
        json: {
          launchUrl: launchUrl.toString(),
          expiresAt: "2026-07-26T20:00:00.000Z",
        },
      });
    });
    await page.route(/\/handoff\?code=[A-Za-z0-9_-]{43}$/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Handoff</title>" }),
    );

    await page.goto(setupUrl(baseURL));
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Review guest settings and policies" }) })
      .getByRole("button", { name: "Open task" })
      .click();

    await expect.poll(() => new URL(page.url()).hostname).toContain("admin.booking");
    const bookingHandoffUrl = new URL(page.url());
    expect(bookingHandoffUrl.pathname).toBe("/handoff");
    expect([...bookingHandoffUrl.searchParams.keys()]).toEqual(["code"]);
    expect(bookingHandoffUrl.hash).toBe("");

    await page.goto(setupUrl(baseURL));
    await page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Set up rooms, rates, and availability" }) })
      .getByRole("button", { name: "Open task" })
      .click();

    await expect.poll(() => new URL(page.url()).hostname).toMatch(/^pms\./);
    const pmsHandoffUrl = new URL(page.url());
    expect(pmsHandoffUrl.pathname).toBe("/handoff");
    expect([...pmsHandoffUrl.searchParams.keys()]).toEqual(["code"]);
    expect(pmsHandoffUrl.hash).toBe("");
    expect(handoffRequests).toEqual([
      {
        propertyId,
        taskId: "guest_settings_policies",
        planRevision: "e2e-plan-1",
      },
      {
        propertyId,
        taskId: "rooms_rates_availability",
        planRevision: "e2e-plan-1",
      },
    ]);
  });

  test("opens profile tools for the actionable creator profile task", async ({ page, baseURL }) => {
    test.skip(!baseURL, "Playwright base URL is required.");
    await primeBrowserState(page, true);
    await mockAuthSession(page);
    await mockSharedSetupStatus(page, sharedSetupStatus(["creatorPitch"]));
    await mockMarketplaceProfileApis(page, [marketplaceOffer("pending")]);
    await mockMarketplaceTaskHandoff(page, baseURL, "creator_profile");

    await page.goto(setupUrl(baseURL));
    await page.getByRole("button", { name: "Continue recommended step" }).click();

    await expectMarketplaceActivationTask(page, 1, "creator_profile");
    await expect(
      page.getByRole("heading", { level: 1, name: "Introduce your hotel to creators" }),
    ).toBeVisible();

    const introduction = page.getByLabel("Creator-facing introduction", { exact: true });
    await introduction.fill(
      "Tell creators why an independent stay at Alpenrose makes a memorable collaboration.",
    );
    await expect(page.getByRole("button", { name: "Save creator profile" })).toBeEnabled();
    await expect(
      page.getByRole("checkbox", { name: /Show city and country on public Vayada surfaces/ }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Public hotel cover/ })).toHaveCount(0);
    await expect(page.getByLabel("Offer title", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Hotel location", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Property type", { exact: true })).toHaveCount(0);
  });

  test("keeps Marketplace pages accessible while creator setup tasks remain", async ({
    page,
    baseURL,
  }) => {
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
    await mockMarketplaceTaskHandoff(page, baseURL, "creator_offer");
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

    await expect(page.getByText("Prepare your collaboration offer")).toBeVisible();
    const continueSetup = page.getByRole("button", { name: "Continue recommended step" });
    await expect(continueSetup).toBeEnabled();
    await continueSetup.click();

    await expectMarketplaceActivationTask(page, 3, "creator_offer");
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

    await expect(page.getByText("Step 2 of 3", { exact: true })).toBeVisible();
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

    await expect(page.getByText("Step 3 of 3", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "Who are you looking for?" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Looking For", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Offerings" })).toHaveCount(0);
    const completeSetup = page.getByRole("button", { name: "Save collaboration offer" });
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

    await page.goto(profileActivationUrl(baseURL));

    await expect(page.getByText("Step 1 of 3", { exact: true })).toBeVisible();
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
    await expect(page.getByLabel("Creator-facing introduction", { exact: true })).toHaveCount(0);
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
    await mockMarketplaceTaskHandoff(page, baseURL, "creator_offer");

    await page.goto(setupUrl(baseURL));
    await page.getByRole("button", { name: "Continue recommended step" }).click();

    await expectMarketplaceActivationTask(page, 3, "creator_offer");
    await expect(page.getByLabel("Offer title", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Creator-facing introduction", { exact: true })).toHaveCount(0);
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
    const taskCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Prepare your collaboration offer" }) });
    await expect(taskCard.getByText("Permission required", { exact: true })).toBeVisible();
    await expect(taskCard.getByRole("button")).toHaveCount(0);
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
    await mockSharedSetupStatus(page, sharedSetupStatus(["creatorPitch"]));
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

    await expect(page.getByText("Waiting", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Another team or an automated process", { exact: false }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Creator Marketplace" })).toBeEnabled();
  });
});

async function expectMarketplaceActivationTask(
  page: Page,
  totalSteps: number,
  taskId: SetupTaskId,
) {
  await expect.poll(() => new URL(page.url()).pathname).toBe("/profile/complete");
  const taskUrl = new URL(page.url());
  expect(taskUrl.searchParams.get("activation")).toBe("marketplace");
  expect(taskUrl.searchParams.get("taskId")).toBe(taskId);
  expect(taskUrl.searchParams.get("destinationRouteKey")).toBe(`marketplace.${taskId}`);
  expect(taskUrl.searchParams.has("propertyId")).toBe(false);
  await expect(page.getByText("Creator Marketplace Setup", { exact: true })).toBeVisible();
  await expect(page.getByText(`Step 1 of ${totalSteps}`, { exact: true })).toBeVisible();
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

async function mockMarketplaceTaskHandoff(
  page: Page,
  baseURL: string,
  taskId: "creator_profile" | "creator_offer",
) {
  const code = (taskId === "creator_profile" ? "U" : "V").repeat(43);
  const destinationRouteKey = `marketplace.${taskId}`;
  await page.route(/\/api\/hotel-setup\/handoffs$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    expect(route.request().postDataJSON()).toEqual({
      propertyId,
      taskId,
      planRevision: "e2e-plan-1",
    });
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        launchUrl: new URL(`/handoff?code=${code}`, baseURL).toString(),
        expiresAt: "2026-07-26T20:00:00.000Z",
      },
    });
  });
  await page.route(/\/api\/hotel-setup\/handoffs\/exchange$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    expect(route.request().postDataJSON()).toEqual({ code });
    const returnUrl = new URL("/setup", baseURL);
    returnUrl.searchParams.set("propertyId", propertyId);
    await route.fulfill({
      headers: corsHeaders(route),
      json: {
        propertyId,
        taskId,
        issuedPlanRevision: "e2e-plan-1",
        destinationRouteKey,
        returnUrl: returnUrl.toString(),
      },
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
  const canonicalProfile = sharedPropertyProfile({
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
          expectedProfileRevision: 1,
          patch: expect.any(Object),
        });
        const patch = request.patch as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            propertyId,
            profileRevision: 2,
            profile: {
              ...canonicalProfile.profile,
              ...patch,
              location:
                patch.location && typeof patch.location === "object"
                  ? { ...canonicalProfile.profile.location, ...patch.location }
                  : canonicalProfile.profile.location,
            },
          },
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
  const publicProfile = {
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
        expect(request).toEqual({
          expectedProfileRevision: 1,
          patch: expect.any(Object),
        });
        const patch = request.patch as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: {
            propertyId,
            profileRevision: 2,
            publicProfile: {
              ...publicProfile.publicProfile,
              ...patch,
              media: publicProfile.publicProfile.media,
            },
          },
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
  marketplaceState: "setup_required" | "suspended" | "pending_review" | "ready" = "setup_required",
): AdaptiveHotelSetupStatus {
  const taskId: SetupTaskId = missingSteps.includes("creatorPitch")
    ? "creator_profile"
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
      ...(missingSteps.includes("creatorPitch")
        ? {
            creator_profile: {
              ownerProgress: "not_started" as const,
              readiness: "actionable" as const,
              actionableBy: "owner" as const,
              reasonCodes: ["creator_profile_required"],
            },
          }
        : {}),
      ...(missingSteps.some((step) => step !== "creatorPitch")
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

function sharedRoadmapStatus(): AdaptiveHotelSetupStatus {
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
      [
        "public_profile",
        "creator_profile",
        "creator_offer",
        "rooms_rates_availability",
        "guest_settings_policies",
        "payment",
        "direct_booking_publication",
      ].map((taskId) => [
        taskId,
        {
          ownerProgress: "not_started",
          readiness: "actionable",
          actionableBy: "owner",
          reasonCodes: [`${taskId}_required`],
        },
      ]),
    ),
    recommendedTaskId: "public_profile",
    entryDecision: {
      propertyId,
      decision: "enter",
      destinationRouteKey: "marketplace.workspace",
      reasonCode: null,
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
