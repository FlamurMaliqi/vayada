import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  LinkedResource,
  ProductEntitlement,
  RequestContext,
  ResourceRelationship,
} from "@vayada/backend-auth";
import type {
  MembershipPropertyScope,
  PropertyAccessRepository,
} from "@vayada/backend-authorization";

import { enforcePmsPropertyRoutePolicy } from "./routes/pmsPropertyPolicy.js";

const PROPERTY_A = "10000000-0000-4000-8000-000000000001";
const PROPERTY_B = "10000000-0000-4000-8000-000000000002";
const FOREIGN_PROPERTY = "20000000-0000-4000-8000-000000000001";

function resources(
  relationship: ResourceRelationship = "operator",
  propertyIds: readonly string[] = [PROPERTY_A, PROPERTY_B],
): LinkedResource[] {
  return propertyIds.flatMap((resourceId) => [
    {
      product: "hotel_catalog" as const,
      resourceType: "property" as const,
      resourceId,
      relationship,
      status: "active" as const,
    },
    {
      product: "pms" as const,
      resourceType: "pms_property" as const,
      resourceId,
      relationship,
      status: "active" as const,
    },
  ]);
}

const activeEntitlement: ProductEntitlement = {
  product: "pms",
  key: "property-management",
  status: "active",
};

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    actor: {
      internalUserId: "user_staff",
      providerIdentity: { provider: "workos", providerUserId: "user_workos_staff" },
      email: "staff@example.com",
      status: "active",
    },
    selectedOrganization: {
      organizationId: "organization_hotel_group",
      kind: "hotel_group",
      status: "active",
    },
    membership: {
      membershipId: "membership_staff",
      status: "active",
      roleKey: "front_desk",
      workosRoleSlugs: ["hotel_member"],
      permissions: ["pms.reservation.read"],
    },
    linkedResources: resources(),
    entitlements: [activeEntitlement],
    locale: "en",
    currency: "EUR",
    audit: {
      requestId: "request-1",
      source: "api",
      receivedAt: "2026-08-27T00:00:00.000Z",
    },
    ...overrides,
  };
}

function scope(overrides: Partial<MembershipPropertyScope> = {}): MembershipPropertyScope {
  return {
    mode: "assigned",
    roleKey: "front_desk",
    accessOrigin: "agency",
    assignedPropertyIds: [PROPERTY_A],
    ...overrides,
  };
}

async function testApp(options: {
  authContext?: RequestContext | null;
  membershipScope?: MembershipPropertyScope | null;
  repository?: PropertyAccessRepository;
  allowedRelationships?: readonly ResourceRelationship[];
}) {
  const handled = vi.fn();
  const app = Fastify({ logger: false });
  const authContext = options.authContext === undefined ? context() : options.authContext;
  const repository =
    options.repository ??
    ({
      findMembershipPropertyScope: async () =>
        options.membershipScope === undefined ? scope() : options.membershipScope,
    } satisfies PropertyAccessRepository);
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    request.authContext = authContext;
  });
  app.get<{ Params: { propertyId: string } }>(
    "/properties/:propertyId/reservations",
    async (request) => {
      await enforcePmsPropertyRoutePolicy(
        request,
        {
          propertyId: request.params.propertyId,
          permission: "pms.reservation.read",
          ...(options.allowedRelationships
            ? { allowedRelationships: options.allowedRelationships }
            : {}),
        },
        repository,
      );
      handled(request.params.propertyId);
      return { ok: true };
    },
  );
  return { app, handled };
}

