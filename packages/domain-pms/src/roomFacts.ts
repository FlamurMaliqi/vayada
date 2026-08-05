export const PMS_ROOM_FACTS_CONTRACT_VERSION = "pms-room-facts.v1" as const;

export const ROOM_TYPE_DELETE_BLOCKER_CODES = [
  "published_reference",
  "booking_reference",
  "assigned_physical_unit",
  "verified_physical_unit",
  "rate_plan_or_rule",
  "calendar_or_inventory",
  "room_block",
  "channel_mapping",
  "other_operational_reference",
  "reference_check_unavailable",
] as const;

const ROOM_FACT_KEY_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ROOM_FACT_KEY_MAX_LENGTH = 80;
const DRAFT_ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

declare const pmsRoomCategoryKeyBrand: unique symbol;
declare const pmsRoomBedTypeKeyBrand: unique symbol;
declare const draftRoomIdBrand: unique symbol;

export type PmsRoomFactsContractVersion = typeof PMS_ROOM_FACTS_CONTRACT_VERSION;
/** Stable key syntax only; supported membership comes from RoomFactsVocabularyValidationPort. */
export type PmsRoomCategoryKey = string & { readonly [pmsRoomCategoryKeyBrand]: true };
/** Stable key syntax only; supported membership comes from RoomFactsVocabularyValidationPort. */
export type PmsRoomBedTypeKey = string & { readonly [pmsRoomBedTypeKeyBrand]: true };
export type DraftRoomId = string & { readonly [draftRoomIdBrand]: true };
export type RoomTypeDeleteBlockerCode = (typeof ROOM_TYPE_DELETE_BLOCKER_CODES)[number];

export type RoomBed = {
  readonly type: PmsRoomBedTypeKey;
  readonly quantity: number;
};

export type RoomOccupancy = {
  readonly maxGuests: number;
  readonly maxAdults: number;
  readonly maxChildren: number;
};

export type RoomSize = {
  readonly value: number;
  readonly unit: "sqm";
};

/**
 * PMS-owned public room facts. Unit count, media, amenities, pricing, and
 * calendar inputs deliberately belong to separate commands.
 */
export type RoomTypeFacts = {
  readonly name: string;
  readonly description: string;
  readonly category: PmsRoomCategoryKey | null;
  readonly occupancy: RoomOccupancy;
  readonly beds: readonly RoomBed[];
  readonly bedrooms: number | null;
  readonly bathrooms: number | null;
  readonly bathroomType: "private" | "shared";
  readonly size: RoomSize | null;
};

export type RoomFactsCommandAudit = {
  readonly actor:
    | { readonly kind: "user"; readonly userId: string }
    | { readonly kind: "system"; readonly service: string };
  readonly requestId: string;
  readonly correlationId: string | null;
  readonly requestedAt: string;
};

export type RoomFactsCommandContext = {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly idempotencyKey: string;
  readonly audit: RoomFactsCommandAudit;
};

export type CreateRoomTypeFactsCommand = RoomFactsCommandContext & {
  readonly draftRoomId: DraftRoomId;
  readonly expectedRevision: 0;
  readonly facts: RoomTypeFacts;
};

export type UpdateRoomTypeFactsCommand = RoomFactsCommandContext & {
  readonly roomTypeId: string;
  readonly expectedRevision: number;
  readonly facts: RoomTypeFacts;
};

export type SafeDeleteRoomTypeCommand = RoomFactsCommandContext & {
  readonly roomTypeId: string;
  readonly expectedRevision: number;
};

export type RoomTypeFactsSnapshot = {
  readonly contractVersion: PmsRoomFactsContractVersion;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomFactsRevision: number;
  readonly lifecycle: "active" | "inactive";
  readonly facts: RoomTypeFacts;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type PhysicalRoomUnitIdentityBase = {
  readonly contractVersion: PmsRoomFactsContractVersion;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomUnitId: string;
  /** Identity lifecycle is independent from operational availability. */
  readonly lifecycle: "active" | "retired";
};

export type PhysicalRoomUnitIdentity = PhysicalRoomUnitIdentityBase &
  (
    | {
        readonly operationalLabel: string | null;
        readonly operationalLabelStatus: "unverified";
      }
    | { readonly operationalLabel: string; readonly operationalLabelStatus: "verified" }
  );

/**
 * Reconciliation/write behavior belongs to ONB-12; this snapshot is downstream-read-only.
 * activeUnitCount includes every non-retired physical unit, independent of
 * label verification and operational availability.
 */
export type RoomTypeCapacitySnapshot = {
  readonly contractVersion: PmsRoomFactsContractVersion;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomUnitsRevision: number;
  readonly activeUnitCount: number;
  readonly capturedAt: string;
};

type CountedRoomTypeDeleteBlockerCode = Exclude<
  RoomTypeDeleteBlockerCode,
  "reference_check_unavailable"
>;

export type RoomTypeDeleteBlocker =
  | { readonly code: CountedRoomTypeDeleteBlockerCode; readonly affectedCount: number }
  | { readonly code: "reference_check_unavailable" };

type RoomFactsCommandCoordinationError = {
  readonly code: "idempotency_key_conflict" | "command_in_progress";
};

export type RoomFactsCommandScopeError = {
  readonly code: "setup_scope_unavailable";
};

export type UnsupportedRoomFactsVocabularyError = {
  readonly code: "unsupported_room_fact_keys";
  /** Empty or one item because room facts carry at most one category. */
  readonly unsupportedCategoryKeys: readonly PmsRoomCategoryKey[];
  readonly unsupportedBedTypeKeys: readonly PmsRoomBedTypeKey[];
};

export type RoomFactsVocabularyValidationRequest = {
  readonly category: PmsRoomCategoryKey | null;
  readonly bedTypeKeys: readonly PmsRoomBedTypeKey[];
};

export type RoomFactsVocabularyValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: UnsupportedRoomFactsVocabularyError };

