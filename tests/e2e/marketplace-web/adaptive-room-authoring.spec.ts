import { expect, test, type Page } from "@playwright/test";
import type { PropertySetupRouteReadModel, PropertySetupStepDraft } from "@vayada/domain-hotels";

import { createPropertySetupRouteMock } from "../support/propertySetupRouteMocks";
import { watchPageHealth } from "../support/pageHealth";
import { corsHeaders, fulfillCorsPreflight } from "./utils/cors";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const roomTypeIds = [
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
];
const mediaObjectIds = [
  "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
];
const now = "2026-08-03T12:00:00.000Z";

test.describe("adaptive room authoring", () => {
  test.describe.configure({ timeout: 120_000 });

  test("authors, resumes, and safely removes multiple typed rooms without pricing traffic", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    const routeState = await mockRoute(page, () => routeWithRoomsDraft(emptyRoomsDraft()));
    const owner = await mockRoomOwnerApis(page);

    await page.goto(setupUrl(baseURL));
    await expect(
      page.getByRole("heading", { name: "Add your room types", level: 1 }),
    ).toBeVisible();
    await expect(page.getByText("Checking saved room details...")).toHaveCount(0);
    const assertHealthy = watchPageHealth(page, testInfo);
    await fillCoreRoom(page, "Garden Suite", "3", "2");
    await page.getByLabel("No additional room amenities apply.").check();
    await uploadPhoto(page, "garden-suite.jpg");
    await page.getByRole("button", { name: "Save and add another" }).click();

    await expect(page.getByRole("heading", { name: "Garden Suite", level: 3 })).toBeVisible();
    await fillCoreRoom(page, "Courtyard Twin", "2", "2");
    await page.getByRole("button", { name: "Wi-Fi" }).click();
    await uploadPhoto(page, "courtyard-twin.jpg");
    await page.getByRole("button", { name: "Save and add another" }).click();

    const savedRooms = page.getByRole("heading", { level: 3 });
    await expect(savedRooms.filter({ hasText: "Garden Suite" })).toBeVisible();
    await expect(savedRooms.filter({ hasText: "Courtyard Twin" })).toBeVisible();
    await page.getByRole("button", { name: "Discard blank room" }).click();
    const courtyardCard = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name: "Courtyard Twin" }) });
    await courtyardCard.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("button", { name: "Remove room type" }).click();
    await expect(page.getByRole("dialog", { name: "Remove this room type?" })).toContainText(
      /operational references/i,
    );
    await page.getByRole("dialog").getByRole("button", { name: "Remove room type" }).click();

    await expect(page.getByRole("heading", { name: "Courtyard Twin", level: 3 })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Garden Suite", level: 3 })).toBeVisible();
    expect(owner.createdDraftIds).toHaveLength(2);
    expect(new Set(owner.createdDraftIds).size).toBe(2);
    expect(owner.mediaTargets).toEqual(roomTypeIds);
    expect(owner.draftWrites).toBeGreaterThanOrEqual(4);
    expect(owner.events.indexOf("draft")).toBeLessThan(owner.events.indexOf("facts:create"));
    expect(owner.events).toContain("units:reconcile");
    expect(owner.events).toContain("media:assign");
    expect(owner.events).toContain("amenities:confirm-empty");
    expect(owner.events.join(" ")).not.toMatch(/pricing|calendar/);
    expect(routeState.reads).toBe(1);
    await assertHealthy();
  });

  test("retains first-visit values and exits only after a refreshed exact manifest", async ({
    page,
    baseURL,
  }, testInfo) => {
    await primeBrowserState(page);
    await mockAuthSession(page);
    let manifestAvailable = false;
    const routeState = await mockRoute(page, () =>
      routeWithRoomsDraft(manifestAvailable ? emptyRoomsDraft() : null),
    );
    const owner = await mockRoomOwnerApis(page);

    await page.goto(setupUrl(baseURL));
    const name = page.getByLabel("Room type name");
    await expect(name).toBeVisible();
    await expect(page.getByText("Checking saved room details...")).toHaveCount(0);
    await name.fill("Locally retained room");
    await expect(
      page.getByRole("heading", { name: "Setup data is still unavailable" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add or arrange photos" })).toBeDisabled();

    expect(owner.draftWrites).toBe(0);
    expect(owner.createdDraftIds).toEqual([]);
    expect(owner.mediaTargets).toEqual([]);

    manifestAvailable = true;
    await page.getByRole("button", { name: "Refresh setup data" }).click();
    await expect(
      page.getByRole("heading", { name: "Setup data is still unavailable" }),
    ).toHaveCount(0);
    await expect(page.getByText("Checking saved room details...")).toHaveCount(0);
    const assertHealthy = watchPageHealth(page, testInfo);
    await expect(name).toHaveValue("Locally retained room");
    await assertHealthy();
    await page.getByRole("button", { name: "Exit setup", exact: true }).click();

    await expect(page).toHaveURL(/\/marketplace$/, { timeout: 60_000 });
    expect(owner.draftWrites).toBe(1);
    expect(owner.lastDraftPayload?.["room.name"]).toEqual(
      expect.objectContaining({ [owner.lastDraftRoomId!]: "Locally retained room" }),
    );
    expect(routeState.reads).toBe(2);
  });

  test("keeps the mobile dialogs keyboard-contained and returns focus without overflow", async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await primeBrowserState(page);
    await mockAuthSession(page);
    await mockRoute(page, () => routeWithRoomsDraft(emptyRoomsDraft()));
    await mockRoomOwnerApis(page);

    await page.goto(setupUrl(baseURL));
    const allAmenities = page.getByRole("button", { name: /View all amenities/ });
    await expect(allAmenities).toBeVisible();
    await expect(page.getByText("Checking saved room details...")).toHaveCount(0);
    const assertHealthy = watchPageHealth(page, testInfo);
    await allAmenities.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "All room amenities" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("checkbox", { name: "Laptop-friendly workspace" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(allAmenities).toBeFocused();

    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(layout.document).toBeLessThanOrEqual(layout.viewport);
    await assertHealthy();
  });
});

async function fillCoreRoom(page: Page, name: string, unitCount: string, maxGuests: string) {
  await page.getByLabel("Room type name").fill(name);
  await page.getByLabel("Number of rooms of this type").fill(unitCount);
  await page.getByLabel("Maximum guests").fill(maxGuests);
  await page.getByRole("radio", { name: "Private bathroom" }).check();
  await page.getByLabel("Bed type").selectOption("king");
}

async function uploadPhoto(page: Page, filename: string) {
  const open = page.getByRole("button", { name: "Add or arrange photos" });
  await expect(open).toBeEnabled();
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Room photos" });
  await dialog.getByLabel("Upload photos").setInputFiles({
    name: filename,
    mimeType: "image/jpeg",
    buffer: Buffer.from([1, 2, 3, 4]),
  });
  await expect(dialog.getByLabel("Room photo 1")).toBeVisible();
  await dialog.getByRole("button", { name: "Close dialog" }).click();
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
          id: "user-room-owner",
          email: "owner@example.com",
          name: "Room Owner",
          phone: "+49 89 123456",
          profilePictureUrl: "https://media.example/owner.webp",
          profilePictureMediaObjectId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          status: "active",
        },
      },
    });
  });
}

