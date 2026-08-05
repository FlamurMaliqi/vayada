import type { RoomMediaProjectionInput } from "@vayada/domain-hotels";

import {
  parseRoomAmenitiesSnapshot,
  type PmsRoomAmenityKey,
  type RoomAmenitiesSnapshot,
} from "./roomAmenities.js";
import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parseRoomTypeCapacitySnapshot,
  parseRoomTypeFacts,
  parseRoomTypeFactsSnapshot,
  type RoomFactsCommandAudit,
  type RoomTypeCapacitySnapshot,
  type RoomTypeFacts,
  type RoomTypeFactsSnapshot,
} from "./roomFacts.js";
import { parseReplaceRoomMediaRequest, type RoomMediaAssignment } from "./roomMedia.js";

export const PMS_ROOM_PUBLICATION_CONTRACT_VERSION = "pms-room-publication.v1" as const;
export const PMS_ASSIGN_ROOM_TYPE_MEDIA_OPERATION = "pms.assignRoomTypeMedia" as const;
export const ROOM_PUBLICATION_BLOCKER_CODES = [
  "room_type_required",
  "room_units_required",
  "room_photo_required",
  "room_media_unavailable",
  "room_amenities_review_required",
] as const;
export const ROOM_PUBLIC_MEDIA_VARIANT_NAMES = [
  "original_safe",
  "large",
  "thumbnail",
  "blur_preview",
] as const;

export type AssignRoomTypeMediaCommand = {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly expectedRoomMediaRevision: number;
  readonly assignments: readonly RoomMediaAssignment[];
  readonly idempotencyKey: string;
  readonly audit: RoomFactsCommandAudit;
};

export type AssignRoomTypeMediaError =
  | { readonly code: "setup_scope_unavailable" | "room_type_not_found" }
  | { readonly code: "room_media_revision_conflict"; readonly currentRevision: number }
  | { readonly code: "idempotency_key_conflict" | "command_in_progress" }
  | {
      readonly code: "media_not_found" | "media_not_authorized" | "media_not_ready";
      readonly mediaObjectIds: readonly string[];
    };

export type AssignRoomTypeMediaResponse = {
  readonly contractVersion: typeof PMS_ROOM_PUBLICATION_CONTRACT_VERSION;
  readonly outcome: "assigned";
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomMediaRevision: number;
  readonly assignments: readonly RoomMediaAssignment[];
  readonly acceptedAt: string;
};

export type AssignRoomTypeMediaResult =
  | { readonly ok: true; readonly response: AssignRoomTypeMediaResponse }
  | { readonly ok: false; readonly error: AssignRoomTypeMediaError };

/**
 * The implementation re-authorizes scope before replay and resolves every
 * non-replayed media ID through VAY-1047's HotelMediaResolutionPort before it
 * changes references. Replacing or clearing assignments never deletes shared
 * Platform Media objects.
 */
export type RoomMediaAssignmentCommandPort = {
  assignRoomTypeMedia(command: AssignRoomTypeMediaCommand): Promise<AssignRoomTypeMediaResult>;
};

export type RoomPublicMediaVariantName = (typeof ROOM_PUBLIC_MEDIA_VARIANT_NAMES)[number];
export type RoomPublicMediaVariant = {
  readonly variantName: RoomPublicMediaVariantName;
  readonly publicUrl: string;
};
export type RoomPublicMediaAssignment = RoomMediaAssignment & {
  readonly publicVariants: readonly [RoomPublicMediaVariant, ...RoomPublicMediaVariant[]];
};

export type RoomPublicationMediaSource =
  | {
      readonly outcome: "resolved";
      readonly roomMediaRevision: number;
      readonly projection: RoomMediaProjectionInput;
    }
  | { readonly outcome: "unavailable"; readonly roomMediaRevision: number };

export type RoomPublicationSourceRevisions = {
  readonly roomFactsRevision: number;
  readonly roomUnitsRevision: number;
  readonly roomMediaRevision: number;
  readonly roomAmenitiesRevision: number;
};

export type RoomPublicationRoomSource = {
  readonly roomFacts: RoomTypeFactsSnapshot;
  readonly capacity: RoomTypeCapacitySnapshot;
  readonly media: RoomPublicationMediaSource;
  readonly roomAmenities: RoomAmenitiesSnapshot;
};

