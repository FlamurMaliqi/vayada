import {
  parsePmsOperatingCalendarSourceRevision,
  type PmsOperatingCalendarSourceRevision,
} from "./operatingCalendar.js";
import {
  PMS_INVENTORY_HORIZON_MAX_DAYS,
  type PmsInventorySourceRevisionVector,
} from "./inventoryMaterialization.js";
import type { RoomFactsCommandAudit } from "./roomFacts.js";

export const PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION =
  "pms-inventory-reservation-lifecycle.v1" as const;

export const PMS_INVENTORY_RESERVATION_LIFECYCLE_IDEMPOTENCY = Object.freeze({
  operationScope: "pms",
  reserve: Object.freeze({
    operation: "pms.inventory.reserve",
    keyScope: "property",
    authorization: "before_replay",
    exactReplay: "same_receipt_current_state",
    replaySideEffects: "none",
    changedFingerprint: "idempotency_key_conflict",
    inProgress: "command_in_progress",
  }),
  release: Object.freeze({
    operation: "pms.inventory.release",
    keyScope: "property",
    authorization: "before_replay",
    exactReplay: "current_terminal_outcome",
    replaySideEffects: "none",
    changedFingerprint: "idempotency_key_conflict",
    inProgress: "command_in_progress",
  }),
} as const);

export type PmsInventoryReservationLifecycleState = "reserved" | "released" | "handed_off";

/**
 * This PMS-owned UUID is an opaque capability, not the legacy
 * `pms.inventory-reservation.v1` Booking metadata marker. Callers persist and
 * present it unchanged and never derive guest, quote, inventory, provider, or
 * storage identity from it. A later adapter owns the explicit marker cutover.
 */
export type PmsInventoryReservationReceipt = Readonly<{
  contractVersion: typeof PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION;
  owner: "pms";
  receiptId: string;
}>;

export type PmsInventoryReservationOfferCorrelation = Readonly<{
  quoteSessionId: string;
  publicOfferKey: string;
}>;

/** Exact current PMS owner revisions for one requested room-day. */
export type PmsInventoryReservationDayWatermark = Readonly<{
  propertyId: string;
  roomTypeId: string;
  stayDate: string;
  calendarRevision: number;
  inventoryRevision: number;
  sourceRevisions: PmsInventorySourceRevisionVector;
}>;

type PmsInventoryReservationStatusBase = Readonly<{
  receipt: PmsInventoryReservationReceipt;
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  offerCorrelation: PmsInventoryReservationOfferCorrelation;
  configurationSource: PmsOperatingCalendarSourceRevision;
  materializedRevision: number;
  reservationWatermarks: readonly PmsInventoryReservationDayWatermark[];
  reservedAt: string;
}>;

/**
 * `released` and `handed_off` are terminal. The `pms-reservation.v1` owner is
 * the only writer allowed to atomically adopt the exact receipt by moving
 * revision 1 `reserved` to revision 2 `handed_off` under the receipt/property
 * lock. Adoption does not increment assigned capacity a second time. Once
 * handed off, root release is a typed no-op; later operational cancellation
 * belongs to the adopted owner.
 */
export type PmsInventoryReservationStatus =
  | (PmsInventoryReservationStatusBase &
      Readonly<{
        state: "reserved";
        lifecycleRevision: 1;
        releasedAt?: never;
        handedOffAt?: never;
      }>)
  | (PmsInventoryReservationStatusBase &
      Readonly<{
        state: "released";
        lifecycleRevision: 2;
        releasedAt: string;
        handedOffAt?: never;
      }>)
  | (PmsInventoryReservationStatusBase &
      Readonly<{
        state: "handed_off";
        lifecycleRevision: 2;
        releasedAt?: never;
        handedOffAt: string;
      }>);

export type PmsInventoryReservationReserveCommand = Readonly<{
  contractVersion: typeof PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  /** Non-secret correlation only; never use either field as a receipt. */
  offerCorrelation: PmsInventoryReservationOfferCorrelation;
  configurationSource: PmsOperatingCalendarSourceRevision;
  expectedMaterializedRevision: number;
  /** One sorted, duplicate-free watermark for every date in [checkIn, checkOut). */
  inventoryWatermarks: readonly PmsInventoryReservationDayWatermark[];
  idempotencyKey: string;
  audit: RoomFactsCommandAudit;
}>;

