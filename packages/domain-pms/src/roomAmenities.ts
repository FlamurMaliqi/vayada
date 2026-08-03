import type { RoomFactsCommandAudit } from "./roomFacts.js";

export const PMS_ROOM_AMENITIES_CONTRACT_VERSION = "pms-room-amenities.v1" as const;
export const PMS_CONFIRM_ROOM_TYPE_AMENITIES_OPERATION = "pms.confirmRoomTypeAmenities" as const;
export const ROOM_AMENITIES_MAX_ITEMS = 100;

const ROOM_AMENITY_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ROOM_AMENITY_KEY_MAX_LENGTH = 80;

declare const pmsRoomAmenityKeyBrand: unique symbol;

export type PmsRoomAmenityKey = string & { readonly [pmsRoomAmenityKeyBrand]: true };

export type ConfirmRoomTypeAmenitiesCommand = {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly expectedRoomAmenitiesRevision: number;
  readonly amenities: readonly PmsRoomAmenityKey[];
  readonly idempotencyKey: string;
  readonly audit: RoomFactsCommandAudit;
};

export type RoomAmenitiesSnapshot = {
  readonly contractVersion: typeof PMS_ROOM_AMENITIES_CONTRACT_VERSION;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomAmenitiesRevision: number;
  readonly reviewed: boolean;
  readonly amenities: readonly PmsRoomAmenityKey[];
  readonly reviewedAt: string | null;
};

export type RoomAmenityVocabularyValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "unsupported_room_amenity_keys";
        readonly unsupportedAmenityKeys: readonly PmsRoomAmenityKey[];
      };
    };

/** PMS-owned membership check. Shape parsing alone never approves an amenity key. */
export type RoomAmenityVocabularyValidationPort = {
  validateRoomAmenities(
    amenities: readonly PmsRoomAmenityKey[],
  ): Promise<RoomAmenityVocabularyValidationResult>;
};

export type ConfirmRoomTypeAmenitiesError =
  | { readonly code: "setup_scope_unavailable" | "room_type_not_found" }
  | {
      readonly code: "room_amenities_revision_conflict";
      readonly currentRevision: number;
    }
  | {
      readonly code: "unsupported_room_amenity_keys";
      readonly unsupportedAmenityKeys: readonly PmsRoomAmenityKey[];
    }
  | { readonly code: "idempotency_key_conflict" | "command_in_progress" };

export type ConfirmRoomTypeAmenitiesResponse = {
  readonly contractVersion: typeof PMS_ROOM_AMENITIES_CONTRACT_VERSION;
  readonly outcome: "confirmed";
  readonly roomAmenities: RoomAmenitiesSnapshot & { readonly reviewed: true };
  readonly acceptedAt: string;
};

export type ConfirmRoomTypeAmenitiesResult =
  | { readonly ok: true; readonly response: ConfirmRoomTypeAmenitiesResponse }
  | { readonly ok: false; readonly error: ConfirmRoomTypeAmenitiesError };

/**
 * Implementations re-authorize organization/property/room scope before replay,
 * validate vocabulary membership, and commit the revision, review evidence,
 * idempotency result, and product audit atomically. Exact retries replay the
 * stored result; changing any fingerprint field under the same key conflicts.
 */
export type RoomAmenitiesCommandPort = {
  confirmRoomTypeAmenities(
    command: ConfirmRoomTypeAmenitiesCommand,
  ): Promise<ConfirmRoomTypeAmenitiesResult>;
};

export function parsePmsRoomAmenityKey(value: unknown): PmsRoomAmenityKey | null {
  return typeof value === "string" &&
    value.length <= ROOM_AMENITY_KEY_MAX_LENGTH &&
    ROOM_AMENITY_KEY_PATTERN.test(value)
    ? (value as PmsRoomAmenityKey)
    : null;
}

export function parseConfirmRoomTypeAmenitiesCommand(
  value: unknown,
): ConfirmRoomTypeAmenitiesCommand | null {
  if (
    !isExactDataRecord(value, [
      "organizationId",
      "propertyId",
      "roomTypeId",
      "expectedRoomAmenitiesRevision",
      "amenities",
      "idempotencyKey",
      "audit",
    ]) ||
    !isUuid(value["organizationId"]) ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"]) ||
    !isPositiveRevision(value["expectedRoomAmenitiesRevision"]) ||
    !isTrimmedText(value["idempotencyKey"], 1, 200)
  ) {
    return null;
  }
  const amenities = parseAmenities(value["amenities"]);
  const audit = parseAudit(value["audit"]);
  return amenities && audit
    ? Object.freeze({
        organizationId: normalizeUuid(value["organizationId"]),
        propertyId: normalizeUuid(value["propertyId"]),
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        expectedRoomAmenitiesRevision: value["expectedRoomAmenitiesRevision"],
        amenities,
        idempotencyKey: value["idempotencyKey"],
        audit,
      })
    : null;
}