/**
 * Required PMS-owned membership check before create/update persistence. Shape
 * parsing alone never authorizes an arbitrary category or bed key.
 */
export type RoomFactsVocabularyValidationPort = {
  validateRoomFactsVocabulary(
    request: RoomFactsVocabularyValidationRequest,
  ): Promise<RoomFactsVocabularyValidationResult>;
};

export type CreateRoomTypeFactsError =
  | { readonly code: "room_type_name_conflict" }
  | {
      readonly code: "draft_room_binding_conflict";
      readonly roomTypeId: string;
      readonly currentRevision: number;
    }
  | UnsupportedRoomFactsVocabularyError
  | RoomFactsCommandScopeError
  | RoomFactsCommandCoordinationError;

export type UpdateRoomTypeFactsError =
  | { readonly code: "room_type_not_found" | "room_type_name_conflict" }
  | { readonly code: "room_facts_revision_conflict"; readonly currentRevision: number }
  | UnsupportedRoomFactsVocabularyError
  | RoomFactsCommandScopeError
  | RoomFactsCommandCoordinationError;

export type SafeDeleteRoomTypeError =
  | { readonly code: "room_type_not_found" }
  | { readonly code: "room_facts_revision_conflict"; readonly currentRevision: number }
  | {
      readonly code: "room_type_delete_blocked";
      readonly currentRevision: number;
      readonly blockers: readonly RoomTypeDeleteBlocker[];
    }
  | RoomFactsCommandScopeError
  | RoomFactsCommandCoordinationError;

export type RoomFactsCommandError =
  | CreateRoomTypeFactsError
  | UpdateRoomTypeFactsError
  | SafeDeleteRoomTypeError;

export type DraftRoomTypeBinding = {
  readonly propertyId: string;
  readonly draftRoomId: DraftRoomId;
  readonly roomTypeId: string;
};

export type CreateRoomTypeFactsResponse = {
  readonly contractVersion: PmsRoomFactsContractVersion;
  readonly outcome: "created";
  /** Newly created active canonical room at roomFactsRevision 1. */
  readonly roomType: RoomTypeFactsSnapshot;
  readonly draftRoomBinding: DraftRoomTypeBinding;
  readonly acceptedAt: string;
};

export type UpdateRoomTypeFactsResponse = {
  readonly contractVersion: PmsRoomFactsContractVersion;
  readonly outcome: "updated";
  /** Active canonical room at command.expectedRevision + 1 (and therefore at least 2). */
  readonly roomType: RoomTypeFactsSnapshot;
  readonly acceptedAt: string;
};

export type SafeDeleteRoomTypeResponse = {
  readonly contractVersion: PmsRoomFactsContractVersion;
  /** Logical removal: the canonical row and draft binding remain as an inactive tombstone. */
  readonly outcome: "deleted";
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly lifecycle: "inactive";
  /** Resulting command.expectedRevision + 1 revision (at least 2) on the tombstone. */
  readonly deletedRevision: number;
  readonly acceptedAt: string;
};

export type RoomFactsCommandResponse =
  | CreateRoomTypeFactsResponse
  | UpdateRoomTypeFactsResponse
  | SafeDeleteRoomTypeResponse;

export type CreateRoomTypeFactsResult =
  | { readonly ok: true; readonly response: CreateRoomTypeFactsResponse }
  | { readonly ok: false; readonly error: CreateRoomTypeFactsError };

export type UpdateRoomTypeFactsResult =
  | { readonly ok: true; readonly response: UpdateRoomTypeFactsResponse }
  | { readonly ok: false; readonly error: UpdateRoomTypeFactsError };

export type SafeDeleteRoomTypeResult =
  | { readonly ok: true; readonly response: SafeDeleteRoomTypeResponse }
  | { readonly ok: false; readonly error: SafeDeleteRoomTypeError };

export type RoomFactsCommandResult =
  | CreateRoomTypeFactsResult
  | UpdateRoomTypeFactsResult
  | SafeDeleteRoomTypeResult;

