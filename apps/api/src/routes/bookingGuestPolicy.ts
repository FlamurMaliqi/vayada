import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError, type PropertyAccessRepository } from "@vayada/backend-authorization";
import {
  BOOKING_GUEST_POLICY_AUTHORIZATION,
  bookingArrivalTimeErrors,
  parseBookingGuestPolicyChoices,
  parseBookingGuestPolicyCommandResult,
  parseBookingGuestPolicyComposition,
  parseBookingGuestPolicyReadiness,
  parseBookingGuestPolicySetupAggregate,
  parseUpsertBookingGuestPolicyRequest,
  type BookingGuestPolicyApplicationPort,
  type BookingGuestPolicyCommandError,
  type UpsertBookingGuestPolicyCommand,
} from "@vayada/domain-booking";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforcePropertyRoutePolicy, enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type AuthorizedScope = {
  context: Awaited<ReturnType<typeof enforcePropertyRoutePolicy>>;
  propertyId: string;
};

export type BookingGuestPolicyRoutesOptions = {
  application: BookingGuestPolicyApplicationPort;
  propertyAccessRepository: PropertyAccessRepository;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Protected Booking-owned setup adapter; application composition owns its `/api/booking` prefix. */
export async function registerBookingGuestPolicyRoutes(
  app: FastifyInstance,
  options: BookingGuestPolicyRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = await authorizeRequest(request, reply, options.propertyAccessRepository);
    if (scope) authorized.set(request, scope);
  };

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/booking-guest-policy",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      let value: unknown;
      try {
        value = await options.application.getGuestPolicySetup(applicationScope(scope));
      } catch {
        return portViolation(reply);
      }
      const aggregate = parseBookingGuestPolicySetupAggregate(value);
      return aggregate?.organizationId === scope.context.selectedOrganization.organizationId &&
        aggregate.propertyId === scope.propertyId
        ? reply.status(200).send(aggregate)
        : portViolation(reply);
    },
  );

  app.post<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/booking-guest-policy/preview",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      if (!exactDataRecord(request.body, ["choices"])) return invalidRequest(reply);
      const choices = parseBookingGuestPolicyChoices(request.body.choices);
      if (!choices) return invalidRequest(reply, request.body.choices);
      let value: unknown;
      try {
        value = await options.application.previewGuestPolicy({
          ...applicationScope(scope),
          choices,
        });
      } catch {
        return portViolation(reply);
      }
      const composition = parseBookingGuestPolicyComposition(value);
      const compositionScope =
        composition?.outcome === "ready"
          ? composition.bundle
          : composition?.outcome === "blocked"
            ? composition
            : null;
      return compositionScope?.organizationId ===
        scope.context.selectedOrganization.organizationId &&
        compositionScope.propertyId === scope.propertyId
        ? reply.status(200).send(composition)
        : portViolation(reply);
    },
  );

  app.put<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/booking-guest-policy",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      const body = parseUpsertBookingGuestPolicyRequest(request.body);
      if (!idempotencyKey || !body)
        return invalidRequest(reply, (request.body as { choices?: unknown } | null)?.choices);
      const command: UpsertBookingGuestPolicyCommand = {
        ...applicationScope(scope),
        idempotencyKey,
        audit: {
          actor: { kind: "user", userId: scope.context.actor.internalUserId },
          requestId: scope.context.audit.requestId,
          correlationId: scope.context.audit.correlationId ?? null,
          requestedAt: scope.context.audit.receivedAt,
        },
        ...body,
      };
      let value: unknown;
      try {
        value = await options.application.upsertGuestPolicy(command);
      } catch {
        return portViolation(reply);
      }
      const result = parseBookingGuestPolicyCommandResult(value, command);
      if (!result) return portViolation(reply);
      if (!result.ok) return sendCommandError(reply, result.error);
      return reply
        .status(result.outcome === "created" ? 201 : 200)
        .send({ outcome: result.outcome, revision: result.revision });
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/booking-guest-policy/readiness",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      let value: unknown;
      try {
        value = await options.application.getGuestPolicyReadiness(applicationScope(scope));
      } catch {
        return portViolation(reply);
      }
      const readiness = parseBookingGuestPolicyReadiness(value);
      if (
        !readiness ||
        readiness.organizationId !== scope.context.selectedOrganization.organizationId ||
        readiness.propertyId !== scope.propertyId
      )
        return portViolation(reply);
      return reply
        .status(readiness.blockers.some(({ kind }) => kind === "provider_failure") ? 503 : 200)
        .send(readiness);
    },
  );
}

async function authorizeRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  propertyAccessRepository: PropertyAccessRepository,
): Promise<AuthorizedScope | null> {
  try {
    const baseContext = enforceRoutePolicy(request, {
      permission: BOOKING_GUEST_POLICY_AUTHORIZATION.permission,
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
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: propertyId,
    } as const;
    const context = await enforcePropertyRoutePolicy(
      request,
      {
        permission: BOOKING_GUEST_POLICY_AUTHORIZATION.permission,
        property: {
          propertyId,
          targetResource: { product: "booking", resourceType: "booking_hotel" },
        },
        entitlement: {
          ...BOOKING_GUEST_POLICY_AUTHORIZATION.entitlement,
          resource,
        },
        resource: {
          ...resource,
          allowedRelationships: BOOKING_GUEST_POLICY_AUTHORIZATION.resource.allowedRelationships,
        },
      },
      propertyAccessRepository,
    );
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

function sendCommandError(reply: FastifyReply, error: BookingGuestPolicyCommandError) {
  if (error.code === "setup_scope_unavailable") return reply.status(404).send(error);
  if (error.code === "guest_policy_not_ready" || error.code === "policy_confirmation_required")
    return reply.status(422).send(error);
  return reply.status(409).send(error);
}

function applicationScope(scope: AuthorizedScope) {
  return {
    organizationId: scope.context.selectedOrganization.organizationId,
    propertyId: scope.propertyId,
  };
}

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope)
    throw new Error("Booking guest-policy authorization was not resolved before body parsing");
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

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Object.keys(descriptors).length === keys.length &&
    Object.keys(descriptors).every((key) => keys.includes(key)) &&
    Object.values(descriptors).every(
      (descriptor) => "value" in descriptor && descriptor.enumerable === true,
    )
  );
}

function invalidRequest(reply: FastifyReply, choices?: unknown) {
  const details =
    typeof choices === "object" && choices !== null && !Array.isArray(choices)
      ? bookingArrivalTimeErrors(choices as Record<string, unknown>)
      : [];
  return reply.status(400).send({
    code: "invalid_request",
    ...(details.length ? { details, message: details.join(" ") } : {}),
  });
}

function portViolation(reply: FastifyReply) {
  return reply.status(500).send({ code: "booking_guest_policy_port_contract_violation" });
}
