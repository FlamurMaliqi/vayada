import type { LinkedResource, ProductEntitlement, RequestContext } from "@vayada/backend-auth";
import type { MembershipPropertyScope } from "@vayada/backend-authorization";
import { injectJson } from "@vayada/backend-test";
import type {
  BookingDesignReadinessPort,
  BookingDesignReadinessResult,
} from "@vayada/domain-booking";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerBookingDesignReadinessRoutes } from "./routes/bookingDesignReadiness.js";

const propertyId = "123e4567-e89b-42d3-a456-426614174000";
const otherPropertyId = "523e4567-e89b-42d3-a456-426614174000";
const foreignPropertyId = "623e4567-e89b-42d3-a456-426614174000";
const organizationId = "323e4567-e89b-42d3-a456-426614174000";
const actorUserId = "423e4567-e89b-42d3-a456-426614174000";
const receivedAt = "2026-08-04T12:00:00.000Z";

function fallbackReady(): BookingDesignReadinessResult {
  const designSource = {
    ownerDomain: "booking" as const,
    entityType: "design_revision" as const,
    entityId: propertyId,
    revision: "design:3",
  };
  return {
    outcome: "ready",
    organizationId,
    propertyId,
    designSource,
    snapshot: {
      contractVersion: "booking-design-renderer.v1",
      organizationId,
      propertyId,
      sourceBindings: [
        designSource,
        {
          ownerDomain: "hotel_catalog",
          entityType: "property_media_assignment",
          entityId: propertyId,
          revision: "profile:7",
        },
        {
          ownerDomain: "hotel_catalog",
          entityType: "property_profile",
          entityId: propertyId,
          revision: "profile:7",
        },
      ],
      appearance: {
        primaryColor: "#4F46E5",
        fontPairing: "high-end-serif",
        headingFontFamily: "'Playfair Display', serif",
        bodyFontFamily: "'Source Sans Pro', sans-serif",
        button: {
          backgroundColor: "#463eca",
          hoverBackgroundColor: "#3932a5",
          foregroundColor: "#FFFFFF",
        },
      },
      profile: {
        displayName: "Hotel Alpenrose",
        contentLocale: "en",
        shortDescription:
          "A calm alpine hotel with welcoming rooms and a view of the surrounding peaks.",
      },
      cover: { kind: "fallback", path: "/vayada-logo.png" },
    },
  };
}

type HarnessOptions = {
  authenticated?: boolean;
  context?: RequestContext;
  scope?: MembershipPropertyScope | null;
};

async function testApp(value: unknown, options: HarnessOptions = {}) {
  const {
    authenticated = true,
    context = requestContext(),
    scope = { mode: "all", assignedPropertyIds: [] },
  } = options;
  const app = Fastify({ logger: false });
  const read = vi.fn().mockResolvedValue(value);
  const findMembershipPropertyScope = vi.fn().mockResolvedValue(scope);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (!authenticated || request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = context;
  });
  await app.register(registerBookingDesignReadinessRoutes, {
    propertyAccessRepository: { findMembershipPropertyScope },
    readinessPort: { getBookingDesignReadiness: read } as BookingDesignReadinessPort,
  });
  return { app, read };
}

