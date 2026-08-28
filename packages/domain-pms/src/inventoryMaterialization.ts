import {
  serializePmsOperatingCalendarSourceRevision,
  type PmsOperatingCalendarConfigurationSnapshot,
  type PmsOperatingCalendarRoomBinding,
  type PmsOperatingCalendarSourceRevision,
} from "./operatingCalendar.js";
import type { RoomFactsCommandAudit } from "./roomFacts.js";

export const PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION =
  "pms-inventory-materialization.v1" as const;
export const PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION =
  "distribution.inventory-projection" as const;
export const PMS_INVENTORY_HORIZON_MAX_DAYS = 366 as const;
export const PMS_INVENTORY_MATERIALIZATION_IDEMPOTENCY = Object.freeze({
  operationScope: "pms",
  operation: "pms.inventory.materialize",
  keyScope: "property",
  exactReplay: "original_response",
  replaySideEffects: "none",
  changedFingerprint: "idempotency_key_conflict",
  inProgress: "command_in_progress",
} as const);
export const PMS_INVENTORY_PRECEDENCE = Object.freeze({
  availabilityGate: "operating_closure",
  sellableLimit: Object.freeze(["manual", "channel", "generated"] as const),
  capacityConsumers: Object.freeze(["booking", "block"] as const),
} as const);

export type PmsInventorySourceRevisionVector = Readonly<{
  generated: number;
  channel: number;
  manual: number;
  block: number;
  booking: number;
}>;

/**
 * Owner revisions are monotonic. Calendar rematerialization may change only
 * generated/calendar-owned fields; manual, channel, block, and booking state
 * remains authoritative until its owning writer advances its revision. Linked
 * stop-sell state is likewise retained. Every stored sellable limit is bounded
 * by physical capacity, assigned plus blocked never exceeds that capacity, and
 * available is zero while closed or linked, or otherwise max(0, effective
 * sellable limit - assigned - blocked).
 */
export type PmsInventoryDaySnapshot = Readonly<{
  propertyId: string;
  roomTypeId: string;
  stayDate: string;
  calendarRevision: number;
  inventoryRevision: number;
  sourceRevisions: PmsInventorySourceRevisionVector;
  operatingStatus: "open" | "closed";
  physicalCapacityCount: number;
  generatedSellableLimitCount: number;
  channelSellableLimitCount: number | null;
  manualSellableLimitCount: number | null;
  effectiveSellableLimitCount: number;
  assignedCount: number;
  blockedCount: number;
  linkedStopSell: boolean;
  linkedSourceRevision: number;
  availableCount: number;
}>;

export type PmsInventoryCoverageEvidence = Readonly<{
  configurationSource: PmsOperatingCalendarSourceRevision;
  materializedRevision: number;
  /** Exact evaluated horizon, never a historical superset. */
  coverageFrom: string;
  coverageThrough: string;
  roomTypeIds: readonly string[];
  expectedDayCount: number;
  materializedDayCount: number;
  gaps: readonly Readonly<{ roomTypeId: string; stayDate: string }>[];
}>;

/** Distribution resolves current PMS state; this payload carries no public rows. */
export type PmsInventoryProjectionRefreshIntent = Readonly<{
  contractVersion: typeof PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION;
  destination: typeof PMS_INVENTORY_PROJECTION_REFRESH_DESTINATION;
  eventType: "pms.inventory.projection_refresh_requested";
  organizationId: string;
  propertyId: string;
  configurationSource: PmsOperatingCalendarSourceRevision;
  materializedRevision: number;
  coverageFrom: string;
  coverageThrough: string;
  roomTypeIds: readonly string[];
  reason: "full_horizon_apply" | "horizon_extension" | "rematerialization";
}>;

export type PmsInventorySellableLimitEvidence = Readonly<{
  roomTypeId: string;
  sourceRoomFactsRevision: number;
  sourceRoomUnitsRevision: number;
  physicalCapacityCount: number;
  configuredSellableLimitCount: number;
  minimumEffectiveSellableLimitCount: number;
  maximumEffectiveSellableLimitCount: number;
}>;

/**
 * Launch configuration evidence deliberately excludes available/assigned/
 * blocked counts: intentional limits and temporary sold-out state are valid.
 */
