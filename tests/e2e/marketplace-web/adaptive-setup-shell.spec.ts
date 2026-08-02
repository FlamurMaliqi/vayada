import { expect, test, type Page, type Request } from "@playwright/test";
import type { PropertySetupStepId, SetupTrack } from "@vayada/domain-hotels";
import {
  createPropertySetupRouteMock,
  mockPropertySetupRoute,
} from "../support/propertySetupRouteMocks";
import { watchPageHealth } from "../support/pageHealth";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const routeScenarios: Array<{
  name: string;
  selectedTracks: SetupTrack[];
  resumeStepId: PropertySetupStepId;
  expectedStep: number;
  expectedTotal: number;
  expectedHeading: string;
}> = [
  {
    name: "Marketplace-only",
    selectedTracks: ["creator_marketplace"],
    resumeStepId: "marketplace_preferences",
    expectedStep: 2,
    expectedTotal: 3,
    expectedHeading: "Tell creators what you are open to",
  },
  {
    name: "Hotel Operations-only",
    selectedTracks: ["hotel_operations"],
    resumeStepId: "calendar",
    expectedStep: 5,
    expectedTotal: 8,
    expectedHeading: "Open your calendar",
  },
  {
    name: "combined",
    selectedTracks: ["hotel_operations", "creator_marketplace"],
    resumeStepId: "guest_experience",
    expectedStep: 7,
    expectedTotal: 9,
    expectedHeading: "Configure the guest experience",
  },
];

