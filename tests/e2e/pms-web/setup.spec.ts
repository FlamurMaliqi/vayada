import { expect, test, type Page } from "@playwright/test";
import type { SetupTaskId, SetupTrack } from "@vayada/domain-hotels";
import {
  PMS_WEB_PROPERTY_ID,
  mockPmsWebAuthenticatedSession,
  mockPmsWebTargetRoutes,
} from "../support/pmsWebMocks";
import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { watchPageHealth } from "../support/pageHealth";

const propertyId = "f6853000-0000-0000-0000-000000000970";
const PMS_ROOMS_HANDOFF_CODE = "P".repeat(43);
const TASK_HANDOFF_CODES: Partial<Record<SetupTaskId, string>> = {
  guest_settings_policies: "Q".repeat(43),
  creator_profile: "R".repeat(43),
};

test.describe("pms-web shared setup", () => {
  test("uses the shared hotel personal-account step when the saved photo is missing", async ({
    page,
  }) => {
    await mockPmsWebTargetRoutes(page);
    await page.route("**/auth/session?surface=pms-web", (route) =>
      route.fulfill({
        json: {
          accessToken: "e2e-pms-token",
          csrfToken: "e2e-pms-csrf-token",
          organizationId: "org_pms_owner",
          user: {
            id: "user_pms_owner",
            email: "owner@example.com",
            name: "PMS Owner",
            phone: "+49 89 123456",
            profilePictureUrl: null,
            profilePictureMediaObjectId: null,
            status: "active",
          },
        },
      }),
    );

    await page.goto("/setup?entryProduct=pms");

    await expect(page.getByRole("heading", { name: "Let’s create your profile" })).toBeVisible();
    await expect(
      page.getByText("Start with your details. Next, we’ll set up your first hotel."),
    ).toBeVisible();
    await expect(page.getByLabel("First name")).toHaveValue("PMS");
    await expect(page.getByLabel("Last name")).toHaveValue("Owner");
    await expect(page.getByLabel("Email address")).toHaveValue("owner@example.com");
    await expect(page.getByLabel("Phone number")).toHaveValue("+49 89 123456");
    await expect(page.getByLabel("Profile photo file")).toHaveAttribute("required", "");
    await expect(page.getByRole("button", { name: "Continue to hotel setup" })).toBeVisible();
  });

  for (const scenario of [
    {
      name: "Hotel Operations",
      selectedTracks: ["hotel_operations"] as SetupTrack[],
      visibleTasks: [
        "Add your hotel basics",
        "Set up rooms, rates, and availability",
        "Review guest settings and policies",
        "Configure payment",
        "Publish direct booking",
      ],
      hiddenTasks: [
        "Create your public hotel profile",
        "Introduce your hotel to creators",
        "Prepare your collaboration offer",
      ],
    },
    {
      name: "Creator Marketplace",
      selectedTracks: ["creator_marketplace"] as SetupTrack[],
      visibleTasks: [
        "Add your hotel basics",
        "Create your public hotel profile",
        "Introduce your hotel to creators",
        "Prepare your collaboration offer",
      ],
      hiddenTasks: [
        "Set up rooms, rates, and availability",
        "Review guest settings and policies",
        "Configure payment",
        "Publish direct booking",
      ],
    },
    {
      name: "both tracks",
      selectedTracks: ["hotel_operations", "creator_marketplace"] as SetupTrack[],
      visibleTasks: [
        "Add your hotel basics",
        "Create your public hotel profile",
        "Introduce your hotel to creators",
        "Prepare your collaboration offer",
        "Set up rooms, rates, and availability",
        "Review guest settings and policies",
        "Configure payment",
        "Publish direct booking",
      ],
      hiddenTasks: [],
    },
  ]) {
    test(`saves ${scenario.name} first and filters the property setup plan`, async ({ page }) => {
      const trackRequests: Array<{
        body: unknown;
        idempotencyKey: string | null;
      }> = [];
      await mockPmsWebAuthenticatedSession(page);
      await mockPmsWebTargetRoutes(page);
      await mockTrackFirstSetupApi(page, {
        initialPropertyId: propertyId,
        onTracks: (request) => trackRequests.push(request),
      });

      await page.goto("/setup?entryProduct=pms");

      await expect(
        page.getByRole("heading", { level: 1, name: "Choose how you’ll use Vayada" }),
      ).toBeVisible();
      await expect(page.getByText("PMS + Booking Engine")).toBeVisible();
      await expect(page.getByLabel("Hotel Operations")).not.toBeChecked();
      await expect(page.getByLabel("Creator Marketplace")).not.toBeChecked();

      for (const track of scenario.selectedTracks) {
        await page
          .getByLabel(track === "hotel_operations" ? "Hotel Operations" : "Creator Marketplace")
          .locator("xpath=ancestor::label")
          .click();
      }
      await page.getByRole("button", { name: "Continue" }).click();

      await expect.poll(() => trackRequests.length).toBe(1);
      expect(trackRequests[0]?.body).toEqual({
        selectedTracks: scenario.selectedTracks,
        expectedRevision: 0,
      });
      expect(trackRequests[0]?.idempotencyKey).toBeTruthy();
      await expect(
        page.getByRole("heading", { level: 1, name: "Set up your Vayada tools" }),
      ).toBeVisible();
      for (const title of scenario.visibleTasks) {
        await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
      }
      for (const title of scenario.hiddenTasks) {
        await expect(page.getByRole("heading", { level: 2, name: title })).toHaveCount(0);
      }
    });
  }

  test("creates a private canonical hotel profile after both tracks are selected", async ({
    page,
  }, testInfo) => {
    const assertHealthy = watchPageHealth(page, testInfo);
    const createRequests: Array<{
      body: unknown;
      idempotencyKey: string | null;
    }> = [];
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await mockTrackFirstSetupApi(page, {
      onCreate: (request) => createRequests.push(request),
    });

    await page.goto("/setup?entryProduct=pms&returnTo=/dashboard");
    await page.getByLabel("Hotel Operations").locator("xpath=ancestor::label").click();
    await page.getByLabel("Creator Marketplace").locator("xpath=ancestor::label").click();
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(
      page.getByRole("heading", { level: 1, name: "Let’s get to know your hotel" }),
    ).toBeVisible();
    await expect(page.getByText("Step 1 of 3 · About your hotel")).toBeVisible();
    await page.getByLabel("Hotel name").fill("Alpenrose Munich");
    await page.getByRole("radio", { name: "Hotel from API", exact: true }).check();
    await page.getByRole("button", { name: "Continue" }).click();

    const manualAddress = page.getByRole("button", { name: "Enter address manually" });
    if (await manualAddress.isVisible()) await manualAddress.click();
    await page.getByLabel("Street address").fill("Marienplatz 1");
    await page.getByLabel("Postal code").fill("80331");
    await page.getByLabel("City").fill("Munich");
    await page.getByLabel("Country").selectOption("DE");
    await expect(page.getByRole("combobox", { name: "Time zone" })).toHaveValue("Europe/Berlin");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Phone number").fill("+49 89 123456");
    await page.getByLabel("Contact email").fill("hello@alpenrose.example");
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect.poll(() => createRequests.length).toBe(1);
    expect(createRequests[0]?.idempotencyKey).toBeTruthy();
    expect(createRequests[0]?.body).toEqual({
      displayName: "Alpenrose Munich",
      propertyType: "hotel",
      location: {
        countryCode: "DE",
        city: "Munich",
        streetAddress: "Marienplatz 1",
        postalCode: "80331",
        timezone: "Europe/Berlin",
        latitude: null,
        longitude: null,
        localityPublic: false,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [
        {
          channelType: "email",
          value: "hello@alpenrose.example",
          purpose: "general",
          isPublic: false,
        },
        {
          channelType: "phone",
          value: "+49 89 123456",
          purpose: "general",
          isPublic: false,
        },
      ],
    });
    await expect(
      page.getByRole("heading", { level: 1, name: "Set up your Vayada tools" }),
    ).toBeVisible();
    await expect(page.getByText("8 of 8 setup tasks complete")).toBeVisible();
    await assertHealthy();
  });

  test("launches an actionable PMS task with an opaque handoff", async ({ page, baseURL }) => {
    test.skip(!baseURL, "Playwright base URL is required.");
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({
        json: actionableStatus("pms", "rooms_rates_availability"),
      }),
    );
    const handoffRequests: Array<Record<string, unknown>> = [];
    await page.route("**/api/hotel-setup/handoffs", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders() });
        return;
      }
      handoffRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        headers: corsHeaders(),
        json: {
          launchUrl: new URL(`/handoff?code=${PMS_ROOMS_HANDOFF_CODE}`, baseURL).toString(),
          expiresAt: "2026-07-26T20:00:00.000Z",
        },
      });
    });
    await page.route(new RegExp(`/handoff\\?code=${PMS_ROOMS_HANDOFF_CODE}$`), (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>PMS task handoff</title>",
      }),
    );

    await page.goto(`/setup?entryProduct=pms&propertyId=${PMS_WEB_PROPERTY_ID}`);
    const taskCard = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Set up rooms, rates, and availability" }),
    });
    await taskCard.getByRole("button", { name: "Continue recommended step" }).click();

    await expect
      .poll(() => new URL(page.url()).searchParams.get("code"))
      .toBe(PMS_ROOMS_HANDOFF_CODE);
    expect(handoffRequests).toEqual([
      {
        propertyId: PMS_WEB_PROPERTY_ID,
        taskId: "rooms_rates_availability",
        planRevision: "e2e-plan-1",
      },
    ]);
    const launchUrl = new URL(page.url());
    expect([...launchUrl.searchParams.keys()]).toEqual(["code"]);
    expect(launchUrl.hash).toBe("");
  });

  test("hands Booking and Marketplace tasks off with the selected hotel group", async ({
    page,
    baseURL,
  }) => {
    test.skip(!baseURL, "Playwright base URL is required.");
    let target: "booking" | "marketplace" = "booking";
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({
        json:
          target === "booking"
            ? actionableStatus("booking", "guest_settings_policies")
            : actionableStatus("marketplace", "creator_profile"),
      }),
    );
    const handoffRequests: Array<Record<string, unknown>> = [];
    await page.route("**/api/hotel-setup/handoffs", async (route) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders() });
        return;
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      handoffRequests.push(body);
      const code = TASK_HANDOFF_CODES[body.taskId as SetupTaskId];
      if (!code) throw new Error(`Missing handoff code for ${String(body.taskId)}`);
      const launchUrl = new URL(`/handoff?code=${code}`, baseURL);
      launchUrl.hostname =
        target === "booking" ? "admin.booking.localhost" : "marketplace.localhost";
      await route.fulfill({
        headers: corsHeaders(),
        json: {
          launchUrl: launchUrl.toString(),
          expiresAt: "2026-07-26T20:00:00.000Z",
        },
      });
    });
    await page.route(/\/handoff\?code=[A-Za-z0-9_-]{43}$/, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Handoff</title>" }),
    );

    for (target of ["booking", "marketplace"] as const) {
      await page.goto(
        new URL(
          `/setup?entryProduct=${target}&propertyId=${PMS_WEB_PROPERTY_ID}`,
          baseURL,
        ).toString(),
      );
      await page.getByRole("button", { name: "Continue recommended step" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/handoff");

      const handoffUrl = new URL(page.url());
      expect(handoffUrl.hostname).toContain(target === "booking" ? "admin.booking" : "marketplace");
      expect([...handoffUrl.searchParams.keys()]).toEqual(["code"]);
      expect(handoffUrl.hash).toBe("");
    }
    expect(handoffRequests).toEqual([
      {
        propertyId: PMS_WEB_PROPERTY_ID,
        taskId: "guest_settings_policies",
        planRevision: "e2e-plan-1",
      },
      {
        propertyId: PMS_WEB_PROPERTY_ID,
        taskId: "creator_profile",
        planRevision: "e2e-plan-1",
      },
    ]);
  });

  test("keeps an unavailable Operations service on the plan without an action", async ({
    page,
  }) => {
    await mockPmsWebAuthenticatedSession(page);
    await mockPmsWebTargetRoutes(page);
    await page.route("**/api/hotel-setup/status**", (route) =>
      route.fulfill({
        json: createAdaptiveHotelSetupStatusMock({
          entryProduct: "pms",
          organizationId: "org_pms_owner",
          organizationDisplayName: "Alpenrose Hotel Group",
          selectedTracks: ["hotel_operations"],
          propertyId: PMS_WEB_PROPERTY_ID,
          componentAccess: { pms: "suspended" },
          taskOverrides: {
            rooms_rates_availability: {
              callerCapability: "forbidden",
              ownerProgress: "not_started",
              readiness: "blocked",
              actionableBy: "support",
              reasonCodes: ["pms_suspended"],
            },
          },
          recommendedTaskId: null,
          entryDecision: {
            decision: "unavailable",
            propertyId: PMS_WEB_PROPERTY_ID,
            destinationRouteKey: null,
            reasonCode: "pms_suspended",
          },
        }),
      }),
    );

    await page.goto(`/setup?entryProduct=pms&propertyId=${PMS_WEB_PROPERTY_ID}`);

    await expect(
      page.getByText("PMS is not available for this hotel right now.", { exact: false }),
    ).toBeVisible();
    const taskCard = page.getByRole("article").filter({
      has: page.getByRole("heading", { name: "Set up rooms, rates, and availability" }),
    });
    await expect(taskCard.getByRole("button")).toHaveCount(0);
  });
});

