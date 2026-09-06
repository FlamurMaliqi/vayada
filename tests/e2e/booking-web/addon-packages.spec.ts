import { expect, test } from "@playwright/test";
import { mockBookingApis, SEEDED_BOOKING_SLUG } from "../support/bookingMocks";

test("guest sees the cover/gallery and carries package pricing through guest details", async ({
  page,
}) => {
  await mockBookingApis(page);
  await page.route(`**/api/booking-web/hotels/${SEEDED_BOOKING_SLUG}/checkout-config`, (route) =>
    route.fulfill({
      json: {
        showAddonsStep: true,
        payAtPropertyEnabled: true,
        onlineCardPayment: false,
        freeCancellationDays: 7,
        phoneRequired: true,
        addons: [
          {
            id: "breakfast",
            name: "Daily Breakfast",
            description: "Fresh breakfast",
            price: 15,
            currency: "EUR",
            category: "dining",
            image: "/vayada-logo.png?photo=cover",
            images: ["/vayada-logo.png?photo=first", "/vayada-logo.png?photo=cover"],
            perPerson: true,
            perNight: true,
            maxQuantity: 2,
            leadTime: "24h before",
          },
        ],
      },
    }),
  );
  await page.goto(
    "/addons?room=alpine-suite&checkIn=2026-09-12&checkOut=2026-09-15&adults=2&children=0&rooms=1&rateType=flexible",
  );
  await expect(page.getByRole("img", { name: "Daily Breakfast", exact: true })).toHaveAttribute(
    "src",
    /cover/,
  );
  await page.getByRole("heading", { name: "Daily Breakfast", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Daily Breakfast" });
  await expect(details.getByRole("img", { name: "Daily Breakfast", exact: true })).toHaveAttribute(
    "src",
    /cover/,
  );
  await details.getByRole("button", { name: "Show photo 2", exact: true }).click();
  await expect(details.getByRole("img", { name: "Daily Breakfast", exact: true })).toHaveAttribute(
    "src",
    /first/,
  );
  await expect(details.getByText("Lead time: 24h before")).toBeVisible();
  await details.getByRole("button", { name: "Close add-on details" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText(/€90(?:\.00)?$/).first()).toBeVisible();
  await page.getByRole("spinbutton", { name: "Daily Breakfast quantity" }).fill("2");
  await expect(page.getByText(/€180(?:\.00)?$/).first()).toBeVisible();
  await page.getByRole("spinbutton", { name: "Daily Breakfast quantity" }).fill("3");
  await expect(page.getByRole("spinbutton", { name: "Daily Breakfast quantity" })).toHaveValue("2");
  await page.getByRole("button", { name: /Proceed to Guest/ }).click();
  await expect(page).toHaveURL(/addonPackages=breakfast%3A2/);
  await expect(page.getByText(/€180(?:\.00)?$/).first()).toBeVisible();
  await page.getByRole("combobox", { name: "Country", exact: true }).fill("Netherlands");
  await page.getByLabel("First Name").fill("Ada");
  await page.getByLabel("Last Name").fill("Lovelace");
  await page
    .getByRole("textbox", { name: "Email Address *", exact: true })
    .fill("ada@example.test");
  await page.getByLabel("Phone Number").fill("1234567");
  await page.getByRole("button", { name: "Continue to Payment" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(sessionStorage.getItem("guestDetails") ?? "{}").addonPackageQuantities,
      ),
    )
    .toEqual({ breakfast: 2 });
});
