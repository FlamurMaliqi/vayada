import { request as httpRequest } from "node:http";

import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseDraftRoomId,
  parseRoomTypeFacts,
  type CreateRoomTypeFactsCommand,
  type CreateRoomTypeFactsResult,
  type SafeDeleteRoomTypeCommand,
  type SafeDeleteRoomTypeResult,
  type UpdateRoomTypeFactsCommand,
  type UpdateRoomTypeFactsResult,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsRoomFactsRoutes,
  type PmsRoomFactsRoutesOptions,
} from "./routes/pmsRoomFacts.js";

const propertyId = "f6853000-0000-4000-8000-000000000001";
const otherPropertyId = "f6853000-0000-4000-8000-000000000002";
const roomTypeId = "a6853000-0000-4000-8000-000000000001";
const roomUnitId = "b6853000-0000-4000-8000-000000000001";
const organizationId = "11111111-1111-4111-8111-111111111111";
const actorUserId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-03T12:00:00.000Z";
const draftRoomId = parseDraftRoomId("setup-room-1")!;

type AuthOptions = {
  kind?: "hotel_group" | "creator_workspace";
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};
type FakePorts = PmsRoomFactsRoutesOptions & {
  createCalls: CreateRoomTypeFactsCommand[];
  updateCalls: UpdateRoomTypeFactsCommand[];
  deleteCalls: SafeDeleteRoomTypeCommand[];
  reads: Array<readonly unknown[]>;
};

function facts(name = "Garden Suite") {
  const parsed = parseRoomTypeFacts({
    name,
    description: "A quiet suite",
    category: "suite",
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 0 },
    beds: [{ type: "queen", quantity: 1 }],
    bedrooms: 1,
    bathrooms: 1,
    bathroomType: "private",
    size: { value: 28, unit: "sqm" },
  });
  if (!parsed) throw new Error("Invalid room-facts fixture");
  return parsed;
}

function snapshot(
  revision = 1,
  overrides: Partial<{
    propertyId: string;
    roomTypeId: string;
    lifecycle: "active" | "inactive";
  }> = {},
) {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId: overrides.propertyId ?? propertyId,
    roomTypeId: overrides.roomTypeId ?? roomTypeId,
    roomFactsRevision: revision,
    lifecycle: overrides.lifecycle ?? "active",
    facts: facts(),
    createdAt: now,
    updatedAt: now,
  } as const;
}

