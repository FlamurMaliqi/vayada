import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  parseDisableRecurringPricingSourceCommand,
  parseMaterializeRecurringPricingCommand,
  parsePmsRecurringPricingBookingEvidence,
  parsePmsRecurringPricingCommandResult,
  parsePmsRecurringPricingSourceSnapshot,
  parseRecurringPricingMaterializationResult,
  parseUpsertRecurringPricingSourceCommand,
  type PmsPricingCommandAudit,
  type PmsRecurringPricingCommandError,
  type PmsRecurringPricingCommandPort,
  type PmsRecurringPricingCommandResponse,
  type PmsRecurringPricingReadPort,
  type PmsRecurringPricingSourceKind,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type SourceParams = PropertyParams & { sourceId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type PmsRecurringPricingRoutesOptions = {
  commandPort: PmsRecurringPricingCommandPort;
  readPort: PmsRecurringPricingReadPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = [
  "season",
  "weekend_surcharge",
  "additional_guest",
  "non_refundable",
] as const satisfies readonly PmsRecurringPricingSourceKind[];

/**
 * Unmounted ONB-16 adapter. Composition remains deferred until the reviewed
 * PMS onboarding cutover supplies the cross-domain currency guard.
 */
export async function registerPmsRecurringPricingRoutes(
  app: FastifyInstance,
  options: PmsRecurringPricingRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.put<{ Params: SourceParams; Body: unknown }>(
    "/properties/:propertyId/pricing-source/recurring/:sourceId",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const sourceId = readSourceId(request.params, reply);
      if (!sourceId) return reply;
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isRecord(request.body)) {
        return invalidRequest(reply, "The recurring pricing source body is invalid.");
      }

      const command = parseUpsertRecurringPricingSourceCommand({
        ...request.body,
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        sourceId,
        idempotencyKey,
        audit: commandAudit(scope.context),
      });
      if (!command) {
        return invalidRequest(reply, "The recurring pricing source body is invalid.");
      }

      const rawResult = await upsert(options.commandPort, command);
      const result = parsePmsRecurringPricingCommandResult(rawResult);
      if (
        !result ||
        (result.ok &&
          (result.response.source.propertyId !== scope.propertyId ||
            result.response.source.sourceId !== sourceId ||
            result.response.source.sourceKind !== command.sourceKind ||
            result.response.source.sourceRevision !== command.expectedSourceRevision + 1 ||
            result.response.source.configuredState !== "active" ||
            result.response.source.lifecycle !== "active" ||
            result.response.source.pricingCurrencyRevision !==
              command.expectedPricingCurrencyRevision ||
            !isExpectedUpsertOutcome(command.expectedSourceRevision, result.response.outcome)))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(result.response.outcome === "created" ? 201 : 200).send(result.response)
        : sendCommandError(reply, result.error);
    },
  );

  app.post<{ Params: SourceParams; Body: unknown }>(
    "/properties/:propertyId/pricing-source/recurring/:sourceId/disable",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const sourceId = readSourceId(request.params, reply);
      if (!sourceId) return reply;
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isRecord(request.body)) {
        return invalidRequest(reply, "The recurring pricing disable body is invalid.");
      }
      const command = parseDisableRecurringPricingSourceCommand({
        ...request.body,
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        sourceId,
        idempotencyKey,
        audit: commandAudit(scope.context),
      });
      if (!command) {
        return invalidRequest(reply, "The recurring pricing disable body is invalid.");
      }

      const result = parsePmsRecurringPricingCommandResult(
        await options.commandPort.disableRecurringPricingSource(command),
      );
      if (
        !result ||
        (result.ok &&
          (result.response.outcome !== "disabled" ||
            result.response.source.propertyId !== scope.propertyId ||
            result.response.source.sourceId !== sourceId ||
            result.response.source.sourceKind !== command.sourceKind ||
            result.response.source.sourceRevision !== command.expectedSourceRevision + 1 ||
            result.response.source.configuredState !== "disabled" ||
            result.response.source.lifecycle !== "disabled"))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(200).send(result.response)
        : sendCommandError(reply, result.error);
    },
  );

  app.post<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/pricing-source/recurring/materializations",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isRecord(request.body)) {
        return invalidRequest(reply, "The recurring pricing materialization body is invalid.");
      }
      const command = parseMaterializeRecurringPricingCommand({
        ...request.body,
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        idempotencyKey,
        audit: commandAudit(scope.context),
      });
      if (!command) {
        return invalidRequest(reply, "The recurring pricing materialization body is invalid.");
      }

      const result = parseRecurringPricingMaterializationResult(
        await options.commandPort.materializeRecurringPricing(command),
      );
      if (
        !result ||
        (result.ok &&
          (result.receipt.propertyId !== scope.propertyId ||
            result.receipt.fromDate !== command.fromDate ||
            result.receipt.throughDate !== command.throughDate ||
            result.receipt.optionalPricingAggregateRevision !==
              command.expectedOptionalPricingAggregateRevision))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(200).send(result.receipt)
        : sendCommandError(reply, result.error);
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/pricing-source/recurring",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const rawSources = await options.readPort.listRecurringPricingSources(scope.propertyId);
      const sources = rawSources.map(parsePmsRecurringPricingSourceSnapshot);
      if (
        sources.some((source) => !source || source.propertyId !== scope.propertyId) ||
        !isStrictlySortedSources(sources)
      ) {
        return invalidPortResult(reply);
      }
      return reply.status(200).send({ sources });
    },
  );

  app.get<{ Params: SourceParams }>(
    "/properties/:propertyId/pricing-source/recurring/:sourceId",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const sourceId = readSourceId(request.params, reply);
      if (!sourceId) return reply;
      const rawSource = await options.readPort.getRecurringPricingSource(
        scope.propertyId,
        sourceId,
      );
      if (!rawSource) return reply.status(404).send({ code: "source_not_found" });
      const source = parsePmsRecurringPricingSourceSnapshot(rawSource);
      return source && source.propertyId === scope.propertyId && source.sourceId === sourceId
        ? reply.status(200).send(source)
        : invalidPortResult(reply);
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/pricing-source/recurring-booking-evidence",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const rawEvidence = await options.readPort.getRecurringPricingBookingEvidence(
        scope.propertyId,
      );
      if (!rawEvidence) {
        return reply.status(404).send({ code: "pricing_currency_not_configured" });
      }
      const evidence = parsePmsRecurringPricingBookingEvidence(rawEvidence);
      return evidence && evidence.propertyId === scope.propertyId
        ? reply.status(200).send(evidence)
        : invalidPortResult(reply);
    },
  );
}