export type PmsInventoryLaunchReadinessSnapshot = Readonly<{
  contractVersion: typeof PMS_INVENTORY_MATERIALIZATION_CONTRACT_VERSION;
  propertyId: string;
  configuration: Readonly<{
    source: PmsOperatingCalendarSourceRevision;
    calendarRevision: number;
    propertyProfileSource: PmsOperatingCalendarConfigurationSnapshot["sourceInputs"]["propertyProfile"];
    propertyTimeZone: PmsOperatingCalendarConfigurationSnapshot["sourceInputs"]["propertyTimeZone"];
  }>;
  roomSet: readonly PmsOperatingCalendarRoomBinding[];
  materializedRevision: number;
  coverage: PmsInventoryCoverageEvidence;
  sellableLimits: readonly PmsInventorySellableLimitEvidence[];
}>;

export type PmsInventoryLaunchReadinessBlocker =
  | "calendar_revision_mismatch"
  | "coverage_gap"
  | "room_set_mismatch"
  | "sellable_limit_invariant_violation";

export type PmsInventoryRequiredCoverage = Readonly<{ from: string; through: string }>;

export type PmsInventoryLaunchReadinessResult =
  | Readonly<{
      ready: true;
      snapshot: PmsInventoryLaunchReadinessSnapshot;
      requiredCoverage: PmsInventoryRequiredCoverage;
      blockers: readonly [];
    }>
  | Readonly<{
      ready: false;
      snapshot: PmsInventoryLaunchReadinessSnapshot;
      requiredCoverage: PmsInventoryRequiredCoverage;
      blockers: readonly PmsInventoryLaunchReadinessBlocker[];
    }>;

export type PmsInventoryMaterializationCommand = Readonly<{
  organizationId: string;
  propertyId: string;
  configurationSource: PmsOperatingCalendarSourceRevision;
  expectedMaterializedRevision: number;
  horizon: Readonly<{ from: string; through: string }>;
  idempotencyKey: string;
  audit: RoomFactsCommandAudit;
}>;

export type PmsInventoryMaterializationError =
  | Readonly<{
      code:
        | "configuration_not_found"
        | "configuration_not_current"
        | "inventory_invariant_violation"
        | "idempotency_key_conflict"
        | "command_in_progress";
    }>
  | Readonly<{ code: "materialized_revision_conflict"; currentRevision: number }>;

export type PmsInventoryMaterializationResult =
  | Readonly<{
      ok: true;
      outcome: "applied" | "extended" | "rematerialized";
      coverage: PmsInventoryCoverageEvidence;
      changedDayCount: number;
      projectionRefreshIntent: PmsInventoryProjectionRefreshIntent;
    }>
  | Readonly<{
      ok: true;
      outcome: "unchanged";
      coverage: PmsInventoryCoverageEvidence;
      changedDayCount: 0;
      projectionRefreshIntent: null;
    }>
  | Readonly<{
      ok: false;
      error: PmsInventoryMaterializationError;
    }>;

export type PmsInventoryMaterializationPort = {
  /**
   * Implementations authorize before replay. The exact fingerprint contains
   * organization, property, configuration source, expected materialized
   * revision, and horizon; it excludes the key and audit metadata. Exact replay
   * returns the original result without another audit, day write, or outbox row.
   * Changed fingerprints conflict and unfinished reservations report in-progress.
   *
   * Accepted work resolves the immutable configuration source, then holds the
   * shared property inventory lock while rechecking the current calendar and
   * physical capacity. Changed day writes, audit, replay result, and refresh
   * outbox intent commit atomically. No database transaction crosses this port.
   */
  materializeInventory(
    command: PmsInventoryMaterializationCommand,
  ): Promise<PmsInventoryMaterializationResult>;
};

export type PmsInventoryLaunchReadinessReadPort = {
  getInventoryLaunchReadiness(
    request: Readonly<{
      propertyId: string;
      requiredCoverage: PmsInventoryRequiredCoverage;
    }>,
  ): Promise<PmsInventoryLaunchReadinessResult | null>;
};

