import { buildPmsAssignmentRecords } from "./productionPmsAssignmentRecords.js";
import { buildPmsAuditRecords } from "./productionPmsAuditRecords.js";
import { buildPmsChannelRecords } from "./productionPmsChannelRecords.js";
import { createProductionPmsContext, propertyForHotel } from "./productionPmsContext.js";
import { buildPmsGuestOperationsRecords } from "./productionPmsGuestOperationsRecords.js";
import { buildPmsInventoryRecords } from "./productionPmsInventoryRecords.js";
import { buildPmsMessagingRecords } from "./productionPmsMessagingRecords.js";
import { buildPmsRoomRecords } from "./productionPmsRoomRecords.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type {
  ExistingPmsTargetRecord,
  PmsBuildContext,
  PmsTargetRecord,
  ProductionPmsPlan,
  ProductionPmsTargetState,
} from "./productionPmsTypes.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";
import { sha256 } from "./productionBookingValues.js";
import { sourceIdentity } from "./productionPmsValues.js";

export function buildProductionPmsPlan(input: {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionPmsTargetState;
}): ProductionPmsPlan {
  const context = createProductionPmsContext(input);
  const rooms = buildPmsRoomRecords(context);
  const assignments = buildPmsAssignmentRecords(context, rooms);
  const records = [
    ...rooms.records,
    ...assignments.records,
    ...buildPmsInventoryRecords(context),
    ...buildPmsGuestOperationsRecords(context, assignments),
    ...buildPmsMessagingRecords(context),
    ...buildPmsChannelRecords(context, rooms, assignments),
    ...buildPmsAuditRecords(context),
  ].sort((left, right) => recordKey(left).localeCompare(recordKey(right)));
  enforceSourceCoverage(context, records);
  return reconcileProductionPmsRecords(context, records);
}

function enforceSourceCoverage(context: PmsBuildContext, records: PmsTargetRecord[]): void {
  const covered = new Set(records.map((record) => `${record.sourceTable}:${record.sourceId}`));
  for (const source of context.rows) {
    let sourceId: string;
    try {
      sourceId = sourceIdentity(source);
    } catch (error) {
      context.blockers.push({
        code: "INVALID_SOURCE_ROW",
        source: `pms.${source.sourceTable}`,
        sourceId: String(source.rowOrdinal),
        message: error instanceof Error ? error.message : "Source identity is invalid",
      });
      continue;
    }
    if (covered.has(`${source.sourceTable}:${sourceId}`)) continue;
    if (
      context.blockers.some(
        (blocker) =>
          blocker.source === `pms.${source.sourceTable}` && blocker.sourceId === sourceId,
      )
    )
      continue;
    context.blockers.push({
      code: "UNMAPPED_SOURCE_ROW",
      source: `pms.${source.sourceTable}`,
      sourceId,
      message: "In-scope source row has no target provenance or explicit blocking disposition",
    });
  }
}

export function reconcileProductionPmsRecords(
  context: PmsBuildContext,
  candidates: PmsTargetRecord[],
): ProductionPmsPlan {
  const existing = new Map(context.target.records.map((row) => [targetKey(row), row]));
  const provenance = new Map(context.target.provenance.map((row) => [provenanceKey(row), row]));
  const accepted: PmsTargetRecord[] = [];
  const writes: PmsTargetRecord[] = [];
  const links: ProductionMigrationSourceLink[] = [];
  const duplicateKeys = new Set<string>();
  const firstByKey = new Map<string, PmsTargetRecord>();
  for (const candidate of candidates) {
    const key = recordKey(candidate);
    if (firstByKey.has(key)) duplicateKeys.add(key);
    else firstByKey.set(key, candidate);
  }
  for (const key of duplicateKeys)
    blocker(
      context,
      "DUPLICATE_TARGET_RECORD",
      firstByKey.get(key)!,
      "More than one source maps here",
    );
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
    if (duplicateKeys.has(key)) continue;
    const current = existing.get(key);
    const prior = provenance.get(provenanceKey(candidate));
    const action = reconcile(candidate, current, prior, context);
    if (action === "block") continue;
    accepted.push(candidate);
    if (action === "insert" || action === "update" || action === "unchanged")
      links.push(linkFor(candidate, prior, context, action));
    if (action === "insert" || action === "update") writes.push(candidate);
    if (action === "insert") counts.inserts += 1;
    else if (action === "update") counts.updates += 1;
    else if (action === "unchanged") counts.unchanged += 1;
    else if (action === "preserve_newer") counts.preservedNewerTarget += 1;
    else counts.preservedTargetDeletions += 1;
  }
  counts.plannedRecords = accepted.length;
  const parity = summarizeParity(context, accepted);
  const blockers = context.blockers.sort((left, right) =>
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
      blockers,
      parity,
    }),
    records: accepted,
    writes,
    provenance: links,
    blockers,
    parity,
    counts,
  };
}

