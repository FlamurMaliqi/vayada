import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION,
  parseMarketplaceHotelCollaborationPreferencesReadModel,
  parseReplaceMarketplaceHotelCollaborationPreferencesRequest,
  parseReplaceMarketplaceHotelCollaborationPreferencesResult,
  type MarketplaceHotelCollaborationPreferencesCommandAudit,
  type MarketplaceHotelCollaborationPreferencesCommandPort,
  type MarketplaceHotelCollaborationPreferencesReadPort,
  type ReplaceMarketplaceHotelCollaborationPreferencesError,
} from "@vayada/domain-marketplace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type MarketplaceHotelCollaborationPreferencesRoutesOptions = {
  commandPort: MarketplaceHotelCollaborationPreferencesCommandPort;
  readPort: MarketplaceHotelCollaborationPreferencesReadPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * ONB-08 adapter. Keep unmounted until the reviewed Marketplace onboarding
 * cutover replaces the legacy offer-shaped preference flow.
 */
export async function registerMarketplaceHotelCollaborationPreferencesRoutes(
  app: FastifyInstance,
  options: MarketplaceHotelCollaborationPreferencesRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/hotel-collaboration-preferences",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const result = await options.readPort.getHotelCollaborationPreferences({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
      });
      const available = snapshotExactRecord(result, ["outcome", "readModel"]);
      if (available?.outcome === "available") {
        const readModel = parseMarketplaceHotelCollaborationPreferencesReadModel(
          available.readModel,
        );
        return readModel?.propertyId === scope.propertyId
          ? reply.status(200).send(readModel)
          : invalidPortResult(reply);
      }
      const failure = snapshotExactRecord(result, ["outcome", "error"]);
      const error = snapshotExactRecord(failure?.error, ["code", "errorSource", "retryable"]);
      if (
        failure?.outcome === "unavailable" &&
        error?.code === "preference_source_unavailable" &&
        error.errorSource === "system" &&
        error.retryable === true
      ) {
        return reply.status(503).send(error);
      }
      if (
        failure?.outcome === "malformed" &&
        error?.code === "preference_source_malformed" &&
        error.errorSource === "system" &&
        error.retryable === false
      ) {
        return reply.status(500).send(error);
      }
      return invalidPortResult(reply);
    },
  );

  app.put<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/hotel-collaboration-preferences",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      const parsedRequest = parseReplaceMarketplaceHotelCollaborationPreferencesRequest(
        request.body,
      );
      if (!parsedRequest)
        return invalidRequest(reply, "The preference replacement body is invalid.");

      const result = parseReplaceMarketplaceHotelCollaborationPreferencesResult(
        await options.commandPort.replaceHotelCollaborationPreferences({
          organizationId: scope.context.selectedOrganization.organizationId,
          propertyId: scope.propertyId,
          idempotencyKey,
          audit: commandAudit(scope.context),
          request: parsedRequest,
        }),
      );
      if (
        !result ||
        (result.ok &&
          (result.response.propertyId !== scope.propertyId ||
            result.response.revision !== parsedRequest.expectedRevision + 1 ||
            JSON.stringify(result.response.preferences) !==
              JSON.stringify({
                compensationTypes: parsedRequest.compensationTypes,
                contentPlatforms: parsedRequest.contentPlatforms,
                contentTypes: parsedRequest.contentTypes,
                availability: parsedRequest.availability,
              }))) ||
        (!result.ok &&
          result.error.code === "preferences_revision_conflict" &&
          result.error.currentRevision === parsedRequest.expectedRevision)
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(200).send(result.response)
        : sendCommandError(reply, result.error);
    },
  );
}

function authorizeRequest(request: FastifyRequest, reply: FastifyReply): AuthorizedScope | null {
  const policy = MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_AUTHORIZATION;
  try {
    const baseContext = enforceRoutePolicy(request, { permission: policy.permission });
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ code: "invalid_organization_scope" });
      return null;
    }
    const rawPropertyId = (request.params as Partial<PropertyParams>).propertyId;
    if (typeof rawPropertyId !== "string" || !UUID_PATTERN.test(rawPropertyId)) {
      invalidRequest(reply, "The property ID is invalid.");
      return null;
    }
    const propertyId = rawPropertyId.toLowerCase();
    const resource = {
      product: policy.resource.product,
      resourceType: policy.resource.resourceType,
      resourceId: propertyId,
    } as const;
    const context = enforceRoutePolicy(request, {
      permission: policy.permission,
      entitlement: {
        product: policy.entitlement.product,
        key: policy.entitlement.key,
        resource,
      },
      resource: { ...resource, allowedRelationships: policy.resource.allowedRelationships },
    });
    return { context, propertyId };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      reply.status(401).send({ code: "unauthenticated" });
      return null;
    }
    if (error instanceof AuthorizationError) {
      reply.status(403).send({ code: "forbidden" });
      return null;
    }
    throw error;
  }
}

function commandAudit(
  context: AuthorizedScope["context"],
): MarketplaceHotelCollaborationPreferencesCommandAudit {
  return {
    actor: { kind: "user", userId: context.actor.internalUserId },
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId ?? null,
    requestedAt: context.audit.receivedAt,
  };
}

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope) {
    throw new Error("Marketplace preference authorization was not resolved before body parsing");
  }
  return scope;
}

function readIdempotencyKey(request: FastifyRequest): string | null {
  const occurrences = request.raw.rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key",
  ).length;
  const header = request.headers["idempotency-key"];
  if (occurrences !== 1 || typeof header !== "string") return null;
  const key = header.trim();
  return key.length >= 1 && key.length <= 200 ? key : null;
}

function snapshotExactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    !ownKeys.every((key) => typeof key === "string" && keys.includes(key)) ||
    !keys.every((key) => Object.hasOwn(descriptors, key) && "value" in descriptors[key]!)
  ) {
    return null;
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function sendCommandError(
  reply: FastifyReply,
  error: ReplaceMarketplaceHotelCollaborationPreferencesError,
): FastifyReply {
  return reply.status(error.code === "setup_scope_unavailable" ? 404 : 409).send(error);
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply
    .status(500)
    .send({ code: "marketplace_hotel_collaboration_preferences_port_contract_violation" });
}
