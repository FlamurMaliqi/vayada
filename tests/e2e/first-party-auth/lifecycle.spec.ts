import { expect, test } from "@playwright/test";
import {
  authRequests,
  firstPartyAuthSurfaces,
  mockFirstPartyAuth,
  sessionCookieName,
} from "../support/firstPartyAuth";

for (const surface of firstPartyAuthSurfaces) {
  test(`${surface.label} keeps login, session, refresh, and logout first-party`, async ({
    page,
  }) => {
    const successPath =
      surface.key === "affiliate" || surface.key === "admin" ? "/dashboard" : "/handoff";
    await page.route(`${surface.baseURL}${successPath}**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><body data-auth-e2e="complete">complete</body>',
      }),
    );
    const records = await mockFirstPartyAuth(page, surface);
    const loginURL = new URL("/login", surface.baseURL);
    if (successPath === "/handoff") loginURL.searchParams.set("returnTo", successPath);

    await page.goto(loginURL.toString());
    await page.getByLabel(/email address/i).fill(`${surface.key}@example.test`);
    await page.getByLabel(/^password$/i).fill("Regression123!");
    await page.getByRole("button", { name: /sign in/i }).click();

    await expect.poll(() => authRequests(records, "/auth/password/login").length).toBe(1);
    const login = authRequests(records, "/auth/password/login")[0]!;
    expect(login.method).toBe("POST");
    expect(login.body).toMatchObject({
      email: `${surface.key}@example.test`,
      surface: surface.surface,
    });
    expect(new URL(login.url).origin).toBe(surface.baseURL);

    await expect(page.locator('[data-auth-e2e="complete"]')).toBeVisible();
    const cookieAfterLogin = await page.context().cookies(`${surface.baseURL}/auth/session`);
    expect(cookieAfterLogin.map((cookie) => cookie.name)).toContain(sessionCookieName(surface));
    expect(
      cookieAfterLogin.find((cookie) => cookie.name === sessionCookieName(surface)),
    ).toMatchObject({
      httpOnly: true,
      path: "/auth",
      sameSite: "Lax",
      secure: surface.baseURL.startsWith("https:"),
    });

    const statuses = await page.evaluate(
      async ({ csrf, surfaceName }) => {
        const session = await fetch(`/auth/session?surface=${encodeURIComponent(surfaceName)}`, {
          credentials: "include",
        });
        const refresh = await fetch("/auth/session/refresh", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "x-vayada-csrf": csrf },
          body: JSON.stringify({ surface: surfaceName }),
        });
        const logout = await fetch("/auth/logout", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", "x-vayada-csrf": csrf },
          body: JSON.stringify({ surface: surfaceName }),
        });
        return [session.status, refresh.status, logout.status];
      },
      { csrf: `csrf-${surface.key}`, surfaceName: surface.surface },
    );

    expect(statuses).toEqual([200, 200, 200]);
    expect(authRequests(records, "/auth/session/refresh")[0]).toMatchObject({
      cookie: expect.stringContaining(`${sessionCookieName(surface)}=sealed-${surface.key}`),
      csrf: `csrf-${surface.key}`,
    });
    expect(authRequests(records, "/auth/logout")[0]).toMatchObject({
      cookie: expect.stringContaining(`${sessionCookieName(surface)}=sealed-${surface.key}`),
      csrf: `csrf-${surface.key}`,
    });

    const cookieAfterLogout = await page.context().cookies(`${surface.baseURL}/auth/session`);
    expect(cookieAfterLogout.map((cookie) => cookie.name)).not.toContain(
      sessionCookieName(surface),
    );
    for (const request of records) expect(new URL(request.url).origin).toBe(surface.baseURL);
  });
}

for (const surface of firstPartyAuthSurfaces.filter(({ key }) =>
  ["marketplace", "bookingAdmin", "pms"].includes(key),
)) {
  test(`${surface.label} keeps signup and recovery endpoints first-party`, async ({ page }) => {
    const records = await mockFirstPartyAuth(page, surface);
    await page.route("**/api/hotel-setup/status**", async (route) => {
      const origin = route.request().headers().origin ?? "*";
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-credentials": "true",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-origin": origin,
          },
        });
        return;
      }
      await route.fulfill({
        status: 503,
        headers: {
          "access-control-allow-credentials": "true",
          "access-control-allow-origin": origin,
          "content-type": "application/json",
        },
        json: { error: "deliberate_signup_guard_failure" },
      });
    });
    await page.route(`${surface.baseURL}/onboarding**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><body data-signup-e2e="complete">Onboarding</body>',
      }),
    );
    await page.route(`${surface.baseURL}/setup**`, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><body data-signup-e2e="complete">Setup</body>',
      }),
    );

    await page.goto(`${surface.baseURL}/signup`);
    await page.getByLabel(/email address/i).fill(`${surface.key}-signup@example.test`);
    await page.getByLabel(/^password$/i).fill("Regression123!");
    await page.getByRole("button", { name: /create account/i }).click();
    await expect.poll(() => authRequests(records, "/auth/password/signup").length).toBe(1);
    expect(authRequests(records, "/auth/password/signup")[0]!.body).toMatchObject({
      email: `${surface.key}-signup@example.test`,
      surface: surface.surface,
    });
    if (surface.key === "marketplace") {
      await expect(page.locator('[data-signup-e2e="complete"]')).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: /create account/i })).toBeEnabled();
    }

    const endpoints = ["/auth/password/reset/request", "/auth/password/reset/confirm"];
    if (surface.key === "marketplace" || surface.key === "pms") {
      endpoints.push("/auth/email-verification/confirm", "/auth/email-verification/resend");
    }
    const statuses = await page.evaluate(
      async (paths) =>
        Promise.all(
          paths.map(
            async (path) =>
              (
                await fetch(path, {
                  method: "POST",
                  credentials: "include",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ email: "recovery@example.test", token: "token-e2e" }),
                })
              ).status,
          ),
        ),
      endpoints,
    );
    expect(statuses).toEqual(endpoints.map(() => 200));
    for (const request of records) expect(new URL(request.url).origin).toBe(surface.baseURL);
  });
}