/** Stable set fingerprint: amenity order is canonicalized before serialization. */
export function serializeConfirmRoomTypeAmenitiesFingerprint(
  command: ConfirmRoomTypeAmenitiesCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    expectedRoomAmenitiesRevision: command.expectedRoomAmenitiesRevision,
    amenities: [...command.amenities].sort(),
  });
}

export function parseRoomAmenitiesSnapshot(value: unknown): RoomAmenitiesSnapshot | null {
  if (
    !isExactDataRecord(value, [
      "contractVersion",
      "propertyId",
      "roomTypeId",
      "roomAmenitiesRevision",
      "reviewed",
      "amenities",
      "reviewedAt",
    ]) ||
    value["contractVersion"] !== PMS_ROOM_AMENITIES_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"]) ||
    !isPositiveRevision(value["roomAmenitiesRevision"]) ||
    typeof value["reviewed"] !== "boolean"
  ) {
    return null;
  }
  const amenities = parseAmenities(value["amenities"]);
  if (!amenities) return null;
  if (value["reviewed"] === false && value["reviewedAt"] !== null) {
    return null;
  }
  if (
    value["reviewed"] === true &&
    (value["roomAmenitiesRevision"] < 2 || !isIsoDateTime(value["reviewedAt"]))
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
    propertyId: normalizeUuid(value["propertyId"]),
    roomTypeId: normalizeUuid(value["roomTypeId"]),
    roomAmenitiesRevision: value["roomAmenitiesRevision"],
    reviewed: value["reviewed"],
    amenities,
    reviewedAt: value["reviewedAt"] as string | null,
  });
}

export function parseConfirmRoomTypeAmenitiesResult(
  value: unknown,
): ConfirmRoomTypeAmenitiesResult | null {
  if (!isPlainDataRecord(value)) return null;
  if (value["ok"] === true && isExactDataRecord(value, ["ok", "response"])) {
    const response = parseConfirmResponse(value["response"]);
    return response ? Object.freeze({ ok: true as const, response }) : null;
  }
  if (value["ok"] === false && isExactDataRecord(value, ["ok", "error"])) {
    const error = parseConfirmError(value["error"]);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  return null;
}

function parseConfirmResponse(value: unknown): ConfirmRoomTypeAmenitiesResponse | null {
  if (
    !isExactDataRecord(value, ["contractVersion", "outcome", "roomAmenities", "acceptedAt"]) ||
    value["contractVersion"] !== PMS_ROOM_AMENITIES_CONTRACT_VERSION ||
    value["outcome"] !== "confirmed" ||
    !isIsoDateTime(value["acceptedAt"])
  ) {
    return null;
  }
  const roomAmenities = parseRoomAmenitiesSnapshot(value["roomAmenities"]);
  return roomAmenities?.reviewed
    ? Object.freeze({
        contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
        outcome: "confirmed" as const,
        roomAmenities: roomAmenities as RoomAmenitiesSnapshot & { readonly reviewed: true },
        acceptedAt: value["acceptedAt"],
      })
    : null;
}

function parseConfirmError(value: unknown): ConfirmRoomTypeAmenitiesError | null {
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
      ? (Object.freeze({ code: value["code"] }) as ConfirmRoomTypeAmenitiesError)
      : null;
  }
  if (value["code"] === "room_amenities_revision_conflict") {
    return isExactDataRecord(value, ["code", "currentRevision"]) &&
      isPositiveRevision(value["currentRevision"])
      ? Object.freeze({ code: value["code"], currentRevision: value["currentRevision"] })
      : null;
  }
  if (
    value["code"] !== "unsupported_room_amenity_keys" ||
    !isExactDataRecord(value, ["code", "unsupportedAmenityKeys"])
  ) {
    return null;
  }
  const unsupportedAmenityKeys = parseAmenities(value["unsupportedAmenityKeys"]);
  return unsupportedAmenityKeys && unsupportedAmenityKeys.length > 0
    ? Object.freeze({ code: value["code"], unsupportedAmenityKeys })
    : null;
}

function parseAmenities(value: unknown): readonly PmsRoomAmenityKey[] | null {
  if (!isDensePlainArray(value) || value.length > ROOM_AMENITIES_MAX_ITEMS) return null;
  const amenities = value.map(parsePmsRoomAmenityKey);
  if (amenities.some((amenity) => amenity === null)) return null;
  const parsed = amenities as PmsRoomAmenityKey[];
  if (new Set(parsed).size !== parsed.length) return null;
  return Object.freeze([...parsed].sort());
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

function isTrimmedText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.trim() === value &&
    !value.includes("\0")
  );
}

function isPositiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
  );
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