async function mockRoute(page: Page, current: () => PropertySetupRouteReadModel) {
  let reads = 0;
  await page.route(
    new RegExp(`/api/hotel-setup/properties/${propertyId}/route(?:\\?|$)`),
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      reads += 1;
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: current() });
    },
  );
  return {
    get reads() {
      return reads;
    },
  };
}

async function mockRoomOwnerApis(page: Page) {
  type OwnerRoom = {
    draftRoomId: string;
    roomTypeId: string;
    facts: Record<string, unknown>;
    roomFactsRevision: number;
    activeUnitCount: number;
    roomUnitsRevision: number;
    mediaObjectIds: string[];
    roomMediaRevision: number;
    amenities: string[] | null;
    roomAmenitiesRevision: number;
  };
  const rooms = new Map<string, OwnerRoom>();
  const events: string[] = [];
  const createdDraftIds: string[] = [];
  const mediaTargets: string[] = [];
  let draftWrites = 0;
  let draftRevision = 4;
  let sessionRevision = 7;
  let lastDraftPayload: Record<string, unknown> | null = null;
  let lastDraftRoomId: string | null = null;

  await page.route(/\/api\/hotel-setup\/properties\/[^/]+\/setup-drafts\/rooms$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const body = route.request().postDataJSON() as { payload: Record<string, unknown> };
    events.push("draft");
    draftWrites += 1;
    draftRevision += 1;
    sessionRevision += 1;
    lastDraftPayload = body.payload;
    lastDraftRoomId =
      Object.keys((body.payload["room.name"] as Record<string, unknown>) ?? {})[0] ?? null;
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        contractVersion: "property-setup-draft.v1",
        sessionId: "22222222-2222-4222-8222-222222222222",
        stepId: "rooms",
        selectedTracks: ["hotel_operations"],
        trackRevision: 3,
        sessionRevision,
        draftRevision,
        retentionExpiresAt: "2026-11-01T00:00:00.000Z",
        updatedAt: now,
        replayed: false,
      },
    });
  });

  await page.route(/\/api\/pms\/properties\/[^/]+\/room-types(?:\?|$)/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: { propertyId, items: [...rooms.values()].map(factsSnapshot) },
      });
      return;
    }
    const body = route.request().postDataJSON() as {
      draftRoomId: string;
      facts: Record<string, unknown>;
    };
    let room = rooms.get(body.draftRoomId);
    if (!room) {
      const index = rooms.size;
      room = {
        draftRoomId: body.draftRoomId,
        roomTypeId: roomTypeIds[index]!,
        facts: body.facts,
        roomFactsRevision: 1,
        activeUnitCount: 0,
        roomUnitsRevision: 1,
        mediaObjectIds: [],
        roomMediaRevision: 1,
        amenities: null,
        roomAmenitiesRevision: 1,
      };
      rooms.set(body.draftRoomId, room);
      createdDraftIds.push(body.draftRoomId);
    }
    events.push("facts:create");
    expect(route.request().headers()["idempotency-key"]).toBe(
      `room-create:${propertyId}:${body.draftRoomId}`,
    );
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        contractVersion: "pms-room-facts.v1",
        outcome: "created",
        roomType: factsSnapshot(room),
        draftRoomBinding: {
          propertyId,
          draftRoomId: body.draftRoomId,
          roomTypeId: room.roomTypeId,
        },
        acceptedAt: now,
      },
    });
  });

  await page.route(
    /\/api\/pms\/properties\/[^/]+\/room-type-bindings\/([^/?]+)$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const draftId = decodeURIComponent(
        new URL(route.request().url()).pathname.split("/").at(-1)!,
      );
      const room = rooms.get(draftId);
      await route.fulfill(
        room
          ? {
              status: 200,
              headers: corsHeaders(route),
              json: { propertyId, draftRoomId: draftId, roomTypeId: room.roomTypeId },
            }
          : { status: 404, headers: corsHeaders(route), json: { detail: "Binding not found" } },
      );
    },
  );

  await page.route(
    /\/api\/pms\/properties\/[^/]+\/room-types\/([^/]+)\/capacity$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const room = roomByType(rooms, route.request().url());
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: capacitySnapshot(room),
      });
    },
  );

  await page.route(
    /\/api\/pms\/properties\/[^/]+\/room-types\/([^/]+)\/physical-units\/reconcile$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const room = roomByType(rooms, route.request().url(), 2);
      const body = route.request().postDataJSON() as { targetActiveUnitCount: number };
      const previous = room.activeUnitCount;
      room.activeUnitCount = body.targetActiveUnitCount;
      room.roomUnitsRevision += 1;
      events.push("units:reconcile");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "pms-room-facts.v1",
          outcome: "reconciled",
          propertyId,
          roomTypeId: room.roomTypeId,
          previousActiveUnitCount: previous,
          capacity: capacitySnapshot(room),
          addedUnits: Array.from({ length: room.activeUnitCount - previous }, (_, index) => ({
            contractVersion: "pms-room-facts.v1",
            propertyId,
            roomTypeId: room.roomTypeId,
            roomUnitId: `eeeeeeee-eeee-4eee-8eee-${String(rooms.size * 100 + index).padStart(12, "0")}`,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          })),
          retiredUnitIds: [],
          acceptedAt: now,
        },
      });
    },
  );

  await page.route(/\/api\/pms\/properties\/[^/]+\/room-types\/([^/]+)\/media$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const room = roomByType(rooms, route.request().url());
    const body = route.request().postDataJSON() as {
      assignments: Array<{ mediaObjectId: string }>;
    };
    room.mediaObjectIds = body.assignments.map(({ mediaObjectId }) => mediaObjectId);
    room.roomMediaRevision += 1;
    events.push("media:assign");
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        contractVersion: "pms-room-publication.v1",
        outcome: "assigned",
        propertyId,
        roomTypeId: room.roomTypeId,
        roomMediaRevision: room.roomMediaRevision,
        assignments: body.assignments,
        acceptedAt: now,
      },
    });
  });

  await page.route(
    /\/api\/pms\/properties\/[^/]+\/room-types\/([^/]+)\/amenities$/,
    async (route) => {
      if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
      const room = roomByType(rooms, route.request().url());
      const body = route.request().postDataJSON() as { amenities: string[] };
      room.amenities = body.amenities;
      room.roomAmenitiesRevision += 1;
      events.push(body.amenities.length === 0 ? "amenities:confirm-empty" : "amenities:confirm");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "pms-room-amenities.v1",
          outcome: "confirmed",
          roomAmenities: {
            contractVersion: "pms-room-amenities.v1",
            propertyId,
            roomTypeId: room.roomTypeId,
            roomAmenitiesRevision: room.roomAmenitiesRevision,
            reviewed: true,
            amenities: body.amenities,
            reviewedAt: now,
          },
          acceptedAt: now,
        },
      });
    },
  );

  await page.route(/\/api\/pms\/properties\/[^/]+\/room-types\/([^/?]+)$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    const room = roomByType(rooms, route.request().url(), 0);
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, headers: corsHeaders(route), json: factsSnapshot(room) });
      return;
    }
    if (route.request().method() === "DELETE") {
      rooms.delete(room.draftRoomId);
      events.push("room:delete");
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "pms-room-facts.v1",
          outcome: "deleted",
          propertyId,
          roomTypeId: room.roomTypeId,
          lifecycle: "inactive",
          deletedRevision: room.roomFactsRevision + 1,
          acceptedAt: now,
        },
      });
      return;
    }
    throw new Error(`Unexpected room facts method ${route.request().method()}`);
  });

  await page.route(/\/api\/pms\/properties\/[^/]+\/room-publication-snapshot$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      json: {
        contractVersion: "pms-room-publication.v1",
        propertyId,
        rooms: [...rooms.values()].map(publicationRoom),
      },
    });
  });

  await page.route(/\/api\/media\/upload-sessions(?:\/[^/]+\/finalize)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") return fulfillCorsPreflight(route);
    if (new URL(route.request().url()).pathname.endsWith("/finalize")) {
      const target = mediaTargets.at(-1)!;
      const mediaObjectId = mediaObjectIds[roomTypeIds.indexOf(target)]!;
      await route.fulfill({
        status: 200,
        headers: corsHeaders(route),
        json: {
          contractVersion: "platform-media-upload.v2",
          mediaObjects: [
            {
              mediaObjectId,
              purpose: "pms.room_type.media",
              status: "private_ready",
              publicVariants: [],
            },
          ],
        },
      });
      return;
    }
    const body = route.request().postDataJSON() as { resource: { targetResourceId: string } };
    expect(body.resource.targetResourceId).not.toMatch(/^draft:/);
    mediaTargets.push(body.resource.targetResourceId);
    await route.fulfill({
      status: 201,
      headers: corsHeaders(route),
      json: {
        contractVersion: "platform-media-upload.v2",
        uploadSession: { sessionId: `upload-${mediaTargets.length}`, status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: `target-${mediaTargets.length}`,
            clientFileId: "file_1",
            method: "PUT",
            uploadUrl: "https://uploads.vayada.localhost/room.jpg",
            headers: { "content-type": "image/jpeg" },
          },
        ],
      },
    });
  });

  return {
    events,
    createdDraftIds,
    mediaTargets,
    get draftWrites() {
      return draftWrites;
    },
    get lastDraftPayload() {
      return lastDraftPayload;
    },
    get lastDraftRoomId() {
      return lastDraftRoomId;
    },
  };
}