/**
 * Implementations authorize the organization/property relationship. Under the
 * command transaction/lock, they recheck that setup scope before any
 * idempotency lookup or replay. A scope that can no longer be established fails
 * closed as setup_scope_unavailable without a replay, audit record, idempotency
 * write, or domain write. The fingerprint contains stable business scope,
 * target, input, and expected revision only: organizationId/propertyId,
 * draftRoomId or roomTypeId, expectedRevision, and facts when present. It
 * excludes idempotencyKey, audit, and transport metadata. Facts, completed
 * replay result, audit record, and (for create) draft-room binding commit in one
 * transaction.
 *
 * Conflict precedence is fixed: only the original scoped idempotency key can
 * exact-replay its stored result. That key with changed fingerprint input
 * returns idempotency_key_conflict before binding checks. A new key for an
 * existing property/draftRoomId binding returns draft_room_binding_conflict
 * even when facts match, so it can never create a second canonical room ID.
 * Exact retries add no replay marker.
 *
 * These are synchronous PMS-local commands. They require neither an outbox nor
 * an externally-uncertain status read.
 */
export type RoomFactsCommandPort = {
  /**
   * Creates facts only after RoomFactsVocabularyValidationPort succeeds. It
   * must not create physical units or pricing/calendar state. Success is an
   * active room snapshot at revision 1.
   */
  createRoomTypeFacts(command: CreateRoomTypeFactsCommand): Promise<CreateRoomTypeFactsResult>;
  /**
   * Updates facts only after RoomFactsVocabularyValidationPort succeeds. The
   * repository cross-checks a successful active snapshot at exactly
   * command.expectedRevision + 1; the wire parser also rejects revisions below 2.
   */
  updateRoomTypeFacts(command: UpdateRoomTypeFactsCommand): Promise<UpdateRoomTypeFactsResult>;
  /**
   * Locks the room type and every downstream reference in one transaction.
   * Eligible removal increments roomFactsRevision and transitions the canonical
   * room_types row to inactive while permanently preserving both that tombstone
   * and setup_draft_room_id binding. Eligible unverified/unassigned physical
   * units transition to retired (incrementing roomUnitsRevision when any active
   * units retire), preserving their opaque IDs and reducing activeUnitCount to
   * zero. Only room-media assignment rows are removed; shared media remains.
   * Neither room_types nor physical-unit rows are hard-deleted, so a stale or
   * new-key retry for the original draft cannot create a second canonical ID.
   * The original draft binding stays permanently reserved, while the inactive
   * room releases its human room name for a different draft/new canonical row.
   * The repository cross-checks deletedRevision at exactly
   * command.expectedRevision + 1; the wire parser also rejects revisions below 2.
   */
  safeDeleteRoomType(command: SafeDeleteRoomTypeCommand): Promise<SafeDeleteRoomTypeResult>;
};

export type RoomFactsReadPort = {
  getRoomTypeFacts(propertyId: string, roomTypeId: string): Promise<RoomTypeFactsSnapshot | null>;
  listRoomTypeFacts(propertyId: string): Promise<readonly RoomTypeFactsSnapshot[]>;
};

/**
 * Durable lookup independent of command-idempotency retention. Implementations
 * include bindings whose canonical room type is an inactive tombstone so setup
 * resume can recover the original roomTypeId instead of creating a replacement.
 */
export type DraftRoomTypeBindingReadPort = {
  getDraftRoomTypeBinding(
    propertyId: string,
    draftRoomId: DraftRoomId,
  ): Promise<DraftRoomTypeBinding | null>;
};

/** Read-only capacity boundary for downstream pricing and calendar lanes. */
export type RoomCapacityReadPort = {
  getRoomTypeCapacity(
    propertyId: string,
    roomTypeId: string,
  ): Promise<RoomTypeCapacitySnapshot | null>;
};

/** Read-only stable-unit identity boundary for downstream room-media and PMS lanes. */
export type PhysicalRoomUnitIdentityReadPort = {
  listPhysicalRoomUnitIdentities(
    propertyId: string,
    roomTypeId: string,
  ): Promise<readonly PhysicalRoomUnitIdentity[]>;
};

/** Parses the setup-draft opaque ID without changing its case-sensitive identity. */
export function parseDraftRoomId(value: unknown): DraftRoomId | null {
  return typeof value === "string" && DRAFT_ROOM_ID_PATTERN.test(value)
    ? (value as DraftRoomId)
    : null;
}

export function parseCreateRoomTypeFactsCommand(value: unknown): CreateRoomTypeFactsCommand | null {
  if (
    !isExactDataRecord(value, [
      "organizationId",
      "propertyId",
      "idempotencyKey",
      "audit",
      "draftRoomId",
      "expectedRevision",
      "facts",
    ])
  ) {
    return null;
  }
  const draftRoomId = parseDraftRoomId(value["draftRoomId"]);
  if (!draftRoomId || value["expectedRevision"] !== 0) return null;
  const context = parseCommandContext(value);
  const facts = parseRoomTypeFacts(value["facts"]);
  return context && facts
    ? Object.freeze({
        ...context,
        draftRoomId,
        expectedRevision: 0 as const,
        facts,
      })
    : null;
}

