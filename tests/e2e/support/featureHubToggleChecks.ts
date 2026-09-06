import { expect, test, type Page } from "@playwright/test";

export function featureHubToggleChecks(
  propertyId: string,
  setup: (page: Page) => Promise<void>,
  hasSidebar: boolean,
  saveError = "Module save failed.",
) {
  for (const unavailableStorage of [false, true]) {
    test(`Feature Hub saves toggles without dialogs and rolls back failed saves (storage unavailable: ${unavailableStorage})`, async ({
      page,
    }) => {
      if (unavailableStorage) {
        await page.addInitScript(() => {
          const setItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key.startsWith("vayada-feature-modules"))
              throw new DOMException("Quota exceeded", "QuotaExceededError");
            return setItem.call(this, key, value);
          };
        });
      }
      await setup(page);
      const dialogs: string[] = [];
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      });
      let active = true;
      let writes = 0;
      let fail = false;
      let release = () => {};
      let pending: Promise<void>;
      const holdSave = () => {
        pending = new Promise<void>((resolve) => {
          release = resolve;
        });
      };
      holdSave();
      await page.route(
        new RegExp(`/api/pms/properties/${propertyId}/module-activations(?:/affiliates)?$`),
        async (route) => {
          const request = route.request();
          if (request.method() === "OPTIONS")
            return route.fulfill({
              status: 204,
              headers: {
                "access-control-allow-origin": request.headers().origin ?? "*",
                "access-control-allow-headers": "authorization,content-type",
                "access-control-allow-methods": "GET,PATCH,OPTIONS",
              },
            });
          if (request.method() === "GET")
            return route.fulfill({
              json: {
                hotelId: propertyId,
                canManage: true,
                supportedModules: ["affiliates"],
                activeModules: active ? ["affiliates"] : [],
                activations: [],
              },
            });
          expect(request.method()).toBe("PATCH");
          expect(request.postDataJSON()).toEqual({ moduleId: "affiliates", isActive: !active });
          writes++;
          await pending;
          const headers = { "access-control-allow-origin": request.headers().origin ?? "*" };
          if (fail)
            return route.fulfill({ status: 503, headers, json: { detail: "Module save failed." } });
          active = request.postDataJSON().isActive;
          return route.fulfill({
            headers,
            json: {
              moduleId: "affiliates",
              isActive: active,
              activatedAt: null,
              deactivatedAt: null,
              updatedAt: new Date().toISOString(),
            },
          });
        },
      );
      await page.goto("/settings/feature-hub");
      const toggle = page.locator("article").getByRole("switch");
      const previewAffiliate = page
        .locator("aside section")
        .getByRole("listitem")
        .filter({ hasText: /^Affiliates$/ });
      const sidebarAffiliate = page
        .getByRole("navigation")
        .getByRole("link", { name: "Affiliates", exact: true });
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect.poll(() => writes).toBe(1);
      await expect(toggle).not.toBeChecked();
      await expect(toggle).toBeDisabled();
      await expect(previewAffiliate).toHaveCount(0);
      if (hasSidebar) await expect(sidebarAffiliate).toHaveCount(0);
      expect(active).toBe(true);
      release();
      await expect(toggle).toBeEnabled();
      await page.reload();
      await expect(toggle).toBeEnabled();
      await expect(toggle).not.toBeChecked();

      fail = true;
      holdSave();
      await toggle.press("Space");
      await expect.poll(() => writes).toBe(2);
      await expect(toggle).toBeChecked();
      await expect(previewAffiliate).toBeVisible();
      if (hasSidebar) await expect(sidebarAffiliate).toBeVisible();
      release();
      await expect(toggle).toBeEnabled();
      await expect(toggle).not.toBeChecked();
      await expect(page.getByRole("alert").filter({ hasText: saveError })).toContainText(saveError);
      await expect(previewAffiliate).toHaveCount(0);
      if (hasSidebar) await expect(sidebarAffiliate).toHaveCount(0);

      fail = false;
      await toggle.click();
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();
      await expect(page.getByRole("alert").filter({ hasText: saveError })).toHaveCount(0);
      await page.reload();
      await expect(toggle).toBeEnabled();
      await expect(toggle).toBeChecked();

      await page.getByRole("button", { name: "Details", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "Affiliates" });
      fail = true;
      await modal.getByRole("button", { name: "Deactivate", exact: true }).click();
      await expect(modal.getByRole("alert")).toContainText(saveError);
      await expect(toggle).toBeChecked();
      fail = false;
      await modal.getByRole("button", { name: "Deactivate", exact: true }).click();
      await expect(
        modal.getByRole("button", { name: "Activate Module", exact: true }),
      ).toBeEnabled();
      await expect(toggle).not.toBeChecked();
      expect(writes).toBe(5);
      expect(dialogs).toEqual([]);
    });
  }
}
