import { expect, test } from "@playwright/test";
import type { Route } from "@playwright/test";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

test.describe("vayada-admin smoke", () => {
  test("login page renders custom password auth", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /vayada admin/i, level: 1 })).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

    await assertHealthy();
  });

  test("register redirects to login because public admin signup is closed", async ({ request }) => {
    const response = await request.get("/register", { maxRedirects: 0 });

    expect(response.status()).toBe(307);
    const location = new URL(response.headers().location ?? "", "https://admin.localhost");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("register")).toBe("closed");
  });

  test("marketplace preview uses next-api discovery without legacy calls", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(
      page,
      testInfo,
      "vayada-admin-marketplace-preview",
    );
    const marketplaceBaseURL = baseURL?.startsWith("http://127.0.0.1:3001")
      ? "http://localhost:3001"
      : (baseURL ?? "https://admin.localhost");
    const pageOrigin = new URL(marketplaceBaseURL).origin;

    await page.addInitScript(() => {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      window.localStorage.setItem("access_token", "e2e-platform-token");
      window.localStorage.setItem("token_expires_at", String(expiresAt));
      window.localStorage.setItem("isLoggedIn", "true");
      window.localStorage.setItem("userId", "user_platform_admin");
      window.localStorage.setItem("userEmail", "platform-admin@example.test");
      window.localStorage.setItem("userStatus", "active");
      window.localStorage.setItem("isSuperAdmin", "true");
      window.localStorage.setItem(
        "user",
        JSON.stringify({
          id: "user_platform_admin",
          email: "platform-admin@example.test",
          status: "active",
          is_superadmin: true,
        }),
      );
    });

    await page.route(
      /https:\/\/api\.localhost(?::\d+)?\/api\/marketplace\/offers(?:\?|$)/,
      async (route) => {
        await fulfillJson(route, pageOrigin, {
          items: [
            {
              offerId: "offer_target_885",
              offerPublicId: "offer-public-target-885",
              offerTitle: "Target creator stay",
              offerSummary: "A next-api Marketplace offer.",
              hotelName: "Target Inn",
              hotelSlug: "target-inn",
              hotelAccommodationType: "hotel",
              hotelLocation: { displayText: "Luxembourg" },
              hotelCoverImageUrl: null,
              hotelImageUrls: [],
              deliverables: [],
              compensationOptions: [],
              creatorRequirements: null,
              createdAt: "2026-06-24T10:00:00.000Z",
              projectedAt: "2026-06-24T10:00:00.000Z",
            },
          ],
          pagination: { limit: 200, offset: 0, total: 1 },
        });
      },
    );

    await page.route(
      /https:\/\/api\.localhost(?::\d+)?\/api\/marketplace\/creators(?:\?|$)/,
      async (route) => {
        await fulfillJson(route, pageOrigin, {
          items: [
            {
              creatorId: "creator_target_885",
              displayName: "Target Creator",
              locationText: "Luxembourg",
              shortDescription: "Next-api creator profile.",
              portfolioUrl: null,
              profilePictureUrl: null,
              creatorType: "travel",
              platforms: [],
              audienceSize: 1200,
              averageRating: 5,
              totalReviews: 3,
              createdAt: "2026-06-24T10:00:00.000Z",
            },
          ],
          pagination: { limit: 200, offset: 0, total: 1 },
        });
      },
    );

    await page.goto(new URL("/dashboard/marketplace", marketplaceBaseURL).toString());

    await expect(page.getByRole("heading", { name: "Marketplace", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Offers \(1\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Creators \(1\)/ })).toBeVisible();
    await expect(page.getByText("Target creator stay")).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("records affiliate payout evidence through target Finance only", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(
      page,
      testInfo,
      "vayada-admin-affiliate-payouts",
    );
    const adminBaseURL = baseURL?.startsWith("http://127.0.0.1:3001")
      ? "http://localhost:3001"
      : (baseURL ?? "https://admin.localhost");
    const pageOrigin = new URL(adminBaseURL).origin;
    const affiliateId = "affiliate-target-1281";
    const organizationId = "30000000-0000-4000-8000-000000000001";
    const markPaidRequests: Array<Record<string, unknown>> = [];
    const listOffsets: string[] = [];

    await page.addInitScript(() => {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      window.localStorage.setItem("access_token", "e2e-platform-token");
      window.localStorage.setItem("token_expires_at", String(expiresAt));
      window.localStorage.setItem("isLoggedIn", "true");
      window.localStorage.setItem("userId", "user_platform_admin");
      window.localStorage.setItem("userEmail", "platform-admin@example.test");
      window.localStorage.setItem("userStatus", "active");
      window.localStorage.setItem("isSuperAdmin", "true");
      window.localStorage.setItem(
        "user",
        JSON.stringify({
          id: "user_platform_admin",
          email: "platform-admin@example.test",
          status: "active",
          is_superadmin: true,
        }),
      );
    });

    await page.route(
      /https:\/\/api\.localhost(?::\d+)?\/api\/finance\/platform\/affiliate-payouts(?:\?|$)/,
      async (route) => {
        const offset = new URL(route.request().url()).searchParams.get("offset") ?? "0";
        listOffsets.push(offset);
        await fulfillJson(route, pageOrigin, {
          contractVersion: "finance-platform-affiliate-payouts.v1",
          summaries:
            offset === "0"
              ? [
                  {
                    affiliateId,
                    organizationId,
                    affiliateLifecycleStatus: "active",
                    currency: "EUR",
                    payoutMethod: "bank_transfer",
                    outstandingAmount: "75.00",
                    payableAmount: "50.00",
                    paidAmount: "25.00",
                    payoutCount: 2,
                    payableCount: 1,
                    lastPaidAt: "2026-08-01T09:00:00.000Z",
                  },
                ]
              : [
                  {
                    affiliateId: "affiliate-inactive-1281",
                    organizationId: "30000000-0000-4000-8000-000000000002",
                    affiliateLifecycleStatus: "inactive",
                    currency: "EUR",
                    payoutMethod: "manual",
                    outstandingAmount: "0.00",
                    payableAmount: "0.00",
                    paidAmount: "10.00",
                    payoutCount: 1,
                    payableCount: 0,
                    lastPaidAt: "2026-07-01T09:00:00.000Z",
                  },
                ],
          total: 2,
          limit: 500,
          offset: Number(offset),
        });
      },
    );
    await page.route(
      new RegExp(
        `https://api\\.localhost(?::\\d+)?/api/finance/platform/affiliate-payouts/${affiliateId}(?:\\?currency=EUR|/mark-paid)$`,
      ),
      async (route) => {
        if (route.request().method() === "POST") {
          const body = route.request().postDataJSON() as Record<string, unknown>;
          markPaidRequests.push(body);
          await fulfillJson(route, pageOrigin, {
            contractVersion: "finance-platform-affiliate-payouts.v1",
            status: "updated",
            evidence: {
              evidenceId: "40000000-0000-4000-8000-000000000001",
              affiliateId,
              organizationId,
              payoutIds: ["50000000-0000-4000-8000-000000000001"],
              amount: "50.00",
              currency: "EUR",
              paymentMethod: body.paymentMethod,
              externalReference: body.externalReference,
              evidenceReference: body.evidenceReference,
              note: body.note,
              paidAt: body.paidAt,
              recordedAt: "2026-08-13T09:00:00.000Z",
            },
          });
          return;
        }
        await fulfillJson(route, pageOrigin, {
          contractVersion: "finance-platform-affiliate-payouts.v1",
          summary: {
            affiliateId,
            organizationId,
            affiliateLifecycleStatus: "active",
            currency: "EUR",
            payoutMethod: "bank_transfer",
            outstandingAmount: "75.00",
            payableAmount: "50.00",
            paidAmount: "25.00",
            payoutCount: 2,
            payableCount: 1,
            lastPaidAt: "2026-08-01T09:00:00.000Z",
          },
          payouts: [
            {
              payoutId: "50000000-0000-4000-8000-000000000001",
              relatedPropertyId: null,
              guestBookingId: null,
              payoutStatus: "pending",
              amount: "50.00",
              feeAmount: "0.00",
              netAmount: "50.00",
              currency: "EUR",
              payoutMethod: "bank_transfer",
              providerPayoutId: null,
              scheduledAt: "2026-08-13T08:00:00.000Z",
              paidAt: null,
              failedAt: null,
              failureCode: null,
              retryCount: 0,
              manualMarkPaidEligible: true,
              paymentEvidenceId: null,
            },
          ],
          history: [],
        });
      },
    );

    await page.goto(new URL("/dashboard/affiliate-payouts", adminBaseURL).toString());
    await expect(page.getByRole("heading", { name: "Affiliate payouts", level: 1 })).toBeVisible();
    await expect(page.getByText(affiliateId, { exact: true })).toBeVisible();
    await expect.poll(() => listOffsets.includes("1")).toBe(true);
    await page.getByRole("button", { name: "Details" }).click();
    await expect(page.getByRole("heading", { name: "Affiliate payout detail" })).toBeVisible();
    await page.getByRole("button", { name: "Record external payment" }).click();
    await page.getByLabel("External reference").fill("bank-transfer-e2e-1281");
    await page.getByLabel("Evidence reference").fill("vault://e2e/transfer-1281");
    await page.getByRole("button", { name: /Confirm .*50\.00 paid/ }).click();

    await expect.poll(() => markPaidRequests.length).toBe(1);
    expect(markPaidRequests[0]).toMatchObject({
      currency: "EUR",
      payoutIds: ["50000000-0000-4000-8000-000000000001"],
      expectedAmount: "50.00",
      paymentMethod: "bank_transfer",
      externalReference: "bank-transfer-e2e-1281",
      evidenceReference: "vault://e2e/transfer-1281",
      note: null,
    });
    expect(markPaidRequests[0]?.commandId).toMatch(/^platform-affiliate-payout-/);
    expect(markPaidRequests[0]?.idempotencyKey).toBe(markPaidRequests[0]?.commandId);
    expect(markPaidRequests[0]?.paidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(markPaidRequests[0])).not.toMatch(/iban|swift|paypal|bankAccount|email/i);

    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("creates every hotel invite route without retired onboarding fields", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "vayada-admin-hotel-invites");
    const adminBaseURL = baseURL?.startsWith("http://127.0.0.1:3001")
      ? "http://localhost:3001"
      : (baseURL ?? "https://admin.localhost");
    const pageOrigin = new URL(adminBaseURL).origin;
    const requests: Array<Record<string, unknown>> = [];

    await page.addInitScript(() => {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      window.localStorage.setItem("access_token", "e2e-platform-token");
      window.localStorage.setItem("token_expires_at", String(expiresAt));
      window.localStorage.setItem("isLoggedIn", "true");
      window.localStorage.setItem("userId", "user_platform_admin");
      window.localStorage.setItem("userEmail", "platform-admin@example.test");
      window.localStorage.setItem("userStatus", "active");
      window.localStorage.setItem("isSuperAdmin", "true");
      window.localStorage.setItem(
        "user",
        JSON.stringify({
          id: "user_platform_admin",
          email: "platform-admin@example.test",
          status: "active",
          is_superadmin: true,
        }),
      );
    });

    await page.route(
      /https:\/\/api\.localhost(?::\d+)?\/api\/marketplace\/admin\/invite-codes(?:\?|$)/,
      async (route) => {
        if (route.request().method() === "GET") {
          await fulfillJson(route, pageOrigin, []);
          return;
        }
        const request = route.request().postDataJSON() as Record<string, unknown>;
        requests.push(request);
        await fulfillJson(
          route,
          pageOrigin,
          {
            contractVersion: "hotel-account-invite.v1",
            id: `invite_${requests.length}`,
            code: `VAY-ROUTE-${requests.length}`,
            status: "pending",
            createdAt: "2026-08-02T12:00:00.000Z",
            expiresAt: "2026-09-01T12:00:00.000Z",
            identity: request.identity,
            organization: request.organization,
            property: request.property,
            selectedTracks: request.selectedTracks,
            handoffPath: "/setup",
            redeemedAt: null,
          },
          201,
        );
      },
    );

    await page.goto(new URL("/dashboard/invite-codes", adminBaseURL).toString());
    await expect(page.getByRole("heading", { name: "Hotel invitations" })).toBeVisible();

    const routeCases = [
      {
        radio: /^Creator Marketplace/,
        expected: ["creator_marketplace"],
      },
      {
        radio: /^Hotel Operations/,
        expected: ["hotel_operations"],
      },
      {
        radio: /^Marketplace \+ Hotel Operations/,
        expected: ["hotel_operations", "creator_marketplace"],
      },
    ];

    for (const [index, routeCase] of routeCases.entries()) {
      await page.getByRole("button", { name: "Create invite" }).click();
      await page.getByLabel("Hotel owner email").fill(`owner-${index + 1}@example.test`);
      await page.getByLabel("Hotel group name").fill(`Hotel Group ${index + 1}`);
      await page.getByLabel("Property name").fill(`Hotel Route ${index + 1}`);
      await page.getByRole("radio", { name: routeCase.radio }).check();
      await page.getByRole("button", { name: "Create invite code" }).click();

      await expect(page.getByRole("heading", { name: "Hotel invite created" })).toBeVisible();
      await expect(page.getByText("After secure acceptance: /setup")).toBeVisible();
      await page.getByRole("button", { name: "Back to invitations" }).click();
    }

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.selectedTracks)).toEqual(
      routeCases.map((routeCase) => routeCase.expected),
    );
    for (const request of requests) {
      expect(Object.keys(request).sort()).toEqual([
        "identity",
        "organization",
        "property",
        "selectedTracks",
      ]);
      expect(JSON.stringify(request)).not.toMatch(
        /rooms|rates|policies|payout|iban|swift|bank|payment|addons|benefits/i,
      );
    }

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});

async function fulfillJson(
  route: Route,
  origin: string,
  body: unknown,
  status = 200,
): Promise<void> {
  await route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
