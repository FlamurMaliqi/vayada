import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PMS_ROOM_AMENITIES_CONTRACT_VERSION,
  PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
  createRoomPublicationSnapshot,
  type AssignRoomTypeMediaCommand,
  type AssignRoomTypeMediaResult,
  type ConfirmRoomTypeAmenitiesCommand,
  type ConfirmRoomTypeAmenitiesResult,
  type RoomPublicationSnapshot,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsRoomPublicationRoutes,
  type PmsRoomPublicationRoutesOptions,
} from "./routes/pmsRoomPublication.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherPropertyId = "11111111-1111-4111-8111-111111111111";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const mediaObjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const actorUserId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const now = "2026-08-03T12:00:00.000Z";

type AuthOptions = {
  kind?: "hotel_group" | "creator_workspace";
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};

type FakePorts = PmsRoomPublicationRoutesOptions & {
  mediaCalls: AssignRoomTypeMediaCommand[];
  amenitiesCalls: ConfirmRoomTypeAmenitiesCommand[];
  snapshotCalls: { organizationId: string; propertyId: string }[];
};

describe("PMS room publication routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("derives exact media scope, audit, expected revision, and idempotency", async () => {
    const ports = fakePorts();
    app = await testApp(ports);

    const response = await mediaRequest(app, { key: "  stable-media-key  " });

    expect(response.statusCode).toBe(200);
    expect(ports.mediaCalls).toHaveLength(1);
    expect(ports.mediaCalls[0]).toEqual({
      organizationId,
      propertyId,
      roomTypeId,
      expectedRoomMediaRevision: 3,
      assignments: [{ mediaObjectId, altText: "Garden suite", sortOrder: 0 }],
      idempotencyKey: "stable-media-key",
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: "request-1",
        correlationId: "correlation-1",
        requestedAt: now,
      },
    });
  });

  it("canonicalizes the reviewed amenity set and derives no scope from the body", async () => {
    const ports = fakePorts();
    app = await testApp(ports);

    const response = await amenitiesRequest(app, {
      body: {
        expectedRoomAmenitiesRevision: 1,
        amenities: ["wifi", "air_conditioning"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(ports.amenitiesCalls[0]).toMatchObject({
      organizationId,
      propertyId,
      roomTypeId,
      expectedRoomAmenitiesRevision: 1,
      amenities: ["air_conditioning", "wifi"],
    });
  });

  it("passes the authenticated organization and property into the snapshot port", async () => {
    const ports = fakePorts();
    app = await testApp(ports, { permissions: ["pms.operations.read"] });

    const response = await snapshotRequest(app);

    expect(response.statusCode).toBe(200);
    expect(ports.snapshotCalls).toEqual([{ organizationId, propertyId }]);
    expect(response.body).toMatchObject({
      contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
      propertyId,
      status: "blocked",
    });
  });

  it.each([
    ["media", { expectedRoomMediaRevision: 3, assignments: [], propertyId }],
    ["media", { expectedRoomMediaRevision: 3, assignments: [], organizationId }],
    ["media", { expectedRoomMediaRevision: 3, assignments: [], pricing: {} }],
    ["amenities", { expectedRoomAmenitiesRevision: 1, amenities: [], roomTypeId }],
    ["amenities", { expectedRoomAmenitiesRevision: 1, amenities: [], calendar: {} }],
  ] as const)("rejects smuggled %s command fields", async (kind, body) => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response =
      kind === "media" ? await mediaRequest(app, { body }) : await amenitiesRequest(app, { body });
    expect(response.statusCode).toBe(400);
    expect([...ports.mediaCalls, ...ports.amenitiesCalls]).toHaveLength(0);
  });

  it("requires bounded idempotency and authorizes before malformed JSON parsing", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    expect((await mediaRequest(app, { key: null })).statusCode).toBe(400);
    const unauthenticated = await app.inject({
      method: "PUT",
      url: `/properties/${propertyId}/room-types/${roomTypeId}/media`,
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(ports.mediaCalls).toHaveLength(0);
  });

  it.each([
    ["missing authentication", {}, null],
    ["non-hotel organization", { kind: "creator_workspace" }, "valid-token"],
    ["missing read permission", { permissions: ["pms.operations.manage"] }, "valid-token"],
    ["missing entitlement", { entitlements: [] }, "valid-token"],
    ["suspended entitlement", { entitlements: [entitlement("suspended")] }, "valid-token"],
    ["missing resource link", { links: [] }, "valid-token"],
    ["wrong property link", { links: [link({ resourceId: otherPropertyId })] }, "valid-token"],
  ] as const)("denies snapshot reads for %s", async (_label, auth, token) => {
    const ports = fakePorts();
    app = await testApp(ports, auth as AuthOptions);
    const response = await snapshotRequest(app, token);
    expect([401, 403]).toContain(response.statusCode);
    expect(ports.snapshotCalls).toHaveLength(0);
  });

  it("requires manage permission for mutations while preserving linked front-desk access", async () => {
    const deniedPorts = fakePorts();
    app = await testApp(deniedPorts, { permissions: ["pms.operations.read"] });
    expect((await mediaRequest(app)).statusCode).toBe(403);
    await app.close();

    const allowedPorts = fakePorts();
    app = await testApp(allowedPorts, { links: [link({ relationship: "front_desk" })] });
    expect((await mediaRequest(app)).statusCode).toBe(200);
    expect((await amenitiesRequest(app)).statusCode).toBe(200);
    expect(allowedPorts.mediaCalls).toHaveLength(1);
    expect(allowedPorts.amenitiesCalls).toHaveLength(1);
  });

  it.each([
    ["media not found", "media", { code: "media_not_found", mediaObjectIds: [mediaObjectId] }, 404],
    ["media not ready", "media", { code: "media_not_ready", mediaObjectIds: [mediaObjectId] }, 422],
    ["media revision", "media", { code: "room_media_revision_conflict", currentRevision: 5 }, 409],
    [
      "amenity vocabulary",
      "amenities",
      { code: "unsupported_room_amenity_keys", unsupportedAmenityKeys: ["unknown"] },
      422,
    ],
    ["amenity scope", "amenities", { code: "setup_scope_unavailable" }, 404],
  ] as const)("maps %s without widening the result", async (_label, kind, error, status) => {
    const ports = fakePorts({
      mediaResult: { ok: false, error } as AssignRoomTypeMediaResult,
      amenitiesResult: { ok: false, error } as ConfirmRoomTypeAmenitiesResult,
    });
    app = await testApp(ports);
    const response = kind === "media" ? await mediaRequest(app) : await amenitiesRequest(app);
    expect(response.statusCode).toBe(status);
    expect(response.body).toEqual(error);
  });

  it("fails closed when a port returns a cross-property result", async () => {
    const ports = fakePorts({ responsePropertyId: otherPropertyId });
    app = await testApp(ports);
    expect((await mediaRequest(app)).statusCode).toBe(500);
    expect((await amenitiesRequest(app)).statusCode).toBe(500);
    expect((await snapshotRequest(app)).statusCode).toBe(500);
  });

  it("rejects successful command results that do not exactly match the accepted command", async () => {
    const ports = fakePorts({ responseAssignments: [], responseAmenities: ["wifi"] });
    app = await testApp(ports);

    expect((await mediaRequest(app)).statusCode).toBe(500);
    expect((await amenitiesRequest(app)).statusCode).toBe(500);
  });

  it("rejects extra nested fields instead of serializing a private port payload", async () => {
    const unsafe = structuredClone(
      createRoomPublicationSnapshot({ organizationId, propertyId, rooms: [] }),
    ) as RoomPublicationSnapshot & {
      blockers: Array<Record<string, unknown>>;
    };
    unsafe.blockers[0]!["privateStorageKey"] = "tenant/private/original.jpg";
    const ports = fakePorts({ snapshotResult: unsafe });
    app = await testApp(ports);

    const response = await snapshotRequest(app);

    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("privateStorageKey");
    expect(JSON.stringify(response.body)).not.toContain("original.jpg");
  });

  it("rejects semantically incomplete ready snapshots and thumbnail-only media", async () => {
    const emptyReady = structuredClone(
      createRoomPublicationSnapshot({ organizationId, propertyId, rooms: [] }),
    ) as unknown as { status: "ready"; blockers: unknown[] } & RoomPublicationSnapshot;
    emptyReady.status = "ready";
    emptyReady.blockers = [];
    const emptyPorts = fakePorts({ snapshotResult: emptyReady });
    app = await testApp(emptyPorts);
    expect((await snapshotRequest(app)).statusCode).toBe(500);
    await app.close();

    const thumbnailOnly = {
      contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
      propertyId,
      status: "ready",
      rooms: [
        {
          propertyId,
          roomTypeId,
          facts: {
            name: "Garden Suite",
            description: "A calm suite.",
            category: null,
            occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
            beds: [{ type: "queen", quantity: 1 }],
            bedrooms: 1,
            bathrooms: 1,
            bathroomType: "private",
            size: { value: 28, unit: "sqm" },
          },
          activeUnitCount: 1,
          media: [
            {
              mediaObjectId,
              altText: "Garden suite",
              sortOrder: 0,
              publicVariants: [
                {
                  variantName: "thumbnail",
                  publicUrl: `https://images.vayada.com/media/${mediaObjectId}/thumbnail/v1.webp`,
                },
              ],
            },
          ],
          amenities: ["wifi"],
          sourceRevisions: {
            roomFactsRevision: 1,
            roomUnitsRevision: 1,
            roomMediaRevision: 1,
            roomAmenitiesRevision: 2,
          },
          sourceRevision: "room-source",
        },
      ],
      blockers: [],
      sourceRevision: "property-source",
    } as unknown as RoomPublicationSnapshot;
    const mediaPorts = fakePorts({ snapshotResult: thumbnailOnly });
    app = await testApp(mediaPorts);
    expect((await snapshotRequest(app)).statusCode).toBe(500);
  });

  it("rejects forged property revisions and noncanonical blocker ordering", async () => {
    const forgedRevision = structuredClone(
      createRoomPublicationSnapshot({ organizationId, propertyId, rooms: [] }),
    ) as unknown as {
      sourceRevision: string;
      blockers: Array<{ sourceRevision: string }>;
    } & RoomPublicationSnapshot;
    forgedRevision.sourceRevision = "forged";
    forgedRevision.blockers[0]!.sourceRevision = "forged";
    app = await testApp(fakePorts({ snapshotResult: forgedRevision }));
    expect((await snapshotRequest(app)).statusCode).toBe(500);
    await app.close();

    const roomSourceRevision = "room-source";
    const reversedBlockers = {
      contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
      propertyId,
      status: "blocked",
      rooms: [
        {
          propertyId,
          roomTypeId,
          facts: {
            name: "Garden Suite",
            description: "A calm suite.",
            category: null,
            occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
            beds: [{ type: "queen", quantity: 1 }],
            bedrooms: 1,
            bathrooms: 1,
            bathroomType: "private",
            size: { value: 28, unit: "sqm" },
          },
          activeUnitCount: 0,
          media: [],
          amenities: null,
          sourceRevisions: {
            roomFactsRevision: 1,
            roomUnitsRevision: 1,
            roomMediaRevision: 1,
            roomAmenitiesRevision: 1,
          },
          sourceRevision: roomSourceRevision,
        },
      ],
      blockers: [
        {
          code: "room_units_required",
          product: "pms",
          ownerDomain: "pms",
          owningStepId: "rooms",
          affectedEntity: { entityType: "room_type", entityId: roomTypeId },
          message: "Add at least one unit for this room type before publishing.",
          kind: "user_fixable",
          sourceRevision: roomSourceRevision,
        },
        {
          code: "room_photo_required",
          product: "pms",
          ownerDomain: "pms",
          owningStepId: "rooms",
          affectedEntity: { entityType: "room_type", entityId: roomTypeId },
          message: "Add at least one room photo before publishing.",
          kind: "user_fixable",
          sourceRevision: roomSourceRevision,
        },
        {
          code: "room_amenities_review_required",
          product: "pms",
          ownerDomain: "pms",
          owningStepId: "rooms",
          affectedEntity: { entityType: "room_type", entityId: roomTypeId },
          message: "Review this room's amenities before publishing.",
          kind: "user_fixable",
          sourceRevision: roomSourceRevision,
        },
      ],
      sourceRevision: JSON.stringify([[roomTypeId, roomSourceRevision]]),
    } as unknown as RoomPublicationSnapshot;
    app = await testApp(fakePorts({ snapshotResult: reversedBlockers }));
    expect((await snapshotRequest(app)).statusCode).toBe(500);
  });
});

function fakePorts(
  options: {
    mediaResult?: AssignRoomTypeMediaResult;
    amenitiesResult?: ConfirmRoomTypeAmenitiesResult;
    responsePropertyId?: string;
    responseAssignments?: readonly {
      mediaObjectId: string;
      altText: string | null;
      sortOrder: number;
    }[];
    responseAmenities?: readonly string[];
    snapshotResult?: RoomPublicationSnapshot;
  } = {},
): FakePorts {
  const mediaCalls: AssignRoomTypeMediaCommand[] = [];
  const amenitiesCalls: ConfirmRoomTypeAmenitiesCommand[] = [];
  const snapshotCalls: { organizationId: string; propertyId: string }[] = [];
  const responsePropertyId = options.responsePropertyId ?? propertyId;
  return {
    mediaCalls,
    amenitiesCalls,
    snapshotCalls,
    mediaCommandPort: {
      async assignRoomTypeMedia(command) {
        mediaCalls.push(command);
        return (
          options.mediaResult ?? {
            ok: true,
            response: {
              contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
              outcome: "assigned",
              propertyId: responsePropertyId,
              roomTypeId,
              roomMediaRevision: command.expectedRoomMediaRevision + 1,
              assignments: options.responseAssignments ?? command.assignments,
              acceptedAt: now,
            },
          }
        );
      },
    },
    amenitiesCommandPort: {
      async confirmRoomTypeAmenities(command) {
        amenitiesCalls.push(command);
        return (
          options.amenitiesResult ?? {
            ok: true,
            response: {
              contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
              outcome: "confirmed",
              roomAmenities: {
                contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
                propertyId: responsePropertyId,
                roomTypeId,
                roomAmenitiesRevision: command.expectedRoomAmenitiesRevision + 1,
                reviewed: true,
                amenities: (options.responseAmenities ??
                  command.amenities) as ConfirmRoomTypeAmenitiesCommand["amenities"],
                reviewedAt: now,
              },
              acceptedAt: now,
            },
          }
        );
      },
    },
    snapshotPort: {
      async getRoomPublicationSnapshot(input) {
        snapshotCalls.push(input);
        return (
          options.snapshotResult ??
          createRoomPublicationSnapshot({
            organizationId,
            propertyId: responsePropertyId,
            rooms: [],
          })
        );
      },
    },
  };
}

async function testApp(ports: FakePorts, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId, kind: auth.kind ?? "hotel_group" },
      membership: {
        permissions: auth.permissions ?? ["pms.operations.read", "pms.operations.manage"],
      },
      linkedResources: auth.links ?? [link()],
      entitlements: auth.entitlements ?? [entitlement()],
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: now,
      },
    } as RequestContext;
  });
  await app.register(registerPmsRoomPublicationRoutes, ports);
  return app;
}

