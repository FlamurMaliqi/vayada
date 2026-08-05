import { UnauthorizedError } from "@vayada/backend-auth";
import { AuthorizationError } from "@vayada/backend-authorization";
import {
  PMS_ROOM_AMENITIES_CONTRACT_VERSION,
  PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
  ROOM_PUBLICATION_BLOCKER_CODES,
  ROOM_PUBLIC_MEDIA_VARIANT_NAMES,
  parseAssignRoomTypeMediaCommand,
  parseAssignRoomTypeMediaResult,
  parseConfirmRoomTypeAmenitiesCommand,
  parseConfirmRoomTypeAmenitiesResult,
  parseRoomAmenitiesSnapshot,
  parseRoomTypeFacts,
  type AssignRoomTypeMediaError,
  type ConfirmRoomTypeAmenitiesError,
  type RoomAmenitiesCommandPort,
  type RoomFactsCommandAudit,
  type RoomMediaAssignmentCommandPort,
  type RoomPublicationSnapshot,
  type RoomPublicationSnapshotPort,
} from "@vayada/domain-pms";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

type PropertyParams = { propertyId: string };
type RoomTypeParams = PropertyParams & { roomTypeId: string };
type AuthorizedScope = {
  context: ReturnType<typeof enforceRoutePolicy>;
  propertyId: string;
};

