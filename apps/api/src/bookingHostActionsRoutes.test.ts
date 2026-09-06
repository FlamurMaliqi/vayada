import type {
  LinkedResource,
  PermissionKey,
  ProductEntitlement,
  RequestContext,
} from "@vayada/backend-auth";
import Fastify from "fastify";
import { it, expect, vi } from "vitest";
import { registerBookingHostActionRoutes } from "./routes/bookingHostActions.js";
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
it.each(
  ["preview", "apply"].flatMap((endpoint) =>
    [
      "missing",
      "invalid",
      "permission",
      "update-only",
      "entitlement",
      "inactive",
      "resource",
      "allowed",
    ].map((mode) => ({ endpoint, mode })),
  ),
)("enforces $mode authorization on $endpoint", async ({ endpoint, mode }) => {
  const app = Fastify();
  const requestEmail = vi.fn(async () => ({ jobId: propertyId }));
  const auth: Auth =
    mode === "update-only"
      ? { permissions: ["pms.reservation.update"] }
      : mode === "permission"
        ? { permissions: [] }
        : mode === "entitlement"
          ? { entitlements: [] }
          : mode === "inactive"
            ? { entitlements: [entitlement("suspended")] }
            : mode === "resource"
              ? { links: [] }
              : {};
  app.decorateRequest("authContext", null);
  app.addHook("onRequest", async (request) => {
    if (!["missing", "invalid"].includes(mode)) request.authContext = context(auth);
  });
  await app.register(registerBookingHostActionRoutes, {
    actions: {
      preview: requestEmail as never,
      apply: requestEmail as never,
      close: async () => {},
      findAction: async () => "cancel",
    },
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
    url: `/properties/${propertyId}/reservations/${propertyId}/host-actions/${endpoint}`,
    payload:
      endpoint === "preview"
        ? { action: "cancel", reason: "Internal reason" }
        : { previewId: propertyId, idempotencyKey: "key" },
  });
  expect(response.statusCode).toBe(
    mode === "allowed" ? 200 : ["missing", "invalid"].includes(mode) ? 401 : 403,
  );
  expect(requestEmail).toHaveBeenCalledTimes(mode === "allowed" ? 1 : 0);
  await app.close();
});
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
      permissions: auth.permissions ?? ["pms.reservation.update", "pms.reservation.cancel"],
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
