import { expect, test } from "@playwright/test";

const status = {
  terms_accepted: true,
  terms_accepted_at: "2026-09-01T00:00:00Z",
  terms_version: "1",
  privacy_accepted: true,
  privacy_accepted_at: "2026-09-01T00:00:00Z",
  privacy_version: "1",
  marketing_consent: false,
  marketing_consent_at: null,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({
        necessary: true,
        functional: false,
        analytics: false,
        marketing: false,
        pending: false,
      }),
    ),
  );
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      json: {
        accessToken: "privacy-test-token",
        csrfToken: "privacy-test-csrf",
        organizationKind: "creator_workspace",
        user: {
          id: "privacy-test-user",
          email: "privacy@example.test",
          name: "Privacy Test",
          status: "active",
        },
      },
    });
  });
});

test("direct privacy load and reload recover auth before a marketing update", async ({ page }) => {
  let marketing = false;
  let authorizedReads = 0;
  await page.route(/\/api\/identity\/consent\/(me|history)(?:\?|$)/, async (route) => {
    if (route.request().headers().authorization !== "Bearer privacy-test-token") {
      return route.fulfill({ status: 401, json: { detail: "A valid access token is required." } });
    }
    if (route.request().method() === "PUT") {
      marketing = route.request().postDataJSON().marketing_consent;
      return route.fulfill({
        json: {
          marketing_consent: marketing,
          marketing_consent_at: "2026-09-06T00:00:00Z",
          message: "Preferences saved",
        },
      });
    }
    authorizedReads++;
    return route.fulfill({
      json: route.request().url().includes("/history")
        ? {
            history: [
              {
                id: "history-1",
                consent_type: "marketing",
                consent_given: marketing,
                version: null,
                created_at: "2026-09-06T00:00:00Z",
              },
            ],
            total: 1,
          }
        : { ...status, marketing_consent: marketing },
    });
  });
  await page.goto("/settings/privacy");
  const toggle = page.getByRole("switch", { name: "Marketing communications", exact: true });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("heading", { name: "Recent Consent Changes" })).toBeVisible();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(marketing).toBe(true);
  expect(authorizedReads).toBeGreaterThanOrEqual(4);
});

test("unavailable account consent is unknown and cannot be toggled", async ({ page }) => {
  await page.route(/\/api\/identity\/consent\/(me|history)(?:\?|$)/, (route) =>
    route.fulfill({ status: 503, json: { detail: "Unavailable" } }),
  );
  await page.goto("/settings/privacy");
  await expect(
    page.getByText("Failed to load your consent settings. Please try again."),
  ).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(3);
  await expect(page.getByText("Not accepted", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Marketing communications" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage Cookies" })).toBeVisible();
});
