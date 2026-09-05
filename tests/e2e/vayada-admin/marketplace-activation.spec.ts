import { expect, test, type Page, type Route } from "@playwright/test";
import { mockFirstPartyAuth } from "../support/firstPartyAuth";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";

const userId = "95500000-0000-4000-8000-000000000001";
const orgId = "95500000-0000-4000-8000-000000000002";
const berlin = "95500000-0000-4000-8000-000000000003";
const munich = "95500000-0000-4000-8000-000000000004";

test("enables an Operations account, selects Munich, and saves a private draft", async ({
  page,
  baseURL,
}, testInfo) => {
  const origin = new URL(baseURL!).origin;
  const noLegacy = watchNoLegacyCalls(page, testInfo, "vayada-admin-marketplace-preview");
  await mockAdminAuth(page, baseURL!);
  await authenticateAdmin(page);
  let enabled = false;
  let publications = 0;
  const drafts: Array<Record<string, unknown>> = [];
  const setup = () => ({
    trackRevision: enabled ? 2 : 1,
    selectedTracks: enabled ? ["hotel_operations", "creator_marketplace"] : ["hotel_operations"],
    tracks: [
      { track: "hotel_operations", provisioning: "active", components: [], allowedActions: [] },
      {
        track: "creator_marketplace",
        provisioning: enabled ? "active" : "not_selected",
        components: [],
        allowedActions: [],
      },
    ],
  });
  await page.route(/\/api\/identity\/admin\/users\/955[^/?]+$/, async (route) => {
    if (await fulfillPreflight(route, origin)) return;
    await fulfillJson(route, origin, {
      id: userId,
      email: "hotel@example.test",
      name: "Hotel Group",
      type: "hotel",
      status: "verified",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      profile: null,
    });
  });
  await page.route(/\/marketplace-accounts(?:\/[^/]+\/activate)?$/, async (route) => {
    if (await fulfillPreflight(route, origin)) return;
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({
        expectedRevision: 1,
        selectedTracks: ["hotel_operations", "creator_marketplace"],
      });
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      enabled = true;
      await fulfillJson(route, origin, setup());
      return;
    }
    await fulfillJson(route, origin, {
      canActivate: true,
      accounts: [
        {
          organizationId: orgId,
          displayName: "Hotel Group",
          setup: setup(),
          properties: [
            { propertyId: berlin, displayName: "Hotel Berlin" },
            { propertyId: munich, displayName: "Hotel Munich" },
          ],
        },
        {
          organizationId: "95500000-0000-4000-8000-000000000006",
          displayName: "Other Group",
          setup: setup(),
          properties: [],
        },
      ],
    });
  });
  await page.route(
    /\/api\/marketplace\/admin\/users\/955[^/]+\/(?:review|offers(?:\/[^/]+\/verify)?)(?:\?.*)?$/,
    async (route) => {
      if (await fulfillPreflight(route, origin)) return;
      const url = new URL(route.request().url());
      expect(url.searchParams.get("propertyId")).toBe(munich);
      if (url.pathname.endsWith("/verify")) {
        publications++;
        await fulfillJson(
          route,
          origin,
          { detail: "Complete Marketplace setup before publishing." },
          422,
        );
        return;
      }
      if (route.request().method() === "POST") {
        expect(route.request().headers()["idempotency-key"]).toBeTruthy();
        const body = route.request().postDataJSON();
        drafts.push({
          ...body,
          offerId: "95500000-0000-4000-8000-000000000005",
          propertyId: munich,
          offerStatus: "draft",
          media: [
            {
              mediaObjectId: "95500000-0000-4000-8000-000000000007",
              url: null,
              approvalStatus: "pending_domain_approval",
              lifecycleStatus: "staged",
            },
          ],
          createdAt: "2026-09-05T00:00:00Z",
          updatedAt: "2026-09-05T00:00:00Z",
        });
        await fulfillJson(route, origin, drafts[0], 201);
        return;
      }
      await fulfillJson(route, origin, {
        contractVersion: "marketplace-admin.v1",
        authorizationMode: "platform_organization_membership",
        userId,
        profile: enabled
          ? {
              propertyId: munich,
              displayName: "Hotel Munich",
              location: "Munich, Germany",
              profileStatus: "pending",
              profileComplete: false,
              hostSummary: null,
              createdAt: "2026-09-01T00:00:00Z",
              updatedAt: "2026-09-01T00:00:00Z",
            }
          : null,
        offers: drafts,
      });
    },
  );
  await page.goto(`/dashboard/users/${userId}?tab=listings`);
  await page.getByLabel("Hotel account", { exact: true }).selectOption(orgId);
  await expect(page.getByRole("button", { name: "Enable Marketplace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create Draft Offer" })).toHaveCount(0);
  await page.getByRole("button", { name: "Enable Marketplace" }).click();
  await expect(
    page.getByText("Marketplace enabled. No properties or offers were published."),
  ).toBeVisible();
  await page.getByLabel("Property", { exact: true }).selectOption(munich);
  await expect(page.getByRole("button", { name: "Create Draft Offer" })).toBeVisible();
  await page.getByRole("button", { name: "Create Draft Offer" }).click();
  await page.getByPlaceholder("Offer title", { exact: true }).fill("Munich creator weekend");
  await page.getByRole("button", { name: "Create Offer", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Munich creator weekend" })).toBeVisible();
  await expect(page.getByText(/Private draft/)).toBeVisible();
  await expect(page.getByText(/Private draft/)).not.toContainText("add a photo");
  expect(drafts).toHaveLength(1);
  expect(publications).toBe(0);
  await page.getByRole("button", { name: "Verify & publish" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Complete Marketplace setup" }),
  ).toBeVisible();
  expect(publications).toBe(1);
  await page
    .getByLabel("Hotel account", { exact: true })
    .selectOption("95500000-0000-4000-8000-000000000006");
  await expect(page.getByLabel("Hotel account", { exact: true })).toHaveValue(
    "95500000-0000-4000-8000-000000000006",
  );
  await expect(page.getByRole("button", { name: "Create Draft Offer" })).toHaveCount(0);
  await noLegacy();
});

async function mockAdminAuth(page: Page, baseURL: string) {
  await mockFirstPartyAuth(page, {
    baseURL,
    key: "admin",
    label: "Vayada Admin",
    surface: "platform-admin",
  });
}

async function authenticateAdmin(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("access_token", "e2e-platform-token");
    window.localStorage.setItem("token_expires_at", String(Date.now() + 60 * 60 * 1000));
    window.localStorage.setItem("isLoggedIn", "true");
    window.localStorage.setItem("userId", "user-platform-admin");
    window.localStorage.setItem("userEmail", "platform-admin@example.test");
    window.localStorage.setItem("userStatus", "active");
    window.localStorage.setItem("isSuperAdmin", "true");
    window.localStorage.setItem(
      "user",
      JSON.stringify({
        id: "user-platform-admin",
        email: "platform-admin@example.test",
        status: "active",
        is_superadmin: true,
      }),
    );
  });
}

async function fulfillPreflight(route: Route, origin: string): Promise<boolean> {
  if (route.request().method() !== "OPTIONS") return false;
  await route.fulfill({ status: 204, headers: corsHeaders(origin) });
  return true;
}

async function fulfillJson(route: Route, origin: string, body: unknown, status = 200) {
  await route.fulfill({
    status,
    headers: { ...corsHeaders(origin), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function corsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type, idempotency-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}
