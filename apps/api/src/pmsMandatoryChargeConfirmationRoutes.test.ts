import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
  type ConfirmMandatoryChargesIncludedCommand,
  type ConfirmMandatoryChargesIncludedResult,
  type PmsMandatoryChargeConfirmationReadRequest,
  type PmsMandatoryChargeConfirmationReadResult,
  type PmsMandatoryChargePricingSourceRevisionManifest,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsMandatoryChargeConfirmationRoutes,
  type PmsMandatoryChargeConfirmationRoutesOptions,
} from "./routes/pmsMandatoryChargeConfirmation.js";

const organizationId = "a8100000-0000-4000-8000-000000000001";
const otherOrganizationId = "a8100000-0000-4000-8000-000000000002";
const propertyId = "a8100000-0000-4000-8000-000000000003";
const otherPropertyId = "a8100000-0000-4000-8000-000000000004";
const actorUserId = "a8100000-0000-4000-8000-000000000005";
const now = "2026-08-04T13:30:00.000Z";
const fingerprint = "a".repeat(64);
const manifest: PmsMandatoryChargePricingSourceRevisionManifest = {
  pricingCurrencyRevision: 3,
  rooms: [],
  flexibleRatePlans: [],
  optionalPricingAggregateRevision: 0,
  recurringSources: [],
};

type AuthOptions = {
  organizationId?: string;
  kind?: "hotel_group" | "creator_workspace";
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};

type FakePorts = PmsMandatoryChargeConfirmationRoutesOptions & {
  commandCalls: ConfirmMandatoryChargesIncludedCommand[];
  readCalls: PmsMandatoryChargeConfirmationReadRequest[];
};

