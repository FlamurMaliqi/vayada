import { expect, test, type Page } from "@playwright/test";

export function featureHubRetirementChecks(
  propertyId: string,
  setup: (page: Page) => Promise<void>,
) {
  for (const active of [false, true]) {
    test(`Feature Hub omits retired affiliates without changing records (active: ${active})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: active ? 390 : 1280, height: 900 });
      await setup(page);
      let reads = 0;
      let writes = 0;
      await page.route(
        new RegExp(`/api/pms/properties/${propertyId}/module-activations(?:/affiliates)?$`),
        async (route) => {
          const request = route.request();
          if (request.method() === "GET") {
            reads++;
            return route.fulfill({
              json: {
                hotelId: propertyId,
                canManage: true,
                supportedModules: ["affiliates"],
                activeModules: active ? ["affiliates"] : [],
                activations: [{ moduleId: "affiliates", isActive: active }],
              },
            });
          }
          if (request.method() !== "OPTIONS") writes++;
          return route.fulfill({ status: 204 });
        },
      );
      await page.goto("/settings/feature-hub");
      await expect.poll(() => reads).toBeGreaterThan(0);
      await expect(page.getByText("No modules in this category.")).toBeVisible();
      await expect(page.locator("article")).toHaveCount(0);
      await expect(page.getByRole("switch")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Affiliates", exact: true })).toHaveCount(0);
      await expect(page.locator('a[href="/affiliates"]')).toHaveCount(0);
      await expect(page.getByRole("listitem").filter({ hasText: /^Affiliates$/ })).toHaveCount(0);
      const beforeReload = reads;
      await page.reload();
      await expect.poll(() => reads).toBeGreaterThan(beforeReload);
      await expect(page.getByText("No modules in this category.")).toBeVisible();
      expect(writes).toBe(0);
    });
  }
}
