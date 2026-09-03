import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PUBLIC_BOOKABILITY_PATH,
  BOOKING_ADMIN_PROPERTY_SETTINGS_PATH,
  BOOKING_ADMIN_PROPERTY_ID,
  defaultBookingAdminDesignSettings,
  defaultBookingAdminPropertyProfile,
  defaultBookingAdminPropertySettings,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminDesignSettings,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const TASK_DESTINATIONS = [
  {
    code: "L".repeat(43),
    taskId: "guest_settings_policies",
    destinationRouteKey: "booking.guest_settings_policies",
    pathname: "/settings",
    settingsSection: "booking",
    activeSection: "Booking",
  },
  {
    code: "M".repeat(43),
    taskId: "payment",
    destinationRouteKey: "finance.payment",
    pathname: "/settings",
    settingsSection: "payments",
    activeSection: "Payments",
  },
  {
    code: "N".repeat(43),
    taskId: "direct_booking_publication",
    destinationRouteKey: "distribution.direct_booking_publication",
    pathname: "/design-studio",
    settingsSection: null,
    activeSection: null,
  },
] as const;

const USED_CODE = "O".repeat(43);
const CANONICAL_PUBLIC_DESCRIPTION =
  "A Marketplace-authored description that must remain canonical for every public surface.";

