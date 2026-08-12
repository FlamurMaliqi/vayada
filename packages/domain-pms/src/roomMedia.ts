export const ROOM_MEDIA_MAX_ITEMS = 20;
export const ROOM_MEDIA_MAX_ALT_TEXT_LENGTH = 500;

export type RoomMediaAssignment = {
  mediaObjectId: string;
  altText: string | null;
  sortOrder: number;
};

/** Transitional snapshot used while a room still contains pre-Platform-Media URLs. */
export type LegacyRoomMediaSnapshotItem = {
  mediaObjectId: string | null;
  url: string;
  altText: string | null;
  sortOrder: number;
};

export type ReplaceRoomMediaRequest = {
  expectedRoomMediaRevision: number;
  assignments: RoomMediaAssignment[];
  legacyMediaSnapshot?: LegacyRoomMediaSnapshotItem[];
};

export type RoomMediaCommandResponse = {
  outcome: "updated" | "idempotent_replay";
  roomMediaRevision: number;
  assignments: RoomMediaAssignment[];
};

export type RoomMediaCommandError =
  | { code: "room_media_revision_conflict"; currentRevision: number }
  | { code: "idempotency_key_conflict" | "command_in_progress" }
  | {
      code: "media_not_found" | "media_not_authorized" | "media_not_ready";
      mediaObjectIds: string[];
    };

export function parseReplaceRoomMediaRequest(value: unknown): ReplaceRoomMediaRequest | null {
  const hasLegacySnapshot = isPlainDataRecord(value) && Object.hasOwn(value, "legacyMediaSnapshot");
  if (
    !isExactDataRecord(
      value,
      hasLegacySnapshot
        ? ["expectedRoomMediaRevision", "assignments", "legacyMediaSnapshot"]
        : ["expectedRoomMediaRevision", "assignments"],
    ) ||
    !isPositiveRevision(value["expectedRoomMediaRevision"]) ||
    !isDensePlainArray(value["assignments"]) ||
    value["assignments"].length > ROOM_MEDIA_MAX_ITEMS
  ) {
    return null;
  }
  const assignments = value["assignments"].map(parseAssignment);
  if (
    assignments.some((assignment) => assignment === null) ||
    new Set(assignments.map((assignment) => assignment!.mediaObjectId)).size !==
      assignments.length ||
    assignments.some((assignment, index) => assignment!.sortOrder !== index)
  ) {
    return null;
  }
  const legacyMediaSnapshot = hasLegacySnapshot
    ? parseLegacyMediaSnapshot(value["legacyMediaSnapshot"], assignments)
    : undefined;
  if (hasLegacySnapshot && !legacyMediaSnapshot) return null;
  return Object.freeze({
    expectedRoomMediaRevision: value["expectedRoomMediaRevision"] as number,
    assignments: Object.freeze(
      assignments as RoomMediaAssignment[],
    ) as unknown as RoomMediaAssignment[],
    ...(legacyMediaSnapshot ? { legacyMediaSnapshot } : {}),
  });
}

export function parseRoomMediaCommandResponse(value: unknown): RoomMediaCommandResponse | null {
  if (
    !isExactDataRecord(value, ["outcome", "roomMediaRevision", "assignments"]) ||
    !["updated", "idempotent_replay"].includes(value["outcome"] as string) ||
    !isPositiveRevision(value["roomMediaRevision"]) ||
    !isDensePlainArray(value["assignments"])
  ) {
    return null;
  }
  const request = parseReplaceRoomMediaRequest({
    expectedRoomMediaRevision: value["roomMediaRevision"],
    assignments: value["assignments"],
  });
  return request
    ? Object.freeze({
        outcome: value["outcome"] as RoomMediaCommandResponse["outcome"],
        roomMediaRevision: request.expectedRoomMediaRevision,
        assignments: request.assignments,
      })
    : null;
}

