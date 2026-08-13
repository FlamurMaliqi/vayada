import { expect, test } from "@playwright/test";

import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

const confirmationToken = "c".repeat(43);
const booking = {
  id: "booking-1268",
  bookingReference: "VAY-1268",
  status: "confirmed",
  paymentStatus: "paid",
  paymentMethod: "card",
  cardBrand: "visa",
  cardLast4: "4242",
  hotelName: "Hotel Alpenrose",
  roomName: "Alpine Suite",
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.test",
  checkIn: "2026-09-12",
  checkOut: "2026-09-15",
  nights: 3,
  adults: 2,
  children: 0,
  numberOfRooms: 1,
  currency: "EUR",
  totalAmount: 720,
  createdAt: "2026-09-01T10:00:00.000Z",
};

test("finds a booking from the shared footer on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBookingApis(page);
  let lookupBody: unknown;
  let confirmationBody: unknown;
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`,
    async (route) => {
      lookupBody = route.request().postDataJSON();
      await route.fulfill({
        json: {
          ...booking,
          confirmationToken,
          confirmationTokenExpiresAt: "2026-09-02T10:00:00.000Z",
        },
      });
    },
  );
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      confirmationBody = route.request().postDataJSON();
      await route.fulfill({ json: booking });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Find My Booking" }).click();
  const dialog = page.getByRole("dialog", { name: "Look Up Your Booking" });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(358);
  expect(bounds?.x).toBeGreaterThanOrEqual(16);

  await dialog.getByLabel("Booking Reference").fill("vay-1268");
  await dialog.getByLabel("Email Address").fill("ada@example.test");
  await dialog.getByRole("button", { name: "Find My Booking" }).click();

  await expect(page).toHaveURL(
    new RegExp(`/confirmation\\?booking=VAY-1268&token=${confirmationToken}$`),
  );
  await expect(page.getByRole("heading", { name: "Your booking is confirmed!" })).toBeVisible();
  expect(lookupBody).toEqual({
    bookingReference: "VAY-1268",
    guestEmail: "ada@example.test",
  });
  expect(confirmationBody).toEqual({
    bookingReference: "VAY-1268",
    confirmationToken,
  });
});

test("keeps booking lookup failures generic", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 360 });
  await mockBookingApis(page);
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`,
    async (route) => {
      await route.fulfill({
        status: 404,
        json: { detail: "Property hotel-alpenrose does not contain reference VAY-SECRET" },
      });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Find My Booking" }).click();
  const dialog = page.getByRole("dialog", { name: "Look Up Your Booking" });
  await dialog.getByLabel("Booking Reference").fill("VAY-SECRET");
  await dialog.getByLabel("Email Address").fill("wrong@example.test");
  await dialog.getByRole("button", { name: "Find My Booking" }).click();

  await expect(dialog.getByRole("alert")).toHaveText(
    "No booking found with that reference and email.",
  );
  await expect(dialog).not.toContainText("hotel-alpenrose");
  await expect(dialog.getByRole("button", { name: "Find My Booking" })).toBeVisible();
});

test("explains rate limits without claiming the booking is missing", async ({ page }) => {
  await mockBookingApis(page);
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`,
    async (route) => {
      await route.fulfill({ status: 429, json: { detail: "Too many attempts" } });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Find My Booking" }).click();
  const dialog = page.getByRole("dialog", { name: "Look Up Your Booking" });
  await dialog.getByLabel("Booking Reference").fill("VAY-1268");
  await dialog.getByLabel("Email Address").fill("ada@example.test");
  await dialog.getByRole("button", { name: "Find My Booking" }).click();

  await expect(dialog.getByRole("alert")).toHaveText(
    "Too many attempts. Please wait a minute and try again.",
  );
});

test("traps focus, restores the footer trigger, and ignores a dismissed lookup", async ({
  page,
}) => {
  await mockBookingApis(page);
  let releaseLookup = () => {};
  let markLookupStarted = () => {};
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/lookup`,
    async (route) => {
      markLookupStarted();
      await new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      await route.fulfill({
        json: {
          ...booking,
          confirmationToken,
          confirmationTokenExpiresAt: "2026-09-02T10:00:00.000Z",
        },
      });
    },
  );

  await page.goto("/");
  const trigger = page.getByRole("button", { name: "Find My Booking" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Look Up Your Booking" });
  await expect(dialog.getByLabel("Booking Reference")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await dialog.getByLabel("Booking Reference").fill("VAY-1268");
  await dialog.getByLabel("Email Address").fill("ada@example.test");
  await dialog.getByRole("button", { name: "Find My Booking" }).click();
  await lookupStarted;
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  releaseLookup();
  await page.waitForTimeout(100);
  await expect(page).toHaveURL(/\/$/);
});

test("shows a neutral recovery state for an invalid confirmation token", async ({ page }) => {
  await mockBookingApis(page);
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      await route.fulfill({ status: 404, json: { detail: "Booking not found" } });
    },
  );

  await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
  await expect(page.getByText(/Booking details are unavailable/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Booking Request Submitted" })).toHaveCount(0);
});

for (const [status, heading] of [
  ["pending", "Booking Request Submitted"],
  ["cancelled", "Booking Cancelled"],
  ["declined", "Booking Request Declined"],
  ["expired", "Booking Request Expired"],
] as const) {
  test(`shows the ${status} booking state`, async ({ page }) => {
    await mockBookingApis(page);
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
      async (route) => {
        await route.fulfill({ json: { ...booking, status } });
      },
    );

    await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText("VAY-1268", { exact: true })).toBeVisible();
  });
}
