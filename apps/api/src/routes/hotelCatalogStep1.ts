import { createHash } from "node:crypto";

import { UnauthorizedError } from "@vayada/backend-auth";
import {
  AuthorizationError,
  hasActiveEntitlement,
  hasActiveLinkedResource,
  type EntitlementRequirement,
  type ResourceRequirement,
} from "@vayada/backend-authorization";
import {
  PROPERTY_MEDIA_AUTHORIZATION,
  createHotelCatalogStep1MediaAssignments,
  parseSaveHotelCatalogStep1Request,
  type PropertyMediaAssignment,
  type SaveHotelCatalogStep1Error,
  type SaveHotelCatalogStep1Result,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { HotelCatalogStep1Repository } from "../domains/hotelCatalogStep1Repository.js";
import type { PropertyMediaCommandRepository } from "../domains/propertyMediaCommandRepository.js";
import { enforceRoutePolicy } from "./policy.js";

type Step1Params = { propertyId?: string };
type AuthorizedRequest = {
  propertyId: string;
  context: ReturnType<typeof enforceRoutePolicy>;
};
type ProductAccess = {
  product: EntitlementRequirement["product"];
  key: string;
  resourceType: ResourceRequirement["resourceType"];
};

const PRODUCT_ACCESS: readonly ProductAccess[] = [
  { product: "marketplace", key: "marketplace-hotel-profile", resourceType: "hotel_profile" },
  { product: "booking", key: "booking-engine", resourceType: "booking_hotel" },
  { product: "pms", key: "property-management", resourceType: "pms_property" },
];

export async function registerHotelCatalogStep1Routes(
  app: FastifyInstance,
  options: {
    repository: HotelCatalogStep1Repository;
    mediaCommands: Pick<PropertyMediaCommandRepository, "replacePresentation">;
  },
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedRequest>();
  const onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const access = authorize(request, reply);
    if (access) authorized.set(request, access);
  };

  app.addHook("onClose", async () => options.repository.close());

  app.get("/properties/:propertyId/steps/present-hotel", { onRequest }, async (request, reply) => {
    const access = requireAuthorized(authorized, request);
    const state = await options.repository.getState(scope(access));
    return state ? state.readModel : reply.status(404).send({ code: "property_not_found" });
  });

  app.put("/properties/:propertyId/steps/present-hotel", { onRequest }, async (request, reply) => {
    const access = requireAuthorized(authorized, request);
    const parsed = parseSaveHotelCatalogStep1Request(request.body);
    if (!parsed) return invalidRequest(reply, "A complete canonical Step 1 profile is required.");
    const idempotencyKey = readIdempotencyKey(request);
    if (!idempotencyKey) {
      return invalidRequest(
        reply,
        "Idempotency-Key must be provided exactly once and contain 1 to 200 characters.",
      );
    }
    const baseCommand = {
      ...scope(access),
      idempotencyKey,
      audit: access.context.audit,
      request: parsed,
    };
    const prepared = await options.repository.prepare(baseCommand);
    if (prepared.kind === "result") return sendResult(reply, prepared.result);
    const state = prepared.state;

    const assignments = createHotelCatalogStep1MediaAssignments(
      parsed.media,
      state.readModel.displayName,
    );
    let writeProfileRevision = state.readModel.profileRevision;
    if (prepared.mediaRequired || !sameAssignments(state.presentationAssignments, assignments)) {
      const mediaResult = await options.mediaCommands.replacePresentation({
        organizationId: access.context.selectedOrganization.organizationId,
        propertyId: access.propertyId,
        actorUserId: access.context.actor.internalUserId,
        audit: access.context.audit,
        idempotencyKey: mediaIdempotencyKey(idempotencyKey),
        expectedProfileRevision: parsed.expectedProfileRevision,
        assignments,
      });
      if (!mediaResult.ok) {
        return sendResult(
          reply,
          await options.repository.completeFailure({
            ...baseCommand,
            claimToken: prepared.claimToken,
            error: mediaResult.error,
          }),
        );
      }
      writeProfileRevision = mediaResult.response.profileRevision;
    }

    return sendResult(
      reply,
      await options.repository.save({
        ...baseCommand,
        claimToken: prepared.claimToken,
        writeProfileRevision,
      }),
    );
  });
}

