import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

for (const mobile of [false, true]) {
  test(`explains guest count and recovers after a new search (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await mockBookingApis(page);
    let reason = "occupancy_unavailable";
    await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/offers**`, async (route) => {
      if (reason === "bookable") return route.fallback();
      await route.fulfill({
        json: {
          request: { nights: 1, rooms: 1 },
          status: "unavailable",
          unavailableReasons: [{ code: reason }],
        },
      });
    });
    await page.goto("/?adults=13");
    await expect(page.getByRole("status")).toContainText("13 guests");
    await page.screenshot({ path: test.info().outputPath("guest-capacity.png"), fullPage: true });
    reason = "sold_out";
    await page.getByRole("button", { name: "Check Availability", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "No accommodation is available for this search",
    );
    await expect(page.getByRole("status")).not.toContainText("13 guests");
    reason = "bookable";
    await page.getByRole("button").filter({ hasText: "13 adults" }).click();
    for (let i = 0; i < 11; i++)
      await page
        .getByTestId("guest-selector")
        .getByRole("button", { name: "-", exact: true })
        .first()
        .click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Check Availability", exact: true }).click();
    await expect(page.getByRole("status")).toHaveCount(0);
    await expect(page.getByText("Alpine Suite", { exact: true }).first()).toBeVisible();
  });
}

test("failed availability is an error, not a capacity claim", async ({ page }) => {
  await mockBookingApis(page);
  let fail = false;
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/offers**`, (route) =>
    fail ? route.fulfill({ status: 503, json: { message: "Unavailable" } }) : route.fallback(),
  );
  await page.goto("/");
  await expect(page.getByText("Alpine Suite", { exact: true }).first()).toBeVisible();
  fail = true;
  await page.getByRole("button", { name: "Check Availability", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("We couldn’t check availability");
});

test("an older search cannot replace a newer result", async ({ page }) => {
  await mockBookingApis(page);
  let releaseOld: (() => void) | undefined;
  const oldResponse = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let oldStarted: (() => void) | undefined;
  const oldRequest = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/offers**`, async (route) => {
    if (new URL(route.request().url()).searchParams.get("adults") !== "3") return route.fallback();
    oldStarted?.();
    await oldResponse;
    await route.fulfill({
      json: {
        request: { nights: 1, rooms: 1 },
        status: "unavailable",
        unavailableReasons: [{ code: "occupancy_unavailable" }],
      },
    });
  });
  await page.goto("/");
  await expect(page.getByText("Alpine Suite", { exact: true }).first()).toBeVisible();
  await page.getByRole("button").filter({ hasText: "2 adults" }).click();
  await page
    .getByTestId("guest-selector")
    .getByRole("button", { name: "+", exact: true })
    .first()
    .click();
  await oldRequest;
  const latest = page.waitForResponse(
    (response) =>
      response.url().includes("/offers?") &&
      new URL(response.url()).searchParams.get("adults") === "2",
  );
  await page
    .getByTestId("guest-selector")
    .getByRole("button", { name: "-", exact: true })
    .first()
    .click();
  await latest;
  const oldFinished = page.waitForResponse(
    (response) =>
      response.url().includes("/offers?") &&
      new URL(response.url()).searchParams.get("adults") === "3",
  );
  releaseOld?.();
  await oldFinished;
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByText("Alpine Suite", { exact: true }).first()).toBeVisible();
});
