import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  PMS_MANDATORY_CHARGE_CONFIRMATION_AUTHORIZATION,
  parseConfirmMandatoryChargesIncludedCommand,
  parseConfirmMandatoryChargesIncludedResult,
  parsePmsMandatoryChargeConfirmationReadRequest,
  parsePmsMandatoryChargeConfirmationReadResult,
  type ConfirmMandatoryChargesIncludedCommand,
  type PmsMandatoryChargeConfirmationCommandError,
  type PmsMandatoryChargeConfirmationCommandPort,
  type PmsMandatoryChargeConfirmationReadPort,
  type PmsPricingCommandAudit,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type PmsMandatoryChargeConfirmationRoutesOptions = {
  commandPort: PmsMandatoryChargeConfirmationCommandPort;
  readPort: PmsMandatoryChargeConfirmationReadPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_BODY_KEYS = [
  "expectedConfirmationRevision",
  "claimedPricingSourceFingerprint",
  "expectedPricingSourceRevisions",
] as const;

/** Target mandatory-charge confirmation owner adapter. */
export async function registerPmsMandatoryChargeConfirmationRoutes(
  app: FastifyInstance,
  options: PmsMandatoryChargeConfirmationRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.put<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/mandatory-charge-confirmation",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, COMMAND_BODY_KEYS)) {
        return invalidRequest(reply, "The mandatory-charge confirmation body is invalid.");
      }
      const command = parseConfirmMandatoryChargesIncludedCommand({
        ...request.body,
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        idempotencyKey,
        audit: commandAudit(scope.context),
      });
      if (!command) {
        return invalidRequest(reply, "The mandatory-charge confirmation body is invalid.");
      }

      let rawResult: unknown;
      try {
        rawResult = await options.commandPort.confirmMandatoryChargesIncluded(command);
      } catch {
        return unavailable(reply);
      }
      const result = parseConfirmMandatoryChargesIncludedResult(rawResult);
      if (!result || (result.ok && !matchesCommand(result.response.evidence, command))) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(200).send(result.response)
        : sendCommandError(reply, result.error);
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/mandatory-charge-confirmation",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const readRequest = parsePmsMandatoryChargeConfirmationReadRequest({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
      });
      if (!readRequest) return invalidPortResult(reply);
      let rawResult: unknown;
      try {
        rawResult = await options.readPort.getMandatoryChargeConfirmation(readRequest);
      } catch {
        return reply.status(503).send({
          ...readRequest,
          outcome: "unavailable",
          errorSource: "system",
        });
      }
      const result = parsePmsMandatoryChargeConfirmationReadResult(rawResult);
      if (
        !result ||
        result.organizationId !== readRequest.organizationId ||
        result.propertyId !== readRequest.propertyId
      ) {
        return invalidPortResult(reply);
      }
      return reply.status(readStatus(result.outcome)).send(result);
    },
  );
}

function authorizeRequest(request: FastifyRequest, reply: FastifyReply): AuthorizedScope | null {
  const authorization = PMS_MANDATORY_CHARGE_CONFIRMATION_AUTHORIZATION;
  try {
    const baseContext = enforceRoutePolicy(request, { permission: authorization.permission });
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
      product: authorization.resource.product,
      resourceType: authorization.resource.resourceType,
      resourceId: propertyId,
    } as const;
    const context = enforceRoutePolicy(request, {
      permission: authorization.permission,
      entitlement: { ...authorization.entitlement, resource },
      resource: {
        ...resource,
        allowedRelationships: authorization.resource.allowedRelationships,
      },
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

function matchesCommand(
  evidence: {
    organizationId: string;
    propertyId: string;
    pricingSourceFingerprint: string;
    confirmationRevision: number;
  },
  command: ConfirmMandatoryChargesIncludedCommand,
): boolean {
  return (
    evidence.organizationId === command.organizationId &&
    evidence.propertyId === command.propertyId &&
    evidence.pricingSourceFingerprint === command.claimedPricingSourceFingerprint &&
    evidence.confirmationRevision === command.expectedConfirmationRevision + 1
  );
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
    throw new Error(
      "PMS mandatory-charge confirmation authorization was not resolved before body parsing",
    );
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

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string") &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sendCommandError(
  reply: FastifyReply,
  error: PmsMandatoryChargeConfirmationCommandError,
): FastifyReply {
  return reply.status(error.code === "setup_scope_unavailable" ? 404 : 409).send(error);
}

function readStatus(outcome: "available" | "missing" | "malformed" | "unavailable"): number {
  if (outcome === "available") return 200;
  if (outcome === "missing") return 404;
  if (outcome === "unavailable") return 503;
  return 500;
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({ code: "pms_mandatory_charge_confirmation_port_violation" });
}

function unavailable(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({ code: "pms_mandatory_charge_confirmation_unavailable" });
}
