import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

const token = "c".repeat(43);
const input = {
  roomTypeId: "alpine-suite",
  checkIn: "2027-02-01",
  checkOut: "2027-02-03",
  adults: 2,
  children: 0,
  numberOfRooms: 1,
  paymentMethod: "pay_at_property",
  currency: "EUR",
  addonIds: ["airport-transfer"],
  addonQuantities: { "airport-transfer": 1 },
  specialRequests: "Quiet room",
  guestFirstName: "Ada",
  guestLastName: "Lovelace",
  guestEmail: "ada@example.test",
};
const booking = {
  id: "booking-959",
  bookingReference: "VAY-959",
  status: "pending",
  canEditRequest: true,
  paymentStatus: "unpaid",
  hotelName: "Hotel Alpenrose",
  roomName: "Alpine Suite",
  ...input,
  nights: 2,
  totalAmount: 445,
  createdAt: new Date().toISOString(),
  hostResponseDeadlineAt: new Date(Date.now() + 86400000).toISOString(),
  pendingExpiresAt: new Date(Date.now() + 86400000).toISOString(),
};

test("prefills and saves every pending-request field without creating a booking", async ({
  page,
}) => {
  await mockBookingApis(page);
  let quoted: any;
  let saved = false;
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        payAtPropertyEnabled: true,
        onlineCardPayment: false,
        paypalEnabled: true,
        specialRequestsEnabled: true,
        addons: [{ id: "airport-transfer", name: "Airport Transfer", price: 45, currency: "EUR" }],
      },
    }),
  );
  await page.route(
    `**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/bookings/**/edit/*`,
    async (route) => {
      const action = new URL(route.request().url()).pathname.split("/").at(-1);
      const body = route.request().postDataJSON();
      expect(body.confirmationToken).toBe(token);
      if (action === "details") return route.fulfill({ json: { booking, revision: 3, input } });
      if (action === "quote") {
        quoted = body;
        return route.fulfill({
          json: { quoteId: "edit-quote", totalAmount: 700, currency: "EUR" },
        });
      }
      if (action === "prepare") {
        expect(body.quoteId).toBe("edit-quote");
        expect(body.expectedTotalAmount).toBe(700);
        return route.fulfill({ json: { attemptId: "attempt-959", clientSecret: null } });
      }
      expect(action).toBe("save");
      expect(body).toMatchObject({ revision: 3, attemptId: "attempt-959" });
      saved = true;
      return route.fulfill({
        json: { booking: { ...booking, ...quoted, totalAmount: 700 }, confirmationToken: token },
      });
    },
  );
  await page.route("**/api/booking-web/hotels/*/bookings/confirmation", (route) =>
    route.fulfill({ json: booking }),
  );
  await page.route("**/api/booking-web/hotels/*/bookings/*/status", (route) =>
    route.fulfill({ json: booking }),
  );
  await page.goto(`/en/booking/VAY-959/edit-request?token=${token}`);
  await expect(page.getByLabel("Check-in", { exact: true })).toHaveValue(input.checkIn);
  await expect(page.getByRole("textbox", { name: "Special requests", exact: true })).toHaveValue(
    "Quiet room",
  );
  await expect(page.getByRole("checkbox", { name: "Airport Transfer" })).toBeChecked();
  await page.getByLabel("Check-in", { exact: true }).fill("2027-02-02");
  await page.getByLabel("Check-out", { exact: true }).fill("2027-02-05");
  await page.getByLabel("Adults", { exact: true }).fill("3");
  await page.getByLabel("Children", { exact: true }).fill("1");
  await page.getByRole("combobox", { name: "Room", exact: true }).selectOption("garden-room");
  await page.getByLabel("Number of rooms", { exact: true }).fill("2");
  await page.getByLabel("Quantity", { exact: true }).fill("2");
  await page.getByLabel("Service dates, if needed").pressSequentially("2027-02-02, 2027-02-04");
  await expect(page.getByLabel("Service dates, if needed")).toHaveValue("2027-02-02, 2027-02-04");
  await page.getByRole("combobox", { name: "Payment method", exact: true }).selectOption("paypal");
  await page
    .getByRole("textbox", { name: "Special requests", exact: true })
    .fill("Late arrival, please.");
  await page.getByRole("button", { name: /Review/ }).click();
  await expect.poll(() => quoted?.roomTypeId).toBe("garden-room");
  expect(quoted).toMatchObject({
    revision: 3,
    checkIn: "2027-02-02",
    checkOut: "2027-02-05",
    adults: 3,
    children: 1,
    numberOfRooms: 2,
    addonQuantities: { "airport-transfer": 2 },
    addonDates: { "airport-transfer": ["2027-02-02", "2027-02-04"] },
    paymentMethod: "paypal",
    specialRequests: "Late arrival, please.",
  });
  await page.getByRole("button", { name: /Save/ }).click();
  await expect.poll(() => saved).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/booking/VAY-959\\?token=${token}$`));
});

test("canceling prefilled editing never saves", async ({ page }) => {
  await mockBookingApis(page);
  const writes: string[] = [];
  await page.route("**/bookings/*/edit/*", (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (action !== "details") writes.push(action);
    return route.fulfill({ json: { booking, revision: 0, input } });
  });
  await page.goto(`/en/booking/VAY-959/edit-request?token=${token}`);
  await expect(page.getByLabel("Check-in", { exact: true })).toHaveValue(input.checkIn);
  await page.getByLabel("Adults", { exact: true }).fill("1");
  await page.getByRole("link", { name: "Back to booking" }).click();
  expect(writes).toEqual([]);
});

test("can remove a retired selection", async ({ page }) => {
  await mockBookingApis(page);
  let quoted: any;
  await page.route("**/bookings/*/edit/*", (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (action === "details")
      return route.fulfill({
        json: {
          booking: { ...booking, addonIds: ["retired"], addonNames: ["Old spa"] },
          revision: 0,
          input: { ...input, addonIds: ["retired"], addonQuantities: { retired: 2 } },
        },
      });
    quoted = route.request().postDataJSON();
    return route.fulfill({ json: { quoteId: "new", totalAmount: 200, currency: "EUR" } });
  });
  await page.goto(`/en/booking/VAY-959/edit-request?token=${token}`);
  await page.getByRole("checkbox", { name: /Old spa/ }).click();
  await expect(page.getByRole("checkbox", { name: /Old spa/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Review/ }).click();
  await expect.poll(() => quoted?.addonIds).toEqual([]);
  expect(quoted.addonQuantities).toEqual({});
});
