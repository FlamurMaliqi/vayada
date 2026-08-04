import { expect, test, type Page } from "@playwright/test";
import {
  createBookingDesignButtonColors,
  type BookingDesignFontPairing,
  type BookingDesignPrimaryColor,
} from "@vayada/domain-booking";
import type {
  PropertySetupRouteReadModel,
  PropertySetupStepDraft,
  PropertySetupStepId,
} from "@vayada/domain-hotels";
import { createMarketplaceHotelCollaborationPreferencesEvidence } from "@vayada/domain-marketplace";

import { createPropertySetupRouteMock } from "../support/propertySetupRouteMocks";
import { watchPageHealth } from "../support/pageHealth";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "22222222-2222-4222-8222-222222222222";
const mediaObjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = "2026-08-04T12:00:00.000Z";
const summary =
  "A quiet canal-side hotel near museums, cafés, local markets, and the historic centre.";

test.describe("adaptive presentation, Marketplace preferences, and Booking design", () => {
  test.describe.configure({ timeout: 120_000 });

  test("completes the first-visit desktop Steps 1–3 through exact owner boundaries", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const api = await mockAdaptiveApis(page);

    await page.goto(setupUrl(baseURL));
    await expect(page.getByRole("heading", { name: "Present your hotel", level: 1 })).toBeVisible();
    const assertHealthy = watchPageHealth(page, testInfo);
    await page.getByLabel("Content language").selectOption("en");
    await page.getByLabel("Short hotel summary").fill(summary);
    await page.getByLabel("Upload photos").setInputFiles({
      name: "canal-house.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from([1, 2, 3, 4]),
    });
    await expect(page.getByText("canal-house.jpg")).toBeVisible();
    await page.getByRole("button", { name: "Add amenities" }).click();
    await page.getByRole("checkbox", { name: "Wi-Fi" }).check();
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Tell creators what you are open to", level: 1 }),
    ).toBeVisible();
    await page.getByRole("checkbox", { name: "Complimentary stay" }).check();
    await page.getByRole("checkbox", { name: "Instagram" }).check();
    await page.getByRole("checkbox", { name: "Short-form video" }).check();
    await page.getByRole("radio", { name: "Year-round" }).check();
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Style your booking page", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("Save these choices to prepare the private preview."),
    ).toBeVisible();
    await page.getByRole("radio", { name: "Ocean blue" }).check();
    await page.getByRole("radio", { name: "Modern Minimalist" }).check();
    await assertHealthy();
    await page.getByRole("button", { name: "Save and continue" }).click();

    await expect(page).toHaveURL(/[?&]step=rooms(?:&|$)/);
    expect(api.draftSteps).toEqual(
      expect.arrayContaining(["present_hotel", "marketplace_preferences", "booking_design"]),
    );
    expect(api.canonicalWrites).toEqual([
      "present_hotel",
      "marketplace_preferences",
      "booking_design",
    ]);
    expect(api.uploadResources).toEqual([propertyId]);
    expect(api.uploadResources.join(" ")).not.toContain("draft:");
    expect(api.legacyCalls).toEqual([]);
  });

  test("retains Step 1 input through network failure, Exit resume, and stale recovery", async ({
    page,
    baseURL,
  }) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const api = await mockAdaptiveApis(page);
    api.failNextDraft = "network";

    await page.goto(setupUrl(baseURL));
    const textarea = page.getByLabel("Short hotel summary");
    await textarea.fill(summary);
    await page.getByRole("button", { name: "Exit setup", exact: true }).click();

    const saveFailure = page
      .getByRole("heading", { name: "Step could not be saved" })
      .locator("..");
    await expect(saveFailure).toBeVisible();
    await expect(textarea).toHaveValue(summary);
    await saveFailure.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page).toHaveURL(/\/marketplace$/);

    await page.goto(setupUrl(baseURL));
    await expect(page.getByLabel("Short hotel summary")).toHaveValue(summary);
    await page.getByLabel("Short hotel summary").fill(`${summary} Still locally retained.`);
    api.failNextDraft = "stale";
    await page.getByRole("button", { name: "Exit setup", exact: true }).click();

    await expect(
      page.getByRole("heading", { name: "This setup draft is out of date" }),
    ).toBeVisible();
    await expect(page.getByLabel("Short hotel summary")).toHaveValue(
      `${summary} Still locally retained.`,
    );
    expect(api.canonicalWrites).toEqual([]);
  });

  test("renders the saved private Booking snapshot in a keyboard-contained mobile preview", async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await primeBrowserState(page);
    await mockAuthSession(page);
    const api = await mockAdaptiveApis(page, { designConfigured: true });

    await page.goto(setupUrl(baseURL, "booking_design"));
    await expect(
      page.getByRole("heading", { name: "Style your booking page", level: 1 }),
    ).toBeVisible();
    const assertHealthy = watchPageHealth(page, testInfo);
    const openPreview = page.getByRole("button", { name: "Preview booking page" });
    await openPreview.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Booking page preview" });
    await expect(dialog).toBeVisible();
    const close = dialog.getByRole("button", { name: "Close booking page preview" });
    await expect(close).toBeFocused();
    await expect(dialog.getByText("Canal House")).toBeVisible();
    await expect(dialog.getByText(summary)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Check availability" })).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(openPreview).toBeFocused();

    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(layout.document).toBeLessThanOrEqual(layout.viewport);
    expect(api.readinessReads).toBeGreaterThan(0);
    await assertHealthy();
  });
});

