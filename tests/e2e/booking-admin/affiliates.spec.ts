import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

for (const width of [1280, 390]) {
  test(`retired affiliate management preserves the authenticated shell at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route("**/api/pms/properties/*/module-activations", (route) =>
      route.fulfill({
        json: {
          hotelId: BOOKING_ADMIN_PROPERTY_ID,
          canManage: true,
          supportedModules: ["affiliates"],
          activeModules: ["affiliates"],
          activations: [{ moduleId: "affiliates", isActive: true }],
        },
      }),
    );
    const affiliateRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/.*\/affiliates(?:[/?]|$)|\/affiliate-commission/.test(request.url())) {
        affiliateRequests.push(request.url());
      }
    });
    const activationsLoaded = page.waitForResponse(
      (response) => response.url().includes("/module-activations") && response.ok(),
    );
    await page.goto("/affiliates");
    await activationsLoaded;
    await expect(
      page.getByRole("heading", { name: /affiliate management is unavailable/i }),
    ).toBeVisible();
    await expect(
      page.locator("main").getByRole("link", { name: "Dashboard", exact: true }),
    ).toHaveAttribute("href", "/");
    await expect(page.locator('a[href="/affiliates"]')).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /approve|suspend|save default|save override/i }),
    ).toHaveCount(0);
    expect(affiliateRequests).toEqual([]);
    await page.locator("main").getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
  });
}

test("retired affiliate page still requires authentication", async ({ page }) => {
  await page.goto("/affiliates");
  await expect(page).toHaveURL(/\/login\?returnTo=%2Faffiliates/);
  await expect(
    page.getByRole("heading", { name: /affiliate management is unavailable/i }),
  ).toHaveCount(0);
});
