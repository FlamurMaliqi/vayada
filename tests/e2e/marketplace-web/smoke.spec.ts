import { expect, test, type Route } from "@playwright/test";

test.describe("marketplace-web smoke", () => {
  test("login page renders the custom auth form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: /sign in to vayada/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test("@signup unified signup renders the custom form", async ({ page }) => {
    await page.goto("/signup");

    await expect(page.getByRole("heading", { name: /create your vayada account/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
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

    await expect(page.getByRole("heading", { name: /set up your workspace/i })).toBeVisible();
    const hotelOption = page.getByRole("button").filter({ hasText: /^Hotel \/ property/ });
    const creatorOption = page.getByRole("button").filter({ hasText: /^Creator/ });
    await expect(hotelOption).toBeVisible();
    await expect(creatorOption).toBeVisible();
    await creatorOption.click();
    await page.getByRole("button", { name: /^continue$/i }).click();
    await expect(page).toHaveURL(/\/profile\/complete$/);
  });
});

function corsHeaders(route: Route) {
  const origin = route.request().headers().origin ?? "http://localhost:3000";
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, x-vayada-csrf",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-origin": origin,
    "content-type": "application/json",
  };
}

async function fulfillCorsPreflight(route: Route) {
  await route.fulfill({
    status: 204,
    headers: corsHeaders(route),
  });
}
