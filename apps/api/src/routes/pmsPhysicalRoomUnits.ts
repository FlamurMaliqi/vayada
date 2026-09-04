import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  parseReconcilePhysicalRoomUnitsCommand,
  parseReconcilePhysicalRoomUnitsResult,
  parseSetPhysicalRoomOperationalLabelCommand,
  parseSetPhysicalRoomOperationalLabelResult,
  type PhysicalRoomUnitReconcilePort,
  type PhysicalRoomOperationalLabelPort,
  type ReconcilePhysicalRoomUnitsError,
  type RoomFactsCommandAudit,
  type SetPhysicalRoomOperationalLabelError,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type Params = { propertyId: string; roomTypeId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type PmsPhysicalRoomUnitRoutesOptions = {
  commandPort: PhysicalRoomUnitReconcilePort;
};

export type PmsPhysicalRoomOperationalLabelRoutesOptions = {
  commandPort: PhysicalRoomOperationalLabelPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ONB-12 canonical physical-unit adapter, mounted below the room setup prefix. */
export async function registerPmsPhysicalRoomUnitRoutes(
  app: FastifyInstance,
  options: PmsPhysicalRoomUnitRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.put<{ Params: Params; Body: unknown }>(
    "/properties/:propertyId/room-types/:roomTypeId/physical-units/reconcile",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, ["expectedRevision", "targetActiveUnitCount"])) {
        return invalidRequest(reply, "The physical-unit reconcile body is invalid.");
      }
      const command = parseReconcilePhysicalRoomUnitsCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        roomTypeId,
        expectedRevision: request.body.expectedRevision,
        targetActiveUnitCount: request.body.targetActiveUnitCount,
        idempotencyKey,
        audit: commandAudit(scope.context),
      });
      if (!command) return invalidRequest(reply, "The physical-unit reconcile body is invalid.");

      const result = parseReconcilePhysicalRoomUnitsResult(
        await options.commandPort.reconcilePhysicalRoomUnits(command),
      );
      const expectedResultRevision =
        result?.ok && result.response.outcome === "reconciled"
          ? command.expectedRevision + 1
          : command.expectedRevision;
      if (
        !result ||
        (result.ok &&
          (result.response.propertyId !== scope.propertyId ||
            result.response.roomTypeId !== roomTypeId ||
            result.response.capacity.activeUnitCount !== command.targetActiveUnitCount ||
            result.response.capacity.roomUnitsRevision !== expectedResultRevision)) ||
        (!result.ok &&
          result.error.code === "physical_unit_reconcile_blocked" &&
          (result.error.currentRevision !== command.expectedRevision ||
            result.error.targetActiveUnitCount !== command.targetActiveUnitCount)) ||
        (!result.ok &&
          result.error.code === "room_units_revision_conflict" &&
          result.error.currentRevision === command.expectedRevision)
      ) {
        return reply.status(500).send({ code: "pms_physical_room_unit_port_contract_violation" });
      }
      return result.ok
        ? reply.status(200).send(result.response)
        : sendCommandError(reply, result.error);
    },
  );
}

export async function registerPmsPhysicalRoomOperationalLabelRoutes(
  app: FastifyInstance,
  options: PmsPhysicalRoomOperationalLabelRoutesOptions,
): Promise<void> {
  type LabelParams = Params & { roomUnitId: string };
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.put<{ Params: LabelParams; Querystring: unknown; Body: unknown }>(
    "/properties/:propertyId/room-types/:roomTypeId/physical-units/:roomUnitId/operational-label",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      if (!isExactObject(request.query, [])) {
        return invalidRequest(reply, "The operational-label route does not accept query fields.");
      }
      const roomTypeId = readRoomTypeId(request.params, reply);
      const roomUnitId = readRoomUnitId(request.params, reply);
      if (!roomTypeId || !roomUnitId) return reply;
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, ["expectedRevision", "operationalLabel"])) {
        return invalidRequest(reply, "The operational-label body is invalid.");
      }
      const command = parseSetPhysicalRoomOperationalLabelCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        roomTypeId,
        roomUnitId,
        expectedRevision: request.body.expectedRevision,
        operationalLabel: request.body.operationalLabel,
        idempotencyKey,
        audit: commandAudit(scope.context),
      });
      if (!command) return invalidRequest(reply, "The operational-label body is invalid.");

      const result = parseSetPhysicalRoomOperationalLabelResult(
        await options.commandPort.setPhysicalRoomOperationalLabel(command),
      );
      const expectedRevision =
        result?.ok && result.response.outcome === "updated"
          ? command.expectedRevision + 1
          : command.expectedRevision;
      if (
        !result ||
        (result.ok &&
          (result.response.propertyId !== scope.propertyId ||
            result.response.roomTypeId !== roomTypeId ||
            result.response.roomUnitId !== roomUnitId ||
            result.response.operationalLabel !== command.operationalLabel ||
            result.response.roomUnitsRevision !== expectedRevision)) ||
        (!result.ok &&
          result.error.code === "room_units_revision_conflict" &&
          result.error.currentRevision === command.expectedRevision)
      ) {
        return reply.status(500).send({ code: "pms_physical_room_label_port_contract_violation" });
      }
      return result.ok
        ? reply.status(200).send(result.response)
        : sendOperationalLabelError(reply, result.error);
    },
  );
}

function authorizeRequest(request: FastifyRequest, reply: FastifyReply): AuthorizedScope | null {
  try {
    const baseContext = enforceRoutePolicy(request, { permission: "pms.operations.manage" });
    if (baseContext.selectedOrganization.kind !== "hotel_group") {
      reply.status(403).send({ code: "invalid_organization_scope" });
      return null;
    }
    const rawPropertyId = (request.params as Partial<Params>).propertyId;
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
      permission: "pms.operations.manage",
      entitlement: { product: "pms", key: "property-management", resource },
      resource: { ...resource, allowedRelationships: ["owner", "operator", "front_desk"] },
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

function commandAudit(context: AuthorizedScope["context"]): RoomFactsCommandAudit {
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
  if (!scope)
    throw new Error("PMS physical-unit authorization was not resolved before body parsing");
  return scope;
}

function readRoomTypeId(params: Params, reply: FastifyReply): string | null {
  if (!UUID_PATTERN.test(params.roomTypeId)) {
    invalidRequest(reply, "The room type ID is invalid.");
    return null;
  }
  return params.roomTypeId.toLowerCase();
}

function readRoomUnitId(
  params: Params & { roomUnitId: string },
  reply: FastifyReply,
): string | null {
  if (!UUID_PATTERN.test(params.roomUnitId)) {
    invalidRequest(reply, "The room unit ID is invalid.");
    return null;
  }
  return params.roomUnitId.toLowerCase();
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
  error: ReconcilePhysicalRoomUnitsError,
): FastifyReply {
  return reply
    .status(
      error.code === "setup_scope_unavailable" || error.code === "room_type_not_found" ? 404 : 409,
    )
    .send(error);
}

function sendOperationalLabelError(
  reply: FastifyReply,
  error: SetPhysicalRoomOperationalLabelError,
): FastifyReply {
  return reply
    .status(
      error.code === "setup_scope_unavailable" ||
        error.code === "room_type_not_found" ||
        error.code === "room_unit_not_found"
        ? 404
        : 409,
    )
    .send(error);
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}
