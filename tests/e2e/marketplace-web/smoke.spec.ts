import { expect, test } from "@playwright/test";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

test.describe("marketplace-web smoke", () => {
  test("login page renders the custom auth form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
  });

  test("@signup unified signup renders the custom form", async ({ page }) => {
    await page.goto("/signup");

    await expect(page.getByRole("heading", { name: /create your vayada account/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/^password$/i)).toBeVisible();
    await expect(page.getByText(/hotel \/ property/i)).toHaveCount(0);
    await expect(page.getByText(/^creator$/i)).toHaveCount(0);
  });

  test("@signup onboarding collects account type after authentication", async ({ page }) => {
    await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        headers: corsHeaders(route),
        json: {
          accessToken: "workos-access-token",
          csrfToken: "csrf-token",
          user: {
            id: "user_signup",
            email: "signup@example.test",
            status: "active",
          },
        },
      });
    });
    await page.route(/\/auth\/compat\/marketplace-web-token/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      await route.fulfill({
        headers: corsHeaders(route),
        json: { accessToken: "legacy-marketplace-token", expiresIn: 900 },
      });
    });
    await page.route(/\/auth\/onboarding(?:\?|$)/, async (route) => {
      if (route.request().method() === "OPTIONS") {
        await fulfillCorsPreflight(route);
        return;
      }
      const body = route.request().postDataJSON() as { type: string };
      expect(body.type).toBe("creator");
      await route.fulfill({
        headers: corsHeaders(route),
        json: {
          accessToken: "creator-workos-access-token",
          csrfToken: "csrf-token",
          organizationId: "org_creator",
          organizationKind: "creator_workspace",
          user: {
            id: "user_signup",
            email: "signup@example.test",
            status: "active",
          },
        },
      });
    });

    await page.goto("/onboarding");

    await expect(page.getByRole("heading", { name: /choose your path/i })).toBeVisible();
    const hotelOption = page.getByRole("radio", { name: /hotel or property/i });
    const creatorOption = page.getByRole("radio", { name: /^creator/i });
    await expect(hotelOption).toBeVisible();
    await expect(creatorOption).toBeVisible();
    await creatorOption.click();
    await page.getByRole("button", { name: /continue setup/i }).click();
    await expect(page).toHaveURL(/\/profile\/complete$/);
  });
});
