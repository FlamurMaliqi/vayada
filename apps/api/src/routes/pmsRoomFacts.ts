import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseCreateRoomTypeFactsCommand,
  parseCreateRoomTypeFactsResult,
  parseDraftRoomId,
  parseDraftRoomTypeBinding,
  parsePhysicalRoomUnitIdentity,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFactsSnapshot,
  parseSafeDeleteRoomTypeCommand,
  parseSafeDeleteRoomTypeResult,
  parseUpdateRoomTypeFactsCommand,
  parseUpdateRoomTypeFactsResult,
  type DraftRoomTypeBindingReadPort,
  type PhysicalRoomUnitIdentityReadPort,
  type RoomCapacityReadPort,
  type RoomFactsCommandAudit,
  type RoomFactsCommandError,
  type RoomFactsCommandPort,
  type RoomFactsReadPort,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type RoomTypeParams = PropertyParams & { roomTypeId: string };
type DraftBindingParams = PropertyParams & { draftRoomId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type PmsRoomFactsRoutesOptions = {
  commandPort: RoomFactsCommandPort;
  factsReadPort: RoomFactsReadPort;
  bindingReadPort: DraftRoomTypeBindingReadPort;
  unitReadPort: PhysicalRoomUnitIdentityReadPort;
  capacityReadPort: RoomCapacityReadPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * VAY-1068 cutover adapter. Its canonical room-type paths overlap the legacy
 * pmsOperations route group, so this factory must remain unmounted until the
 * reviewed PMS room-type cutover replaces those handlers.
 */
export async function registerPmsRoomFactsRoutes(
  app: FastifyInstance,
  options: PmsRoomFactsRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.post<{ Params: PropertyParams; Body: unknown }>(
    "/properties/:propertyId/room-types",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, ["draftRoomId", "expectedRevision", "facts"])) {
        return invalidRequest(reply, "The room facts create body is invalid.");
      }
      const command = parseCreateRoomTypeFactsCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        idempotencyKey,
        audit: commandAudit(scope.context),
        draftRoomId: request.body["draftRoomId"],
        expectedRevision: request.body["expectedRevision"],
        facts: request.body["facts"],
      });
      if (!command) return invalidRequest(reply, "The room facts create body is invalid.");

      const result = parseCreateRoomTypeFactsResult(
        await options.commandPort.createRoomTypeFacts(command),
      );
      if (
        !result ||
        (result.ok &&
          (result.response.roomType.propertyId !== scope.propertyId ||
            result.response.draftRoomBinding.draftRoomId !== command.draftRoomId))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(201).send(result.response)
        : sendCommandError(reply, result.error);
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/room-types",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const items = (await options.factsReadPort.listRoomTypeFacts(scope.propertyId)).map(
        parseRoomTypeFactsSnapshot,
      );
      if (items.some((item) => !item || item.propertyId !== scope.propertyId)) {
        return invalidPortResult(reply);
      }
      return reply.status(200).send({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId: scope.propertyId,
        items,
      });
    },
  );

  app.get<{ Params: RoomTypeParams }>(
    "/properties/:propertyId/room-types/:roomTypeId",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const value = await options.factsReadPort.getRoomTypeFacts(scope.propertyId, roomTypeId);
      if (!value) return notFound(reply, "room_type_not_found");
      const item = parseRoomTypeFactsSnapshot(value);
      return item && item.propertyId === scope.propertyId && item.roomTypeId === roomTypeId
        ? reply.status(200).send(item)
        : invalidPortResult(reply);
    },
  );

  app.put<{ Params: RoomTypeParams; Body: unknown }>(
    "/properties/:propertyId/room-types/:roomTypeId",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, ["expectedRevision", "facts"])) {
        return invalidRequest(reply, "The room facts update body is invalid.");
      }
      const command = parseUpdateRoomTypeFactsCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        idempotencyKey,
        audit: commandAudit(scope.context),
        roomTypeId,
        expectedRevision: request.body["expectedRevision"],
        facts: request.body["facts"],
      });
      if (!command) return invalidRequest(reply, "The room facts update body is invalid.");

      const result = parseUpdateRoomTypeFactsResult(
        await options.commandPort.updateRoomTypeFacts(command),
      );
      if (
        !result ||
        (result.ok &&
          (result.response.roomType.propertyId !== scope.propertyId ||
            result.response.roomType.roomTypeId !== roomTypeId ||
            result.response.roomType.roomFactsRevision !== command.expectedRevision + 1))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(200).send(result.response)
        : sendCommandError(reply, result.error);
    },
  );

  app.delete<{ Params: RoomTypeParams; Body: unknown }>(
    "/properties/:propertyId/room-types/:roomTypeId",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, ["expectedRevision"])) {
        return invalidRequest(reply, "The safe-delete body is invalid.");
      }
      const command = parseSafeDeleteRoomTypeCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        idempotencyKey,
        audit: commandAudit(scope.context),
        roomTypeId,
        expectedRevision: request.body["expectedRevision"],
      });
      if (!command) return invalidRequest(reply, "The safe-delete body is invalid.");

      const result = parseSafeDeleteRoomTypeResult(
        await options.commandPort.safeDeleteRoomType(command),
      );
      if (
        !result ||
        (result.ok &&
          (result.response.propertyId !== scope.propertyId ||
            result.response.roomTypeId !== roomTypeId ||
            result.response.deletedRevision !== command.expectedRevision + 1))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(200).send(result.response)
        : sendCommandError(reply, result.error);
    },
  );

  app.get<{ Params: DraftBindingParams }>(
    "/properties/:propertyId/room-type-bindings/:draftRoomId",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const draftRoomId = parseDraftRoomId(request.params.draftRoomId);
      if (!draftRoomId) return invalidRequest(reply, "The draft room ID is invalid.");
      const value = await options.bindingReadPort.getDraftRoomTypeBinding(
        scope.propertyId,
        draftRoomId,
      );
      if (!value) return notFound(reply, "draft_room_binding_not_found");
      const binding = parseDraftRoomTypeBinding(value);
      return binding &&
        binding.propertyId === scope.propertyId &&
        binding.draftRoomId === draftRoomId
        ? reply.status(200).send(binding)
        : invalidPortResult(reply);
    },
  );

  app.get<{ Params: RoomTypeParams }>(
    "/properties/:propertyId/room-types/:roomTypeId/units",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const items = (
        await options.unitReadPort.listPhysicalRoomUnitIdentities(scope.propertyId, roomTypeId)
      ).map(parsePhysicalRoomUnitIdentity);
      if (
        items.some(
          (item) => !item || item.propertyId !== scope.propertyId || item.roomTypeId !== roomTypeId,
        )
      ) {
        return invalidPortResult(reply);
      }
      return reply.status(200).send({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId: scope.propertyId,
        roomTypeId,
        items,
      });
    },
  );

  app.get<{ Params: RoomTypeParams }>(
    "/properties/:propertyId/room-types/:roomTypeId/capacity",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const value = await options.capacityReadPort.getRoomTypeCapacity(
        scope.propertyId,
        roomTypeId,
      );
      if (!value) return notFound(reply, "room_type_not_found");
      const capacity = parseRoomTypeCapacitySnapshot(value);
      return capacity &&
        capacity.propertyId === scope.propertyId &&
        capacity.roomTypeId === roomTypeId
        ? reply.status(200).send(capacity)
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
  if (!scope) throw new Error("PMS room-facts authorization was not resolved before body parsing");
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

function sendCommandError(reply: FastifyReply, error: RoomFactsCommandError): FastifyReply {
  if (error.code === "setup_scope_unavailable" || error.code === "room_type_not_found") {
    return reply.status(404).send(error);
  }
  if (error.code === "unsupported_room_fact_keys") return reply.status(422).send(error);
  return reply.status(409).send(error);
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function notFound(reply: FastifyReply, code: string): FastifyReply {
  return reply.status(404).send({ code });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({ code: "pms_room_facts_port_contract_violation" });
}
