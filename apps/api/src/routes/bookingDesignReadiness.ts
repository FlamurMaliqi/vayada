import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  parseBookingDesignReadinessResult,
  type BookingDesignReadinessPort,
} from "@vayada/domain-booking";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type BookingDesignReadinessRoutesOptions = {
  readinessPort: BookingDesignReadinessPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function registerBookingDesignReadinessRoutes(
  app: FastifyInstance,
  options: BookingDesignReadinessRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/booking-design/readiness",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const input = {
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
      };
      let value: unknown;
      try {
        value = await options.readinessPort.getBookingDesignReadiness(input);
      } catch {
        return portViolation(reply);
      }
      let result;
      try {
        result = parseBookingDesignReadinessResult(value, input);
      } catch {
        return portViolation(reply);
      }
      if (!result) return portViolation(reply);
      return reply.status(result.outcome === "provider_failure" ? 503 : 200).send(result);
    },
  );
}

function authorizeRequest(request: FastifyRequest, reply: FastifyReply): AuthorizedScope | null {
  try {
    const baseContext = enforceRoutePolicy(request, { permission: "booking.settings.manage" });
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ code: "forbidden" });
      return null;
    }
    const rawPropertyId = (request.params as Partial<PropertyParams>).propertyId;
    if (typeof rawPropertyId !== "string" || !UUID_PATTERN.test(rawPropertyId)) {
      reply.status(400).send({ code: "invalid_request" });
      return null;
    }
    const propertyId = rawPropertyId.toLowerCase();
    const resource = {
      product: "booking",
      resourceType: "booking_hotel",
      resourceId: propertyId,
    } as const;
    const context = enforceRoutePolicy(request, {
      permission: "booking.settings.manage",
      entitlement: { product: "booking", key: "booking-engine", resource },
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

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope) throw new Error("Booking design readiness authorization was not resolved");
  return scope;
}

function portViolation(reply: FastifyReply) {
  return reply.status(500).send({ code: "booking_design_readiness_port_contract_violation" });
}
