import { expect, test } from "@playwright/test";
import { watchPageHealth } from "../support/pageHealth";

test.describe("booking-admin smoke", () => {
  test("login page renders the booking engine admin shell", async ({ page }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /booking engine/i, level: 1 })).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
    await expect(page.getByRole("textbox", { name: /password/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();

    await assertHealthy();
  });

  test("opens the paid Fixed Plan confirmation from billing settings", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await page.route("**/admin/module-activations", (route) =>
      route.fulfill({ json: { modules: [] } }),
    );
    await page.route("**/admin/hotels", (route) =>
      route.fulfill({
        json: [{ id: "hotel-1", name: "Hotel Test", slug: "hotel-test" }],
      }),
    );
    await page.route("**/admin/settings/property", (route) =>
      route.fulfill({
        json: {
          property_name: "Hotel Test",
          default_currency: "EUR",
          billing_active_plan: "commission",
          booking_engine_fee_pct: 5,
        },
      }),
    );
    await page.route("**/admin/settings/custom-domain/status", (route) =>
      route.fulfill({ json: { configured: false } }),
    );
    await page.route("**/admin/payment-settings", (route) =>
      route.fulfill({ json: { paymentSettings: {} } }),
    );
    await page.route("**/admin/billing/subscription", (route) =>
      route.fulfill({
        json: {
          plan: "commission",
          status: null,
          amount: 35,
          currency: "EUR",
          roomCount: 2,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          canManageBilling: false,
        },
      }),
    );

    await page.addInitScript(() => {
      localStorage.setItem("access_token", "e2e-token");
      localStorage.setItem("token_expires_at", String(Date.now() + 60_000));
      localStorage.setItem("isLoggedIn", "true");
      localStorage.setItem("userType", "hotel");
      localStorage.setItem("userStatus", "active");
      localStorage.setItem("userName", "Hotel Test");
      localStorage.setItem("userEmail", "hotel@example.test");
      localStorage.setItem("selectedHotelId", "hotel-1");
    });

    await page.goto("/settings?section=billing");

    const switchButton = page.getByRole("button", { name: "Switch to Fixed Plan" });
    await expect(switchButton).toBeVisible();
    await expect(page.getByText("€35", { exact: true })).toBeVisible();
    await expect(
      page.getByText("€30 for the first active room + €5 per additional active room"),
    ).toBeVisible();

    await switchButton.click();
    const dialog = page.getByRole("dialog", { name: "Switch to Fixed Plan" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("charged €35 now and then every 30 days through Stripe");
    await expect(dialog).toContainText("New rooms affect only the next 30-day charge");
    await expect(dialog.getByRole("button", { name: "Continue to Stripe" })).toBeVisible();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await page.unroute("**/admin/billing/subscription");
    await page.route("**/admin/billing/subscription", (route) =>
      route.fulfill({
        json: {
          plan: "commission",
          status: "checkout_pending",
          amount: 35,
          currency: "EUR",
          roomCount: 2,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
          canManageBilling: true,
        },
      }),
    );
    await page.reload();
    await expect(page.getByText("Stripe Checkout is in progress")).toBeVisible();
    await expect(switchButton).toBeHidden();
    await assertHealthy();
  });
});