async function mockTrackFirstSetupApi(
  page: Page,
  options: {
    initialPropertyId?: string;
    onTracks?: (request: { body: unknown; idempotencyKey: string | null }) => void;
    onCreate?: (request: { body: unknown; idempotencyKey: string | null }) => void;
  },
) {
  let selectedTracks: SetupTrack[] = [];
  let selectedPropertyId = options.initialPropertyId ?? null;

  await page.route("**/api/hotel-setup/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders() });
    }
    const url = new URL(request.url());

    if (url.pathname === "/api/hotel-setup/property-types") {
      return route.fulfill({
        headers: corsHeaders(),
        json: {
          contractVersion: "adaptive-hotel-property-types.v1",
          propertyTypes: [
            { value: "hotel", label: "Hotel from API" },
            { value: "constructor", label: "Future type from API" },
          ],
        },
      });
    }
    if (url.pathname === "/api/hotel-setup/status") {
      return route.fulfill({
        headers: corsHeaders(),
        json: createAdaptiveHotelSetupStatusMock({
          entryProduct: "pms",
          organizationId: "org_pms_owner",
          organizationDisplayName: "Alpenrose Hotel Group",
          selectedTracks,
          trackRevision: selectedTracks.length === 0 ? 0 : 1,
          propertyId: selectedPropertyId,
          publicId: "prop_alpenrose",
          propertyDisplayName: "Alpenrose Munich",
          locationSummary: "Munich, DE",
          entryDecision: {
            propertyId: selectedPropertyId,
            decision:
              selectedPropertyId && selectedTracks.includes("hotel_operations")
                ? "enter"
                : "setup_required",
            destinationRouteKey:
              selectedPropertyId && selectedTracks.includes("hotel_operations")
                ? "pms.workspace"
                : "hotel_setup",
            reasonCode:
              selectedPropertyId && selectedTracks.includes("hotel_operations")
                ? null
                : selectedPropertyId
                  ? "requested_track_not_selected"
                  : "property_selection_required",
          },
          recommendedTaskId: null,
        }),
      });
    }
    if (url.pathname === "/api/hotel-setup/tracks" && request.method() === "PUT") {
      const body = request.postDataJSON() as { selectedTracks: SetupTrack[] };
      options.onTracks?.({
        body,
        idempotencyKey: request.headers()["idempotency-key"] ?? null,
      });
      selectedTracks = body.selectedTracks;
      const status = createAdaptiveHotelSetupStatusMock({
        entryProduct: "pms",
        organizationId: "org_pms_owner",
        organizationDisplayName: "Alpenrose Hotel Group",
        selectedTracks,
        trackRevision: 1,
        propertyId: selectedPropertyId,
      });
      return route.fulfill({
        headers: corsHeaders(),
        json: {
          trackRevision: status.organization.trackRevision,
          selectedTracks,
          tracks: status.organization.tracks,
        },
      });
    }
    if (url.pathname === "/api/hotel-setup/properties" && request.method() === "POST") {
      const body = request.postDataJSON();
      options.onCreate?.({
        body,
        idempotencyKey: request.headers()["idempotency-key"] ?? null,
      });
      selectedPropertyId = propertyId;
      return route.fulfill({
        status: 201,
        headers: corsHeaders(),
        json: {
          propertyId,
          profileRevision: 1,
          profile: body,
        },
      });
    }
    return route.fulfill({ status: 404, headers: corsHeaders(), json: { detail: "Not found" } });
  });
}

function actionableStatus(entryProduct: "pms" | "booking" | "marketplace", taskId: SetupTaskId) {
  const selectedTracks: SetupTrack[] =
    entryProduct === "marketplace" ? ["creator_marketplace"] : ["hotel_operations"];
  return createAdaptiveHotelSetupStatusMock({
    entryProduct,
    organizationId: "org_pms_owner",
    organizationDisplayName: "Alpenrose Hotel Group",
    selectedTracks,
    propertyId: PMS_WEB_PROPERTY_ID,
    propertyDisplayName: "Alpenrose Munich",
    taskOverrides: {
      [taskId]: {
        ownerProgress: "not_started",
        readiness: "actionable",
        actionableBy: "owner",
        reasonCodes: [`${taskId}_required`],
      },
    },
    recommendedTaskId: taskId,
    entryDecision: {
      propertyId: PMS_WEB_PROPERTY_ID,
      decision: "enter",
      destinationRouteKey: `${entryProduct}.workspace`,
      reasonCode: null,
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  };
}