describe("enforcePmsPropertyRoutePolicy", () => {
  it("allows all-scope access with the safe default relationships", async () => {
    const { app, handled } = await testApp({
      membershipScope: scope({ mode: "all", assignedPropertyIds: [] }),
    });
    const response = await app.inject({
      method: "GET",
      url: `/properties/${PROPERTY_A}/reservations`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(handled).toHaveBeenCalledOnce();
    await app.close();
  });

  it("allows assigned front-desk access only when the route opts in", async () => {
    const authContext = context({ linkedResources: resources("front_desk") });
    const membershipScope = scope();
    const allowedRelationships = ["owner", "operator", "front_desk"] as const;
    const { app, handled } = await testApp({
      authContext,
      membershipScope,
      allowedRelationships,
    });
    const response = await app.inject({
      method: "GET",
      url: `/properties/${PROPERTY_A}/reservations`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(handled).toHaveBeenCalledOnce();
    await app.close();
  });

  it("fails closed across the PMS property denial matrix", async () => {
    const active = context();
    const cases: Array<{
      name: string;
      authContext?: RequestContext | null;
      membershipScope?: MembershipPropertyScope | null;
      propertyId?: string;
    }> = [
      { name: "missing authentication", authContext: null },
      {
        name: "inactive actor",
        authContext: context({ actor: { ...active.actor, status: "suspended" } }),
      },
      {
        name: "inactive membership",
        authContext: context({ membership: { ...active.membership, status: "inactive" } }),
      },
      {
        name: "inactive organization",
        authContext: context({
          selectedOrganization: { ...active.selectedOrganization, status: "suspended" },
        }),
      },
      {
        name: "missing permission",
        authContext: context({ membership: { ...active.membership, permissions: [] } }),
      },
      { name: "missing entitlement", authContext: context({ entitlements: [] }) },
      {
        name: "inactive entitlement",
        authContext: context({ entitlements: [{ ...activeEntitlement, status: "suspended" }] }),
      },
      { name: "empty assigned scope", membershipScope: scope({ assignedPropertyIds: [] }) },
      { name: "missing membership scope", membershipScope: null },
      { name: "unknown scope", membershipScope: scope({ mode: "unknown" }) },
      {
        name: "cross-tenant assignment",
        membershipScope: scope({ assignedPropertyIds: [FOREIGN_PROPERTY] }),
        propertyId: FOREIGN_PROPERTY,
      },
      { name: "direct URL to unassigned property", propertyId: PROPERTY_B },
      {
        name: "missing target resource",
        authContext: context({
          linkedResources: resources().filter(({ product }) => product === "hotel_catalog"),
        }),
      },
      {
        name: "inactive target resource",
        authContext: context({
          linkedResources: resources().map((resource) =>
            resource.product === "pms" ? { ...resource, status: "suspended" } : resource,
          ),
        }),
      },
      {
        name: "relationship mismatch",
        authContext: context({ linkedResources: resources("finance_manager") }),
      },
    ];

    let crossTenantBody = "";
    let unassignedBody = "";
    for (const candidate of cases) {
      const { app, handled } = await testApp(candidate);
      const response = await app.inject({
        method: "GET",
        url: `/properties/${candidate.propertyId ?? PROPERTY_A}/reservations`,
      });
      expect(response.statusCode, candidate.name).toBe(candidate.authContext === null ? 401 : 403);
      expect(handled, candidate.name).not.toHaveBeenCalled();
      if (candidate.name === "cross-tenant assignment") crossTenantBody = response.body;
      if (candidate.name === "direct URL to unassigned property") unassignedBody = response.body;
      await app.close();
    }
    expect(crossTenantBody).toBe(unassignedBody);
  });

  it("keeps front-desk access opt-in", async () => {
    const { app, handled } = await testApp({
      authContext: context({ linkedResources: resources("front_desk") }),
    });
    expect(
      (await app.inject({ method: "GET", url: `/properties/${PROPERTY_A}/reservations` }))
        .statusCode,
    ).toBe(403);
    expect(handled).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not run the route when property-scope storage fails", async () => {
    const { app, handled } = await testApp({
      repository: {
        findMembershipPropertyScope: async () => {
          throw new Error("storage unavailable");
        },
      },
    });
    expect(
      (await app.inject({ method: "GET", url: `/properties/${PROPERTY_A}/reservations` }))
        .statusCode,
    ).toBe(500);
    expect(handled).not.toHaveBeenCalled();
    await app.close();
  });
});