export function parseUpdateRoomTypeFactsCommand(value: unknown): UpdateRoomTypeFactsCommand | null {
  if (
    !isExactDataRecord(value, [
      "organizationId",
      "propertyId",
      "idempotencyKey",
      "audit",
      "roomTypeId",
      "expectedRevision",
      "facts",
    ]) ||
    !isUuid(value["roomTypeId"]) ||
    !isPositiveRevision(value["expectedRevision"])
  ) {
    return null;
  }
  const context = parseCommandContext(value);
  const facts = parseRoomTypeFacts(value["facts"]);
  return context && facts
    ? Object.freeze({
        ...context,
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        expectedRevision: value["expectedRevision"],
        facts,
      })
    : null;
}

export function parseSafeDeleteRoomTypeCommand(value: unknown): SafeDeleteRoomTypeCommand | null {
  if (
    !isExactDataRecord(value, [
      "organizationId",
      "propertyId",
      "idempotencyKey",
      "audit",
      "roomTypeId",
      "expectedRevision",
    ]) ||
    !isUuid(value["roomTypeId"]) ||
    !isPositiveRevision(value["expectedRevision"])
  ) {
    return null;
  }
  const context = parseCommandContext(value);
  return context
    ? Object.freeze({
        ...context,
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        expectedRevision: value["expectedRevision"],
      })
    : null;
}

/**
 * Serializes the exact stable create fingerprint fields in frozen key order.
 * Hash this returned string; do not add idempotency/audit/transport metadata.
 * Bed rows remain in submitted order; their JSON array order is compatibility-sensitive.
 */
export function serializeCreateRoomTypeFactsFingerprint(
  command: CreateRoomTypeFactsCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    draftRoomId: command.draftRoomId,
    expectedRevision: command.expectedRevision,
    facts: roomTypeFactsFingerprintPayload(command.facts),
  });
}

/**
 * Serializes the exact stable update fingerprint fields in frozen key order.
 * Bed-row JSON array order is compatibility-sensitive and preserved.
 */
export function serializeUpdateRoomTypeFactsFingerprint(
  command: UpdateRoomTypeFactsCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    expectedRevision: command.expectedRevision,
    facts: roomTypeFactsFingerprintPayload(command.facts),
  });
}

/** Serializes the exact stable safe-delete fingerprint fields in frozen key order. */
export function serializeSafeDeleteRoomTypeFingerprint(command: SafeDeleteRoomTypeCommand): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    expectedRevision: command.expectedRevision,
  });
}

export function parseRoomTypeFacts(value: unknown): RoomTypeFacts | null {
  if (
    !isExactDataRecord(value, [
      "name",
      "description",
      "category",
      "occupancy",
      "beds",
      "bedrooms",
      "bathrooms",
      "bathroomType",
      "size",
    ]) ||
    !isTrimmedText(value["name"], 1, 200) ||
    !isText(value["description"], 5_000) ||
    !(value["bedrooms"] === null || isIntegerInRange(value["bedrooms"], 0, 100)) ||
    !(value["bathrooms"] === null || isNumberInRange(value["bathrooms"], Number.EPSILON, 100)) ||
    !isOneOf(value["bathroomType"], ["private", "shared"] as const) ||
    (value["bathroomType"] === "shared" && value["bathrooms"] !== null)
  ) {
    return null;
  }
  // The approved inventory does not define a closed category/bed catalog. This
  // boundary validates stable key shape; a PMS-owned catalog adapter must
  // validate supported membership before persistence once that catalog exists.
  const category =
    value["category"] === null ? null : parseRoomFactKey<PmsRoomCategoryKey>(value["category"]);
  const occupancy = parseOccupancy(value["occupancy"]);
  const beds = parseBeds(value["beds"]);
  const size = value["size"] === null ? null : parseRoomSize(value["size"]);
  if (
    (value["category"] !== null && !category) ||
    !occupancy ||
    !beds ||
    (value["size"] !== null && !size)
  ) {
    return null;
  }
  return Object.freeze({
    name: value["name"],
    description: value["description"],
    category,
    occupancy,
    beds,
    bedrooms: value["bedrooms"],
    bathrooms: value["bathrooms"],
    bathroomType: value["bathroomType"],
    size,
  });
}

export function parseRoomTypeFactsSnapshot(value: unknown): RoomTypeFactsSnapshot | null {
  if (
    !isExactDataRecord(value, [
      "contractVersion",
      "propertyId",
      "roomTypeId",
      "roomFactsRevision",
      "lifecycle",
      "facts",
      "createdAt",
      "updatedAt",
    ]) ||
    value["contractVersion"] !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"]) ||
    !isPositiveRevision(value["roomFactsRevision"]) ||
    !isOneOf(value["lifecycle"], ["active", "inactive"] as const) ||
    !isIsoDateTime(value["createdAt"]) ||
    !isIsoDateTime(value["updatedAt"])
  ) {
    return null;
  }
  const facts = parseRoomTypeFacts(value["facts"]);
  return facts
    ? Object.freeze({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId: normalizeUuid(value["propertyId"]),
        roomTypeId: normalizeUuid(value["roomTypeId"]),
        roomFactsRevision: value["roomFactsRevision"],
        lifecycle: value["lifecycle"],
        facts,
        createdAt: value["createdAt"],
        updatedAt: value["updatedAt"],
      })
    : null;
}

