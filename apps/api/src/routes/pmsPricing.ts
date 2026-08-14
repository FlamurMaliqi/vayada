import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  parseFlexibleRatePlanCommandResult,
  parseFlexibleRatePlanSnapshot,
  parsePmsPricingSourceSnapshot,
  parsePmsPricingCurrencyCapabilities,
  parsePropertyPricingCurrencyCommandResult,
  parseUpsertFlexibleRatePlanCommand,
  parseUpsertPropertyPricingCurrencyCommand,
  type FlexibleRatePlanCommandError,
  type PmsPricingCommandAudit,
  type PmsPricingCommandPort,
  type PmsPricingCurrencyCapabilitiesReadPort,
  type PmsPricingReadPort,
  type PropertyPricingCurrencyCommandError,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type RoomTypeParams = PropertyParams & { roomTypeId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type PmsPricingRoutesOptions = {
  commandPort: PmsPricingCommandPort;
  readPort: PmsPricingReadPort;
  currencyCapabilitiesReadPort: PmsPricingCurrencyCapabilitiesReadPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Target pricing adapter. Currency changes stay fail-closed until the shared dependency guard lands. */
export async function registerPmsPricingRoutes(
  app: FastifyInstance,
  options: PmsPricingRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.put<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/pricing-source/currency",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, ["expectedPricingCurrencyRevision", "currency"])) {
        return invalidRequest(reply, "The pricing currency body is invalid.");
      }
      const command = parseUpsertPropertyPricingCurrencyCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        idempotencyKey,
        audit: commandAudit(scope.context),
        expectedPricingCurrencyRevision: request.body["expectedPricingCurrencyRevision"],
        currency: request.body["currency"],
      });
      if (!command) return invalidRequest(reply, "The pricing currency body is invalid.");

      const result = parsePropertyPricingCurrencyCommandResult(
        await options.commandPort.upsertPropertyPricingCurrency(command),
      );
      if (
        !result ||
        (result.ok && result.response.pricingCurrency.propertyId !== scope.propertyId)
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(result.response.outcome === "created" ? 201 : 200).send(result.response)
        : sendCurrencyError(reply, result.error);
    },
  );

  app.put<{ Params: RoomTypeParams; Body: unknown }>(
    "/properties/:propertyId/room-types/:roomTypeId/flexible-rate-plan",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (
        !isExactObject(request.body, [
          "expectedRoomFactsRevision",
          "expectedPricingCurrencyRevision",
          "expectedFlexibleRatePlanRevision",
          "baseAmountDecimal",
          "cancellationTerms",
        ])
      ) {
        return invalidRequest(reply, "The flexible rate plan body is invalid.");
      }
      const command = parseUpsertFlexibleRatePlanCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        roomTypeId,
        idempotencyKey,
        audit: commandAudit(scope.context),
        expectedRoomFactsRevision: request.body["expectedRoomFactsRevision"],
        expectedPricingCurrencyRevision: request.body["expectedPricingCurrencyRevision"],
        expectedFlexibleRatePlanRevision: request.body["expectedFlexibleRatePlanRevision"],
        baseAmountDecimal: request.body["baseAmountDecimal"],
        cancellationTerms: request.body["cancellationTerms"],
      });
      if (!command) return invalidRequest(reply, "The flexible rate plan body is invalid.");

      const result = parseFlexibleRatePlanCommandResult(
        await options.commandPort.upsertFlexibleRatePlan(command),
      );
      if (
        !result ||
        (result.ok &&
          (result.response.flexibleRatePlan.propertyId !== scope.propertyId ||
            result.response.flexibleRatePlan.roomTypeId !== roomTypeId ||
            result.response.flexibleRatePlan.sourceRoomFactsRevision !==
              command.expectedRoomFactsRevision ||
            result.response.flexibleRatePlan.flexibleRatePlanRevision !==
              command.expectedFlexibleRatePlanRevision + 1))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(result.response.outcome === "created" ? 201 : 200).send(result.response)
        : sendPlanError(reply, result.error);
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/pricing-source/currency-capabilities",
    { onRequest: authorize },
    async (request, reply) => {
      requireAuthorizedScope(authorized, request);
      try {
        const value = await options.currencyCapabilitiesReadPort.getPricingCurrencyCapabilities();
        if (value === null) {
          return reply.status(503).send({ code: "pms_pricing_currency_capabilities_unavailable" });
        }
        const capabilities = parsePmsPricingCurrencyCapabilities(value);
        return capabilities
          ? reply.status(200).send(capabilities)
          : reply
              .status(500)
              .send({ code: "pms_pricing_currency_capabilities_port_contract_violation" });
      } catch {
        return reply.status(503).send({ code: "pms_pricing_currency_capabilities_unavailable" });
      }
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/pricing-source",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const value = await options.readPort.getPricingSourceSnapshot(scope.propertyId);
      if (!value) return reply.status(404).send({ code: "pricing_currency_not_configured" });
      const snapshot = parsePmsPricingSourceSnapshot(value);
      return snapshot && snapshot.propertyId === scope.propertyId
        ? reply.status(200).send(snapshot)
        : invalidPortResult(reply);
    },
  );

  app.get<{ Params: RoomTypeParams }>(
    "/properties/:propertyId/room-types/:roomTypeId/flexible-rate-plan",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const value = await options.readPort.getFlexibleRatePlan(scope.propertyId, roomTypeId);
      if (!value) return reply.status(404).send({ code: "flexible_rate_plan_not_found" });
      const snapshot = parseFlexibleRatePlanSnapshot(value);
      return snapshot &&
        snapshot.propertyId === scope.propertyId &&
        snapshot.roomTypeId === roomTypeId
        ? reply.status(200).send(snapshot)
        : invalidPortResult(reply);
    },
  );
}

function authorizeRequest(request: FastifyRequest, reply: FastifyReply): AuthorizedScope | null {
  const permission = request.method === "GET" ? "pms.operations.read" : "pms.operations.manage";
  try {
    const baseContext = enforceRoutePolicy(request, { permission });
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
      product: "pms",
      resourceType: "pms_property",
      resourceId: propertyId,
    } as const;
    const context = enforceRoutePolicy(request, {
      permission,
      entitlement: { product: "pms", key: "property-management", resource },
      resource: { ...resource, allowedRelationships: ["owner", "operator"] },
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

function commandAudit(context: AuthorizedScope["context"]): PmsPricingCommandAudit {
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
  if (!scope) throw new Error("PMS pricing authorization was not resolved before body parsing");
  return scope;
}

function readRoomTypeId(params: RoomTypeParams, reply: FastifyReply): string | null {
  if (!UUID_PATTERN.test(params.roomTypeId)) {
    invalidRequest(reply, "The room type ID is invalid.");
    return null;
  }
  return params.roomTypeId.toLowerCase();
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

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string") &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sendCurrencyError(
  reply: FastifyReply,
  error: PropertyPricingCurrencyCommandError,
): FastifyReply {
  if (error.code === "setup_scope_unavailable") return reply.status(404).send(error);
  if (error.code === "unsupported_pricing_currency") return reply.status(422).send(error);
  return reply.status(409).send(error);
}

function sendPlanError(reply: FastifyReply, error: FlexibleRatePlanCommandError): FastifyReply {
  if (error.code === "setup_scope_unavailable" || error.code === "room_type_not_found") {
    return reply.status(404).send(error);
  }
  return reply.status(409).send(error);
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({ code: "pms_pricing_port_contract_violation" });
}
