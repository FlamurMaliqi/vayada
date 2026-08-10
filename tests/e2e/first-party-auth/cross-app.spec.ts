import { expect, test, type Route } from "@playwright/test";
import {
  authRequests,
  firstPartyAuthSurfaces,
  mockFirstPartyAuth,
  sessionCookieName,
} from "../support/firstPartyAuth";

const marketplace = firstPartyAuthSurfaces.find(({ key }) => key === "marketplace")!;
const pms = firstPartyAuthSurfaces.find(({ key }) => key === "pms")!;
const handoffCode = "7_8FkqvJvK_vOS5Ke4iFAScHY6LmDsQUviRLKfS1dCk";

test("cross-app handoff replaces a stale target cookie without sending the source cookie", async ({
  page,
}) => {
  const destination = `${pms.baseURL}/handoff#code=${handoffCode}`;
  const sourceRecords = await mockFirstPartyAuth(page, marketplace, async (route, record) => {
    if (new URL(record.url).pathname !== "/auth/handoff/create") return false;
    await route.fulfill({ status: 201, json: { destination } });
    return true;
  });
  await page.route(`${marketplace.baseURL}/handoff**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body data-source-e2e="complete">Source</body>',
    }),
  );

  await page.goto(`${marketplace.baseURL}/login?returnTo=/handoff`);
  await page.getByLabel(/email address/i).fill("marketplace@example.test");
  await page.getByLabel(/^password$/i).fill("Regression123!");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect.poll(() => authRequests(sourceRecords, "/auth/password/login").length).toBe(1);
  await expect(page.locator('[data-source-e2e="complete"]')).toBeVisible();

  const createdDestination = await page.evaluate(
    async ({ csrf, target }) => {
      const response = await fetch("/auth/handoff/create", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-vayada-csrf": csrf },
        body: JSON.stringify({
          routingHints: { propertyId: "property-e2e" },
          sourceSurface: "marketplace-web",
          targetPath: "/setup?entryProduct=pms",
          targetSurface: target,
        }),
      });
      return (await response.json()).destination as string;
    },
    { csrf: "csrf-marketplace", target: "pms-web" },
  );
  expect(createdDestination).toBe(destination);

  await page.context().addCookies([
    {
      domain: new URL(pms.baseURL).hostname,
      path: "/auth",
      name: sessionCookieName(pms),
      value: "stale-pms-session",
      httpOnly: true,
      sameSite: "Lax",
      secure: pms.baseURL.startsWith("https:"),
    },
  ]);
  const targetRecords = await mockFirstPartyAuth(page, pms, async (route, record) => {
    if (new URL(record.url).pathname !== "/auth/handoff/redeem") return false;
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": `${sessionCookieName(pms)}=sealed-pms; Path=/auth; HttpOnly; SameSite=Lax`,
      },
      json: { routingHints: { propertyId: "property-e2e" }, targetPath: "/setup?entryProduct=pms" },
    });
    return true;
  });
  const productRequests: string[] = [];
  await page.route("**/api/hotel-setup/status**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCors(route);
      return;
    }
    productRequests.push(route.request().url());
    await route.fulfill({
      status: 503,
      headers: corsHeaders(route),
      json: { error: "deliberate_handoff_fallback" },
    });
  });
  await page.route(`${pms.baseURL}/setup**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><body data-handoff-e2e="complete">complete</body>',
    }),
  );

  await page.goto(createdDestination);
  await expect(page.locator('[data-handoff-e2e="complete"]')).toBeVisible();
  expect(page.url()).not.toContain(handoffCode);

  const create = authRequests(sourceRecords, "/auth/handoff/create")[0]!;
  expect(create.csrf).toBe("csrf-marketplace");
  expect(create.cookie).toContain(`${sessionCookieName(marketplace)}=sealed-marketplace`);
  expect(create.body).toMatchObject({
    sourceSurface: "marketplace-web",
    targetSurface: "pms-web",
  });
  const redeem = authRequests(targetRecords, "/auth/handoff/redeem")[0]!;
  expect(redeem.cookie).toContain(`${sessionCookieName(pms)}=stale-pms-session`);
  expect(redeem.cookie).not.toContain("sealed-marketplace");
  expect(redeem.body).toEqual({ code: handoffCode, targetSurface: "pms-web" });
  expect(authRequests(targetRecords, "/auth/handoff/redeem")).toHaveLength(1);

  const sourceCookie = await page.context().cookies(`${marketplace.baseURL}/auth/session`);
  const targetCookie = await page.context().cookies(`${pms.baseURL}/auth/session`);
  expect(sourceCookie.find(({ name }) => name === sessionCookieName(marketplace))?.value).toBe(
    "sealed-marketplace",
  );
  expect(targetCookie.find(({ name }) => name === sessionCookieName(pms))?.value).toBe(
    "sealed-pms",
  );
  expect(productRequests).toHaveLength(1);
  expect(new URL(productRequests[0]!).pathname).toMatch(/^\/api\//);
  expect(new URL(productRequests[0]!).origin).not.toBe(pms.baseURL);
});

test("a terminal stale session clears its first-party cookie", async ({ page }) => {
  await page.context().addCookies([
    {
      domain: new URL(pms.baseURL).hostname,
      path: "/auth",
      name: sessionCookieName(pms),
      value: "stale-pms-session",
      httpOnly: true,
      sameSite: "Lax",
      secure: pms.baseURL.startsWith("https:"),
    },
  ]);
  const records = await mockFirstPartyAuth(page, pms, async (route, record) => {
    if (new URL(record.url).pathname !== "/auth/session") return false;
    await route.fulfill({
      status: 401,
      headers: {
        "content-type": "application/json",
        "set-cookie": `${sessionCookieName(pms)}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      },
      json: { error: "missing_session" },
    });
    return true;
  });

  await page.goto(`${pms.baseURL}/login`);
  const result = await page.evaluate(async () => {
    const response = await fetch("/auth/session?surface=pms-web", { credentials: "include" });
    return { body: await response.json(), status: response.status };
  });

  expect(result).toEqual({ body: { error: "missing_session" }, status: 401 });
  expect(authRequests(records, "/auth/session")[0]!.cookie).toContain(
    `${sessionCookieName(pms)}=stale-pms-session`,
  );
  const cookies = await page.context().cookies(`${pms.baseURL}/auth/session`);
  expect(cookies.map(({ name }) => name)).not.toContain(sessionCookieName(pms));
});

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
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-origin": route.request().headers().origin ?? "*",
    },
  });
}
