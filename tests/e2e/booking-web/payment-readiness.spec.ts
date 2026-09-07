import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

for (const [message, expected] of [
  [
    "Selected payment method is no longer available. Please refresh.",
    "This payment method is no longer available. Please refresh and choose an available payment method.",
  ],
  [
    "Checkout quote inventory is no longer available. Please refresh.",
    "Unfortunately this room just sold out. Please choose another room or different dates.",
  ],
]) {
  test(`classifies checkout409: ${message}`, async ({ page }) => {
    await mockBookingApis(page);
    await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings`, (route) =>
      route.fulfill({ status: 409, json: { detail: message } }),
    );
    await page.goto(
      "/book?room=alpine-suite&checkIn=2026-09-12&checkOut=2026-09-15&adults=2&children=0&rooms=1&rateType=flexible",
    );
    await page.getByLabel("First Name").fill("Ada");
    await page.getByLabel("Last Name").fill("Lovelace");
    await page
      .getByRole("textbox", { name: "Email Address *", exact: true })
      .fill("ada@example.test");
    await page.getByLabel("Phone Number").fill("1234567");
    await page.getByRole("button", { name: "Continue to Payment" }).click();
    await page
      .locator("label")
      .filter({ hasText: /I agree/ })
      .getByRole("button")
      .first()
      .click();
    await page.getByRole("button", { name: /Confirm Booking|Submit Booking Request/ }).click();
    await expect(page.getByText(expected, { exact: true })).toBeVisible();
    if (message.startsWith("Selected")) {
      await expect(page.getByRole("button", { name: "Choose another room" })).toHaveCount(0);
      await expect(page.getByText(/Unfortunately this room just sold out/)).toHaveCount(0);
    }
  });
}
