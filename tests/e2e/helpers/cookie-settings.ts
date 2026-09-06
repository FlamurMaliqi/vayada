import { expect, test } from "@playwright/test";

export function cookieSettingsTests(path: string, privacyHref: string) {
  test.beforeEach(async ({ page }) => {
    await page.route(/\/api\/identity\/consent\/cookies(?:\?|$)/, (route) =>
      route.fulfill({
        json: route.request().method() === "POST" ? route.request().postDataJSON() : null,
      }),
    );
  });

  test("keyboard settings discard drafts, trap focus, and reopen publicly", async ({ page }) => {
    await page.goto(path);
    const customize = page.getByRole("button", { name: "Customize", exact: true });
    await customize.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Cookie Settings", exact: true });
    const close = dialog.getByRole("button", { name: "Close cookie settings", exact: true });
    await expect(close).toBeFocused();
    await expect(dialog.getByRole("switch", { name: "Necessary", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("link")).toHaveAttribute("href", privacyHref);
    await dialog.getByRole("switch", { name: "Analytics", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(customize).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("switch", { name: "Analytics", exact: true })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Accept All", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await dialog.getByRole("button", { name: "Accept All", exact: true }).click();
    const reopen = page.getByRole("button", { name: "Cookie settings", exact: true });
    await expect(reopen).toBeFocused();
    await reopen.click();
    await expect(dialog.getByRole("switch", { name: "Analytics", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await dialog.getByRole("button", { name: "Necessary Only", exact: true }).click();
    await page.reload();
    await reopen.click();
    await expect(dialog.getByRole("switch", { name: "Analytics", exact: true })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await close.click();
    await expect(reopen).toBeFocused();
  });

  for (const stored of ["{bad", JSON.stringify({ necessary: true, analytics: "false" })]) {
    test(`invalid stored choice recovers: ${stored}`, async ({ page }) => {
      await page.addInitScript(
        (value) => localStorage.setItem("vayada_cookie_consent", value),
        stored,
      );
      await page.goto(path);
      await page.getByRole("button", { name: "Customize", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Cookie Settings", exact: true });
      for (const name of ["Functional", "Analytics", "Marketing"]) {
        await expect(dialog.getByRole("switch", { name, exact: true })).toHaveAttribute(
          "aria-checked",
          "false",
        );
      }
    });
  }
}
