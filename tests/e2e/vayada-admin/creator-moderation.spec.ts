import { expect, test, type Page, type Route } from "@playwright/test";

import { mockFirstPartyAuth } from "../support/firstPartyAuth";
import { watchNoLegacyCalls } from "../support/noLegacyCalls";
import { watchPageHealth } from "../support/pageHealth";

const userId = "user-creator-1419";
const creatorProfileId = "14190000-0000-4000-8000-000000000001";

test("reviews and activates a pending creator with one idempotent command", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertHealthy = watchPageHealth(page, testInfo);
  const assertNoLegacyCalls = watchNoLegacyCalls(
    page,
    testInfo,
    "vayada-admin-marketplace-preview",
  );
  const adminBaseURL = resolvedAdminBaseURL(baseURL);
  const pageOrigin = new URL(adminBaseURL).origin;
  const requests: Array<{ body: unknown; idempotencyKey?: string }> = [];
  let releaseModeration: () => void = () => undefined;
  const moderationGate = new Promise<void>((resolve) => {
    releaseModeration = resolve;
  });
  const reviewState: CreatorReviewState = {
    profileStatus: "pending",
    profileComplete: true,
    profileAvailable: true,
    moderationAllowed: true,
    allowedTransitions: ["active", "rejected", "archived"],
  };

  await mockAdminAuth(page, adminBaseURL);
  await authenticateAdmin(page);
  await routeCreatorDetail(page, pageOrigin, reviewState);
  await page.route(moderationRoute(), async (route) => {
    if (await fulfillPreflight(route, pageOrigin)) return;
    requests.push({
      body: route.request().postDataJSON(),
      idempotencyKey: route.request().headers()["idempotency-key"],
    });
    await moderationGate;
    reviewState.profileStatus = "active";
    reviewState.allowedTransitions = ["suspended", "archived"];
    await fulfillJson(route, pageOrigin, {
      contractVersion: "marketplace-creator-moderation.v1",
      outcome: "transitioned",
      creatorProfileId,
      previousStatus: "pending",
      profileStatus: "active",
      reason: "Profile reviewed and approved.",
      moderatedByUserId: "user-platform-admin",
      moderatedAt: "2026-09-02T10:00:00.000Z",
    });
  });

  await page.goto(new URL(`/dashboard/users/${userId}`, adminBaseURL).toString());

  await expect(page.getByRole("heading", { name: "Creator moderation" })).toBeVisible();
  await expect(page.getByText("Pending review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Suspend" })).toHaveCount(0);

  const activateButton = page.getByRole("button", { name: "Activate" });
  await activateButton.click();
  const dialog = page.getByRole("dialog");
  const reason = page.getByLabel("Reason");
  await expect(dialog).toBeVisible();
  await expect(reason).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(activateButton).toBeFocused();

  await activateButton.click();
  await page.getByRole("button", { name: "Activate creator" }).click();
  await expect(page.getByText("Enter a reason for this decision.")).toBeVisible();
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  await expect(reason).toHaveAttribute("aria-describedby", "creator-moderation-reason-feedback");
  await expect(dialog.getByRole("alert")).toContainText("Enter a reason");
  await reason.fill("Profile reviewed and approved.");
  await page.getByRole("button", { name: "Activate creator" }).dblclick();

  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();
  releaseModeration();

  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  const success = page.getByText("Creator status updated to Active.");
  await expect(success).toBeVisible();
  await expect(success.locator("..")).toBeFocused();
  await expect(page.getByRole("button", { name: "Suspend" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate" })).toHaveCount(0);
  expect(requests).toEqual([
    {
      body: {
        expectedStatus: "pending",
        nextStatus: "active",
        reason: "Profile reviewed and approved.",
      },
      idempotencyKey: expect.stringMatching(
        /^marketplace\.admin\.creator\.active:14190000-0000-4000-8000-000000000001:.+:v1$/,
      ),
    },
  ]);
  await assertNoLegacyCalls();
  await assertHealthy();
});

test("replaces stale lifecycle state with the server state", async ({
  page,
  baseURL,
}, testInfo) => {
  const assertNoLegacyCalls = watchNoLegacyCalls(
    page,
    testInfo,
    "vayada-admin-marketplace-preview",
  );
  const adminBaseURL = resolvedAdminBaseURL(baseURL);
  const pageOrigin = new URL(adminBaseURL).origin;
  const reviewState: CreatorReviewState = {
    profileStatus: "pending",
    profileComplete: true,
    profileAvailable: true,
    moderationAllowed: true,
    allowedTransitions: ["active", "rejected", "archived"],
  };

  await mockAdminAuth(page, adminBaseURL);
  await authenticateAdmin(page);
  await routeCreatorDetail(page, pageOrigin, reviewState);
  await page.route(moderationRoute(), async (route) => {
    if (await fulfillPreflight(route, pageOrigin)) return;
    reviewState.profileStatus = "suspended";
    reviewState.allowedTransitions = ["active", "archived"];
    await fulfillJson(
      route,
      pageOrigin,
      {
        statusCode: 409,
        code: "profile_status_conflict",
        category: "conflict",
        message: "profile_status_conflict",
        currentStatus: "suspended",
      },
      409,
    );
  });

  await page.goto(new URL(`/dashboard/users/${userId}`, adminBaseURL).toString());
  await page.getByRole("button", { name: "Reject" }).click();
  await page.getByLabel("Reason").fill("Audience information could not be verified.");
  await page.getByRole("button", { name: "Reject creator" }).click();

  await expect(
    page.getByRole("region", { name: "Creator moderation" }).getByRole("alert"),
  ).toContainText("changed elsewhere");
  await expect(page.getByText("Suspended", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reactivate" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject" })).toHaveCount(0);
  await assertNoLegacyCalls();
});

