import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  type ReconcilePhysicalRoomUnitsCommand,
  type ReconcilePhysicalRoomUnitsResult,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsPhysicalRoomUnitRoutes,
  type PmsPhysicalRoomUnitRoutesOptions,
} from "./routes/pmsPhysicalRoomUnits.js";

const propertyId = "c1000000-0000-0000-8000-000000000001";
const otherPropertyId = "c1000000-0000-0000-8000-000000000002";
const roomTypeId = "c1000000-0000-0000-8000-000000000003";
const roomUnitId = "c1000000-0000-0000-8000-000000000004";
const organizationId = "c1000000-0000-0000-8000-000000000005";
const actorUserId = "c1000000-0000-0000-8000-000000000006";
const now = "2026-08-03T11:00:00.000Z";

type AuthOptions = {
  kind?: "hotel_group" | "creator_workspace";
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};

let app: Awaited<ReturnType<typeof testApp>> | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function success(command: ReconcilePhysicalRoomUnitsCommand): ReconcilePhysicalRoomUnitsResult {
  return {
    ok: true,
    response: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      outcome: "reconciled",
      propertyId: command.propertyId,
      roomTypeId: command.roomTypeId,
      previousActiveUnitCount: 1,
      capacity: {
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId: command.propertyId,
        roomTypeId: command.roomTypeId,
        roomUnitsRevision: command.expectedRevision + 1,
        activeUnitCount: command.targetActiveUnitCount,
        capturedAt: now,
      },
      addedUnits: [
        {
          contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
          propertyId: command.propertyId,
          roomTypeId: command.roomTypeId,
          roomUnitId,
          lifecycle: "active",
          operationalLabel: null,
          operationalLabelStatus: "unverified",
        },
      ],
      retiredUnitIds: [],
      acceptedAt: now,
    },
  };
}

