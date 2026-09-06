import { expect, test } from "@playwright/test";

import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

test("fetches protected bank instructions after submission and refresh without storing them", async ({
  page,
}) => {
  await mockBookingApis(page);
  const token = "c".repeat(43);
  const booking = {
    id: "bank-booking",
    bookingReference: "VAY-BANK",
    status: "pending_payment",
    paymentStatus: "unpaid",
    paymentMethod: "bank_transfer",
    hotelName: "Hotel Alpenrose",
    roomName: "Alpine Suite",
    guestFirstName: "Ada",
    guestLastName: "Lovelace",
    guestEmail: "ada@example.test",
    checkIn: "2026-10-12",
    checkOut: "2026-10-15",
    nights: 3,
    adults: 2,
    children: 0,
    numberOfRooms: 1,
    currency: "EUR",
    totalAmount: 720,
    createdAt: "2026-09-05T00:00:00Z",
  };
  await page.addInitScript(
    (value) => sessionStorage.setItem("lastBooking", JSON.stringify(value)),
    booking,
  );
  let calls = 0;
  let instructionsAvailable = true;
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      calls++;
      expect(route.request().postDataJSON()).toEqual({
        bookingReference: "VAY-BANK",
        confirmationToken: token,
      });
      await route.fulfill({
        json: {
          ...booking,
          bankTransferDetails: instructionsAvailable ? "IBAN: DE89370400440532013000" : null,
        },
      });
    },
  );
  await page.goto(`/confirmation?booking=VAY-BANK&token=${token}`);
  await expect(page.getByText("IBAN: DE89370400440532013000", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(
    "DE89370400440532013000",
  );
  await page.reload();
  await expect(page.getByText("IBAN: DE89370400440532013000", { exact: true })).toBeVisible();
  expect(calls).toBe(2);
  instructionsAvailable = false;
  await page.reload();
  await expect(page.getByText("IBAN: DE89370400440532013000", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Manage Booking", exact: true }).first(),
  ).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(
    "DE89370400440532013000",
  );
});

test("recovers a completed card payment and survives refresh or a new tab", async ({
  page,
  browser,
}) => {
  await mockBookingApis(page);
  const telemetry: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/booking-web/events"))
      telemetry.push(request.postDataJSON().eventType);
  });
  let createCalls = 0;
  let idempotencyKey = "";
  const confirmationToken = "a".repeat(43);
  const confirmedBooking = {
    id: "booking-card-1267",
    bookingReference: "VAY-1267",
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

  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings`, async (route) => {
    createCalls += 1;
    idempotencyKey = route.request().headers()["idempotency-key"] ?? "";
    await route.fulfill({
      json: {
        authorizationComplete: true,
        clientSecret: null,
        paymentMethod: "card",
        confirmationToken,
        booking: confirmedBooking,
      },
    });
  });
  await page.addInitScript(
    ({ slug, token }) => {
      localStorage.setItem(
        `vayada_booking_analytics:${slug}`,
        JSON.stringify({ version: 1, analytics: true }),
      );
      sessionStorage.setItem(
        "pendingBookingCreateRecovery",
        JSON.stringify({
          slug,
          quoteId: "quote-card-1267",
          paymentMethod: "card",
          createIdempotencyKey: "booking-web:create:card-1267",
          draftId: "booking-card-1267",
          confirmationToken: token,
          quote: {
            roomTypeId: "alpine-suite",
            roomName: "Alpine Suite",
            rateType: "flexible",
            paymentMethod: "card",
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
          requestBody: {
            roomTypeId: "alpine-suite",
            guestFirstName: "Ada",
            guestLastName: "Lovelace",
            guestEmail: "ada@example.test",
            guestPhone: "+41440000000",
            checkIn: "2026-09-12",
            checkOut: "2026-09-15",
            adults: 2,
            children: 0,
            numberOfRooms: 1,
            paymentMethod: "card",
          },
        }),
      );
    },
    { slug: SEEDED_BOOKING_SLUG, token: confirmationToken },
  );

  await page.goto(`/confirmation?booking=VAY-1267&token=${confirmationToken}`);

  await expect(page).toHaveURL(
    new RegExp(`/confirmation\\?booking=VAY-1267&token=${confirmationToken}$`),
  );
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  await expect(page.getByRole("heading", { name: "Your booking is confirmed!" })).toBeVisible();
  await expect(page.getByText("VAY-1267", { exact: true })).toBeVisible();
  await expect(page.getByText("Alpine Suite", { exact: true })).toBeVisible();
  await expect(page.getByText(/€720/)).toBeVisible();
  await expect(page.getByText(/Visa •••• 4242/)).toBeVisible();
  await expect.poll(() => telemetry).toEqual(["payment_authorized", "booking_completed"]);
  expect(createCalls).toBe(1);
  expect(idempotencyKey).toBe("booking-web:create:card-1267");

  await page.reload();

  await expect(page.getByRole("heading", { name: "Your booking is confirmed!" })).toBeVisible();
  await expect(page.getByText(/Visa •••• 4242/)).toBeVisible();
  expect(createCalls).toBe(1);

  const freshContext = await browser.newContext();
  const freshPage = await freshContext.newPage();
  await mockBookingApis(freshPage);
  let freshCreateCalls = 0;
  let confirmationCalls = 0;
  await freshPage.addInitScript(
    ({ slug, staleToken }) => {
      sessionStorage.setItem(
        "pendingBookingCreateRecovery",
        JSON.stringify({
          slug,
          quoteId: "stale-quote",
          paymentMethod: "card",
          createIdempotencyKey: "stale-create",
          confirmationToken: staleToken,
          quote: {},
          requestBody: {},
        }),
      );
    },
    { slug: SEEDED_BOOKING_SLUG, staleToken: "b".repeat(43) },
  );
  await freshPage.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings`,
    async (route) => {
      freshCreateCalls += 1;
      await route.fulfill({ status: 500 });
    },
  );
  await freshPage.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/confirmation`,
    async (route) => {
      confirmationCalls += 1;
      expect(route.request().postDataJSON()).toEqual({
        bookingReference: "VAY-1267",
        confirmationToken,
      });
      if (confirmationCalls === 1) {
        await route.abort("connectionfailed");
        return;
      }
      await route.fulfill({ json: confirmedBooking });
    },
  );
  await freshPage.goto(page.url());
  await expect(
    freshPage.getByRole("heading", { name: "Your booking is confirmed!" }),
  ).toBeVisible();
  await expect(freshPage.getByText(/Visa •••• 4242/)).toBeVisible();
  expect(createCalls).toBe(1);
  expect(freshCreateCalls).toBe(0);
  expect(confirmationCalls).toBe(2);
  await freshContext.close();
});
