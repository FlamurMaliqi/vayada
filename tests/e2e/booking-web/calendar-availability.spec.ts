import { expect, test } from "@playwright/test";

import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

const unavailableCalendarResponses = [
  {
    name: "the request fails",
    response: { status: 503, json: { detail: "Availability unavailable" } },
  },
  {
    name: "freshness is unavailable",
    response: {
      status: 200,
      json: {
        calendar: {
          unavailableDates: [],
          minStayByArrival: {},
          maxStayByArrival: {},
        },
        freshness: { status: "unavailable" },
      },
    },
  },
] as const;

for (const scenario of unavailableCalendarResponses) {
  test(`fails closed when ${scenario.name}`, async ({ page }) => {
    await mockBookingApis(page);

    const calendarRoute = `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/calendar**`;
    await page.unroute(calendarRoute);
    await page.route(calendarRoute, async (route) => {
      await route.fulfill(scenario.response);
    });

    await page.goto("/");
    await page.getByRole("button").filter({ hasText: "Your Stay" }).click();

    await expect(
      page.getByText("Availability is temporarily unavailable for these dates."),
    ).toBeVisible();
    const unavailableDateButtons = page.locator('button[title="Availability unavailable"]');
    await expect(unavailableDateButtons.first()).toBeVisible();
    await expect(unavailableDateButtons.first()).toBeDisabled();
  });
}