test("keeps the archived terminal state visible after archiving", async ({ page, baseURL }) => {
  const adminBaseURL = resolvedAdminBaseURL(baseURL);
  const pageOrigin = new URL(adminBaseURL).origin;
  const reviewState: CreatorReviewState = {
    profileStatus: "active",
    profileComplete: true,
    profileAvailable: true,
    moderationAllowed: true,
    allowedTransitions: ["suspended", "archived"],
  };

  await mockAdminAuth(page, adminBaseURL);
  await authenticateAdmin(page);
  await routeCreatorDetail(page, pageOrigin, reviewState);
  await page.route(moderationRoute(), async (route) => {
    if (await fulfillPreflight(route, pageOrigin)) return;
    reviewState.profileStatus = "archived";
    reviewState.allowedTransitions = [];
    await fulfillJson(route, pageOrigin, {
      contractVersion: "marketplace-creator-moderation.v1",
      outcome: "transitioned",
      creatorProfileId,
      previousStatus: "active",
      profileStatus: "archived",
      reason: "The creator requested permanent profile closure.",
      moderatedByUserId: "user-platform-admin",
      moderatedAt: "2026-09-02T10:00:00.000Z",
    });
  });

  await page.goto(new URL(`/dashboard/users/${userId}`, adminBaseURL).toString());
  await page.getByRole("button", { name: "Archive" }).click();
  await page.getByLabel("Reason").fill("The creator requested permanent profile closure.");
  await page.getByRole("button", { name: "Archive creator" }).click();

  await expect(page.getByText("Archived", { exact: true })).toBeVisible();
  await expect(page.getByText("Creator status updated to Archived.")).toBeVisible();
  await expect(page.getByText("Archived is terminal;")).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate|Reject|Suspend|Archive/ })).toHaveCount(
    0,
  );
});