test.describe("marketplace-web adaptive hotel setup shell", () => {
  test("holds safely when an adaptive entry has no property scope", async ({ page, baseURL }) => {
    const forbiddenCalls = watchForbiddenSetupCalls(page);
    await primeBrowserState(page);
    await mockAuthSession(page);
    const entryUrl = new URL(setupUrl(baseURL));
    entryUrl.searchParams.delete("propertyId");

    await page.goto(entryUrl.toString());

    await expect(page.getByRole("heading", { name: "Choose a hotel to continue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Exit setup", exact: true })).toBeVisible();
    expect(forbiddenCalls()).toEqual([]);
  });

  for (const scenario of routeScenarios) {
    test(`${scenario.name} follows the canonical route and resumes at the server step`, async ({
      page,
      baseURL,
    }, testInfo) => {
      const assertHealthy = watchPageHealth(page, testInfo);
      const forbiddenCalls = watchForbiddenSetupCalls(page);
      await primeBrowserState(page);
      await mockAuthSession(page);
      const routeModel = createPropertySetupRouteMock({
        propertyId,
        selectedTracks: scenario.selectedTracks,
        resumeStepId: scenario.resumeStepId,
        stepStates: { present_hotel: "complete" },
      });
      const routeMock = await mockPropertySetupRoute(page, routeModel);

      await page.goto(setupUrl(baseURL));

      await expect(
        page.getByRole("heading", { name: scenario.expectedHeading, level: 1 }),
      ).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`[?&]step=${scenario.resumeStepId}(?:&|$)`));
      await expect(
        page.getByText(`Step ${scenario.expectedStep} of ${scenario.expectedTotal}`),
      ).toBeVisible();
      await expect(page.getByRole("progressbar", { name: "Hotel setup progress" })).toHaveAttribute(
        "aria-valuetext",
        `Step ${scenario.expectedStep} of ${scenario.expectedTotal}`,
      );
      await expect(page.getByTestId("adaptive-setup-content")).toHaveAttribute(
        "data-step-id",
        scenario.resumeStepId,
      );
      expect(routeMock.requestCount).toBe(1);
      expect(forbiddenCalls()).toEqual([]);
      await assertHealthy();
    });
  }

  test("reload resumes the same property session and server-selected step", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await primeBrowserState(page);
    await mockAuthSession(page);
    const routeMock = await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        resumeStepId: "calendar",
      }),
    );

    await page.goto(setupUrl(baseURL));
    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();
    await page.reload();

    await expect(page).toHaveURL(new RegExp(`propertyId=${propertyId}.*[?&]step=calendar`));
    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();
    expect(routeMock.requestCount).toBe(2);
    await assertHealthy();
  });

  test("Back follows the exact previous server position, focuses the heading, and respects browser history", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        resumeStepId: "calendar",
      }),
    );

    await page.goto(setupUrl(baseURL, { step: "calendar" }));
    await expect(page.getByRole("heading", { name: "Open your calendar", level: 1 })).toBeVisible();

    await page.getByRole("button", { name: "Back", exact: true }).click();

    await expect(page).toHaveURL(/[?&]step=pricing(?:&|$)/);
    const previousHeading = page.getByRole("heading", {
      name: "Set your room prices",
      level: 1,
    });
    await expect(previousHeading).toBeVisible();
    await expect(previousHeading).toBeFocused();
    await expect(page.getByText("Step 5 of 9")).toBeVisible();

    await page.goBack();

    const restoredHeading = page.getByRole("heading", {
      name: "Open your calendar",
      level: 1,
    });
    await expect(restoredHeading).toBeVisible();
    await expect(restoredHeading).toBeFocused();
    await expect(page.getByText("Step 6 of 9")).toBeVisible();
    await assertHealthy();
  });

  test("browser Back leaves setup through the draft-preservation guard", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "pricing",
      }),
    );
    const originUrl = new URL("/setup-history-origin", baseURL).toString();
    await page.route(originUrl, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Setup history origin</title>",
      });
    });

    await page.goto(originUrl);
    await page.goto(setupUrl(baseURL));
    await expect(
      page.getByRole("heading", { name: "Set your room prices", level: 1 }),
    ).toBeVisible();

    await page.goBack();

    await expect(page).toHaveURL(originUrl);
  });

  test("Exit setup is keyboard accessible and preserves a Marketplace return target", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["creator_marketplace"],
        resumeStepId: "marketplace_preferences",
      }),
    );
    const returnTo = "/marketplace?view=creators";

    await page.goto(setupUrl(baseURL, { returnTo }));
    await expect(
      page.getByRole("heading", {
        name: "Tell creators what you are open to",
        level: 1,
      }),
    ).toBeVisible();

    const exit = page.getByRole("button", { name: "Exit setup", exact: true });
    await exit.focus();
    await expect(exit).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/marketplace\?view=creators$/);
  });

  for (const target of [
    {
      product: "booking" as const,
      origin: "http://admin.booking.localhost:3003",
      label: "Booking Admin",
    },
    { product: "pms" as const, origin: "http://pms.localhost:3004", label: "PMS" },
  ]) {
    test(`Exit setup preserves the ${target.label} return route`, async ({ page, baseURL }) => {
      await primeBrowserState(page);
      await mockAuthSession(page);
      await mockPropertySetupRoute(
        page,
        createPropertySetupRouteMock({
          propertyId,
          selectedTracks: ["hotel_operations"],
          resumeStepId: "booking_design",
        }),
      );
      await page.route(`${target.origin}/**`, async (route) => {
        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html>" });
      });

      await page.goto(
        setupUrl(baseURL, {
          returnProduct: target.product,
          returnTo: "/dashboard?from=setup",
        }),
      );
      await expect(
        page.getByRole("heading", { name: "Style your booking page", level: 1 }),
      ).toBeVisible();

      await page.getByRole("button", { name: "Exit setup", exact: true }).click();

      await expect(page).toHaveURL(`${target.origin}/dashboard?from=setup`);
    });
  }

  test("shows an accessible Retry action and recovers after an initial 503", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const routeMock = await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "rooms",
      }),
      { failuresBeforeSuccess: 1, failureDetail: "Setup is temporarily unavailable." },
    );

    await page.goto(setupUrl(baseURL));

    const recoveryHeading = page.getByRole("heading", { name: "Setup could not be loaded" });
    const recovery = recoveryHeading.locator("..");
    await expect(recoveryHeading).toBeVisible();
    await expect(recovery).toContainText("Setup is temporarily unavailable.");
    const retry = recovery.getByRole("button", { name: "Retry", exact: true });
    await retry.focus();
    await expect(retry).toBeFocused();
    const assertHealthyAfterRecovery = watchPageHealth(page, testInfo);
    await page.keyboard.press("Enter");

    await expect(
      page.getByRole("heading", { name: "Add your room types", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Step 3 of 8")).toBeVisible();
    expect(routeMock.requestCount).toBe(2);
    await assertHealthyAfterRecovery();
  });

  test("announces a stale draft and supports keyboard refresh recovery", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const routeMock = await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "pricing",
      }),
      {
        failuresBeforeSuccess: 1,
        failureStatus: 409,
        failureCode: "draft_revision_conflict",
        failureDetail: "The setup draft changed in another session.",
      },
    );

    await page.goto(setupUrl(baseURL));

    const staleHeading = page.getByRole("heading", { name: "This setup draft is out of date" });
    const staleAlert = staleHeading.locator("..");
    await expect(staleAlert).toHaveAttribute("role", "alert");
    await expect(staleAlert).toContainText(/changed in another tab or session/i);
    const refresh = staleAlert.getByRole("button", { name: "Refresh", exact: true });
    await refresh.focus();
    await expect(refresh).toBeFocused();
    const assertHealthyAfterRecovery = watchPageHealth(page, testInfo);
    await page.keyboard.press("Enter");

    await expect(
      page.getByRole("heading", { name: "Set your room prices", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Step 4 of 8")).toBeVisible();
    expect(routeMock.requestCount).toBe(2);
    await assertHealthyAfterRecovery();
  });

  test("keeps the shell and step content full-width without horizontal overflow on mobile", async ({
    page,
    baseURL,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.setViewportSize({ width: 390, height: 844 });
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockPropertySetupRoute(
      page,
      createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations"],
        resumeStepId: "booking_design",
      }),
    );

    await page.goto(setupUrl(baseURL));
    await expect(
      page.getByRole("heading", { name: "Style your booking page", level: 1 }),
    ).toBeVisible();
    await expect(page.getByTestId("adaptive-setup-content")).toBeAttached();

    const layout = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('[data-testid="adaptive-setup-content"]');
      const container = content?.parentElement;
      if (!content || !container) throw new Error("Adaptive setup content was not rendered.");
      return {
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        contentWidth: content.getBoundingClientRect().width,
        containerWidth: container.getBoundingClientRect().width,
      };
    });

    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.contentWidth).toBeGreaterThanOrEqual(layout.viewportWidth - 40);
    expect(Math.abs(layout.contentWidth - layout.containerWidth)).toBeLessThanOrEqual(1);
    await assertHealthy();
  });
});

