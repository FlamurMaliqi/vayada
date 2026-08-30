import { createHash } from "node:crypto";

import { planProductionCatalogContent } from "./productionCatalogContentPlan.js";
import { planProductionCatalogCore } from "./productionCatalogCorePlan.js";
import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import { addBlocker, stableJson } from "./productionIdentitySourceValidation.js";
import {
  planCatalogOwnership,
  type PlannedCatalogSourceLink,
} from "./productionCatalogOwnership.js";
import { planProductionCatalogPresentation } from "./productionCatalogPresentationPlan.js";
import {
  reconcileProductionCatalog,
  type PreservedCatalogTarget,
  type ReconciledCatalogWrites,
} from "./productionCatalogReconciliation.js";
import type { ProductionCatalogTargetState } from "./productionCatalogTargetReader.js";

export type ProductionCatalogCounts = {
  properties: number;
  sourceLinks: number;
  slugs: number;
  domains: number;
  locations: number;
  profiles: number;
  amenities: number;
  contacts: number;
  policies: number;
  media: number;
  writes: number;
  preservedTarget: number;
};
export type ProductionCatalogPlan = {
  sourceLinks: PlannedCatalogSourceLink[];
  propertyIds: string[];
  writes: ReconciledCatalogWrites;
  preservedTarget: PreservedCatalogTarget[];
  blockers: IdentityMigrationBlocker[];
  counts: ProductionCatalogCounts;
  checksum: string;
};

export function buildProductionCatalogPlan(
  rows: IdentitySourceRow[],
  target: ProductionCatalogTargetState,
): ProductionCatalogPlan {
  const orderedRows = sortedBy(
    rows,
    (row) => `${row.sourceDatabase}:${row.sourceTable}:${row.rowOrdinal}:${stableJson(row.data)}`,
  );
  const ownership = planCatalogOwnership(orderedRows, target.sourceLinks);
  const core = planProductionCatalogCore(orderedRows, ownership);
  const content = planProductionCatalogContent(orderedRows, ownership, core);
  const presentation = planProductionCatalogPresentation(orderedRows, ownership, content, {
    domains: target.domains,
    mediaObjects: target.mediaObjects,
  });
  const reconciliation = reconcileProductionCatalog(core, content, presentation, target);
  const blockers = [...reconciliation.blockers];
  if (ownership.properties.length === 0)
    addBlocker(
      blockers,
      "EMPTY_PRODUCTION_CATALOG",
      "booking.booking_hotels",
      "none",
      "Attested source run contains no canonical Booking properties",
    );
  const desired = {
    sourceLinks: ownership.sourceLinks,
    properties: core.properties,
    slugs: core.slugs,
    domains: presentation.domains,
    locations: core.locations,
    profiles: content.profiles,
    amenities: content.amenities,
    contacts: content.contacts,
    policies: content.policies,
    media: presentation.media,
  };
  const counts = countPlan(desired, reconciliation.writes, reconciliation.preservedTarget.length);
  return {
    sourceLinks: ownership.sourceLinks,
    propertyIds: ownership.properties.map((row) => row.propertyId),
    writes: reconciliation.writes,
    preservedTarget: reconciliation.preservedTarget,
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
    counts,
    checksum: createHash("sha256").update(stableJson(desired)).digest("hex"),
  };
}

function countPlan(
  desired: ReconciledCatalogWrites & { sourceLinks: PlannedCatalogSourceLink[] },
  writes: ReconciledCatalogWrites,
  preservedTarget: number,
): ProductionCatalogCounts {
  return {
    properties: desired.properties.length,
    sourceLinks: desired.sourceLinks.length,
    slugs: desired.slugs.length,
    domains: desired.domains.length,
    locations: desired.locations.length,
    profiles: desired.profiles.length,
    amenities: desired.amenities.length,
    contacts: desired.contacts.length,
    policies: desired.policies.length,
    media: desired.media.length,
    writes: Object.values(writes).reduce((sum, values) => sum + values.length, 0),
    preservedTarget,
  };
}