function authorize(request: FastifyRequest, reply: FastifyReply): AuthorizedRequest | null {
  try {
    const baseContext = enforceRoutePolicy(request, {
      permission: PROPERTY_MEDIA_AUTHORIZATION.permission,
    });
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      forbidden(reply, "Hotel setup requires a hotel-group organization.");
      return null;
    }
    const rawPropertyId = (request.params as Step1Params).propertyId;
    if (!rawPropertyId || !isUuid(rawPropertyId)) {
      invalidRequest(reply, "propertyId must be a UUID.");
      return null;
    }
    const propertyId = rawPropertyId.toLowerCase();
    const context = enforceRoutePolicy(request, {
      permission: PROPERTY_MEDIA_AUTHORIZATION.permission,
      resource: {
        product: PROPERTY_MEDIA_AUTHORIZATION.product,
        resourceType: PROPERTY_MEDIA_AUTHORIZATION.resourceType,
        resourceId: propertyId,
        allowedRelationships: PROPERTY_MEDIA_AUTHORIZATION.allowedRelationships,
      },
    });
    if (
      !PRODUCT_ACCESS.some((access) => {
        const requirements = productRequirements(access, propertyId);
        return (
          hasActiveEntitlement(context, requirements.entitlement) &&
          hasActiveLinkedResource(context, requirements.resource)
        );
      })
    ) {
      forbidden(reply, "Property setup requires an active selected product.");
      return null;
    }
    return { propertyId, context };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      reply
        .status(401)
        .send(accessError(401, "unauthenticated", "A valid access token is required."));
      return null;
    }
    if (error instanceof AuthorizationError) {
      const hasPermission = request.authContext?.membership.permissions.includes(
        PROPERTY_MEDIA_AUTHORIZATION.permission,
      );
      reply
        .status(403)
        .send(
          accessError(
            403,
            hasPermission ? "missing_property_resource_link" : "missing_permission",
            hasPermission
              ? "The selected hotel group is not linked to that property."
              : "Missing required hotel setup permission.",
          ),
        );
      return null;
    }
    throw error;
  }
}

function productRequirements(access: ProductAccess, propertyId: string) {
  const resource = {
    product: access.product,
    resourceType: access.resourceType,
    resourceId: propertyId,
  };
  return {
    entitlement: { product: access.product, key: access.key, resource },
    resource: { ...resource, allowedRelationships: ["owner", "operator"] },
  } satisfies { entitlement: EntitlementRequirement; resource: ResourceRequirement };
}

function scope(access: AuthorizedRequest) {
  return {
    organizationId: access.context.selectedOrganization.organizationId,
    propertyId: access.propertyId,
    actorUserId: access.context.actor.internalUserId,
  };
}

function sameAssignments(
  left: readonly (PropertyMediaAssignment & { role: "cover" | "gallery" })[],
  right: readonly (PropertyMediaAssignment & { role: "cover" | "gallery" })[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mediaIdempotencyKey(outerKey: string): string {
  return `hotel-catalog-step1-media:${createHash("sha256").update(outerKey).digest("hex")}`;
}

function sendResult(
  reply: FastifyReply,
  result: SaveHotelCatalogStep1Result,
): FastifyReply | object {
  if (result.ok) return reply.send(result.response);
  return reply.status(step1ErrorStatus(result.error)).send(result.error);
}

function step1ErrorStatus(error: SaveHotelCatalogStep1Error): number {
  if (error.code === "property_not_found" || error.code === "media_not_found") return 404;
  if (error.code === "media_not_authorized") return 403;
  if (error.code === "media_not_ready") return 422;
  if (error.code === "media_publication_failed") return 503;
  return 409;
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const value = header.trim();
  return value.length >= 1 && value.length <= 200 ? value : null;
}

function requireAuthorized(
  authorized: WeakMap<FastifyRequest, AuthorizedRequest>,
  request: FastifyRequest,
): AuthorizedRequest {
  const access = authorized.get(request);
  if (!access) throw new Error("Hotel Catalog Step 1 access was not resolved before body parsing");
  return access;
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(422).send({ code: "invalid_hotel_catalog_step1_request", message });
}

function forbidden(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(403).send(accessError(403, "forbidden", message));
}

function accessError(statusCode: 401 | 403, code: string, message: string) {
  return {
    statusCode,
    code,
    category: statusCode === 401 ? "authentication" : "authorization",
    message,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
