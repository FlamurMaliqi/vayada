import { expect, test, type Page } from "@playwright/test";

import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

test("creator updates matching preferences and retries a failed save", async ({ page }) => {
  await primeCreatorSession(page);

  let profile = creatorProfile({
    contentCategories: { mode: "selected", values: ["travel", "slow_travel"] },
    deliverableTypes: { mode: "no_preference" },
    compensationTypes: null,
    collaborationGoals: null,
    travel: null,
  });
  let saveAttempts = 0;
  let savedBody: Record<string, unknown> | null = null;

  await page.route(/\/api\/marketplace\/creators\/me(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    if (route.request().method() === "PUT") {
      saveAttempts += 1;
      savedBody = route.request().postDataJSON() as Record<string, unknown>;
      if (saveAttempts === 1) {
        await route.fulfill({
          status: 503,
          headers: corsHeaders(route),
          json: { detail: "Temporarily unavailable" },
        });
        return;
      }
      profile = creatorProfile(savedBody.matchingPreferences as MatchingPreferencesWrite);
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: profile });
  });
  await routeJson(page, /\/api\/marketplace\/creators\/me\/profile-status(?:\?|$)/, {
    profilePhotoRequired: true,
    profileComplete: true,
    missingFields: [],
    missingPlatforms: false,
    completionSteps: [],
  });

  await page.goto("/profile");
  const matchingTab = page.getByRole("button", { name: "Matching" });
  await matchingTab.click();

  await expect(page.getByRole("heading", { name: "Better matches, on your terms" })).toBeVisible();
  await expect(matchingTab).toHaveClass(/bg-white/);
  await expect(matchingTab).toHaveAttribute("aria-pressed", "true");
  const overviewTab = page.getByRole("button", { name: "Overview" });
  await expect(overviewTab).not.toHaveClass(/bg-white/);
  await expect(overviewTab).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Slow Travel (saved)")).toBeVisible();
  await expect(
    page.getByText(/Missing or stale metrics are unavailable, never treated as zero/),
  ).toBeVisible();

  const content = page.getByRole("group", { name: /What do you create content about/ });
  const foodAndDrink = content.getByRole("checkbox", { name: "Food & drink" });
  await foodAndDrink.press("Space");
  await expect(foodAndDrink).toBeChecked();
  await overviewTab.click();
  await expect(overviewTab).toHaveAttribute("aria-pressed", "true");
  await matchingTab.click();
  await expect(foodAndDrink).toBeChecked();
  const compensation = page.getByRole("group", { name: /Which offers work for you/ });
  await compensation.getByText("Choose", { exact: true }).click();
  await compensation.getByText("Paid collaboration", { exact: true }).click();
  const travel = page.getByRole("group", { name: /How flexible are your travel dates/ });
  await travel.getByText("Use my trips", { exact: true }).click();
  await page.getByLabel("Days before each trip").fill("3");
  await page.getByLabel("Days after each trip").fill("5");
  const manageTrips = page.getByRole("button", { name: "Manage trips" });
  await expect(manageTrips).toBeDisabled();

  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText(/We could not save your preferences/)).toContainText(
    "Your changes are still here",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Preferences saved.")).toBeVisible();
  await expect(manageTrips).toBeEnabled();

  expect(saveAttempts).toBe(2);
  expect(savedBody).toEqual({
    matchingPreferences: {
      contentCategories: {
        mode: "selected",
        values: ["travel", "slow_travel", "food_drink"],
      },
      deliverableTypes: { mode: "no_preference" },
      compensationTypes: { mode: "selected", values: ["paid"] },
      collaborationGoals: null,
      travel: { mode: "planned_trips", flexibilityDaysBefore: 3, flexibilityDaysAfter: 5 },
    },
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Better matches, on your terms" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
});

type MatchingPreferencesWrite = {
  contentCategories: { mode: "selected"; values: string[] } | { mode: "no_preference" } | null;
  deliverableTypes: { mode: "selected"; values: string[] } | { mode: "no_preference" } | null;
  compensationTypes: { mode: "selected"; values: string[] } | { mode: "no_preference" } | null;
  collaborationGoals: { mode: "selected"; values: string[] } | { mode: "no_preference" } | null;
  travel:
    | { mode: "no_preference" }
    | { mode: "planned_trips"; flexibilityDaysBefore: number; flexibilityDaysAfter: number }
    | null;
};

function creatorProfile(matchingPreferences: MatchingPreferencesWrite) {
  return {
    creatorProfileId: "creator-profile-e2e",
    displayName: "Lina Creator",
    creatorType: "travel",
    locationText: "Berlin, Germany",
    shortDescription: "I create practical city guides for independent travelers.",
    portfolioUrl: "https://creator.example/portfolio",
    phone: "+49 89 123456",
    profilePictureUrl: null,
    profilePictureMediaObjectId: null,
    profileComplete: true,
    profileStatus: "active",
    platforms: [],
    audienceSize: 0,
    rating: { averageRating: 0, totalReviews: 0 },
    matchingPreferences: {
      ...matchingPreferences,
      contractVersion: "marketplace-creator-matching-preferences.v1",
      evidenceSource: "creator_declared",
      revision: 2,
      updatedAt: "2026-09-03T08:00:00.000Z",
    },
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-09-03T08:00:00.000Z",
  };
}

async function primeCreatorSession(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("userType", "creator");
    localStorage.setItem("userName", "Lina Creator");
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem(
      "vayada_cookie_consent",
      JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
    );
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "creator-authkit-token",
        csrfToken: "creator-csrf-token",
        organizationId: "22222222-2222-4222-8222-222222222222",
        organizationKind: "creator_workspace",
        user: {
          id: "user-creator-e2e",
          email: "creator@example.test",
          name: "Lina Creator",
          status: "active",
        },
      },
    });
  });
}

async function routeJson(page: Page, pattern: RegExp, json: unknown) {
  await page.route(pattern, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json });
  });
}
