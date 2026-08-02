import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  PROPERTY_MEDIA_AUTHORIZATION,
  parseAssignPropertyLogoRequest,
  parseReplacePropertyPresentationMediaRequest,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  propertyMediaCommandResultStatus,
  type PropertyMediaCommandRepository,
} from "../domains/propertyMediaCommandRepository.js";
import { enforceRoutePolicy } from "./policy.js";

type PropertyMediaParams = { propertyId?: string };
type AuthorizedRequest = {
  propertyId: string;
  context: ReturnType<typeof enforceRoutePolicy>;
};

export async function registerPropertyMediaRoutes(
  app: FastifyInstance,
  options: { repository: PropertyMediaCommandRepository },
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedRequest>();
  const onRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    const access = authorizePropertyMediaRequest(request, reply);
    if (access) authorized.set(request, access);
  };

  app.put("/properties/:propertyId/media/logo", { onRequest }, async (request, reply) => {
    const access = requireAuthorizedRequest(authorized, request);
    const body = parseAssignPropertyLogoRequest(request.body);
    if (!body) return invalidRequest(reply, "A valid logo assignment is required.");
    const idempotencyKey = parseIdempotencyKey(request, reply);
    if (!idempotencyKey) return reply;
    return sendResult(
      reply,
      await options.repository.assignLogo({
        organizationId: access.context.selectedOrganization.organizationId,
        propertyId: access.propertyId,
        actorUserId: access.context.actor.internalUserId,
        audit: access.context.audit,
        idempotencyKey,
        ...body,
      }),
    );
  });

  app.put("/properties/:propertyId/media/presentation", { onRequest }, async (request, reply) => {
    const access = requireAuthorizedRequest(authorized, request);
    const body = parseReplacePropertyPresentationMediaRequest(request.body);
    if (!body) return invalidRequest(reply, "Valid cover and gallery assignments are required.");
    const idempotencyKey = parseIdempotencyKey(request, reply);
    if (!idempotencyKey) return reply;
    return sendResult(
      reply,
      await options.repository.replacePresentation({
        organizationId: access.context.selectedOrganization.organizationId,
        propertyId: access.propertyId,
        actorUserId: access.context.actor.internalUserId,
        audit: access.context.audit,
        idempotencyKey,
        ...body,
      }),
    );
  });
}

function authorizePropertyMediaRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): AuthorizedRequest | null {
  try {
    const baseContext = enforceRoutePolicy(request, {
      permission: PROPERTY_MEDIA_AUTHORIZATION.permission,
    });
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      reply
        .status(403)
        .send(
          accessError(
            403,
            "invalid_organization_scope",
            "Hotel media requires a hotel-group organization.",
          ),
        );
      return null;
    }
    const rawPropertyId = (request.params as PropertyMediaParams).propertyId;
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

function requireAuthorizedRequest(
  authorized: WeakMap<FastifyRequest, AuthorizedRequest>,
  request: FastifyRequest,
): AuthorizedRequest {
  const access = authorized.get(request);
  if (!access) throw new Error("Property media access was not resolved before body parsing");
  return access;
}

function parseIdempotencyKey(request: FastifyRequest, reply: FastifyReply): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") {
    invalidRequest(reply, "Idempotency-Key must be provided exactly once.");
    return null;
  }
  const value = header.trim();
  if (value.length < 1 || value.length > 200) {
    invalidRequest(reply, "Idempotency-Key must contain 1 to 200 characters.");
    return null;
  }
  return value;
}

function sendResult(
  reply: FastifyReply,
  result: Awaited<ReturnType<PropertyMediaCommandRepository["assignLogo"]>>,
): FastifyReply | object {
  if (result.ok) return reply.send(result.response);
  return reply.status(propertyMediaCommandResultStatus(result)).send(result.error);
}

function invalidRequest(reply: FastifyReply, detail: string): FastifyReply {
  return reply.status(422).send({ code: "invalid_property_media_request", detail });
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