type DraftFailure = "network" | "stale" | null;

async function mockAdaptiveApis(page: Page, options: { designConfigured?: boolean } = {}) {
  let profileRevision = 7;
  let profileSummary: string | null = options.designConfigured ? summary : null;
  let coverMediaObjectId: string | null = null;
  let preferencesRevision = 0;
  let preferences: Record<string, unknown> | null = null;
  let designRevision = options.designConfigured ? 1 : 0;
  let designChoices: {
    primaryColor: BookingDesignPrimaryColor;
    fontPairing: BookingDesignFontPairing;
  } = { primaryColor: "#4F46E5", fontPairing: "high-end-serif" };
  let sessionRevision = 7;
  const draftRevisions = new Map<PropertySetupStepId, number>();
  const drafts = new Map<PropertySetupStepId, PropertySetupStepDraft>();
  const draftSteps: PropertySetupStepId[] = [];
  const canonicalWrites: PropertySetupStepId[] = [];
  const uploadResources: string[] = [];
  const legacyCalls: string[] = [];
  let readinessReads = 0;
  let failNextDraft: DraftFailure = null;

  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      /^\/api\/hotel-setup\/(?:status|tracks|handoffs)(?:\/|$)/.test(pathname) ||
      /^\/api\/hotel-setup\/properties\/[^/]+\/(?:profile|public-profile)(?:\/|$)/.test(pathname)
    ) {
      legacyCalls.push(`${request.method()} ${pathname}`);
    }
  });

  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/route(?:\\?|$)`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const base = createPropertySetupRouteMock({
        propertyId,
        selectedTracks: ["hotel_operations", "creator_marketplace"],
        resumeStepId: "present_hotel",
      });
      const model = {
        ...base,
        sessionRevision,
        steps: base.steps.map((step) => ({
          ...step,
          currentBaseRevisions: currentManifest(
            step.stepId,
            {
              profileRevision,
              preferencesRevision,
              designRevision,
            },
            step.currentBaseRevisions,
          ),
          state: drafts.has(step.stepId) ? "draft" : step.state,
          draft: drafts.get(step.stepId) ?? null,
        })),
      } satisfies PropertySetupRouteReadModel;
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: model });
    },
  );

  await page.route(
    /\/api\/hotel-setup\/properties\/[^/]+\/setup-drafts\/([^/?]+)$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      if (failNextDraft) {
        const failure = failNextDraft;
        failNextDraft = null;
        await route.fulfill({
          status: failure === "stale" ? 409 : 503,
          headers: corsHeaders(route),
          json:
            failure === "stale"
              ? { code: "base_revision_conflict", detail: "The setup draft is out of date." }
              : { code: "service_unavailable", detail: "The draft service is unavailable." },
        });
        return;
      }
      const stepId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1)!,
      ) as PropertySetupStepId;
      const body = route.request().postDataJSON() as {
        payload: Record<string, unknown>;
        dirtyFields: PropertySetupStepDraft["dirtyFields"];
        expectedBaseRevisions: PropertySetupStepDraft["baseRevisions"];
      };
      const revision = (draftRevisions.get(stepId) ?? 0) + 1;
      draftRevisions.set(stepId, revision);
      sessionRevision += 1;
      drafts.set(stepId, {
        stepId,
        payload: body.payload,
        dirtyFields: body.dirtyFields,
        baseRevisions: body.expectedBaseRevisions,
        piiClassification: "potential_incidental_pii",
        retentionExpiresAt: "2026-11-01T00:00:00.000Z",
        revision,
        updatedAt: now,
      } as PropertySetupStepDraft);
      draftSteps.push(stepId);
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "property-setup-draft.v1",
          sessionId,
          stepId,
          selectedTracks: ["hotel_operations", "creator_marketplace"],
          trackRevision: 3,
          sessionRevision,
          draftRevision: revision,
          retentionExpiresAt: "2026-11-01T00:00:00.000Z",
          updatedAt: now,
          replayed: false,
        },
      });
    },
  );

  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/steps/present-hotel$`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: presentationRead(profileRevision, profileSummary, coverMediaObjectId),
        });
        return;
      }
      const body = route.request().postDataJSON() as {
        locale: "en";
        shortDescription: string;
        amenities: { reviewed: true; keys: string[] };
        media: { coverMediaObjectId: string | null; galleryMediaObjectIds: string[] };
      };
      profileRevision += 1;
      profileSummary = body.shortDescription;
      coverMediaObjectId = body.media.coverMediaObjectId;
      canonicalWrites.push("present_hotel");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          ...presentationRead(
            profileRevision,
            profileSummary,
            coverMediaObjectId,
            body.amenities.keys,
          ),
          outcome: "updated",
        },
      });
    },
  );

  await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    if (new URL(route.request().url()).pathname.endsWith("/finalize")) {
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "platform-media-upload.v2",
          mediaObjects: [
            {
              mediaObjectId,
              purpose: "property.gallery_image",
              status: "private_ready",
              publicVariants: [],
            },
          ],
        },
      });
      return;
    }
    const body = route.request().postDataJSON() as { resource: { resourceId: string } };
    uploadResources.push(body.resource.resourceId);
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        contractVersion: "platform-media-upload.v2",
        uploadSession: { sessionId: "upload-1", status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: "target-1",
            clientFileId: "file_1",
            method: "PUT",
            uploadUrl: "https://uploads.vayada.localhost/hotel.jpg",
            headers: { "content-type": "image/jpeg" },
          },
        ],
      },
    });
  });

  await page.route(
    new RegExp(`/api/marketplace/properties/${propertyId}/hotel-collaboration-preferences$`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          headers: corsHeaders(route),
          json: preferencesRead(preferencesRevision, preferences),
        });
        return;
      }
      preferences = route.request().postDataJSON() as Record<string, unknown>;
      delete preferences.expectedRevision;
      preferencesRevision += 1;
      canonicalWrites.push("marketplace_preferences");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          ...preferencesRead(preferencesRevision, preferences),
          outcome: "updated",
          acceptedAt: now,
        },
      });
    },
  );

  await page.route(
    new RegExp(`/api/booking/properties/${propertyId}/booking-design/readiness$`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      readinessReads += 1;
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json:
          designRevision === 0
            ? {
                outcome: "blocked",
                organizationId,
                propertyId,
                blocker: { code: "booking_design_missing", evidencePort: "design" },
              }
            : designReadiness(profileRevision, designRevision, designChoices, coverMediaObjectId),
      });
    },
  );

  await page.route(
    new RegExp(`/api/booking/properties/${propertyId}/booking-design$`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      if (route.request().method() === "GET") {
        await route.fulfill(
          designRevision === 0
            ? {
                status: 404,
                headers: corsHeaders(route),
                json: { code: "booking_design_not_configured" },
              }
            : {
                status: 200,
                headers: corsHeaders(route),
                json: designRead(designRevision, designChoices),
              },
        );
        return;
      }
      const body = route.request().postDataJSON() as {
        primaryColor: BookingDesignPrimaryColor;
        fontPairing: BookingDesignFontPairing;
      };
      designRevision += 1;
      designChoices = { primaryColor: body.primaryColor, fontPairing: body.fontPairing };
      canonicalWrites.push("booking_design");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: { outcome: "created", design: designRead(designRevision, designChoices) },
      });
    },
  );

  return {
    draftSteps,
    canonicalWrites,
    uploadResources,
    legacyCalls,
    get readinessReads() {
      return readinessReads;
    },
    get failNextDraft() {
      return failNextDraft;
    },
    set failNextDraft(value: DraftFailure) {
      failNextDraft = value;
    },
  };
}

