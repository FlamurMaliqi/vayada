import { request as httpRequest } from "node:http";

import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
  createMarketplaceHotelCollaborationPreferencesEvidence,
  parseMarketplaceHotelCollaborationPreferencesReadModel,
  parseReplaceMarketplaceHotelCollaborationPreferencesRequest,
  type MarketplaceHotelCollaborationPreferencesReadOutcome,
  type MarketplaceHotelCollaborationPreferencesReadyReadModel,
  type MarketplaceHotelCollaborationPreferencesReadModel,
  type ReplaceMarketplaceHotelCollaborationPreferencesCommand,
  type ReplaceMarketplaceHotelCollaborationPreferencesResult,
} from "@vayada/domain-marketplace";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerMarketplaceHotelCollaborationPreferencesRoutes,
  type MarketplaceHotelCollaborationPreferencesRoutesOptions,
} from "./routes/marketplaceHotelCollaborationPreferences.js";

const propertyId = "a1077000-0000-4000-8000-000000000001";
const otherPropertyId = "a1077000-0000-4000-8000-000000000002";
const organizationId = "11111111-1111-4111-8111-111111111111";
const actorUserId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-03T12:00:00.000Z";

type AuthOptions = {
  kind?: "hotel_group" | "creator_workspace";
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};
type FakePorts = MarketplaceHotelCollaborationPreferencesRoutesOptions & {
  commands: ReplaceMarketplaceHotelCollaborationPreferencesCommand[];
  reads: Array<{ organizationId: string; propertyId: string }>;
};

function requestBody() {
  return {
    expectedRevision: 0,
    compensationTypes: ["paid", "free_stay"],
    contentPlatforms: ["youtube", "instagram"],
    contentTypes: ["photography", "post"],
    availability: { mode: "selected_months", selectedMonths: [12, 1] },
  };
}

function readModel(
  revision: 0,
  targetPropertyId?: string,
): Extract<MarketplaceHotelCollaborationPreferencesReadModel, { revision: 0 }>;
function readModel(
  revision?: 1,
  targetPropertyId?: string,
): MarketplaceHotelCollaborationPreferencesReadyReadModel;
function readModel(
  revision: 0 | 1 = 1,
  targetPropertyId = propertyId,
): MarketplaceHotelCollaborationPreferencesReadModel {
  if (revision === 0) {
    return parseMarketplaceHotelCollaborationPreferencesReadModel({
      contractVersion: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
      propertyId: targetPropertyId,
      revision: 0,
      sourceRevision: "preferences:0",
      preferences: null,
      readiness: createMarketplaceHotelCollaborationPreferencesEvidence(targetPropertyId, 0, null),
    })!;
  }
  const { expectedRevision: _expectedRevision, ...preferences } =
    parseReplaceMarketplaceHotelCollaborationPreferencesRequest(requestBody())!;
  return parseMarketplaceHotelCollaborationPreferencesReadModel({
    contractVersion: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
    propertyId: targetPropertyId,
    revision: 1,
    sourceRevision: "preferences:1",
    preferences,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(
      targetPropertyId,
      1,
      preferences,
    ),
  })!;
}

function success(
  outcome: "updated" | "idempotent_replay" = "updated",
): Extract<ReplaceMarketplaceHotelCollaborationPreferencesResult, { ok: true }> {
  return {
    ok: true,
    response: { ...readModel(1), outcome, acceptedAt: now },
  };
}

function successWithDifferentPreferences(
  outcome: "updated" | "idempotent_replay",
): Extract<ReplaceMarketplaceHotelCollaborationPreferencesResult, { ok: true }> {
  const { expectedRevision: _expectedRevision, ...preferences } =
    parseReplaceMarketplaceHotelCollaborationPreferencesRequest({
      ...requestBody(),
      compensationTypes: ["affiliate"],
    })!;
  const model = parseMarketplaceHotelCollaborationPreferencesReadModel({
    ...readModel(1),
    preferences,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(propertyId, 1, preferences),
  });
  if (!model || model.preferences === null) throw new Error("Invalid mismatched response fixture");
  return { ok: true, response: { ...model, outcome, acceptedAt: now } };
}

function fakePorts(
  overrides: {
    commandResult?: unknown;
    readResult?: unknown;
  } = {},
): FakePorts {
  const commands: ReplaceMarketplaceHotelCollaborationPreferencesCommand[] = [];
  const reads: Array<{ organizationId: string; propertyId: string }> = [];
  return {
    commands,
    reads,
    commandPort: {
      async replaceHotelCollaborationPreferences(command) {
        commands.push(command);
        return (overrides.commandResult ??
          success()) as ReplaceMarketplaceHotelCollaborationPreferencesResult;
      },
    },
    readPort: {
      async getHotelCollaborationPreferences(scope) {
        reads.push(scope);
        return (overrides.readResult ?? {
          outcome: "available",
          readModel: readModel(),
        }) as MarketplaceHotelCollaborationPreferencesReadOutcome;
      },
    },
  };
}