export type PmsInventoryReservationProjectionRefreshIntent = Readonly<{
  contractVersion: typeof PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION;
  destination: "distribution.inventory-projection";
  eventType: "pms.inventory.projection_refresh_requested";
  organizationId: string;
  propertyId: string;
  roomTypeId: string;
  coverageFrom: string;
  coverageThroughExclusive: string;
  reservationLifecycleRevision: number;
  reason: "reservation_held" | "reservation_released";
}>;

export type PmsInventoryReservationReserveResult =
  | Readonly<{
      ok: true;
      outcome: "reserved";
      status: PmsInventoryReservationStatus & Readonly<{ state: "reserved" }>;
      projectionRefreshIntent: PmsInventoryReservationProjectionRefreshIntent &
        Readonly<{ reason: "reservation_held" }>;
    }>
  | Readonly<{
      ok: true;
      outcome: "already_reserved";
      status: PmsInventoryReservationStatus & Readonly<{ state: "reserved" }>;
      projectionRefreshIntent: null;
    }>
  | Readonly<{
      ok: true;
      outcome: "already_released";
      status: PmsInventoryReservationStatus & Readonly<{ state: "released" }>;
      projectionRefreshIntent: null;
    }>
  | Readonly<{
      ok: true;
      outcome: "already_handed_off";
      status: PmsInventoryReservationStatus & Readonly<{ state: "handed_off" }>;
      projectionRefreshIntent: null;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code:
          | "configuration_not_current"
          | "materialization_not_current"
          | "inventory_watermark_conflict"
          | "inventory_unavailable"
          | "inventory_invariant_violation"
          | "idempotency_key_conflict"
          | "command_in_progress";
      }>;
    }>;

export type PmsInventoryReservationReleaseCommand = Readonly<{
  contractVersion: typeof PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION;
  organizationId: string;
  propertyId: string;
  receipt: PmsInventoryReservationReceipt;
  idempotencyKey: string;
  audit: RoomFactsCommandAudit;
}>;

export type PmsInventoryReservationReleaseResult =
  | Readonly<{
      ok: true;
      outcome: "released";
      status: PmsInventoryReservationStatus & Readonly<{ state: "released" }>;
      projectionRefreshIntent: PmsInventoryReservationProjectionRefreshIntent &
        Readonly<{ reason: "reservation_released" }>;
    }>
  | Readonly<{
      ok: true;
      outcome: "already_released";
      status: PmsInventoryReservationStatus & Readonly<{ state: "released" }>;
      projectionRefreshIntent: null;
    }>
  | Readonly<{
      ok: true;
      outcome: "already_handed_off";
      status: PmsInventoryReservationStatus & Readonly<{ state: "handed_off" }>;
      projectionRefreshIntent: null;
    }>
  | Readonly<{
      ok: false;
      error: Readonly<{
        code:
          | "receipt_not_found"
          | "inventory_invariant_violation"
          | "idempotency_key_conflict"
          | "command_in_progress";
      }>;
    }>;

export type PmsInventoryReservationLifecyclePort = {
  /**
   * Implementations prove organization/property scope before replay, then take
   * the one shared property inventory lock. They recheck the exact current
   * configuration/materialized/watermark evidence and validate every requested
   * day is materialized, current, open, invariant-safe, and sufficiently
   * available. Only an all-day success increments assignedCount plus the
   * booking-owned source and inventory revisions on every day and recomputes
   * availability as effectiveSellableLimitCount - assignedCount - blockedCount
   * without clamping. Day writes, immutable receipt, idempotency result, audit,
   * revision 1 reserved status, and refresh outbox intent commit atomically; one
   * failed date writes nothing. No database transaction crosses this port.
   */
  reserveInventory(
    command: PmsInventoryReservationReserveCommand,
  ): Promise<PmsInventoryReservationReserveResult>;

  /**
   * Implementations prove scope before replay, resolve the original dates/count
   * only from the exact receipt, and lock that receipt plus the same property
   * inventory scope. `reserved` releases once: every original day decrements
   * assignedCount by the original roomCount, advances booking/inventory
   * revisions, and recomputes availability from current operating status,
   * effective sellable limit, assigned, and blocked state without clamping.
   * Every original-day write, revision 2 released status, release idempotency
   * result, audit, and refresh outbox intent commit in one transaction; any day
   * or invariant failure writes nothing. Callers supply no dates or counts.
   * Replays never decrement again; `handed_off` returns `already_handed_off` and
   * performs zero capacity or outbox changes.
   */
  releaseInventory(
    command: PmsInventoryReservationReleaseCommand,
  ): Promise<PmsInventoryReservationReleaseResult>;
};