function currentManifest(
  stepId: PropertySetupStepId,
  revisions: { profileRevision: number; preferencesRevision: number; designRevision: number },
  fallback: Record<string, string>,
): Record<string, string> {
  switch (stepId) {
    case "present_hotel":
      return {
        "hotel_catalog.profile": `profile:${revisions.profileRevision}`,
        "hotel_catalog.media": `profile:${revisions.profileRevision}`,
        "hotel_catalog.amenities": `profile:${revisions.profileRevision}`,
      };
    case "marketplace_preferences":
      return {
        "marketplace.collaboration_preferences": `preferences:${revisions.preferencesRevision}`,
      };
    case "booking_design":
      return {
        "booking.design": `design:${revisions.designRevision}`,
        "hotel_catalog.profile": `profile:${revisions.profileRevision}`,
        "hotel_catalog.media": `profile:${revisions.profileRevision}`,
      };
    default:
      return { ...fallback };
  }
}

function presentationRead(
  revision: number,
  shortDescription: string | null,
  cover: string | null,
  amenityKeys: string[] = [],
) {
  return {
    contractVersion: "hotel-catalog-step1.v1",
    propertyId,
    displayName: "Canal House",
    profileRevision: revision,
    supportedLocales: ["de", "en"],
    profile: {
      locale: "en",
      shortDescription,
      publicSlug: shortDescription ? "canal-house" : null,
      amenities: { reviewed: shortDescription !== null, keys: amenityKeys },
      media: { coverMediaObjectId: cover, galleryMediaObjectIds: [] },
    },
    baseRevisions: {
      "hotel_catalog.profile": `profile:${revision}`,
      "hotel_catalog.media": `profile:${revision}`,
      "hotel_catalog.amenities": `profile:${revision}`,
    },
  };
}