test.describe("booking-admin adaptive setup", () => {
  test("replaces local setup with the canonical Marketplace wizard and preserves context", async ({
    page,
  }) => {
    const expectedUrl = canonicalMarketplaceSetupUrl({
      entryProduct: "pms",
      returnTo: "/settings?section=booking",
      propertyId: BOOKING_ADMIN_PROPERTY_ID,
      mode: "add",
    });
    await page.route("**/__before-local-setup", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Before local setup</title><h1>Before local setup</h1>",
      }),
    );
    await page.route(
      (url) => url.toString() === expectedUrl,
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Canonical setup</title><h1>Canonical setup</h1>",
        }),
    );

    await page.goto("/__before-local-setup");
    await page.goto(
      `/setup?entryProduct=pms&returnTo=${encodeURIComponent("/settings?section=booking")}&propertyId=${BOOKING_ADMIN_PROPERTY_ID}&mode=add`,
    );

    await expect.poll(() => page.url()).toBe(expectedUrl);
    await expect(page.getByRole("heading", { name: "Canonical setup" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Before local setup" })).toBeVisible();
  });

  test("defaults invalid local setup parameters before redirecting to Marketplace", async ({
    page,
  }) => {
    const expectedUrl = canonicalMarketplaceSetupUrl({
      entryProduct: "booking",
      returnTo: "/dashboard",
      propertyId: BOOKING_ADMIN_PROPERTY_ID,
    });
    await page.route(
      (url) => url.toString() === expectedUrl,
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Canonical setup</title><h1>Canonical setup</h1>",
        }),
    );

    await page.goto(
      `/setup?entryProduct=unknown&returnTo=${encodeURIComponent("https://attacker.example/dashboard")}&propertyId=${BOOKING_ADMIN_PROPERTY_ID}`,
    );

    await expect.poll(() => page.url()).toBe(expectedUrl);
  });

  for (const destination of TASK_DESTINATIONS) {
    test(`exchanges an opaque code and opens ${destination.taskId}`, async ({ page }) => {
      await mockBookingAdminAuthenticatedSession(page);
      await page.route("**/auth/session?surface=booking-admin", (route) =>
        route.fulfill({ json: bookingAuthSession() }),
      );
      await mockBookingAdminShellRoutes(page);
      await mockFinancePaymentSettings(page);
      const guestSettingsRequests: Array<Record<string, unknown>> = [];
      const canonicalProfileRequests: Array<Record<string, unknown>> = [];
      const publicProfileRequests: Array<Record<string, unknown>> = [];
      let publicationRequests = 0;
      if (destination.taskId === "guest_settings_policies") {
        await mockGuestSettingsTask(page, guestSettingsRequests);
      }
      if (destination.taskId === "direct_booking_publication") {
        let profileRevision = 1;
        let localityPublic = false;
        let shortDescription = CANONICAL_PUBLIC_DESCRIPTION;
        await page.route(
          `**/api/hotel-setup/properties/${BOOKING_ADMIN_PROPERTY_ID}/profile`,
          (route) => {
            if (route.request().method() === "PUT") {
              const body = route.request().postDataJSON() as Record<string, unknown>;
              canonicalProfileRequests.push(body);
              profileRevision += 1;
              localityPublic = true;
            }
            return route.fulfill({
              json: {
                ...defaultBookingAdminPropertyProfile,
                profileRevision,
                profile: {
                  ...defaultBookingAdminPropertyProfile.profile,
                  location: {
                    ...defaultBookingAdminPropertyProfile.profile.location,
                    localityPublic,
                  },
                },
              },
            });
          },
        );
        await page.route(
          `**/api/hotel-setup/properties/${BOOKING_ADMIN_PROPERTY_ID}/public-profile`,
          (route) => {
            if (route.request().method() === "PUT") {
              const body = route.request().postDataJSON() as Record<string, unknown>;
              publicProfileRequests.push(body);
              shortDescription = (body.patch as { shortDescription?: string } | undefined)
                ?.shortDescription;
              profileRevision += 1;
            }
            return route.fulfill({
              json: {
                propertyId: BOOKING_ADMIN_PROPERTY_ID,
                profileRevision,
                publicProfile: {
                  locale: "en",
                  shortDescription,
                  longDescription: null,
                  media: [
                    {
                      mediaObjectId: "f6853000-0000-4000-8000-000000000002",
                      mediaType: "hero_image",
                      url: "https://media.example/alpenrose-hero.webp",
                      altText: "Alpenrose",
                      sortOrder: 0,
                    },
                  ],
                },
              },
            });
          },
        );
        await page.route(`**${BOOKING_ADMIN_PUBLIC_BOOKABILITY_PATH}*`, (route) => {
          publicationRequests += 1;
          return route.fulfill({
            json: {
              propertyId: BOOKING_ADMIN_PROPERTY_ID,
              canonicalSlug: "hotel-alpenrose",
              canonicalUrl: "https://hotel-alpenrose.booking.localhost/en",
              bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
              profileStatus: "public",
              freshnessStatus: "fresh",
              missingReadiness: publicationRequests === 1 ? ["payment_method"] : [],
            },
          });
        });
      }
      await page.route("**/__booking-setup-history-start", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Before setup</title><h1>Before setup</h1>",
        }),
      );
      await page.route(
        (url) => url.toString() === marketplaceSetupReturnUrl(),
        (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Setup plan</title><h1>Setup plan refreshed</h1>",
          }),
      );

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

      await page.goto("/__booking-setup-history-start");
      const historyLengthBeforeHandoff = await page.evaluate(() => window.history.length);
      await page.goto(`/handoff?code=${destination.code}`);

      await expect.poll(() => new URL(page.url()).pathname).toBe(destination.pathname);
      const taskUrl = new URL(page.url());
      expect(taskUrl.searchParams.get("section")).toBe(destination.settingsSection);
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
      expect(await page.evaluate(() => window.history.length)).toBe(historyLengthBeforeHandoff + 1);

      if (destination.activeSection) {
        await expect(
          page.getByRole("button", { name: destination.activeSection, exact: true }).first(),
        ).toHaveAttribute("aria-current", "page");
      } else {
        await expect(page.getByRole("heading", { name: "Design Studio" })).toBeVisible();
      }

      await expect(page.getByText("Hotel setup", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Exit setup" })).toBeVisible();

      if (destination.taskId === "guest_settings_policies") {
        await expect(page.getByLabel("Check-in time")).toHaveValue("");
        await expect(page.getByLabel("Check-out time")).toHaveValue("");
        await expect(page.getByLabel("Terms & Conditions")).toHaveValue("");
        await expect(page.getByLabel("Cancellation Policy")).toHaveValue("");

        await page.getByRole("button", { name: "Save and return to setup", exact: true }).click();
        await expect(
          page.getByText(
            "Add a check-in time, check-out time, and cancellation policy before returning to setup.",
          ),
        ).toBeVisible();
        expect(guestSettingsRequests).toEqual([]);
        expect(new URL(page.url()).pathname).toBe("/settings");

        await page.getByLabel("Check-in time").fill("16:00");
        await page.getByLabel("Check-out time").fill("10:00");
        await page.getByLabel("Terms & Conditions").fill("Hotel Alpenrose booking terms.");
        await page
          .getByLabel("Cancellation Policy")
          .fill("Free cancellation until seven days before arrival.");
      }
      if (destination.taskId === "direct_booking_publication") {
        await expect(page.getByLabel("Public description")).toHaveValue(
          CANONICAL_PUBLIC_DESCRIPTION,
        );
        await page
          .getByRole("checkbox", {
            name: "Show the hotel's city and country on the public booking page",
          })
          .check();
        await page.getByRole("button", { name: "Save and return to setup", exact: true }).click();
        await expect(
          page.getByText(
            /Your design and public profile were saved, but direct booking is not ready yet/,
          ),
        ).toContainText("Finish setting up a payment method");
        expect(new URL(page.url()).pathname).toBe("/design-studio");
        expect(canonicalProfileRequests).toEqual([
          {
            expectedProfileRevision: 1,
            patch: { location: { localityPublic: true } },
          },
        ]);
        expect(publicProfileRequests).toEqual([
          {
            expectedProfileRevision: 2,
            patch: {
              shortDescription: CANONICAL_PUBLIC_DESCRIPTION,
            },
          },
        ]);
      }

      await page.getByRole("button", { name: "Save and return to setup", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Setup plan refreshed" })).toBeVisible();
      expect(page.url()).toBe(marketplaceSetupReturnUrl());
      expect(await page.evaluate(() => window.history.length)).toBe(historyLengthBeforeHandoff + 1);
      if (destination.taskId === "guest_settings_policies") {
        expect(guestSettingsRequests).toEqual([
          {
            check_in_time: "16:00",
            check_out_time: "10:00",
            terms_text: "Hotel Alpenrose booking terms.",
            cancellation_policy_text: "Free cancellation until seven days before arrival.",
          },
        ]);
      }
      if (destination.taskId === "direct_booking_publication") {
        expect(publicProfileRequests).toEqual([
          {
            expectedProfileRevision: 2,
            patch: {
              shortDescription: CANONICAL_PUBLIC_DESCRIPTION,
            },
          },
          {
            expectedProfileRevision: 3,
            patch: {
              shortDescription: CANONICAL_PUBLIC_DESCRIPTION,
            },
          },
        ]);
        expect(publicationRequests).toBe(2);
      }

      await page.goBack();
      await expect(page.getByRole("heading", { name: "Before setup" })).toBeVisible();
      expect(exchangeRequests).toEqual([{ code: destination.code }]);
    });
  }

  test("rejects untrusted, mismatched, or fragment-bearing task context", async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await page.addInitScript(
      (propertyId) => localStorage.setItem("selectedSharedPropertyId", propertyId),
      BOOKING_ADMIN_PROPERTY_ID,
    );
    await mockBookingAdminShellRoutes(page);
    await mockFinancePaymentSettings(page);

    const validContext = {
      section: "payments",
      taskId: "payment",
      destinationRouteKey: "finance.payment",
      planRevision: "e2e-plan-1",
      returnUrl: marketplaceSetupReturnUrl(),
    };
    const invalidContexts = [
      {
        ...validContext,
        returnUrl: `https://attacker.example/setup?propertyId=${BOOKING_ADMIN_PROPERTY_ID}`,
      },
      {
        ...validContext,
        section: "booking",
      },
    ];

    for (const context of invalidContexts) {
      await page.goto(`/settings?${new URLSearchParams(context).toString()}`);
      await expect(page.getByRole("heading", { name: "Setup task unavailable" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Return to setup plan" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Save and return to setup" })).toHaveCount(0);
    }

    await page.goto(`/settings?${new URLSearchParams(validContext).toString()}#untrusted`);
    await expect(page.getByRole("heading", { name: "Setup task unavailable" })).toBeVisible();
  });

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

  test("advances the canonical media revision and restores the approved hero after a conflict", async ({
    page,
  }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await page.addInitScript(
      (propertyId) => localStorage.setItem("selectedSharedPropertyId", propertyId),
      BOOKING_ADMIN_PROPERTY_ID,
    );
    await mockBookingAdminShellRoutes(page);
    await mockBookingAdminDesignSettings(page, {
      ...defaultBookingAdminDesignSettings,
      heroImage: "",
    });
    await page.route(
      `**/api/hotel-setup/properties/${BOOKING_ADMIN_PROPERTY_ID}/public-profile`,
      (route) =>
        route.fulfill({
          json: {
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            profileRevision: 1,
            publicProfile: {
              locale: "en",
              shortDescription: CANONICAL_PUBLIC_DESCRIPTION,
              longDescription: null,
              media: [],
            },
          },
        }),
    );

    const uploadSessionRequests: Array<Record<string, unknown>> = [];
    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      const request = route.request();
      if (request.method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: corsHeaders() });
      }
      if (request.url().endsWith("/finalize")) {
        if (uploadSessionRequests.length === 1) {
          return route.fulfill({
            status: 200,
            headers: corsHeaders(),
            json: {
              mediaObjects: [
                {
                  mediaId: "a1000000-0000-4000-8000-000000000001",
                  variants: [
                    {
                      publicCdnUrl: "https://media.example/approved-hero.webp",
                      storageKey: "public/hotels/approved-hero.webp",
                    },
                  ],
                },
              ],
            },
          });
        }
        return route.fulfill({
          status: 409,
          headers: corsHeaders(),
          json: {
            code: "profile_revision_conflict",
            message: "The property profile changed while its hero image was being finalized.",
            currentRevision: 3,
          },
        });
      }

      const body = request.postDataJSON() as Record<string, unknown>;
      uploadSessionRequests.push(body);
      const uploadNumber = uploadSessionRequests.length;
      return route.fulfill({
        status: 201,
        headers: corsHeaders(),
        json: {
          uploadSession: { sessionId: `hero-upload-${uploadNumber}` },
          uploadTargets: [
            {
              uploadTargetId: `hero-target-${uploadNumber}`,
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: `https://uploads.vayada.localhost/hero-upload-${uploadNumber}`,
              headers: {},
            },
          ],
        },
      });
    });

    await page.goto(`/design-studio?${directPublicationTaskParams().toString()}`);

    const missingHeroMessage = page.getByText(
      "Upload a hero image here so Vayada can approve it for the public booking profile.",
    );
    await expect(missingHeroMessage).toBeVisible();

    const heroInput = page.locator('input[type="file"][accept="image/*"]');
    await heroInput.setInputFiles({
      name: "first-hero.webp",
      mimeType: "image/webp",
      buffer: Buffer.from("first approved hero"),
    });

    await expect.poll(() => uploadSessionRequests).toHaveLength(1);
    expect(uploadSessionRequests[0]).toMatchObject({
      purpose: "property.hero_image",
      visibility: "public",
      expectedProfileRevision: 1,
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: BOOKING_ADMIN_HOTEL_ID,
      },
    });
    await expect(missingHeroMessage).toHaveCount(0);
    await expect(page.locator('img[alt="Hero"]')).toHaveAttribute(
      "src",
      "https://media.example/approved-hero.webp",
    );

    await heroInput.setInputFiles({
      name: "replacement-hero.webp",
      mimeType: "image/webp",
      buffer: Buffer.from("conflicting replacement hero"),
    });

    await expect.poll(() => uploadSessionRequests).toHaveLength(2);
    expect(uploadSessionRequests[1]).toMatchObject({
      purpose: "property.hero_image",
      visibility: "public",
      expectedProfileRevision: 2,
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        resourceId: BOOKING_ADMIN_HOTEL_ID,
      },
    });
    await expect(
      page.getByText(
        "This property changed in another session. Refresh Design Studio before uploading a new hero image.",
      ),
    ).toBeVisible();
    await expect(page.locator('img[alt="Hero"]')).toHaveAttribute(
      "src",
      "https://media.example/approved-hero.webp",
    );
    await expect(missingHeroMessage).toHaveCount(0);
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

  test("uploads, previews, and removes a Booking header logo", async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    const { requests } = await mockBookingAdminDesignSettings(page);
    const logoUrls = [
      "https://media.example/alpenrose-header-logo.webp",
      "https://media.example/alpenrose-header-logo-replacement.webp",
    ];
    const logoMediaObjectIds = [
      "a1000000-0000-4000-8000-000000001217",
      "a1000000-0000-4000-8000-000000001218",
    ];
    let uploadCount = 0;

    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      const request = route.request();
      if (request.url().endsWith("/finalize")) {
        const logoIndex = Math.max(0, uploadCount - 1);
        const logoUrl = logoUrls[logoIndex]!;
        await route.fulfill({
          json: {
            mediaObjects: [
              {
                mediaId: logoMediaObjectIds[logoIndex],
                purpose: "booking.header_logo",
                visibility: "public",
                variants: [{ publicCdnUrl: logoUrl }],
              },
            ],
          },
        });
        return;
      }

      expect(request.postDataJSON()).toMatchObject({
        purpose: "booking.header_logo",
        visibility: "public",
        resource: {
          product: "booking",
          resourceType: "booking_hotel",
          resourceId: BOOKING_ADMIN_HOTEL_ID,
        },
        files: [{ contentType: "image/svg+xml" }],
      });
      uploadCount += 1;
      await route.fulfill({
        json: {
          uploadSession: { sessionId: `header-logo-session-${uploadCount}` },
          uploadTargets: [
            {
              uploadTargetId: `header-logo-target-${uploadCount}`,
              method: "PUT",
              uploadUrl: `https://uploads.vayada.localhost/header-logo-target-${uploadCount}`,
              headers: { "content-type": "image/svg+xml" },
            },
          ],
        },
      });
    });

    await page.goto("/design-studio");
    await page.locator('input[accept*="image/svg+xml"]').setInputFiles({
      name: "alpenrose.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><rect width="300" height="80" fill="white"/></svg>',
      ),
    });

    await expect(page.getByAltText("Header logo preview")).toHaveAttribute("src", logoUrls[0]!);
    await expect(page.getByAltText("Alpenrose logo")).toHaveAttribute("src", logoUrls[0]!);
    await expect
      .poll(
        () =>
          requests.find(
            (request) =>
              request.method === "PATCH" &&
              request.body?.headerLogoMediaObjectId === logoMediaObjectIds[0],
          )?.body?.headerLogoMediaObjectId,
      )
      .toBe(logoMediaObjectIds[0]);

    const replacement = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="72"><rect width="260" height="72" fill="navy"/></svg>',
          ],
          "alpenrose-replacement.svg",
          { type: "image/svg+xml" },
        ),
      );
      return transfer;
    });
    await page.getByTestId("header-logo-dropzone").dispatchEvent("drop", {
      dataTransfer: replacement,
    });
    await expect(page.getByAltText("Header logo preview")).toHaveAttribute("src", logoUrls[1]!);
    await expect(page.getByAltText("Alpenrose logo")).toHaveAttribute("src", logoUrls[1]!);

    await page.getByRole("button", { name: "Manage header logo" }).click();
    await page.getByRole("button", { name: "Remove logo" }).click();
    await expect(page.getByAltText("Header logo preview")).toHaveCount(0);
    await expect(page.getByRole("main").getByText("Alpenrose", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save Changes" }).click();
    await expect
      .poll(
        () =>
          requests.filter((request) => request.method === "PATCH").at(-1)?.body
            ?.headerLogoMediaObjectId,
      )
      .toBeNull();
  });
});

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
          paymentsEnabled: true,
          paymentProvider: "vayada",
          acceptedMethods: ["card"],
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

