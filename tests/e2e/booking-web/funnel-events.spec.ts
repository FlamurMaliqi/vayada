import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

test("tracks the guest path through add-ons, details and non-card submission", async ({ page }) => {
  await mockBookingApis(page);
  const events: { eventType: string; sessionId: string; metadata: { funnelSequence: number } }[] =
    [];
  await page.route("**/api/booking-web/events", (route) => {
    events.push(route.request().postDataJSON());
    return route.fulfill({ status: 204 });
  });
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/quote`, (route) =>
    route.fulfill({
      json: {
        quoteId: "funnel-quote",
        expiresAt: "2030-01-01T00:00:00Z",
        roomTypeId: "alpine-suite",
        roomName: "Alpine Suite",
        rateType: "flexible",
        paymentMethod: "pay_at_property",
        nightlyRate: 240,
        numberOfRooms: 1,
        roomTotal: 720,
        addonTotal: 0,
        promoDiscount: 0,
        lastMinuteDiscountPercent: 0,
        lastMinuteDiscountAmount: 0,
        totalAmount: 720,
        currency: "EUR",
        depositRequired: false,
        depositAmount: 0,
        balanceAmount: 720,
      },
    }),
  );
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings`, (route) =>
    route.fulfill({
      json: {
        booking: {
          ...route.request().postDataJSON(),
          id: "funnel-booking",
          bookingReference: "FUNNEL-1034",
          status: "pending",
          paymentMethod: "pay_at_property",
          roomName: "Alpine Suite",
          nights: 3,
          totalAmount: 720,
          currency: "EUR",
        },
        paymentMethod: "pay_at_property",
      },
    }),
  );
  await page.goto("/?checkIn=2026-09-12&checkOut=2026-09-15");
  await page.getByRole("button", { name: "View Details", exact: true }).first().click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Select This Rate/i })
    .click();
  await expect(page).toHaveURL(/\/addons\?/);
  await page.getByRole("button", { name: "Proceed to Guest Information" }).click();
  await page.getByLabel("First Name").fill("Ada");
  await page.getByLabel("Last Name").fill("Lovelace");
  await page
    .getByRole("textbox", { name: "Email Address *", exact: true })
    .fill("ada@example.test");
  await page.getByLabel("Phone Number").fill("1234567");
  await page.getByRole("combobox", { name: "Country", exact: true }).fill("Netherlands");
  await page.getByRole("button", { name: "Continue to Payment" }).click();
  await expect(page).toHaveURL(/\/payment\?/);
  await page
    .locator("label")
    .filter({ hasText: /I agree/ })
    .getByRole("button")
    .first()
    .click();
  await page.getByRole("button", { name: /Confirm Booking|Submit Booking Request/ }).click();
  await expect.poll(() => events.map((event) => event.eventType)).toContain("booking_completed");
  expect([...new Set(events.map((event) => event.eventType))]).toEqual([
    "page_visit",
    "room_viewed",
    "rate_selected",
    "addons_step_passed",
    "details_completed",
    "complete_booking_clicked",
    "booking_completed",
  ]);
  expect(new Set(events.map((event) => event.sessionId)).size).toBe(1);
  const sequences = events.map((event) => event.metadata.funnelSequence);
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
});