/** Canonical launch evaluation; available/assigned/blocked counts are not inputs. */
export function evaluatePmsInventoryLaunchReadiness(
  snapshot: PmsInventoryLaunchReadinessSnapshot,
  requiredCoverage: PmsInventoryRequiredCoverage,
): PmsInventoryLaunchReadinessResult {
  const blockers = new Set<PmsInventoryLaunchReadinessBlocker>();
  let expectedSourceRevision: string | null = null;
  try {
    expectedSourceRevision = serializePmsOperatingCalendarSourceRevision(
      snapshot.configuration.calendarRevision,
    );
  } catch {
    // Malformed owner evidence fails closed below.
  }
  const sourceMatches =
    snapshot.configuration.source.entityId === snapshot.propertyId &&
    snapshot.configuration.source.revision === expectedSourceRevision &&
    snapshot.coverage.configurationSource.ownerDomain ===
      snapshot.configuration.source.ownerDomain &&
    snapshot.coverage.configurationSource.entityType === snapshot.configuration.source.entityType &&
    snapshot.coverage.configurationSource.entityId === snapshot.configuration.source.entityId &&
    snapshot.coverage.configurationSource.revision === snapshot.configuration.source.revision;
  if (
    !sourceMatches ||
    snapshot.materializedRevision !== snapshot.configuration.calendarRevision ||
    snapshot.coverage.materializedRevision !== snapshot.configuration.calendarRevision
  ) {
    blockers.add("calendar_revision_mismatch");
  }
  const requiredDayCount = inclusiveIsoDateCount(requiredCoverage);
  const uniqueRoomTypeCount = new Set(snapshot.roomSet.map(({ roomTypeId }) => roomTypeId)).size;
  const expectedDayCount =
    requiredDayCount === null || uniqueRoomTypeCount === 0
      ? null
      : requiredDayCount * uniqueRoomTypeCount;
  if (
    expectedDayCount === null ||
    snapshot.coverage.coverageFrom !== requiredCoverage.from ||
    snapshot.coverage.coverageThrough !== requiredCoverage.through ||
    snapshot.coverage.gaps.length > 0 ||
    snapshot.coverage.expectedDayCount !== expectedDayCount ||
    snapshot.coverage.materializedDayCount !== expectedDayCount
  ) {
    blockers.add("coverage_gap");
  }
  const roomIds = snapshot.roomSet.map(({ roomTypeId }) => roomTypeId).sort();
  const coverageRoomIds = [...snapshot.coverage.roomTypeIds].sort();
  const limitRoomIds = snapshot.sellableLimits.map(({ roomTypeId }) => roomTypeId).sort();
  if (
    roomIds.length === 0 ||
    new Set(roomIds).size !== roomIds.length ||
    JSON.stringify(roomIds) !== JSON.stringify(coverageRoomIds) ||
    JSON.stringify(roomIds) !== JSON.stringify(limitRoomIds) ||
    snapshot.sellableLimits.some((evidence) => {
      const binding = snapshot.roomSet.find(({ roomTypeId }) => roomTypeId === evidence.roomTypeId);
      return (
        !binding ||
        evidence.sourceRoomFactsRevision !== binding.sourceRoomFactsRevision ||
        evidence.sourceRoomUnitsRevision !== binding.sourceRoomUnitsRevision ||
        evidence.physicalCapacityCount !== binding.physicalCapacityCount ||
        evidence.configuredSellableLimitCount !== binding.startingSellableLimitCount
      );
    })
  ) {
    blockers.add("room_set_mismatch");
  }
  if (
    snapshot.sellableLimits.some(
      (evidence) =>
        evidence.configuredSellableLimitCount < 0 ||
        evidence.configuredSellableLimitCount > evidence.physicalCapacityCount ||
        evidence.minimumEffectiveSellableLimitCount < 0 ||
        evidence.minimumEffectiveSellableLimitCount > evidence.maximumEffectiveSellableLimitCount ||
        evidence.maximumEffectiveSellableLimitCount > evidence.physicalCapacityCount,
    )
  ) {
    blockers.add("sellable_limit_invariant_violation");
  }
  const sorted = Object.freeze([...blockers].sort());
  return sorted.length === 0
    ? Object.freeze({
        ready: true,
        snapshot,
        requiredCoverage,
        blockers: Object.freeze([]) as readonly [],
      })
    : Object.freeze({ ready: false, snapshot, requiredCoverage, blockers: sorted });
}

function inclusiveIsoDateCount({ from, through }: PmsInventoryRequiredCoverage): number | null {
  const parse = (value: string): number | null => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const timestamp = Date.UTC(year!, month! - 1, day!);
    return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
  };
  const fromTimestamp = parse(from);
  const throughTimestamp = parse(through);
  if (fromTimestamp === null || throughTimestamp === null) return null;
  const count = (throughTimestamp - fromTimestamp) / 86_400_000 + 1;
  return Number.isInteger(count) && count >= 1 && count <= PMS_INVENTORY_HORIZON_MAX_DAYS
    ? count
    : null;
}
