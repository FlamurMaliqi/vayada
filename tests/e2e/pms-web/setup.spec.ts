import { expect, test } from "@playwright/test";

import { PMS_WEB_PROPERTY_ID } from "../support/pmsWebMocks";

test.describe("pms-web canonical setup redirect", () => {
  test("replaces local setup with Marketplace and preserves the exact product return path", async ({
    page,
  }) => {
    const expectedUrl = canonicalMarketplaceSetupUrl({
      entryProduct: "pms",
      returnTo: "/reservations?view=arrivals",
      propertyId: PMS_WEB_PROPERTY_ID,
    });
    await page.route("**/__before-local-setup", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Before local setup</title><h1>Before local setup</h1>",
      }),
    );
    await page.route(
      (url) => url.toString() === expectedUrl,
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Canonical setup</title><h1>Canonical setup</h1>",
        }),
    );

    await page.goto("/__before-local-setup");
    await page.goto(
      `/setup?entryProduct=pms&returnTo=${encodeURIComponent("/reservations?view=arrivals")}&propertyId=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect.poll(() => page.url()).toBe(expectedUrl);
    await expect(page.getByRole("heading", { name: "Canonical setup" })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Before local setup" })).toBeVisible();
  });

  test("preserves another valid entry product while defaulting an unsafe return path", async ({
    page,
  }) => {
    const expectedUrl = canonicalMarketplaceSetupUrl({
      entryProduct: "marketplace",
      returnTo: "/dashboard",
      propertyId: PMS_WEB_PROPERTY_ID,
    });
    await page.route(
      (url) => url.toString() === expectedUrl,
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Canonical setup</title><h1>Canonical setup</h1>",
        }),
    );

    await page.goto(
      `/setup?entryProduct=marketplace&returnTo=${encodeURIComponent("https://attacker.example/dashboard")}&propertyId=${PMS_WEB_PROPERTY_ID}`,
    );

    await expect.poll(() => page.url()).toBe(expectedUrl);
  });

  test("defaults a missing entry product to PMS", async ({ page }) => {
    const expectedUrl = canonicalMarketplaceSetupUrl({
      entryProduct: "pms",
      returnTo: "/dashboard",
      mode: "add",
    });
    await page.route(
      (url) => url.toString() === expectedUrl,
      (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Canonical setup</title><h1>Canonical setup</h1>",
        }),
    );

    await page.goto("/setup?mode=add");

    await expect.poll(() => page.url()).toBe(expectedUrl);
  });
});

function canonicalMarketplaceSetupUrl(input: {
  entryProduct: "booking" | "marketplace" | "pms";
  returnTo: string;
  propertyId?: string;
  mode?: "add";
}): string {
  const origin =
    process.env.E2E_MARKETPLACE_BASE_URL ||
    (process.env.CI === "true" || process.env.E2E_START_SERVERS === "1"
      ? "http://marketplace.localhost:3000"
      : "https://marketplace.localhost");
  const url = new URL("/setup", origin);
  url.searchParams.set("entryProduct", input.entryProduct);
  url.searchParams.set("returnProduct", "pms");
  url.searchParams.set("returnTo", input.returnTo);
  if (input.propertyId) url.searchParams.set("propertyId", input.propertyId);
  if (input.mode) url.searchParams.set("mode", input.mode);
  return url.toString();
}