test("preserves a successful decision when the follow-up refresh fails", async ({
  page,
  baseURL,
}) => {
  const adminBaseURL = resolvedAdminBaseURL(baseURL);
  const pageOrigin = new URL(adminBaseURL).origin;
  const reviewState: CreatorReviewState = {
    profileStatus: "pending",
    profileComplete: true,
    profileAvailable: true,
    moderationAllowed: true,
    allowedTransitions: ["active", "rejected", "archived"],
  };

  await mockAdminAuth(page, adminBaseURL);
  await authenticateAdmin(page);
  await routeCreatorDetail(page, pageOrigin, reviewState);
  await page.route(moderationRoute(), async (route) => {
    if (await fulfillPreflight(route, pageOrigin)) return;
    reviewState.profileStatus = "active";
    reviewState.reviewFailureStatus = 503;
    await fulfillJson(route, pageOrigin, {
      contractVersion: "marketplace-creator-moderation.v1",
      outcome: "transitioned",
      creatorProfileId,
      previousStatus: "pending",
      profileStatus: "active",
      reason: "Profile reviewed and approved.",
      moderatedByUserId: "user-platform-admin",
      moderatedAt: "2026-09-02T10:00:00.000Z",
    });
  });

  await page.goto(new URL(`/dashboard/users/${userId}`, adminBaseURL).toString());
  await page.getByRole("button", { name: "Activate" }).click();
  await page.getByLabel("Reason").fill("Profile reviewed and approved.");
  await page.getByRole("button", { name: "Activate creator" }).click();

  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Creator status updated to Active.")).toBeVisible();
  await expect(page.getByText("The latest creator profile could not be refreshed.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate|Reject|Suspend|Archive/ })).toHaveCount(
    0,
  );

  const tabs = page.getByRole("navigation", { name: "Tabs" });
  await tabs.getByRole("button", { name: /Social Media/ }).click();
  await tabs.getByRole("button", { name: "Profile" }).click();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate|Reject|Suspend|Archive/ })).toHaveCount(
    0,
  );
});