async function mockGuestSettingsTask(
  page: Page,
  requests: Array<Record<string, unknown>>,
): Promise<void> {
  let settings: Record<string, unknown> = {
    ...defaultBookingAdminPropertySettings,
    check_in_time: "",
    check_out_time: "",
    cancellation_policy_text: "",
  };

  await page.route(`**${BOOKING_ADMIN_PROPERTY_SETTINGS_PATH}*`, (route) => {
    if (route.request().method() !== "PATCH") {
      return route.fulfill({ json: settings });
    }

    const body = route.request().postDataJSON() as Record<string, unknown>;
    requests.push(body);
    settings = { ...settings, ...body };
    return route.fulfill({ json: settings });
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  };
}

function marketplaceSetupReturnUrl(): string {
  const url = new URL("/setup", marketplaceOrigin());
  url.searchParams.set("propertyId", BOOKING_ADMIN_PROPERTY_ID);
  return url.toString();
}

function directPublicationTaskParams(): URLSearchParams {
  return new URLSearchParams({
    taskId: "direct_booking_publication",
    destinationRouteKey: "distribution.direct_booking_publication",
    planRevision: "e2e-plan-1",
    returnUrl: marketplaceSetupReturnUrl(),
  });
}

function canonicalMarketplaceSetupUrl(input: {
  entryProduct: "booking" | "marketplace" | "pms";
  returnTo: string;
  propertyId?: string;
  mode?: "add";
}): string {
  const url = new URL("/setup", marketplaceOrigin());
  url.searchParams.set("entryProduct", input.entryProduct);
  url.searchParams.set("returnProduct", "booking");
  url.searchParams.set("returnTo", input.returnTo);
  if (input.propertyId) url.searchParams.set("propertyId", input.propertyId);
  if (input.mode) url.searchParams.set("mode", input.mode);
  return url.toString();
}

function marketplaceOrigin(): string {
  return (
    process.env.E2E_MARKETPLACE_BASE_URL ||
    (process.env.CI === "true" || process.env.E2E_START_SERVERS === "1"
      ? "http://marketplace.localhost:3000"
      : "https://marketplace.localhost")
  );
}
