import { transformLegacyOffersToMarketplacePreferenceDraft } from "@vayada/domain-marketplace";

import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { sha256, uuid } from "./productionBookingValues.js";
import type { ProductionMigrationSourceLink } from "./productionBookingTypes.js";
import {
  block,
  collaborationScope,
  createProductionMarketplaceContext,
  hotelScope,
  offerScope,
  sourceIdentity,
} from "./productionMarketplaceContext.js";
import { buildMarketplaceRecords } from "./productionMarketplaceRecords.js";
import type {
  ExistingMarketplaceTargetRecord,
  MarketplaceBuildContext,
  MarketplaceTargetRecord,
  ProductionMarketplacePlan,
  ProductionMarketplaceTargetState,
} from "./productionMarketplaceTypes.js";

export function buildProductionMarketplacePlan(input: {
  sourceRunId: string;
  completedAt: string;
  rows: IdentitySourceRow[];
  target: ProductionMarketplaceTargetState;
}): ProductionMarketplacePlan {
  const context = createProductionMarketplaceContext(input);
  const candidates = buildMarketplaceRecords(context).sort((left, right) =>
    targetKey(left).localeCompare(targetKey(right)),
  );
  enforceSourceCoverage(context, candidates);
  return reconcileProductionMarketplaceRecords(context, candidates);
}

function enforceSourceCoverage(
  context: MarketplaceBuildContext,
  records: MarketplaceTargetRecord[],
): void {
  const covered = new Set(records.map((record) => `${record.sourceTable}:${record.sourceId}`));
  for (const source of context.rows) {
    let sourceId: string;
    try {
      sourceId = sourceIdentity(source);
    } catch (error) {
      block(
        context,
        "INVALID_SOURCE_ROW",
        `marketplace.${source.sourceTable}`,
        String(source.rowOrdinal),
        error instanceof Error ? error.message : "Source identity is invalid",
      );
      continue;
    }
    if (covered.has(`${source.sourceTable}:${sourceId}`)) continue;
    if (
      context.blockers.some(
        (blocker) =>
          blocker.source === `marketplace.${source.sourceTable}` && blocker.sourceId === sourceId,
      )
    )
      continue;
    block(
      context,
      "UNMAPPED_SOURCE_ROW",
      `marketplace.${source.sourceTable}`,
      sourceId,
      "In-scope source row has no target provenance or explicit blocking disposition",
    );
  }
}