export type PmsRoomPublicationRoutesOptions = {
  mediaCommandPort: RoomMediaAssignmentCommandPort;
  amenitiesCommandPort: RoomAmenitiesCommandPort;
  snapshotPort: RoomPublicationSnapshotPort;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * VAY-1061 owner adapter. It remains unmounted until the coordinated PMS API
 * composition cutover; registering this factory alone cannot activate public content.
 */
export async function registerPmsRoomPublicationRoutes(
  app: FastifyInstance,
  options: PmsRoomPublicationRoutesOptions,
): Promise<void> {
  const authorized = new WeakMap<FastifyRequest, AuthorizedScope>();
  const authorize = async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = authorizeRequest(request, reply);
    if (scope) authorized.set(request, scope);
  };

  app.put<{ Params: RoomTypeParams; Body: unknown }>(
    "/properties/:propertyId/room-types/:roomTypeId/media",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, ["expectedRoomMediaRevision", "assignments"])) {
        return invalidRequest(reply, "The room media assignment body is invalid.");
      }
      const command = parseAssignRoomTypeMediaCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        roomTypeId,
        expectedRoomMediaRevision: request.body["expectedRoomMediaRevision"],
        assignments: request.body["assignments"],
        idempotencyKey,
        audit: commandAudit(scope.context),
      });
      if (!command) return invalidRequest(reply, "The room media assignment body is invalid.");

      const result = parseAssignRoomTypeMediaResult(
        await options.mediaCommandPort.assignRoomTypeMedia(command),
      );
      if (
        !result ||
        (result.ok &&
          (result.response.propertyId !== scope.propertyId ||
            result.response.roomTypeId !== roomTypeId ||
            result.response.roomMediaRevision !== command.expectedRoomMediaRevision + 1 ||
            !sameMediaAssignments(result.response.assignments, command.assignments)))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(200).send(result.response)
        : sendMediaError(reply, result.error);
    },
  );

  app.put<{ Params: RoomTypeParams; Body: unknown }>(
    "/properties/:propertyId/room-types/:roomTypeId/amenities",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const roomTypeId = readRoomTypeId(request.params, reply);
      if (!roomTypeId) return reply;
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return invalidRequest(reply, "A single Idempotency-Key is required.");
      if (!isExactObject(request.body, ["expectedRoomAmenitiesRevision", "amenities"])) {
        return invalidRequest(reply, "The room amenities confirmation body is invalid.");
      }
      const command = parseConfirmRoomTypeAmenitiesCommand({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
        roomTypeId,
        expectedRoomAmenitiesRevision: request.body["expectedRoomAmenitiesRevision"],
        amenities: request.body["amenities"],
        idempotencyKey,
        audit: commandAudit(scope.context),
      });
      if (!command)
        return invalidRequest(reply, "The room amenities confirmation body is invalid.");

      const result = parseConfirmRoomTypeAmenitiesResult(
        await options.amenitiesCommandPort.confirmRoomTypeAmenities(command),
      );
      if (
        !result ||
        (result.ok &&
          (result.response.roomAmenities.propertyId !== scope.propertyId ||
            result.response.roomAmenities.roomTypeId !== roomTypeId ||
            result.response.roomAmenities.roomAmenitiesRevision !==
              command.expectedRoomAmenitiesRevision + 1 ||
            !sameStrings(result.response.roomAmenities.amenities, command.amenities)))
      ) {
        return invalidPortResult(reply);
      }
      return result.ok
        ? reply.status(200).send(result.response)
        : sendAmenitiesError(reply, result.error);
    },
  );

  app.get<{ Params: PropertyParams }>(
    "/properties/:propertyId/room-publication-snapshot",
    { onRequest: authorize },
    async (request, reply) => {
      const scope = requireAuthorizedScope(authorized, request);
      const snapshot = await options.snapshotPort.getRoomPublicationSnapshot({
        organizationId: scope.context.selectedOrganization.organizationId,
        propertyId: scope.propertyId,
      });
      return validSnapshotScope(snapshot, scope.propertyId)
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
  if (!scope) {
    throw new Error("PMS room-publication authorization was not resolved before body parsing");
  }
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

function validSnapshotScope(value: unknown, propertyId: string): value is RoomPublicationSnapshot {
  if (
    !isExactDataRecord(value, [
      "contractVersion",
      "propertyId",
      "status",
      "rooms",
      "blockers",
      "sourceRevision",
    ]) ||
    value["contractVersion"] !== PMS_ROOM_PUBLICATION_CONTRACT_VERSION ||
    value["propertyId"] !== propertyId ||
    !isDensePlainArray(value["rooms"]) ||
    !isDensePlainArray(value["blockers"]) ||
    typeof value["sourceRevision"] !== "string"
  ) {
    return false;
  }
  const roomIds: string[] = [];
  for (const room of value["rooms"]) {
    if (!validSnapshotRoom(room, propertyId)) return false;
    roomIds.push(room["roomTypeId"] as string);
  }
  if (
    new Set(roomIds).size !== roomIds.length ||
    !strictlyCodeUnitSorted(roomIds) ||
    !value["blockers"].every((blocker) => validSnapshotBlocker(blocker, propertyId, roomIds))
  ) {
    return false;
  }
  const derivedSourceRevision = JSON.stringify(
    value["rooms"].map((room) => [
      (room as Record<string, unknown>)["roomTypeId"],
      (room as Record<string, unknown>)["sourceRevision"],
    ]),
  );
  if (value["sourceRevision"] !== derivedSourceRevision) return false;
  if (
    !completeBlockerCoverage(value["rooms"], value["blockers"], propertyId, value["sourceRevision"])
  ) {
    return false;
  }
  return value["status"] === (value["blockers"].length === 0 ? "ready" : "blocked");
}

function validSnapshotRoom(value: unknown, propertyId: string): value is Record<string, unknown> {
  if (
    !isExactDataRecord(value, [
      "propertyId",
      "roomTypeId",
      "facts",
      "activeUnitCount",
      "media",
      "amenities",
      "sourceRevisions",
      "sourceRevision",
    ]) ||
    value["propertyId"] !== propertyId ||
    typeof value["roomTypeId"] !== "string" ||
    !UUID_PATTERN.test(value["roomTypeId"]) ||
    !parseRoomTypeFacts(value["facts"]) ||
    !Number.isSafeInteger(value["activeUnitCount"]) ||
    (value["activeUnitCount"] as number) < 0 ||
    !isDensePlainArray(value["media"]) ||
    typeof value["sourceRevision"] !== "string" ||
    !validSourceRevisions(value["sourceRevisions"])
  ) {
    return false;
  }
  const roomTypeId = value["roomTypeId"].toLowerCase();
  if (roomTypeId !== value["roomTypeId"]) return false;
  if (!value["media"].every((assignment, index) => validPublicMedia(assignment, index))) {
    return false;
  }
  const amenities = value["amenities"];
  if (amenities === null) return true;
  if (!isDensePlainArray(amenities)) return false;
  const parsed = parseRoomAmenitiesSnapshot({
    contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomAmenitiesRevision: value["sourceRevisions"]["roomAmenitiesRevision"],
    reviewed: true,
    amenities,
    reviewedAt: "2000-01-01T00:00:00.000Z",
  });
  return !!parsed && sameStrings(parsed.amenities, amenities);
}

function validSourceRevisions(value: unknown): value is Record<string, number> {
  return (
    isExactDataRecord(value, [
      "roomFactsRevision",
      "roomUnitsRevision",
      "roomMediaRevision",
      "roomAmenitiesRevision",
    ]) &&
    [
      value["roomFactsRevision"],
      value["roomUnitsRevision"],
      value["roomMediaRevision"],
      value["roomAmenitiesRevision"],
    ].every(isPositiveRevision)
  );
}

function validPublicMedia(value: unknown, index: number): boolean {
  if (
    !isExactDataRecord(value, ["mediaObjectId", "altText", "sortOrder", "publicVariants"]) ||
    typeof value["mediaObjectId"] !== "string" ||
    !UUID_PATTERN.test(value["mediaObjectId"]) ||
    value["mediaObjectId"].toLowerCase() !== value["mediaObjectId"] ||
    (value["altText"] !== null &&
      (typeof value["altText"] !== "string" || value["altText"].length > 500)) ||
    value["sortOrder"] !== index ||
    !isDensePlainArray(value["publicVariants"]) ||
    value["publicVariants"].length === 0
  ) {
    return false;
  }
  const variantNames = new Set<string>();
  const valid = value["publicVariants"].every((variant) => {
    if (
      !isExactDataRecord(variant, ["variantName", "publicUrl"]) ||
      typeof variant["variantName"] !== "string" ||
      !ROOM_PUBLIC_MEDIA_VARIANT_NAMES.includes(
        variant["variantName"] as (typeof ROOM_PUBLIC_MEDIA_VARIANT_NAMES)[number],
      ) ||
      variantNames.has(variant["variantName"]) ||
      typeof variant["publicUrl"] !== "string" ||
      !isSafePublicUrl(variant["publicUrl"])
    ) {
      return false;
    }
    variantNames.add(variant["variantName"]);
    return true;
  });
  const variantOrder = value["publicVariants"].map((variant) =>
    isExactDataRecord(variant, ["variantName", "publicUrl"])
      ? `${String(variant["variantName"])}\u0000${String(variant["publicUrl"])}`
      : "",
  );
  return valid && variantNames.has("original_safe") && strictlyCodeUnitSorted(variantOrder);
}

function validSnapshotBlocker(
  value: unknown,
  propertyId: string,
  roomIds: readonly string[],
): boolean {
  if (
    !isExactDataRecord(value, [
      "code",
      "product",
      "ownerDomain",
      "owningStepId",
      "affectedEntity",
      "message",
      "kind",
      "sourceRevision",
    ]) ||
    typeof value["code"] !== "string" ||
    !ROOM_PUBLICATION_BLOCKER_CODES.includes(
      value["code"] as (typeof ROOM_PUBLICATION_BLOCKER_CODES)[number],
    ) ||
    value["product"] !== "pms" ||
    value["ownerDomain"] !== "pms" ||
    value["owningStepId"] !== "rooms" ||
    value["kind"] !== "user_fixable" ||
    value["message"] !==
      BLOCKER_MESSAGES[value["code"] as (typeof ROOM_PUBLICATION_BLOCKER_CODES)[number]] ||
    typeof value["sourceRevision"] !== "string" ||
    !isExactDataRecord(value["affectedEntity"], ["entityType", "entityId"])
  ) {
    return false;
  }
  const entity = value["affectedEntity"];
  return value["code"] === "room_type_required"
    ? entity["entityType"] === "property" && entity["entityId"] === propertyId
    : entity["entityType"] === "room_type" &&
        typeof entity["entityId"] === "string" &&
        roomIds.includes(entity["entityId"]);
}

const BLOCKER_MESSAGES: Record<(typeof ROOM_PUBLICATION_BLOCKER_CODES)[number], string> = {
  room_type_required: "Add at least one room type before publishing.",
  room_units_required: "Add at least one unit for this room type before publishing.",
  room_photo_required: "Add at least one room photo before publishing.",
  room_media_unavailable: "Review this room's photos before publishing.",
  room_amenities_review_required: "Review this room's amenities before publishing.",
};

function completeBlockerCoverage(
  rooms: readonly unknown[],
  blockers: readonly unknown[],
  propertyId: string,
  snapshotSourceRevision: string,
): boolean {
  const actual = new Set<string>();
  const actualSortKeys: string[] = [];
  for (const blocker of blockers) {
    if (
      !isExactDataRecord(blocker, [
        "code",
        "product",
        "ownerDomain",
        "owningStepId",
        "affectedEntity",
        "message",
        "kind",
        "sourceRevision",
      ]) ||
      !isExactDataRecord(blocker["affectedEntity"], ["entityType", "entityId"])
    ) {
      return false;
    }
    const entity = blocker["affectedEntity"];
    const key = blockerKey(
      String(blocker["code"]),
      String(entity["entityType"]),
      String(entity["entityId"]),
      String(blocker["sourceRevision"]),
    );
    if (actual.has(key)) return false;
    actual.add(key);
    actualSortKeys.push(
      JSON.stringify([entity["entityType"], entity["entityId"], blocker["code"]]),
    );
  }
  if (!strictlyCodeUnitSorted(actualSortKeys)) return false;

  const expected = new Set<string>();
  if (rooms.length === 0) {
    expected.add(blockerKey("room_type_required", "property", propertyId, snapshotSourceRevision));
  }
  for (const room of rooms) {
    if (!validSnapshotRoom(room, propertyId)) return false;
    const roomTypeId = String(room["roomTypeId"]);
    const sourceRevision = String(room["sourceRevision"]);
    if (room["activeUnitCount"] === 0) {
      expected.add(blockerKey("room_units_required", "room_type", roomTypeId, sourceRevision));
    }
    if ((room["media"] as unknown[]).length === 0) {
      const photo = blockerKey("room_photo_required", "room_type", roomTypeId, sourceRevision);
      const unavailable = blockerKey(
        "room_media_unavailable",
        "room_type",
        roomTypeId,
        sourceRevision,
      );
      if (actual.has(photo) === actual.has(unavailable)) return false;
      expected.add(actual.has(photo) ? photo : unavailable);
    }
    if (room["amenities"] === null) {
      expected.add(
        blockerKey("room_amenities_review_required", "room_type", roomTypeId, sourceRevision),
      );
    }
  }
  return actual.size === expected.size && [...actual].every((key) => expected.has(key));
}

function blockerKey(code: string, entityType: string, entityId: string, sourceRevision: string) {
  return JSON.stringify([code, entityType, entityId, sourceRevision]);
}

function sameMediaAssignments(
  left: readonly { mediaObjectId: string; altText: string | null; sortOrder: number }[],
  right: readonly { mediaObjectId: string; altText: string | null; sortOrder: number }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (assignment, index) =>
        assignment.mediaObjectId === right[index]?.mediaObjectId &&
        assignment.altText === right[index]?.altText &&
        assignment.sortOrder === right[index]?.sortOrder,
    )
  );
}

