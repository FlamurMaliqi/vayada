import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

test.use({ hasTouch: true });

for (const mobile of [false, true]) {
  test(`explains minimum stays and prevents invalid selections (${mobile ? "touch" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.setFixedTime(new Date("2028-03-01T12:00:00Z"));
    await mockBookingApis(page);
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/calendar**`,
      async (route) => {
        await route.fulfill({
          json: {
            calendar: {
              unavailableDates: ["2028-03-10"],
              minStayByArrival: {
                "2028-03-03": 2,
                "2028-03-09": 2,
                "2028-03-20": 3,
                "2028-03-31": 2,
              },
              maxStayByArrival: {},
              validCheckOutsByArrival: {
                "2028-03-03": ["2028-03-05", "2028-03-06"],
                "2028-03-09": [],
                "2028-03-20": ["2028-03-23"],
                "2028-03-31": ["2028-04-02"],
              },
            },
            freshness: { status: "fresh" },
          },
        });
      },
    );
    await page.goto("/");
    await page.getByRole("button").filter({ hasText: "Your Stay" })[mobile ? "tap" : "click"]();
    await expect(page.getByText("Minimum stays vary by arrival date and rate:")).toBeVisible();
    const blockedArrival = page.getByRole("button", { name: /^2028-03-09/ });
    await expect(blockedArrival).toHaveAttribute("aria-disabled", "true");
    await blockedArrival[mobile ? "tap" : "click"]({ force: true });
    await expect(page.getByRole("status").getByText(/No valid stay from this date/)).toBeVisible();
    await page.getByRole("button", { name: /^2028-03-03/ })[mobile ? "tap" : "click"]();
    await expect(page.getByText(/Minimum stay: 2 nights/)).toBeVisible();
    const tooShort = page.getByRole("button", { name: /^2028-03-04/ });
    await expect(tooShort).toHaveAttribute("aria-disabled", "true");
    await tooShort[mobile ? "tap" : "click"]({ force: true });
    await expect(
      page.getByRole("status").getByText("Minimum stay of 2 nights required."),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("minimum-stay.png"), fullPage: true });
    await page.getByRole("button", { name: /^2028-03-05/ })[mobile ? "tap" : "click"]();
    await expect(page.getByText("Select your dates")).toBeHidden();
    await page.getByRole("button").filter({ hasText: "Your Stay" })[mobile ? "tap" : "click"]();
    await page.getByRole("button", { name: /^2028-03-31/ })[mobile ? "tap" : "click"]();
    await expect(page.getByRole("button", { name: /^2028-04-01/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.getByRole("button", { name: /^2028-04-02/ })[mobile ? "tap" : "click"]();
    await expect(page.getByText("Select your dates")).toBeHidden();
  });
}

test("adds no minimum-stay message for a one-night rule", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2028-03-01T12:00:00Z"));
  await mockBookingApis(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/calendar**`, (route) =>
    route.fulfill({
      json: {
        calendar: {
          unavailableDates: [],
          minStayByArrival: { "2028-03-03": 1 },
          maxStayByArrival: {},
          validCheckOutsByArrival: { "2028-03-03": ["2028-03-04"] },
        },
        freshness: { status: "fresh" },
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button").filter({ hasText: "Your Stay" }).click();
  await expect(page.getByRole("button", { name: /^2028-03-03/ })).toBeEnabled();
  await expect(page.getByText(/Minimum stay:/)).toHaveCount(0);
  await page.getByRole("button", { name: /^2028-03-03/ }).click();
  await expect(page.getByText(/Minimum stay:/)).toHaveCount(0);
  await page.getByRole("button", { name: /^2028-03-04/ }).click();
  await expect(page.getByText("Select your dates")).toBeHidden();
});

test("explains when no stay fits the available dates", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2028-03-01T12:00:00Z"));
  await mockBookingApis(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/calendar**`, (route) =>
    route.fulfill({
      json: {
        calendar: {
          unavailableDates: ["2028-03-04"],
          minStayByArrival: { "2028-03-03": 2 },
          maxStayByArrival: {},
          validCheckOutsByArrival: { "2028-03-03": [] },
        },
        freshness: { status: "fresh" },
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button").filter({ hasText: "Your Stay" }).click();
  await expect(page.getByText("Minimum stay: 2 nights.", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "No available stay satisfies the stay requirements in these dates. Try later months.",
    ),
  ).toBeVisible();
});