function entitlement(
  status: ProductEntitlement["status"] = "active",
  resourceId = propertyId,
): ProductEntitlement {
  return {
    product: "marketplace",
    key: "marketplace-hotel-profile",
    status,
    resource: { product: "marketplace", resourceType: "hotel_profile", resourceId },
  };
}

function link(overrides: Partial<LinkedResource> = {}): LinkedResource {
  return {
    product: "marketplace",
    resourceType: "hotel_profile",
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
      membership: { permissions: auth.permissions ?? ["marketplace.profile.manage"] },
      linkedResources: auth.links ?? [link()],
      entitlements: auth.entitlements ?? [entitlement()],
      audit: {
        requestId: "request-1077",
        correlationId: "correlation-1077",
        source: "api",
        receivedAt: now,
      },
    } as RequestContext;
  });
  await app.register(registerMarketplaceHotelCollaborationPreferencesRoutes, ports);
  return app;
}

async function replaceRequest(
  app: Awaited<ReturnType<typeof testApp>>,
  options: {
    authorization?: string | null;
    body?: unknown;
    key?: string | null;
    targetPropertyId?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (options.authorization !== null) {
    headers.authorization = options.authorization ?? "Bearer valid-token";
  }
  if (options.key !== null) headers["idempotency-key"] = options.key ?? "preferences-key";
  return injectJson<Record<string, unknown>>(app, {
    method: "PUT",
    url: `/properties/${options.targetPropertyId ?? propertyId}/hotel-collaboration-preferences`,
    headers,
    payload: options.body ?? requestBody(),
  });
}

async function readRequest(
  app: Awaited<ReturnType<typeof testApp>>,
  authorization: string | null = "Bearer valid-token",
  targetPropertyId = propertyId,
) {
  return injectJson<Record<string, unknown>>(app, {
    method: "GET",
    url: `/properties/${targetPropertyId}/hotel-collaboration-preferences`,
    headers: authorization ? { authorization } : {},
  });
}

async function replaceWithRepeatedIdempotencyKeys(
  app: Awaited<ReturnType<typeof testApp>>,
): Promise<{ statusCode: number }> {
  const payload = JSON.stringify(requestBody());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: address.port,
        method: "PUT",
        path: `/properties/${propertyId}/hotel-collaboration-preferences`,
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

describe("Marketplace hotel collaboration preference routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("reads an available owner omission without deriving readiness from a draft", async () => {
    const ports = fakePorts({
      readResult: { outcome: "available", readModel: readModel(0) },
    });
    app = await testApp(ports);
    const response = await readRequest(app);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      revision: 0,
      preferences: null,
      sourceRevision: "preferences:0",
    });
    expect(ports.reads).toEqual([{ organizationId, propertyId }]);
  });

  it("derives scope, audit, canonical input, and the trimmed key before replacing", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await replaceRequest(app, { key: "  stable-key  " });

    expect(response.statusCode).toBe(200);
    expect(ports.commands).toEqual([
      {
        organizationId,
        propertyId,
        idempotencyKey: "stable-key",
        audit: {
          actor: { kind: "user", userId: actorUserId },
          requestId: "request-1077",
          correlationId: "correlation-1077",
          requestedAt: now,
        },
        request: {
          expectedRevision: 0,
          compensationTypes: ["free_stay", "paid"],
          contentPlatforms: ["instagram", "youtube"],
          contentTypes: ["post", "photography"],
          availability: { mode: "selected_months", selectedMonths: [1, 12] },
        },
      },
    ]);
  });

  it("returns a strictly parsed exact replay without changing its outcome", async () => {
    const ports = fakePorts({ commandResult: success("idempotent_replay") });
    app = await testApp(ports);
    const response = await replaceRequest(app);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ outcome: "idempotent_replay", revision: 1 });
  });

  it.each(["updated", "idempotent_replay"] as const)(
    "fails closed when an %s response contains a different canonical document",
    async (outcome) => {
      const ports = fakePorts({ commandResult: successWithDifferentPreferences(outcome) });
      app = await testApp(ports);
      expect((await replaceRequest(app)).statusCode).toBe(500);
    },
  );

  it.each([
    ["missing authentication", {}, null],
    ["non-hotel organization", { kind: "creator_workspace" }, "Bearer valid-token"],
    ["missing permission", { permissions: [] }, "Bearer valid-token"],
    ["missing entitlement", { entitlements: [] }, "Bearer valid-token"],
    ["inactive entitlement", { entitlements: [entitlement("suspended")] }, "Bearer valid-token"],
    [
      "wrong-property entitlement",
      { entitlements: [entitlement("active", otherPropertyId)] },
      "Bearer valid-token",
    ],
    ["missing resource link", { links: [] }, "Bearer valid-token"],
    ["inactive resource link", { links: [link({ status: "suspended" })] }, "Bearer valid-token"],
    [
      "wrong-property resource link",
      { links: [link({ resourceId: otherPropertyId })] },
      "Bearer valid-token",
    ],
    ["wrong relationship", { links: [link({ relationship: "front_desk" })] }, "Bearer valid-token"],
  ] as const)("denies reads and writes for %s", async (_label, auth, token) => {
    const ports = fakePorts();
    app = await testApp(ports, auth as AuthOptions);
    const read = await readRequest(app, token);
    const write = await replaceRequest(app, { authorization: token });

    expect([401, 403]).toContain(read.statusCode);
    expect([401, 403]).toContain(write.statusCode);
    expect(ports.reads).toHaveLength(0);
    expect(ports.commands).toHaveLength(0);
  });

  it("authorizes before malformed JSON is parsed or replay can be inspected", async () => {
    const ports = fakePorts({ commandResult: success("idempotent_replay") });
    app = await testApp(ports);
    const response = await app.inject({
      method: "PUT",
      url: `/properties/${propertyId}/hotel-collaboration-preferences`,
      headers: { "content-type": "application/json", "idempotency-key": "preferences-key" },
      payload: "{",
    });
    expect(response.statusCode).toBe(401);
    expect(ports.commands).toHaveLength(0);
  });

  it.each([null, "   ", "x".repeat(201)])(
    "requires one bounded Idempotency-Key (%s)",
    async (key) => {
      const ports = fakePorts();
      app = await testApp(ports);
      expect((await replaceRequest(app, { key })).statusCode).toBe(400);
      expect(ports.commands).toHaveLength(0);
    },
  );

  it("rejects repeated Idempotency-Key headers", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    expect((await replaceWithRepeatedIdempotencyKeys(app)).statusCode).toBe(400);
    expect(ports.commands).toHaveLength(0);
  });

  it.each([
    ["smuggled scope", { ...requestBody(), organizationId }],
    ["unanswered group", { ...requestBody(), contentTypes: [] }],
    [
      "ambiguous year-round",
      { ...requestBody(), availability: { mode: "year_round", selectedMonths: [1] } },
    ],
    [
      "duplicate month",
      { ...requestBody(), availability: { mode: "selected_months", selectedMonths: [1, 1] } },
    ],
  ])("rejects %s before invoking the command port", async (_label, body) => {
    const ports = fakePorts();
    app = await testApp(ports);
    expect((await replaceRequest(app, { body })).statusCode).toBe(400);
    expect(ports.commands).toHaveLength(0);
  });

  it.each([
    [{ code: "preferences_revision_conflict", currentRevision: 2 }, 409],
    [{ code: "idempotency_key_conflict" }, 409],
    [{ code: "command_in_progress" }, 409],
    [{ code: "setup_scope_unavailable" }, 404],
  ] as const)("maps command error %o to %i", async (error, status) => {
    const ports = fakePorts({ commandResult: { ok: false, error } });
    app = await testApp(ports);
    expect((await replaceRequest(app)).statusCode).toBe(status);
  });

  it.each([
    [
      {
        outcome: "unavailable",
        error: { code: "preference_source_unavailable", errorSource: "system", retryable: true },
      },
      503,
    ],
    [
      {
        outcome: "malformed",
        error: { code: "preference_source_malformed", errorSource: "system", retryable: false },
      },
      500,
    ],
  ] as const)("preserves the distinct %s read outcome", async (readResult, status) => {
    const ports = fakePorts({ readResult });
    app = await testApp(ports);
    expect((await readRequest(app)).statusCode).toBe(status);
  });

  it("fails closed for invalid property IDs and cross-property port data", async () => {
    const invalidPorts = fakePorts();
    app = await testApp(invalidPorts);
    expect((await readRequest(app, "Bearer valid-token", "not-a-property")).statusCode).toBe(400);
    expect(invalidPorts.reads).toHaveLength(0);
    await app.close();

    const crossPropertyPorts = fakePorts({
      readResult: { outcome: "available", readModel: readModel(1, otherPropertyId) },
    });
    app = await testApp(crossPropertyPorts);
    const response = await readRequest(app);
    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      code: "marketplace_hotel_collaboration_preferences_port_contract_violation",
    });
  });

  it("fails closed for a malformed read-port envelope", async () => {
    const ports = fakePorts({
      readResult: { outcome: "available", readModel: readModel(), leaked: "internal" },
    });
    app = await testApp(ports);
    expect((await readRequest(app)).statusCode).toBe(500);
  });

  it.each([
    ["malformed result", { ok: true }],
    [
      "wrong revision",
      {
        ...success(),
        response: { ...success().response, revision: 2, sourceRevision: "preferences:2" },
      },
    ],
    [
      "non-conflicting conflict",
      { ok: false, error: { code: "preferences_revision_conflict", currentRevision: 0 } },
    ],
  ])("fails closed for a %s from the command port", async (_label, commandResult) => {
    const ports = fakePorts({ commandResult });
    app = await testApp(ports);
    expect((await replaceRequest(app)).statusCode).toBe(500);
  });
});