function fakePorts(
  overrides: {
    createResult?: CreateRoomTypeFactsResult;
    updateResult?: UpdateRoomTypeFactsResult;
    deleteResult?: SafeDeleteRoomTypeResult;
    readPropertyId?: string;
    missing?: boolean;
  } = {},
): FakePorts {
  const createCalls: CreateRoomTypeFactsCommand[] = [];
  const updateCalls: UpdateRoomTypeFactsCommand[] = [];
  const deleteCalls: SafeDeleteRoomTypeCommand[] = [];
  const reads: Array<readonly unknown[]> = [];
  const responsePropertyId = overrides.readPropertyId ?? propertyId;
  return {
    createCalls,
    updateCalls,
    deleteCalls,
    reads,
    commandPort: {
      async createRoomTypeFacts(command) {
        createCalls.push(command);
        return (
          overrides.createResult ?? {
            ok: true,
            response: {
              contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
              outcome: "created",
              roomType: { ...snapshot(), facts: command.facts },
              draftRoomBinding: {
                propertyId,
                draftRoomId: command.draftRoomId,
                roomTypeId,
              },
              acceptedAt: now,
            },
          }
        );
      },
      async updateRoomTypeFacts(command) {
        updateCalls.push(command);
        return (
          overrides.updateResult ?? {
            ok: true,
            response: {
              contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
              outcome: "updated",
              roomType: {
                ...snapshot(command.expectedRevision + 1),
                facts: command.facts,
              },
              acceptedAt: now,
            },
          }
        );
      },
      async safeDeleteRoomType(command) {
        deleteCalls.push(command);
        return (
          overrides.deleteResult ?? {
            ok: true,
            response: {
              contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
              outcome: "deleted",
              propertyId,
              roomTypeId,
              lifecycle: "inactive",
              deletedRevision: command.expectedRevision + 1,
              acceptedAt: now,
            },
          }
        );
      },
    },
    factsReadPort: {
      async getRoomTypeFacts(requestPropertyId, requestRoomTypeId) {
        reads.push(["facts", requestPropertyId, requestRoomTypeId]);
        return overrides.missing
          ? null
          : snapshot(1, { propertyId: responsePropertyId, roomTypeId: requestRoomTypeId });
      },
      async listRoomTypeFacts(requestPropertyId) {
        reads.push(["list", requestPropertyId]);
        return [snapshot(1, { propertyId: responsePropertyId })];
      },
    },
    bindingReadPort: {
      async getDraftRoomTypeBinding(requestPropertyId, requestDraftRoomId) {
        reads.push(["binding", requestPropertyId, requestDraftRoomId]);
        return overrides.missing
          ? null
          : { propertyId: responsePropertyId, draftRoomId: requestDraftRoomId, roomTypeId };
      },
    },
    unitReadPort: {
      async listPhysicalRoomUnitIdentities(requestPropertyId, requestRoomTypeId) {
        reads.push(["units", requestPropertyId, requestRoomTypeId]);
        return [
          {
            contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
            propertyId: responsePropertyId,
            roomTypeId: requestRoomTypeId,
            roomUnitId,
            lifecycle: "active",
            operationalLabel: null,
            operationalLabelStatus: "unverified",
          },
        ];
      },
    },
    capacityReadPort: {
      async getRoomTypeCapacity(requestPropertyId, requestRoomTypeId) {
        reads.push(["capacity", requestPropertyId, requestRoomTypeId]);
        return overrides.missing
          ? null
          : {
              contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
              propertyId: responsePropertyId,
              roomTypeId: requestRoomTypeId,
              roomUnitsRevision: 1,
              activeUnitCount: 1,
              capturedAt: now,
            };
      },
    },
  };
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
  await app.register(registerPmsRoomFactsRoutes, ports);
  return app;
}

async function commandRequest(
  app: Awaited<ReturnType<typeof testApp>>,
  method: "POST" | "PUT" | "DELETE",
  options: { body?: unknown; key?: string | null; targetPropertyId?: string } = {},
) {
  const headers: Record<string, string> = { authorization: "Bearer valid-token" };
  if (options.key !== null) headers["idempotency-key"] = options.key ?? "room-facts-key";
  const url =
    method === "POST"
      ? `/properties/${options.targetPropertyId ?? propertyId}/room-types`
      : `/properties/${options.targetPropertyId ?? propertyId}/room-types/${roomTypeId}`;
  const defaultBody =
    method === "POST"
      ? { draftRoomId, expectedRevision: 0, facts: facts() }
      : method === "PUT"
        ? { expectedRevision: 1, facts: facts("Updated Suite") }
        : { expectedRevision: 1 };
  return injectJson<Record<string, unknown>>(app, {
    method,
    url,
    headers,
    payload: options.body ?? defaultBody,
  });
}

async function postWithRepeatedIdempotencyKeys(
  app: Awaited<ReturnType<typeof testApp>>,
): Promise<{ statusCode: number }> {
  const payload = JSON.stringify({ draftRoomId, expectedRevision: 0, facts: facts() });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "POST",
        path: `/properties/${propertyId}/room-types`,
        headers: {
          authorization: "Bearer valid-token",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "idempotency-key": ["first", "second"],
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0 }));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

