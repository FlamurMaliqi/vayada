import { createHash } from "node:crypto";

import type { IdentityMigrationBlocker } from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import { addBlocker, stableJson } from "./productionIdentitySourceValidation.js";
import type {
  PlannedCatalogAmenity,
  PlannedCatalogContact,
  PlannedCatalogPolicy,
  PlannedCatalogProfile,
  ProductionCatalogContentPlan,
} from "./productionCatalogContentPlan.js";
import type {
  PlannedCatalogLocation,
  PlannedCatalogProperty,
  PlannedCatalogSlug,
  ProductionCatalogCorePlan,
} from "./productionCatalogCorePlan.js";
import type {
  PlannedCatalogDomain,
  PlannedCatalogMediaAssignment,
  ProductionCatalogPresentationPlan,
} from "./productionCatalogPresentationPlan.js";
import type {
  CatalogTargetRow,
  ProductionCatalogTargetState,
} from "./productionCatalogTargetReader.js";

export type PreservedCatalogTarget = {
  entity: string;
  key: string;
  reason: "identical" | "target_newer" | "target_owner_revision" | "target_removed";
  sourceUpdatedAt: string;
  targetUpdatedAt: string | null;
};
export type ReconciledCatalogWrites = {
  properties: PlannedCatalogProperty[];
  slugs: PlannedCatalogSlug[];
  domains: PlannedCatalogDomain[];
  locations: PlannedCatalogLocation[];
  profiles: PlannedCatalogProfile[];
  amenities: PlannedCatalogAmenity[];
  contacts: PlannedCatalogContact[];
  policies: PlannedCatalogPolicy[];
  media: PlannedCatalogMediaAssignment[];
};
export type ProductionCatalogReconciliation = {
  writes: ReconciledCatalogWrites;
  preservedTarget: PreservedCatalogTarget[];
  blockers: IdentityMigrationBlocker[];
  checksum: string;
};