export type PmsInventoryReservationStatusReadPort = {
  /** Scope proof precedes lookup; wrong scope fails closed as null. */
  getInventoryReservationStatus(
    request: PmsInventoryReservationStatusRequest,
  ): Promise<PmsInventoryReservationStatus | null>;
};

export type PmsInventoryReservationStatusRequest = Readonly<{
  organizationId: string;
  propertyId: string;
  receipt: PmsInventoryReservationReceipt;
}>;

export function parsePmsInventoryReservationReceipt(
  value: unknown,
): PmsInventoryReservationReceipt | null {
  return exactDataRecord(value, ["contractVersion", "owner", "receiptId"]) &&
    value.contractVersion === PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION &&
    value.owner === "pms" &&
    uuid(value.receiptId)
    ? Object.freeze({
        contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
        owner: "pms" as const,
        receiptId: value.receiptId.toLowerCase(),
      })
    : null;
}

export function parsePmsInventoryReservationReserveCommand(
  value: unknown,
): PmsInventoryReservationReserveCommand | null {
  if (
    !exactDataRecord(value, [
      "contractVersion",
      "organizationId",
      "propertyId",
      "roomTypeId",
      "checkIn",
      "checkOut",
      "roomCount",
      "offerCorrelation",
      "configurationSource",
      "expectedMaterializedRevision",
      "inventoryWatermarks",
      "idempotencyKey",
      "audit",
    ]) ||
    value.contractVersion !== PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION ||
    !uuid(value.organizationId) ||
    !uuid(value.propertyId) ||
    !uuid(value.roomTypeId) ||
    !integer(value.roomCount, 1, 500) ||
    !positiveRevision(value.expectedMaterializedRevision) ||
    !trimmed(value.idempotencyKey, 1, 200)
  ) {
    return null;
  }
  const organizationId = value.organizationId.toLowerCase();
  const propertyId = value.propertyId.toLowerCase();
  const roomTypeId = value.roomTypeId.toLowerCase();
  const dateRange = parseDateRange(value.checkIn, value.checkOut);
  const offerCorrelation = parseOfferCorrelation(value.offerCorrelation);
  const configurationSource = parseStrictConfigurationSource(value.configurationSource);
  const inventoryWatermarks = parseWatermarks(value.inventoryWatermarks, {
    propertyId,
    roomTypeId,
    dateRange,
    calendarRevision: value.expectedMaterializedRevision,
  });
  const audit = parseAudit(value.audit);
  if (
    !dateRange ||
    !offerCorrelation ||
    !configurationSource ||
    configurationSource.entityId !== propertyId ||
    sourceRevisionNumber(configurationSource) !== value.expectedMaterializedRevision ||
    !inventoryWatermarks ||
    !audit
  ) {
    return null;
  }
  return Object.freeze({
    contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
    organizationId,
    propertyId,
    roomTypeId,
    checkIn: dateRange.checkIn,
    checkOut: dateRange.checkOut,
    roomCount: value.roomCount,
    offerCorrelation,
    configurationSource,
    expectedMaterializedRevision: value.expectedMaterializedRevision,
    inventoryWatermarks,
    idempotencyKey: value.idempotencyKey,
    audit,
  });
}

export function parsePmsInventoryReservationReleaseCommand(
  value: unknown,
): PmsInventoryReservationReleaseCommand | null {
  if (
    !exactDataRecord(value, [
      "contractVersion",
      "organizationId",
      "propertyId",
      "receipt",
      "idempotencyKey",
      "audit",
    ]) ||
    value.contractVersion !== PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION ||
    !uuid(value.organizationId) ||
    !uuid(value.propertyId) ||
    !trimmed(value.idempotencyKey, 1, 200)
  ) {
    return null;
  }
  const receipt = parsePmsInventoryReservationReceipt(value.receipt);
  const audit = parseAudit(value.audit);
  return receipt && audit
    ? Object.freeze({
        contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
        organizationId: value.organizationId.toLowerCase(),
        propertyId: value.propertyId.toLowerCase(),
        receipt,
        idempotencyKey: value.idempotencyKey,
        audit,
      })
    : null;
}

