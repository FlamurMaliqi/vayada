import {
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  parsePhysicalRoomUnitIdentity,
  parseRoomTypeCapacitySnapshot,
  type PhysicalRoomUnitIdentity,
  type PmsRoomFactsContractVersion,
  type RoomFactsCommandAudit,
  type RoomTypeCapacitySnapshot,
} from "./roomFacts.js";

export const PHYSICAL_ROOM_UNIT_RECONCILE_BLOCKER_CODES = [
  "verified_operational_label",
  "reservation_assignment",
  "room_block",
  "operational_status",
  "reference_check_unavailable",
] as const;

export const PHYSICAL_ROOM_OPERATIONAL_USES = ["assignment", "housekeeping", "check_in"] as const;

export type PhysicalRoomUnitReconcileBlockerCode =
  (typeof PHYSICAL_ROOM_UNIT_RECONCILE_BLOCKER_CODES)[number];
export type PhysicalRoomOperationalUse = (typeof PHYSICAL_ROOM_OPERATIONAL_USES)[number];

export type ReconcilePhysicalRoomUnitsCommand = {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly expectedRevision: number;
  readonly targetActiveUnitCount: number;
  readonly idempotencyKey: string;
  readonly audit: RoomFactsCommandAudit;
};

export type PhysicalRoomUnitReconcileBlocker =
  | {
      readonly code: Exclude<PhysicalRoomUnitReconcileBlockerCode, "reference_check_unavailable">;
      readonly affectedCount: number;
    }
  | { readonly code: "reference_check_unavailable" };

export type ReconcilePhysicalRoomUnitsResponse = {
  readonly contractVersion: PmsRoomFactsContractVersion;
  readonly outcome: "reconciled" | "unchanged";
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly previousActiveUnitCount: number;
  readonly capacity: RoomTypeCapacitySnapshot;
  /** Newly generated opaque units are always active, unlabeled, and unverified. */
  readonly addedUnits: readonly PhysicalRoomUnitIdentity[];
  /** Retired rows keep these opaque IDs permanently. */
  readonly retiredUnitIds: readonly string[];
  readonly acceptedAt: string;
};

type ReconcileCoordinationError = {
  readonly code: "idempotency_key_conflict" | "command_in_progress";
};

export type ReconcilePhysicalRoomUnitsError =
  | { readonly code: "setup_scope_unavailable" | "room_type_not_found" }
  | { readonly code: "room_units_revision_conflict"; readonly currentRevision: number }
  | {
      readonly code: "physical_unit_capacity_invariant_violation";
      readonly currentActiveUnitCount: number;
    }
  | {
      readonly code: "physical_unit_reconcile_blocked";
      readonly currentRevision: number;
      readonly currentActiveUnitCount: number;
      readonly targetActiveUnitCount: number;
      readonly safelyRemovableUnitCount: number;
      readonly blockers: readonly PhysicalRoomUnitReconcileBlocker[];
    }
  | ReconcileCoordinationError;

export type ReconcilePhysicalRoomUnitsResult =
  | { readonly ok: true; readonly response: ReconcilePhysicalRoomUnitsResponse }
  | { readonly ok: false; readonly error: ReconcilePhysicalRoomUnitsError };

/**
 * Implementations recheck the authorized organization/property scope and lock
 * the active canonical room type before replay lookup. A changed reconcile
 * increments only roomUnitsRevision. New rows use opaque UUIDs, NULL labels,
 * and unverified label state. Decreases retire a deterministic subset of
 * available, unreferenced units that are either unverified or retain canonical
 * setup-generated provenance; protected rows produce blockers.
 * Domain state, idempotency result, and audit commit atomically. This
 * synchronous PMS-local command emits no outbox work or status operation.
 */
export type PhysicalRoomUnitReconcilePort = {
  reconcilePhysicalRoomUnits(
    command: ReconcilePhysicalRoomUnitsCommand,
  ): Promise<ReconcilePhysicalRoomUnitsResult>;
};

export type SetPhysicalRoomOperationalLabelCommand = {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomUnitId: string;
  readonly expectedRevision: number;
  readonly operationalLabel: string;
  readonly idempotencyKey: string;
  readonly audit: RoomFactsCommandAudit;
};

