import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import type { MembershipPropertyScope } from "@vayada/backend-authorization";
import {
  PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
  type PmsCalendarAutoOpenSetupError,
  type PmsCalendarAutoOpenSettingsPort,
  type UpdatePmsCalendarAutoOpenSetting,
} from "@vayada/domain-pms";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerPmsCalendarAutoOpenRoutes } from "./routes/pmsCalendarAutoOpen.js";

const propertyId = "14340000-0000-4000-8000-000000000001";
const otherPropertyId = "14340000-0000-4000-8000-000000000002";
const actorUserId = "14340000-0000-4000-8000-000000000003";
const organizationId = "14340000-0000-4000-8000-000000000004";
const evaluatedAt = "2026-09-03T08:00:00.000Z";
const warning = {
  code: "missing_rate" as const,
  roomTypeId: "14340000-0000-4000-8000-000000000006",
  from: "2027-01-01",
  through: "2027-01-31",
};

type Auth = {
  permissions?: PermissionKey[];
  entitlements?: ProductEntitlement[];
  links?: LinkedResource[];
  kind?: RequestContext["selectedOrganization"]["kind"];
  scope?: MembershipPropertyScope | null;
};

describe("PMS calendar auto-open routes", () => {
  let app: Awaited<ReturnType<typeof testApp>>["app"] | undefined;
  afterEach(async () => app?.close());

  it("reads the canonical setting and property-local horizon", async () => {
    const test = await testApp();
    app = test.app;
    const response = await app.inject({
      method: "GET",
      url: route(propertyId),
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
      setting: { propertyId, revision: 0, enabled: false },
      horizon: {
        propertyTimeZone: "Asia/Taipei",
        propertyLocalDate: "2026-09-03",
        targetOpenThrough: null,
      },
      warnings: [warning],
      setupError: null,
    });
    expect(test.findContext).toHaveBeenCalledWith(propertyId);
  });

  it("does not expose a target horizon when canonical setup is stale", async () => {
    const test = await testApp(
      {},
      success(),
      { code: "operating_calendar_room_bindings_stale" },
      setting(3, true),
    );
    app = test.app;
    const response = await app.inject({
      method: "GET",
      url: route(propertyId),
      headers: headers(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      setting: { enabled: true },
      horizon: { targetOpenThrough: null },
      setupError: { code: "operating_calendar_room_bindings_stale" },
    });
  });

  it.each(["owner", "operator"] as const)(
    "allows a %s to save the exact command and returns its enqueue intent",
    async (relationship) => {
      const test = await testApp({ links: links(relationship) }, success(), null, setting(1, true));
      const response = await test.app.inject({
        method: "PATCH",
        url: route(propertyId.toUpperCase()),
        headers: headers("  save-key  "),
        payload: body(),
      });
      await test.app.close();

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        outcome: "created",
        setting: { propertyId, revision: 1, enabled: true },
        horizon: { targetOpenThrough: "2028-03-31" },
        warnings: [warning],
        setupError: null,
        enqueueIntentId: "14340000-0000-4000-8000-000000000005",
      });
      expect(test.updates[0]).toMatchObject({
        propertyId,
        expectedRevision: 0,
        idempotencyKey: "save-key",
        audit: {
          actorUserId,
          requestId: "request-1",
          correlationId: "correlation-1",
          requestedAt: evaluatedAt,
        },
      });
    },
  );

  it("returns paused live readiness when an exact successful retry finds stale setup", async () => {
    const test = await testApp(
      {},
      success(),
      { code: "operating_calendar_room_bindings_stale" },
      setting(1, true),
    );
    app = test.app;

    const response = await app.inject({
      method: "PATCH",
      url: route(propertyId),
      headers: headers("retried-save-key"),
      payload: body(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      setting: { revision: 1, enabled: true },
      horizon: { targetOpenThrough: null },
      setupError: { code: "operating_calendar_room_bindings_stale" },
    });
    expect(test.findContext).toHaveBeenCalledWith(propertyId);
  });

  it("rejects missing idempotency, extra keys, and invalid mode combinations", async () => {
    const test = await testApp();
    app = test.app;
    const requests = [
      { headers: headers(), payload: body() },
      { headers: headers("extra"), payload: { ...body(), invented: true } },
      {
        headers: headers("invalid"),
        payload: body({ mode: "fixed", rollingMonths: 18, fixedEndMonth: "2028-06" }),
      },
    ];
    for (const request of requests) {
      const response = await app.inject({ method: "PATCH", url: route(propertyId), ...request });
      expect(response.statusCode).toBe(400);
    }
    expect(test.updates).toEqual([]);
  });

  it("maps repository validation and conflict results without hiding their codes", async () => {
    const cases = [
      [{ code: "property_time_zone_invalid" }, 422],
      [{ code: "operating_calendar_not_configured" }, 409],
      [{ code: "operating_calendar_room_bindings_stale" }, 409],
      [{ code: "physical_room_labels_unverified" }, 409],
      [{ code: "calendar_auto_open_revision_conflict", currentRevision: 2 }, 409],
      [{ code: "idempotency_key_conflict" }, 409],
    ] as const;
    for (const [error, status] of cases) {
      const test = await testApp({}, { ok: false, error });
      const response = await test.app.inject({
        method: "PATCH",
        url: route(propertyId),
        headers: headers("save-key"),
        payload: body(),
      });
      await test.app.close();
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(error);
    }
  });

  it("denies the protected access matrix before any settings call", async () => {
    const cases: readonly [string, Record<string, string>, Auth][] = [
      ["missing auth", {}, {}],
      ["invalid auth", { authorization: "Bearer invalid" }, {}],
      ["missing permission", headers(), { permissions: [] }],
      ["missing entitlement", headers(), { entitlements: [] }],
      ["inactive entitlement", headers(), { entitlements: [entitlement("suspended")] }],
      ["missing linkage", headers(), { links: [] }],
      ["front desk", headers(), { links: links("front_desk") }],
      [
        "membership property scope",
        headers(),
        {
          scope: {
            mode: "assigned",
            roleKey: "operator",
            accessOrigin: "agency",
            assignedPropertyIds: [otherPropertyId],
          },
        },
      ],
      ["organization kind", headers(), { kind: "affiliate_partner" }],
    ];
    for (const [name, requestHeaders, auth] of cases) {
      const test = await testApp(auth);
      const response = await test.app.inject({
        method: "GET",
        url: route(propertyId),
        headers: requestHeaders,
      });
      await test.app.close();
      expect(response.statusCode, name).toBe(name.includes("auth") ? 401 : 403);
      expect(test.findContext, name).not.toHaveBeenCalled();
      expect(test.updates, name).toEqual([]);
    }
  });

  it("uses the PMS operations origin allowlist for browser requests", async () => {
    const test = await testApp();
    app = test.app;
    const preflight = await app.inject({
      method: "OPTIONS",
      url: route(propertyId),
      headers: {
        origin: "https://pms.localhost",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "authorization,content-type,idempotency-key",
      },
    });
    const rejected = await app.inject({
      method: "GET",
      url: route(propertyId),
      headers: { ...headers(), origin: "https://untrusted.example" },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://pms.localhost");
    expect(preflight.headers["access-control-allow-headers"]).toContain("idempotency-key");
    expect(rejected.statusCode).toBe(403);
    expect(test.findContext).not.toHaveBeenCalled();
  });
});

async function testApp(
  auth: Auth = {},
  updateResult: Awaited<ReturnType<PmsCalendarAutoOpenSettingsPort["update"]>> = success(),
  setupError: PmsCalendarAutoOpenSetupError | null = null,
  contextSetting = setting(0, false),
) {
  const app = Fastify({ logger: false });
  const updates: UpdatePmsCalendarAutoOpenSetting[] = [];
  const findContext = vi.fn(async () => ({
    setting: contextSetting,
    propertyTimeZone: "Asia/Taipei",
    warnings: [warning],
    setupError,
  }));
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (request.headers.authorization === "Bearer valid") request.authContext = context(auth);
  });
  await app.register(registerPmsCalendarAutoOpenRoutes, {
    settings: {
      async find() {
        return setting(0, false);
      },
      findContext,
      async update(command) {
        updates.push(command);
        return updateResult;
      },
    },
    propertyAccessRepository: {
      async findMembershipPropertyScope() {
        return auth.scope === undefined
          ? {
              mode: "all",
              roleKey: "operator",
              accessOrigin: "agency",
              assignedPropertyIds: [],
            }
          : auth.scope;
      },
    },
    allowedOrigins: ["https://pms.localhost"],
  });
  return { app, updates, findContext };
}

