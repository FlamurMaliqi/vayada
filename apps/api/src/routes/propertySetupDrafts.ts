import {
  hasActiveEntitlement,
  hasActiveLinkedResource,
  type EntitlementRequirement,
  type ResourceRequirement,
} from "@vayada/backend-authorization";
import {
  parseResetPropertySetupDraftRequest,
  parseSavePropertySetupDraftRequest,
  PROPERTY_SETUP_STEP_DEFINITIONS,
  type PropertySetupStepPermission,
  type ResetPropertySetupDraftError,
  type SavePropertySetupDraftError,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { PropertySetupDraftCommandRepository } from "../domains/propertySetupDraftCommandRepository.js";
import { enforceRoutePolicy } from "./policy.js";

type DraftParams = { propertyId: string; stepId: string };
type RoutesOptions = { repository: PropertySetupDraftCommandRepository };
type ProductAccess = {
  product: EntitlementRequirement["product"];
  key: string;
  resourceType: ResourceRequirement["resourceType"];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_ACCESS_BY_PERMISSION: Partial<Record<PropertySetupStepPermission, ProductAccess>> = {
  "marketplace.profile.manage": {
    product: "marketplace",
    key: "marketplace-hotel-profile",
    resourceType: "hotel_profile",
  },
  "booking.settings.manage": {
    product: "booking",
    key: "booking-engine",
    resourceType: "booking_hotel",
  },
  "pms.operations.manage": {
    product: "pms",
    key: "property-management",
    resourceType: "pms_property",
  },
};
const SHARED_STEP_PRODUCT_ACCESS = Object.values(PRODUCT_ACCESS_BY_PERMISSION).filter(
  (access): access is ProductAccess => Boolean(access),
);
export async function registerPropertySetupDraftRoutes(
  app: FastifyInstance,
  { repository }: RoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => repository.close());

  app.put<{ Params: DraftParams; Body: unknown }>(
    "/properties/:propertyId/setup-drafts/:stepId",
    async (request, reply) => {
      const scope = authorizeDraftMutation(request, reply);
      if (!scope) return reply;

      const parsed = parseSavePropertySetupDraftRequest(request.body);
      if (!parsed.ok) return reply.status(400).send(parsed.error);
      if (parsed.value.stepId !== scope.definition.stepId) {
        return invalidRequest(reply, "The body stepId must match the route stepId.");
      }
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) {
        return invalidRequest(
          reply,
          "Idempotency-Key must be provided exactly once and contain 1 to 200 characters.",
        );
      }

      const result = await repository.saveStepDraft({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        actorUserId: scope.context.actor.internalUserId,
        idempotencyKey,
        audit: scope.context.audit,
        request: parsed.value,
      });
      return result.ok ? result.receipt : sendSaveError(reply, result.error);
    },
  );

  app.post<{ Params: DraftParams; Body: unknown }>(
    "/properties/:propertyId/setup-drafts/:stepId/reset",
    async (request, reply) => {
      const scope = authorizeDraftMutation(request, reply);
      if (!scope) return reply;

      const parsed = parseResetPropertySetupDraftRequest(request.body);
      if (!parsed.ok) return reply.status(400).send(parsed.error);
      if (parsed.value.stepId !== scope.definition.stepId) {
        return invalidRequest(reply, "The body stepId must match the route stepId.");
      }
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) {
        return invalidRequest(
          reply,
          "Idempotency-Key must be provided exactly once and contain 1 to 200 characters.",
        );
      }

      const result = await repository.resetStepDraft({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        actorUserId: scope.context.actor.internalUserId,
        idempotencyKey,
        audit: scope.context.audit,
        request: parsed.value,
      });
      return result.ok ? result.receipt : sendResetError(reply, result.error);
    },
  );
}

function authorizeDraftMutation(
  request: FastifyRequest<{ Params: DraftParams }>,
  reply: FastifyReply,
) {
  const context = enforceRoutePolicy(request, {
    permission: "hotel_catalog.setup.read",
  });
  const { propertyId: rawPropertyId, stepId } = request.params;
  const definition = PROPERTY_SETUP_STEP_DEFINITIONS.find((step) => step.stepId === stepId);
  if (!UUID_PATTERN.test(rawPropertyId) || !definition) {
    invalidRequest(reply, "The property or setup step is invalid.");
    return null;
  }
  const propertyId = rawPropertyId.toLowerCase();
  if (context.selectedOrganization.kind !== "hotel_group") {
    forbidden(reply);
    return null;
  }
  const catalogResource = {
    product: "hotel_catalog",
    resourceType: "property",
    resourceId: propertyId,
    allowedRelationships: ["owner", "operator"],
  } as const;
  enforceRoutePolicy(request, {
    permission: "hotel_catalog.setup.read",
    resource: catalogResource,
  });

  const productAccess = PRODUCT_ACCESS_BY_PERMISSION[definition.permission];
  if (productAccess) {
    const requirements = productRequirements(productAccess, propertyId);
    enforceRoutePolicy(request, {
      permission: definition.permission,
      ...requirements,
    });
  } else {
    enforceRoutePolicy(request, {
      permission: definition.permission,
      resource: catalogResource,
    });
    if (
      !SHARED_STEP_PRODUCT_ACCESS.some((access) => {
        const requirements = productRequirements(access, propertyId);
        return (
          hasActiveEntitlement(context, requirements.entitlement) &&
          hasActiveLinkedResource(context, requirements.resource)
        );
      })
    ) {
      forbidden(reply);
      return null;
    }
  }
  return { context, propertyId, definition };
}

function productRequirements(access: ProductAccess, propertyId: string) {
  const scope = {
    product: access.product,
    resourceType: access.resourceType,
    resourceId: propertyId,
  };
  return {
    entitlement: { product: access.product, key: access.key, resource: scope },
    resource: { ...scope, allowedRelationships: ["owner", "operator"] },
  } satisfies {
    entitlement: EntitlementRequirement;
    resource: ResourceRequirement;
  };
}

function forbidden(reply: FastifyReply): FastifyReply {
  return reply.status(403).send({
    code: "forbidden",
    message: "Property setup requires an entitled hotel-group property.",
  });
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length > 0 && key.length <= 200 ? key : null;
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function sendSaveError(reply: FastifyReply, error: SavePropertySetupDraftError): FastifyReply {
  const status = error.code === "setup_scope_unavailable" ? 404 : 409;
  return reply.status(status).send(error);
}

function sendResetError(reply: FastifyReply, error: ResetPropertySetupDraftError): FastifyReply {
  const status = error.code === "setup_scope_unavailable" ? 404 : 409;
  return reply.status(status).send(error);
}