function sameStrings(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function isPositiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
  );
}

function isSafePublicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function strictlyCodeUnitSorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? "") < value);
}

function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) return false;
  }
  return ownKeys.every(
    (key) =>
      key === "length" || (/^(?:0|[1-9]\d*)$/.test(String(key)) && Number(key) < value.length),
  );
}

function isExactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function sendMediaError(reply: FastifyReply, error: AssignRoomTypeMediaError): FastifyReply {
  if (
    error.code === "setup_scope_unavailable" ||
    error.code === "room_type_not_found" ||
    error.code === "media_not_found"
  ) {
    return reply.status(404).send(error);
  }
  if (error.code === "media_not_authorized") return reply.status(403).send(error);
  if (error.code === "media_not_ready") return reply.status(422).send(error);
  return reply.status(409).send(error);
}

function sendAmenitiesError(
  reply: FastifyReply,
  error: ConfirmRoomTypeAmenitiesError,
): FastifyReply {
  if (error.code === "setup_scope_unavailable" || error.code === "room_type_not_found") {
    return reply.status(404).send(error);
  }
  if (error.code === "unsupported_room_amenity_keys") return reply.status(422).send(error);
  return reply.status(409).send(error);
}

function invalidRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ code: "invalid_request", message });
}

function invalidPortResult(reply: FastifyReply): FastifyReply {
  return reply.status(500).send({ code: "pms_room_publication_port_contract_violation" });
}
