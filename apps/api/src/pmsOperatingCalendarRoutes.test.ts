import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
  createPmsOperatingCalendarSourceRevision,
  parsePmsCanonicalIanaTimeZone,
  type PmsOperatingCalendarCommandResult,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarCurrentReadResult,
  type PmsOperatingCalendarSourceRevision,
  type UpsertPmsOperatingCalendarCommand,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerPmsOperatingCalendarRoutes,
  type PmsOperatingCalendarRoutesOptions,
} from "./routes/pmsOperatingCalendar.js";

const organizationId = "a6000000-0000-4000-8000-000000000001";
const propertyId = "a6000000-0000-4000-8000-000000000002";
const otherPropertyId = "a6000000-0000-4000-8000-000000000003";
const roomTypeA = "a6000000-0000-4000-8000-000000000004";
const roomTypeB = "a6000000-0000-4000-8000-000000000005";
const actorUserId = "a6000000-0000-4000-8000-000000000006";
const now = "2026-08-04T10:30:00.000Z";
const registry = {
  ownerDomain: "hotel_catalog" as const,
  registryVersion: "test-iana.v1",
  isCanonicalIanaTimeZone: (value: string) => value === "Europe/Berlin",
};
const timeZone = parsePmsCanonicalIanaTimeZone("Europe/Berlin", registry)!;

type AuthOptions = {
  kind?: "hotel_group" | "creator_workspace";
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
};

type FakePorts = PmsOperatingCalendarRoutesOptions & {
  commandCalls: UpsertPmsOperatingCalendarCommand[];
  currentCalls: string[];
  sourceCalls: PmsOperatingCalendarSourceRevision[];
};