export type RoomPublicationSnapshotInput = {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly rooms: readonly RoomPublicationRoomSource[];
};

export type RoomPublicationBlockerCode = (typeof ROOM_PUBLICATION_BLOCKER_CODES)[number];
export type RoomPublicationBlocker = {
  readonly code: RoomPublicationBlockerCode;
  readonly product: "pms";
  readonly ownerDomain: "pms";
  readonly owningStepId: "rooms";
  readonly affectedEntity: {
    readonly entityType: "property" | "room_type";
    readonly entityId: string;
  };
  readonly message: string;
  readonly kind: "user_fixable";
  readonly sourceRevision: string;
};

export type RoomPublicationRoomSnapshot = {
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly facts: RoomTypeFacts;
  readonly activeUnitCount: number;
  readonly media: readonly RoomPublicMediaAssignment[];
  /** Null means untouched; reviewed-empty is represented by an empty array. */
  readonly amenities: readonly PmsRoomAmenityKey[] | null;
  readonly sourceRevisions: RoomPublicationSourceRevisions;
  readonly sourceRevision: string;
};

export type RoomPublicationSnapshot = {
  readonly contractVersion: typeof PMS_ROOM_PUBLICATION_CONTRACT_VERSION;
  readonly propertyId: string;
  readonly status: "ready" | "blocked";
  readonly rooms: readonly RoomPublicationRoomSnapshot[];
  readonly blockers: readonly RoomPublicationBlocker[];
  readonly sourceRevision: string;
};

export type RoomPublicationSnapshotPort = {
  getRoomPublicationSnapshot(input: {
    readonly organizationId: string;
    readonly propertyId: string;
  }): Promise<RoomPublicationSnapshot>;
};

export function parseAssignRoomTypeMediaCommand(value: unknown): AssignRoomTypeMediaCommand | null {
  if (
    !isExactDataRecord(value, [
      "organizationId",
      "propertyId",
      "roomTypeId",
      "expectedRoomMediaRevision",
      "assignments",
      "idempotencyKey",
      "audit",
    ]) ||
    !isUuid(value["organizationId"]) ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"]) ||
    !isTrimmedText(value["idempotencyKey"], 1, 200)
  ) {
    return null;
  }
  const request = parseReplaceRoomMediaRequest({
    expectedRoomMediaRevision: value["expectedRoomMediaRevision"],
    assignments: value["assignments"],
  });
  const audit = parseAudit(value["audit"]);
  return request && audit
    ? Object.freeze({
        organizationId: normalizeUuid(value["organizationId"]),
        propertyId: normalizeUuid(value["propertyId"]),
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        expectedRoomMediaRevision: request.expectedRoomMediaRevision,
        assignments: request.assignments,
        idempotencyKey: value["idempotencyKey"],
        audit,
      })
    : null;
}

export function serializeAssignRoomTypeMediaFingerprint(
  command: AssignRoomTypeMediaCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    expectedRoomMediaRevision: command.expectedRoomMediaRevision,
    assignments: command.assignments.map(({ mediaObjectId, altText, sortOrder }) => ({
      mediaObjectId,
      altText,
      sortOrder,
    })),
  });
}

