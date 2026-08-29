import type { PermissionKey, ResourceRelationship } from "@vayada/backend-auth";
import type { PropertyAccessRepository } from "@vayada/backend-authorization";
import type { FastifyRequest } from "fastify";

import { enforcePropertyRoutePolicy } from "./policy.js";

const PMS_PROPERTY_RELATIONSHIPS = ["owner", "operator"] as const;

export async function enforcePmsPropertyRoutePolicy(
  request: FastifyRequest,
  input: {
    propertyId: string;
    permission: PermissionKey;
    allowedRelationships?: readonly ResourceRelationship[];
  },
  repository: PropertyAccessRepository,
) {
  const allowedRelationships = input.allowedRelationships ?? PMS_PROPERTY_RELATIONSHIPS;
  const resource = {
    product: "pms",
    resourceType: "pms_property",
    resourceId: input.propertyId,
  } as const;

  return enforcePropertyRoutePolicy(
    request,
    {
      permission: input.permission,
      property: {
        propertyId: input.propertyId,
        targetResource: { product: "pms", resourceType: "pms_property" },
        allowedRelationships,
      },
      entitlement: { product: "pms", key: "property-management", resource },
      resource: { ...resource, allowedRelationships },
    },
    repository,
  );
}