function summarizeParity(
  context: PmsBuildContext,
  records: PmsTargetRecord[],
): ProductionPmsPlan["parity"] {
  const sourceCountsByProperty: Record<string, Record<string, number>> = {};
  for (const row of context.rows)
    incrementNested(sourceCountsByProperty, sourceProperty(context, row), row.sourceTable);
  const targetCountsByProperty: Record<string, Record<string, number>> = {};
  for (const record of records)
    incrementNested(
      targetCountsByProperty,
      typeof record.row["propertyId"] === "string" ? record.row["propertyId"] : "<migration>",
      record.targetTable,
    );
  const futureInventoryByProperty: ProductionPmsPlan["parity"]["futureInventoryByProperty"] = {};
  for (const record of records.filter((entry) => entry.targetTable === "inventory_days")) {
    const propertyId = String(record.row["propertyId"]);
    const current = futureInventoryByProperty[propertyId] ?? {
      days: 0,
      assigned: 0,
      blocked: 0,
      available: 0,
      stopSell: 0,
    };
    current.days += 1;
    current.assigned += number(record.row["assignedCount"]);
    current.blocked += number(record.row["blockedCount"]);
    current.available += number(record.row["availableCount"]);
    const freshness = record.row["sourceFreshness"] as
      | { legacy?: { linkedStopSell?: unknown } }
      | undefined;
    if (freshness?.legacy?.linkedStopSell === true) current.stopSell += 1;
    futureInventoryByProperty[propertyId] = current;
  }
  return {
    sourceTableCounts: countBy(context.rows, (row) => `pms.${row.sourceTable}`),
    targetTableCounts: countBy(
      records,
      (record) => `${record.targetProduct}.${record.targetTable}`,
    ),
    sourceCountsByProperty: sortNested(sourceCountsByProperty),
    targetCountsByProperty: sortNested(targetCountsByProperty),
    futureInventoryByProperty: Object.fromEntries(
      Object.entries(futureInventoryByProperty).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
}

function sourceProperty(context: PmsBuildContext, row: IdentitySourceRow): string {
  try {
    if (row.data["hotel_id"]) return propertyForHotel(context, row.data["hotel_id"]);
    const bookingId = String(row.data["booking_id"] ?? "").toLowerCase();
    if (bookingId) {
      const booking = context.bookingById.get(bookingId);
      if (booking) return propertyForHotel(context, booking.data["hotel_id"]);
    }
    const roomTypeId = String(row.data["room_type_id"] ?? "").toLowerCase();
    if (roomTypeId) {
      const roomType = context.roomTypeById.get(roomTypeId);
      if (roomType) return propertyForHotel(context, roomType.data["hotel_id"]);
    }
    if (row.sourceTable === "messages") {
      const thread = findSource(context, "message_threads", row.data["thread_id"]);
      return propertyForHotel(context, thread.data["hotel_id"]);
    }
    if (row.sourceTable === "message_attachments") {
      const message = findSource(context, "messages", row.data["message_id"]);
      const thread = findSource(context, "message_threads", message.data["thread_id"]);
      return propertyForHotel(context, thread.data["hotel_id"]);
    }
    if (row.sourceTable === "linked_inventory_group_members") {
      const roomType = context.roomTypeById.get(String(row.data["room_type_id"]).toLowerCase());
      if (roomType) return propertyForHotel(context, roomType.data["hotel_id"]);
    }
    if (row.sourceTable === "channex_webhook_events" && row.data["property_id"]) {
      const externalId = String(row.data["property_id"]).toLowerCase();
      const connection = (context.rowsByTable.get("channex_connections") ?? []).find(
        (entry) => String(entry.data["channex_property_id"] ?? "").toLowerCase() === externalId,
      );
      if (connection) return propertyForHotel(context, connection.data["hotel_id"]);
    }
  } catch {
    return "<unresolved>";
  }
  return "<unresolved>";
}

function findSource(context: PmsBuildContext, table: string, id: unknown): IdentitySourceRow {
  const row = (context.rowsByTable.get(table) ?? []).find(
    (entry) => String(entry.data["id"] ?? "").toLowerCase() === String(id ?? "").toLowerCase(),
  );
  if (!row) throw new Error(`${table} source is missing`);
  return row;
}

type Action = "insert" | "update" | "unchanged" | "preserve_newer" | "preserve_deletion" | "block";

function reconcile(
  candidate: PmsTargetRecord,
  current: ExistingPmsTargetRecord | undefined,
  prior: ProductionMigrationSourceLink | undefined,
  context: PmsBuildContext,
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
        "Target differs from unchanged provenance without a newer target timestamp",
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
      "Immutable target differs from source",
    );
    return "block";
  }
  if (!candidate.sourceUpdatedAt || !current.updatedAt) {
    blocker(
      context,
      "TARGET_FRESHNESS_UNKNOWN",
      candidate,
      "Cannot safely order source and target",
    );
    return "block";
  }
  const sourceTime = Date.parse(candidate.sourceUpdatedAt);
  const targetTime = Date.parse(current.updatedAt);
  if (targetTime > sourceTime) return "preserve_newer";
  if (targetTime === sourceTime) {
    blocker(context, "TARGET_EQUAL_TIME_CONFLICT", candidate, "Rows disagree at equal freshness");
    return "block";
  }
  return "update";
}

function linkFor(
  record: PmsTargetRecord,
  prior: ProductionMigrationSourceLink | undefined,
  context: PmsBuildContext,
  action: Action,
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
    lastMigratedAt:
      action === "update" ? context.completedAt : (prior?.lastMigratedAt ?? context.completedAt),
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

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = key(value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function incrementNested(
  target: Record<string, Record<string, number>>,
  outer: string,
  inner: string,
) {
  const values = target[outer] ?? {};
  values[inner] = (values[inner] ?? 0) + 1;
  target[outer] = values;
}

function sortNested(value: Record<string, Record<string, number>>) {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, counts]) => [key, Object.fromEntries(Object.entries(counts).sort())]),
  );
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function targetKey(row: { targetProduct: string; targetTable: string; targetId: string }): string {
  return `${row.targetProduct}:${row.targetTable}:${row.targetId}`;
}

function recordKey(row: PmsTargetRecord): string {
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
  context: PmsBuildContext,
  code: string,
  record: PmsTargetRecord,
  message: string,
): void {
  context.blockers.push({
    code,
    source: `${record.sourceDatabase}.${record.sourceTable}`,
    sourceId: record.sourceId,
    message,
  });
}