export function parsePhysicalRoomUnitIdentity(value: unknown): PhysicalRoomUnitIdentity | null {
  if (
    !isExactDataRecord(value, [
      "contractVersion",
      "propertyId",
      "roomTypeId",
      "roomUnitId",
      "lifecycle",
      "operationalLabel",
      "operationalLabelStatus",
    ]) ||
    value["contractVersion"] !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"]) ||
    !isUuid(value["roomUnitId"]) ||
    !isOneOf(value["lifecycle"], ["active", "retired"] as const) ||
    !(value["operationalLabel"] === null || isTrimmedText(value["operationalLabel"], 1, 200)) ||
    !isOneOf(value["operationalLabelStatus"], ["unverified", "verified"] as const) ||
    (value["operationalLabelStatus"] === "verified" && value["operationalLabel"] === null)
  ) {
    return null;
  }
  const base = {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId: normalizeUuid(value["propertyId"]),
    roomTypeId: normalizeUuid(value["roomTypeId"]),
    roomUnitId: normalizeUuid(value["roomUnitId"]),
    lifecycle: value["lifecycle"],
  } as const;
  return value["operationalLabelStatus"] === "verified"
    ? Object.freeze({
        ...base,
        operationalLabel: value["operationalLabel"] as string,
        operationalLabelStatus: "verified" as const,
      })
    : Object.freeze({
        ...base,
        operationalLabel: value["operationalLabel"],
        operationalLabelStatus: "unverified" as const,
      });
}

export function parseRoomTypeCapacitySnapshot(value: unknown): RoomTypeCapacitySnapshot | null {
  if (
    !isExactDataRecord(value, [
      "contractVersion",
      "propertyId",
      "roomTypeId",
      "roomUnitsRevision",
      "activeUnitCount",
      "capturedAt",
    ]) ||
    value["contractVersion"] !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"]) ||
    !isPositiveRevision(value["roomUnitsRevision"]) ||
    !isIntegerInRange(value["activeUnitCount"], 0, 500) ||
    !isIsoDateTime(value["capturedAt"])
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId: normalizeUuid(value["propertyId"]),
    roomTypeId: normalizeUuid(value["roomTypeId"]),
    roomUnitsRevision: value["roomUnitsRevision"],
    activeUnitCount: value["activeUnitCount"],
    capturedAt: value["capturedAt"],
  });
}