test("shows creator review without controls when moderation permission is denied", async ({
  page,
  baseURL,
}) => {
  const adminBaseURL = resolvedAdminBaseURL(baseURL);
  const pageOrigin = new URL(adminBaseURL).origin;

  await mockAdminAuth(page, adminBaseURL);
  await authenticateAdmin(page);
  await routeCreatorDetail(page, pageOrigin, {
    profileStatus: "pending",
    profileComplete: true,
    profileAvailable: true,
    moderationAllowed: false,
    allowedTransitions: [],
  });

  await page.goto(new URL(`/dashboard/users/${userId}`, adminBaseURL).toString());

  await expect(page.getByRole("heading", { name: "Creator moderation" })).toBeVisible();
  await expect(page.getByText("You have read-only access to this profile.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Activate|Reject|Suspend|Archive/ })).toHaveCount(
    0,
  );
});

test("removes stale controls when the creator profile no longer exists", async ({
  page,
  baseURL,
}) => {
  const adminBaseURL = resolvedAdminBaseURL(baseURL);
  const pageOrigin = new URL(adminBaseURL).origin;
  const reviewState: CreatorReviewState = {
    profileStatus: "pending",
    profileComplete: true,
    profileAvailable: true,
    moderationAllowed: true,
    allowedTransitions: ["active", "rejected", "archived"],
  };

  await mockAdminAuth(page, adminBaseURL);
  await authenticateAdmin(page);
  await routeCreatorDetail(page, pageOrigin, reviewState);
  await page.route(moderationRoute(), async (route) => {
    if (await fulfillPreflight(route, pageOrigin)) return;
    reviewState.profileAvailable = false;
    reviewState.allowedTransitions = [];
    await fulfillJson(
      route,
      pageOrigin,
      {
        statusCode: 404,
        code: "creator_profile_not_found",
        category: "not_found",
        message: "creator_profile_not_found",
      },
      404,
    );
  });

  await page.goto(new URL(`/dashboard/users/${userId}`, adminBaseURL).toString());
  await page.getByRole("button", { name: "Reject" }).click();
  await page.getByLabel("Reason").fill("The profile is no longer available.");
  await page.getByRole("button", { name: "Reject creator" }).click();

  await expect(
    page.getByText("This creator does not have an available marketplace profile."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Creator moderation" })).toHaveCount(0);
});

test("does not expose moderation controls when creator review access is denied", async ({
  page,
  baseURL,
}, testInfo) => {
  const adminBaseURL = resolvedAdminBaseURL(baseURL);
  const pageOrigin = new URL(adminBaseURL).origin;

  await mockAdminAuth(page, adminBaseURL);
  await authenticateAdmin(page);
  await routeIdentityUser(page, pageOrigin);
  await page.route(creatorReviewRoute(), async (route) => {
    if (await fulfillPreflight(route, pageOrigin)) return;
    await fulfillJson(route, pageOrigin, { message: "Forbidden" }, 403);
  });

  await page.goto(new URL(`/dashboard/users/${userId}`, adminBaseURL).toString());

  await expect(page.getByText("Access denied. Admin privileges required.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Creator moderation" })).toHaveCount(0);
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

async function routeCreatorDetail(page: Page, pageOrigin: string, state: CreatorReviewState) {
  await routeIdentityUser(page, pageOrigin);
  await page.route(creatorReviewRoute(), async (route) => {
    if (await fulfillPreflight(route, pageOrigin)) return;
    if (state.reviewFailureStatus) {
      await fulfillJson(
        route,
        pageOrigin,
        { message: "Review unavailable" },
        state.reviewFailureStatus,
      );
      return;
    }
    await fulfillJson(route, pageOrigin, {
      contractVersion: "marketplace-admin.v1",
      authorizationMode: "platform_organization_membership",
      userId,
      profile: state.profileAvailable
        ? {
            creatorProfileId,
            displayName: "Mina Travels",
            locationText: "Vienna",
            shortDescription: "Travel creator focused on European city stays.",
            portfolioUrl: "https://example.test/mina",
            phone: null,
            profilePictureUrl: null,
            profilePictureMediaObjectId: null,
            profileComplete: state.profileComplete,
            profileCompletedAt: state.profileComplete ? "2026-09-01T10:00:00.000Z" : null,
            profileStatus: state.profileStatus,
            platforms: [],
            createdAt: "2026-08-28T10:00:00.000Z",
            updatedAt: "2026-09-01T10:00:00.000Z",
          }
        : null,
      moderation: {
        allowed: state.moderationAllowed,
        allowedTransitions: state.allowedTransitions,
      },
    });
  });
}

type CreatorReviewState = {
  profileStatus: "pending" | "active" | "rejected" | "suspended" | "archived";
  profileComplete: boolean;
  profileAvailable: boolean;
  moderationAllowed: boolean;
  allowedTransitions: Array<"active" | "rejected" | "suspended" | "archived">;
  reviewFailureStatus?: number;
};

async function routeIdentityUser(page: Page, pageOrigin: string) {
  await page.route(identityUserRoute(), async (route) => {
    if (await fulfillPreflight(route, pageOrigin)) return;
    await fulfillJson(route, pageOrigin, {
      id: userId,
      email: "mina@example.test",
      name: "Mina Travels",
      type: "creator",
      status: "verified",
      emailVerified: true,
      avatar: null,
      createdAt: "2026-08-28T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
      profile: null,
    });
  });
}

function resolvedAdminBaseURL(baseURL: string | undefined) {
  return baseURL?.startsWith("http://127.0.0.1:3001")
    ? "http://localhost:3001"
    : (baseURL ?? "https://admin.localhost");
}

function identityUserRoute() {
  return new RegExp(`https://api\\.localhost(?::\\d+)?/api/identity/admin/users/${userId}$`);
}

function creatorReviewRoute() {
  return new RegExp(
    `https://api\\.localhost(?::\\d+)?/api/marketplace/admin/users/${userId}/review/creator$`,
  );
}

function moderationRoute() {
  return new RegExp(
    `https://api\\.localhost(?::\\d+)?/api/marketplace/admin/creators/${creatorProfileId}/moderation$`,
  );
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
