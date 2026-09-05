import { expect, test } from "@playwright/test";
import {
  BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH,
  BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH,
  BOOKING_ADMIN_DESIGN_SETTINGS_PATH,
  mockBookingAdminAuthenticatedSession,
  mockBookingAdminShellRoutes,
} from "../support/bookingAdminMocks";

test.beforeEach(async ({ page }) => {
  await mockBookingAdminAuthenticatedSession(page);
  await mockBookingAdminShellRoutes(page);
});

test("searches from every main page and opens Domain directly with the keyboard", async ({
  page,
}, testInfo) => {
  for (const path of ["/", "/settings?section=localization", "/booking-flow", "/design-studio"]) {
    await page.goto(path);
    const search = page.getByRole("combobox", { name: "Search pages and settings" });
    await expect(search).toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(search).toBeFocused();
    await search.fill("domein");
    await expect(page.getByRole("option", { name: "Domain Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(search).toHaveAttribute("aria-expanded", "false");
  }
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox", { name: "Search pages and settings" }).fill("domain");
  await expect(page.getByRole("option", { name: "Domain Settings" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("search-desktop.png") });
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/design-studio\?tab=domain$/);
  await expect(page.getByRole("heading", { name: /custom domain/i })).toBeVisible();
  await page.getByRole("combobox", { name: "Search pages and settings" }).fill("payment");
  await page.getByRole("option", { name: "Payment Settings" }).click();
  await expect(page).toHaveURL(/\/settings\?section=payments$/);
  await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Search pages and settings" }).fill("");
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
});

test("keeps typed search while access checks are loading", async ({ page }) => {
  let release = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH}*`, async (route) => {
    await pending;
    await route.fallback();
  });
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Search pages and settings" });
  await search.fill("domain");
  await expect(page.getByText("Loading search…", { exact: true })).toBeVisible();
  release();
  await expect(page.getByRole("option", { name: "Domain Settings" })).toBeVisible();
  await expect(search).toHaveValue("domain");
});

test("shows empty results, hides denied settings and inactive affiliates, and supports mobile navigation", async ({
  page,
}, testInfo) => {
  await page.route(`**${BOOKING_ADMIN_FINANCE_PAYMENT_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ status: 403, json: { detail: "Forbidden" } }),
  );
  await page.route(`**${BOOKING_ADMIN_FINANCE_PLAN_STATUS_PATH}*`, (route) =>
    route.fulfill({ status: 403, json: { detail: "Forbidden" } }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  const search = page.getByRole("combobox", { name: "Search pages and settings" });
  for (const query of ["zzzzzz", "payment", "billing", "affiliates", "security", "notifications"]) {
    await search.fill(query);
    await expect(page.getByText("No results found", { exact: true })).toBeVisible();
  }
  await search.fill("language");
  await expect(page.getByRole("option")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("search-mobile.png") });
  await page.getByRole("option").click();
  await expect(page).toHaveURL(/\/settings\?section=localization$/);
  await expect(page.getByRole("heading", { name: "Localization", exact: true })).toBeVisible();
  await page.route(`**${BOOKING_ADMIN_DESIGN_SETTINGS_PATH}*`, (route) =>
    route.fulfill({ status: 403, json: { detail: "Forbidden" } }),
  );
  await page.getByRole("combobox", { name: "Search pages and settings" }).fill("domain");
  await expect(page.getByText("No results found", { exact: true })).toBeVisible();
});