function context(auth: Auth): RequestContext {
  return {
    actor: {
      internalUserId: actorUserId,
      providerIdentity: { provider: "workos", providerUserId: "user-1" },
      email: "operator@example.test",
      status: "active",
    },
    selectedOrganization: {
      organizationId,
      kind: auth.kind ?? "hotel_group",
      status: "active",
    },
    membership: {
      membershipId: "membership-1",
      status: "active",
      roleKey: "operator",
      workosRoleSlugs: [],
      permissions: auth.permissions ?? ["pms.operations.manage"],
    },
    linkedResources: auth.links ?? links("operator"),
    entitlements: auth.entitlements ?? [entitlement()],
    locale: "en",
    currency: "EUR",
    audit: {
      requestId: "request-1",
      correlationId: "correlation-1",
      source: "api",
      receivedAt: evaluatedAt,
    },
  };
}

function setting(revision: number, enabled: boolean) {
  return {
    contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
    propertyId,
    revision,
    enabled,
    mode: "rolling" as const,
    rollingMonths: 18 as const,
    fixedEndMonth: null,
    updatedAt: revision ? evaluatedAt : null,
  };
}

function success() {
  return {
    ok: true as const,
    outcome: "created" as const,
    setting: setting(1, true),
    propertyTimeZone: "Asia/Taipei",
    evaluatedAt,
    enqueueIntentId: "14340000-0000-4000-8000-000000000005",
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

function links(relationship: LinkedResource["relationship"]): LinkedResource[] {
  return [
    {
      product: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      relationship,
      status: "active",
    },
    {
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
      relationship,
      status: "active",
    },
  ];
}

function route(scope: string) {
  return `/properties/${scope}/calendar-auto-open`;
}

function headers(idempotencyKey?: string) {
  return {
    authorization: "Bearer valid",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    expectedRevision: 0,
    enabled: true,
    mode: "rolling",
    rollingMonths: 18,
    fixedEndMonth: null,
    ...overrides,
  };
}