function roomByType(rooms: Map<string, { roomTypeId: string }>, url: string, trailingSegments = 1) {
  const segments = new URL(url).pathname.split("/");
  const roomTypeId = segments.at(-1 - trailingSegments)!;
  const room = [...rooms.values()].find((candidate) => candidate.roomTypeId === roomTypeId);
  if (!room) throw new Error(`Unknown room type ${roomTypeId}`);
  return room as ReturnType<typeof ownerRoomShape>;
}

function ownerRoomShape() {
  return {
    draftRoomId: "",
    roomTypeId: "",
    facts: {} as Record<string, unknown>,
    roomFactsRevision: 1,
    activeUnitCount: 0,
    roomUnitsRevision: 1,
    mediaObjectIds: [] as string[],
    roomMediaRevision: 1,
    amenities: null as string[] | null,
    roomAmenitiesRevision: 1,
  };
}

function factsSnapshot(room: ReturnType<typeof ownerRoomShape>) {
  return {
    contractVersion: "pms-room-facts.v1",
    propertyId,
    roomTypeId: room.roomTypeId,
    roomFactsRevision: room.roomFactsRevision,
    lifecycle: "active",
    facts: room.facts,
    createdAt: now,
    updatedAt: now,
  };
}

function capacitySnapshot(room: ReturnType<typeof ownerRoomShape>) {
  return {
    contractVersion: "pms-room-facts.v1",
    propertyId,
    roomTypeId: room.roomTypeId,
    roomUnitsRevision: room.roomUnitsRevision,
    activeUnitCount: room.activeUnitCount,
    capturedAt: now,
  };
}

