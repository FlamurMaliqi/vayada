import type { LinkedResource, ProductEntitlement, RequestContext } from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  BookingDesignReadinessPort,
  BookingDesignReadinessResult,
} from "@vayada/domain-booking";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerBookingDesignReadinessRoutes } from "./routes/bookingDesignReadiness.js";

const propertyId = "123e4567-e89b-42d3-a456-426614174000";
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

async function testApp(value: unknown, authenticated = true) {
  const app = Fastify({ logger: false });
  const read = vi.fn().mockResolvedValue(value);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (!authenticated || request.headers.authorization !== "Bearer valid-token") return;
    request.authContext = {
      actor: { internalUserId: actorUserId },
      selectedOrganization: { organizationId, kind: "hotel_group" },
      membership: { permissions: ["booking.settings.manage"] },
      linkedResources: [link()],
      entitlements: [entitlement()],
      locale: "en",
      currency: "EUR",
      audit: { requestId: "request-1", source: "api", receivedAt },
    } as RequestContext;
  });
  await app.register(registerBookingDesignReadinessRoutes, {
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

  it("fails closed before or after the protected port boundary", async () => {
    let harness = await testApp(fallbackReady(), false);
    app = harness.app;
    expect(await get(app)).toMatchObject({ statusCode: 401, body: { code: "unauthenticated" } });
    expect(harness.read).not.toHaveBeenCalled();
    await app.close();

    harness = await testApp({ ...fallbackReady(), propertyId: actorUserId });
    app = harness.app;
    expect(await get(app)).toMatchObject({
      statusCode: 500,
      body: { code: "booking_design_readiness_port_contract_violation" },
    });
  });
});

function entitlement(): ProductEntitlement {
  return {
    product: "booking",
    key: "booking-engine",
    status: "active",
    resource: { product: "booking", resourceType: "booking_hotel", resourceId: propertyId },
  };
}

function link(): LinkedResource {
  return {
    product: "booking",
    resourceType: "booking_hotel",
    resourceId: propertyId,
    relationship: "owner",
    status: "active",
  };
}

function get(server: ReturnType<typeof Fastify>) {
  return injectJson(server, {
    method: "GET",
    url: `/properties/${propertyId}/booking-design/readiness`,
    headers: { authorization: "Bearer valid-token" },
  });
}
