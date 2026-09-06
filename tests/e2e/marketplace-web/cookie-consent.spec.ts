import { expect, test, type Page } from "@playwright/test";

const key = "vayada_cookie_consent";
const cookies = /\/api\/identity\/consent\/cookies(?:\?|$)/;
const all = { necessary: true, functional: true, analytics: true, marketing: true };
const necessary = { necessary: true, functional: false, analytics: false, marketing: false };

async function seed(page: Page, value: string) {
  await page.addInitScript(
    ({ key, value }) => {
      // Seed once so reload tests exercise the state written by the actual app.
      if (!sessionStorage.getItem("consent-test-seeded")) {
        localStorage.setItem(key, value);
        sessionStorage.setItem("consent-test-seeded", "true");
      }
    },
    { key, value },
  );
}

async function stored(page: Page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), key);
}

test.beforeEach(async ({ page }) => {
  // Keep the account shell deterministic; no real account or backend is used.
  await page.route(/\/auth\/session(?:\/refresh)?(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        accessToken: "cookie-test-token",
        organizationKind: "creator_workspace",
        user: {
          id: "cookie-test-user",
          email: "cookie@example.test",
          name: "Cookie Test",
          status: "active",
        },
      },
    }),
  );
  await page.route(/\/api\/identity\/consent\/(me|history)/, (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: "{}",
    }),
  );
});

test("failed withdrawal survives reload and syncs on recovery", async ({ page }) => {
  let fail = true;
  let remote = all;
  await seed(page, JSON.stringify({ ...all, pending: false }));
  await page.route(cookies, async (route) => {
    if (route.request().method() === "POST") {
      if (fail) return route.fulfill({ status: 503, body: "{}" });
      remote = route.request().postDataJSON();
    }
    await route.fulfill({ json: remote });
  });
  await page.goto("/settings/privacy");
  await page.getByRole("button", { name: "Manage Cookies", exact: true }).click();
  await page.getByRole("button", { name: "Necessary Only", exact: true }).click();
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: true });
  expect(remote.analytics).toBe(true);
  await page.reload();
  await expect(page.getByText(/Necessary: On \| Functional: Off \| Analytics: Off/)).toBeVisible();
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: true });
  fail = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: false });
  expect(remote).toMatchObject(necessary);
  await page.reload();
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: false });
});

test("failed first save retries on the timer without a prior backend record", async ({ page }) => {
  let fail = true;
  let remote: unknown = null;
  await page.clock.install();
  await page.route(cookies, async (route) => {
    if (route.request().method() === "POST") {
      if (fail) return route.fulfill({ status: 503, body: "{}" });
      remote = route.request().postDataJSON();
    }
    await route.fulfill({ json: remote });
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "Necessary only", exact: true }).click();
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: true });
  expect(remote).toBeNull();
  await page.reload();
  await expect(page.getByRole("button", { name: "Customize", exact: true })).toBeHidden();
  fail = false;
  await page.clock.runFor(15_001);
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: false });
  expect(remote).toMatchObject(necessary);
});

test("legacy local choices are synced once rather than replaced by the server", async ({
  page,
}) => {
  let posts = 0;
  await seed(page, JSON.stringify(necessary));
  await page.route(cookies, (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: all });
    posts++;
    return route.fulfill({ json: route.request().postDataJSON() });
  });
  await page.goto("/login");
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: false });
  expect(posts).toBe(1);
  await page.reload();
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: false });
  expect(posts).toBe(1);
});

test("a stale initial read cannot replace a choice made while it was pending", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(cookies, async (route) => {
    if (route.request().method() === "GET") {
      await gate;
      return route.fulfill({ json: all });
    }
    await route.fulfill({ json: route.request().postDataJSON() });
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "Necessary only", exact: true }).click();
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: false });
  const read = page.waitForResponse((r) => cookies.test(r.url()) && r.request().method() === "GET");
  release();
  await read;
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: false });
  await expect(page.getByRole("button", { name: "Customize", exact: true })).toBeHidden();
});

test("an older save cannot acknowledge a newer failed withdrawal", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let posts = 0;
  let fail = true;
  await seed(page, JSON.stringify({ ...all, pending: false }));
  await page.route(cookies, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: all });
    posts++;
    const choice = route.request().postDataJSON();
    if (posts === 1) await gate;
    else if (fail) return route.fulfill({ status: 503, body: "{}" });
    await route.fulfill({ json: choice });
  });
  await page.goto("/settings/privacy");
  const manage = page.getByRole("button", { name: "Manage Cookies", exact: true });
  await manage.click();
  await page.getByRole("button", { name: "Accept All", exact: true }).click();
  await expect.poll(() => posts).toBe(1);
  await manage.click();
  await page.getByRole("button", { name: "Necessary Only", exact: true }).click();
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: true });
  expect(posts).toBe(1);
  release();
  await expect.poll(() => posts).toBe(2);
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: true });
  fail = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: false });
});

test("hung reads leave the banner usable and hung saves remain retryable", async ({ page }) => {
  test.setTimeout(40_000);
  const failed: string[] = [];
  page.on("requestfailed", (request) => {
    if (cookies.test(request.url())) failed.push(request.method());
  });
  await page.route(cookies, async () => {});
  await page.goto("/login");
  await page.getByRole("button", { name: "Necessary only", exact: true }).click();
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: true });
  await expect
    .poll(() => failed, { timeout: 15_000 })
    .toEqual(expect.arrayContaining(["GET", "POST"]));
  await page.unroute(cookies);
  await page.route(cookies, (route) => route.fulfill({ json: route.request().postDataJSON() }));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: false });
});

for (const invalid of ["{bad", "{}", JSON.stringify({ ...all, analytics: "false" })]) {
  test(`invalid storage requires a new choice: ${invalid}`, async ({ page }) => {
    await seed(page, invalid);
    await page.route(cookies, (route) => route.fulfill({ json: all }));
    await page.goto("/login");
    await page.getByRole("button", { name: "Customize", exact: true }).click();
    await expect(page.getByRole("switch").nth(2)).toHaveAttribute("aria-checked", "false");
    await page.getByRole("button", { name: "Necessary Only", exact: true }).click();
    // A mismatched acknowledgement must also leave the choice pending.
    await expect.poll(() => stored(page)).toEqual({ ...necessary, pending: true });
  });
}
