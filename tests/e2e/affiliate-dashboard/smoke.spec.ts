import { expect, type Page, type Route, type TestInfo, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

test.describe("affiliate-dashboard smoke", () => {
  test("login page renders the affiliate portal shell", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchAffiliateNoLegacyCalls(page, testInfo);

    await page.goto("/login");

    await expect(
      page.getByRole("heading", { name: /vayada Affiliate Portal/i, level: 1 }),
    ).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("dashboard uses target affiliate contracts without PMS calls", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchAffiliateNoLegacyCalls(page, testInfo);
    const targetApiRequests: string[] = [];
    await mockAffiliateAuthSession(page);
    await mockAffiliateTargetApi(page, targetApiRequests);

    await page.goto("/dashboard");

    await expect(page.getByRole("heading", { name: /hey affiliate/i })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hotel Alpenrose" })).toBeVisible();
    await expect(page.getByText("Payout History")).toBeVisible();

    expect(targetApiRequests).toEqual(
      expect.arrayContaining([
        "/api/affiliate/dashboard",
        "/api/affiliate/properties",
        "/api/affiliate/earnings?period=6m",
        "/api/affiliate/activity?limit=10",
        "/api/affiliate/payouts",
      ]),
    );

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("settings uses target finance payout settings contract", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchAffiliateNoLegacyCalls(page, testInfo);
    const targetApiRequests: string[] = [];
    await mockAffiliateAuthSession(page);
    await mockAffiliateTargetApi(page, targetApiRequests);

    await page.goto("/settings");

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Stripe" })).toBeVisible();
    await expect(page.getByText(/provider status: active/i)).toBeVisible();

    expect(targetApiRequests).toContain("/api/affiliate/payout-settings");

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});

function watchAffiliateNoLegacyCalls(page: Page, testInfo: TestInfo) {
  const failures: string[] = [];
  const legacyProductionHosts = new Set([
    "api.vayada.com",
    "pms-api.vayada.com",
    "api.pms.vayada.com",
  ]);

  page.on("request", (request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }

    if (url.hostname === "api.pms.localhost" || legacyProductionHosts.has(url.hostname)) {
      failures.push(`legacy PMS API host: ${request.method()} ${request.url()}`);
      return;
    }

    if (url.pathname === "/auth/compat/affiliate-dashboard-token") {
      failures.push(`affiliate compatibility token endpoint: ${request.method()} ${request.url()}`);
      return;
    }

    if (url.pathname.startsWith("/affiliate/")) {
      failures.push(`legacy PMS affiliate route: ${request.method()} ${request.url()}`);
    }
  });

  return async () => {
    if (failures.length === 0) return;
    const body = failures.join("\n");
    await testInfo.attach("affiliate-dashboard-legacy-calls", {
      body,
      contentType: "text/plain",
    });
    throw new Error(`Affiliate no-legacy-call guard failed:\n${body}`);
  };
}

async function mockAffiliateAuthSession(page: Page) {
  await page.route("**/auth/session**", async (route) => {
    await route.fulfill({
      json: {
        accessToken: "valid-token",
        csrfToken: "csrf-affiliate",
        organizationId: "org_affiliate_target_886",
        organizationKind: "affiliate_partner",
        user: {
          id: "user_affiliate_886",
          email: "affiliate@example.test",
          status: "active",
          workosUserId: "workos_affiliate_886",
        },
      },
      headers: corsHeaders(route),
    });
  });
}

async function mockAffiliateTargetApi(page: Page, targetApiRequests: string[]) {
  await page.route("**/api/affiliate/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders(route) });
      return;
    }

    const url = new URL(route.request().url());
    targetApiRequests.push(`${url.pathname}${url.search}`);

    switch (url.pathname) {
      case "/api/affiliate/dashboard":
        await route.fulfill({
          json: {
            contractVersion: "affiliate-dashboard.v1",
            affiliateId: "affiliate_target_886",
            summary: {
              currency: "EUR",
              totalCommissionAmount: "275.00",
              bookingCount: 4,
              clickCount: 80,
              conversionRate: 5,
              propertyCount: 1,
              outstandingBalanceAmount: "125.00",
              sourceFreshness: { marketplace: "target", finance: "target" },
            },
          },
          headers: corsHeaders(route),
        });
        return;
      case "/api/affiliate/properties":
        await route.fulfill({
          json: {
            contractVersion: "affiliate-dashboard.v1",
            affiliateId: "affiliate_target_886",
            properties: [
              {
                affiliateId: "affiliate_target_886",
                propertyId: "property_alpenrose",
                displayName: "Hotel Alpenrose",
                slug: "hotel-alpenrose",
                referralCode: "ALPEN-886",
                commissionPercent: 10,
                status: "active",
                metrics: {
                  bookingCount: 4,
                  totalRevenueAmount: "2750.00",
                  totalCommissionAmount: "275.00",
                  clickCount: 80,
                  conversionRate: 5,
                },
              },
            ],
          },
          headers: corsHeaders(route),
        });
        return;
      case "/api/affiliate/earnings":
        await route.fulfill({
          json: {
            contractVersion: "affiliate-dashboard.v1",
            affiliateId: "affiliate_target_886",
            period: url.searchParams.get("period") || "6m",
            currency: "EUR",
            buckets: [
              { bucketStart: "2026-04-01", label: "Apr", commissionAmount: "75.00" },
              { bucketStart: "2026-05-01", label: "May", commissionAmount: "100.00" },
              { bucketStart: "2026-06-01", label: "Jun", commissionAmount: "100.00" },
            ],
            sourceFreshness: { finance: "target" },
          },
          headers: corsHeaders(route),
        });
        return;
      case "/api/affiliate/activity":
        await route.fulfill({
          json: {
            contractVersion: "affiliate-dashboard.v1",
            affiliateId: "affiliate_target_886",
            activities: [
              {
                activityType: "booking",
                occurredAt: "2026-06-24T10:00:00.000Z",
                propertyName: "Hotel Alpenrose",
                count: 1,
              },
            ],
          },
          headers: corsHeaders(route),
        });
        return;
      case "/api/affiliate/payouts":
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            affiliateId: "affiliate_target_886",
            payouts: [
              {
                payoutId: "payout_affiliate_886",
                ownerScope: "organization",
                propertyId: null,
                organizationId: "org_affiliate_target_886",
                relatedPropertyId: "property_alpenrose",
                guestBookingId: "booking_886",
                paymentId: "payment_886",
                payoutStatus: "paid",
                amount: "125.00",
                feeAmount: "0.00",
                netAmount: "125.00",
                currency: "EUR",
                provider: "stripe",
                providerPayoutId: "po_886",
                scheduledAt: "2026-06-24T10:00:00.000Z",
                paidAt: "2026-06-24T10:05:00.000Z",
                failedAt: null,
                failureCode: null,
                retryCount: 0,
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
            sourceFreshness: { finance: { status: "fresh" } },
          },
          headers: corsHeaders(route),
        });
        return;
      case "/api/affiliate/payout-settings":
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            affiliateId: "affiliate_target_886",
            marketplaceOrganizationId: "org_affiliate_target_886",
            payoutSettings: {
              payoutsEnabled: true,
              payoutProvider: "stripe",
              payoutCurrency: "EUR",
              payoutSchedule: "monthly",
              payoutThresholdAmount: null,
              providerAccount: {
                providerAccountId: "acct_affiliate_target_886",
                provider: "stripe",
                status: "active",
                onboardingStatus: "completed",
                payoutsEnabled: true,
              },
              sourceFreshness: { finance: "target", status: "fresh" },
            },
          },
          headers: corsHeaders(route),
        });
        return;
      default:
        await route.fulfill({
          status: 404,
          json: { message: `Unhandled target affiliate mock: ${url.pathname}` },
          headers: corsHeaders(route),
        });
    }
  });
}

function corsHeaders(route: Route): Record<string, string> {
  const origin = route.request().headers().origin || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization,content-type,x-vayada-csrf",
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    vary: "Origin",
  };
}