async function primeBrowserState(page: Page) {
  await page.addInitScript(
    ({ selectedPropertyId }) => {
      localStorage.setItem(
        "vayada_cookie_consent",
        JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
      );
      localStorage.setItem("userType", "hotel");
      localStorage.setItem("selectedSharedPropertyId", selectedPropertyId);
    },
    { selectedPropertyId: propertyId },
  );
}

async function mockAuthSession(page: Page) {
  await page.route(/\/api\/identity\/consent\/cookies(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: null });
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await fulfillCorsPreflight(route);
      return;
    }
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId,
        workosOrganizationId: "org_workos_hotel_group",
        organizationKind: "hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@alpenrose.example",
          name: "Owner Example",
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/owner.webp",
          profilePictureMediaObjectId: "media-owner",
          status: "active",
          workosUserId: "user_workos_hotel_owner",
        },
      },
    });
  });
}

const organizationId = "11111111-1111-4111-8111-111111111111";

function setupUrl(
  baseURL: string | undefined,
  overrides: {
    step?: PropertySetupStepId;
    returnProduct?: "marketplace" | "booking" | "pms";
    returnTo?: string;
  } = {},
): string {
  const query = new URLSearchParams({
    entryProduct: "marketplace",
    returnProduct: overrides.returnProduct ?? "marketplace",
    returnTo: overrides.returnTo ?? "/marketplace",
    propertyId,
    _adaptive: "1",
  });
  if (overrides.step) query.set("step", overrides.step);
  if (!baseURL) return `/setup?${query.toString()}`;

  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}

function watchForbiddenSetupCalls(page: Page) {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (isForbiddenSetupCall(request)) calls.push(`${request.method()} ${request.url()}`);
  });
  return () => calls;
}

function isForbiddenSetupCall(request: Request): boolean {
  const pathname = new URL(request.url()).pathname;
  return (
    /^\/api\/hotel-setup\/(?:status|tracks|property-types|handoffs)(?:\/|$)/.test(pathname) ||
    /^\/api\/hotel-setup\/properties\/[^/]+\/(?:profile|public-profile)(?:\/|$)/.test(pathname) ||
    /^\/api\/(?:booking|finance|marketplace|pms|distribution)\//.test(pathname)
  );
}
