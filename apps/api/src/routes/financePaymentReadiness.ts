import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  FINANCE_PAYMENT_READINESS_AUTHORIZATION,
  parseFinancePaymentReadinessSnapshot,
  parseReplaceFinancePaymentMethodsCommand,
  parseReplaceFinancePaymentMethodsResult,
  type FinancePaymentMethodsCommandPort,
  type FinancePaymentReadinessReadPort,
  type ReplaceFinancePaymentMethodsError,
  type ReplaceFinancePaymentMethodsCommand,
  type ReplaceFinancePaymentMethodsResponse,
} from "@vayada/domain-finance";
import { PMS_PRICING_CONTRACT_VERSION } from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type FinancePaymentReadinessRoutesOptions = {
  commandPort: FinancePaymentMethodsCommandPort;
  readPort: FinancePaymentReadinessReadPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Unmounted ONB-24 adapter; future composition owns the `/api` prefix. */
export async function registerFinancePaymentReadinessRoutes(
  app: FastifyInstance,
  options: FinancePaymentReadinessRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.get<{ Params: PropertyParams }>(
    "/finance/properties/:propertyId/payment-readiness",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      let value: unknown;
      try {
        value = await options.readPort.getPaymentReadiness({
          organizationId: scope.context.selectedOrganization.organizationId,
          propertyId: scope.propertyId,
        });
      } catch {
        return portViolation(reply);
      }
      if (value === null) {
        return reply.status(404).send({ code: "payment_readiness_not_configured" });
      }
      const snapshot = parseFinancePaymentReadinessSnapshot(value);
      return snapshot?.propertyId === scope.propertyId
        ? reply.status(200).send(snapshot)
        : portViolation(reply);
    },
  );

  app.put<{ Params: PropertyParams; Body: unknown }>(
    "/finance/properties/:propertyId/payment-methods",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply);
      if (
        !isExactObject(request.body, [
          "expectedPaymentMethodsRevision",
          "expectedPricingCurrencyRevision",
          "selectedMethods",
        ])
      )
        return invalidRequest(reply);
      const command = parseReplaceFinancePaymentMethodsCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        idempotencyKey,
        expectedPaymentMethodsRevision: request.body.expectedPaymentMethodsRevision,
        expectedPricingCurrencyRevision: request.body.expectedPricingCurrencyRevision,
        selectedMethods: request.body.selectedMethods,
        audit: {
          actor: { kind: "user", userId: scope.context.actor.internalUserId },
          requestId: scope.context.audit.requestId,
          correlationId: scope.context.audit.correlationId ?? null,
          requestedAt: scope.context.audit.receivedAt,
        },
      });
      if (!command) return invalidRequest(reply);

      let value: unknown;
      try {
        value = await options.commandPort.replacePaymentMethods(command);
      } catch {
        return portViolation(reply);
      }
      const result = parseReplaceFinancePaymentMethodsResult(value);
      if (!result) return portViolation(reply);
      if (!result.ok) return sendCommandError(reply, result.error);
      return validSuccess(command, result.response)
        ? reply.status(result.response.outcome === "created" ? 201 : 200).send(result.response)
        : portViolation(reply);
    },
  );
}

function authorizeRequest(request: FastifyRequest, reply: FastifyReply): AuthorizedScope | null {
  try {
    const baseContext = enforceRoutePolicy(request, {
      permission: FINANCE_PAYMENT_READINESS_AUTHORIZATION.permission,
    });
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ code: "forbidden" });
      return null;
    }
    const rawPropertyId = (request.params as Partial<PropertyParams>).propertyId;
    if (typeof rawPropertyId !== "string" || !UUID_PATTERN.test(rawPropertyId)) {
      invalidRequest(reply);
      return null;
    }
    const propertyId = rawPropertyId.toLowerCase();
    const resource = {
      product: FINANCE_PAYMENT_READINESS_AUTHORIZATION.resource.product,
      resourceType: FINANCE_PAYMENT_READINESS_AUTHORIZATION.resource.resourceType,
      resourceId: propertyId,
    } as const;
    const context = enforceRoutePolicy(request, {
      permission: FINANCE_PAYMENT_READINESS_AUTHORIZATION.permission,
      entitlement: {
        ...FINANCE_PAYMENT_READINESS_AUTHORIZATION.entitlement,
        resource,
      },
      resource: {
        ...resource,
        allowedRelationships: FINANCE_PAYMENT_READINESS_AUTHORIZATION.resource.allowedRelationships,
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

function validSuccess(
  command: ReplaceFinancePaymentMethodsCommand,
  response: ReplaceFinancePaymentMethodsResponse,
): boolean {
  const snapshot = response.paymentReadiness;
  const committed = snapshot.pricingCurrency.committed;
  const current = snapshot.pricingCurrency.current;
  const selectedMethods = snapshot.methods
    .filter(({ selected }) => selected)
    .map(({ method }) => method);
  return (
    response.outcome === (command.expectedPaymentMethodsRevision === 0 ? "created" : "updated") &&
    snapshot.propertyId === command.propertyId &&
    snapshot.paymentMethodsRevision === command.expectedPaymentMethodsRevision + 1 &&
    selectedMethods.length === command.selectedMethods.length &&
    selectedMethods.every((method, index) => method === command.selectedMethods[index]) &&
    committed?.contractVersion === PMS_PRICING_CONTRACT_VERSION &&
    current?.contractVersion === PMS_PRICING_CONTRACT_VERSION &&
    committed.pricingCurrencyRevision === command.expectedPricingCurrencyRevision &&
    current.pricingCurrencyRevision === command.expectedPricingCurrencyRevision &&
    snapshot.pricingCurrency.matchesCurrent
  );
}

function sendCommandError(reply: FastifyReply, error: ReplaceFinancePaymentMethodsError) {
  if (error.code === "setup_scope_unavailable" || error.code === "pricing_currency_unavailable") {
    return reply.status(404).send(error);
  }
  if (error.code === "payment_method_unavailable") return reply.status(422).send(error);
  return reply.status(409).send(error);
}

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope) throw new Error("Finance payment readiness authorization was not resolved");
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

function invalidRequest(reply: FastifyReply) {
  return reply.status(400).send({ code: "invalid_request" });
}

function portViolation(reply: FastifyReply) {
  return reply.status(500).send({ code: "finance_payment_readiness_port_contract_violation" });
}