describe("PMS operating-calendar routes", () => {
  let app: Awaited<ReturnType<typeof testApp>> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("derives scope, audit, and idempotency while canonicalizing the complete room set", async () => {
    const ports = fakePorts();
    app = await testApp(ports);

    const response = await putCalendar(app, {
      body: commandBody({
        roomTypeLimits: [roomLimit(roomTypeB, 3, 4, 2), roomLimit(roomTypeA, 1, 2, 1)],
      }),
      key: "  calendar-key  ",
    });

    expect(response.statusCode).toBe(201);
    expect(ports.commandCalls).toEqual([
      expect.objectContaining({
        organizationId,
        propertyId,
        expectedCalendarRevision: 0,
        expectedPropertyProfileRevision: 7,
        idempotencyKey: "calendar-key",
        roomTypeLimits: [roomLimit(roomTypeA, 1, 2, 1), roomLimit(roomTypeB, 3, 4, 2)],
        audit: {
          actor: { kind: "user", userId: actorUserId },
          requestId: "request-1",
          correlationId: "correlation-1",
          requestedAt: now,
        },
      }),
    ]);
    expect(response.body).toMatchObject({ outcome: "created", configuration: { propertyId } });
  });

  it("returns 200 for an expected-versioned update", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await putCalendar(app, {
      body: commandBody({ expectedCalendarRevision: 2 }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.configuration.calendarRevision).toBe(3);
  });

  it("rejects smuggled scope and malformed idempotency without calling the port", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    expect(
      (await putCalendar(app, { body: { ...commandBody(), organizationId } })).statusCode,
    ).toBe(400);
    expect((await putCalendar(app, { key: null })).statusCode).toBe(400);
    expect(ports.commandCalls).toHaveLength(0);
  });

  it("authorizes before malformed JSON parsing and rejects repeated idempotency headers", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const unauthorized = await app.inject({
      method: "PUT",
      url: `/properties/${propertyId}/operating-calendar`,
      headers: { "content-type": "application/json", "idempotency-key": "key" },
      payload: "{",
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(await repeatedIdempotencyStatus(app, JSON.stringify(commandBody()))).toBe(400);
    expect(ports.commandCalls).toHaveLength(0);
  });

  it.each([
    ["missing authentication", {}, null],
    ["non-hotel organization", { kind: "creator_workspace" }, "valid-token"],
    ["missing read permission", { permissions: ["pms.operations.manage"] }, "valid-token"],
    ["missing entitlement", { entitlements: [] }, "valid-token"],
    ["missing property link", { links: [] }, "valid-token"],
    ["front desk relationship", { links: [link("front_desk")] }, "valid-token"],
  ] as const)("denies current reads for %s", async (_label, auth, token) => {
    const ports = fakePorts();
    app = await testApp(ports, auth as AuthOptions);
    const response = await getCurrent(app, token);
    expect([401, 403]).toContain(response.statusCode);
    expect(ports.currentCalls).toHaveLength(0);
  });

  it("requires manage permission for writes while allowing owner and operator reads", async () => {
    const denied = fakePorts();
    app = await testApp(denied, { permissions: ["pms.operations.read"] });
    expect((await putCalendar(app)).statusCode).toBe(403);
    await app.close();

    const owner = fakePorts();
    app = await testApp(owner, { links: [link("owner")] });
    expect((await getCurrent(app)).statusCode).toBe(200);
  });

  it("returns the validated current source status without deriving readiness", async () => {
    const stale: PmsOperatingCalendarCurrentReadResult = {
      configuration: snapshot(),
      sourceStatus: "stale",
      sourceConflicts: [
        { code: "room_units_revision_conflict", roomTypeId: roomTypeA, currentRevision: 3 },
      ],
    };
    const ports = fakePorts({ currentResult: stale });
    app = await testApp(ports);
    const response = await getCurrent(app);
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(stale);
    expect(ports.currentCalls).toEqual([propertyId]);
  });

  it("constructs and validates the exact immutable source identity", async () => {
    const ports = fakePorts();
    app = await testApp(ports);
    const response = await getRevision(app, "1");
    expect(response.statusCode).toBe(200);
    expect(ports.sourceCalls).toEqual([createPmsOperatingCalendarSourceRevision(propertyId, 1)]);
    expect(response.body.source).toEqual({
      ownerDomain: "pms",
      entityType: "pms_operating_calendar.v1",
      entityId: propertyId,
      revision: "calendar:1",
    });
  });

  it("distinguishes missing current/source reads and rejects noncanonical revisions", async () => {
    const ports = fakePorts({ currentResult: null, sourceResult: null });
    app = await testApp(ports);
    expect((await getCurrent(app)).body).toEqual({ code: "operating_calendar_not_configured" });
    expect((await getRevision(app, "2")).body).toEqual({
      code: "operating_calendar_source_not_found",
    });
    expect((await getRevision(app, "01")).statusCode).toBe(400);
    expect((await getRevision(app, "2147483648")).statusCode).toBe(400);
  });

  it.each([
    [{ code: "setup_scope_unavailable" }, 404],
    [{ code: "property_timezone_missing" }, 422],
    [{ code: "property_timezone_invalid" }, 422],
    [{ code: "active_room_type_set_empty" }, 422],
    [{ code: "room_capacity_unavailable", roomTypeId: roomTypeA }, 422],
    [
      {
        code: "starting_sellable_limit_exceeds_capacity",
        roomTypeId: roomTypeA,
        physicalCapacityCount: 1,
      },
      422,
    ],
    [{ code: "calendar_revision_conflict", currentRevision: 2 }, 409],
    [{ code: "operating_calendar_unchanged" }, 409],
    [{ code: "idempotency_key_conflict" }, 409],
  ] as const)("maps command error %# without widening it", async (error, status) => {
    const ports = fakePorts({
      commandResult: { ok: false, error } as PmsOperatingCalendarCommandResult,
    });
    app = await testApp(ports);
    const response = await putCalendar(app);
    expect(response.statusCode).toBe(status);
    expect(response.body).toEqual(error);
  });

  it("fails closed on cross-property, wrong-revision, or altered successful port data", async () => {
    const commandResult: PmsOperatingCalendarCommandResult = {
      ok: true,
      response: {
        contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
        outcome: "created",
        configuration: snapshot({ propertyId: otherPropertyId }),
        acceptedAt: now,
      },
    };
    const ports = fakePorts({
      commandResult,
      currentResult: current(snapshot({ propertyId: otherPropertyId })),
    });
    app = await testApp(ports);
    expect((await putCalendar(app)).statusCode).toBe(500);
    expect((await getCurrent(app)).statusCode).toBe(500);
    await app.close();
    app = await testApp(fakePorts({ sourceResult: snapshot({ revision: 2 }) }));
    expect((await getRevision(app, "1")).statusCode).toBe(500);
  });
});

function fakePorts(
  options: {
    commandResult?: PmsOperatingCalendarCommandResult;
    currentResult?: PmsOperatingCalendarCurrentReadResult | null;
    sourceResult?: PmsOperatingCalendarConfigurationSnapshot | null;
  } = {},
): FakePorts {
  const commandCalls: UpsertPmsOperatingCalendarCommand[] = [];
  const currentCalls: string[] = [];
  const sourceCalls: PmsOperatingCalendarSourceRevision[] = [];
  return {
    commandCalls,
    currentCalls,
    sourceCalls,
    timeZoneRegistry: registry,
    commandPort: {
      async upsertOperatingCalendar(command) {
        commandCalls.push(command);
        return options.commandResult ?? success(command);
      },
    },
    readPort: {
      async getCurrentOperatingCalendarConfiguration(requestPropertyId) {
        currentCalls.push(requestPropertyId);
        return options.currentResult === undefined ? current(snapshot()) : options.currentResult;
      },
      async getOperatingCalendarConfigurationBySource(source) {
        sourceCalls.push(source);
        return options.sourceResult === undefined ? snapshot() : options.sourceResult;
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
      linkedResources: auth.links ?? [link("operator")],
      entitlements: auth.entitlements ?? [entitlement()],
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: now,
      },
    } as RequestContext;
  });
  await app.register(registerPmsOperatingCalendarRoutes, ports);
  return app;
}