export function reconcileProductionCatalog(
  core: ProductionCatalogCorePlan,
  content: ProductionCatalogContentPlan,
  presentation: ProductionCatalogPresentationPlan,
  target: ProductionCatalogTargetState,
): ProductionCatalogReconciliation {
  const blockers = [...presentation.blockers];
  const preservedTarget: PreservedCatalogTarget[] = [];
  const revisions = new Map(
    target.ownerRevisions.map((row) => [`${row.propertyId}:${row.ownerKey}`, Number(row.revision)]),
  );
  const migratedProperties = new Set(
    target.sourceLinks
      .filter(
        (row) =>
          row.migrationPhase !== "prerequisites" &&
          VAY1351_RUN.test(row.migrationRunId ?? "") &&
          (row.migrationDisposition === "canonical" ||
            row.migrationDisposition === "private_quarantine" ||
            (row.sourceSystem === "booking" &&
              row.sourceTable === "booking_hotels" &&
              row.propertyId === row.sourceId)),
      )
      .map((row) => row.propertyId),
  );
  const currentProperties = new Map(target.properties.map((row) => [String(row["id"]), row]));
  for (const property of core.properties) {
    const current = currentProperties.get(property.id);
    if (property.profileStatus === "private" && current && current["profileStatus"] !== "private")
      addBlocker(
        blockers,
        "CATALOG_PRIVATE_DISPOSITION_CONFLICT",
        "hotel_catalog.properties",
        property.id,
        "Target property is public-capable but the reviewed migration disposition is private",
      );
  }
  const sourceSlugs = protectCanonicalSlugs(core.slugs, target.slugs, blockers);
  const reconcile = <T extends { updatedAt: string }>(
    entity: string,
    source: T[],
    current: unknown[],
    key: (row: Record<string, unknown>) => string,
    fields: string[],
    ownerKey?: "hotel_catalog.location" | "hotel_catalog.policy",
  ): T[] =>
    reconcileRows(
      entity,
      source,
      current,
      key,
      fields,
      ownerKey,
      revisions,
      migratedProperties,
      preservedTarget,
      blockers,
    );

  const writes: ReconciledCatalogWrites = {
    properties: reconcile("properties", core.properties, target.properties, by("id"), [
      "publicId",
      "displayName",
      "propertyType",
      "category",
      "starRating",
      "defaultLocale",
      "supportedLocales",
    ]),
    slugs: reconcile("property_slugs", sourceSlugs, target.slugs, by("slug"), [
      "propertyId",
      "purpose",
      "status",
      "redirectsToId",
    ]),
    domains: reconcile("property_domains", presentation.domains, target.domains, by("hostname"), [
      "propertyId",
      "verificationStatus",
      "canonicalWhenVerified",
      "verifiedAt",
    ]),
    locations: reconcile(
      "property_locations",
      core.locations,
      target.locations,
      by("propertyId"),
      [
        "countryCode",
        "region",
        "city",
        "streetAddress",
        "postalCode",
        "rawMarketplaceLocation",
        "latitude",
        "longitude",
        "timezone",
        "sourceConfidence",
        "migrationNotes",
      ],
      "hotel_catalog.location",
    ),
    profiles: reconcile(
      "property_profiles",
      content.profiles,
      target.profiles,
      compound("propertyId", "locale"),
      ["shortDescription", "longDescription", "sourceConfidence"],
    ),
    amenities: reconcile(
      "property_amenities",
      content.amenities,
      target.amenities,
      compound("propertyId", "amenityKey"),
      ["label", "sourceSystem"],
    ),
    contacts: reconcile(
      "property_contact_channels",
      content.contacts,
      target.contacts,
      compound("propertyId", "channelType", "value"),
      ["sourceSystem"],
    ),
    policies: reconcile(
      "property_policy_summaries",
      content.policies,
      target.policies,
      by("propertyId"),
      ["checkInTime", "checkOutTime", "cancellationSummary", "paymentPolicySummary"],
      "hotel_catalog.policy",
    ),
    media: reconcile("property_media", presentation.media, target.media, by("id"), [
      "propertyId",
      "platformMediaObjectId",
      "mediaType",
      "sortOrder",
      "sourceSystem",
    ]),
  };
  const result = {
    writes,
    preservedTarget: sortedBy(preservedTarget, (row) => `${row.entity}:${row.key}`),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
  return { ...result, checksum: createHash("sha256").update(stableJson(result)).digest("hex") };
}

function protectCanonicalSlugs(
  source: PlannedCatalogSlug[],
  target: CatalogTargetRow[],
  blockers: IdentityMigrationBlocker[],
): PlannedCatalogSlug[] {
  const canonical = new Map(
    target
      .filter((row) => row.purpose === "canonical" && row.status === "active")
      .map((row) => [String(row.propertyId), String(row.slug)]),
  );
  return source.filter((row) => {
    const current = row.purpose === "canonical" ? canonical.get(row.propertyId) : undefined;
    if (!current || current === row.slug) return true;
    addBlocker(
      blockers,
      "CATALOG_CANONICAL_SLUG_CONFLICT",
      "hotel_catalog.property_slugs",
      row.propertyId,
      `Target canonical slug ${current} differs from legacy slug ${row.slug}`,
    );
    return false;
  });
}

function reconcileRows<T extends { updatedAt: string }>(
  entity: string,
  source: T[],
  target: unknown[],
  key: (row: Record<string, unknown>) => string,
  fields: string[],
  ownerKey: "hotel_catalog.location" | "hotel_catalog.policy" | undefined,
  revisions: Map<string, number>,
  migratedProperties: Set<string>,
  preserved: PreservedCatalogTarget[],
  blockers: IdentityMigrationBlocker[],
): T[] {
  const current = new Map(target.map((row) => [key(record(row)), record(row)]));
  const writes: T[] = [];
  for (const row of source) {
    const sourceRecord = record(row);
    const rowKey = key(sourceRecord);
    const existing = current.get(rowKey);
    if (!existing) {
      const propertyId = typeof sourceRecord.propertyId === "string" ? sourceRecord.propertyId : "";
      if (migratedProperties.has(propertyId)) {
        if (
          entity === "property_slugs" &&
          sourceRecord.purpose === "canonical" &&
          sourceRecord.status === "active"
        )
          addBlocker(
            blockers,
            "CATALOG_REQUIRED_TARGET_ROW_REMOVED",
            `hotel_catalog.${entity}`,
            rowKey,
            "Previously migrated canonical target row is now absent",
          );
        else
          preserved.push({
            entity,
            key: rowKey,
            reason: "target_removed",
            sourceUpdatedAt: row.updatedAt,
            targetUpdatedAt: null,
          });
        continue;
      }
      writes.push(row);
      continue;
    }
    if ("propertyId" in sourceRecord && existing.propertyId !== sourceRecord.propertyId) {
      addBlocker(
        blockers,
        "CATALOG_TARGET_OWNERSHIP_CONFLICT",
        `hotel_catalog.${entity}`,
        rowKey,
        "Target key belongs to another canonical property",
      );
      continue;
    }
    const sourceTime = timestamp(row.updatedAt, `${entity} source updatedAt`);
    const targetUpdatedAt = String(existing.updatedAt);
    const targetTime = timestamp(targetUpdatedAt, `${entity} target updatedAt`);
    const revision = ownerKey ? (revisions.get(`${sourceRecord.propertyId}:${ownerKey}`) ?? 0) : 0;
    if (revision > 1) preserve("target_owner_revision");
    else if (targetTime > sourceTime) preserve("target_newer");
    else if (targetTime === sourceTime) {
      if (sameOwnedFields(sourceRecord, existing, fields)) preserve("identical");
      else
        addBlocker(
          blockers,
          "CATALOG_EQUAL_TIME_CONFLICT",
          `hotel_catalog.${entity}`,
          rowKey,
          "Source and target disagree at equal freshness",
        );
    } else writes.push(row);

    function preserve(reason: PreservedCatalogTarget["reason"]): void {
      preserved.push({
        entity,
        key: rowKey,
        reason,
        sourceUpdatedAt: row.updatedAt,
        targetUpdatedAt,
      });
    }
  }
  return writes;
}

function sameOwnedFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  fields: string[],
): boolean {
  return fields.every(
    (field) =>
      stableJson(normalize(field, source[field])) === stableJson(normalize(field, target[field])),
  );
}
function normalize(field: string, value: unknown): unknown {
  if (value == null) return null;
  if (["starRating", "latitude", "longitude", "sortOrder"].includes(field)) return Number(value);
  if (["checkInTime", "checkOutTime"].includes(field) && typeof value === "string")
    return value.slice(0, 5);
  return value;
}
function timestamp(value: string, field: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`${field} is not a timestamp`);
  return result;
}
function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
function by(field: string): (row: Record<string, unknown>) => string {
  return (row) => String(row[field]);
}
function compound(...fields: string[]): (row: Record<string, unknown>) => string {
  return (row) => fields.map((field) => String(row[field])).join(":");
}

const VAY1351_RUN = /^vay1351-[0-9a-f]{24}$/;