export function parsePmsInventoryReservationStatusRequest(
  value: unknown,
): PmsInventoryReservationStatusRequest | null {
  if (
    !exactDataRecord(value, ["organizationId", "propertyId", "receipt"]) ||
    !uuid(value.organizationId) ||
    !uuid(value.propertyId)
  ) {
    return null;
  }
  const receipt = parsePmsInventoryReservationReceipt(value.receipt);
  return receipt
    ? Object.freeze({
        organizationId: value.organizationId.toLowerCase(),
        propertyId: value.propertyId.toLowerCase(),
        receipt,
      })
    : null;
}

/** Frozen field order; excludes idempotency and audit transport metadata. */
export function serializePmsInventoryReservationReserveFingerprint(
  command: PmsInventoryReservationReserveCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    roomTypeId: command.roomTypeId,
    checkIn: command.checkIn,
    checkOut: command.checkOut,
    roomCount: command.roomCount,
    offerCorrelation: command.offerCorrelation,
    configurationSource: command.configurationSource,
    expectedMaterializedRevision: command.expectedMaterializedRevision,
    inventoryWatermarks: command.inventoryWatermarks,
  });
}

/** Release never accepts mutable inventory scope; the receipt resolves it. */
export function serializePmsInventoryReservationReleaseFingerprint(
  command: PmsInventoryReservationReleaseCommand,
): string {
  return JSON.stringify({
    organizationId: command.organizationId,
    propertyId: command.propertyId,
    receipt: command.receipt,
  });
}

export function parsePmsInventoryReservationStatus(
  value: unknown,
): PmsInventoryReservationStatus | null {
  if (!plainDataRecord(value)) return null;
  const state = value.state;
  const keys = [
    "receipt",
    "organizationId",
    "propertyId",
    "roomTypeId",
    "checkIn",
    "checkOut",
    "roomCount",
    "offerCorrelation",
    "configurationSource",
    "materializedRevision",
    "reservationWatermarks",
    "lifecycleRevision",
    "reservedAt",
    "state",
    ...(state === "released" ? ["releasedAt"] : state === "handed_off" ? ["handedOffAt"] : []),
  ];
  if (
    !(state === "reserved" || state === "released" || state === "handed_off") ||
    !exactDataRecord(value, keys) ||
    !uuid(value.organizationId) ||
    !uuid(value.propertyId) ||
    !uuid(value.roomTypeId) ||
    !integer(value.roomCount, 1, 500) ||
    !positiveRevision(value.materializedRevision) ||
    !(
      (state === "reserved" && value.lifecycleRevision === 1) ||
      ((state === "released" || state === "handed_off") && value.lifecycleRevision === 2)
    ) ||
    !isoDateTime(value.reservedAt)
  ) {
    return null;
  }
  const organizationId = value.organizationId.toLowerCase();
  const propertyId = value.propertyId.toLowerCase();
  const roomTypeId = value.roomTypeId.toLowerCase();
  const dateRange = parseDateRange(value.checkIn, value.checkOut);
  const receipt = parsePmsInventoryReservationReceipt(value.receipt);
  const offerCorrelation = parseOfferCorrelation(value.offerCorrelation);
  const configurationSource = parseStrictConfigurationSource(value.configurationSource);
  const reservationWatermarks = parseWatermarks(value.reservationWatermarks, {
    propertyId,
    roomTypeId,
    dateRange,
    calendarRevision: value.materializedRevision,
  });
  if (
    !dateRange ||
    !receipt ||
    !offerCorrelation ||
    !configurationSource ||
    configurationSource.entityId !== propertyId ||
    sourceRevisionNumber(configurationSource) !== value.materializedRevision ||
    !reservationWatermarks
  ) {
    return null;
  }
  const base = {
    receipt,
    organizationId,
    propertyId,
    roomTypeId,
    checkIn: dateRange.checkIn,
    checkOut: dateRange.checkOut,
    roomCount: value.roomCount,
    offerCorrelation,
    configurationSource,
    materializedRevision: value.materializedRevision,
    reservationWatermarks,
    reservedAt: value.reservedAt,
  };
  if (state === "reserved") return Object.freeze({ ...base, state, lifecycleRevision: 1 as const });
  const transitionAt = state === "released" ? value.releasedAt : value.handedOffAt;
  if (!isoDateTime(transitionAt) || Date.parse(transitionAt) < Date.parse(value.reservedAt)) {
    return null;
  }
  return state === "released"
    ? Object.freeze({ ...base, state, lifecycleRevision: 2 as const, releasedAt: transitionAt })
    : Object.freeze({ ...base, state, lifecycleRevision: 2 as const, handedOffAt: transitionAt });
}

