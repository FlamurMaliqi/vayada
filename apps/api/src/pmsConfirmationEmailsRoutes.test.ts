import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import Fastify from "fastify";
import { it, expect, vi } from "vitest";
import { registerPmsConfirmationEmailRoutes } from "./routes/pmsConfirmationEmails.js";
const propertyId = "93000000-0000-4000-8000-000000000001",
  actorUserId = "93000000-0000-4000-8000-000000000003",
  organizationId = "93000000-0000-4000-8000-000000000004",
  evaluatedAt = "2026-09-05T00:00:00Z";
type Auth = {
  permissions?: PermissionKey[];
  links?: LinkedResource[];
  entitlements?: ProductEntitlement[];
  kind?: RequestContext["selectedOrganization"]["kind"];
};
it.each(["missing", "invalid", "permission", "entitlement", "inactive", "resource", "allowed"])(
  "enforces %s authorization",
  async (mode) => {
    const app = Fastify();
    const requestEmail = vi.fn(async () => ({ jobId: propertyId }));
    const auth: Auth =
      mode === "permission"
        ? { permissions: [] }
        : mode === "entitlement"
          ? { entitlements: [] }
          : mode === "inactive"
            ? { entitlements: [entitlement("inactive")] }
            : mode === "resource"
              ? { links: [] }
              : {};
    app.decorateRequest("authContext", null);
    app.addHook("onRequest", async (request) => {
      if (!["missing", "invalid"].includes(mode)) request.authContext = context(auth);
    });
    await app.register(registerPmsConfirmationEmailRoutes, {
      emails: { request: requestEmail, status: async () => null, close: async () => {} },
      propertyAccessRepository: {
        findMembershipPropertyScope: async () => ({
          mode: "all",
          roleKey: "operator",
          accessOrigin: "agency",
          assignedPropertyIds: [],
        }),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/properties/${propertyId}/reservations/${propertyId}/confirmation-email`,
      payload: { idempotencyKey: "test" },
    });
    expect(response.statusCode).toBe(
      mode === "allowed" ? 202 : ["missing", "invalid"].includes(mode) ? 401 : 403,
    );
    expect(requestEmail).toHaveBeenCalledTimes(mode === "allowed" ? 1 : 0);
    await app.close();
  },
);
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
      permissions: auth.permissions ?? ["pms.reservation.update"],
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
