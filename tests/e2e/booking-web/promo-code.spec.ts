import { expect, test } from "@playwright/test";

import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";
import { watchPageHealth } from "../support/pageHealth";

const promoPath = `/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/promo/validate`;

test.describe("booking-web promo validation", () => {
  test("shows the specific rule failure returned by the canonical API", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);
    await page.route(`**${promoPath}`, (route) =>
      route.fulfill({
        json: {
          valid: false,
          code: "SUMMER20",
          message: "This promo code is not available for the selected room.",
        },
      }),
    );

    await page.goto("/");
    await page.getByRole("button", { name: "Add promo" }).click();
    await page.getByPlaceholder("Enter code").fill("summer20");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(
      page.getByText("This promo code is not available for the selected room."),
    ).toBeVisible();
    await assertHealthy();
  });

  test("validates the selected stay and renders the promo summary line", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);
    let validationBody: Record<string, unknown> | undefined;
    await page.route(`**${promoPath}`, async (route) => {
      validationBody = route.request().postDataJSON();
      await route.fulfill({
        json: {
          valid: true,
          code: "SUMMER20",
          discountType: "percentage",
          discountValue: 20,
          currency: "EUR",
          message: "Promo code applied successfully.",
        },
      });
    });

    await page.goto(
      "/en/book?room=alpine-suite&checkIn=2026-09-12&checkOut=2026-09-15&adults=2&children=0&rooms=1&rateType=flexible&promoCode=SUMMER20",
    );

    await expect(page.getByText("Promo SUMMER20: -20%", { exact: true }).first()).toBeVisible();
    expect(validationBody).toEqual({
      code: "SUMMER20",
      checkIn: "2026-09-12",
      roomTypeId: "alpine-suite",
      bookingTotal: 720,
    });
    await assertHealthy();
  });

  test("renders a fixed property-currency promo summary", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await mockBookingApis(page);
    await page.route(`**${promoPath}`, (route) =>
      route.fulfill({
        json: {
          valid: true,
          code: "DIRECT50",
          discountType: "fixed",
          discountValue: 50,
          currency: "EUR",
          message: "Promo code applied successfully.",
        },
      }),
    );

    await page.goto(
      "/en/book?room=alpine-suite&checkIn=2026-09-12&checkOut=2026-09-15&adults=2&children=0&rooms=1&rateType=flexible&promoCode=DIRECT50",
    );

    await expect(page.getByText("Promo DIRECT50: -€50", { exact: true }).first()).toBeVisible();
    await assertHealthy();
  });
});