export function reconcileProductionMarketplaceRecords(
  context: MarketplaceBuildContext,
  candidates: MarketplaceTargetRecord[],
): ProductionMarketplacePlan {
  const existing = new Map(context.target.records.map((row) => [targetKey(row), row]));
  const provenance = new Map(context.target.provenance.map((row) => [provenanceKey(row), row]));
  const duplicateKeys = duplicateTargetKeys(candidates);
  for (const key of duplicateKeys) {
    const candidate = candidates.find((row) => targetKey(row) === key)!;
    addRecordBlocker(
      context,
      "DUPLICATE_TARGET_RECORD",
      candidate,
      "More than one source maps here",
    );
  }

  const accepted: MarketplaceTargetRecord[] = [];
  const writes: MarketplaceTargetRecord[] = [];
  const links: ProductionMigrationSourceLink[] = [];
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
    if (duplicateKeys.has(targetKey(candidate))) continue;
    const action = reconcile(
      candidate,
      existing.get(targetKey(candidate)),
      provenance.get(provenanceKey(candidate)),
      context,
    );
    if (action === "block") continue;
    accepted.push(candidate);
    if (action === "insert" || action === "update" || action === "unchanged")
      links.push(linkFor(candidate, provenance.get(provenanceKey(candidate)), context, action));
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
        key: targetKey(record),
        sourceChecksum: record.sourceChecksum,
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

type Action = "insert" | "update" | "unchanged" | "preserve_newer" | "preserve_deletion" | "block";

function reconcile(
  candidate: MarketplaceTargetRecord,
  current: ExistingMarketplaceTargetRecord | undefined,
  prior: ProductionMigrationSourceLink | undefined,
  context: MarketplaceBuildContext,
): Action {
  if (prior) {
    if (!current) return "preserve_deletion";
    if (prior.sourceChecksum === candidate.sourceChecksum) {
      if (sameRecord(candidate.row, current.row)) return "unchanged";
      if (Date.parse(current.updatedAt) > Date.parse(prior.lastMigratedAt)) return "preserve_newer";
      addRecordBlocker(
        context,
        "TARGET_PROVENANCE_MISMATCH",
        candidate,
        "Target differs from unchanged provenance without a newer target timestamp",
      );
      return "block";
    }
    if (Date.parse(current.updatedAt) > Date.parse(prior.lastMigratedAt)) return "preserve_newer";
    return "update";
  }
  if (!current) return "insert";
  if (sameRecord(candidate.row, current.row)) return "unchanged";
  const sourceTime = Date.parse(candidate.sourceUpdatedAt);
  const targetTime = Date.parse(current.updatedAt);
  if (targetTime > sourceTime) {
    addRecordBlocker(
      context,
      "TARGET_NEWER_WITHOUT_PROVENANCE",
      candidate,
      "Newer target has no durable migration disposition; review ownership before cutover",
    );
    return "block";
  }
  if (targetTime === sourceTime) {
    addRecordBlocker(
      context,
      "TARGET_EQUAL_TIME_CONFLICT",
      candidate,
      "Rows disagree at equal freshness",
    );
    return "block";
  }
  return "update";
}

function linkFor(
  record: MarketplaceTargetRecord,
  prior: ProductionMigrationSourceLink | undefined,
  context: MarketplaceBuildContext,
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

function summarizeParity(
  context: MarketplaceBuildContext,
  records: MarketplaceTargetRecord[],
): ProductionMarketplacePlan["parity"] {
  const sourceCountsByProperty: Record<string, Record<string, number>> = {};
  for (const row of context.rows)
    increment(sourceCountsByProperty, sourceProperty(context, row), row.sourceTable);
  const targetCountsByProperty: Record<string, Record<string, number>> = {};
  for (const record of records)
    increment(
      targetCountsByProperty,
      typeof record.row["propertyId"] === "string" ? String(record.row["propertyId"]) : "<creator>",
      record.targetTable,
    );
  return {
    sourceTableCounts: countBy(context.rows, (row) => `marketplace.${row.sourceTable}`),
    targetTableCounts: countBy(records, (row) => `marketplace.${row.targetTable}`),
    sourceCountsByProperty: sortNested(sourceCountsByProperty),
    targetCountsByProperty: sortNested(targetCountsByProperty),
    preferenceDraftsByProperty: preferenceDrafts(context, records),
  };
}

function preferenceDrafts(
  context: MarketplaceBuildContext,
  records: MarketplaceTargetRecord[],
): ProductionMarketplacePlan["parity"]["preferenceDraftsByProperty"] {
  const offers = records.filter((record) => record.targetTable === "marketplace_offers");
  const options = records.filter((record) => record.targetTable === "offer_compensation_options");
  const canonical = new Map(
    context.target.hotelPreferences.map((preference) => [
      preference.propertyId,
      preference.revision,
    ]),
  );
  const grouped = new Map<string, MarketplaceTargetRecord[]>();
  for (const offer of offers) {
    const propertyId = String(offer.row["propertyId"]);
    const rows = grouped.get(propertyId);
    if (rows) rows.push(offer);
    else grouped.set(propertyId, [offer]);
  }
  const result: ProductionMarketplacePlan["parity"]["preferenceDraftsByProperty"] = {};
  for (const [propertyId, propertyOffers] of [...grouped].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const evidence = propertyOffers.map((offer) => ({
      offerId: offer.targetId,
      updatedAt: offer.sourceUpdatedAt,
      compensationOptions: options
        .filter((option) => option.row["offerId"] === offer.targetId)
        .map((option) => ({
          compensationOptionId: option.targetId,
          compensationType: String(option.row["compensationType"]),
          availabilityMonths: option.row["availabilityMonths"] as string[],
          platforms: option.row["platforms"] as string[],
        })),
    }));
    const draft = transformLegacyOffersToMarketplacePreferenceDraft(evidence);
    if (draft)
      result[propertyId] = {
        draft,
        canonicalTargetRevision: canonical.get(propertyId) ?? null,
      };
  }
  return result;
}

function sourceProperty(context: MarketplaceBuildContext, row: IdentitySourceRow): string {
  try {
    if (row.sourceTable === "hotel_profiles") return hotelScope(context, row.data["id"]).propertyId;
    if (row.sourceTable === "hotel_listings")
      return hotelScope(context, row.data["hotel_profile_id"]).propertyId;
    if (
      row.sourceTable === "listing_collaboration_offerings" ||
      row.sourceTable === "listing_creator_requirements"
    )
      return offerScope(context, row.data["listing_id"]).propertyId;
    if (row.sourceTable === "collaborations")
      return collaborationScope(context, row.data["id"]).propertyId;
    if (row.sourceTable === "creator_ratings")
      return hotelScope(context, row.data["hotel_id"]).propertyId;
    if (row.sourceTable === "collaboration_deliverables" || row.sourceTable === "chat_messages")
      return collaborationScope(context, row.data["collaboration_id"]).propertyId;
    if (row.sourceTable === "invite_codes") return "<global>";
    if (row.sourceTable === "notifications" || row.sourceTable === "newsletter_preferences")
      return "<global>";
    uuid(row.data["id"], "id");
    return "<creator>";
  } catch {
    return "<unresolved>";
  }
}

function duplicateTargetKeys(records: MarketplaceTargetRecord[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const record of records) {
    const key = targetKey(record);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return duplicates;
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

function addRecordBlocker(
  context: MarketplaceBuildContext,
  code: string,
  record: MarketplaceTargetRecord,
  message: string,
): void {
  block(context, code, `${record.sourceDatabase}.${record.sourceTable}`, record.sourceId, message);
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = key(value);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function increment(
  target: Record<string, Record<string, number>>,
  outer: string,
  inner: string,
): void {
  const group = target[outer] ?? {};
  group[inner] = (group[inner] ?? 0) + 1;
  target[outer] = group;
}

function sortNested(
  value: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, counts]) => [key, Object.fromEntries(Object.entries(counts).sort())]),
  );
}
