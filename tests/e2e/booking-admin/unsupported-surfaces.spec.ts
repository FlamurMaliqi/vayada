import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_PROPERTY_ID,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";

test.describe("booking-admin unsupported surfaces", () => {
  test("hides unsupported settings without exposing legacy controls", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);

    await mockBookingAdminAuthenticatedSession(page);
    await mockBookingAdminShellRoutes(page);
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}*`, (route) =>
      route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "vayada",
            acceptedMethods: ["pay_at_property", "cash", "card"],
            defaultCurrency: "EUR",
            supportedCurrencies: [],
            requiresManualReview: false,
            providerAccount: {
              providerAccountId: null,
              provider: null,
              status: "not_configured",
              onboardingStatus: "not_started",
              chargesEnabled: false,
              payoutsEnabled: false,
              capabilities: [],
            },
          },
        },
      }),
    );

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Account", exact: true })).toHaveCount(0);
    await expect(page.getByText("Personal account security")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /change password/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /enable two-factor/i })).toHaveCount(0);

    await page.getByRole("button", { name: "BO", exact: true }).click();
    await page.getByRole("button", { name: /manage properties/i }).click();
    await expect(page.getByText("Deletion unavailable")).toBeVisible();
    await expect(page.getByRole("button", { name: /delete.*not available yet/i })).toBeDisabled();

    await assertHealthy();
  });
});
