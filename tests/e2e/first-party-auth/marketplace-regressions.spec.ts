import { expect, test, type Route } from "@playwright/test";
import {
  authRequests,
  authSession,
  firstPartyAuthSurfaces,
  mockFirstPartyAuth,
  sessionCookieName,
} from "../support/firstPartyAuth";

const marketplace = firstPartyAuthSurfaces.find(({ key }) => key === "marketplace")!;

test("Marketplace signup reaches creator onboarding without csrf_rejected", async ({ page }) => {
  const guestSession = {
    accessToken: "access-marketplace-guest",
    csrfToken: "csrf-marketplace",
    user: {
      email: "marketplace-signup@example.test",
      id: "user-marketplace-signup",
      status: "active",
    },
  };
  const records = await mockFirstPartyAuth(page, marketplace, async (route, record) => {
    const pathname = new URL(record.url).pathname;
    if (pathname === "/auth/password/signup") {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": `${sessionCookieName(marketplace)}=sealed-marketplace; Path=/auth; HttpOnly; SameSite=Lax`,
        },
        json: guestSession,
      });
      return true;
    }
    if (pathname === "/auth/onboarding") {
      const session = authSession(marketplace, "creator");
      await route.fulfill({
        status: 200,
        json: {
          ...session,
          user: { ...session.user, email: "marketplace-signup@example.test" },
        },
      });
      return true;
    }
    return false;
  });
  await page.route("**/api/marketplace/creators/me**", async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "OPTIONS") {
      await fulfillCors(route);
      return;
    }
    if (url.pathname.endsWith("/platform-connections")) {
      await route.fulfill({ headers: corsHeaders(route), json: { connections: [] } });
      return;
    }
    await route.fulfill({
      headers: corsHeaders(route),
      json: {
        audienceSize: 0,
        createdAt: "2026-08-11T08:00:00.000Z",
        creatorProfileId: "creator-profile-auth-regression",
        creatorType: "travel",
        displayName: null,
        locationText: null,
        phone: null,
        platforms: [],
        portfolioUrl: null,
        profileComplete: false,
        profilePictureMediaObjectId: null,
        profilePictureUrl: null,
        profileStatus: "pending",
        rating: { averageRating: 0, totalReviews: 0 },
        shortDescription: null,
        updatedAt: "2026-08-11T08:00:00.000Z",
      },
    });
  });

  await page.goto(`${marketplace.baseURL}/signup`);
  await page.getByLabel(/email address/i).fill("marketplace-signup@example.test");
  await page.getByLabel(/^password$/i).fill("Regression123!");
  await page.getByRole("button", { name: /create account/i }).click();

  await expect(
    page.getByRole("heading", { name: "Welcome to Vayada — what brings you here?" }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /i’m a creator/i }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect.poll(() => authRequests(records, "/auth/onboarding").length).toBe(1);
  const onboarding = authRequests(records, "/auth/onboarding")[0]!;
  expect(onboarding.body).toEqual({ surface: "marketplace-web", type: "creator" });
  expect(onboarding.csrf).toBe("csrf-marketplace");
  expect(onboarding.cookie).toContain(`${sessionCookieName(marketplace)}=sealed-marketplace`);
  await expect(page.getByText("csrf_rejected", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Email address")).toHaveValue("marketplace-signup@example.test");
  await expect(page.getByRole("button", { name: "Upload profile photo" })).toBeVisible();
  for (const request of records) expect(new URL(request.url).origin).toBe(marketplace.baseURL);
});

for (const flow of ["login", "signup"] as const) {
  test(`Marketplace Google ${flow} keeps OAuth state on the app-local callback`, async ({
    page,
  }) => {
    const providerOrigin = "https://workos-sandbox.example";
    const state = `state-${flow}`;
    let returnTo = "";
    let callbackCookie = "";
    const records = await mockFirstPartyAuth(page, marketplace, async (route, record) => {
      const url = new URL(record.url);
      if (url.pathname === "/auth/oauth/google/start") {
        expect(url.searchParams.get("flow")).toBe(flow);
        expect(url.searchParams.get("surface")).toBe("marketplace-web");
        returnTo = url.searchParams.get("return_to") ?? "";
        const providerURL = new URL("/authorize", providerOrigin);
        providerURL.searchParams.set(
          "redirect_uri",
          `${marketplace.baseURL}/auth/oauth/google/callback`,
        );
        expect(providerURL.searchParams.get("redirect_uri")).toBe(
          `${marketplace.baseURL}/auth/oauth/google/callback`,
        );
        providerURL.searchParams.set("state", state);
        const callbackURL = new URL(providerURL.searchParams.get("redirect_uri")!);
        callbackURL.searchParams.set("code", "sandbox-code");
        callbackURL.searchParams.set("state", state);
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          headers: {
            "set-cookie": `vayada_fp_oauth_state=${state}; Path=/auth/oauth; HttpOnly; SameSite=Lax`,
          },
          body: `<!doctype html><script>window.location.replace(${JSON.stringify(callbackURL.toString())})</script>`,
        });
        return true;
      }
      return false;
    });
    await page.route(
      (url) => {
        return url.origin === marketplace.baseURL && url.pathname === "/auth/oauth/google/callback";
      },
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        callbackCookie = request.headers().cookie ?? "";
        expect(url.searchParams.get("state")).toBe(state);
        await route.fulfill({
          status: 302,
          headers: {
            location: returnTo,
            "set-cookie": `${sessionCookieName(marketplace)}=sealed-google-${flow}; Path=/auth; HttpOnly; SameSite=Lax`,
          },
        });
      },
    );
    const finalPath = flow === "login" ? "/handoff" : "/onboarding";
    const entryURL = new URL(flow === "login" ? "/login" : "/signup", marketplace.baseURL);
    if (flow === "login") entryURL.searchParams.set("returnTo", finalPath);
    await page.goto(entryURL.toString());
    await page.getByRole("button", { name: /continue with google/i }).click();

    await expect.poll(() => callbackCookie).toContain(`vayada_fp_oauth_state=${state}`);
    await expect
      .poll(() => authRequests(records, "/auth/session").length)
      .toBeGreaterThanOrEqual(1);
    const sessionRequest = authRequests(records, "/auth/session").find((request) =>
      request.cookie?.includes(`${sessionCookieName(marketplace)}=sealed-google-${flow}`),
    );
    expect(sessionRequest).toBeDefined();
    expect(new URL(sessionRequest!.url).origin).toBe(marketplace.baseURL);
    await expect(page.getByText("missing_session", { exact: true })).toHaveCount(0);
  });
}

function corsHeaders(route: Route): Record<string, string> {
  return {
    "access-control-allow-credentials": "true",
    "access-control-allow-origin": route.request().headers().origin ?? "*",
    "content-type": "application/json",
  };
}

async function fulfillCors(route: Route): Promise<void> {
  await route.fulfill({
    status: 204,
    headers: {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
      "access-control-allow-origin": route.request().headers().origin ?? "*",
    },
  });
}
