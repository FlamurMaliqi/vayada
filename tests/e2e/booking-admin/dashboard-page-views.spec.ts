import { expect, test } from "@playwright/test";

import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";

test.describe("booking-admin page-view timeline", () => {
  test("renders target counts and recovers through loading, error, and empty states", async ({
    page,
  }, testInfo) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);

    let dashboardRefreshFails = false;
    await page.route("**/api/booking/properties/*/dashboard/stats**", (route) => {
      if (dashboardRefreshFails) {
        return route.fulfill({ status: 503, json: { detail: "Read model unavailable" } });
      }
      return route.fulfill({
        json: {
          metrics: {
            current: {
              totalRevenue: { amountDecimal: "0.00", currency: "EUR" },
              bookingCount: 2,
              avgNightlyRate: { amountDecimal: "0.00", currency: "EUR" },
              pageViewCount: 28,
            },
            previous: {
              totalRevenue: { amountDecimal: "0.00", currency: "EUR" },
              bookingCount: 1,
              avgNightlyRate: { amountDecimal: "0.00", currency: "EUR" },
              pageViewCount: 21,
            },
            nextArrivalDate: null,
            liveSinceDate: null,
          },
        },
      });
    });
    await page.route("**/api/booking/properties/*/dashboard/sparklines**", (route) => {
      if (dashboardRefreshFails) {
        return route.fulfill({ status: 503, json: { detail: "Read model unavailable" } });
      }
      return route.fulfill({
        json: {
          sparklines: {
            points: Array.from({ length: 7 }, (_, index) => ({
              revenue: { amountDecimal: "0.00", currency: "EUR" },
              bookingCount: 0,
              avgNightlyRate: { amountDecimal: "0.00", currency: "EUR" },
              pageViewCount: index + 1,
            })),
          },
        },
      });
    });

    const requestedWindows: Array<{ start: string; end: string }> = [];
    let timelineMode: "error" | "success" | "empty" = "error";
    let releaseTimeline: (() => void) | undefined;
    let markTimelineRequested: (() => void) | undefined;
    const timelineRequested = new Promise<void>((resolve) => {
      markTimelineRequested = resolve;
    });
    await page.route("**/api/booking/properties/*/dashboard/page-views**", async (route) => {
      const url = new URL(route.request().url());
      const window = {
        start: url.searchParams.get("windowStart") ?? "",
        end: url.searchParams.get("windowEnd") ?? "",
      };
      requestedWindows.push(window);
      if (timelineMode === "error") {
        await route.fulfill({ status: 503, json: { code: "read_model_unavailable" } });
        return;
      }
      if (timelineMode === "success") {
        markTimelineRequested?.();
        await new Promise<void>((resolve) => {
          releaseTimeline = resolve;
        });
      }
      await route.fulfill({
        json: pageViewsFixture(window.start, window.end, timelineMode === "empty"),
      });
    });

    await page.goto("/dashboard");
    const pageViewsCard = page.getByRole("button", { name: "Open page views breakdown" });
    await expect(pageViewsCard).toContainText("28");
    await pageViewsCard.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Page-view data could not be loaded.")).toBeVisible();
    timelineMode = "success";
    const retry = dialog.getByRole("button", { name: "Try again" }).click();
    await timelineRequested;
    await expect(dialog.locator('[aria-busy="true"]')).toBeVisible();
    releaseTimeline?.();
    await retry;
    await expect(dialog.getByText("28", { exact: true })).toBeVisible();

    const assertHealthy = watchPageHealth(page, testInfo);
    const successfulWindow = requestedWindows.at(-1)!;
    timelineMode = "empty";
    await dialog.getByRole("button", { name: "Previous week" }).click();
    await expect(dialog.getByText("0", { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText("No previous data")).toBeVisible();
    expect(previousDay(successfulWindow.start)).toBe(requestedWindows.at(-1)!.end);
    await assertHealthy();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    dashboardRefreshFails = true;
    await page.getByRole("button", { name: "This week" }).click();
    await expect(pageViewsCard).toContainText("--");
    await expect(pageViewsCard).not.toContainText("28");
  });
});

function pageViewsFixture(windowStart: string, windowEnd: string, empty: boolean) {
  const previousWindowEnd = previousDay(windowStart);
  const previousWindowStart = shiftDate(previousWindowEnd, -6);
  const counts = empty ? Array(7).fill(0) : [1, 2, 3, 4, 5, 6, 7];
  return {
    pageViews: {
      timeZone: "Europe/Berlin",
      windowStart,
      windowEnd,
      previousWindowStart,
      previousWindowEnd,
      buckets: counts.map((count, index) => ({ date: shiftDate(windowStart, index), count })),
      previousBuckets: counts.map((_, index) => ({
        date: shiftDate(previousWindowStart, index),
        count: empty ? 0 : index + 1,
      })),
      total: counts.reduce((sum, count) => sum + count, 0),
      previousTotal: empty ? 0 : 28,
    },
  };
}

function previousDay(value: string): string {
  return shiftDate(value, -1);
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
