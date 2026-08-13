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
  unitNames: ["Suite 204", "Suite 205"],
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.test",
  checkIn: "2026-09-12",
  checkOut: "2026-09-15",
  nights: 3,
  adults: 2,
  children: 0,
  numberOfRooms: 2,
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
  await expect(page.getByText("2× Alpine Suite")).toBeVisible();
  await expect(page.getByText("Suite 204, Suite 205")).toBeVisible();
  await expect(page.getByText("Payment Status")).toBeVisible();
  await expect(page.getByRole("link", { name: "Contact Property" })).toHaveAttribute(
    "href",
    "mailto:stay@alpenrose.test",
  );
  await expect(page.getByRole("link", { name: "Manage Booking" })).not.toHaveAttribute(
    "href",
    /email=/,
  );
  await expect(page.getByRole("link", { name: "Request Changes" })).not.toHaveAttribute(
    "href",
    /email=/,
  );
  expect(lookupBody).toEqual({
    bookingReference: "VAY-1268",
    guestEmail: "ada@example.test",
  });
  expect(confirmationBody).toEqual({
    bookingReference: "VAY-1268",
    confirmationToken,
  });

  await page.getByRole("link", { name: "Manage Booking" }).click();
  await expect(page).toHaveURL(/\/my-booking\?reference=VAY-1268$/);
  await expect(page.getByText("Booking Found")).toBeVisible();
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
  ["checked_in", "You're checked in"],
  ["checked_out", "You've checked out"],
] as const) {
  test(`shows the ${status} booking state`, async ({ page }) => {
    await mockBookingApis(page);
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
      async (route) => {
        await route.fulfill({
          json: {
            ...booking,
            status,
            ...(status === "cancelled" ? { cancelledAt: "2026-09-04T22:30:00.000Z" } : {}),
          },
        });
      },
    );

    await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await expect(page.getByText("VAY-1268", { exact: true })).toBeVisible();
    if (status === "cancelled") {
      await expect(page.getByText("Cancelled on: Sep 5, 2026")).toBeVisible();
    }
  });
}

for (const status of ["pending", "confirmed"] as const) {
  test(`shows bank transfer instructions and deadline for an unpaid ${status} booking`, async ({
    page,
  }) => {
    await mockBookingApis(page);
    await page.route(
      `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
      async (route) => {
        await route.fulfill({
          json: {
            ...booking,
            status,
            paymentStatus: "unpaid",
            paymentMethod: "bank_transfer",
            bankTransferDetails: "IBAN: CH93 0076 2011 6238 5295 7",
            paymentDeadline: "2026-09-02T10:00:00.000Z",
          },
        });
      },
    );

    await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
    await expect(page.getByText("Bank transfer pending")).toBeVisible();
    await expect(page.getByText("IBAN: CH93 0076 2011 6238 5295 7")).toBeVisible();
    await expect(page.getByText(/Payment deadline: Sep 2, 2026, 12:00 PM GMT\+2/)).toBeVisible();
    await expect(page.getByText("Total Due")).toBeVisible();
  });
}

test("does not request a bank transfer after a booking ends", async ({ page }) => {
  await mockBookingApis(page);
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      await route.fulfill({
        json: {
          ...booking,
          status: "cancelled",
          paymentStatus: "unpaid",
          paymentMethod: "bank_transfer",
          bankTransferDetails: "IBAN: CH93 0076 2011 6238 5295 7",
          paymentDeadline: "2026-09-02T10:00:00.000Z",
        },
      });
    },
  );

  await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
  await expect(page.getByRole("heading", { name: "Booking Cancelled" })).toBeVisible();
  await expect(page.getByText("Bank transfer pending")).toHaveCount(0);
  await expect(page.getByText(/IBAN:/)).toHaveCount(0);
});

test("keeps polling statuses in the public status vocabulary", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-01T10:00:00.000Z") });
  await mockBookingApis(page);
  let statusReads = 0;
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      await route.fulfill({ json: { ...booking, status: "pending" } });
    },
  );
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/status**`,
    async (route) => {
      statusReads += 1;
      await route.fulfill({
        json: {
          bookingReference: booking.bookingReference,
          status: statusReads === 1 ? "pending" : "cancelled",
          paymentStatus: "unpaid",
        },
      });
    },
  );

  await page.goto(`/confirmation?booking=VAY-1268&token=${confirmationToken}`);
  await expect(page.getByRole("heading", { name: "Booking Request Submitted" })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect.poll(() => statusReads).toBe(1);
  await expect(page.getByRole("heading", { name: "Booking Request Submitted" })).toBeVisible();
  await page.clock.fastForward(30_000);
  await expect(page.getByRole("heading", { name: "Booking Cancelled" })).toBeVisible();
});
