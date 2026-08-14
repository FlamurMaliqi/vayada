import { expect, test, type Page, type Route } from "@playwright/test";

import { createAdaptiveHotelSetupStatusMock } from "../support/sharedHotelSetupMocks";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const mediaObjectId = "33333333-3333-4333-8333-333333333333";

test.describe("hotel account prerequisites", () => {
  test("saves combined-track property details, public contacts, explicit locality, and one logo", async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await primeHotelManager(page);
    await mockSession(page);
    let selectedTracks: Array<"hotel_operations" | "creator_marketplace"> = [];
    let assigned = false;
    const writes: Array<{ path: string; body: unknown; idempotencyKey?: string }> = [];

    await page.route(/\/api\/hotel-setup\/status/, async (route) => {
      await fulfillJson(
        route,
        createAdaptiveHotelSetupStatusMock({
          entryProduct: "marketplace",
          organizationId,
          organizationDisplayName: "Alpenrose Hospitality",
          selectedTracks,
          trackRevision: selectedTracks.length > 0 ? 1 : 0,
          propertyId: assigned ? propertyId : null,
          propertyDisplayName: "Hotel Alpenrose",
          taskOverrides: assigned
            ? { shared_identity: { ownerProgress: "owner_complete", readiness: "complete" } }
            : undefined,
        }),
      );
    });
    await page.route(/\/api\/hotel-setup\/tracks$/, async (route) => {
      const body = route.request().postDataJSON() as { selectedTracks: typeof selectedTracks };
      selectedTracks = [...body.selectedTracks];
      writes.push(requestWrite(route));
      await fulfillJson(route, {
        trackRevision: 1,
        selectedTracks,
        tracks: createAdaptiveHotelSetupStatusMock({
          entryProduct: "marketplace",
          organizationId,
          organizationDisplayName: "Alpenrose Hospitality",
          selectedTracks,
          trackRevision: 1,
          propertyId: null,
        }).organization.tracks,
      });
    });
    await mockPropertyTypes(page);
    await page.route(/\/api\/hotel-setup\/properties$/, async (route) => {
      writes.push(requestWrite(route));
      const body = route.request().postDataJSON() as Record<string, unknown>;
      await fulfillJson(route, { propertyId, profileRevision: 1, profile: body });
    });
    await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
      writes.push(requestWrite(route));
      if (route.request().url().endsWith("/finalize")) {
        await fulfillJson(route, {
          mediaObjects: [
            {
              mediaObjectId,
              purpose: "property.logo",
              status: "private_ready",
              publicVariants: [],
            },
          ],
        });
        return;
      }
      await fulfillJson(
        route,
        {
          uploadSession: { sessionId: "44444444-4444-4444-8444-444444444444" },
          uploadTargets: [
            {
              uploadTargetId: "55555555-5555-4555-8555-555555555555",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/property-logo",
              headers: {},
            },
          ],
        },
        201,
      );
    });
    await page.route(
      new RegExp(`/api/hotel-setup/properties/${propertyId}/media/logo$`),
      async (route) => {
        writes.push(requestWrite(route));
        assigned = true;
        await fulfillJson(route, {
          outcome: "updated",
          profileRevision: 2,
          logoAssignment: {
            mediaObjectId,
            role: "logo",
            altText: null,
            sortOrder: 0,
          },
          presentationAssignments: [],
        });
      },
    );
    await page.route(
      new RegExp(`/api/hotel-setup/properties/${propertyId}/launch-settings$`),
      async (route) => {
        writes.push(requestWrite(route));
        await fulfillJson(route, route.request().postDataJSON());
      },
    );

    await page.goto(setupUrl(baseURL));
    await page.getByLabel("Hotel Operations").locator("xpath=ancestor::label").click();
    await page.getByLabel("Creator Marketplace").locator("xpath=ancestor::label").click();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByLabel("Hotel name").fill("Hotel Alpenrose");
    await page.getByRole("radio", { name: "Hotel", exact: true }).check();
    await page.getByLabel("Hotel logo file").setInputFiles({
      name: "alpenrose.webp",
      mimeType: "image/webp",
      buffer: Buffer.from("property-logo"),
    });
    await expect(page.getByRole("img", { name: "Hotel logo preview" })).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("button", { name: "Enter address manually" }).click();
    await page.getByRole("textbox", { name: /Street address/ }).fill("Marienplatz 1");
    await page.getByRole("textbox", { name: /Postal code/ }).fill("80331");
    await page.getByRole("textbox", { name: /City/ }).fill("Munich");
    await page.getByRole("combobox", { name: /Country/ }).selectOption("DE");
    await expect(page.getByRole("combobox", { name: /Time zone/ })).toHaveValue("Europe/Berlin");
    const localityConsent = page.getByRole("checkbox", {
      name: "Show city and country publicly",
    });
    await expect(localityConsent).not.toBeChecked();
    await localityConsent.focus();
    await page.keyboard.press("Space");
    await expect(localityConsent).toBeChecked();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByText("Step 3 of 4 · Guest preferences")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Step 4 of 4 · Contact information")).toBeVisible();
    await page.getByRole("textbox", { name: "Phone number", exact: true }).fill("+49 89 123456");
    await expect(page.getByRole("textbox", { name: "WhatsApp number", exact: true })).toHaveValue(
      "+49 89 123456",
    );
    await page.getByRole("textbox", { name: "WhatsApp number", exact: true }).fill("");
    await page.getByRole("textbox", { name: "Email", exact: true }).fill("hello@alpenrose.example");
    await expect(page.getByLabel("Website")).toHaveCount(0);
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(page.getByRole("heading", { name: "Review and next steps" })).toBeVisible();
    expect(selectedTracks).toEqual(["hotel_operations", "creator_marketplace"]);
    const profileWrite = writes.find(({ path }) => path.endsWith("/hotel-setup/properties"));
    expect(profileWrite?.body).toMatchObject({
      location: {
        city: "Munich",
        countryCode: "DE",
        localityPublic: true,
        geoPublic: false,
        mapDisplayMode: "hidden",
      },
      contacts: [
        { channelType: "phone", isPublic: true },
        { channelType: "email", isPublic: true },
      ],
    });
    const uploadWrite = writes.find(({ path }) => path.endsWith("/media/upload-sessions"));
    expect(uploadWrite?.body).toMatchObject({
      purpose: "property.logo",
      visibility: "private",
      resource: { product: "hotel_catalog", resourceType: "property", resourceId: propertyId },
    });
    expect(uploadWrite?.body).not.toHaveProperty("expectedProfileRevision");
    const assignmentWrite = writes.find(({ path }) => path.endsWith("/media/logo"));
    expect(assignmentWrite).toMatchObject({
      body: {
        expectedProfileRevision: 1,
        assignment: { mediaObjectId, role: "logo", sortOrder: 0 },
      },
    });
    expect(assignmentWrite?.idempotencyKey).toBeTruthy();
  });

  test("resumes a finalized logo assignment after reload and replays the exact command", async ({
    page,
    baseURL,
  }) => {
    const pending = {
      mediaObjectId,
      expectedProfileRevision: 3,
      assignmentIdempotencyKey: "resume-assignment-key",
    };
    await primeHotelManager(page, pending);
    await mockSession(page);
    await mockPropertyTypes(page);
    let committed = false;
    let assignmentAttempts = 0;
    const assignmentKeys: string[] = [];
    let uploadRequests = 0;
    await page.route(/\/api\/hotel-setup\/status/, (route) =>
      fulfillJson(
        route,
        createAdaptiveHotelSetupStatusMock({
          entryProduct: "marketplace",
          organizationId,
          organizationDisplayName: "Alpenrose Hospitality",
          selectedTracks: ["creator_marketplace"],
          propertyId,
          propertyDisplayName: "Hotel Alpenrose",
          taskOverrides: {
            shared_identity: committed
              ? { ownerProgress: "owner_complete", readiness: "complete" }
              : {
                  ownerProgress: "not_started",
                  readiness: "actionable",
                  actionableBy: "owner",
                },
          },
        }),
      ),
    );
    const profile = propertyProfile(3);
    await page.route(new RegExp(`/api/hotel-setup/properties/${propertyId}/profile$`), (route) =>
      fulfillJson(route, profile),
    );
    await page.route(
      new RegExp(`/api/hotel-setup/properties/${propertyId}/public-profile$`),
      (route) =>
        fulfillJson(route, {
          propertyId,
          profileRevision: 3,
          publicProfile: {
            locale: "en",
            shortDescription: null,
            longDescription: null,
            media: [
              {
                mediaObjectId: "66666666-6666-4666-8666-666666666666",
                mediaType: "logo",
                url: "https://media.example/previous-logo.webp",
                altText: null,
                sortOrder: 0,
              },
            ],
          },
        }),
    );
    await page.route(/\/api\/media\/upload-sessions/, async (route) => {
      uploadRequests += 1;
      await fulfillJson(route, { error: "Upload must not repeat." }, 500);
    });
    await page.route(
      new RegExp(`/api/hotel-setup/properties/${propertyId}/media/logo$`),
      async (route) => {
        assignmentKeys.push(route.request().headers()["idempotency-key"] ?? "");
        assignmentAttempts += 1;
        if (assignmentAttempts === 1) {
          await route.abort("connectionreset");
          return;
        }
        committed = true;
        await fulfillJson(route, {
          outcome: "idempotent_replay",
          profileRevision: 4,
          logoAssignment: { mediaObjectId, role: "logo", altText: null, sortOrder: 0 },
          presentationAssignments: [],
        });
      },
    );

    await page.goto(setupUrl(baseURL, propertyId));
    await expect(page.getByText("Logo ready to finish")).toBeVisible();
    await completePrefilledProfile(page);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Failed to fetch");
    await page.reload();
    await expect(page.getByText("Logo ready to finish")).toBeVisible();
    await completePrefilledProfile(page);

    await expect(page.getByRole("heading", { name: "Review and next steps" })).toBeVisible();
    expect(assignmentKeys).toEqual([
      pending.assignmentIdempotencyKey,
      pending.assignmentIdempotencyKey,
    ]);
    expect(uploadRequests).toBe(0);
    expect(
      await page.evaluate(
        (id) => localStorage.getItem(`vayada:hotel-prerequisite:pending-logo:${id}`),
        propertyId,
      ),
    ).toBeNull();
  });
});

