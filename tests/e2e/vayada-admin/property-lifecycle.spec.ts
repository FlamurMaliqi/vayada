import { expect, test, type Route } from "@playwright/test";

import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

test("reviews impact and retires a property without destructive deletion", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "vayada-admin-property-lifecycle");
  const adminBaseURL = baseURL?.startsWith("http://127.0.0.1:3001")
    ? "http://localhost:3001"
    : (baseURL ?? "https://admin.localhost");
  const pageOrigin = new URL(adminBaseURL).origin;
  const propertyId = "11111111-1111-4111-8111-111111111111";
  let retirementRequest: Record<string, unknown> | null = null;

  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "e2e-platform-token");
    window.localStorage.setItem("token_expires_at", String(Date.now() + 60 * 60 * 1000));
    window.localStorage.setItem("isLoggedIn", "true");
    window.localStorage.setItem("userId", "user_platform_admin");
    window.localStorage.setItem("userEmail", "platform-admin@example.test");
    window.localStorage.setItem("userStatus", "active");
    window.localStorage.setItem("isSuperAdmin", "true");
    window.localStorage.setItem(
      "user",
      JSON.stringify({
        id: "user_platform_admin",
        email: "platform-admin@example.test",
        status: "active",
        is_superadmin: true,
      }),
    );
  });

  await page.route(
    /https:\/\/api\.localhost(?::\d+)?\/api\/platform\/admin\/growth(?:\?|$)/,
    (route) =>
      fulfillJson(route, pageOrigin, {
        properties: [
          {
            id: propertyId,
            name: "Hotel Lifecycle",
            slug: "hotel-lifecycle",
            status: "live",
            lifecycleStatus: "active",
            lifecycleRevision: 4,
            ownerAccountUserIds: [],
            createdAt: "2026-08-13T12:00:00.000Z",
          },
        ],
      }),
  );
  await page.route(
    /https:\/\/api\.localhost(?::\d+)?\/api\/identity\/admin\/users(?:\?|$)/,
    (route) => fulfillJson(route, pageOrigin, { users: [], total: 0 }),
  );
  await page.route(
    new RegExp(
      `https://api\\.localhost(?::\\d+)?/api/platform/admin/properties/${propertyId}/retirement-impact$`,
    ),
    (route) =>
      fulfillJson(route, pageOrigin, {
        contractVersion: "platform-property-lifecycle.v1",
        propertyId,
        lifecycleStatus: "active",
        lifecycleRevision: 4,
        organizations: { linked: 1 },
        entitlements: { active: 2, suspended: 0 },
        bookings: { total: 12, active: 0 },
        inventory: { roomTypes: 3, rooms: 9 },
        finance: {
          totalPayments: 7,
          unresolvedPayments: 0,
          totalPayouts: 3,
          openPayouts: 0,
          billingEntitlements: 1,
        },
        media: { objects: 6 },
        publicExposure: {
          marketplaceActive: true,
          distributionStatus: "public",
          bookingRevisionActive: true,
        },
        blockers: [],
        canRetire: true,
        hardDeletion: { allowed: false, reason: "hard_delete_not_supported" },
      }),
  );
  await page.route(
    new RegExp(
      `https://api\\.localhost(?::\\d+)?/api/platform/admin/properties/${propertyId}/retire$`,
    ),
    async (route) => {
      retirementRequest = route.request().postDataJSON() as Record<string, unknown>;
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      await fulfillJson(route, pageOrigin, {
        contractVersion: "platform-property-lifecycle.v1",
        propertyId,
        lifecycleStatus: "retired",
        lifecycleRevision: 5,
      });
    },
  );

  await page.goto(new URL("/dashboard/hotels", adminBaseURL).toString());
  await expect(page.getByRole("heading", { name: "Hotels" })).toBeVisible();
  await expect(page.getByText("Hotel Lifecycle")).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Retire" }).click();
  await expect(page.getByRole("heading", { name: "Retire Hotel Lifecycle" })).toBeVisible();
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  await page.getByLabel("Reason").fill("Property owner offboarded");
  await page.getByLabel("Type RETIRE to confirm").fill("RETIRE");
  await page.getByRole("button", { name: "Retire property" }).click();

  await expect(page.getByText("Retired", { exact: true })).toBeVisible();
  expect(retirementRequest).toEqual({
    expectedLifecycleRevision: 4,
    reason: "Property owner offboarded",
    confirmation: "RETIRE",
  });
  await assertNoLegacyCalls();
  await assertHealthy();
});

