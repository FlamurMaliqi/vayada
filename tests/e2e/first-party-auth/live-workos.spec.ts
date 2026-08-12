import { expect, test } from "@playwright/test";
import { firstPartyAuthSurfaces } from "../support/firstPartyAuth";

const marketplace = firstPartyAuthSurfaces.find(({ key }) => key === "marketplace")!;

test("live WorkOS sandbox Google callback yields an app-local session", async ({ page }) => {
  test.skip(
    process.env.E2E_WORKOS_SANDBOX_GOOGLE !== "1",
    "Set E2E_WORKOS_SANDBOX_GOOGLE=1 and run headed against the local WorkOS stack.",
  );
  test.setTimeout(180_000);

  const callback = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.origin === marketplace.baseURL && url.pathname === "/auth/oauth/google/callback";
  });
  await page.goto(`${marketplace.baseURL}/login?returnTo=/marketplace`);
  await page.getByRole("button", { name: /continue with google/i }).click();
  const callbackRequest = await callback;
  expect(new URL(callbackRequest.url()).origin).toBe(marketplace.baseURL);
  await page.waitForURL(
    (url) => url.origin === marketplace.baseURL && url.pathname === "/marketplace",
  );
  const sessionStatus = await page.evaluate(
    async () =>
      (await fetch("/auth/session?surface=marketplace-web", { credentials: "include" })).status,
  );
  expect(sessionStatus).toBe(200);
});