describe("Booking design readiness route", () => {
  let app: Awaited<ReturnType<typeof testApp>>["app"] | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it.each([
    [fallbackReady(), 200],
    [
      {
        outcome: "blocked",
        organizationId,
        propertyId,
        blocker: { code: "booking_design_missing", evidencePort: "design" },
      },
      200,
    ],
    [
      {
        outcome: "provider_failure",
        organizationId,
        propertyId,
        error: {
          code: "booking_design_profile_unavailable",
          evidencePort: "profile",
          errorSource: "system",
        },
      },
      503,
    ],
  ] as const)("serves strict renderer-readiness outcome %#", async (value, statusCode) => {
    const harness = await testApp(value);
    app = harness.app;
    const response = await get(app);
    expect(response).toMatchObject({ statusCode, body: value });
    expect(harness.read).toHaveBeenCalledWith({ organizationId, propertyId });
  });

  it("allows an explicitly assigned property", async () => {
    const harness = await testApp(fallbackReady(), {
      scope: { mode: "assigned", assignedPropertyIds: [propertyId] },
    });
    app = harness.app;

    expect(await get(app)).toMatchObject({ statusCode: 200 });
    expect(harness.read).toHaveBeenCalledWith({ organizationId, propertyId });
  });

  it.each([
    ["missing authentication", { authenticated: false }, 401, "unauthenticated"],
    [
      "missing permission",
      {
        context: requestContext({
          membership: { ...requestContext().membership, permissions: [] },
        }),
      },
      403,
      "forbidden",
    ],
    [
      "inactive membership",
      {
        context: requestContext({
          membership: { ...requestContext().membership, status: "inactive" },
        }),
      },
      403,
      "forbidden",
    ],
    [
      "no property assignment",
      { scope: { mode: "assigned", assignedPropertyIds: [] } },
      403,
      "forbidden",
    ],
    [
      "missing target resource",
      { context: requestContext({ linkedResources: [canonicalLink()] }) },
      403,
      "forbidden",
    ],
    ["missing entitlement", { context: requestContext({ entitlements: [] }) }, 403, "forbidden"],
    [
      "suspended entitlement",
      { context: requestContext({ entitlements: [entitlement("suspended")] }) },
      403,
      "forbidden",
    ],
  ] as const)("denies %s before reading readiness", async (_name, options, statusCode, code) => {
    const harness = await testApp(fallbackReady(), options);
    app = harness.app;

    expect(await get(app)).toMatchObject({ statusCode, body: { code } });
    expect(harness.read).not.toHaveBeenCalled();
  });

  it("returns the same denial for an unassigned and foreign property", async () => {
    let harness = await testApp(fallbackReady(), {
      context: requestContext({ linkedResources: [...links(), ...links(otherPropertyId)] }),
      scope: { mode: "assigned", assignedPropertyIds: [propertyId] },
    });
    app = harness.app;
    const unassigned = await get(app, otherPropertyId);
    expect(harness.read).not.toHaveBeenCalled();
    await app.close();

    harness = await testApp(fallbackReady(), {
      scope: { mode: "assigned", assignedPropertyIds: [foreignPropertyId] },
    });
    app = harness.app;
    const foreign = await get(app, foreignPropertyId);
    expect(harness.read).not.toHaveBeenCalled();

    expect(unassigned).toMatchObject({ statusCode: 403, body: { code: "forbidden" } });
    expect(foreign).toEqual(unassigned);
  });

  it("fails closed after the protected port boundary", async () => {
    const harness = await testApp({ ...fallbackReady(), propertyId: actorUserId });
    app = harness.app;

    expect(await get(app)).toMatchObject({
      statusCode: 500,
      body: { code: "booking_design_readiness_port_contract_violation" },
    });
  });
});

function requestContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    actor: {
      internalUserId: actorUserId,
      providerIdentity: { provider: "workos", providerUserId: "user_1" },
      email: "owner@example.com",
      status: "active",
    },
    selectedOrganization: { organizationId, kind: "hotel_group", status: "active" },
    membership: {
      membershipId: "723e4567-e89b-42d3-a456-426614174000",
      status: "active",
      roleKey: "hotel_owner",
      workosRoleSlugs: ["hotel_owner"],
      permissions: ["booking.settings.manage"],
    },
    linkedResources: links(),
    entitlements: [entitlement()],
    locale: "en",
    currency: "EUR",
    audit: { requestId: "request-1", source: "api", receivedAt },
    ...overrides,
  };
}

function entitlement(status: ProductEntitlement["status"] = "active"): ProductEntitlement {
  return {
    product: "booking",
    key: "booking-engine",
    status,
    resource: { product: "booking", resourceType: "booking_hotel", resourceId: propertyId },
  };
}

function canonicalLink(resourceId = propertyId): LinkedResource {
  return {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId,
    relationship: "owner",
    status: "active",
  };
}

function bookingLink(resourceId = propertyId): LinkedResource {
  return {
    product: "booking",
    resourceType: "booking_hotel",
    resourceId,
    relationship: "owner",
    status: "active",
  };
}

function links(resourceId = propertyId): LinkedResource[] {
  return [canonicalLink(resourceId), bookingLink(resourceId)];
}

function get(server: ReturnType<typeof Fastify>, requestedPropertyId = propertyId) {
  return injectJson(server, {
    method: "GET",
    url: `/properties/${requestedPropertyId}/booking-design/readiness`,
    headers: { authorization: "Bearer valid-token" },
  });
}