export function parseRoomMediaCommandError(value: unknown): RoomMediaCommandError | null {
  if (!isPlainDataRecord(value) || typeof value["code"] !== "string") return null;
  if (value["code"] === "room_media_revision_conflict") {
    return isExactDataRecord(value, ["code", "currentRevision"]) &&
      isPositiveRevision(value["currentRevision"])
      ? Object.freeze({
          code: "room_media_revision_conflict",
          currentRevision: value["currentRevision"] as number,
        })
      : null;
  }
  if (["idempotency_key_conflict", "command_in_progress"].includes(value["code"])) {
    return isExactDataRecord(value, ["code"])
      ? Object.freeze({
          code: value["code"] as "idempotency_key_conflict" | "command_in_progress",
        })
      : null;
  }
  if (
    !["media_not_found", "media_not_authorized", "media_not_ready"].includes(value["code"]) ||
    !isExactDataRecord(value, ["code", "mediaObjectIds"]) ||
    !isUniqueUuidArray(value["mediaObjectIds"])
  ) {
    return null;
  }
  return Object.freeze({
    code: value["code"] as "media_not_found" | "media_not_authorized" | "media_not_ready",
    mediaObjectIds: Object.freeze(
      value["mediaObjectIds"].map((id) => id.toLowerCase()),
    ) as unknown as string[],
  });
}

function parseAssignment(value: unknown): RoomMediaAssignment | null {
  if (
    !isExactDataRecord(value, ["mediaObjectId", "altText", "sortOrder"]) ||
    !isUuid(value["mediaObjectId"]) ||
    !isValidAltText(value["altText"]) ||
    !isNonNegativeInteger(value["sortOrder"])
  ) {
    return null;
  }
  return Object.freeze({
    mediaObjectId: value["mediaObjectId"].toLowerCase(),
    altText: value["altText"],
    sortOrder: value["sortOrder"],
  });
}

function parseLegacyMediaSnapshot(
  value: unknown,
  assignments: readonly (RoomMediaAssignment | null)[],
): LegacyRoomMediaSnapshotItem[] | null {
  if (!isDensePlainArray(value) || value.length > ROOM_MEDIA_MAX_ITEMS) return null;
  const items = value.map((item, index): LegacyRoomMediaSnapshotItem | null => {
    if (
      !isExactDataRecord(item, ["mediaObjectId", "url", "altText", "sortOrder"]) ||
      (item["mediaObjectId"] !== null && !isUuid(item["mediaObjectId"])) ||
      !isSafeHttpUrl(item["url"]) ||
      !isValidAltText(item["altText"]) ||
      item["sortOrder"] !== index
    ) {
      return null;
    }
    return Object.freeze({
      mediaObjectId: item["mediaObjectId"] === null ? null : item["mediaObjectId"].toLowerCase(),
      url: item["url"],
      altText: item["altText"],
      sortOrder: index,
    });
  });
  if (items.some((item) => item === null)) return null;
  const parsed = items as LegacyRoomMediaSnapshotItem[];
  if (!parsed.some(({ mediaObjectId }) => mediaObjectId === null)) return null;
  const canonicalItems = parsed.filter(({ mediaObjectId }) => mediaObjectId !== null);
  if (
    canonicalItems.length !== assignments.length ||
    canonicalItems.some(
      (item, index) =>
        item.mediaObjectId !== assignments[index]?.mediaObjectId ||
        item.altText !== assignments[index]?.altText,
    )
  ) {
    return null;
  }
  return Object.freeze(parsed) as unknown as LegacyRoomMediaSnapshotItem[];
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isUniqueUuidArray(value: unknown): value is string[] {
  return (
    isDensePlainArray(value) &&
    value.length > 0 &&
    value.every(isUuid) &&
    new Set(value.map((id) => id.toLowerCase())).size === value.length
  );
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
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  return Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isValidAltText(value: unknown): value is string | null {
  return (
    value === null || (typeof value === "string" && value.length <= ROOM_MEDIA_MAX_ALT_TEXT_LENGTH)
  );
}

function isPositiveRevision(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_647
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647
  );
}
