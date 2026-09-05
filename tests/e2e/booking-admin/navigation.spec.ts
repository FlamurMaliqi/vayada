import { expect, test } from "@playwright/test";
import {
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

const NAV_LABELS = [
  "Dashboard",
  "Design Studio",
  "Booking Flow",
  "Promos",
  "Settings",
  "Feature Hub",
];

test.describe("booking-admin navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
  });

  test("shows the product navigation in order when expanded and collapsed", async ({ page }) => {
    await page.goto("/");

    const navigation = page.getByRole("navigation");
    await expect(navigation.getByRole("link")).toHaveText(NAV_LABELS);
    await expect(navigation.getByRole("link", { name: "Reservations" })).toHaveCount(0);

    await page.getByRole("button", { name: "Collapse" }).click();
    await expect(navigation.getByRole("link")).toHaveCount(5);
    expect(
      await navigation.locator("a").evaluateAll((links) => links.map((link) => link.title)),
    ).toEqual(NAV_LABELS.slice(0, -1));
  });

  test("shows the same order in the mobile drawer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const navigation = page.getByRole("navigation");
    await expect(navigation).not.toBeInViewport();
    await page.getByRole("button", { name: "Toggle menu" }).click();
    await expect(navigation).toBeInViewport();
    await expect(navigation.getByRole("link")).toHaveText(NAV_LABELS);
    await expect(navigation.getByRole("link", { name: "Reservations" })).toHaveCount(0);
  });
});
