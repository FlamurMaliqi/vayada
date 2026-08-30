import { buildBookingCatalogRecords } from "./productionBookingCatalogRecords.js";
import { createProductionBookingContext } from "./productionBookingContext.js";
import { buildBookingDraftRecords } from "./productionBookingDraftRecords.js";
import { buildBookingRelatedRecords } from "./productionBookingRelatedRecords.js";
import { buildBookingReservationRecords } from "./productionBookingReservationRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type {
  BookingBuildContext,
  BookingTargetRecord,
  ExistingBookingTargetRecord,
  ProductionBookingPlan,
  ProductionBookingTargetState,
  ProductionMigrationSourceLink,
} from "./productionBookingTypes.js";
import { sha256 } from "./productionBookingValues.js";

export function buildProductionBookingPlan(input: {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionBookingTargetState;
}): ProductionBookingPlan {
  const context = createProductionBookingContext(input);
  const records = [
    ...buildBookingCatalogRecords(context),
    ...buildBookingDraftRecords(context),
    ...buildBookingReservationRecords(context),
    ...buildBookingRelatedRecords(context),
  ].sort((left, right) => recordKey(left).localeCompare(recordKey(right)));
  return reconcileProductionBookingRecords(context, records);
}

export function reconcileProductionBookingRecords(
  context: BookingBuildContext,
  candidates: BookingTargetRecord[],
): ProductionBookingPlan {
  const existing = new Map(context.target.records.map((row) => [targetKey(row), row]));
  const provenance = new Map(context.target.provenance.map((row) => [provenanceKey(row), row]));
  const accepted: BookingTargetRecord[] = [];
  const writes: BookingTargetRecord[] = [];
  const links: ProductionMigrationSourceLink[] = [];
  const seen = new Set<string>();
  const counts = {
    sourceRows: context.rows.length,
    plannedRecords: 0,
    inserts: 0,
    updates: 0,
    unchanged: 0,
    preservedNewerTarget: 0,
    preservedTargetDeletions: 0,
  };

  for (const candidate of candidates) {
    const key = recordKey(candidate);
    if (seen.has(key)) {
      blocker(
        context,
        "DUPLICATE_TARGET_RECORD",
        candidate,
        "More than one source mapping targets this row",
      );
      continue;
    }
    seen.add(key);
    const current = existing.get(key);
    const prior = provenance.get(provenanceKey(candidate));
    const action = reconcile(candidate, current, prior, context);
    if (action === "block") continue;
    accepted.push(candidate);
    if (action === "insert" || action === "update" || action === "unchanged")
      links.push(linkFor(candidate, prior, context));
    if (action === "insert" || action === "update") writes.push(candidate);
    if (action === "insert") counts.inserts += 1;
    else if (action === "update") counts.updates += 1;
    else if (action === "unchanged") counts.unchanged += 1;
    else if (action === "preserve_newer") counts.preservedNewerTarget += 1;
    else counts.preservedTargetDeletions += 1;
  }
  counts.plannedRecords = accepted.length;
  const parity = summarizeParity(context, accepted);
  const sortedBlockers = context.blockers.sort((left, right) =>
    `${left.code}:${left.source}:${left.sourceId}`.localeCompare(
      `${right.code}:${right.source}:${right.sourceId}`,
    ),
  );
  return {
    sourceRunId: context.sourceRunId,
    checksum: sha256({
      records: accepted.map((record) => ({
        key: recordKey(record),
        checksum: record.sourceChecksum,
        row: record.row,
      })),
      blockers: sortedBlockers,
      parity,
    }),
    records: accepted,
    writes,
    provenance: links,
    blockers: sortedBlockers,
    parity,
    counts,
  };
}

