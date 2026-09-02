import { expect, test } from "@playwright/test";
import { stripeOnboardingPropertyKey } from "../../../apps/booking-admin/lib/utils/stripeOnboardingRefresh";
import {
  BOOKING_ADMIN_CUSTOM_DOMAIN_PATH,
  BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH,
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  BOOKING_ADMIN_PROPERTY_SETTINGS_PATH,
  BOOKING_ADMIN_SAME_DAY_PATH,
  defaultBookingAdminPropertySettings,
  defaultCustomDomain,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
  type BookingAdminCustomDomainFixture,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin settings no-legacy guard", () => {
  test("loads and saves the shared same-day booking cutoff", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    let failRead = true;
    let failWrite = false;
    await page.route(`**${BOOKING_ADMIN_SAME_DAY_PATH}*`, async (route) => {
      if (route.request().method() === "GET" && failRead) {
        failRead = false;
        await route.fulfill({ status: 503, json: { message: "Same-day settings unavailable." } });
        return;
      }
      if (route.request().method() === "PUT" && failWrite) {
        await route.fulfill({
          status: 503,
          json: { message: "Same-day settings were not saved." },
        });
        return;
      }
      await route.fallback();
    });
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: false,
            paymentProvider: "vayada",
            acceptedMethods: ["pay_at_property", "cash"],
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

    await page.goto("/settings?section=booking");

    await expect(
      page.getByRole("alert").filter({ hasText: "Same-day settings unavailable." }),
    ).toBeVisible();
    await expect(page.getByRole("switch", { name: "Allow same-day bookings" })).toHaveCount(0);
    await expect(page.getByLabel("Same-day booking cutoff")).toHaveCount(0);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByRole("switch", { name: "Allow same-day bookings" })).toBeChecked();
    const assertHealthy = watchPageHealth(page, testInfo);
    const cutoff = page.getByLabel("Same-day booking cutoff");
    await expect(cutoff).toHaveValue("18:00");
    await expect(page.getByText(/property timezone \(Europe\/Vienna\)/)).toBeVisible();
    const sameDayWrite = page.waitForRequest(
      (request) => request.method() === "PUT" && request.url().endsWith("/same-day-booking"),
    );
    await cutoff.selectOption("17:30");
    const body = (await sameDayWrite).postDataJSON();
    expect(body).toMatchObject({ enabled: true, cutoffLocalTime: "17:30" });
    expect(body.idempotencyKey).toBe(body.commandId);
    const success = page.getByText("Same-day booking settings saved.");
    await expect(success).toBeVisible();
    await assertNoLegacyCalls();
    await assertHealthy();

    failWrite = true;
    await cutoff.selectOption("17:00");
    await expect(success).toHaveCount(0);
    await expect(
      page.getByRole("alert").filter({ hasText: "Same-day settings were not saved." }),
    ).toBeVisible();
    await assertNoLegacyCalls();
  });

  test("shows onboarding social links in Property settings and keeps all four editable", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    const persisted = {
      ...defaultBookingAdminPropertySettings,
      property_name: "Alpenrose",
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
      tiktok: "https://tiktok.com/@alpenrose",
      youtube: "https://youtube.com/@alpenrose",
    };
    await mockBookingAdminShellRoutes(page, { propertySettings: persisted });
    const writes: unknown[] = [];
    await page.route(`**${BOOKING_ADMIN_PROPERTY_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        writes.push(body);
        Object.assign(persisted, body);
      }
      await route.fulfill({ json: persisted });
    });

    await page.goto("/settings");

    await expect(page.getByPlaceholder("https://instagram.com/yourhotel")).toHaveValue(
      "https://instagram.com/alpenrose",
    );
    await expect(page.getByPlaceholder("https://facebook.com/yourhotel")).toHaveValue(
      "https://facebook.com/alpenrose",
    );
    await expect(page.getByPlaceholder("https://www.tiktok.com/@yourhotel")).toHaveValue(
      "https://tiktok.com/@alpenrose",
    );
    await expect(page.getByPlaceholder("https://youtube.com/@yourhotel")).toHaveValue(
      "https://youtube.com/@alpenrose",
    );

    await page
      .getByPlaceholder("https://www.tiktok.com/@yourhotel")
      .fill("https://tiktok.com/@alpenrose-hotel");
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();

    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0]).toMatchObject({
      instagram: "https://instagram.com/alpenrose",
      facebook: "https://facebook.com/alpenrose",
      tiktok: "https://tiktok.com/@alpenrose-hotel",
      youtube: "https://youtube.com/@alpenrose",
    });
    await assertHealthy();
  });

  test("loads migrated settings surfaces without helper calls", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(
      `**/api/pms/properties/${BOOKING_ADMIN_PROPERTY_ID}/payment-settings*`,
      (route) =>
        route.fulfill({
          json: {
            paymentSettings: {
              paymentProvider: "vayada",
              payAtPropertyEnabled: true,
              onlineCardPayment: true,
              bankTransfer: false,
            },
          },
        }),
    );
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "vayada",
            acceptedMethods: ["pay_at_property", "cash", "manual_card", "card"],
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
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.getByRole("button", { name: "Booking", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Custom Domain" })).toHaveCount(0);
    await expect(page.getByPlaceholder("booking.yourdomain.com")).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Enable map view" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: '"Refer a Guest" Feature' })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Location map", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Notifications", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Payments", exact: true }).click();
    await expect(
      page.getByText("vayada Payments is not available in target checkout yet."),
    ).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("moves custom domain setup to Design Studio and updates the live preview", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    let customDomain: BookingAdminCustomDomainFixture = defaultCustomDomain;
    await page.route(`**${BOOKING_ADMIN_CUSTOM_DOMAIN_PATH}*`, async (route) => {
      const method = route.request().method();
      if (method === "PUT") {
        const body = route.request().postDataJSON() as { domain: string };
        customDomain = {
          hotelId: BOOKING_ADMIN_HOTEL_ID,
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          configured: true,
          domain: body.domain,
          status: "pending",
          sslStatus: "pending",
          dnsRecords: [
            {
              type: "CNAME",
              name: body.domain,
              value: "custom.booking.vayada.com",
              status: "pending",
            },
          ],
          verificationErrors: [],
          checkedAt: "2026-06-22T10:00:00.000Z",
          updatedAt: "2026-06-22T10:00:00.000Z",
        };
        await route.fulfill({ json: customDomain });
        return;
      }
      if (method === "DELETE") {
        customDomain = defaultCustomDomain;
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({ json: customDomain });
    });

    await page.goto("/design-studio");

    const customDomainHeading = page.getByRole("heading", { name: "Custom Domain" });
    const heroImageHeading = page.getByRole("heading", { name: /Hero Image/ });
    const preview = page.getByLabel("Live booking page preview");
    await expect(customDomainHeading).toBeVisible();
    await expect(heroImageHeading).toBeVisible();
    const mediaHeadings = await page.locator("h2").allTextContents();
    expect(mediaHeadings.indexOf("Custom Domain")).toBeLessThan(
      mediaHeadings.findIndex((heading) => heading.startsWith("Hero Image")),
    );
    await expect(preview).toContainText("hotel-alpenrose.booking.vayada.com");

    await page.getByPlaceholder("booking.yourdomain.com").fill("book.alpenrose.example");
    await page.getByRole("button", { name: "Connect Domain" }).click();

    await expect(preview).toContainText("book.alpenrose.example");
    await expect(preview).not.toContainText("hotel-alpenrose.booking.vayada.com");
    await expect(page.getByText("custom.booking.vayada.com")).toBeVisible();

    await page.getByRole("button", { name: "Remove Domain" }).click();

    await expect(page.getByPlaceholder("booking.yourdomain.com")).toBeVisible();
    await expect(preview).toContainText("hotel-alpenrose.booking.vayada.com");
    await assertHealthy();
  });

  test("keeps section deep links in sync with browser history", async ({ page }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: false,
            paymentProvider: "vayada",
            acceptedMethods: ["pay_at_property", "cash"],
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

    await page.goto("/settings?billing=canceled&source=email&section=payments", {
      waitUntil: "networkidle",
    });
    await expect(page.getByRole("button", { name: "Payments", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Payments", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.getByRole("button", { name: "Booking", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("section")).toBe("booking");
    expect(new URL(page.url()).searchParams.get("billing")).toBe("canceled");
    expect(new URL(page.url()).searchParams.get("source")).toBe("email");

    await page.getByRole("button", { name: "Localization", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("section")).toBe("localization");

    await page.goBack();
    await expect(page.getByRole("button", { name: "Booking", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.goForward();
    await expect(page.getByRole("button", { name: "Localization", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    for (const section of ["location", "notifications"]) {
      await page.goto(`/settings?section=${section}`, { waitUntil: "networkidle" });
      await expect(page.getByRole("button", { name: "Property", exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }

    await page.goto("/settings?section=unknown", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Property", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.goto("/settings?section=account", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Property", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByRole("button", { name: "Account", exact: true })).toHaveCount(0);
    await expect(page.getByText("Personal account security")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    const mobilePropertyButton = page.getByRole("button", { name: "Property", exact: true });
    const mobileBookingButton = page.getByRole("button", { name: "Booking", exact: true });
    const mobileLocalizationButton = page.getByRole("button", {
      name: "Localization",
      exact: true,
    });
    await expect(mobileBookingButton).toBeVisible();
    await mobilePropertyButton.focus();
    await page.keyboard.press("Tab");
    await expect(mobileBookingButton).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(mobileLocalizationButton).toBeFocused();

    await page.goto("/settings?billing=canceled", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Billing", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await assertHealthy();
  });

  test("switches Fixed through Stripe and schedules Commission at period end", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          paymentSettings: {
            paymentsEnabled: false,
            paymentProvider: "stripe",
            acceptedMethods: [],
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

    let plan: "commission" | "fixed" = "commission";
    let cancelAtPeriodEnd = false;
    const planResponse = () => ({
      contractVersion: "finance-subscriptions.v1",
      propertyId: BOOKING_ADMIN_PROPERTY_ID,
      planStatus: {
        plan,
        status: cancelAtPeriodEnd
          ? "cancel_at_period_end"
          : plan === "fixed"
            ? "active"
            : "commission",
        currency: "EUR",
        activeRoomCount: 3,
        amountMinor: 4_000,
        currentPeriodStart: plan === "fixed" ? "2026-08-11T12:00:00.000Z" : null,
        currentPeriodEnd: plan === "fixed" ? "2026-09-10T12:00:00.000Z" : null,
        nextBillingDate: plan === "fixed" && !cancelAtPeriodEnd ? "2026-09-10T12:00:00.000Z" : null,
        cancelAtPeriodEnd,
        checkoutPending: false,
        customerPortalAvailable: plan === "fixed",
        activatedAt: plan === "fixed" ? "2026-08-11T12:00:00.000Z" : null,
        updatedAt: "2026-08-11T12:00:00.000Z",
      },
    });
    await page.route(`**${BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH}*`, (route) =>
      route.fulfill({ json: planResponse() }),
    );
    let checkoutCount = 0;
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/fixed-plan/checkout`,
      async (route) => {
        checkoutCount += 1;
        const body = route.request().postDataJSON() as {
          commandId: string;
          idempotencyKey: string;
        };
        expect(body.idempotencyKey).toBe(body.commandId);
        expect(body).not.toHaveProperty("customerEmail");
        plan = "fixed";
        await route.fulfill({
          json: {
            contractVersion: "finance-subscriptions.v1",
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            checkout: {
              checkoutSessionId: "cs_fixed",
              checkoutUrl: new URL("/settings?billing=success", page.url()).toString(),
              currency: "EUR",
              amountMinor: 4_000,
              activeRoomCount: 3,
            },
          },
        });
      },
    );
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/switch-to-commission`,
      async (route) => {
        const body = route.request().postDataJSON() as {
          commandId: string;
          idempotencyKey: string;
        };
        expect(body.idempotencyKey).toBe(body.commandId);
        cancelAtPeriodEnd = true;
        await route.fulfill({ json: planResponse() });
      },
    );

    await page.goto("/settings");
    await page.getByRole("button", { name: "Billing", exact: true }).click();
    await page.getByRole("button", { name: "Switch to Fixed Plan" }).click();
    const fixedDialog = page.getByRole("dialog");
    await expect(fixedDialog).toContainText(
      "Your first payment will be charged today. Future payments will be charged every 30 days.",
    );
    await fixedDialog.getByRole("button", { name: "Continue to payment" }).click();
    await expect(page.getByText("Fixed Plan is active.")).toBeVisible();
    expect(checkoutCount).toBe(1);

    await page.getByRole("button", { name: "Switch to Commission Plan" }).click();
    const commissionDialog = page.getByRole("dialog");
    await expect(commissionDialog).toContainText(
      "Commission will apply to all bookings created after that date.",
    );
    await commissionDialog.getByRole("button", { name: "Switch to Commission Plan" }).click();
    await expect(page.getByText(/Your Fixed Plan is paid through/)).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("opens Stripe Express Dashboard only for a connected property account", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    let stripeConnected = true;
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, (route) =>
      route.fulfill({
        json: {
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "stripe",
            acceptedMethods: ["card"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: stripeConnected
                ? "acct_property_e2e"
                : `settings-choice:${BOOKING_ADMIN_PROPERTY_ID}:stripe`,
              provider: "stripe",
              status: stripeConnected ? "active" : "not_configured",
              onboardingStatus: stripeConnected ? "completed" : "not_started",
              chargesEnabled: stripeConnected,
              payoutsEnabled: stripeConnected,
              capabilities: stripeConnected ? ["card_payments", "transfers"] : [],
            },
          },
        },
      }),
    );

    let dashboardRequest: { method: string; body: string | null } | null = null;
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/provider-accounts/stripe/dashboard-link`,
      async (route) => {
        dashboardRequest = {
          method: route.request().method(),
          body: route.request().postData(),
        };
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({
          json: { url: new URL("/stripe-dashboard-opened", page.url()).toString() },
        });
      },
    );

    await page.goto("/settings");
    await page.getByRole("button", { name: "Payments", exact: true }).click();
    const dashboardButton = page.getByRole("button", { name: "View Stripe Dashboard" });
    await expect(dashboardButton).toBeVisible();
    await expect(
      page.getByText(
        "Check your payouts, balance, and payment history, or update your bank account.",
      ),
    ).toBeVisible();

    const popupPromise = page.waitForEvent("popup");
    await dashboardButton.click();
    await expect(page.getByRole("button", { name: "Opening Stripe..." })).toBeDisabled();
    const stripeDashboard = await popupPromise;
    await stripeDashboard.waitForURL("**/stripe-dashboard-opened");
    expect(dashboardRequest).toEqual({ method: "POST", body: null });

    stripeConnected = false;
    await page.reload();
    await page.getByRole("button", { name: "Payments", exact: true }).click();
    await expect(page.getByRole("button", { name: "View Stripe Dashboard" })).toHaveCount(0);

    await assertHealthy();
  });

  test("persists Stripe before account creation and stops after a failed save", async ({
    page,
  }) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    let persistedProvider: "vayada" | "stripe" = "vayada";
    let failSave = false;
    let accountCreates = 0;
    const order: string[] = [];
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            paymentSettings: {
              paymentsEnabled: true,
              paymentProvider: persistedProvider,
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
        });
        return;
      }

      order.push("save");
      const body = route.request().postDataJSON() as {
        paymentSettings: { paymentProvider: string };
      };
      expect(body.paymentSettings.paymentProvider).toBe("stripe");
      if (failSave) {
        await route.fulfill({ status: 503, json: { error: "write unavailable" } });
        return;
      }
      persistedProvider = "stripe";
      await route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: body.paymentSettings,
        },
      });
    });
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/provider-accounts/stripe`,
      async (route) => {
        order.push("create");
        accountCreates += 1;
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            providerAccountId: "provider_account_e2e",
            provider: "stripe",
            providerAccountRef: "acct_e2e",
            status: "setup_incomplete",
            onboardingStatus: "invited",
            onboardingUrl: "about:blank#stripe-onboarding",
          },
        });
      },
    );

    await page.goto("/settings?section=payments");
    await page.getByRole("button", { name: /Stripe Connect/ }).click();
    const firstPopup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect Payment Account" }).click();
    const onboarding = await firstPopup;
    await onboarding.waitForURL("about:blank#stripe-onboarding");
    expect(order).toEqual(["save", "create"]);
    await onboarding.close();

    await page.reload();
    await expect(page.getByRole("button", { name: /Stripe Connect/ })).toHaveClass(
      /border-primary-500/,
    );
    await expect(page.getByRole("button", { name: "Connect Payment Account" })).toBeVisible();

    persistedProvider = "vayada";
    failSave = true;
    order.length = 0;
    await page.reload();
    await page.getByRole("button", { name: /Stripe Connect/ }).click();
    const failedPopup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Connect Payment Account" }).click();
    const closedPopup = await failedPopup;
    await closedPopup.waitForEvent("close");

    expect(order).toEqual(["save"]);
    expect(accountCreates).toBe(1);
    await expect(page.getByText("Failed to save")).toBeVisible();
    await expect(page.getByRole("button", { name: "Payments", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("relinks a persisted Stripe account once without rewriting payment settings", async ({
    page,
  }) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    let settingsWrites = 0;
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
      if (route.request().method() !== "GET") {
        settingsWrites += 1;
        await route.fulfill({ status: 500, json: { error: "unexpected settings write" } });
        return;
      }
      await route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "stripe",
            acceptedMethods: ["card", "bank_transfer"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            depositPolicy: {},
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: "provider_account_e2e",
              provider: "stripe",
              status: "setup_incomplete",
              onboardingStatus: "invited",
              chargesEnabled: false,
              payoutsEnabled: false,
              capabilities: [],
            },
          },
        },
      });
    });

    let onboardingLinks = 0;
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/provider-accounts/provider_account_e2e/onboarding-link`,
      async (route) => {
        onboardingLinks += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            providerAccountId: "provider_account_e2e",
            provider: "stripe",
            providerAccountRef: "acct_e2e",
            status: "setup_incomplete",
            onboardingStatus: "invited",
            onboardingUrl: "about:blank#stripe-relink",
          },
        });
      },
    );

    await page.goto("/settings?section=payments");
    const popup = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Complete Onboarding" }).dblclick();
    const onboarding = await popup;
    await onboarding.waitForURL("about:blank#stripe-relink");

    expect(settingsWrites).toBe(0);
    expect(onboardingLinks).toBe(1);
    await onboarding.close();
  });

  test("reconciles Stripe on return and reloads the connected payment state", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    const onboardingFlowId = "stripe-onboarding-e2e-flow";
    await page.addInitScript(
      ({ key, value }) => {
        if (window.location.search.includes("stripe=return")) {
          window.localStorage.setItem(key, value);
        }
      },
      {
        key: stripeOnboardingPropertyKey(BOOKING_ADMIN_PROPERTY_ID),
        value: onboardingFlowId,
      },
    );

    let stripeConnected = false;
    let returnMissingAccount = false;
    let paymentSettingsReads = 0;
    let releaseInitialRead!: () => void;
    let confirmInitialReadFinished!: () => void;
    const initialReadGate = new Promise<void>((resolve) => {
      releaseInitialRead = resolve;
    });
    const initialReadFinished = new Promise<void>((resolve) => {
      confirmInitialReadFinished = resolve;
    });
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
      paymentSettingsReads += 1;
      const isInitialRead = paymentSettingsReads === 1;
      if (isInitialRead) await initialReadGate;
      await route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "stripe",
            acceptedMethods: ["card"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            depositPolicy: {},
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: returnMissingAccount ? null : "provider_account_e2e",
              provider: returnMissingAccount ? null : "stripe",
              status: returnMissingAccount
                ? "not_configured"
                : stripeConnected
                  ? "active"
                  : "setup_incomplete",
              onboardingStatus: returnMissingAccount
                ? "not_started"
                : stripeConnected
                  ? "completed"
                  : "invited",
              chargesEnabled: !returnMissingAccount && stripeConnected,
              payoutsEnabled: !returnMissingAccount && stripeConnected,
              capabilities:
                !returnMissingAccount && stripeConnected ? ["card_payments", "transfers"] : [],
            },
          },
        },
      });
      if (isInitialRead) confirmInitialReadFinished();
    });

    const reconciliationBodies: Array<Record<string, unknown>> = [];
    let failReconciliation = false;
    const forbiddenSetupRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (
        request.method() === "POST" &&
        (pathname.endsWith("/provider-accounts/stripe") || pathname.endsWith("/onboarding-link"))
      ) {
        forbiddenSetupRequests.push(pathname);
      }
    });
    await page.route(
      `**/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}/provider-accounts/stripe/reconcile`,
      async (route) => {
        const body = route.request().postDataJSON() as Record<string, unknown>;
        reconciliationBodies.push(body);
        expect(body.idempotencyKey).toBe(body.commandId);
        expect(body).not.toHaveProperty("providerAccountRef");
        if (failReconciliation) {
          await route.fulfill({ status: 503, json: { error: "temporarily unavailable" } });
          return;
        }
        stripeConnected = true;
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            providerAccount: {
              provider: "stripe",
              status: "setup_incomplete",
              onboardingStatus: "invited",
              chargesEnabled: false,
              payoutsEnabled: false,
              detailsSubmitted: false,
              cardPaymentsStatus: "pending",
              ready: false,
            },
          },
        });
      },
    );

    await page.goto("/settings?stripe=return");

    await expect(page).toHaveURL(/\/settings\?section=payments$/);
    await expect(page.getByText("Stripe is connected.")).toBeVisible();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    expect(reconciliationBodies).toEqual(
      [1, 2, 3].map((attempt) => ({
        commandId: `${onboardingFlowId}:attempt:${attempt}`,
        idempotencyKey: `${onboardingFlowId}:attempt:${attempt}`,
      })),
    );
    expect(paymentSettingsReads).toBeGreaterThanOrEqual(2);

    releaseInitialRead();
    await initialReadFinished;
    await page.waitForTimeout(100);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await expect(page.getByText("Pending Onboarding", { exact: true })).toHaveCount(0);
    const markerKey = stripeOnboardingPropertyKey(BOOKING_ADMIN_PROPERTY_ID);
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), markerKey))
      .toBe(`settled:${onboardingFlowId}`);

    await page.goto("/settings?section=payments");
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    const readsBeforeOriginalFocus = paymentSettingsReads;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect
      .poll(() => page.evaluate((key) => window.localStorage.getItem(key), markerKey))
      .toBeNull();
    expect(reconciliationBodies).toHaveLength(3);
    expect(paymentSettingsReads).toBeGreaterThan(readsBeforeOriginalFocus);
    await assertHealthy();

    stripeConnected = false;
    returnMissingAccount = true;
    failReconciliation = true;
    await page.goto("/settings?stripe=return");
    await expect(page).toHaveURL(/\/settings\?section=payments$/);
    await expect(page.getByText("Couldn't refresh Stripe status.")).toBeVisible();
    await expect(page.getByText("Pending Onboarding", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check Stripe status" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect payment account" })).toHaveCount(0);
    await page.getByRole("button", { name: "Check Stripe status" }).click();
    await expect(page.getByText("Couldn't refresh Stripe status.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect payment account" })).toHaveCount(0);
    expect(forbiddenSetupRequests).toEqual([]);
    await assertNoLegacyCalls();
  });
});