export function parseAssignRoomTypeMediaResult(value: unknown): AssignRoomTypeMediaResult | null {
  if (!isPlainDataRecord(value)) return null;
  if (value["ok"] === true && isExactDataRecord(value, ["ok", "response"])) {
    const response = parseMediaResponse(value["response"]);
    return response ? Object.freeze({ ok: true as const, response }) : null;
  }
  if (value["ok"] === false && isExactDataRecord(value, ["ok", "error"])) {
    const error = parseMediaError(value["error"]);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  return null;
}

export function serializeRoomPublicationSourceRevision(
  revisions: RoomPublicationSourceRevisions,
  mediaEvidenceFingerprint: string,
): string {
  if (
    !Object.values(revisions).every(isPositiveRevision) ||
    !isTrimmedText(mediaEvidenceFingerprint, 1, 100_000)
  ) {
    throw new TypeError("Room publication source revisions must be positive integers");
  }
  return JSON.stringify([
    revisions.roomFactsRevision,
    revisions.roomUnitsRevision,
    revisions.roomMediaRevision,
    revisions.roomAmenitiesRevision,
    mediaEvidenceFingerprint,
  ]);
}

/** Snapshots and sorts all inputs; equal source state always produces equal output. */
export function createRoomPublicationSnapshot(
  input: RoomPublicationSnapshotInput,
): RoomPublicationSnapshot {
  if (
    !isExactDataRecord(input, ["organizationId", "propertyId", "rooms"]) ||
    !isUuid(input["organizationId"]) ||
    !isUuid(input["propertyId"]) ||
    !isDensePlainArray(input["rooms"])
  ) {
    throw new TypeError("Room publication input is invalid");
  }
  const organizationId = normalizeUuid(input["organizationId"]);
  const propertyId = normalizeUuid(input["propertyId"]);
  const sourceRooms = input["rooms"] as RoomPublicationRoomSource[];
  const roomIds = new Set<string>();
  const rooms = sourceRooms.map((source) => snapshotRoomSource(organizationId, propertyId, source));
  for (const room of rooms) {
    if (roomIds.has(room.snapshot.roomTypeId)) {
      throw new TypeError("Room publication contains a duplicate room type");
    }
    roomIds.add(room.snapshot.roomTypeId);
  }
  rooms.sort((left, right) =>
    compareCodeUnits(left.snapshot.roomTypeId, right.snapshot.roomTypeId),
  );

  const blockers = rooms.flatMap(({ blockers: roomBlockers }) => roomBlockers);
  const sourceRevision = JSON.stringify(
    rooms.map(({ snapshot }) => [snapshot.roomTypeId, snapshot.sourceRevision]),
  );
  if (rooms.length === 0) {
    blockers.push(blocker("room_type_required", "property", propertyId, sourceRevision));
  }
  blockers.sort((left, right) =>
    compareCodeUnits(
      JSON.stringify([left.affectedEntity.entityType, left.affectedEntity.entityId, left.code]),
      JSON.stringify([right.affectedEntity.entityType, right.affectedEntity.entityId, right.code]),
    ),
  );

  return deepFreeze({
    contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
    propertyId,
    status: blockers.length === 0 ? "ready" : "blocked",
    rooms: rooms.map(({ snapshot }) => snapshot),
    blockers,
    sourceRevision,
  });
}

function snapshotRoomSource(
  organizationId: string,
  propertyId: string,
  source: RoomPublicationRoomSource,
): { snapshot: RoomPublicationRoomSnapshot; blockers: RoomPublicationBlocker[] } {
  const roomFacts = parseRoomTypeFactsSnapshot(structuredClone(source.roomFacts));
  const capacity = parseRoomTypeCapacitySnapshot(structuredClone(source.capacity));
  const roomAmenities = parseRoomAmenitiesSnapshot(structuredClone(source.roomAmenities));
  if (
    !roomFacts ||
    roomFacts.contractVersion !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    roomFacts.lifecycle !== "active" ||
    !capacity ||
    !roomAmenities ||
    roomFacts.propertyId !== propertyId ||
    capacity.propertyId !== propertyId ||
    roomAmenities.propertyId !== propertyId ||
    capacity.roomTypeId !== roomFacts.roomTypeId ||
    roomAmenities.roomTypeId !== roomFacts.roomTypeId
  ) {
    throw new TypeError("Room publication source is invalid or outside property scope");
  }
  const media = snapshotMediaSource(organizationId, propertyId, roomFacts.roomTypeId, source.media);
  const sourceRevisions = Object.freeze({
    roomFactsRevision: roomFacts.roomFactsRevision,
    roomUnitsRevision: capacity.roomUnitsRevision,
    roomMediaRevision: media.roomMediaRevision,
    roomAmenitiesRevision: roomAmenities.roomAmenitiesRevision,
  });
  const sourceRevision = serializeRoomPublicationSourceRevision(
    sourceRevisions,
    media.evidenceFingerprint,
  );
  const blockers: RoomPublicationBlocker[] = [];
  if (capacity.activeUnitCount === 0) {
    blockers.push(
      blocker("room_units_required", "room_type", roomFacts.roomTypeId, sourceRevision),
    );
  }
  if (media.assignments === null) {
    blockers.push(
      blocker("room_media_unavailable", "room_type", roomFacts.roomTypeId, sourceRevision),
    );
  } else if (media.assignments.length === 0) {
    blockers.push(
      blocker("room_photo_required", "room_type", roomFacts.roomTypeId, sourceRevision),
    );
  }
  if (!roomAmenities.reviewed) {
    blockers.push(
      blocker("room_amenities_review_required", "room_type", roomFacts.roomTypeId, sourceRevision),
    );
  }
  return {
    snapshot: Object.freeze({
      propertyId,
      roomTypeId: roomFacts.roomTypeId,
      facts: roomFacts.facts,
      activeUnitCount: capacity.activeUnitCount,
      media: media.assignments ?? Object.freeze([]),
      amenities: roomAmenities.reviewed ? roomAmenities.amenities : null,
      sourceRevisions,
      sourceRevision,
    }),
    blockers,
  };
}

type SnapshottedRoomMedia = {
  readonly roomMediaRevision: number;
  readonly assignments: readonly RoomPublicMediaAssignment[] | null;
  readonly evidenceFingerprint: string;
};

function snapshotMediaSource(
  organizationId: string,
  propertyId: string,
  roomTypeId: string,
  value: RoomPublicationMediaSource,
): SnapshottedRoomMedia {
  if (
    isExactDataRecord(value, ["outcome", "roomMediaRevision"]) &&
    value["outcome"] === "unavailable" &&
    isPositiveRevision(value["roomMediaRevision"])
  ) {
    return Object.freeze({
      roomMediaRevision: value["roomMediaRevision"],
      assignments: null,
      evidenceFingerprint: JSON.stringify(["unavailable"]),
    });
  }
  if (
    !isExactDataRecord(value, ["outcome", "roomMediaRevision", "projection"]) ||
    value["outcome"] !== "resolved" ||
    !isPositiveRevision(value["roomMediaRevision"])
  ) {
    throw new TypeError("Room publication media source is invalid");
  }

  // RoomMediaProjectionInput is an opaque VAY-1047 proof. Its private brand is
  // intentionally not copied or inspected here; TypeScript prevents structural
  // construction, while these checks bind the trusted proof to this snapshot.
  const projection = value["projection"] as RoomMediaProjectionInput;
  if (
    projection.ownerOrganizationId !== organizationId ||
    projection.propertyId !== propertyId ||
    projection.roomTypeId !== roomTypeId ||
    projection.roomMediaRevision !== value["roomMediaRevision"]
  ) {
    throw new TypeError("Room publication media proof is outside the snapped room scope");
  }

  const evidenceAssignments: unknown[] = [];
  const assignments = projection.assignments.map((assignment) => {
    const publicVariants = [...assignment.media.publicVariants]
      .sort((left, right) => {
        const byName = compareCodeUnits(left.variantName, right.variantName);
        return byName || compareCodeUnits(left.publicUrl, right.publicUrl);
      })
      .map((variant) =>
        Object.freeze({
          variantName: variant.variantName as RoomPublicMediaVariantName,
          publicUrl: variant.publicUrl,
        }),
      );
    evidenceAssignments.push([
      assignment.media.mediaObjectId,
      assignment.media.purpose,
      assignment.sortOrder,
      assignment.altText,
      publicVariants.map(({ variantName, publicUrl }) => [variantName, publicUrl]),
    ]);
    return Object.freeze({
      mediaObjectId: assignment.media.mediaObjectId,
      altText: assignment.altText,
      sortOrder: assignment.sortOrder,
      publicVariants: Object.freeze(
        publicVariants as [RoomPublicMediaVariant, ...RoomPublicMediaVariant[]],
      ),
    });
  });

  return Object.freeze({
    roomMediaRevision: value["roomMediaRevision"],
    assignments: Object.freeze(assignments),
    evidenceFingerprint: JSON.stringify(["resolved", evidenceAssignments]),
  });
}

function blocker(
  code: RoomPublicationBlockerCode,
  entityType: "property" | "room_type",
  entityId: string,
  sourceRevision: string,
): RoomPublicationBlocker {
  const messages: Record<RoomPublicationBlockerCode, string> = {
    room_type_required: "Add at least one room type before publishing.",
    room_units_required: "Add at least one unit for this room type before publishing.",
    room_photo_required: "Add at least one room photo before publishing.",
    room_media_unavailable: "Review this room's photos before publishing.",
    room_amenities_review_required: "Review this room's amenities before publishing.",
  };
  return Object.freeze({
    code,
    product: "pms",
    ownerDomain: "pms",
    owningStepId: "rooms",
    affectedEntity: Object.freeze({ entityType, entityId }),
    message: messages[code],
    kind: "user_fixable",
    sourceRevision,
  });
}

function parseMediaResponse(value: unknown): AssignRoomTypeMediaResponse | null {
  if (
    !isExactDataRecord(value, [
      "contractVersion",
      "outcome",
      "propertyId",
      "roomTypeId",
      "roomMediaRevision",
      "assignments",
      "acceptedAt",
    ]) ||
    value["contractVersion"] !== PMS_ROOM_PUBLICATION_CONTRACT_VERSION ||
    value["outcome"] !== "assigned" ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"]) ||
    !isIsoDateTime(value["acceptedAt"])
  ) {
    return null;
  }
  const parsed = parseReplaceRoomMediaRequest({
    expectedRoomMediaRevision: value["roomMediaRevision"],
    assignments: value["assignments"],
  });
  return parsed
    ? Object.freeze({
        contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
        outcome: "assigned" as const,
        propertyId: normalizeUuid(value["propertyId"]),
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        roomMediaRevision: parsed.expectedRoomMediaRevision,
        assignments: parsed.assignments,
        acceptedAt: value["acceptedAt"],
      })
    : null;
}

function parseMediaError(value: unknown): AssignRoomTypeMediaError | null {
  if (!isPlainDataRecord(value) || typeof value["code"] !== "string") return null;
  if (
    [
      "setup_scope_unavailable",
      "room_type_not_found",
      "idempotency_key_conflict",
      "command_in_progress",
    ].includes(value["code"])
  ) {
    return isExactDataRecord(value, ["code"])
      ? (Object.freeze({ code: value["code"] }) as AssignRoomTypeMediaError)
      : null;
  }
  if (value["code"] === "room_media_revision_conflict") {
    return isExactDataRecord(value, ["code", "currentRevision"]) &&
      isPositiveRevision(value["currentRevision"])
      ? Object.freeze({ code: value["code"], currentRevision: value["currentRevision"] })
      : null;
  }
  if (
    !["media_not_found", "media_not_authorized", "media_not_ready"].includes(value["code"]) ||
    !isExactDataRecord(value, ["code", "mediaObjectIds"]) ||
    !isDensePlainArray(value["mediaObjectIds"]) ||
    value["mediaObjectIds"].length === 0 ||
    !value["mediaObjectIds"].every(isUuid)
  ) {
    return null;
  }
  const ids = value["mediaObjectIds"].map(normalizeUuid);
  return new Set(ids).size === ids.length
    ? (Object.freeze({
        code: value["code"],
        mediaObjectIds: Object.freeze(ids),
      }) as AssignRoomTypeMediaError)
    : null;
}

function parseAudit(value: unknown): RoomFactsCommandAudit | null {
  if (
    !isExactDataRecord(value, ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !isTrimmedText(value["requestId"], 1, 200) ||
    !(value["correlationId"] === null || isTrimmedText(value["correlationId"], 1, 200)) ||
    !isIsoDateTime(value["requestedAt"])
  ) {
    return null;
  }
  const actor = value["actor"];
  let parsedActor: RoomFactsCommandAudit["actor"] | null = null;
  if (
    isExactDataRecord(actor, ["kind", "userId"]) &&
    actor["kind"] === "user" &&
    isUuid(actor["userId"])
  ) {
    parsedActor = Object.freeze({ kind: "user", userId: normalizeUuid(actor["userId"]) });
  } else if (
    isExactDataRecord(actor, ["kind", "service"]) &&
    actor["kind"] === "system" &&
    isTrimmedText(actor["service"], 1, 100)
  ) {
    parsedActor = Object.freeze({ kind: "system", service: actor["service"] });
  }
  return parsedActor
    ? Object.freeze({
        actor: parsedActor,
        requestId: value["requestId"],
        correlationId: value["correlationId"],
        requestedAt: value["requestedAt"],
      })
    : null;
}

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function isExactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    isPlainDataRecord(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === value.length + 1 &&
    keys.includes("length") &&
    Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function normalizeUuid(value: string): string {
  return value.toLowerCase();
}

function isPositiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
  );
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum && !value.includes("\0");
}

function isTrimmedText(value: unknown, minimum: number, maximum: number): value is string {
  return isText(value, maximum) && value.length >= minimum && value.trim() === value;
}

function isIsoDateTime(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  const canonicalInput = value.includes(".") ? value : value.replace("Z", ".000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === canonicalInput;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  Object.freeze(object);
  return value;
}
