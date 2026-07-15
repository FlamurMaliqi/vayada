import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
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

  test("marketplace preview uses legacy Python discovery", async ({ page, baseURL }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const marketplaceBaseURL = adminBaseUrl(baseURL);
    const pageOrigin = new URL(marketplaceBaseURL).origin;

    await authenticatePlatformAdmin(page);

    await page.route("https://api.vayada.com/marketplace/listings", async (route) => {
      await fulfillJson(route, pageOrigin, [
        {
          id: "listing_legacy_508",
          hotel_profile_id: "hotel_profile_legacy_508",
          hotel_name: "Legacy Inn",
          hotel_picture: null,
          owner_email: "owner@example.test",
          owner_user_id: "owner_legacy_508",
          name: "Legacy creator stay",
          location: "Luxembourg",
          description: "A Python marketplace listing.",
          accommodation_type: "hotel",
          images: [],
          status: "verified",
          collaboration_offerings: [],
          creator_requirements: null,
          created_at: "2026-06-24T10:00:00.000Z",
        },
      ]);
    });

    await page.route("https://api.vayada.com/marketplace/creators", async (route) => {
      await fulfillJson(route, pageOrigin, [
        {
          id: "creator_legacy_508",
          name: "Legacy Creator",
          location: "Luxembourg",
          short_description: "Python creator profile.",
          portfolio_link: null,
          profile_picture: null,
          platforms: [],
          audience_size: 1200,
          average_rating: 5,
          total_reviews: 3,
          created_at: "2026-06-24T10:00:00.000Z",
        },
      ]);
    });

    await page.goto(new URL("/dashboard/marketplace", marketplaceBaseURL).toString());

    await expect(page.getByRole("heading", { name: "Marketplace", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: /Listings \(1\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Creators \(1\)/ })).toBeVisible();
    await expect(page.getByText("Legacy creator stay")).toBeVisible();

    await assertHealthy();
  });

  test("users load from the legacy Python admin API", async ({ page, baseURL }) => {
    const adminBaseURL = adminBaseUrl(baseURL);
    const pageOrigin = new URL(adminBaseURL).origin;
    let authorization: string | undefined;

    await authenticatePlatformAdmin(page);
    await page.route(/https:\/\/api\.vayada\.com\/admin\/users(?:\?|$)/, async (route) => {
      authorization = route.request().headers().authorization;
      await fulfillJson(route, pageOrigin, {
        users: [
          {
            id: "user_legacy_508",
            email: "legacy-admin-user@example.test",
            name: "Legacy Admin User",
            type: "hotel",
            status: "verified",
            avatar: null,
            email_verified: true,
            created_at: "2026-06-24T10:00:00.000Z",
            updated_at: "2026-06-24T10:00:00.000Z",
          },
        ],
        total: 1,
      });
    });

    await page.goto(new URL("/dashboard", adminBaseURL).toString());

    await expect(page.getByRole("heading", { name: "Users", level: 1 })).toBeVisible();
    await expect(page.getByText("legacy-admin-user@example.test")).toBeVisible();
    expect(authorization).toBe("Bearer e2e-platform-token");
  });

  test("legacy bookings load from the PMS API with the admin token", async ({ page, baseURL }) => {
    const adminBaseURL = adminBaseUrl(baseURL);
    const pageOrigin = new URL(adminBaseURL).origin;
    let requestedUrl: URL | undefined;
    let authorization: string | undefined;

    await authenticatePlatformAdmin(page);
    await page.route(
      /https:\/\/pms-api\.vayada\.com\/super-admin\/bookings(?:\?|$)/,
      async (route) => {
        requestedUrl = new URL(route.request().url());
        authorization = route.request().headers().authorization;
        await fulfillJson(route, pageOrigin, {
          bookings: [
            {
              id: "booking_123",
              bookingReference: "VAY-123",
              hotelId: "hotel_123",
              hotelName: "Alpenrose",
              hotelSlug: "alpenrose",
              guestName: "Ada Lovelace",
              guestEmail: "ada@example.test",
              checkIn: "2026-08-10",
              checkOut: "2026-08-13",
              nights: 3,
              totalAmount: 420,
              currency: "EUR",
              status: "pending",
              rawStatus: "pending",
              channel: "direct",
              requestedAt: "2026-07-15T10:00:00.000Z",
              respondedAt: null,
            },
          ],
        });
      },
    );

    await page.goto(new URL("/dashboard/bookings", adminBaseURL).toString());

    await expect(page.getByText("VAY-123")).toBeVisible();
    await expect(page.getByText("Ada Lovelace")).toBeVisible();
    expect(requestedUrl?.pathname).toBe("/super-admin/bookings");
    expect(requestedUrl?.searchParams.get("limit")).toBe("500");
    expect(authorization).toBe("Bearer e2e-platform-token");
  });

  test("legacy bookings show an error when the PMS API fails", async ({ page, baseURL }) => {
    const adminBaseURL = adminBaseUrl(baseURL);
    const pageOrigin = new URL(adminBaseURL).origin;

    await authenticatePlatformAdmin(page);
    await page.route(
      /https:\/\/pms-api\.vayada\.com\/super-admin\/bookings(?:\?|$)/,
      async (route) => {
        await fulfillJson(route, pageOrigin, { detail: "Backend unavailable" }, 500);
      },
    );

    await page.goto(new URL("/dashboard/bookings", adminBaseURL).toString());

    await expect(
      page.getByText("Could not load bookings. Please refresh and try again.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("No bookings found.")).toHaveCount(0);
  });
});

function adminBaseUrl(baseURL: string | undefined): string {
  return baseURL?.startsWith("http://127.0.0.1:3001")
    ? "http://localhost:3001"
    : (baseURL ?? "https://admin.localhost");
}

async function authenticatePlatformAdmin(page: Page): Promise<void> {
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
}

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
