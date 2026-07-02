import { expect, test } from "@playwright/test";
import { mockPmsWebAuthenticatedSession, mockPmsWebTargetRoutes } from "../support/pmsWebMocks";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

test.describe("pms-web smoke", () => {
  test("login page redirects to hosted auth", async ({ request }) => {
    const response = await request.get("/login", { maxRedirects: 0 });

    expect(response.status()).toBe(307);

    const hostedLoginUrl = new URL(response.headers().location ?? "");
    expect(hostedLoginUrl.pathname).toBe("/auth/workos/login");
    expect(hostedLoginUrl.searchParams.get("surface")).toBe("pms-web");

    const returnTo = new URL(hostedLoginUrl.searchParams.get("return_to") ?? "");
    expect(returnTo.pathname).toBe("/login");
    expect(returnTo.searchParams.get("auth")).toBe("callback");
    expect(returnTo.searchParams.get("returnTo")).toBe("/dashboard");
  });

  test("@signup register redirects to hosted AuthKit signup", async ({ request }) => {
    const response = await request.get("/register", { maxRedirects: 0 });

    expect(response.status()).toBe(307);
    const hostedSignupUrl = new URL(response.headers().location ?? "");
    expect(hostedSignupUrl.pathname).toBe("/auth/workos/signup");
    expect(hostedSignupUrl.searchParams.get("surface")).toBe("pms-web");
    expect(hostedSignupUrl.searchParams.get("intent")).toBe("hotel");
    expect(hostedSignupUrl.pathname).not.toBe("/auth/register");
    expect(hostedSignupUrl.pathname).not.toBe("/auth/login");

    const returnTo = new URL(hostedSignupUrl.searchParams.get("return_to") ?? "");
    expect(returnTo.pathname).toBe("/login");
    expect(returnTo.searchParams.get("auth")).toBe("callback");
    expect(returnTo.searchParams.get("returnTo")).toBe("/dashboard");
  });

  test("loads migrated PMS operations surfaces without legacy helper calls", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "pms-web-operations");

    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);

    await page.goto("/rooms");
    await expect(page.getByRole("heading", { name: /rooms/i })).toBeVisible();
    await expect(page.getByText("Alpine Suite").first()).toBeVisible();

    await page.goto("/calendar");
    await expect(page.getByRole("heading", { name: /calendar/i })).toBeVisible();
    await expect(page.getByText("Alpine Suite").first()).toBeVisible();

    await page.goto("/channel-manager");
    await expect(page.getByRole("heading", { level: 1, name: /channel/i })).toBeVisible();

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: /settings/i })).toBeVisible();

    await page.goto("/bookings");
    await expect(page.getByRole("heading", { name: /reservation|booking/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /Ada Lovelace/ }).first()).toBeVisible();

    await assertNoLegacyCalls();
    await assertHealthy();
  });
});