export type SetPhysicalRoomOperationalLabelResponse = {
  readonly contractVersion: PmsRoomFactsContractVersion;
  readonly outcome: "updated" | "unchanged";
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly roomUnitId: string;
  readonly roomUnitsRevision: number;
  readonly operationalLabel: string;
  readonly operationalLabelStatus: "verified";
  readonly acceptedAt: string;
};

export type SetPhysicalRoomOperationalLabelError =
  | {
      readonly code:
        | "setup_scope_unavailable"
        | "room_type_not_found"
        | "room_unit_not_found"
        | "operational_label_conflict"
        | "idempotency_key_conflict"
        | "command_in_progress";
    }
  | { readonly code: "room_units_revision_conflict"; readonly currentRevision: number };

export type SetPhysicalRoomOperationalLabelResult =
  | { readonly ok: true; readonly response: SetPhysicalRoomOperationalLabelResponse }
  | { readonly ok: false; readonly error: SetPhysicalRoomOperationalLabelError };

export type PhysicalRoomOperationalLabelPort = {
  setPhysicalRoomOperationalLabel(
    command: SetPhysicalRoomOperationalLabelCommand,
  ): Promise<SetPhysicalRoomOperationalLabelResult>;
};

export function parseSetPhysicalRoomOperationalLabelCommand(
  value: unknown,
): SetPhysicalRoomOperationalLabelCommand | null {
  if (
    !isExactRecord(value, [
      "organizationId",
      "propertyId",
      "roomTypeId",
      "roomUnitId",
      "expectedRevision",
      "operationalLabel",
      "idempotencyKey",
      "audit",
    ]) ||
    !isUuid(value.organizationId) ||
    !isUuid(value.propertyId) ||
    !isUuid(value.roomTypeId) ||
    !isUuid(value.roomUnitId) ||
    !isRevision(value.expectedRevision) ||
    !isTrimmedText(value.operationalLabel, 1, 200) ||
    !isTrimmedText(value.idempotencyKey, 1, 200)
  ) {
    return null;
  }
  const audit = parseAudit(value.audit);
  return audit
    ? Object.freeze({
        organizationId: normalizeUuid(value.organizationId),
        propertyId: normalizeUuid(value.propertyId),
        roomTypeId: normalizeUuid(value.roomTypeId),
        roomUnitId: normalizeUuid(value.roomUnitId),
        expectedRevision: value.expectedRevision,
        operationalLabel: value.operationalLabel,
        idempotencyKey: value.idempotencyKey,
        audit,
      })
    : null;
}

export function serializeSetPhysicalRoomOperationalLabelFingerprint(
  command: SetPhysicalRoomOperationalLabelCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    roomUnitId: command.roomUnitId,
    expectedRevision: command.expectedRevision,
    operationalLabel: command.operationalLabel,
  });
}

export function parseSetPhysicalRoomOperationalLabelResult(
  value: unknown,
): SetPhysicalRoomOperationalLabelResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === false && isExactRecord(value, ["ok", "error"])) {
    const error = parseOperationalLabelError(value.error);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  if (value.ok !== true || !isExactRecord(value, ["ok", "response"])) return null;
  const response = value.response;
  if (
    !isExactRecord(response, [
      "contractVersion",
      "outcome",
      "propertyId",
      "roomTypeId",
      "roomUnitId",
      "roomUnitsRevision",
      "operationalLabel",
      "operationalLabelStatus",
      "acceptedAt",
    ]) ||
    response.contractVersion !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    !(response.outcome === "updated" || response.outcome === "unchanged") ||
    !isUuid(response.propertyId) ||
    !isUuid(response.roomTypeId) ||
    !isUuid(response.roomUnitId) ||
    !isRevision(response.roomUnitsRevision) ||
    !isTrimmedText(response.operationalLabel, 1, 200) ||
    response.operationalLabelStatus !== "verified" ||
    !isIsoDateTime(response.acceptedAt)
  ) {
    return null;
  }
  return Object.freeze({
    ok: true as const,
    response: Object.freeze({
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      outcome: response.outcome,
      propertyId: normalizeUuid(response.propertyId),
      roomTypeId: normalizeUuid(response.roomTypeId),
      roomUnitId: normalizeUuid(response.roomUnitId),
      roomUnitsRevision: response.roomUnitsRevision,
      operationalLabel: response.operationalLabel,
      operationalLabelStatus: "verified" as const,
      acceptedAt: response.acceptedAt,
    }),
  });
}