describe("PMS room-facts routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("derives create scope, audit, and a trimmed idempotency key before delegating", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await commandRequest(app, "POST", { key: "  stable-key  " });
    expect(response.statusCode).toBe(201);
    expect(ports.createCalls).toHaveLength(1);
    expect(ports.createCalls[0]).toMatchObject({
      organizationId,
      propertyId,
      draftRoomId,
      expectedRevision: 0,
      idempotencyKey: "stable-key",
      audit: {
        actor: { kind: "user", userId: actorUserId },
        requestId: "request-1",
        correlationId: "correlation-1",
        requestedAt: now,
      },
    });
  });

  it("updates and safe-deletes facts using only route identity and optimistic revision", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const update = await commandRequest(app, "PUT");
    const remove = await commandRequest(app, "DELETE");
    expect([update.statusCode, remove.statusCode]).toEqual([200, 200]);
    expect(ports.updateCalls[0]).toMatchObject({ propertyId, roomTypeId, expectedRevision: 1 });
    expect(ports.deleteCalls[0]).toMatchObject({ propertyId, roomTypeId, expectedRevision: 1 });
  });

  it.each([
    ["organizationId", organizationId],
    ["propertyId", otherPropertyId],
    ["roomTypeId", roomTypeId],
    ["idempotencyKey", "smuggled"],
    ["actorUserId", actorUserId],
    ["unitCount", 4],
    ["media", []],
    ["pricing", {}],
    ["calendar", {}],
  ])("rejects a smuggled create %s field", async (key, value) => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await commandRequest(app, "POST", {
      body: { draftRoomId, expectedRevision: 0, facts: facts(), [key]: value },
    });
    expect(response.statusCode).toBe(400);
    expect(ports.createCalls).toHaveLength(0);
  });

  it.each([null, "   ", "x".repeat(201)])(
    "requires exactly one bounded Idempotency-Key (%s)",
    async (key) => {
      const ports = fakePorts();
      app = await testApp(ports);
      const response = await commandRequest(app, "POST", { key });
      expect(response.statusCode).toBe(400);
      expect(ports.createCalls).toHaveLength(0);
    },
  );

  it("rejects repeated Idempotency-Key headers", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await postWithRepeatedIdempotencyKeys(app);
    expect(response.statusCode).toBe(400);
    expect(ports.createCalls).toHaveLength(0);
  });

  it.each([
    ["PUT", { expectedRevision: 1, facts: facts(), roomTypeId }],
    ["DELETE", { expectedRevision: 1, facts: facts() }],
  ] as const)("rejects smuggled %s body fields", async (method, body) => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await commandRequest(app, method, { body });
    expect(response.statusCode).toBe(400);
    expect([...ports.updateCalls, ...ports.deleteCalls]).toHaveLength(0);
  });

  it("authorizes in onRequest before malformed JSON is parsed", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await app.inject({
      method: "POST",
      url: `/properties/${propertyId}/room-types`,
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    expect(response.statusCode).toBe(401);
    expect(ports.createCalls).toHaveLength(0);
  });

  it.each([
    ["missing authentication", {}, null],
    ["non-hotel organization", { kind: "creator_workspace" }, "valid-token"],
    ["missing read permission", { permissions: ["pms.operations.manage"] }, "valid-token"],
    ["missing entitlement", { entitlements: [] }, "valid-token"],
    ["inactive entitlement", { entitlements: [entitlement("suspended")] }, "valid-token"],
    ["missing resource link", { links: [] }, "valid-token"],
    [
      "wrong-property resource link",
      { links: [link({ resourceId: otherPropertyId })] },
      "valid-token",
    ],
  ] as const)("denies reads for %s", async (_label, auth, token) => {
    const ports = fakePorts();
    app = await testApp(ports, auth as AuthOptions);
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const response = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/room-types`,
      headers,
    });
    expect([401, 403]).toContain(response.statusCode);
    expect(ports.reads).toHaveLength(0);
  });

  it("preserves permissioned front-desk room-type reads and writes", async () => {
    const ports = fakePorts();
    app = await testApp(ports, { links: [link({ relationship: "front_desk" })] });

    const read = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/room-types`,
      headers: { authorization: "Bearer valid-token" },
    });
    const write = await commandRequest(app, "POST");

    expect([read.statusCode, write.statusCode]).toEqual([200, 201]);
    expect(ports.reads).toEqual([["list", propertyId]]);
    expect(ports.createCalls).toHaveLength(1);
  });

  it("requires manage permission for writes and denies a linked different property", async () => {
    const ports = fakePorts();
    app = await testApp(ports, { permissions: ["pms.operations.read"] });
    expect((await commandRequest(app, "POST")).statusCode).toBe(403);
    await app.close();
    app = await testApp(ports);
    expect(
      (await commandRequest(app, "POST", { targetPropertyId: otherPropertyId })).statusCode,
    ).toBe(403);
    expect(ports.createCalls).toHaveLength(0);
  });

  it.each([
    [
      "create vocabulary",
      "POST",
      {
        code: "unsupported_room_fact_keys",
        unsupportedCategoryKeys: ["unknown"],
        unsupportedBedTypeKeys: [],
      },
      422,
    ],
    ["create conflict", "POST", { code: "room_type_name_conflict" }, 409],
    ["create scope", "POST", { code: "setup_scope_unavailable" }, 404],
    ["update missing", "PUT", { code: "room_type_not_found" }, 404],
    ["update revision", "PUT", { code: "room_facts_revision_conflict", currentRevision: 3 }, 409],
    [
      "delete blocked",
      "DELETE",
      {
        code: "room_type_delete_blocked",
        currentRevision: 1,
        blockers: [{ code: "booking_reference", affectedCount: 1 }],
      },
      409,
    ],
    ["delete in progress", "DELETE", { code: "command_in_progress" }, 409],
  ] as const)("maps %s", async (_label, method, error, status) => {
    const ports = fakePorts({
      createResult: { ok: false, error } as CreateRoomTypeFactsResult,
      updateResult: { ok: false, error } as UpdateRoomTypeFactsResult,
      deleteResult: { ok: false, error } as SafeDeleteRoomTypeResult,
    });
    app = await testApp(ports);
    const response = await commandRequest(app, method);
    expect(response.statusCode).toBe(status);
    expect(response.body).toEqual(error);
  });

  it("serves facts, binding, stable units, and capacity through their owner ports", async () => {
    const ports = fakePorts();
    app = await testApp(ports, { permissions: ["pms.operations.read"] });
    const urls = [
      `/properties/${propertyId}/room-types`,
      `/properties/${propertyId}/room-types/${roomTypeId}`,
      `/properties/${propertyId}/room-type-bindings/${draftRoomId}`,
      `/properties/${propertyId}/room-types/${roomTypeId}/units`,
      `/properties/${propertyId}/room-types/${roomTypeId}/capacity`,
    ];
    for (const url of urls) {
      const response = await injectJson(app, {
        method: "GET",
        url,
        headers: { authorization: "Bearer valid-token" },
      });
      expect(response.statusCode, url).toBe(200);
    }
    expect(ports.reads).toEqual([
      ["list", propertyId],
      ["facts", propertyId, roomTypeId],
      ["binding", propertyId, draftRoomId],
      ["units", propertyId, roomTypeId],
      ["capacity", propertyId, roomTypeId],
    ]);
  });

  it.each(["facts", "binding", "capacity"])("returns 404 for missing %s reads", async (kind) => {
    const ports = fakePorts({ missing: true });
    app = await testApp(ports);
    const suffix =
      kind === "facts"
        ? `room-types/${roomTypeId}`
        : kind === "binding"
          ? `room-type-bindings/${draftRoomId}`
          : `room-types/${roomTypeId}/capacity`;
    const response = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/${suffix}`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect(response.statusCode).toBe(404);
  });

  it.each(["list", "facts", "binding", "units", "capacity"])(
    "fails closed when the %s port returns another property's data",
    async (kind) => {
      const ports = fakePorts({ readPropertyId: otherPropertyId });
      app = await testApp(ports);
      const suffix =
        kind === "list"
          ? "room-types"
          : kind === "facts"
            ? `room-types/${roomTypeId}`
            : kind === "binding"
              ? `room-type-bindings/${draftRoomId}`
              : `room-types/${roomTypeId}/${kind}`;
      const response = await injectJson(app, {
        method: "GET",
        url: `/properties/${propertyId}/${suffix}`,
        headers: { authorization: "Bearer valid-token" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).toEqual({ code: "pms_room_facts_port_contract_violation" });
    },
  );

  it("rejects invalid IDs before invoking a domain port", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const property = await injectJson(app, {
      method: "GET",
      url: "/properties/not-a-property/room-types",
      headers: { authorization: "Bearer valid-token" },
    });
    const room = await injectJson(app, {
      method: "GET",
      url: `/properties/${propertyId}/room-types/not-a-room-type`,
      headers: { authorization: "Bearer valid-token" },
    });
    expect([property.statusCode, room.statusCode]).toEqual([400, 400]);
    expect(ports.reads).toHaveLength(0);
  });
});