function summarizeParity(
  context: BookingBuildContext,
  records: BookingTargetRecord[],
): ProductionBookingPlan["parity"] {
  const bookings = context.rows.filter(
    (row) => row.sourceDatabase === "pms" && row.sourceTable === "bookings",
  );
  const drafts = context.rows.filter(
    (row) => row.sourceDatabase === "pms" && row.sourceTable === "booking_drafts",
  );
  return {
    sourceTableCounts: countBy(context.rows, (row) => `${row.sourceDatabase}.${row.sourceTable}`),
    targetTableCounts: countBy(
      records,
      (record) => `${record.targetProduct}.${record.targetTable}`,
    ),
    sourceBookingStatuses: countBy(bookings, (row) => normalizedLabel(row.data["status"])),
    plannedBookingLifecycleStatuses: countBy(
      records.filter((record) => record.targetTable === "guest_bookings"),
      (record) => normalizedLabel(record.row["lifecycleStatus"]),
    ),
    sourceDraftMaterialization: countBy(drafts, (row) =>
      row.data["materialized_booking_id"] ? "materialized" : "unmaterialized",
    ),
    plannedDraftStatuses: countBy(
      records.filter((record) => record.targetTable === "quote_sessions"),
      (record) => normalizedLabel(record.row["status"]),
    ),
  };
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = key(value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedLabel(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "<missing>";
}

type Action = "insert" | "update" | "unchanged" | "preserve_newer" | "preserve_deletion" | "block";

function reconcile(
  candidate: BookingTargetRecord,
  current: ExistingBookingTargetRecord | undefined,
  prior: ProductionMigrationSourceLink | undefined,
  context: BookingBuildContext,
): Action {
  if (prior) {
    if (!current) return "preserve_deletion";
    if (prior.sourceChecksum === candidate.sourceChecksum) {
      if (sameRecord(candidate.row, current.row)) return "unchanged";
      if (current.updatedAt && Date.parse(current.updatedAt) > Date.parse(prior.lastMigratedAt))
        return "preserve_newer";
      blocker(
        context,
        candidate.mutable ? "TARGET_PROVENANCE_MISMATCH" : "TARGET_IMMUTABLE_CONFLICT",
        candidate,
        "Target row differs from unchanged source provenance without a newer target timestamp",
      );
      return "block";
    }
    if (!candidate.mutable) {
      blocker(
        context,
        "IMMUTABLE_SOURCE_CHANGED",
        candidate,
        "Legacy source changed after an immutable target row was migrated",
      );
      return "block";
    }
    if (current.updatedAt && Date.parse(current.updatedAt) > Date.parse(prior.lastMigratedAt))
      return "preserve_newer";
    return "update";
  }
  if (!current) return "insert";
  if (sameRecord(candidate.row, current.row)) return "unchanged";
  if (!candidate.mutable) {
    blocker(
      context,
      "TARGET_IMMUTABLE_CONFLICT",
      candidate,
      "Existing immutable target row differs from the source mapping",
    );
    return "block";
  }
  if (!candidate.sourceUpdatedAt || !current.updatedAt) {
    blocker(
      context,
      "TARGET_FRESHNESS_UNKNOWN",
      candidate,
      "Cannot order source and target freshness safely",
    );
    return "block";
  }
  const sourceTime = Date.parse(candidate.sourceUpdatedAt);
  const targetTime = Date.parse(current.updatedAt);
  if (targetTime > sourceTime) return "preserve_newer";
  if (targetTime === sourceTime) {
    blocker(
      context,
      "TARGET_EQUAL_TIME_CONFLICT",
      candidate,
      "Source and target disagree at equal freshness",
    );
    return "block";
  }
  return "update";
}

function linkFor(
  record: BookingTargetRecord,
  prior: ProductionMigrationSourceLink | undefined,
  context: BookingBuildContext,
): ProductionMigrationSourceLink {
  return {
    sourceDatabase: record.sourceDatabase,
    sourceTable: record.sourceTable,
    sourceId: record.sourceId,
    targetProduct: record.targetProduct,
    targetTable: record.targetTable,
    targetId: record.targetId,
    sourceChecksum: record.sourceChecksum,
    sourceUpdatedAt: record.sourceUpdatedAt,
    lastMigratedAt: prior?.lastMigratedAt ?? context.completedAt,
  };
}

function sameRecord(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => sameValue(value, actual[key]));
}
function sameValue(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if ((expected === undefined || expected === null) && actual === null) return true;
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => sameValue(value, actual[index]))
    );
  if (expected && typeof expected === "object")
    return (
      !!actual &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
        sameValue(value, (actual as Record<string, unknown>)[key]),
      )
    );
  if (typeof expected === "string" && typeof actual === "number")
    return expected.trim() !== "" && Number(expected) === actual;
  if (typeof expected === "string" && typeof actual === "string" && isTimestamp(expected))
    return isTimestamp(actual) && Date.parse(expected) === Date.parse(actual);
  return false;
}
function isTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
function targetKey(row: { targetProduct: string; targetTable: string; targetId: string }): string {
  return `${row.targetProduct}:${row.targetTable}:${row.targetId}`;
}
function recordKey(row: BookingTargetRecord): string {
  return targetKey(row);
}
function provenanceKey(row: {
  sourceDatabase: string;
  sourceTable: string;
  sourceId: string;
  targetProduct: string;
  targetTable: string;
  targetId: string;
}): string {
  return `${row.sourceDatabase}:${row.sourceTable}:${row.sourceId}:${targetKey(row)}`;
}
function blocker(
  context: BookingBuildContext,
  code: string,
  record: BookingTargetRecord,
  message: string,
): void {
  context.blockers.push({
    code,
    source: `${record.sourceDatabase}.${record.sourceTable}`,
    sourceId: record.sourceId,
    message,
  });
}
