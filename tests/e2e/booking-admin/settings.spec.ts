import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_CUSTOM_DOMAIN_PATH,
  BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH,
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_PROPERTY_ID,
  BOOKING_ADMIN_PROPERTY_SETTINGS_PATH,
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
    let financePatchCount = 0;
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
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
        });
        return;
      }
      financePatchCount += 1;
      const body = route.request().postDataJSON() as {
        commandId: string;
        idempotencyKey: string;
        paymentSettings: {
          paymentProvider: string;
          acceptedMethods: string[];
        };
      };
      expect(body.commandId).toContain("settings-payment-settings");
      expect(body.idempotencyKey).toBe(body.commandId);
      expect(body.paymentSettings).toMatchObject({
        paymentProvider: "vayada",
        acceptedMethods: ["pay_at_property", "cash", "manual_card", "card"],
      });
      await route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: body.paymentSettings,
          commandMeta: {
            commandId: body.commandId,
            idempotencyKey: body.idempotencyKey,
            sideEffects: ["audit_event"],
            outboxEvents: [],
            jobs: [],
          },
        },
      });
    });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.getByRole("button", { name: "Booking", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Custom Domain" })).toHaveCount(0);
    await expect(page.getByPlaceholder("booking.yourdomain.com")).toHaveCount(0);

    await page.getByRole("button", { name: "Location map", exact: true }).click();
    await expect(
      page.getByText("Automatic property map centering is not available on next-api yet."),
    ).toBeVisible();

    await page.getByRole("button", { name: "Payments", exact: true }).click();
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect(page.getByText("Payment settings saved").first()).toBeVisible();
    expect(financePatchCount).toBe(1);

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

    await page.getByRole("button", { name: "Location map", exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("section")).toBe("location");

    await page.goBack();
    await expect(page.getByRole("button", { name: "Booking", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.goForward();
    await expect(page.getByRole("button", { name: "Location map", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await page.goto("/settings?section=unknown", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Property", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );

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
});
