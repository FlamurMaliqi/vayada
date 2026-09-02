import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_HOTEL_ID,
  BOOKING_ADMIN_HOTEL_SLUG,
  BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH,
  BOOKING_ADMIN_PROPERTY_ID,
  BOOKING_ADMIN_PROPERTY_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchPageHealth } from "../support/pageHealth";

const PROD = process.env.E2E_BOOKING_ADMIN_PROD === "1";

test.describe("booking-admin localization settings cutover", () => {
  test("loads and saves localization settings through the TypeScript contract", async ({
    page,
  }, testInfo) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    await mockBookingAdminBookingFlow(page);
    const financeWrites: unknown[] = [];
    let expectedFinanceCurrency = "CHF";
    await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}`, async (route) => {
      const providerAccount = {
        providerAccountId: "acct_localization_e2e",
        provider: "stripe",
        status: "active",
        onboardingStatus: "completed",
        chargesEnabled: true,
        payoutsEnabled: true,
        capabilities: ["card_payments", "transfers"],
      };
      if (route.request().method() === "PATCH") {
        const body = route.request().postDataJSON() as {
          paymentSettings: { defaultCurrency: string };
        };
        financeWrites.push(body);
        if (body.paymentSettings.defaultCurrency !== expectedFinanceCurrency) {
          await route.fulfill({ status: 409, json: { code: "property_currency_conflict" } });
          return;
        }
        await route.fulfill({
          json: {
            contractVersion: "finance-route-contracts.v1",
            propertyId: BOOKING_ADMIN_PROPERTY_ID,
            paymentSettings: { ...body.paymentSettings, providerAccount },
          },
        });
        return;
      }
      await route.fulfill({
        json: {
          contractVersion: "finance-route-contracts.v1",
          propertyId: BOOKING_ADMIN_PROPERTY_ID,
          paymentSettings: {
            paymentsEnabled: true,
            paymentProvider: "stripe",
            acceptedMethods: ["card"],
            defaultCurrency: "EUR",
            supportedCurrencies: ["EUR"],
            requiresManualReview: false,
            providerAccount,
          },
        },
      });
    });

    const legacyWrites: unknown[] = [];
    await page.route("**/admin/settings/property", async (route) => {
      if (route.request().method() === "PATCH") {
        legacyWrites.push(route.request().postDataJSON());
        await route.fulfill({
          json: {
            id: BOOKING_ADMIN_HOTEL_ID,
            slug: BOOKING_ADMIN_HOTEL_SLUG,
            default_currency: "CHF",
            default_language: "de",
            supported_currencies: ["EUR", "USD"],
            supported_languages: ["en", "fr"],
            special_requests_enabled: false,
            arrival_time_enabled: true,
            guest_count_enabled: true,
          },
        });
        return;
      }

      await route.fulfill({
        json: {
          id: BOOKING_ADMIN_HOTEL_ID,
          slug: BOOKING_ADMIN_HOTEL_SLUG,
          default_currency: "EUR",
          default_language: "en",
          supported_currencies: [],
          supported_languages: [],
          special_requests_enabled: false,
          arrival_time_enabled: false,
          guest_count_enabled: false,
        },
      });
    });

    const contractRequests: string[] = [];
    const typedWrites: unknown[] = [];
    let failRead = true;
    let failWrite = false;
    let delayWrite = false;
    let releaseLocalizationWrite: (() => void) | null = null;
    let canonicalLocalization = {
      defaultCurrency: "CHF",
      defaultLanguage: "de",
      supportedCurrencies: ["EUR", "USD"],
      supportedLanguages: ["en", "fr"],
    };
    await page.route(`**${BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH}*`, async (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON() as typeof canonicalLocalization;
        typedWrites.push(body);
        if (delayWrite) {
          await new Promise<void>((resolve) => {
            releaseLocalizationWrite = resolve;
          });
        }
        if (failWrite) {
          await route.fulfill({ status: 503, json: { message: "Localization save failed." } });
          return;
        }
        canonicalLocalization = body;
        await route.fulfill({ json: body });
        return;
      }

      contractRequests.push(route.request().url());
      expect(route.request().method()).toBe("GET");
      if (failRead) {
        failRead = false;
        await route.fulfill({
          status: 503,
          json: { message: "Localization settings failed to load." },
        });
        return;
      }
      await route.fulfill({
        json: canonicalLocalization,
      });
    });

    await page.goto("/settings?section=localization");
    await expect(page.getByRole("button", { name: "Localization", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      page.getByRole("alert").filter({ hasText: "Localization settings failed to load." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Retry" }).click();
    const assertHealthy = watchPageHealth(page, testInfo);

    await expect(page.getByRole("heading", { name: "Currency & Languages" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Swiss Franc/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /German/ })).toBeVisible();
    await expect(page.getByText("Added (2):").first()).toBeVisible();
    await expect(page.getByText("EUR").first()).toBeVisible();
    await expect(page.getByText("USD").first()).toBeVisible();
    await expect(page.getByText("English").first()).toBeVisible();
    await expect(page.getByText(/Fran/).first()).toBeVisible();

    await page.getByPlaceholder(/Search currencies/).fill("LKR");
    await page.getByRole("option", { name: /Sri Lankan Rupee.*LKR/ }).click();
    await expect(page.getByText("LKR").first()).toBeVisible();

    await page.getByRole("button", { name: /^Save Changes$/ }).click();

    await expect.poll(() => typedWrites.length).toBe(1);
    await expect(
      page.getByRole("status").filter({ hasText: "Currency & language settings saved" }),
    ).toBeVisible();

    expect(contractRequests.length).toBeGreaterThan(0);
    expect(new URL(contractRequests[0]!).pathname).toBe(BOOKING_ADMIN_LOCALIZATION_SETTINGS_PATH);
    expect(typedWrites).toEqual([
      {
        defaultCurrency: "CHF",
        defaultLanguage: "de",
        supportedCurrencies: ["EUR", "USD", "LKR"],
        supportedLanguages: ["en", "fr"],
      },
    ]);
    expect(legacyWrites).toEqual([]);

    await page.getByRole("button", { name: "Payments", exact: true }).click();
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect.poll(() => financeWrites.length).toBe(1);
    expect(financeWrites[0]).toMatchObject({
      paymentSettings: { defaultCurrency: "CHF", supportedCurrencies: ["CHF"] },
    });
    await page.getByRole("button", { name: "Localization", exact: true }).click();
    await assertHealthy();

    await page.getByRole("button", { name: /Swiss Franc/ }).click();
    await page.getByPlaceholder("Search...", { exact: true }).fill("USD");
    await page.getByRole("button", { name: /US Dollar/ }).click();
    delayWrite = true;
    await page.getByRole("button", { name: /^Save Changes$/ }).click();
    await expect.poll(() => typedWrites.length).toBe(2);

    await page.getByRole("button", { name: "Payments", exact: true }).click();
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    expect(financeWrites).toHaveLength(1);
    await expect(
      page.getByRole("alert").filter({
        hasText: "Localization settings did not load. Retry Localization before saving payments.",
      }),
    ).toBeVisible();

    expectedFinanceCurrency = "USD";
    delayWrite = false;
    releaseLocalizationWrite?.();
    await expect(
      page.getByRole("status").filter({ hasText: "Currency & language settings saved" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect.poll(() => financeWrites.length).toBe(2);
    expect(financeWrites[1]).toMatchObject({
      paymentSettings: { defaultCurrency: "USD", supportedCurrencies: ["USD"] },
    });

    await page.getByRole("button", { name: "Localization", exact: true }).click();
    await page.getByRole("button", { name: /US Dollar/ }).click();
    await page.getByPlaceholder("Search...", { exact: true }).fill("CHF");
    await page.getByRole("button", { name: /Swiss Franc/ }).click();
    failWrite = true;
    await page.getByRole("button", { name: /^Save Changes$/ }).click();
    await expect.poll(() => typedWrites.length).toBe(3);
    expect(typedWrites[2]).toMatchObject({ defaultCurrency: "CHF" });
    await expect(
      page.getByRole("alert").filter({ hasText: "Failed to save currency & language settings" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Payments", exact: true }).click();
    await page.getByRole("button", { name: "Save Changes", exact: true }).click();
    await expect.poll(() => financeWrites.length).toBe(3);
    expect(financeWrites[2]).toMatchObject({
      paymentSettings: { defaultCurrency: "USD", supportedCurrencies: ["USD"] },
    });

    const settingsContractRequestCount = contractRequests.length;
    const assertBookingFlowHealthy = watchPageHealth(page, testInfo);
    await page.goto("/booking-flow");
    await expect(page.getByRole("button", { name: "Localization", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Currency & Languages" })).toHaveCount(0);
    await expect.poll(() => contractRequests.length).toBeGreaterThan(settingsContractRequestCount);

    await assertBookingFlowHealthy();
  });

  test("loads canonical localization when property settings are unavailable", async ({ page }) => {
    test.skip(
      !PROD,
      "Requires a production booking-admin build so the authenticated shell hydrates.",
    );

    await mockBookingAdminBookingFlow(page);
    await page.route(`**${BOOKING_ADMIN_PROPERTY_SETTINGS_PATH}*`, (route) =>
      route.fulfill({ status: 503, json: { message: "Property settings unavailable." } }),
    );

    await page.goto("/settings?section=localization");

    await expect(page.getByRole("heading", { name: "Currency & Languages" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Euro/ })).toBeVisible();
  });
});
