import { expect, test } from "@playwright/test";
import type { Route } from "@playwright/test";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

test.describe("vayada-admin smoke", () => {
  test("login page redirects to AuthKit", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /vayada admin/i, level: 1 })).toBeVisible();
    await expect(page.getByText(/redirecting to sign in/i)).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /continue with workos/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /use legacy password fallback/i })).toHaveCount(0);

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

    await page.route("https://api.localhost/api/marketplace/listings**", async (route) => {
      await fulfillJson(route, pageOrigin, {
        items: [
          {
            listingId: "listing_target_885",
            publicId: "hotel_profile_target_885",
            canonicalSlug: "target-inn",
            displayName: "Target Inn",
            listingTitle: "Target creator stay",
            listingSummary: "A next-api marketplace listing.",
            accommodationType: "hotel",
            location: { displayText: "Luxembourg" },
            coverImageUrl: null,
            imageUrls: [],
            offerings: [],
            creatorRequirements: null,
            createdAt: "2026-06-24T10:00:00.000Z",
            projectedAt: "2026-06-24T10:00:00.000Z",
          },
        ],
        pagination: { limit: 200, offset: 0, total: 1 },
      });
    });

    await page.route("https://api.localhost/api/marketplace/creators**", async (route) => {
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
    });

    await page.goto(new URL("/dashboard/marketplace", marketplaceBaseURL).toString());

    await expect(page.getByRole("heading", { name: "Marketplace", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Listings \(1\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Creators \(1\)/ })).toBeVisible();
    await expect(page.getByText("Target creator stay")).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});

async function fulfillJson(route: Route, origin: string, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