function publicationRoom(room: ReturnType<typeof ownerRoomShape>) {
  return {
    propertyId,
    roomTypeId: room.roomTypeId,
    facts: room.facts,
    activeUnitCount: room.activeUnitCount,
    media: room.mediaObjectIds.map((mediaObjectId, sortOrder) => ({
      mediaObjectId,
      altText: `Room photo ${sortOrder + 1}`,
      sortOrder,
      publicVariants: [
        {
          variantName: "thumbnail",
          publicUrl: `https://media.example/${mediaObjectId}/thumbnail.webp`,
        },
      ],
    })),
    amenities: room.amenities,
    sourceRevisions: {
      roomFactsRevision: room.roomFactsRevision,
      roomUnitsRevision: room.roomUnitsRevision,
      roomMediaRevision: room.roomMediaRevision,
      roomAmenitiesRevision: room.roomAmenitiesRevision,
    },
  };
}

function routeWithRoomsDraft(
  draft: Extract<PropertySetupStepDraft, { stepId: "rooms" }> | null,
): PropertySetupRouteReadModel {
  const route = createPropertySetupRouteMock({
    propertyId,
    selectedTracks: ["hotel_operations"],
    resumeStepId: "rooms",
  });
  return {
    ...route,
    steps: route.steps.map((step) =>
      step.stepId === "rooms" ? { ...step, state: draft ? "draft" : "not_started", draft } : step,
    ),
  };
}

function emptyRoomsDraft(): Extract<PropertySetupStepDraft, { stepId: "rooms" }> {
  return {
    stepId: "rooms",
    payload: {},
    dirtyFields: [],
    baseRevisions: {
      "pms.room_types": "types:1",
      "pms.room_units": "units:1",
      "pms.room_media": "media:1",
    },
    piiClassification: "potential_incidental_pii",
    retentionExpiresAt: "2026-11-01T00:00:00.000Z",
    revision: 4,
    updatedAt: now,
  };
}

function setupUrl(baseURL: string | undefined) {
  const query = new URLSearchParams({
    entryProduct: "marketplace",
    returnProduct: "marketplace",
    returnTo: "/marketplace",
    propertyId,
    step: "rooms",
    _adaptive: "1",
  });
  if (!baseURL) return `/setup?${query.toString()}`;
  const url = new URL(baseURL);
  if (url.hostname === "127.0.0.1" && url.port === "3000") url.hostname = "localhost";
  url.pathname = "/setup";
  url.search = query.toString();
  return url.toString();
}
