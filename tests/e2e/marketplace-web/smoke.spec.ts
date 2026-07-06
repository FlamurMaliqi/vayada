import { expect, test } from "@playwright/test";

test.describe("marketplace-web smoke", () => {
  test("login page renders the custom password form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Sign in to vayada" })).toBeVisible();
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
  });

  test("login callback renders locally", async ({ request }) => {
    const response = await request.get("/login?auth=callback", {
      maxRedirects: 0,
    });

    expect(response.status()).toBe(200);
  });

  for (const intent of ["creator", "hotel"] as const) {
    test(`@signup ${intent} signup renders the custom password form`, async ({ page }) => {
      await page.goto(`/signup?type=${intent}`);

      await expect(
        page.getByRole("heading", {
          name: intent === "hotel" ? "Create hotel account" : "Create creator account",
        }),
      ).toBeVisible();
      await expect(page.getByLabel("Email address")).toBeVisible();
      await expect(page.getByLabel("Password")).toBeVisible();
      await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
    });
  }
});