async function upsert(
  port: PmsRecurringPricingCommandPort,
  command: NonNullable<ReturnType<typeof parseUpsertRecurringPricingSourceCommand>>,
) {
  switch (command.sourceKind) {
    case "season":
      return port.upsertRecurringSeason(command);
    case "weekend_surcharge":
      return port.upsertWeekendSurcharge(command);
    case "additional_guest":
      return port.upsertAdditionalGuestPricing(command);
    case "non_refundable":
      return port.upsertNonRefundablePricing(command);
  }
}

function isExpectedUpsertOutcome(
  expectedSourceRevision: number,
  outcome: PmsRecurringPricingCommandResponse["outcome"],
): boolean {
  return expectedSourceRevision === 0
    ? outcome === "created"
    : outcome === "updated" || outcome === "re_enabled";
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
  if (!scope) {
    throw new Error("PMS recurring pricing authorization was not resolved before body parsing");
  }
  return scope;
}

function readSourceId(params: SourceParams, reply: FastifyReply): string | null {
  if (!UUID_PATTERN.test(params.sourceId)) {
    invalidRequest(reply, "The source ID is invalid.");
    return null;
  }
  return params.sourceId.toLowerCase();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrictlySortedSources(
  sources: readonly ReturnType<typeof parsePmsRecurringPricingSourceSnapshot>[],
): boolean {
  let previous = "";
  for (const source of sources) {
    if (!source) return false;
    const key = `${String(SOURCE_KINDS.indexOf(source.sourceKind)).padStart(2, "0")}:${source.sourceId}`;
    if (key <= previous) return false;
    previous = key;
  }
  return true;
}

function sendCommandError(
  reply: FastifyReply,
  error: PmsRecurringPricingCommandError,
): FastifyReply {
  if (
    error.code === "setup_scope_unavailable" ||
    error.code === "source_not_found" ||
    error.code === "room_type_not_found" ||
    error.code === "flexible_rate_plan_not_found"
  ) {
    return reply.status(404).send(error);
  }
  if (
    error.code === "season_name_conflict" ||
    error.code === "season_overlap" ||
    error.code === "additional_guest_capacity_inapplicable" ||
    error.code === "recurring_pricing_room_plan_set_incomplete"
  ) {
    return reply.status(422).send(error);
  }
  return reply.status(409).send(error);
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({ code: "pms_recurring_pricing_port_contract_violation" });
}