test("suppresses bound accounts and reuses the provisioning workflow after a lost response", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "vayada-admin-property-lifecycle");
  const adminBaseURL = baseURL?.startsWith("http://127.0.0.1:3001")
    ? "http://localhost:3001"
    : (baseURL ?? "https://admin.localhost");
  const pageOrigin = new URL(adminBaseURL).origin;
  const boundAccountId = "22222222-2222-4222-8222-222222222222";
  const newAccountId = "33333333-3333-4333-8333-333333333333";
  const requests: Record<string, unknown>[] = [];

  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "e2e-platform-token");
    window.localStorage.setItem("token_expires_at", String(Date.now() + 60 * 60 * 1000));
    window.localStorage.setItem("isLoggedIn", "true");
    window.localStorage.setItem("userId", "user_platform_admin");
    window.localStorage.setItem("userEmail", "platform-admin@example.test");
    window.localStorage.setItem("userStatus", "active");
    window.localStorage.setItem("isSuperAdmin", "true");
    window.localStorage.setItem(
      "user",
      JSON.stringify({ id: "user_platform_admin", status: "active", is_superadmin: true }),
    );
  });
  await page.route(
    /https:\/\/api\.localhost(?::\d+)?\/api\/platform\/admin\/growth(?:\?|$)/,
    (route) =>
      fulfillJson(route, pageOrigin, {
        properties: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Already Provisioned",
            slug: "already-provisioned",
            status: "live",
            lifecycleStatus: "active",
            lifecycleRevision: 1,
            ownerAccountUserIds: [boundAccountId],
            createdAt: "2026-08-13T12:00:00.000Z",
          },
        ],
      }),
  );
  await page.route(
    /https:\/\/api\.localhost(?::\d+)?\/api\/identity\/admin\/users(?:\?|$)/,
    (route) =>
      fulfillJson(route, pageOrigin, {
        users: [
          { id: boundAccountId, name: "Bound Owner", email: "bound@example.test" },
          { id: newAccountId, name: "New Hotel", email: "new@example.test" },
        ],
        total: 2,
      }),
  );
  await page.route(
    /https:\/\/api\.localhost(?::\d+)?\/api\/platform\/admin\/properties\/provision$/,
    async (route) => {
      requests.push(route.request().postDataJSON() as Record<string, unknown>);
      await fulfillJson(route, pageOrigin, { code: "upstream_timeout" }, 503);
    },
  );

  await page.goto(new URL("/dashboard/hotels", adminBaseURL).toString());
  await expect(page.getByText("Already Provisioned")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set Up" })).toHaveCount(1);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.getByRole("button", { name: "Set Up" }).click();
    await page.getByLabel("Street address").fill("1 Main Street");
    await page.getByLabel("Postal code").fill("10000");
    await page.getByLabel("City").fill("Athens");
    await page.getByLabel("Country code").fill("GR");
    await page.getByLabel("Operations phone").fill("+30123456789");
    await page.getByLabel("Provisioning reason").fill("Owner onboarding request");
    await page.getByRole("button", { name: "Provision property" }).click();
    if (attempt === 0) {
      await expect.poll(() => requests.length).toBe(1);
      await expect(page.getByRole("button", { name: "Provision property" })).toBeEnabled();
      await page.getByRole("button", { name: "Cancel" }).click();
    }
  }

  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map((request) => request["provisioningReference"])).toEqual([
    `platform-admin:account:${newAccountId}`,
    `platform-admin:account:${newAccountId}`,
  ]);
  await assertNoLegacyCalls();
});

test("fails closed when canonical property bindings cannot be loaded", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertNoLegacyCalls = watchNoLegacyCalls(page, testInfo, "vayada-admin-property-lifecycle");
  const adminBaseURL = baseURL?.startsWith("http://127.0.0.1:3001")
    ? "http://localhost:3001"
    : (baseURL ?? "https://admin.localhost");
  const pageOrigin = new URL(adminBaseURL).origin;
  let failPropertyReads = false;
  let failedPropertyReads = 0;

  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "e2e-platform-token");
    window.localStorage.setItem("token_expires_at", String(Date.now() + 60 * 60 * 1000));
    window.localStorage.setItem("isLoggedIn", "true");
    window.localStorage.setItem("userId", "user_platform_admin");
    window.localStorage.setItem("userStatus", "active");
    window.localStorage.setItem("isSuperAdmin", "true");
    window.localStorage.setItem(
      "user",
      JSON.stringify({ id: "user_platform_admin", status: "active", is_superadmin: true }),
    );
  });
  await page.route(
    /https:\/\/api\.localhost(?::\d+)?\/api\/platform\/admin\/growth(?:\?|$)/,
    (route) => {
      if (!failPropertyReads) return fulfillJson(route, pageOrigin, { properties: [] });
      failedPropertyReads += 1;
      return fulfillJson(route, pageOrigin, { code: "read_unavailable" }, 503);
    },
  );
  await page.route(
    /https:\/\/api\.localhost(?::\d+)?\/api\/identity\/admin\/users(?:\?|$)/,
    (route) =>
      fulfillJson(route, pageOrigin, {
        users: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            name: "Existing Owner",
            email: "existing@example.test",
          },
        ],
        total: 1,
      }),
  );

  await page.goto(new URL("/dashboard/hotels", adminBaseURL).toString());
  await expect(page.getByRole("button", { name: "Set Up" })).toHaveCount(1);
  failPropertyReads = true;
  await page.getByPlaceholder("Search by hotel name, location, owner...").fill("Existing");
  await expect(
    page.getByText(
      "Failed to load canonical property bindings. Provisioning is disabled until the read succeeds.",
    ),
  ).toBeVisible();
  expect(failedPropertyReads).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Set Up" })).toHaveCount(0);
  await assertNoLegacyCalls();
});

async function fulfillJson(route: Route, origin: string, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