function entitlement(
  status: ProductEntitlement["status"] = "active",
  resourceId = propertyId,
): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status,
    resource: { product: "pms", resourceType: "pms_property", resourceId },
  };
}

function link(overrides: Partial<LinkedResource> = {}): LinkedResource {
  return {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
    relationship: "operator",
    status: "active",
    ...overrides,
  };
}

async function mediaRequest(
  app: Awaited<ReturnType<typeof testApp>>,
  options: { body?: unknown; key?: string | null } = {},
) {
  const headers: Record<string, string> = { authorization: "Bearer valid-token" };
  if (options.key !== null) headers["idempotency-key"] = options.key ?? "media-key";
  return injectJson<Record<string, unknown>>(app, {
    method: "PUT",
    url: `/properties/${propertyId}/room-types/${roomTypeId}/media`,
    headers,
    payload: options.body ?? {
      expectedRoomMediaRevision: 3,
      assignments: [{ mediaObjectId, altText: "Garden suite", sortOrder: 0 }],
    },
  });
}

async function amenitiesRequest(
  app: Awaited<ReturnType<typeof testApp>>,
  options: { body?: unknown; key?: string | null } = {},
) {
  const headers: Record<string, string> = { authorization: "Bearer valid-token" };
  if (options.key !== null) headers["idempotency-key"] = options.key ?? "amenities-key";
  return injectJson<Record<string, unknown>>(app, {
    method: "PUT",
    url: `/properties/${propertyId}/room-types/${roomTypeId}/amenities`,
    headers,
    payload: options.body ?? { expectedRoomAmenitiesRevision: 1, amenities: [] },
  });
}

async function snapshotRequest(
  app: Awaited<ReturnType<typeof testApp>>,
  token: string | null = "valid-token",
) {
  return injectJson<Record<string, unknown>>(app, {
    method: "GET",
    url: `/properties/${propertyId}/room-publication-snapshot`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
