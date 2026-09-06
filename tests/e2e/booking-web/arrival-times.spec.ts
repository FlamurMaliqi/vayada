import { expect, test } from "@playwright/test";
import { mockBookingApis } from "../support/bookingMocks";
test("shows published arrival ranges in room details", async ({ page }) => {
  await mockBookingApis(page, { arrivalBounds: { checkInUntil: "23:00", checkOutFrom: "07:00" } });
  await page.goto("/");
  await page.getByRole("button", { name: "View Details", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Check-in: 15:00–23:00")).toBeVisible();
  await expect(dialog.getByText("Check-out: 07:00–11:00")).toBeVisible();
});
