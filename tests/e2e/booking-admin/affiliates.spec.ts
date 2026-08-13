import { expect, test, type Page } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";
const AFFILIATE_ID = "affiliate_creator_1";
const MARKETPLACE_PATH = `/api/marketplace/properties/${BOOKING_ADMIN_PROPERTY_ID}/affiliates`;
const FINANCE_PATH = `/api/finance/properties/${BOOKING_ADMIN_PROPERTY_ID}`;

const initialAffiliate = {
  contractVersion: "marketplace-affiliate-admin.v1",
  affiliateId: AFFILIATE_ID,
  propertyId: BOOKING_ADMIN_PROPERTY_ID,
  referralCode: "ALPINE15",
  displayName: "Mira Alpine",
  contactEmail: "mira@example.com",
  socialMedia: "@miraalpine",
  affiliateType: "creator",
  lifecycleStatus: "pending",
  applicationSource: "public_registration",
  appliedAt: "2026-08-10T09:00:00.000Z",
  updatedAt: "2026-08-10T09:00:00.000Z",
} as const;

test.describe("booking-admin affiliate management", () => {
  test("reviews lifecycle and commission settings through target contracts", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "booking-admin-settings");
    const requests = await mockAffiliateRoutes(page);

    await page.goto("/affiliates");
    await expect(
      page.getByRole("heading", { level: 1, name: "Affiliate applications" }),
    ).toBeVisible();
    await expect(page.getByText("Mira Alpine").first()).toBeVisible();
    await expect(page.getByText("Effective rate:")).toBeVisible();
    await expect(page.getByRole("button", { name: /payout/i })).toHaveCount(0);
    await expect(page.getByText(/bank account/i)).toHaveCount(0);

    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("Mira Alpine approved.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Suspend access" })).toBeVisible();

    await page.getByLabel("Default commission percentage").fill("14.5");
    await page.getByRole("button", { name: "Save default" }).click();
    await expect(page.getByText("Default affiliate commission saved.")).toBeVisible();

    await page.getByLabel("Affiliate commission override").fill("18");
    await page.getByRole("button", { name: "Save override" }).click();
    await expect(page.getByText("Affiliate override saved.")).toBeVisible();

    await page.getByLabel("Affiliate status").selectOption("approved");
    await page.getByPlaceholder("Name, email, or referral code").fill("mira");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect.poll(() => requests.listQueries.at(-1)).toContain("status=approved");
    await expect.poll(() => requests.listQueries.at(-1)).toContain("search=mira");

    expect(requests.lifecycleWrites).toHaveLength(1);
    expect(requests.lifecycleWrites[0]).toMatchObject({ action: "approve" });
    expect(requests.lifecycleWrites[0]?.commandId).toBe(
      requests.lifecycleWrites[0]?.idempotencyKey,
    );
    expect(requests.commissionWrites.map((write) => write.percentageRate)).toEqual(["14.5", "18"]);
    for (const write of requests.commissionWrites) {
      expect(write.commandId).toBe(write.idempotencyKey);
    }
    await assertNoLegacyCalls();
    await assertHealthy();
  });

  test("shows stable authorization denial copy", async ({ page }) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(`**${MARKETPLACE_PATH}**`, (route) =>
      route.fulfill({ status: 403, json: { code: "missing_permission", message: "Forbidden" } }),
    );
    await page.route(`**${FINANCE_PATH}/affiliate-commission`, (route) =>
      route.fulfill({ json: commission(null, null) }),
    );

    await page.goto("/affiliates");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Your role cannot manage affiliates for this property." }),
    ).toBeVisible();
  });
});

async function mockAffiliateRoutes(page: Page) {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const lifecycleWrites: Record<string, string>[] = [];
  const commissionWrites: Record<string, string>[] = [];
  const listQueries: string[] = [];
  let affiliate = { ...initialAffiliate, lifecycleStatus: "pending" as string };
  let defaultRate = "12.5";
  let overrideRate: string | null = null;

  await page.route(`**${MARKETPLACE_PATH}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, string>;
      lifecycleWrites.push(body);
      affiliate = {
        ...affiliate,
        lifecycleStatus: "approved",
        updatedAt: "2026-08-13T10:00:00.000Z",
      };
      await route.fulfill({ json: { outcome: "applied", commandId: body.commandId, affiliate } });
      return;
    }
    if (url.pathname === MARKETPLACE_PATH) {
      listQueries.push(url.search);
      await route.fulfill({
        json: {
          contractVersion: "marketplace-affiliate-admin.v1",
          affiliates: [affiliate],
          total: 1,
          limit: 100,
          offset: 0,
        },
      });
      return;
    }
    await route.fulfill({ json: affiliate });
  });

  await page.route(`**${FINANCE_PATH}/**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const perAffiliate = pathname.includes(`/affiliates/${AFFILIATE_ID}/commission`);
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, string>;
      commissionWrites.push(body);
      if (perAffiliate) overrideRate = body.percentageRate;
      else defaultRate = body.percentageRate;
      const value = commission(
        perAffiliate ? AFFILIATE_ID : null,
        perAffiliate ? overrideRate : null,
        defaultRate,
      );
      await route.fulfill({
        json: { outcome: "applied", commandId: body.commandId, commission: value },
      });
      return;
    }
    await route.fulfill({
      json: commission(
        perAffiliate ? AFFILIATE_ID : null,
        perAffiliate ? overrideRate : null,
        defaultRate,
      ),
    });
  });

  return { lifecycleWrites, commissionWrites, listQueries };
}

function commission(affiliateId: string | null, overrideRate: string | null, defaultRate = "12.5") {
  return {
    contractVersion: "finance-affiliate-commission.v1",
    propertyId: BOOKING_ADMIN_PROPERTY_ID,
    affiliateId,
    defaultPercentageRate: defaultRate,
    overridePercentageRate: overrideRate,
    effectivePercentageRate: overrideRate ?? defaultRate,
    updatedAt: "2026-08-13T10:00:00.000Z",
  };
}
