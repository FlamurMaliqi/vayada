import type { RequestContext } from "@vayada/backend-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PmsLinkedInventoryGroupCommandRepository } from "./domains/pmsLinkedInventoryGroupRepository.js";
import { registerPmsOperationsRoutes } from "./routes/pmsOperations.js";
import type { PmsOperationsReadRepository } from "./routes/pmsOperations.js";
const propertyId = "88000000-0000-4000-8000-000000000001";
const otherPropertyId = "88000000-0000-4000-8000-000000000002";
const groupId = "88000000-0000-4000-8000-000000000003";
const roomTypeIds = [
  "88000000-0000-4000-8000-000000000004",
  "88000000-0000-4000-8000-000000000005",
];
const group = { groupId, name: "Linked rooms", revision: 1, memberRoomTypeIds: roomTypeIds };
const errors = [
  ["linked_inventory_group_invalid", 400, "validation"],
  ["group_not_found", 404, "not_found"],
  ["revision_conflict", 409, "conflict"],
  ["idempotency_conflict", 409, "conflict"],
  ["linked_inventory_name_conflict", 409, "conflict"],
  ["linked_inventory_membership_conflict", 409, "conflict"],
  ["linked_inventory_not_canonical", 409, "conflict"],
  ["linked_inventory_overlap_conflict", 409, "conflict"],
] as const;
describe("PMS linked inventory group routes", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => app?.close());
  it("preserves command envelopes, statuses, scope, and audit metadata", async () => {
    const test = await testApp();
    app = test.app;
    const replaced = { ...group, name: "Renamed", revision: 2 };
    test.commands.create
      .mockResolvedValueOnce({ ok: true, group })
      .mockResolvedValueOnce({ ok: true, group, replayed: true });
    test.commands.replace.mockResolvedValue({ ok: true, group: replaced });
    test.commands.delete.mockResolvedValue({ ok: true, group: null });
    const fresh = await command(app, "POST", collection(propertyId), put());
    const replay = await command(app, "POST", collection(propertyId), put());
    const replace = await command(
      app,
      "PUT",
      item(propertyId),
      put({ name: "Renamed", expectedRevision: 1 }),
    );
    const deleted = await command(app, "DELETE", item(propertyId), del());
    expect([fresh.statusCode, replay.statusCode, replace.statusCode, deleted.statusCode]).toEqual([
      201, 201, 200, 200,
    ]);
    expect(fresh.json()).toEqual(envelope(propertyId, group));
    expect(replay.json()).toEqual(fresh.json());
    expect(replace.json()).toEqual(envelope(propertyId, replaced));
    expect(deleted.json()).toEqual(envelope(propertyId, null));
    expect(test.commands.create).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId,
        audit: expect.objectContaining({
          actor: expect.objectContaining({ userId: actorId, organizationId }),
          requestId: "request-1",
        }),
      }),
    );
    expect(test.commands.replace).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId, groupId, expectedRevision: 1 }),
    );
    expect(test.commands.delete).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId, groupId, expectedRevision: 1 }),
    );
  });
  it.each(errors)(
    "maps %s without losing its typed contract",
    async (code, statusCode, category) => {
      const test = await testApp();
      app = test.app;
      test.commands.replace.mockResolvedValue({ ok: false, statusCode, code, message: code });
      const response = await command(app, "PUT", item(propertyId), put({ expectedRevision: 1 }));
      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({ statusCode, code, category, message: code });
    },
  );
  it("rejects malformed, oversized, and cross-property commands before dispatch", async () => {
    const test = await testApp();
    app = test.app;
    const requests = [
      ["PUT", item(propertyId), put({ expectedRevision: "1junk" }), 400],
      ["POST", collection(propertyId), put({ memberRoomTypeIds: [...roomTypeIds, 42] }), 400],
      ["POST", collection(propertyId), put({ commandId: "c".repeat(201) }), 400],
      ["POST", collection(propertyId), put({ idempotencyKey: "k".repeat(201) }), 400],
      ["POST", collection(propertyId), put({ name: "n".repeat(201) }), 400],
      ["POST", collection(otherPropertyId), put(), 403],
    ] as const;
    for (const [method, url, payload, status] of requests) {
      expect((await command(app, method, url, payload)).statusCode).toBe(status);
    }
    expect(test.commands.create).not.toHaveBeenCalled();
    expect(test.commands.replace).not.toHaveBeenCalled();
  });
  it("serves item CORS and closes both route-owned repositories", async () => {
    const test = await testApp(["https://pms.localhost"]);
    app = test.app;
    const response = await app.inject({
      method: "OPTIONS",
      url: item(propertyId),
      headers: { origin: "https://pms.localhost", "access-control-request-method": "DELETE" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("https://pms.localhost");
    await app.close();
    app = undefined;
    expect(test.readClose).toHaveBeenCalledOnce();
    expect(test.commands.close).toHaveBeenCalledOnce();
  });
});
const actorId = "88000000-0000-4000-8000-000000000006";
const organizationId = "88000000-0000-4000-8000-000000000007";
async function testApp(allowedOrigins: string[] = []) {
  const app = Fastify({ logger: false });
  const readClose = vi.fn(async () => undefined);
  const commands = {
    create: vi.fn<PmsLinkedInventoryGroupCommandRepository["create"]>(),
    replace: vi.fn<PmsLinkedInventoryGroupCommandRepository["replace"]>(),
    delete: vi.fn<PmsLinkedInventoryGroupCommandRepository["delete"]>(),
    close: vi.fn<PmsLinkedInventoryGroupCommandRepository["close"]>(async () => undefined),
  };
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization === "Bearer valid") request.authContext = context();
  });
  await app.register(registerPmsOperationsRoutes, {
    repository: { close: readClose } as unknown as PmsOperationsReadRepository,
    linkedInventoryGroupCommandRepository: commands,
    allowedOrigins,
  });
  return { app, commands, readClose };
}
function context(): RequestContext {
  return {
    actor: { internalUserId: actorId },
    selectedOrganization: { organizationId, kind: "hotel_group" },
    membership: { permissions: ["pms.operations.manage"] },
    entitlements: [
      {
        product: "pms",
        key: "property-management",
        status: "active",
        resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
      },
    ],
    linkedResources: [
      {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        relationship: "operator",
        status: "active",
      },
    ],
    audit: { requestId: "request-1", source: "api", receivedAt: "2026-08-28T08:00:00.000Z" },
  } as RequestContext;
}
function command(
  app: ReturnType<typeof Fastify>,
  method: "POST" | "PUT" | "DELETE",
  url: string,
  payload: unknown,
) {
  return app.inject({ method, url, headers: { authorization: "Bearer valid" }, payload });
}

const collection = (scope: string) => `/properties/${scope}/linked-inventory-groups`;
const item = (scope: string) => `${collection(scope)}/${groupId}`;
const envelope = (scope: string, value: unknown) => ({
  contractVersion: "pms-operations.v1",
  propertyId: scope,
  group: value,
});
const put = (overrides: Record<string, unknown> = {}) => ({
  commandId: "command-1",
  idempotencyKey: "key-1",
  name: "Linked rooms",
  memberRoomTypeIds: roomTypeIds,
  ...overrides,
});
const del = () => ({ commandId: "command-2", idempotencyKey: "key-2", expectedRevision: 1 });
