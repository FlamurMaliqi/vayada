import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const legacyBookingsEnabled = process.env.NEXT_PUBLIC_LEGACY_ADMIN_BOOKINGS_ENABLED === "true";
const legacyAuthEnabled = process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED === "false";
const expectedBookingsApiUrl = legacyBookingsEnabled
  ? process.env.NEXT_PUBLIC_PMS_API_URL || "https://pms-api.vayada.com"
  : process.env.NEXT_PUBLIC_API_URL || "https://api.localhost";
const expectedBookingsPath = legacyBookingsEnabled
  ? "/super-admin/bookings"
  : "/api/platform/admin/bookings";

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

  test("legacy login completes TOTP and authenticates the bookings request", async ({
    page,
    baseURL,
  }) => {
    test.skip(!legacyAuthEnabled, "Legacy password login is only enabled in the production mode");

    const adminBaseURL = adminBaseUrl(baseURL);
    const pageOrigin = new URL(adminBaseURL).origin;
    let bookingsAuthorization: string | undefined;

    await page.route("https://api.vayada.com/auth/login", async (route) => {
      await fulfillJson(route, pageOrigin, {
        message: "TOTP required",
        requires_totp: true,
        totp_session: "totp_session_123",
      });
    });
    await page.route("https://api.vayada.com/auth/totp/verify", async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        totp_session: "totp_session_123",
        code: "123456",
      });
      await fulfillJson(route, pageOrigin, {
        id: "user_platform_admin",
        email: "platform-admin@example.test",
        name: "Platform Admin",
        type: "admin",
        status: "verified",
        access_token: "legacy-admin-token",
        token_type: "bearer",
        expires_in: 3600,
        message: "Login successful",
        is_superadmin: true,
      });
    });
    await page.route(
      /https:\/\/pms-api\.vayada\.com\/super-admin\/bookings(?:\?|$)/,
      async (route) => {
        bookingsAuthorization = route.request().headers().authorization;
        await fulfillJson(route, pageOrigin, { bookings: [] });
      },
    );

    await page.goto(new URL("/login", adminBaseURL).toString());
    await page.getByLabel(/email address/i).fill("platform-admin@example.test");
    await page.getByLabel(/^password$/i).fill("password");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect(page.getByLabel(/authentication code/i)).toBeVisible();
    await page.getByLabel(/authentication code/i).fill("123456");
    await page.getByRole("button", { name: /verify/i }).click();
    await page.waitForURL(/\/dashboard(?:\?|$)/);

    await page.goto(new URL("/dashboard/bookings", adminBaseURL).toString());
    await expect(page.getByText("No bookings found.")).toBeVisible();
    await expect.poll(() => bookingsAuthorization).toBe("Bearer legacy-admin-token");
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
    const marketplaceBaseURL = adminBaseUrl(baseURL);
    const pageOrigin = new URL(marketplaceBaseURL).origin;

    await authenticatePlatformAdmin(page);

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

  test("bookings load from the configured admin backend", async ({ page, baseURL }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const adminBaseURL = adminBaseUrl(baseURL);
    const pageOrigin = new URL(adminBaseURL).origin;
    let requestedUrl: URL | undefined;

    await authenticatePlatformAdmin(page);
    await page.route(
      /\/(?:api\/platform\/admin\/bookings|super-admin\/bookings)(?:\?|$)/,
      async (route) => {
        requestedUrl = new URL(route.request().url());
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
              requestedAt: "2026-07-14T10:00:00.000Z",
              respondedAt: null,
            },
          ],
        });
      },
    );

    await page.goto(new URL("/dashboard/bookings", adminBaseURL).toString());

    await expect(page.getByRole("heading", { name: "Bookings", level: 1 })).toBeVisible();
    await expect(page.getByText("VAY-123")).toBeVisible();
    await expect(page.getByText("Ada Lovelace")).toBeVisible();
    expect(requestedUrl?.origin).toBe(new URL(expectedBookingsApiUrl).origin);
    expect(requestedUrl?.pathname).toBe(expectedBookingsPath);
    expect(requestedUrl?.searchParams.get("limit")).toBe("500");

    await assertHealthy();
  });

  test("bookings show an error when the configured backend fails", async ({ page, baseURL }) => {
    const adminBaseURL = adminBaseUrl(baseURL);
    const pageOrigin = new URL(adminBaseURL).origin;

    await authenticatePlatformAdmin(page);
    await page.route(
      /\/(?:api\/platform\/admin\/bookings|super-admin\/bookings)(?:\?|$)/,
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
