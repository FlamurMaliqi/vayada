import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  parseBookingDesignRevision,
  parseUpsertBookingDesignRequest,
  type BookingDesignCommandError,
  type BookingDesignCommandPort,
  type BookingDesignCommandResult,
  type BookingDesignReadPort,
  type UpsertBookingDesignCommand,
} from "@vayada/domain-booking";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type BookingDesignRoutesOptions = {
  commandPort: BookingDesignCommandPort;
  readPort: BookingDesignReadPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Unmounted ONB-10 adapter; future composition owns its `/api` prefix. */
export async function registerBookingDesignRoutes(
  app: FastifyInstance,
  options: BookingDesignRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/booking-design",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      let value: unknown;
      try {
        value = await options.readPort.getCurrentDesign({
          organizationId: scope.context.selectedOrganization.organizationId,
          propertyId: scope.propertyId,
        });
      } catch {
        return invalidPortResult(reply);
      }
      if (value === null) return reply.status(404).send({ code: "booking_design_not_configured" });
      let design;
      try {
        design = parseBookingDesignRevision(value);
      } catch {
        return invalidPortResult(reply);
      }
      return design?.propertyId === scope.propertyId
        ? reply.status(200).send(design)
        : invalidPortResult(reply);
    },
  );

  app.put<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/booking-design",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply);
      const body = parseUpsertBookingDesignRequest(request.body);
      if (!body) return invalidRequest(reply);
      const command: UpsertBookingDesignCommand = {
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        actorUserId: scope.context.actor.internalUserId,
        idempotencyKey,
        expectedRevision: body.expectedRevision,
        choices: body.choices,
        audit: {
          requestId: scope.context.audit.requestId,
          source: scope.context.audit.source,
          ...(scope.context.audit.correlationId
            ? { correlationId: scope.context.audit.correlationId }
            : {}),
        },
      };

      let value: unknown;
      try {
        value = await options.commandPort.upsertDesign(command);
      } catch {
        return invalidPortResult(reply);
      }
      let result;
      try {
        result = parseCommandResult(value, command);
      } catch {
        return invalidPortResult(reply);
      }
      if (!result) return invalidPortResult(reply);
      if (!result.ok) return sendCommandError(reply, result.error);
      return reply
        .status(result.outcome === "created" ? 201 : 200)
        .send({ outcome: result.outcome, design: result.design });
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
      invalidRequest(reply);
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

function parseCommandResult(
  value: unknown,
  command: UpsertBookingDesignCommand,
): BookingDesignCommandResult | null {
  if (!exact(value, ["ok", "outcome", "design"]) && !exact(value, ["ok", "error"])) {
    return null;
  }
  if (value["ok"] === true) {
    const outcome = value["outcome"];
    const expectedOutcome = command.expectedRevision === 0 ? "created" : "updated";
    const design = parseBookingDesignRevision(value["design"]);
    if (
      (outcome !== "created" && outcome !== "updated" && outcome !== "idempotent_replay") ||
      (outcome !== expectedOutcome && outcome !== "idempotent_replay") ||
      !design ||
      design.propertyId !== command.propertyId ||
      design.revision !== command.expectedRevision + 1 ||
      design.choices.primaryColor !== command.choices.primaryColor ||
      design.choices.fontPairing !== command.choices.fontPairing
    ) {
      return null;
    }
    return { ok: true, outcome, design };
  }
  if (value["ok"] !== false) return null;
  const error = parseCommandError(value["error"]);
  return error ? { ok: false, error } : null;
}

function parseCommandError(value: unknown): BookingDesignCommandError | null {
  if (!exact(value, ["code"]) && !exact(value, ["code", "currentRevision"])) return null;
  const code = value["code"];
  if (
    code === "command_in_progress" ||
    code === "idempotency_key_conflict" ||
    code === "setup_scope_unavailable"
  ) {
    return exact(value, ["code"]) ? { code } : null;
  }
  const currentRevision = value["currentRevision"];
  return code === "design_revision_conflict" &&
    exact(value, ["code", "currentRevision"]) &&
    Number.isSafeInteger(currentRevision) &&
    (currentRevision as number) >= 0 &&
    (currentRevision as number) <= 2_147_483_647
    ? { code, currentRevision: currentRevision as number }
    : null;
}

function sendCommandError(reply: FastifyReply, error: BookingDesignCommandError) {
  return reply.status(error.code === "setup_scope_unavailable" ? 404 : 409).send(error);
}

function requireAuthorizedScope(
  authorized: WeakMap<FastifyRequest, AuthorizedScope>,
  request: FastifyRequest,
): AuthorizedScope {
  const scope = authorized.get(request);
  if (!scope) throw new Error("Booking design authorization was not resolved before body parsing");
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

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === "string") &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function invalidRequest(reply: FastifyReply) {
  return reply.status(400).send({ code: "invalid_request" });
}

function invalidPortResult(reply: FastifyReply) {
  return reply.status(500).send({ code: "booking_design_port_contract_violation" });
}