export type PhysicalRoomOperationalIdentityResult =
  | {
      readonly ok: true;
      readonly use: PhysicalRoomOperationalUse;
      readonly roomUnitId: string;
      readonly operationalLabel: string;
    }
  | {
      readonly ok: false;
      readonly use: PhysicalRoomOperationalUse;
      readonly roomUnitId: string;
      readonly code:
        "room_unit_not_active" | "missing_operational_label" | "unverified_operational_label";
    };

export function parseReconcilePhysicalRoomUnitsCommand(
  value: unknown,
): ReconcilePhysicalRoomUnitsCommand | null {
  if (
    !isExactRecord(value, [
      "organizationId",
      "propertyId",
      "roomTypeId",
      "expectedRevision",
      "targetActiveUnitCount",
      "idempotencyKey",
      "audit",
    ]) ||
    !isUuid(value.organizationId) ||
    !isUuid(value.propertyId) ||
    !isUuid(value.roomTypeId) ||
    !isRevision(value.expectedRevision) ||
    !isInteger(value.targetActiveUnitCount, 1, 500) ||
    !isTrimmedText(value.idempotencyKey, 1, 200)
  ) {
    return null;
  }
  const audit = parseAudit(value.audit);
  return audit
    ? Object.freeze({
        organizationId: normalizeUuid(value.organizationId),
        propertyId: normalizeUuid(value.propertyId),
        roomTypeId: normalizeUuid(value.roomTypeId),
        expectedRevision: value.expectedRevision,
        targetActiveUnitCount: value.targetActiveUnitCount,
        idempotencyKey: value.idempotencyKey,
        audit,
      })
    : null;
}

/** Stable fingerprint field order; excludes idempotency/audit/transport metadata. */
export function serializeReconcilePhysicalRoomUnitsFingerprint(
  command: ReconcilePhysicalRoomUnitsCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    expectedRevision: command.expectedRevision,
    targetActiveUnitCount: command.targetActiveUnitCount,
  });
}

