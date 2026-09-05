import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH,
  mockBookingAdminBookingFlow,
} from "../support/bookingAdminMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

test("manages all automatic promotions in Promos and preserves last-minute tiers", async ({
  page,
}, testInfo) => {
  test.skip(process.env.E2E_BOOKING_ADMIN_PROD !== "1", "Requires production booking-admin build.");
  const healthy = watchPageHealth(page, testInfo);
  const noLegacy = watchNoLegacyCalls(page, testInfo, "booking-admin-booking-flow");
  await mockBookingAdminBookingFlow(page);
  let settings: Record<string, any> = {
    enabled: true,
    stackWithPromo: true,
    tiers: [
      { daysBeforeMin: 0, daysBeforeMax: 2, discountPercent: 12.5 },
      { daysBeforeMin: 3, daysBeforeMax: 5, discountPercent: 0.5 },
    ],
    updatedAt: "2026-09-05T10:00:00Z",
  };
  const originalTiers = structuredClone(settings.tiers);
  await page.route(`**${BOOKING_ADMIN_LAST_MINUTE_SETTINGS_PATH}*`, async (route) => {
    if (route.request().method() === "PUT")
      settings = { ...route.request().postDataJSON(), updatedAt: settings.updatedAt };
    await route.fulfill({ json: settings });
  });
  await page.goto("/promo-codes");
  await expect(page.getByRole("heading", { name: "Promos", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Promotions", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit Last minute escape" }).click();
  await expect(
    page.getByRole("spinbutton", { name: "Discount %", exact: true }).first(),
  ).toHaveValue("12.5");
  await page.getByRole("button", { name: "Save promotion", exact: true }).click();
  expect(settings.promotions[0].tiers).toEqual(originalTiers);
  for (const [type, name] of [
    ["EARLY_BIRD", "Early bird"],
    ["EXTENDED_STAY", "Extended stay"],
    ["MIDWEEK", "Midweek getaway"],
  ]) {
    await page.getByRole("button", { name: "+ New promotion", exact: true }).click();
    await page.getByLabel("Promotion type").selectOption(type!);
    if (type === "EXTENDED_STAY") {
      await page.getByLabel("Discount format").selectOption("free");
      await page.getByLabel("Free nights", { exact: true }).fill("");
      await expect(page.getByLabel("Discount format")).toHaveValue("free");
      await page.getByLabel("Free nights", { exact: true }).fill("2");
    }
    await page.getByRole("button", { name: "Save promotion", exact: true }).click();
    await expect(page.getByRole("heading", { name: name!, exact: true })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "+ New promotion", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Edit Extended stay" }).click();
  await expect(page.getByLabel("Discount format")).toHaveValue("free");
  await expect(page.getByLabel("Free nights", { exact: true })).toHaveValue("2");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Activate Last minute escape" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(settings.promotions[0].tiers).toEqual(originalTiers);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Edit Early bird" }).click();
  await page.getByLabel("Minimum days ahead").fill("45");
  await page.getByRole("group", { name: "Room targeting" }).getByRole("checkbox").nth(1).check();
  await page.getByRole("button", { name: "Save promotion", exact: true }).click();
  await expect(page.getByText("Book 45+ days ahead", { exact: true })).toBeVisible();
  expect(settings.promotions.find((p: any) => p.type === "EARLY_BIRD").roomTypeIds).toHaveLength(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Midweek getaway", exact: true }) })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "+ New promotion", exact: true })).toBeVisible();
  await testInfo.attach("promotions-desktop", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Collapse", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await testInfo.attach("promotions-mobile", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await page.goto("/booking-flow");
  await expect(page.getByRole("button", { name: /^Last-Minute$/ })).toHaveCount(0);
  await healthy();
  await noLegacy();
});
