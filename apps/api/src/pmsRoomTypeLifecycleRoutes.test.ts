import type { RequestContext } from "@vayada/backend-auth";
import type { PmsRoomTypeRetirementImpact } from "@vayada/domain-pms";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPmsOperationsRoutes } from "./routes/pmsOperations.js";
import type {
  PmsOperationsCommandRepository,
  PmsOperationsReadRepository,
  PmsRoomType,
} from "./routes/pmsOperations.js";

const propertyId = "87000000-0000-4000-8000-000000000001";
const otherPropertyId = "87000000-0000-4000-8000-000000000002";
const roomTypeId = "87000000-0000-4000-8000-000000000003";
const duplicateId = "87000000-0000-4000-8000-000000000004";
const actorId = "87000000-0000-4000-8000-000000000005";
const organizationId = "87000000-0000-4000-8000-000000000006";
const version = "room-type-facts-v3";

const roomType: PmsRoomType = {
  roomTypeId: duplicateId,
  version: "room-type-facts-v1",
  name: "Alpine Suite Copy",
  description: "Alpine suite",
  category: "suite",
  occupancyLimits: { total: 2 },
  attributes: {},
  amenities: [],
  media: [],
  roomMediaRevision: 1,
  baseRate: { amountDecimal: "180.00", currency: "EUR" },
  active: true,
  sortOrder: 2,
  ratePlans: [],
  rateRulesSummary: {
    minStayNights: null,
    maxStayNights: null,
    closedToArrival: false,
    closedToDeparture: false,
    activeRuleCount: 0,
  },
  roomCount: 0,
};

const clearImpact: PmsRoomTypeRetirementImpact = {
  contractVersion: "pms-room-type-lifecycle.v1",
  propertyId,
  roomTypeId,
  version,
  canRetire: true,
  blockers: [],
};

describe("PMS room type lifecycle routes", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => app?.close());

  it("protects and preserves versioned duplicate and retirement command envelopes", async () => {
    const test = await testApp();
    app = test.app;
    test.commands.duplicateRoomType.mockResolvedValue({
      ok: true,
      roomType,
      commandMeta: commandMeta("duplicate-command"),
    });
    test.commands.inspectRoomTypeRetirement.mockResolvedValue(clearImpact);
    test.commands.retireRoomType.mockResolvedValue({
      ok: true,
      impact: { ...clearImpact, version: "room-type-facts-v4", canRetire: false },
      commandMeta: commandMeta("retire-command"),
    });

    const duplicate = await inject(app, "POST", `${endpoint()}/duplicate`, body("duplicate"));
    const impact = await inject(app, "GET", `${endpoint()}/retirement-impact`);
    const retired = await inject(app, "DELETE", endpoint(), body("retire"));

    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json()).toMatchObject({ propertyId, item: { roomTypeId: duplicateId } });
    expect(impact.json()).toEqual(clearImpact);
    expect(retired.statusCode).toBe(200);
    expect(test.commands.duplicateRoomType).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId,
        roomTypeId,
        expectedVersion: version,
        audit: expect.objectContaining({
          actor: { kind: "user", userId: actorId, organizationId },
          requestId: "request-1",
        }),
      }),
    );
    expect(test.commands.retireRoomType).toHaveBeenCalledWith(
      expect.objectContaining({ propertyId, roomTypeId, expectedVersion: version }),
    );
  });

  it("returns actionable retirement conflicts without losing the typed impact", async () => {
    const blocked: PmsRoomTypeRetirementImpact = {
      ...clearImpact,
      canRetire: false,
      blockers: [
        {
          category: "reservations",
          code: "active_reservations",
          affectedCount: 2,
          action: "Move or release active reservations.",
        },
      ],
    };
    const test = await testApp();
    app = test.app;
    test.commands.retireRoomType.mockResolvedValue({
      ok: false,
      statusCode: 409,
      code: "room_type_retirement_blocked",
      message: "Resolve dependencies.",
      impact: blocked,
    });

    const response = await inject(app, "DELETE", endpoint(), body("retire"));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      statusCode: 409,
      code: "room_type_retirement_blocked",
      category: "conflict",
      message: "Resolve dependencies.",
      impact: blocked,
    });
  });

  it.each([
    ["permission", context({ permissions: [] })],
    ["entitlement", context({ entitlements: [] })],
    ["resource", context({ linkedResources: [] })],
  ])("denies missing %s authorization before dispatch", async (_name, authContext) => {
    const test = await testApp(authContext);
    app = test.app;
    expect(
      (await inject(app, "POST", `${endpoint()}/duplicate`, body("duplicate"))).statusCode,
    ).toBe(403);
    expect(test.commands.duplicateRoomType).not.toHaveBeenCalled();
  });

  it("rejects malformed and cross-property lifecycle requests before dispatch", async () => {
    const test = await testApp();
    app = test.app;
    expect(
      (
        await inject(
          app,
          "POST",
          `${endpoint()}/duplicate`,
          body("duplicate", { expectedVersion: "" }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await inject(app, "DELETE", endpoint(otherPropertyId), body("retire"))).statusCode,
    ).toBe(403);
    expect(test.commands.duplicateRoomType).not.toHaveBeenCalled();
    expect(test.commands.retireRoomType).not.toHaveBeenCalled();
  });
});

