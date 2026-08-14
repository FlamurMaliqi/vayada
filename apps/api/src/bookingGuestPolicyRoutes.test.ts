import type {
  LinkedResource,
  OrganizationKind,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import {
  BOOKING_GUEST_POLICY_CONTRACT_VERSION,
  type BookingGuestPolicyApplicationPort,
  type BookingGuestPolicyRevision,
} from "@vayada/domain-booking";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  actorUserId,
  appliedReceipt,
  applicationHarness,
  choices,
  compositionFixture,
  currentEvidence,
  now,
  organizationId,
  otherPropertyId,
  propertyId,
  revisionFixture,
} from "./bookingGuestPolicyTestFixtures.js";
import { registerBookingGuestPolicyRoutes } from "./routes/bookingGuestPolicy.js";
import { buildApp } from "./app.js";

describe("protected Booking guest-policy routes", () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("mounts the protected production route only with its application", async () => {
    const disabled = buildApp({ logger: false });
    const path = `/api/booking/properties/${propertyId}/booking-guest-policy`;
    expect((await disabled.inject({ method: "GET", url: path })).statusCode).toBe(404);
    await disabled.close();

    app = buildApp({
      logger: false,
      bookingGuestPolicy: {
        application: routeApplication(
          revisionFixture(),
          compositionFixture(),
          firstVisitReadiness(),
          [],
        ),
      },
    });
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
  });

  it("serves setup, preview, command, and readiness through one exact authorized scope", async () => {
    const current = revisionFixture({ projectionReceipt: appliedReceipt() });
    const composition = compositionFixture();
    const readiness = await applicationHarness({ current }).application.getGuestPolicyReadiness({
      organizationId,
      propertyId,
    });
    const calls: unknown[] = [];
    const application = routeApplication(current, composition, readiness, calls);
    app = await routeApp(application);

    const setupResponse = await get(app, "");
    const previewResponse = await post(app, "/preview", { choices });
    const commandResponse = await put(app, {
      expectedRevision: 0,
      expectedSourceFingerprint: composition.bundle.sourceFingerprint,
      choices,
      confirmPolicyBundle: true,
    });
    const readinessResponse = await get(app, "/readiness");

    expect([
      setupResponse.statusCode,
      previewResponse.statusCode,
      commandResponse.statusCode,
      readinessResponse.statusCode,
    ]).toEqual([200, 200, 201, 200]);
    expect(calls).toContainEqual(
      expect.objectContaining({
        idempotencyKey: "route-key",
        organizationId,
        propertyId,
        audit: {
          actor: { kind: "user", userId: actorUserId },
          requestId: "request-1",
          correlationId: "correlation-1",
          requestedAt: now,
        },
      }),
    );
  });

  it.each([
    ["missing authentication", {}, null],
    ["invalid authentication", {}, "Bearer invalid-token"],
    [
      "wrong organization",
      { organizationKind: "creator_workspace" as const },
      "Bearer valid-token",
    ],
    ["missing permission", { permissions: [] }, "Bearer valid-token"],
    ["missing entitlement", { entitlements: [] }, "Bearer valid-token"],
    ["inactive entitlement", { entitlements: [entitlement("suspended")] }, "Bearer valid-token"],
    [
      "wrong-property entitlement",
      { entitlements: [entitlement("active", otherPropertyId)] },
      "Bearer valid-token",
    ],
    ["missing link", { links: [] }, "Bearer valid-token"],
    ["inactive link", { links: [link({ status: "suspended" })] }, "Bearer valid-token"],
    [
      "wrong-property link",
      { links: [link({ resourceId: otherPropertyId })] },
      "Bearer valid-token",
    ],
    ["front desk", { links: [link({ relationship: "front_desk" })] }, "Bearer valid-token"],
  ] as const)("denies %s before application access", async (_name, auth, token) => {
    const application = routeApplication(
      revisionFixture(),
      compositionFixture(),
      firstVisitReadiness(),
      [],
    );
    app = await routeApp(application, auth as AuthOptions);
    const responses = await Promise.all([
      get(app, "", token),
      post(app, "/preview", { unsafe: true }, token),
      put(app, { unsafe: true }, token),
      get(app, "/readiness", token),
    ]);
    const expected = token === "Bearer valid-token" ? 403 : 401;
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([
      expected,
      expected,
      expected,
      expected,
    ]);
    expect(application.getGuestPolicySetup).not.toHaveBeenCalled();
    expect(application.previewGuestPolicy).not.toHaveBeenCalled();
    expect(application.upsertGuestPolicy).not.toHaveBeenCalled();
    expect(application.getGuestPolicyReadiness).not.toHaveBeenCalled();
  });

  it("authorizes before Fastify parses malformed JSON", async () => {
    const application = routeApplication(
      revisionFixture(),
      compositionFixture(),
      firstVisitReadiness(),
      [],
    );
    app = await routeApp(application, { authenticated: false });
    const response = await app.inject({
      method: "PUT",
      url: `/properties/${propertyId}/booking-guest-policy`,
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(response.statusCode).toBe(401);
    expect(application.upsertGuestPolicy).not.toHaveBeenCalled();
  });
});

function routeApplication(
  current: BookingGuestPolicyRevision,
  composition: ReturnType<typeof compositionFixture>,
  readiness: Awaited<ReturnType<BookingGuestPolicyApplicationPort["getGuestPolicyReadiness"]>>,
  calls: unknown[],
) {
  return {
    getGuestPolicySetup: vi.fn(async (scope) => ({
      contractVersion: BOOKING_GUEST_POLICY_CONTRACT_VERSION,
      ...scope,
      supportedLanguages: ["en", "de", "fr", "es", "id", "nl"] as const,
      draft: null,
      current,
      composition,
    })),
    previewGuestPolicy: vi.fn(async (input) => {
      calls.push(input);
      return composition;
    }),
    upsertGuestPolicy: vi.fn(async (input) => {
      calls.push(input);
      return { ok: true as const, outcome: "created" as const, revision: current };
    }),
    getGuestPolicyReadiness: vi.fn(async (scope) => {
      calls.push(scope);
      return readiness;
    }),
  } satisfies BookingGuestPolicyApplicationPort;
}

function firstVisitReadiness() {
  const evidence = currentEvidence(null);
  if (evidence.outcome !== "available") throw new Error("Expected available owner evidence");
  return {
    contractVersion: "booking-guest-policy-readiness.v1" as const,
    organizationId,
    propertyId,
    status: "blocked" as const,
    guestPolicySourceRevision: "guest-policy:absent" as const,
    sourceFingerprint: null,
    currentBaseRevisions: evidence.currentBaseRevisions,
    blockers: [{ code: "guest_policy_not_configured" as const, kind: "user_fixable" as const }],
  };
}

type AuthOptions = {
  authenticated?: boolean;
  organizationKind?: OrganizationKind;
  permissions?: readonly PermissionKey[];
  entitlements?: readonly ProductEntitlement[];
  links?: readonly LinkedResource[];
};

async function routeApp(application: BookingGuestPolicyApplicationPort, auth: AuthOptions = {}) {
  const app = Fastify({ logger: false });
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (auth.authenticated === false || request.headers.authorization !== "Bearer valid-token")
      return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: {
        organizationId,
        kind: auth.organizationKind ?? "hotel_group",
      },
      membership: { permissions: [...(auth.permissions ?? ["booking.settings.manage"])] },
      linkedResources: [...(auth.links ?? [link()])],
      entitlements: [...(auth.entitlements ?? [entitlement()])],
      locale: "en",
      currency: "EUR",
      audit: {
        requestId: "request-1",
        correlationId: "correlation-1",
        source: "api",
        receivedAt: now,
      },
    } as RequestContext;
  });
  await app.register(registerBookingGuestPolicyRoutes, { application });
  return app;
}

