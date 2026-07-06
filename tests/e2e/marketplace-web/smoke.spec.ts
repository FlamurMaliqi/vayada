import { expect, test } from "@playwright/test";

test.describe("marketplace-web smoke", () => {
  test("login page renders the custom auth form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  for (const intent of ["creator", "hotel"] as const) {
    test(`@signup ${intent} signup renders the custom form`, async ({ page }) => {
      await page.goto(`/signup?type=${intent}`);

      await expect(
        page.getByRole("heading", { name: new RegExp(`create ${intent} account`, "i") }),
      ).toBeVisible();
      await expect(page.getByLabel(/email/i)).toBeVisible();
      await expect(page.getByLabel(/password/i)).toBeVisible();
    });
  }
});