export function parsePmsInventoryReservationReserveResult(
  value: unknown,
): PmsInventoryReservationReserveResult | null {
  if (!plainDataRecord(value)) return null;
  if (
    !exactDataRecord(
      value,
      value.ok === true ? ["ok", "outcome", "status", "projectionRefreshIntent"] : ["ok", "error"],
    )
  ) {
    return null;
  }
  if (value.ok === false) {
    const error = parseError(value.error, RESERVE_ERROR_CODES);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  if (value.ok !== true || !RESERVE_OUTCOMES.includes(value.outcome as never)) return null;
  const status = parsePmsInventoryReservationStatus(value.status);
  if (!status) return null;
  if (value.outcome !== "reserved") {
    if (value.projectionRefreshIntent !== null) return null;
    if (value.outcome === "already_reserved" && status.state === "reserved") {
      return Object.freeze({
        ok: true as const,
        outcome: value.outcome,
        status,
        projectionRefreshIntent: null,
      });
    }
    if (value.outcome === "already_released" && status.state === "released") {
      return Object.freeze({
        ok: true as const,
        outcome: value.outcome,
        status,
        projectionRefreshIntent: null,
      });
    }
    return value.outcome === "already_handed_off" && status.state === "handed_off"
      ? Object.freeze({
          ok: true as const,
          outcome: value.outcome,
          status,
          projectionRefreshIntent: null,
        })
      : null;
  }
  const intent = parseRefreshIntent(value.projectionRefreshIntent, status, "reservation_held");
  return status.state === "reserved" && intent
    ? Object.freeze({
        ok: true as const,
        outcome: "reserved" as const,
        status,
        projectionRefreshIntent: intent,
      })
    : null;
}

export function parsePmsInventoryReservationReleaseResult(
  value: unknown,
): PmsInventoryReservationReleaseResult | null {
  if (!plainDataRecord(value)) return null;
  if (
    !exactDataRecord(
      value,
      value.ok === true ? ["ok", "outcome", "status", "projectionRefreshIntent"] : ["ok", "error"],
    )
  ) {
    return null;
  }
  if (value.ok === false) {
    const error = parseError(value.error, RELEASE_ERROR_CODES);
    return error ? Object.freeze({ ok: false as const, error }) : null;
  }
  if (value.ok !== true || !RELEASE_OUTCOMES.includes(value.outcome as never)) return null;
  const status = parsePmsInventoryReservationStatus(value.status);
  const expectedState = value.outcome === "already_handed_off" ? "handed_off" : "released";
  if (!status || status.state !== expectedState) return null;
  if (value.outcome !== "released") {
    if (value.projectionRefreshIntent !== null) return null;
    if (value.outcome === "already_released" && status.state === "released") {
      return Object.freeze({
        ok: true as const,
        outcome: value.outcome,
        status,
        projectionRefreshIntent: null,
      });
    }
    return value.outcome === "already_handed_off" && status.state === "handed_off"
      ? Object.freeze({
          ok: true as const,
          outcome: value.outcome,
          status,
          projectionRefreshIntent: null,
        })
      : null;
  }
  const intent = parseRefreshIntent(value.projectionRefreshIntent, status, "reservation_released");
  return status.state === "released" && intent
    ? Object.freeze({
        ok: true as const,
        outcome: "released" as const,
        status,
        projectionRefreshIntent: intent,
      })
    : null;
}

const RESERVE_OUTCOMES = [
  "reserved",
  "already_reserved",
  "already_released",
  "already_handed_off",
] as const;
const RELEASE_OUTCOMES = ["released", "already_released", "already_handed_off"] as const;
const RESERVE_ERROR_CODES = [
  "configuration_not_current",
  "materialization_not_current",
  "inventory_watermark_conflict",
  "inventory_unavailable",
  "inventory_invariant_violation",
  "idempotency_key_conflict",
  "command_in_progress",
] as const;
const RELEASE_ERROR_CODES = [
  "receipt_not_found",
  "inventory_invariant_violation",
  "idempotency_key_conflict",
  "command_in_progress",
] as const;

function parseOfferCorrelation(value: unknown): PmsInventoryReservationOfferCorrelation | null {
  return exactDataRecord(value, ["quoteSessionId", "publicOfferKey"]) &&
    trimmed(value.quoteSessionId, 1, 200) &&
    trimmed(value.publicOfferKey, 1, 200)
    ? Object.freeze({
        quoteSessionId: value.quoteSessionId,
        publicOfferKey: value.publicOfferKey,
      })
    : null;
}

function parseWatermarks(
  value: unknown,
  scope: Readonly<{
    propertyId: string;
    roomTypeId: string;
    dateRange: DateRange | null;
    calendarRevision: number;
  }>,
): readonly PmsInventoryReservationDayWatermark[] | null {
  if (!scope.dateRange || !denseDataArray(value) || value.length !== scope.dateRange.dayCount) {
    return null;
  }
  const parsed = value.map((item) => parseWatermark(item));
  if (parsed.some((item) => item === null)) return null;
  const watermarks = parsed as PmsInventoryReservationDayWatermark[];
  for (let index = 0; index < watermarks.length; index += 1) {
    const watermark = watermarks[index]!;
    if (
      watermark.propertyId !== scope.propertyId ||
      watermark.roomTypeId !== scope.roomTypeId ||
      watermark.stayDate !== isoDateFromEpochDay(scope.dateRange.checkInDay + index) ||
      watermark.calendarRevision !== scope.calendarRevision ||
      watermark.sourceRevisions.generated !== scope.calendarRevision
    ) {
      return null;
    }
  }
  return Object.freeze(watermarks);
}

function parseWatermark(value: unknown): PmsInventoryReservationDayWatermark | null {
  if (
    !exactDataRecord(value, [
      "propertyId",
      "roomTypeId",
      "stayDate",
      "calendarRevision",
      "inventoryRevision",
      "sourceRevisions",
    ]) ||
    !uuid(value.propertyId) ||
    !uuid(value.roomTypeId) ||
    !isoDate(value.stayDate) ||
    !positiveRevision(value.calendarRevision) ||
    !positiveRevision(value.inventoryRevision) ||
    !exactDataRecord(value.sourceRevisions, [
      "generated",
      "channel",
      "manual",
      "block",
      "booking",
    ]) ||
    !positiveRevision(value.sourceRevisions.generated) ||
    !revision(value.sourceRevisions.channel) ||
    !revision(value.sourceRevisions.manual) ||
    !revision(value.sourceRevisions.block) ||
    !revision(value.sourceRevisions.booking)
  ) {
    return null;
  }
  return Object.freeze({
    propertyId: value.propertyId.toLowerCase(),
    roomTypeId: value.roomTypeId.toLowerCase(),
    stayDate: value.stayDate,
    calendarRevision: value.calendarRevision,
    inventoryRevision: value.inventoryRevision,
    sourceRevisions: Object.freeze({
      generated: value.sourceRevisions.generated,
      channel: value.sourceRevisions.channel,
      manual: value.sourceRevisions.manual,
      block: value.sourceRevisions.block,
      booking: value.sourceRevisions.booking,
    }),
  });
}

function parseRefreshIntent<
  const Reason extends PmsInventoryReservationProjectionRefreshIntent["reason"],
>(
  value: unknown,
  status: PmsInventoryReservationStatus,
  reason: Reason,
): (PmsInventoryReservationProjectionRefreshIntent & Readonly<{ reason: Reason }>) | null {
  return exactDataRecord(value, [
    "contractVersion",
    "destination",
    "eventType",
    "organizationId",
    "propertyId",
    "roomTypeId",
    "coverageFrom",
    "coverageThroughExclusive",
    "reservationLifecycleRevision",
    "reason",
  ]) &&
    value.contractVersion === PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION &&
    value.destination === "distribution.inventory-projection" &&
    value.eventType === "pms.inventory.projection_refresh_requested" &&
    value.organizationId === status.organizationId &&
    value.propertyId === status.propertyId &&
    value.roomTypeId === status.roomTypeId &&
    value.coverageFrom === status.checkIn &&
    value.coverageThroughExclusive === status.checkOut &&
    value.reservationLifecycleRevision === status.lifecycleRevision &&
    value.reason === reason
    ? Object.freeze({
        contractVersion: PMS_INVENTORY_RESERVATION_LIFECYCLE_CONTRACT_VERSION,
        destination: "distribution.inventory-projection" as const,
        eventType: "pms.inventory.projection_refresh_requested" as const,
        organizationId: value.organizationId,
        propertyId: value.propertyId,
        roomTypeId: value.roomTypeId,
        coverageFrom: value.coverageFrom,
        coverageThroughExclusive: value.coverageThroughExclusive,
        reservationLifecycleRevision: status.lifecycleRevision,
        reason,
      })
    : null;
}

function parseError<const Codes extends readonly string[]>(
  value: unknown,
  codes: Codes,
): Readonly<{ code: Codes[number] }> | null {
  return exactDataRecord(value, ["code"]) && codes.includes(value.code as never)
    ? Object.freeze({ code: value.code as Codes[number] })
    : null;
}

function parseAudit(value: unknown): RoomFactsCommandAudit | null {
  if (
    !exactDataRecord(value, ["actor", "requestId", "correlationId", "requestedAt"]) ||
    !trimmed(value.requestId, 1, 200) ||
    !(value.correlationId === null || trimmed(value.correlationId, 1, 200)) ||
    !isoDateTime(value.requestedAt) ||
    !plainDataRecord(value.actor)
  ) {
    return null;
  }
  const actor =
    value.actor.kind === "user" &&
    exactDataRecord(value.actor, ["kind", "userId"]) &&
    uuid(value.actor.userId)
      ? Object.freeze({ kind: "user" as const, userId: value.actor.userId.toLowerCase() })
      : value.actor.kind === "system" &&
          exactDataRecord(value.actor, ["kind", "service"]) &&
          trimmed(value.actor.service, 1, 100)
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

function parseStrictConfigurationSource(value: unknown): PmsOperatingCalendarSourceRevision | null {
  return exactDataRecord(value, ["ownerDomain", "entityType", "entityId", "revision"])
    ? parsePmsOperatingCalendarSourceRevision(value)
    : null;
}

type DateRange = Readonly<{
  checkIn: string;
  checkOut: string;
  checkInDay: number;
  dayCount: number;
}>;

function parseDateRange(checkIn: unknown, checkOut: unknown): DateRange | null {
  const checkInDay = isoDateEpochDay(checkIn);
  const checkOutDay = isoDateEpochDay(checkOut);
  const dayCount = checkInDay === null || checkOutDay === null ? 0 : checkOutDay - checkInDay;
  return checkInDay !== null &&
    checkOutDay !== null &&
    dayCount >= 1 &&
    dayCount <= PMS_INVENTORY_HORIZON_MAX_DAYS
    ? Object.freeze({
        checkIn: checkIn as string,
        checkOut: checkOut as string,
        checkInDay,
        dayCount,
      })
    : null;
}

function isoDate(value: unknown): value is string {
  return isoDateEpochDay(value) !== null;
}

function isoDateEpochDay(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? Math.floor(date.getTime() / 86_400_000)
    : null;
}

function isoDateFromEpochDay(epochDay: number): string {
  return new Date(epochDay * 86_400_000).toISOString().slice(0, 10);
}

function isoDateTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function sourceRevisionNumber(source: PmsOperatingCalendarSourceRevision): number {
  return Number(source.revision.slice("calendar:".length));
}

function plainDataRecord(value: unknown): value is Record<string, unknown> {
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

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    plainDataRecord(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function denseDataArray(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    Object.getPrototypeOf(value) === Array.prototype &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => String(index)).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
    })
  );
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function trimmed(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    value.trim() === value
  );
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function revision(value: unknown): value is number {
  return integer(value, 0, 2_147_483_647);
}

function positiveRevision(value: unknown): value is number {
  return integer(value, 1, 2_147_483_647);
}