function entitlement(
  status: ProductEntitlement["status"] = "active",
  resourceId = propertyId,
): ProductEntitlement {
  return {
    product: "booking",
    key: "booking-engine",
    status,
    resource: { product: "booking", resourceType: "booking_hotel", resourceId },
  };
}

function link(overrides: Partial<LinkedResource> = {}): LinkedResource {
  return {
    product: "booking",
    resourceType: "booking_hotel",
    resourceId: propertyId,
    relationship: "owner",
    status: "active",
    ...overrides,
  };
}

function get(
  app: FastifyInstance,
  suffix: string,
  authorization: string | null = "Bearer valid-token",
) {
  return injectJson(app, {
    method: "GET",
    url: `/properties/${propertyId}/booking-guest-policy${suffix}`,
    ...(authorization ? { headers: { authorization } } : {}),
  });
}

function post(
  app: FastifyInstance,
  suffix: string,
  payload: unknown,
  authorization: string | null = "Bearer valid-token",
) {
  return injectJson(app, {
    method: "POST",
    url: `/properties/${propertyId}/booking-guest-policy${suffix}`,
    ...(authorization ? { headers: { authorization } } : {}),
    payload: payload as Record<string, unknown>,
  });
}

function put(
  app: FastifyInstance,
  payload: unknown,
  authorization: string | null = "Bearer valid-token",
) {
  return injectJson(app, {
    method: "PUT",
    url: `/properties/${propertyId}/booking-guest-policy`,
    headers: {
      ...(authorization ? { authorization } : {}),
      "idempotency-key": "route-key",
    },
    payload: payload as Record<string, unknown>,
  });
}