async function testApp(authContext: RequestContext = context()) {
  const app = Fastify({ logger: false });
  const commands = {
    duplicateRoomType: vi.fn<PmsOperationsCommandRepository["duplicateRoomType"]>(),
    inspectRoomTypeRetirement: vi.fn<PmsOperationsCommandRepository["inspectRoomTypeRetirement"]>(),
    retireRoomType: vi.fn<PmsOperationsCommandRepository["retireRoomType"]>(),
  };
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization === "Bearer valid") request.authContext = authContext;
  });
  await app.register(registerPmsOperationsRoutes, {
    repository: {} as PmsOperationsReadRepository,
    commandRepository: commands as unknown as PmsOperationsCommandRepository,
  });
  return { app, commands };
}

function context(
  overrides: Partial<Pick<RequestContext, "membership" | "entitlements" | "linkedResources">> & {
    permissions?: RequestContext["membership"]["permissions"];
  } = {},
): RequestContext {
  return {
    actor: { internalUserId: actorId },
    selectedOrganization: { organizationId, kind: "hotel_group" },
    membership: { permissions: overrides.permissions ?? ["pms.operations.manage"] },
    entitlements: overrides.entitlements ?? [
      {
        product: "pms",
        key: "property-management",
        status: "active",
        resource: { product: "pms", resourceType: "pms_property", resourceId: propertyId },
      },
    ],
    linkedResources: overrides.linkedResources ?? [
      {
        product: "pms",
        resourceType: "pms_property",
        resourceId: propertyId,
        relationship: "operator",
        status: "active",
      },
    ],
    audit: { requestId: "request-1", source: "api", receivedAt: "2026-09-01T08:00:00.000Z" },
  } as RequestContext;
}

function inject(
  app: ReturnType<typeof Fastify>,
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: unknown,
) {
  return app.inject({ method, url, headers: { authorization: "Bearer valid" }, payload });
}

const endpoint = (scope = propertyId) => `/properties/${scope}/room-types/${roomTypeId}`;
const body = (prefix: string, overrides: Record<string, unknown> = {}) => ({
  commandId: `${prefix}-command`,
  idempotencyKey: `${prefix}-key`,
  expectedVersion: version,
  ...overrides,
});
const commandMeta = (commandId: string) => ({
  contractVersion: "pms-operations.v1" as const,
  commandId,
  idempotencyKey: commandId,
  acceptedAt: "2026-09-01T08:00:00.000Z",
  sideEffects: ["ari_changed", "distribution_refresh", "audit_event"] as Array<
    "ari_changed" | "distribution_refresh" | "audit_event"
  >,
});