async function completePrefilledProfile(page: Page) {
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Save and continue" }).click();
}

async function primeHotelManager(page: Page, pending?: Record<string, unknown>) {
  await page.addInitScript(
    ({ id, retry }) => {
      localStorage.setItem(
        "vayada_cookie_consent",
        JSON.stringify({ necessary: true, functional: true, analytics: false, marketing: false }),
      );
      localStorage.setItem("userType", "hotel");
      if (retry) {
        localStorage.setItem(`vayada:hotel-prerequisite:pending-logo:${id}`, JSON.stringify(retry));
      }
    },
    { id: propertyId, retry: pending ?? null },
  );
}

async function mockSession(page: Page) {
  await page.route(/\/auth\/session(?:\?|$)/, (route) =>
    fulfillJson(route, {
      accessToken: "hotel-access-token",
      csrfToken: "hotel-csrf-token",
      organizationId,
      organizationKind: "hotel_group",
      user: {
        id: "manager-user",
        email: "manager@alpenrose.example",
        name: "Maya Manager",
        phone: "+49 89 123456",
        profilePictureUrl: null,
        profilePictureMediaObjectId: null,
        status: "active",
      },
    }),
  );
}

async function mockPropertyTypes(page: Page) {
  await page.route(/\/api\/hotel-setup\/property-types/, (route) =>
    fulfillJson(route, {
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel" }],
    }),
  );
}

function propertyProfile(profileRevision: number) {
  return {
    propertyId,
    profileRevision,
    profile: {
      displayName: "Hotel Alpenrose",
      propertyType: "hotel",
      location: {
        streetAddress: "Marienplatz 1",
        postalCode: "80331",
        city: "Munich",
        countryCode: "DE",
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
        { channelType: "phone", value: "+49 89 123456", purpose: "general", isPublic: false },
      ],
    },
  };
}

function requestWrite(route: Route) {
  const url = new URL(route.request().url());
  return {
    path: url.pathname,
    body: route.request().postDataJSON(),
    idempotencyKey: route.request().headers()["idempotency-key"],
  };
}

async function fulfillJson(route: Route, json: unknown, status = 200) {
  if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
  await route.fulfill({ status, headers: corsHeaders(route), json });
}

function setupUrl(baseURL: string | undefined, selectedPropertyId?: string) {
  const url = new URL(baseURL ?? "https://marketplace.localhost");
  if (url.hostname === "127.0.0.1" && url.port === "3000") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = new URLSearchParams({
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo: "/marketplace",
    ...(selectedPropertyId ? { propertyId: selectedPropertyId } : {}),
  }).toString();
  return baseURL ? url.toString() : `${url.pathname}${url.search}`;
}