function fakePort(result?: ReconcilePhysicalRoomUnitsResult) {
  const calls: ReconcilePhysicalRoomUnitsCommand[] = [];
  const options: PmsPhysicalRoomUnitRoutesOptions = {
    commandPort: {
      async reconcilePhysicalRoomUnits(command) {
        calls.push(command);
        return result ?? success(command);
      },
    },
  };
  return { calls, options };
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

function link(
  resourceId = propertyId,
  relationship: LinkedResource["relationship"] = "operator",
): LinkedResource {
  return {
    product: "pms",
    resourceType: "pms_property",
    resourceId,
    relationship,
    status: "active",
  };
}

async function testApp(port: PmsPhysicalRoomUnitRoutesOptions, auth: AuthOptions = {}) {
  const instance = Fastify({ logger: false });
  instance.decorateRequest("authContext", null);
  instance.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId, kind: auth.kind ?? "hotel_group" },
      membership: {
        permissions: auth.permissions ?? ["pms.operations.manage"],
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
  await instance.register(registerPmsPhysicalRoomUnitRoutes, port);
  return instance;
}

function url(targetPropertyId = propertyId, targetRoomTypeId = roomTypeId) {
  return `/properties/${targetPropertyId}/room-types/${targetRoomTypeId}/physical-units/reconcile`;
}

async function request(
  instance: Awaited<ReturnType<typeof testApp>>,
  overrides: {
    authorization?: string | null;
    targetPropertyId?: string;
    targetRoomTypeId?: string;
    body?: unknown;
    idempotencyKey?: string | null;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (overrides.authorization !== null) {
    headers.authorization = overrides.authorization ?? "Bearer valid-token";
  }
  if (overrides.idempotencyKey !== null) {
    headers["idempotency-key"] = overrides.idempotencyKey ?? "reconcile-key-1";
  }
  return injectJson<Record<string, unknown>>(instance, {
    method: "PUT",
    url: url(overrides.targetPropertyId, overrides.targetRoomTypeId),
    headers,
    payload: overrides.body ?? { expectedRevision: 2, targetActiveUnitCount: 2 },
  });
}

describe("PMS physical room unit reconcile route", () => {
  it("authorizes before parsing and builds scope/audit from RequestContext", async () => {
    const port = fakePort();
    app = await testApp(port.options);
    const response = await request(app);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      outcome: "reconciled",
      capacity: { activeUnitCount: 2, roomUnitsRevision: 3 },
      addedUnits: [{ operationalLabel: null, operationalLabelStatus: "unverified" }],
    });
    expect(port.calls).toEqual([
      {
        organizationId,
        propertyId,
        roomTypeId,
        expectedRevision: 2,
        targetActiveUnitCount: 2,
        idempotencyKey: "reconcile-key-1",
        audit: {
          actor: { kind: "user", userId: actorUserId },
          requestId: "request-1",
          correlationId: "correlation-1",
          requestedAt: now,
        },
      },
    ]);
  });

  it("allows an entitled front-desk operator in the selected property scope", async () => {
    const port = fakePort();
    app = await testApp(port.options, { links: [link(propertyId, "front_desk")] });

    const response = await request(app);

    expect(response.statusCode).toBe(200);
    expect(port.calls).toHaveLength(1);
  });

  it.each([
    ["missing auth", {}, 401],
    ["invalid auth", {}, 401, "Bearer invalid-token"],
    ["missing permission", { permissions: [] }, 403],
    ["missing entitlement", { entitlements: [] }, 403],
    ["suspended entitlement", { entitlements: [entitlement("suspended")] }, 403],
    ["missing linked property", { links: [] }, 403],
    ["wrong linked property", { links: [link(otherPropertyId)] }, 403],
    ["wrong organization kind", { kind: "creator_workspace" }, 403],
  ] as const)("rejects %s without invoking the command", async (...args) => {
    const [_label, auth, status, token] = args;
    const port = fakePort();
    app = await testApp(port.options, auth as AuthOptions);
    const response = await request(app, {
      authorization: token ?? (_label === "missing auth" ? null : undefined),
    });

    expect(response.statusCode).toBe(status);
    expect(port.calls).toHaveLength(0);
  });

  it("returns authorization denial before malformed JSON body parsing", async () => {
    const port = fakePort();
    app = await testApp(port.options);
    const response = await app.inject({
      method: "PUT",
      url: url(),
      headers: { "content-type": "application/json", "idempotency-key": "key" },
      payload: '{"expectedRevision":',
    });

    expect(response.statusCode).toBe(401);
    expect(port.calls).toHaveLength(0);
  });

  it.each([
    ["missing idempotency key", { idempotencyKey: null }],
    ["zero target", { body: { expectedRevision: 2, targetActiveUnitCount: 0 } }],
    ["oversized target", { body: { expectedRevision: 2, targetActiveUnitCount: 501 } }],
    ["stale shape", { body: { expectedRevision: 2, targetActiveUnitCount: 2, extra: true } }],
    ["invalid room type", { targetRoomTypeId: "not-a-uuid" }],
  ])("rejects invalid input: %s", async (_label, overrides) => {
    const port = fakePort();
    app = await testApp(port.options);
    const response = await request(app, overrides);

    expect(response.statusCode).toBe(400);
    expect(port.calls).toHaveLength(0);
  });

  it("fails wrong-property access without revealing room type existence", async () => {
    const port = fakePort();
    app = await testApp(port.options);
    const response = await request(app, { targetPropertyId: otherPropertyId });

    expect(response.statusCode).toBe(403);
    expect(port.calls).toHaveLength(0);
  });

  it.each([
    [{ code: "setup_scope_unavailable" }, 404],
    [{ code: "room_type_not_found" }, 404],
    [{ code: "room_units_revision_conflict", currentRevision: 4 }, 409],
    [{ code: "idempotency_key_conflict" }, 409],
    [
      {
        code: "physical_unit_reconcile_blocked",
        currentRevision: 2,
        currentActiveUnitCount: 3,
        targetActiveUnitCount: 2,
        safelyRemovableUnitCount: 0,
        blockers: [{ code: "reservation_assignment", affectedCount: 2 }],
      },
      409,
    ],
  ] as const)("maps typed command errors without reshaping them", async (error, status) => {
    const port = fakePort({ ok: false, error } as ReconcilePhysicalRoomUnitsResult);
    app = await testApp(port.options);
    const response = await request(app);

    expect(response.statusCode).toBe(status);
    expect(response.body).toEqual(error);
  });

  it("rejects a cross-property or wrong-revision port response", async () => {
    const port = fakePort();
    port.options.commandPort.reconcilePhysicalRoomUnits = async (command) => {
      const result = success(command);
      if (!result.ok) return result;
      return {
        ok: true,
        response: {
          ...result.response,
          capacity: { ...result.response.capacity, roomUnitsRevision: 99 },
        },
      };
    };
    app = await testApp(port.options);
    const response = await request(app);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ code: "pms_physical_room_unit_port_contract_violation" });
  });

  it.each([
    [
      "blocker revision",
      {
        code: "physical_unit_reconcile_blocked",
        currentRevision: 3,
        currentActiveUnitCount: 3,
        targetActiveUnitCount: 2,
        safelyRemovableUnitCount: 0,
        blockers: [{ code: "reservation_assignment", affectedCount: 1 }],
      },
    ],
    [
      "blocker target",
      {
        code: "physical_unit_reconcile_blocked",
        currentRevision: 2,
        currentActiveUnitCount: 3,
        targetActiveUnitCount: 1,
        safelyRemovableUnitCount: 0,
        blockers: [{ code: "reservation_assignment", affectedCount: 1 }],
      },
    ],
    ["non-conflicting revision", { code: "room_units_revision_conflict", currentRevision: 2 }],
  ] as const)("rejects a port result with wrong command correlation: %s", async (_label, error) => {
    const port = fakePort({ ok: false, error } as ReconcilePhysicalRoomUnitsResult);
    app = await testApp(port.options);
    const response = await request(app);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ code: "pms_physical_room_unit_port_contract_violation" });
  });
});