export function parseCreateRoomTypeFactsResult(value: unknown): CreateRoomTypeFactsResult | null {
  if (!isPlainDataRecord(value)) return null;
  if (value["ok"] === true) {
    if (!isExactDataRecord(value, ["ok", "response"])) return null;
    const response = parseCreateRoomTypeFactsResponse(value["response"]);
    return response ? Object.freeze({ ok: true as const, response }) : null;
  }
  if (value["ok"] === false) {
    if (!isExactDataRecord(value, ["ok", "error"])) return null;
    const error = parseCreateRoomTypeFactsError(value["error"]);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  return null;
}

export function parseUpdateRoomTypeFactsResult(value: unknown): UpdateRoomTypeFactsResult | null {
  if (!isPlainDataRecord(value)) return null;
  if (value["ok"] === true) {
    if (!isExactDataRecord(value, ["ok", "response"])) return null;
    const response = parseUpdateRoomTypeFactsResponse(value["response"]);
    return response ? Object.freeze({ ok: true as const, response }) : null;
  }
  if (value["ok"] === false) {
    if (!isExactDataRecord(value, ["ok", "error"])) return null;
    const error = parseUpdateRoomTypeFactsError(value["error"]);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  return null;
}

export function parseSafeDeleteRoomTypeResult(value: unknown): SafeDeleteRoomTypeResult | null {
  if (!isPlainDataRecord(value)) return null;
  if (value["ok"] === true) {
    if (!isExactDataRecord(value, ["ok", "response"])) return null;
    const response = parseSafeDeleteRoomTypeResponse(value["response"]);
    return response ? Object.freeze({ ok: true as const, response }) : null;
  }
  if (value["ok"] === false) {
    if (!isExactDataRecord(value, ["ok", "error"])) return null;
    const error = parseSafeDeleteRoomTypeError(value["error"]);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  return null;
}

function parseCreateRoomTypeFactsResponse(value: unknown): CreateRoomTypeFactsResponse | null {
  if (
    !isExactDataRecord(value, [
      "contractVersion",
      "outcome",
      "roomType",
      "draftRoomBinding",
      "acceptedAt",
    ]) ||
    value["contractVersion"] !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    value["outcome"] !== "created" ||
    !isIsoDateTime(value["acceptedAt"])
  ) {
    return null;
  }
  const roomType = parseRoomTypeFactsSnapshot(value["roomType"]);
  const draftRoomBinding = parseDraftRoomTypeBinding(value["draftRoomBinding"]);
  if (
    !roomType ||
    roomType.roomFactsRevision !== 1 ||
    roomType.lifecycle !== "active" ||
    !draftRoomBinding ||
    draftRoomBinding.propertyId !== roomType.propertyId ||
    draftRoomBinding.roomTypeId !== roomType.roomTypeId
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    outcome: "created" as const,
    roomType,
    draftRoomBinding,
    acceptedAt: value["acceptedAt"],
  });
}

function parseUpdateRoomTypeFactsResponse(value: unknown): UpdateRoomTypeFactsResponse | null {
  if (
    !isExactDataRecord(value, ["contractVersion", "outcome", "roomType", "acceptedAt"]) ||
    value["contractVersion"] !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    value["outcome"] !== "updated" ||
    !isIsoDateTime(value["acceptedAt"])
  ) {
    return null;
  }
  const roomType = parseRoomTypeFactsSnapshot(value["roomType"]);
  return roomType && roomType.lifecycle === "active" && roomType.roomFactsRevision >= 2
    ? Object.freeze({
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        outcome: "updated" as const,
        roomType,
        acceptedAt: value["acceptedAt"],
      })
    : null;
}

function parseSafeDeleteRoomTypeResponse(value: unknown): SafeDeleteRoomTypeResponse | null {
  if (
    !isExactDataRecord(value, [
      "contractVersion",
      "outcome",
      "propertyId",
      "roomTypeId",
      "lifecycle",
      "deletedRevision",
      "acceptedAt",
    ]) ||
    value["contractVersion"] !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    value["outcome"] !== "deleted" ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"]) ||
    value["lifecycle"] !== "inactive" ||
    !isPositiveRevision(value["deletedRevision"]) ||
    value["deletedRevision"] < 2 ||
    !isIsoDateTime(value["acceptedAt"])
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    outcome: "deleted" as const,
    propertyId: normalizeUuid(value["propertyId"]),
    roomTypeId: normalizeUuid(value["roomTypeId"]),
    lifecycle: "inactive" as const,
    deletedRevision: value["deletedRevision"],
    acceptedAt: value["acceptedAt"],
  });
}

export function parseDraftRoomTypeBinding(value: unknown): DraftRoomTypeBinding | null {
  if (
    !isExactDataRecord(value, ["propertyId", "draftRoomId", "roomTypeId"]) ||
    !isUuid(value["propertyId"]) ||
    !isUuid(value["roomTypeId"])
  ) {
    return null;
  }
  const draftRoomId = parseDraftRoomId(value["draftRoomId"]);
  if (!draftRoomId) return null;
  return Object.freeze({
    propertyId: normalizeUuid(value["propertyId"]),
    draftRoomId,
    roomTypeId: normalizeUuid(value["roomTypeId"]),
  });
}

function parseCreateRoomTypeFactsError(value: unknown): CreateRoomTypeFactsError | null {
  const unavailableScope = parseRoomFactsCommandScopeError(value);
  if (unavailableScope) return unavailableScope;
  const coordination = parseRoomFactsCommandCoordinationError(value);
  if (coordination) return coordination;
  const unsupportedVocabulary = parseUnsupportedRoomFactsVocabularyError(value);
  if (unsupportedVocabulary) return unsupportedVocabulary;
  if (!isPlainDataRecord(value)) return null;
  if (value["code"] === "room_type_name_conflict") {
    return isExactDataRecord(value, ["code"])
      ? Object.freeze({ code: "room_type_name_conflict" as const })
      : null;
  }
  if (
    value["code"] !== "draft_room_binding_conflict" ||
    !isExactDataRecord(value, ["code", "roomTypeId", "currentRevision"]) ||
    !isUuid(value["roomTypeId"]) ||
    !isPositiveRevision(value["currentRevision"])
  ) {
    return null;
  }
  return Object.freeze({
    code: "draft_room_binding_conflict" as const,
    roomTypeId: normalizeUuid(value["roomTypeId"]),
    currentRevision: value["currentRevision"],
  });
}

function parseUpdateRoomTypeFactsError(value: unknown): UpdateRoomTypeFactsError | null {
  const unavailableScope = parseRoomFactsCommandScopeError(value);
  if (unavailableScope) return unavailableScope;
  const coordination = parseRoomFactsCommandCoordinationError(value);
  if (coordination) return coordination;
  const unsupportedVocabulary = parseUnsupportedRoomFactsVocabularyError(value);
  if (unsupportedVocabulary) return unsupportedVocabulary;
  if (!isPlainDataRecord(value)) return null;
  if (isOneOf(value["code"], ["room_type_not_found", "room_type_name_conflict"] as const)) {
    return isExactDataRecord(value, ["code"]) ? Object.freeze({ code: value["code"] }) : null;
  }
  if (
    value["code"] !== "room_facts_revision_conflict" ||
    !isExactDataRecord(value, ["code", "currentRevision"]) ||
    !isPositiveRevision(value["currentRevision"])
  ) {
    return null;
  }
  return Object.freeze({
    code: "room_facts_revision_conflict" as const,
    currentRevision: value["currentRevision"],
  });
}

function parseSafeDeleteRoomTypeError(value: unknown): SafeDeleteRoomTypeError | null {
  const unavailableScope = parseRoomFactsCommandScopeError(value);
  if (unavailableScope) return unavailableScope;
  const coordination = parseRoomFactsCommandCoordinationError(value);
  if (coordination) return coordination;
  if (!isPlainDataRecord(value)) return null;
  if (value["code"] === "room_type_not_found") {
    return isExactDataRecord(value, ["code"])
      ? Object.freeze({ code: "room_type_not_found" as const })
      : null;
  }
  if (value["code"] === "room_facts_revision_conflict") {
    return isExactDataRecord(value, ["code", "currentRevision"]) &&
      isPositiveRevision(value["currentRevision"])
      ? Object.freeze({
          code: "room_facts_revision_conflict" as const,
          currentRevision: value["currentRevision"],
        })
      : null;
  }
  if (
    value["code"] !== "room_type_delete_blocked" ||
    !isExactDataRecord(value, ["code", "currentRevision", "blockers"]) ||
    !isPositiveRevision(value["currentRevision"])
  ) {
    return null;
  }
  const blockers = parseRoomTypeDeleteBlockers(value["blockers"]);
  return blockers
    ? Object.freeze({
        code: "room_type_delete_blocked" as const,
        currentRevision: value["currentRevision"],
        blockers,
      })
    : null;
}

function parseRoomFactsCommandCoordinationError(
  value: unknown,
): RoomFactsCommandCoordinationError | null {
  return isExactDataRecord(value, ["code"]) &&
    isOneOf(value["code"], ["idempotency_key_conflict", "command_in_progress"] as const)
    ? Object.freeze({ code: value["code"] })
    : null;
}

function parseRoomFactsCommandScopeError(value: unknown): RoomFactsCommandScopeError | null {
  return isExactDataRecord(value, ["code"]) && value["code"] === "setup_scope_unavailable"
    ? Object.freeze({ code: "setup_scope_unavailable" as const })
    : null;
}

function parseUnsupportedRoomFactsVocabularyError(
  value: unknown,
): UnsupportedRoomFactsVocabularyError | null {
  if (
    !isExactDataRecord(value, ["code", "unsupportedCategoryKeys", "unsupportedBedTypeKeys"]) ||
    value["code"] !== "unsupported_room_fact_keys" ||
    !isDensePlainArray(value["unsupportedCategoryKeys"]) ||
    value["unsupportedCategoryKeys"].length > 1 ||
    !isDensePlainArray(value["unsupportedBedTypeKeys"]) ||
    value["unsupportedBedTypeKeys"].length > 20
  ) {
    return null;
  }
  const unsupportedCategoryKeys = value["unsupportedCategoryKeys"].map((key) =>
    parseRoomFactKey<PmsRoomCategoryKey>(key),
  );
  const unsupportedBedTypeKeys = value["unsupportedBedTypeKeys"].map((key) =>
    parseRoomFactKey<PmsRoomBedTypeKey>(key),
  );
  if (
    unsupportedCategoryKeys.some((key) => key === null) ||
    unsupportedBedTypeKeys.some((key) => key === null) ||
    unsupportedCategoryKeys.length + unsupportedBedTypeKeys.length === 0
  ) {
    return null;
  }
  const categories = unsupportedCategoryKeys as PmsRoomCategoryKey[];
  const beds = unsupportedBedTypeKeys as PmsRoomBedTypeKey[];
  if (new Set(beds).size !== beds.length) return null;
  return Object.freeze({
    code: "unsupported_room_fact_keys" as const,
    unsupportedCategoryKeys: Object.freeze(categories),
    unsupportedBedTypeKeys: Object.freeze(beds),
  });
}

function parseRoomTypeDeleteBlockers(value: unknown): readonly RoomTypeDeleteBlocker[] | null {
  if (
    !isDensePlainArray(value) ||
    value.length < 1 ||
    value.length > ROOM_TYPE_DELETE_BLOCKER_CODES.length
  ) {
    return null;
  }
  const blockers: RoomTypeDeleteBlocker[] = [];
  for (const entry of value) {
    if (!isPlainDataRecord(entry) || !isOneOf(entry["code"], ROOM_TYPE_DELETE_BLOCKER_CODES)) {
      return null;
    }
    if (entry["code"] === "reference_check_unavailable") {
      if (!isExactDataRecord(entry, ["code"])) return null;
      blockers.push(Object.freeze({ code: "reference_check_unavailable" as const }));
      continue;
    }
    if (
      !isExactDataRecord(entry, ["code", "affectedCount"]) ||
      !isIntegerInRange(entry["affectedCount"], 1, 2_147_483_647)
    ) {
      return null;
    }
    blockers.push(Object.freeze({ code: entry["code"], affectedCount: entry["affectedCount"] }));
  }
  if (new Set(blockers.map(({ code }) => code)).size !== blockers.length) return null;
  return Object.freeze(blockers);
}

function parseCommandContext(value: Record<string, unknown>): RoomFactsCommandContext | null {
  if (
    !isUuid(value["organizationId"]) ||
    !isUuid(value["propertyId"]) ||
    !isTrimmedText(value["idempotencyKey"], 1, 200)
  ) {
    return null;
  }
  const audit = parseCommandAudit(value["audit"]);
  return audit
    ? Object.freeze({
        organizationId: normalizeUuid(value["organizationId"]),
        propertyId: normalizeUuid(value["propertyId"]),
        idempotencyKey: value["idempotencyKey"],
        audit,
      })
    : null;
}

function parseCommandAudit(value: unknown): RoomFactsCommandAudit | null {
  if (
    !isExactDataRecord(value, ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !isTrimmedText(value["requestId"], 1, 200) ||
    !(value["correlationId"] === null || isTrimmedText(value["correlationId"], 1, 200)) ||
    !isIsoDateTime(value["requestedAt"])
  ) {
    return null;
  }
  const actor = parseCommandActor(value["actor"]);
  return actor
    ? Object.freeze({
        actor,
        requestId: value["requestId"],
        correlationId: value["correlationId"],
        requestedAt: value["requestedAt"],
      })
    : null;
}

function parseCommandActor(value: unknown): RoomFactsCommandAudit["actor"] | null {
  if (!isPlainDataRecord(value) || !isOneOf(value["kind"], ["user", "system"] as const)) {
    return null;
  }
  if (value["kind"] === "user") {
    return isExactDataRecord(value, ["kind", "userId"]) && isUuid(value["userId"])
      ? Object.freeze({ kind: "user" as const, userId: normalizeUuid(value["userId"]) })
      : null;
  }
  return isExactDataRecord(value, ["kind", "service"]) && isTrimmedText(value["service"], 1, 100)
    ? Object.freeze({ kind: "system" as const, service: value["service"] })
    : null;
}

function parseOccupancy(value: unknown): RoomOccupancy | null {
  if (
    !isExactDataRecord(value, ["maxGuests", "maxAdults", "maxChildren"]) ||
    !isIntegerInRange(value["maxGuests"], 1, 100) ||
    !isIntegerInRange(value["maxAdults"], 1, value["maxGuests"]) ||
    !isIntegerInRange(value["maxChildren"], 0, value["maxGuests"]) ||
    value["maxAdults"] + value["maxChildren"] < value["maxGuests"]
  ) {
    return null;
  }
  return Object.freeze({
    maxGuests: value["maxGuests"],
    maxAdults: value["maxAdults"],
    maxChildren: value["maxChildren"],
  });
}

function parseBeds(value: unknown): readonly RoomBed[] | null {
  if (!isDensePlainArray(value) || value.length < 1 || value.length > 20) return null;
  const beds = value.map((entry): RoomBed | null => {
    if (!isExactDataRecord(entry, ["type", "quantity"])) return null;
    const type = parseRoomFactKey<PmsRoomBedTypeKey>(entry["type"]);
    if (!type || !isIntegerInRange(entry["quantity"], 1, 20)) {
      return null;
    }
    return Object.freeze({ type, quantity: entry["quantity"] });
  });
  if (beds.some((bed) => bed === null)) return null;
  const parsed = beds as RoomBed[];
  if (new Set(parsed.map((bed) => bed.type)).size !== parsed.length) return null;
  return Object.freeze(parsed);
}

function parseRoomSize(value: unknown): RoomSize | null {
  return isExactDataRecord(value, ["value", "unit"]) &&
    isNumberInRange(value["value"], Number.EPSILON, 100_000) &&
    value["unit"] === "sqm"
    ? Object.freeze({ value: value["value"], unit: "sqm" as const })
    : null;
}

function roomTypeFactsFingerprintPayload(facts: RoomTypeFacts) {
  return {
    name: facts.name,
    description: facts.description,
    category: facts.category,
    occupancy: {
      maxGuests: facts.occupancy.maxGuests,
      maxAdults: facts.occupancy.maxAdults,
      maxChildren: facts.occupancy.maxChildren,
    },
    beds: facts.beds.map(({ type, quantity }) => ({ type, quantity })),
    bedrooms: facts.bedrooms,
    bathrooms: facts.bathrooms,
    bathroomType: facts.bathroomType,
    size: facts.size === null ? null : { value: facts.size.value, unit: facts.size.unit },
  };
}

function parseRoomFactKey<T extends string>(value: unknown): T | null {
  return typeof value === "string" &&
    value.length <= ROOM_FACT_KEY_MAX_LENGTH &&
    ROOM_FACT_KEY_PATTERN.test(value)
    ? (value as T)
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
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  return Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
  });
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
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

function isText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length <= maximumLength && !value.includes("\0");
}

function isTrimmedText(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): value is string {
  return isText(value, maximumLength) && value.length >= minimumLength && value.trim() === value;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function isNumberInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function isPositiveRevision(value: unknown): value is number {
  return isIntegerInRange(value, 1, 2_147_483_647);
}

function isIsoDateTime(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const canonicalInput = value.includes(".") ? value : value.replace("Z", ".000Z");
  return parsed.toISOString() === canonicalInput;
}
