import { expect, test } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

test("shows sequential percentages, card branch, payment split and recomputes all time tabs", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1200 });
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
  const windows: string[] = [];
  let empty = false;
  await page.route("**/dashboard/conversion-funnel?**", (route) => {
    windows.push(route.request().url());
    return route.fulfill({
      json: {
        funnel: {
          steps: [
            ["page_visit", 100, 100, 100],
            ["room_viewed", 90, 90, 90],
            ["rate_selected", 80, 80, 88.9],
            ["details_completed", 80, 80, 100],
            ["complete_booking_clicked", 80, 80, 100],
            ["payment_authorized", 10, 10, 25],
            ["booking_completed", 50, 50, 100],
          ].map(([stage, count, percentOfVisits, conversionPercent]) => ({
            stage,
            count: empty ? 0 : count,
            percentOfVisits,
            conversionPercent,
          })),
          paymentMethods: [
            { method: "card", count: 40 },
            { method: "bank_transfer", count: 40 },
          ],
          biggestDrop: "payment_authorized",
        },
      },
    });
  });
  await page.goto("/dashboard");
  const card = page.getByText("Conversion Funnel", { exact: false }).locator("xpath=../..");
  await expect(card.getByText("Authorized payment (card only)")).toBeVisible();
  await expect(card.getByText("25% of card clicks")).toBeVisible();
  await expect(card.getByText("Biggest drop")).toHaveCount(1);
  await expect(card.getByText("Card: 40 (50%)")).toBeVisible();
  await expect(card.getByText("Added add-ons / skipped")).toHaveCount(0);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(card.getByText("Authorized payment (card only)")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("conversion-funnel.png"), fullPage: true });
  await page.getByRole("button", { name: "This week", exact: true }).click();
  await expect.poll(() => windows.length).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Last 30 days", exact: true }).click();
  await expect.poll(() => windows.length).toBeGreaterThanOrEqual(3);
  empty = true;
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(card.getByText("Authorized payment (card only)")).toHaveCount(0);
  expect(new Set(windows.map((url) => new URL(url).searchParams.get("windowStart"))).size).toBe(3);
});