export function parseReconcilePhysicalRoomUnitsResult(
  value: unknown,
): ReconcilePhysicalRoomUnitsResult | null {
  if (!isRecord(value)) return null;
  if (value.ok === true && isExactRecord(value, ["ok", "response"])) {
    const response = parseResponse(value.response);
    return response ? Object.freeze({ ok: true as const, response }) : null;
  }
  if (value.ok === false && isExactRecord(value, ["ok", "error"])) {
    const error = parseError(value.error);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  return null;
}

/** Shared identity gate for assignment, housekeeping, and check-in workflows. */
export function requireVerifiedPhysicalRoomOperationalIdentity(
  unit: PhysicalRoomUnitIdentity,
  use: PhysicalRoomOperationalUse,
): PhysicalRoomOperationalIdentityResult {
  if (unit.lifecycle !== "active") return rejectedIdentity(unit, use, "room_unit_not_active");
  if (unit.operationalLabel === null) {
    return rejectedIdentity(unit, use, "missing_operational_label");
  }
  if (unit.operationalLabelStatus !== "verified") {
    return rejectedIdentity(unit, use, "unverified_operational_label");
  }
  return Object.freeze({
    ok: true as const,
    use,
    roomUnitId: unit.roomUnitId,
    operationalLabel: unit.operationalLabel,
  });
}

function rejectedIdentity(
  unit: PhysicalRoomUnitIdentity,
  use: PhysicalRoomOperationalUse,
  code: Extract<PhysicalRoomOperationalIdentityResult, { ok: false }>["code"],
): PhysicalRoomOperationalIdentityResult {
  return Object.freeze({ ok: false as const, use, roomUnitId: unit.roomUnitId, code });
}

function parseResponse(value: unknown): ReconcilePhysicalRoomUnitsResponse | null {
  if (
    !isExactRecord(value, [
      "contractVersion",
      "outcome",
      "propertyId",
      "roomTypeId",
      "previousActiveUnitCount",
      "capacity",
      "addedUnits",
      "retiredUnitIds",
      "acceptedAt",
    ]) ||
    value.contractVersion !== PMS_ROOM_FACTS_CONTRACT_VERSION ||
    !(value.outcome === "reconciled" || value.outcome === "unchanged") ||
    !isUuid(value.propertyId) ||
    !isUuid(value.roomTypeId) ||
    !isInteger(value.previousActiveUnitCount, 0, 500) ||
    !isDenseArray(value.addedUnits) ||
    !isDenseArray(value.retiredUnitIds) ||
    !isIsoDateTime(value.acceptedAt)
  ) {
    return null;
  }
  const propertyId = normalizeUuid(value.propertyId);
  const roomTypeId = normalizeUuid(value.roomTypeId);
  const capacity = parseRoomTypeCapacitySnapshot(value.capacity);
  const addedUnits = value.addedUnits.map(parsePhysicalRoomUnitIdentity);
  const retiredUnitIds = value.retiredUnitIds.map((id) => (isUuid(id) ? normalizeUuid(id) : null));
  if (
    !capacity ||
    capacity.propertyId !== propertyId ||
    capacity.roomTypeId !== roomTypeId ||
    capacity.activeUnitCount < 1 ||
    capacity.capturedAt !== value.acceptedAt ||
    addedUnits.some((unit) => unit === null) ||
    retiredUnitIds.some((id) => id === null)
  ) {
    return null;
  }
  const added = addedUnits as PhysicalRoomUnitIdentity[];
  const retired = retiredUnitIds as string[];
  if (
    new Set(added.map(({ roomUnitId }) => roomUnitId)).size !== added.length ||
    new Set(retired).size !== retired.length ||
    added.some(
      (unit) =>
        unit.propertyId !== propertyId ||
        unit.roomTypeId !== roomTypeId ||
        unit.lifecycle !== "active" ||
        unit.operationalLabel !== null ||
        unit.operationalLabelStatus !== "unverified",
    ) ||
    (added.length > 0 && retired.length > 0)
  ) {
    return null;
  }
  const expectedCount = value.previousActiveUnitCount + added.length - retired.length;
  if (
    capacity.activeUnitCount !== expectedCount ||
    (value.outcome === "unchanged" && (added.length !== 0 || retired.length !== 0)) ||
    (value.outcome === "reconciled" && added.length === 0 && retired.length === 0)
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    outcome: value.outcome,
    propertyId,
    roomTypeId,
    previousActiveUnitCount: value.previousActiveUnitCount,
    capacity,
    addedUnits: Object.freeze(added),
    retiredUnitIds: Object.freeze(retired),
    acceptedAt: value.acceptedAt,
  });
}

function parseError(value: unknown): ReconcilePhysicalRoomUnitsError | null {
  if (!isRecord(value)) return null;
  if (
    isExactRecord(value, ["code"]) &&
    (value.code === "setup_scope_unavailable" ||
      value.code === "room_type_not_found" ||
      value.code === "idempotency_key_conflict" ||
      value.code === "command_in_progress")
  ) {
    return Object.freeze({ code: value.code });
  }
  if (
    value.code === "room_units_revision_conflict" &&
    isExactRecord(value, ["code", "currentRevision"]) &&
    isRevision(value.currentRevision)
  ) {
    return Object.freeze({ code: value.code, currentRevision: value.currentRevision });
  }
  if (
    value.code === "physical_unit_capacity_invariant_violation" &&
    isExactRecord(value, ["code", "currentActiveUnitCount"]) &&
    isInteger(value.currentActiveUnitCount, 501, 2_147_483_647)
  ) {
    return Object.freeze({
      code: value.code,
      currentActiveUnitCount: value.currentActiveUnitCount,
    });
  }
  if (
    value.code !== "physical_unit_reconcile_blocked" ||
    !isExactRecord(value, [
      "code",
      "currentRevision",
      "currentActiveUnitCount",
      "targetActiveUnitCount",
      "safelyRemovableUnitCount",
      "blockers",
    ]) ||
    !isRevision(value.currentRevision) ||
    !isInteger(value.currentActiveUnitCount, 1, 500) ||
    !isInteger(value.targetActiveUnitCount, 1, value.currentActiveUnitCount - 1) ||
    !isInteger(value.safelyRemovableUnitCount, 0, value.currentActiveUnitCount) ||
    value.safelyRemovableUnitCount >= value.currentActiveUnitCount - value.targetActiveUnitCount ||
    !isDenseArray(value.blockers) ||
    value.blockers.length < 1 ||
    value.blockers.length > PHYSICAL_ROOM_UNIT_RECONCILE_BLOCKER_CODES.length
  ) {
    return null;
  }
  const currentActiveUnitCount = value.currentActiveUnitCount;
  const blockers = value.blockers.map(parseBlocker);
  if (
    blockers.some((blocker) => blocker === null) ||
    new Set(blockers.map((blocker) => blocker?.code)).size !== blockers.length ||
    (blockers.some((blocker) => blocker?.code === "reference_check_unavailable") &&
      blockers.length !== 1) ||
    blockers.some(
      (blocker) =>
        blocker !== null &&
        "affectedCount" in blocker &&
        blocker.affectedCount > currentActiveUnitCount,
    )
  ) {
    return null;
  }
  return Object.freeze({
    code: value.code,
    currentRevision: value.currentRevision,
    currentActiveUnitCount,
    targetActiveUnitCount: value.targetActiveUnitCount,
    safelyRemovableUnitCount: value.safelyRemovableUnitCount,
    blockers: Object.freeze(blockers as PhysicalRoomUnitReconcileBlocker[]),
  });
}

