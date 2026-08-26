import { requireAuthContext, type PermissionKey } from "@vayada/backend-auth";
import {
  requireActiveEntitlement,
  requirePropertyAccess,
  requirePermission,
  requireResourceAccess,
  type EntitlementRequirement,
  type PropertyAccessRepository,
  type PropertyAccessRequirement,
  type ResourceRequirement,
} from "@vayada/backend-authorization";
import type { FastifyRequest } from "fastify";

export type RouteAuthorizationPolicy = {
  permission: PermissionKey;
  entitlement?: EntitlementRequirement;
  resource?: ResourceRequirement;
};

function enforceRouteRequirements(
  context: ReturnType<typeof requireAuthContext>,
  policy: RouteAuthorizationPolicy,
): ReturnType<typeof requireAuthContext> {
  if (policy.entitlement) {
    requireActiveEntitlement(context, policy.entitlement);
  }

  if (policy.resource) {
    requireResourceAccess(context, {
      permission: policy.permission,
      resource: policy.resource,
    });
  }

  return context;
}

export function enforceRoutePolicy(
  request: FastifyRequest,
  policy: RouteAuthorizationPolicy,
): ReturnType<typeof requireAuthContext> {
  const context = requireAuthContext(request);
  requirePermission(context, policy.permission);
  return enforceRouteRequirements(context, policy);
}

export async function enforcePropertyRoutePolicy(
  request: FastifyRequest,
  policy: RouteAuthorizationPolicy & { property: PropertyAccessRequirement },
  repository: PropertyAccessRepository,
): Promise<ReturnType<typeof requireAuthContext>> {
  const context = requireAuthContext(request);
  requirePermission(context, policy.permission);
  await requirePropertyAccess(context, repository, policy.property);
  return enforceRouteRequirements(context, policy);
}
