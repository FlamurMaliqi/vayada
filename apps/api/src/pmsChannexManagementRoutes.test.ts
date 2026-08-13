import type { RequestContext } from "@vayada/backend-auth";
import {
  CHANNEX_MANAGEMENT_CONTRACT_VERSION,
  type ChannexManagementCapabilityModes,
  type ChannexManagementOperation,
} from "@vayada/domain-pms-channex";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PmsChannexManagementCommandPort } from "./domains/pmsChannexManagementCommands.js";
import type { PmsChannexManagementReadRepository } from "./domains/pmsChannexManagementReadModel.js";
import { registerPmsChannexManagementRoutes } from "./routes/pmsChannexManagement.js";

const propertyId = "123e4567-e89b-42d3-a456-426614174000";
const operationId = "223e4567-e89b-42d3-a456-426614174000";
const mutating: ChannexManagementCapabilityModes = {
  connection: "mutating",
  provisioning: "mutating",
  ariSync: "mutating",
  bookingSync: "mutating",
  markups: "mutating",
  messaging: "mutating",
  iframe: "observe_only",
};

type Access = {
  authenticated?: boolean;
  permission?: boolean;
  entitlement?: "active" | "suspended" | "missing";
  linked?: boolean;
  relationship?: "operator" | "finance_manager";
};

describe("PMS Channex management command routes", () => {
  let app: ReturnType<typeof Fastify> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it.each([
    [{ authenticated: false }, 401],
    [{ permission: false }, 403],
    [{ entitlement: "missing" }, 403],
    [{ entitlement: "suspended" }, 403],
    [{ linked: false }, 403],
    [{ relationship: "finance_manager" }, 403],
  ] as const)("denies unauthorized command access %#", async (access, statusCode) => {
    const harness = await testApp(access);
    app = harness.app;

    expect((await command(app)).statusCode).toBe(statusCode);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("queues an authorized command and preserves actor context", async () => {
    const harness = await testApp();
    app = harness.app;

    const response = await command(app);

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual(operation());
    expect(harness.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { internalUserId: "actor-1" } }),
      propertyId,
      {
        commandId: "command-1",
        idempotencyKey: "key-1",
        operationType: "enable",
      },
    );
  });

  it("fails closed for observe-only capabilities and invalid payloads", async () => {
    const harness = await testApp({}, { ...mutating, connection: "observe_only" });
    app = harness.app;

    expect((await command(app)).json()).toEqual({ code: "channex_capability_not_mutating" });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/properties/${propertyId}/channex/commands`,
          headers: { authorization: "Bearer valid" },
          payload: { operationType: "webhook_setup" },
        })
      ).statusCode,
    ).toBe(400);
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("applies authentication policy before command or markup validation", async () => {
    const harness = await testApp({ authenticated: false });
    app = harness.app;
    for (const [method, path] of [
      ["POST", "commands"],
      ["PUT", "markups"],
    ] as const) {
      const response = await app.inject({
        method,
        url: `/properties/${propertyId}/channex/${path}`,
        payload: { malformed: true },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it("validates and queues target-owned markups", async () => {
    const harness = await testApp();
    app = harness.app;
    const response = await app.inject({
      method: "PUT",
      url: `/properties/${propertyId}/channex/markups`,
      headers: { authorization: "Bearer valid" },
      payload: {
        commandId: "command-2",
        idempotencyKey: "key-2",
        markups: [{ channel: "airbnb", markupPercent: 12.5 }],
      },
    });

    expect(response.statusCode).toBe(202);
    expect(harness.enqueue).toHaveBeenCalledWith(expect.anything(), propertyId, {
      commandId: "command-2",
      idempotencyKey: "key-2",
      operationType: "update_markups",
      markups: [{ channel: "airbnb", markupPercent: 12.5 }],
    });
  });

  it("guards short-lived iframe sessions with the iframe cutover mode", async () => {
    let harness = await testApp({}, { ...mutating, iframe: "mutating" });
    app = harness.app;
    const unavailable = await app.inject({
      method: "POST",
      url: `/properties/${propertyId}/channex/iframe-session`,
      headers: { authorization: "Bearer valid" },
    });
    expect(unavailable).toMatchObject({ statusCode: 503 });
    await app.close();

    harness = await testApp({}, { ...mutating, iframe: "observe_only" });
    app = harness.app;
    const disabled = await app.inject({
      method: "POST",
      url: `/properties/${propertyId}/channex/iframe-session`,
      headers: { authorization: "Bearer valid" },
    });
    expect(disabled).toMatchObject({ statusCode: 409 });
  });
});

async function testApp(
  access: Access = {},
  capabilityModes: ChannexManagementCapabilityModes = mutating,
) {
  const app = Fastify({ logger: false });
  const enqueue = vi.fn<PmsChannexManagementCommandPort["enqueue"]>();
  enqueue.mockResolvedValue({ ok: true, operation: operation(), replayed: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization !== "Bearer valid" || access.authenticated === false) return;
    request.authContext = context(access);
  });
  await app.register(registerPmsChannexManagementRoutes, {
    repository: repository(),
    capabilityModes,
    commandPort: { enqueue },
  });
  return { app, enqueue };
}

function context(access: Access): RequestContext {
  const entitlement = access.entitlement ?? "active";
  return {
    actor: { internalUserId: "actor-1" },
    selectedOrganization: { organizationId: "organization-1", kind: "hotel_group" },
    membership: {
      permissions: access.permission === false ? [] : ["pms.operations.manage"],
    },
    entitlements:
      entitlement === "missing"
        ? []
        : [
            {
              product: "pms",
              key: "property-management",
              status: entitlement,
              resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
            },
          ],
    linkedResources:
      access.linked === false
        ? []
        : [
            {
              product: "pms",
              resourceType: "pms_property",
              resourceId: propertyId,
              relationship: access.relationship ?? "operator",
              status: "active",
            },
          ],
    audit: { requestId: "request-1", source: "api", receivedAt: "2026-08-13T10:00:00.000Z" },
  } as RequestContext;
}

function repository(): PmsChannexManagementReadRepository {
  return {
    async getSnapshot() {
      throw new Error("not used");
    },
    async getOperation() {
      return null;
    },
  };
}

function operation(): ChannexManagementOperation {
  return {
    contractVersion: CHANNEX_MANAGEMENT_CONTRACT_VERSION,
    operationId,
    propertyId,
    operationType: "enable",
    status: "queued",
    commandId: "command-1",
    idempotencyKey: "key-1",
    acceptedAt: "2026-08-13T10:00:00.000Z",
    attemptsMade: 0,
    maxAttempts: 5,
    retryAfter: null,
    lastError: null,
  };
}

function command(app: ReturnType<typeof Fastify>) {
  return app.inject({
    method: "POST",
    url: `/properties/${propertyId}/channex/commands`,
    headers: { authorization: "Bearer valid" },
    payload: { commandId: "command-1", idempotencyKey: "key-1", operationType: "enable" },
  });
}