describe("PMS mandatory-charge confirmation routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("derives exact scope, audit, and idempotency without accepting owner state in the body", async () => {
    const ports = fakePorts();
    app = await testApp(ports);

    const response = await confirmRequest(app, { key: "  confirmation-key  " });

    expect(response.statusCode).toBe(200);
    expect(ports.commandCalls).toEqual([
      {
        organizationId,
        propertyId,
        expectedConfirmationRevision: 5,
        claimedPricingSourceFingerprint: fingerprint,
        expectedPricingSourceRevisions: manifest,
        idempotencyKey: "confirmation-key",
        audit: {
          actor: { kind: "user", userId: actorUserId },
          requestId: "request-1",
          correlationId: "correlation-1",
          requestedAt: now,
        },
      },
    ]);
    expect(response.body).toEqual(success(ports.commandCalls[0]!).response);
  });

  it("passes the authenticated organization and property into the read port", async () => {
    const ports = fakePorts();
    app = await testApp(ports);

    const response = await readRequest(app);

    expect(response.statusCode).toBe(200);
    expect(ports.readCalls).toEqual([{ organizationId, propertyId }]);
    expect(response.body).toEqual(available());
  });

  it("canonicalizes authenticated scope before either port call", async () => {
    const ports = fakePorts();
    app = await testApp(ports, { organizationId: organizationId.toUpperCase() });

    expect((await confirmRequest(app)).statusCode).toBe(200);
    expect((await readRequest(app)).statusCode).toBe(200);
    expect(ports.commandCalls[0]?.organizationId).toBe(organizationId);
    expect(ports.readCalls).toEqual([{ organizationId, propertyId }]);
  });

  it("rejects property UUID versions outside the domain contract before either port", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const invalidPropertyId = "a8100000-0000-0000-8000-000000000003";

    expect((await confirmRequest(app, { propertyId: invalidPropertyId })).statusCode).toBe(400);
    expect((await readRequest(app, "valid-token", invalidPropertyId)).statusCode).toBe(400);
    expect(ports.commandCalls).toHaveLength(0);
    expect(ports.readCalls).toHaveLength(0);
  });

  it.each([
    { ...commandBody(), organizationId },
    { ...commandBody(), propertyId },
    { ...commandBody(), pricing: { amount: "120.00" } },
    { ...commandBody(), audit: { requestId: "smuggled" } },
    { ...commandBody(), claimedPricingSourceFingerprint: "A".repeat(64) },
  ])("rejects smuggled or malformed command fields", async (body) => {
    const ports = fakePorts();
    app = await testApp(ports);

    expect((await confirmRequest(app, { body })).statusCode).toBe(400);
    expect(ports.commandCalls).toHaveLength(0);
  });

  it("requires one bounded idempotency key and authorizes before malformed JSON parsing", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    expect((await confirmRequest(app, { key: null })).statusCode).toBe(400);
    expect((await confirmRequest(app, { key: "x".repeat(201) })).statusCode).toBe(400);
    expect(await repeatedIdempotencyStatus(app, JSON.stringify(commandBody()))).toBe(400);

    const unauthorized = await app.inject({
      method: "PUT",
      url: `/properties/${propertyId}/mandatory-charge-confirmation`,
      headers: { "content-type": "application/json", "idempotency-key": "key" },
      payload: "{",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(ports.commandCalls).toHaveLength(0);
  });

  it.each([
    ["missing authentication", {}, null],
    ["non-hotel organization", { kind: "creator_workspace" }, "valid-token"],
    ["missing manage permission", { permissions: ["pms.operations.read"] }, "valid-token"],
    ["missing entitlement", { entitlements: [] }, "valid-token"],
    ["suspended entitlement", { entitlements: [entitlement("suspended")] }, "valid-token"],
    ["missing property link", { links: [] }, "valid-token"],
    ["wrong property link", { links: [link({ resourceId: otherPropertyId })] }, "valid-token"],
    ["front desk link", { links: [link({ relationship: "front_desk" })] }, "valid-token"],
  ] as const)("denies command and evidence access for %s", async (_label, auth, token) => {
    const ports = fakePorts();
    app = await testApp(ports, auth as AuthOptions);

    expect([401, 403]).toContain((await confirmRequest(app, { token })).statusCode);
    expect([401, 403]).toContain((await readRequest(app, token)).statusCode);
    expect(ports.commandCalls).toHaveLength(0);
    expect(ports.readCalls).toHaveLength(0);
  });

  it.each([
    [{ code: "setup_scope_unavailable" }, 404],
    [{ code: "pricing_source_not_configured" }, 409],
    [{ code: "pricing_source_conflict" }, 409],
    [{ code: "confirmation_revision_conflict", currentRevision: 8 }, 409],
    [{ code: "idempotency_key_conflict" }, 409],
    [{ code: "command_in_progress" }, 409],
  ] as const)("maps command error %# without widening it", async (error, status) => {
    const ports = fakePorts({ commandResult: { ok: false, error } });
    app = await testApp(ports);

    const response = await confirmRequest(app);
    expect(response.statusCode).toBe(status);
    expect(response.body).toEqual(error);
  });

  it("fails closed on altered or private successful command results", async () => {
    const command = parsedCommand();
    const valid = success(command);
    const altered = {
      ...valid,
      response: {
        ...valid.response,
        evidence: {
          ...valid.response.evidence,
          propertyId: otherPropertyId,
          pricingPayload: { amount: "secret" },
        },
      },
    } as unknown as ConfirmMandatoryChargesIncludedResult;
    const ports = fakePorts({ commandResult: altered });
    app = await testApp(ports);

    const response = await confirmRequest(app);
    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("masks secret-bearing command and read-port rejections", async () => {
    const commandPorts = fakePorts({ commandError: new Error("password=command-secret") });
    app = await testApp(commandPorts);
    const commandResponse = await confirmRequest(app);
    expect(commandResponse.statusCode).toBe(503);
    expect(commandResponse.body).toEqual({
      code: "pms_mandatory_charge_confirmation_unavailable",
    });
    expect(JSON.stringify(commandResponse.body)).not.toContain("command-secret");
    await app.close();

    const readPorts = fakePorts({ readError: new Error("postgres://read-secret") });
    app = await testApp(readPorts);
    const readResponse = await readRequest(app);
    expect(readResponse.statusCode).toBe(503);
    expect(readResponse.body).toEqual({
      organizationId,
      propertyId,
      outcome: "unavailable",
      errorSource: "system",
    });
    expect(JSON.stringify(readResponse.body)).not.toContain("read-secret");
  });

  it.each([
    [available(), 200],
    [{ outcome: "missing", organizationId, propertyId }, 404],
    [{ outcome: "malformed", organizationId, propertyId }, 500],
    [{ outcome: "unavailable", organizationId, propertyId, errorSource: "provider" }, 503],
    [{ outcome: "unavailable", organizationId, propertyId, errorSource: "system" }, 503],
  ] as const)("preserves typed read outcome %#", async (readResult, status) => {
    const ports = fakePorts({ readResult });
    app = await testApp(ports);

    const response = await readRequest(app);
    expect(response.statusCode).toBe(status);
    expect(response.body).toEqual(readResult);
  });

  it("fails closed on cross-scope or extended read-port data", async () => {
    const unsafe = {
      ...available(),
      organizationId: otherOrganizationId,
      evidence: { ...available().evidence, organizationId: otherOrganizationId },
      privateRequestMetadata: "secret",
    };
    const ports = fakePorts({ readResult: unsafe as never });
    app = await testApp(ports);

    const response = await readRequest(app);
    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });
});

function fakePorts(
  options: {
    commandResult?: ConfirmMandatoryChargesIncludedResult;
    commandError?: Error;
    readResult?: PmsMandatoryChargeConfirmationReadResult;
    readError?: Error;
  } = {},
): FakePorts {
  const commandCalls: ConfirmMandatoryChargesIncludedCommand[] = [];
  const readCalls: PmsMandatoryChargeConfirmationReadRequest[] = [];
  return {
    commandCalls,
    readCalls,
    commandPort: {
      async confirmMandatoryChargesIncluded(command) {
        commandCalls.push(command);
        if (options.commandError) throw options.commandError;
        return options.commandResult ?? success(command);
      },
    },
    readPort: {
      async getMandatoryChargeConfirmation(request) {
        readCalls.push(request);
        if (options.readError) throw options.readError;
        return options.readResult ?? available();
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
      selectedOrganization: {
        organizationId: auth.organizationId ?? organizationId,
        kind: auth.kind ?? "hotel_group",
      },
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
  await app.register(registerPmsMandatoryChargeConfirmationRoutes, ports);
  return app;
}

function success(
  command: ConfirmMandatoryChargesIncludedCommand,
): Extract<ConfirmMandatoryChargesIncludedResult, { ok: true }> {
  return {
    ok: true,
    response: {
      contractVersion: PMS_MANDATORY_CHARGE_CONFIRMATION_CONTRACT_VERSION,
      outcome: "confirmed",
      evidence: {
        organizationId: command.organizationId,
        propertyId: command.propertyId,
        pricingSourceFingerprint: command.claimedPricingSourceFingerprint,
        confirmationRevision: command.expectedConfirmationRevision + 1,
        confirmedAt: now,
      },
      acceptedAt: now,
    },
  };
}

function available(): Extract<PmsMandatoryChargeConfirmationReadResult, { outcome: "available" }> {
  return {
    outcome: "available",
    organizationId,
    propertyId,
    evidence: {
      organizationId,
      propertyId,
      pricingSourceFingerprint: fingerprint as never,
      confirmationRevision: 6,
      confirmedAt: now,
    },
  };
}

function commandBody() {
  return {
    expectedConfirmationRevision: 5,
    claimedPricingSourceFingerprint: fingerprint,
    expectedPricingSourceRevisions: manifest,
  };
}

function parsedCommand(): ConfirmMandatoryChargesIncludedCommand {
  return {
    organizationId,
    propertyId,
    ...commandBody(),
    claimedPricingSourceFingerprint: fingerprint as never,
    idempotencyKey: "confirmation-key",
    audit: {
      actor: { kind: "user", userId: actorUserId },
      requestId: "request-1",
      correlationId: "correlation-1",
      requestedAt: now,
    },
  };
}

function entitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status,
    resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
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

function confirmRequest(
  app: Awaited<ReturnType<typeof testApp>>,
  options: {
    body?: unknown;
    key?: string | null;
    token?: string | null;
    propertyId?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? "valid-token"}`;
  if (options.key !== null) headers["idempotency-key"] = options.key ?? "confirmation-key";
  return injectJson<Record<string, any>>(app, {
    method: "PUT",
    url: `/properties/${options.propertyId ?? propertyId}/mandatory-charge-confirmation`,
    headers,
    payload: options.body ?? commandBody(),
  });
}

function readRequest(
  app: Awaited<ReturnType<typeof testApp>>,
  token: string | null = "valid-token",
  requestPropertyId = propertyId,
) {
  return injectJson<Record<string, any>>(app, {
    method: "GET",
    url: `/properties/${requestPropertyId}/mandatory-charge-confirmation`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function repeatedIdempotencyStatus(
  app: Awaited<ReturnType<typeof testApp>>,
  payload: string,
): Promise<number> {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "PUT",
        path: `/properties/${propertyId}/mandatory-charge-confirmation`,
        headers: {
          authorization: "Bearer valid-token",
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "idempotency-key": ["one", "two"],
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}