function success(command: UpsertPmsOperatingCalendarCommand): PmsOperatingCalendarCommandResult {
  return {
    ok: true,
    response: {
      contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
      outcome: command.expectedCalendarRevision === 0 ? "created" : "updated",
      configuration: snapshot({
        propertyId: command.propertyId,
        revision: command.expectedCalendarRevision + 1,
        profileRevision: command.expectedPropertyProfileRevision,
        schedule: command.schedule,
        minimumStay: command.defaultMinimumStayNights,
        rooms: command.roomTypeLimits.map((room) => ({
          roomTypeId: room.roomTypeId,
          sourceRoomFactsRevision: room.expectedRoomFactsRevision,
          sourceRoomUnitsRevision: room.expectedRoomUnitsRevision,
          physicalCapacityCount: Math.max(10, room.startingSellableLimitCount),
          startingSellableLimitCount: room.startingSellableLimitCount,
        })),
      }),
      acceptedAt: now,
    },
  };
}

function snapshot(
  overrides: {
    propertyId?: string;
    revision?: number;
    profileRevision?: number;
    schedule?: UpsertPmsOperatingCalendarCommand["schedule"];
    minimumStay?: number;
    rooms?: PmsOperatingCalendarConfigurationSnapshot["sourceInputs"]["roomBindings"];
  } = {},
): PmsOperatingCalendarConfigurationSnapshot {
  const requestPropertyId = overrides.propertyId ?? propertyId;
  const revision = overrides.revision ?? 1;
  return {
    contractVersion: PMS_OPERATING_CALENDAR_CONTRACT_VERSION,
    propertyId: requestPropertyId,
    calendarRevision: revision,
    source: createPmsOperatingCalendarSourceRevision(requestPropertyId, revision),
    sourceInputs: {
      propertyProfile: {
        ownerDomain: "hotel_catalog",
        entityType: "property_profile",
        entityId: requestPropertyId,
        revision: `profile:${overrides.profileRevision ?? 7}`,
      },
      propertyTimeZone: timeZone,
      roomBindings: overrides.rooms ?? [
        {
          roomTypeId: roomTypeA,
          sourceRoomFactsRevision: 1,
          sourceRoomUnitsRevision: 2,
          physicalCapacityCount: 10,
          startingSellableLimitCount: 1,
        },
      ],
    },
    schedule: overrides.schedule ?? { mode: "year_round", periods: [] },
    defaultMinimumStayNights: overrides.minimumStay ?? 2,
    createdAt: now,
    updatedAt: now,
  };
}

function current(
  configuration: PmsOperatingCalendarConfigurationSnapshot,
): PmsOperatingCalendarCurrentReadResult {
  return { configuration, sourceStatus: "current", sourceConflicts: [] };
}

function commandBody(overrides: Record<string, unknown> = {}) {
  return {
    expectedCalendarRevision: 0,
    expectedPropertyProfileRevision: 7,
    schedule: { mode: "year_round", periods: [] },
    defaultMinimumStayNights: 2,
    roomTypeLimits: [roomLimit(roomTypeA, 1, 2, 1)],
    ...overrides,
  };
}

function roomLimit(roomTypeId: string, facts: number, units: number, limit: number) {
  return {
    roomTypeId,
    expectedRoomFactsRevision: facts,
    expectedRoomUnitsRevision: units,
    startingSellableLimitCount: limit,
  };
}

function entitlement(): ProductEntitlement {
  return {
    product: "pms",
    key: "property-management",
    status: "active",
    resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
  };
}

function link(relationship: LinkedResource["relationship"]): LinkedResource {
  return {
    product: "pms",
    resourceType: "pms_property",
    resourceId: propertyId,
    relationship,
    status: "active",
  };
}

async function putCalendar(
  app: Awaited<ReturnType<typeof testApp>>,
  options: { body?: unknown; key?: string | null } = {},
) {
  const headers: Record<string, string> = { authorization: "Bearer valid-token" };
  if (options.key !== null) headers["idempotency-key"] = options.key ?? "calendar-key";
  return injectJson<Record<string, any>>(app, {
    method: "PUT",
    url: `/properties/${propertyId}/operating-calendar`,
    headers,
    payload: options.body ?? commandBody(),
  });
}

function getCurrent(
  app: Awaited<ReturnType<typeof testApp>>,
  token: string | null = "valid-token",
) {
  return injectJson<Record<string, any>>(app, {
    method: "GET",
    url: `/properties/${propertyId}/operating-calendar`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function getRevision(app: Awaited<ReturnType<typeof testApp>>, revision: string) {
  return injectJson<Record<string, any>>(app, {
    method: "GET",
    url: `/properties/${propertyId}/operating-calendar/revisions/${revision}`,
    headers: { authorization: "Bearer valid-token" },
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
        path: `/properties/${propertyId}/operating-calendar`,
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
