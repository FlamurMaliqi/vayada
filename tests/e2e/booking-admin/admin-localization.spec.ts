import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  mockBookingAdminBookingFlow,
  mockBookingAdminDesignSettings,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";

const catalog = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(`apps/booking-admin/messages/${locale}.json`, "utf8"));

for (const locale of ["de", "fr", "es", "id", "ja", "zh", "ru", "it", "nl"]) {
  test(`${locale}: payment settings and shared add-on editor persist the admin language`, async ({
    page,
  }, testInfo) => {
    const messages = catalog(locale);
    const noLegacy = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");
    await mockBookingAdminBookingFlow(page);
    await page.addInitScript(
      (language) => localStorage.setItem("admin_language", language),
      locale,
    );
    await page.goto("/settings?section=payments");
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(
      page.getByRole("heading", { name: messages["admin.payments"], exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(messages["admin.howYourHotelCollectsPaymentsFromGuests"], { exact: true }),
    ).toBeVisible();
    await page.goto("/settings?section=billing");
    await expect(
      page.getByRole("heading", { name: messages["settings.billing.paymentMethods"], exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(messages["admin.guestsSendPaymentManuallyToYourPayPalEmailConfirmIt"], {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Guest pays online with credit or debit card via Stripe", { exact: true }),
    ).toHaveCount(0);
    await page.goto("/booking-flow");
    await page
      .getByRole("button", { name: messages["bookingFlow.tabs.addons"], exact: true })
      .click();
    await page
      .getByRole("button", { name: messages["bookingFlow.addons.addExperience"], exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("radio", { name: messages["addons.editor.perPersonNight"], exact: true }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: messages["addons.editor.createAddOn"], exact: true })
      .click();
    await expect(
      dialog.getByText(messages["addons.editor.nameIsRequired"], { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`addon-${locale}.png`), fullPage: true });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await expect(
      page.getByRole("heading", { name: messages["bookingFlow.title"], exact: true }),
    ).toBeVisible();
    await noLegacy();
  });
}

test("switches language through the profile menu and translates the live preview", async ({
  page,
}) => {
  await mockBookingAdminBookingFlow(page);
  await mockBookingAdminDesignSettings(page);
  const en = catalog("en"),
    de = catalog("de");
  await page.goto("/design-studio");
  const heading = page.getByRole("textbox", { name: en["admin.heroHeading"], exact: true });
  await heading.fill("Unsaved hotel headline");
  await page.getByRole("button", { name: "BO", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(en["layout.header.language"]) }).click();
  await page.getByRole("button", { name: /Deutsch/ }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
  await expect(
    page.getByRole("heading", { name: de["designStudio.title"], exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: de["bookingPreview.checkAvailability"] }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: de["admin.heroHeading"], exact: true }),
  ).toHaveValue("Unsaved hotel headline");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "de");
});

test("a visible module inventory error follows a later language change", async ({ page }) => {
  await mockBookingAdminBookingFlow(page);
  await page.route("**/api/pms/properties/*/module-activations**", (route) =>
    route.fulfill({ status: 503, json: { detail: "Backend failure in English" } }),
  );
  const en = catalog("en"),
    de = catalog("de");
  await page.goto("/settings/feature-hub");
  await expect(
    page.getByRole("alert").filter({ hasText: en["featureHub.copy.couldNotLoadModules"] }),
  ).toBeVisible();
  await page.getByRole("button", { name: "BO", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(en["layout.header.language"]) }).click();
  await page.getByRole("button", { name: /Deutsch/ }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: de["featureHub.copy.couldNotLoadModules"] }),
  ).toBeVisible();
  await expect(page.getByText("Backend failure in English")).toHaveCount(0);
});

test("German add-on editor fits a narrow screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBookingAdminBookingFlow(page);
  await page.addInitScript(() => localStorage.setItem("admin_language", "de"));
  const de = catalog("de");
  await page.goto("/booking-flow");
  await page.getByRole("button", { name: de["bookingFlow.tabs.addons"], exact: true }).click();
  await page
    .getByRole("button", { name: de["bookingFlow.addons.addExperience"], exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(
    dialog.getByRole("button", { name: de["addons.editor.createAddOn"], exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("addon-de-mobile.png") });
});