function parseOperationalLabelError(value: unknown): SetPhysicalRoomOperationalLabelError | null {
  if (!isRecord(value)) return null;
  if (
    isExactRecord(value, ["code"]) &&
    (value.code === "setup_scope_unavailable" ||
      value.code === "room_type_not_found" ||
      value.code === "room_unit_not_found" ||
      value.code === "operational_label_conflict" ||
      value.code === "idempotency_key_conflict" ||
      value.code === "command_in_progress")
  ) {
    return Object.freeze({ code: value.code });
  }
  return value.code === "room_units_revision_conflict" &&
    isExactRecord(value, ["code", "currentRevision"]) &&
    isRevision(value.currentRevision)
    ? Object.freeze({ code: value.code, currentRevision: value.currentRevision })
    : null;
}

function parseBlocker(value: unknown): PhysicalRoomUnitReconcileBlocker | null {
  if (
    !isRecord(value) ||
    !PHYSICAL_ROOM_UNIT_RECONCILE_BLOCKER_CODES.includes(value.code as never)
  ) {
    return null;
  }
  if (value.code === "reference_check_unavailable") {
    return isExactRecord(value, ["code"])
      ? Object.freeze({ code: "reference_check_unavailable" as const })
      : null;
  }
  return isExactRecord(value, ["code", "affectedCount"]) &&
    isInteger(value.affectedCount, 1, 2_147_483_647)
    ? Object.freeze({
        code: value.code as Exclude<
          PhysicalRoomUnitReconcileBlockerCode,
          "reference_check_unavailable"
        >,
        affectedCount: value.affectedCount,
      })
    : null;
}

function parseAudit(value: unknown): RoomFactsCommandAudit | null {
  if (
    !isExactRecord(value, ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !isTrimmedText(value.requestId, 1, 200) ||
    !(value.correlationId === null || isTrimmedText(value.correlationId, 1, 200)) ||
    !isIsoDateTime(value.requestedAt) ||
    !isRecord(value.actor)
  ) {
    return null;
  }
  const actor =
    value.actor.kind === "user" &&
    isExactRecord(value.actor, ["kind", "userId"]) &&
    isUuid(value.actor.userId)
      ? Object.freeze({ kind: "user" as const, userId: normalizeUuid(value.actor.userId) })
      : value.actor.kind === "system" &&
          isExactRecord(value.actor, ["kind", "service"]) &&
          isTrimmedText(value.actor.service, 1, 100)
        ? Object.freeze({ kind: "system" as const, service: value.actor.service })
        : null;
  return actor
    ? Object.freeze({
        actor,
        requestId: value.requestId,
        correlationId: value.correlationId,
        requestedAt: value.requestedAt,
      })
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isDenseArray(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => String(index)).every((key) =>
      Object.hasOwn(value, key),
    )
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

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function isRevision(value: unknown): value is number {
  return isInteger(value, 1, 2_147_483_647);
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

function isIsoDateTime(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === canonical;
}
