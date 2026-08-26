import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { RequestContext } from "@vayada/backend-auth";
import {
  createAuthorizationResolver,
  type PropertyAccessRepository,
} from "@vayada/backend-authorization";

import { requestContextFixtureCases } from "./platform/requestContext.fixtures.js";
import { enforcePropertyRoutePolicy, enforceRoutePolicy } from "./routes/policy.js";

const PROPERTY_A = "10000000-0000-4000-8000-000000000001";
const PROPERTY_B = "10000000-0000-4000-8000-000000000002";
const PROPERTY_FOREIGN = "20000000-0000-4000-8000-000000000001";
const baseContext = requestContextFixtureCases.find(({ scope }) => scope === "hotel")!.context;

function context(): RequestContext {
  return {
    ...baseContext,
    membership: {
      ...baseContext.membership,
      roleKey: "front_desk",
      permissions: ["pms.operations.read"],
    },
    linkedResources: [PROPERTY_A, PROPERTY_B].flatMap((propertyId) => [
      {
        product: "hotel_catalog" as const,
        resourceType: "property" as const,
        resourceId: propertyId,
        relationship: "operator" as const,
        status: "active" as const,
      },
      {
        product: "pms" as const,
        resourceType: "pms_property" as const,
        resourceId: propertyId,
        relationship: "operator" as const,
        status: "active" as const,
      },
    ]),
  };
}

describe("enforcePropertyRoutePolicy", () => {
  it("blocks direct URLs for unassigned properties before the handler runs", async () => {
    const repository: PropertyAccessRepository = {
      async findMembershipPropertyScope() {
        return {
          mode: "assigned",
          roleKey: "front_desk",
          accessOrigin: "agency",
          assignedPropertyIds: [PROPERTY_A],
        };
      },
    };
    const handled = vi.fn();
    const app = Fastify({ logger: false });
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      request.authContext = context();
    });
    app.get<{ Params: { propertyId: string } }>("/properties/:propertyId", async (request) => {
      await enforcePropertyRoutePolicy(
        request,
        {
          permission: "pms.operations.read",
          property: {
            propertyId: request.params.propertyId,
            targetResource: { product: "pms", resourceType: "pms_property" },
          },
          resource: {
            product: "pms",
            resourceType: "pms_property",
            resourceId: request.params.propertyId,
            allowedRelationships: ["owner", "operator"],
          },
        },
        repository,
      );
      handled(request.params.propertyId);
      return { propertyId: request.params.propertyId };
    });

    expect((await app.inject({ method: "GET", url: `/properties/${PROPERTY_A}` })).statusCode).toBe(
      200,
    );
    const denied = await app.inject({ method: "GET", url: `/properties/${PROPERTY_B}` });
    const foreign = await app.inject({ method: "GET", url: `/properties/${PROPERTY_FOREIGN}` });
    expect([denied.statusCode, foreign.statusCode]).toEqual([403, 403]);
    expect(foreign.json()).toEqual(denied.json());
    expect(handled).toHaveBeenCalledOnce();
    await app.close();
  });

  it("denies delegated staff before ordinary route permissions resolve", async () => {
    const delegatedScope: PropertyAccessRepository = {
      async findMembershipPropertyScope() {
        return {
          mode: "assigned",
          roleKey: "front_desk",
          accessOrigin: "external_owner",
          assignedPropertyIds: [PROPERTY_A],
        };
      },
    };
    const resolution = await createAuthorizationResolver(
      { findPermissionsForRole: async () => ["pms.operations.read"] },
      undefined,
      delegatedScope,
    )(context());
    const delegatedContext = context();
    delegatedContext.membership.permissions = resolution.permissions;
    const app = Fastify({ logger: false });
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      request.authContext = delegatedContext;
    });
    app.get("/ordinary", async (request) => {
      enforceRoutePolicy(request, { permission: "pms.operations.read" });
      return { ok: true };
    });

    expect((await app.inject({ method: "GET", url: "/ordinary" })).statusCode).toBe(403);
    await app.close();
  });

  it("returns the same denial for delegated access to assigned and other-owner properties", async () => {
    const repository: PropertyAccessRepository = {
      async findMembershipPropertyScope() {
        return {
          mode: "assigned",
          roleKey: "front_desk",
          accessOrigin: "external_owner",
          assignedPropertyIds: [PROPERTY_A],
        };
      },
    };
    const app = Fastify({ logger: false });
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      request.authContext = context();
    });
    app.get<{ Params: { propertyId: string } }>("/delegated/:propertyId", async (request) => {
      await enforcePropertyRoutePolicy(
        request,
        {
          permission: "pms.operations.read",
          property: {
            propertyId: request.params.propertyId,
            targetResource: { product: "pms", resourceType: "pms_property" },
          },
        },
        repository,
      );
      return { propertyId: request.params.propertyId };
    });

    const assigned = await app.inject({ method: "GET", url: `/delegated/${PROPERTY_A}` });
    const otherOwner = await app.inject({ method: "GET", url: `/delegated/${PROPERTY_B}` });
    expect([assigned.statusCode, otherOwner.statusCode]).toEqual([403, 403]);
    expect(assigned.json()).toEqual(otherOwner.json());
    await app.close();
  });
});
