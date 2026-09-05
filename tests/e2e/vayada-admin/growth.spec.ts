import { expect, test } from "@playwright/test";
import { mockFirstPartyAuth } from "../support/firstPartyAuth";

test("growth filters both charts, clears to totals, and ignores stale responses", async ({
  page,
  baseURL,
}) => {
  await mockFirstPartyAuth(page, {
    baseURL: baseURL!,
    key: "admin",
    label: "Vayada Admin",
    surface: "platform-admin",
  });
  await page.addInitScript(() => {
    localStorage.setItem("access_token", "e2e-platform-token");
    localStorage.setItem("token_expires_at", String(Date.now() + 3600000));
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem("isSuperAdmin", "true");
    localStorage.setItem(
      "user",
      JSON.stringify({
        id: "admin",
        email: "admin@example.test",
        status: "active",
        is_superadmin: true,
      }),
    );
  });
  let release: (() => void) | undefined;
  let delay = false;
  let fail = false;
  const seen: string[] = [];
  await page.route(/\/api\/platform\/admin\/growth\?/, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const id = query.get("booking_property_id") || "";
    seen.push(query.get("granularity")!);
    if (delay && id === "a")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (fail) {
      await route.fulfill({
        status: 500,
        json: { message: "Growth unavailable" },
        headers: {
          "access-control-allow-origin": new URL(baseURL!).origin,
          "access-control-allow-credentials": "true",
        },
      });
      return;
    }
    const views = id === "a" ? 10 : id === "empty" ? 0 : 30;
    const requests = views / 10;
    await route.fulfill({
      json: {
        properties: ["a", "b", "empty"].map((id) => ({ id, name: id, slug: id, status: "live" })),
        selectedPropertyIds: ["a", "b", "empty"],
        bookingPropertyId: id || null,
        excludeTestData: true,
        granularity: query.get("granularity"),
        metrics: [
          { key: "page_views", label: "Page views", value: String(views) },
          { key: "booking_requests", label: "Booking requests", value: String(requests) },
        ],
        pageViews: [{ key: "today", label: "Today", value: views }],
        bookingRequests: [{ key: "today", label: "Today", value: requests }],
        liveProperties: [],
        emptyMessage: null,
      },
      headers: {
        "access-control-allow-origin": new URL(baseURL!).origin,
        "access-control-allow-credentials": "true",
      },
    });
  });
  await page.goto("/dashboard/kpis");
  const views = page.getByRole("img", { name: "Number of views" });
  const requests = page.getByRole("img", { name: "Number of requests" });
  await expect(views.locator("circle title")).toHaveText("Today: 30");
  const selector = page.getByLabel("Dashboard property");
  await selector.selectOption("a");
  await expect(views.locator("circle title")).toHaveText("Today: 10");
  await expect(requests.locator("[title]")).toHaveAttribute("title", "Today: 1");
  for (const granularity of ["daily", "monthly", "weekly"]) {
    await page.getByRole("button", { name: granularity, exact: true }).click();
    await expect.poll(() => seen.at(-1)).toBe(granularity);
    await expect(views).toBeVisible();
  }
  delay = true;
  await selector.selectOption("empty");
  await expect(views.locator("circle title")).toHaveText("Today: 0");
  await expect(requests.locator("[title]")).toHaveAttribute("style", "height: 0%;");
  await selector.selectOption("a");
  await expect(page.getByRole("status")).toHaveCount(2);
  await expect(views).toHaveCount(0);
  await selector.selectOption("");
  await expect(views.locator("circle title")).toHaveText("Today: 30");
  const staleResponse = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("booking_property_id") === "a",
  );
  release?.();
  await staleResponse;
  await expect(views.locator("circle title")).toHaveText("Today: 30");
  fail = true;
  await selector.selectOption("b");
  await expect(page.getByText("Growth unavailable", { exact: true })).toBeVisible();
  await expect(page.locator("article").getByText("—", { exact: true })).toHaveCount(2);
  await expect(views).toHaveCount(0);
});