function preferencesRead(revision: number, value: Record<string, unknown> | null) {
  return {
    contractVersion: "marketplace-hotel-collaboration-preferences.v1",
    propertyId,
    revision,
    sourceRevision: `preferences:${revision}`,
    preferences: value,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(
      propertyId,
      revision,
      value as never,
    ),
  };
}

function designRead(
  revision: number,
  choices: { primaryColor: BookingDesignPrimaryColor; fontPairing: BookingDesignFontPairing },
) {
  return {
    contractVersion: "booking-design.v1",
    propertyId,
    revision,
    choices,
    createdAt: now,
  };
}

function designReadiness(
  profileRevision: number,
  designRevision: number,
  choices: { primaryColor: BookingDesignPrimaryColor; fontPairing: BookingDesignFontPairing },
  cover: string | null,
) {
  const designSource = {
    ownerDomain: "booking",
    entityType: "design_revision",
    entityId: propertyId,
    revision: `design:${designRevision}`,
  } as const;
  const sources = [
    designSource,
    {
      ownerDomain: "hotel_catalog",
      entityType: "property_media_assignment",
      entityId: propertyId,
      revision: `profile:${profileRevision}`,
    },
    {
      ownerDomain: "hotel_catalog",
      entityType: "property_profile",
      entityId: propertyId,
      revision: `profile:${profileRevision}`,
    },
    ...(cover
      ? [
          {
            ownerDomain: "hotel_catalog" as const,
            entityType: "property_safe_media",
            entityId: cover,
            revision: "media:1",
          },
        ]
      : []),
  ];
  const pairing =
    choices.fontPairing === "modern-minimalist"
      ? { heading: "'Inter', sans-serif", body: "'Inter', sans-serif" }
      : { heading: "'Playfair Display', serif", body: "'Source Sans Pro', sans-serif" };
  return {
    outcome: "ready",
    organizationId,
    propertyId,
    designSource,
    snapshot: {
      contractVersion: "booking-design-renderer.v1",
      organizationId,
      propertyId,
      sourceBindings: sources,
      appearance: {
        primaryColor: choices.primaryColor,
        fontPairing: choices.fontPairing,
        headingFontFamily: pairing.heading,
        bodyFontFamily: pairing.body,
        button: createBookingDesignButtonColors(choices.primaryColor),
      },
      profile: { displayName: "Canal House", contentLocale: "en", shortDescription: summary },
      cover: cover
        ? {
            kind: "safe_media",
            mediaObjectId: cover,
            altText: "Canal House exterior",
            publicVariants: [
              {
                variantName: "original_safe",
                publicUrl: `https://media.example/${cover}/original.webp`,
              },
            ],
          }
        : { kind: "fallback", path: "/vayada-logo.png" },
    },
  };
}

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
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({ status: 200, headers: corsHeaders(route), json: null });
  });
  await page.route(/\/auth\/session(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        accessToken: "test-access-token",
        csrfToken: "test-csrf-token",
        organizationId,
        organizationKind: "hotel_group",
        user: {
          id: "user-hotel-owner",
          email: "owner@example.com",
          name: "Hotel Owner",
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/owner.webp",
          profilePictureMediaObjectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          status: "active",
        },
      },
    });
  });
}

function setupUrl(baseURL: string | undefined, step?: PropertySetupStepId) {
  const query = new URLSearchParams({
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo: "/marketplace",
    propertyId,
    _adaptive: "1",
  });
  if (step) query.set("step", step);
  if (!baseURL) return `/setup?${query.toString()}`;
  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}
