import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import {
  addBlocker,
  date,
  optionalDate,
  text,
  uuid,
} from "./productionIdentitySourceValidation.js";
import { stableCatalogId } from "./productionCatalogValues.js";

export type CatalogSourceSystem = "booking" | "pms" | "marketplace";
export type CatalogSourceRelationship = "canonical_input" | "operational_input" | "profile_input";
export type ExistingCatalogSourceLink = {
  propertyId: string;
  sourceSystem: CatalogSourceSystem;
  sourceTable: string;
  sourceId: string;
  relationship?: CatalogSourceRelationship;
  status?: "active" | "superseded" | "ignored";
  migrationRunId?: string | null;
  migrationPhase?: "prerequisites" | "complete" | null;
  migrationDisposition?: CatalogMigrationDisposition | null;
  migrationDispositionReason?: CatalogQuarantineReason | null;
};
export type PlannedCatalogSourceLink = ExistingCatalogSourceLink & {
  relationship: CatalogSourceRelationship;
  migrationDisposition: CatalogMigrationDisposition;
  migrationDispositionReason: CatalogQuarantineReason | null;
};
export type CatalogMigrationDisposition = "canonical" | "private_quarantine";
export type CatalogQuarantineReason =
  | "legacy_owner_quarantined"
  | "missing_canonical_property"
  | "ambiguous_canonical_property"
  | "duplicate_pms_property"
  | "duplicate_marketplace_profile";
export type CatalogOwnerLink = {
  organizationId: string;
  product: "booking" | "pms" | "marketplace";
  resourceType: "booking_hotel" | "pms_hotel" | "hotel_profile";
  resourceId: string;
  relationship: "owner" | "operator";
  status: "active" | "suspended" | "archived";
};
export type CatalogPropertySource = {
  sourceSystem: CatalogSourceSystem;
  sourceTable: string;
  sourceId: string;
  userId: string;
  propertyId: string;
  name: string;
  slug: string | null;
  status: string;
  ownershipQuarantined: boolean;
  ownerPublicEligible: boolean;
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
};
export type CatalogQuarantinedSource = {
  propertyId: string;
  sourceSystem: CatalogSourceSystem;
  sourceTable: string;
  sourceId: string;
  reason: CatalogQuarantineReason;
};
export type CatalogPropertyGroup = {
  propertyId: string;
  primary: CatalogPropertySource;
  booking: CatalogPropertySource | null;
  pms: CatalogPropertySource[];
  marketplace: CatalogPropertySource[];
  migrationDisposition: CatalogMigrationDisposition;
  migrationDispositionReason: CatalogQuarantineReason | null;
};
export type CatalogOwnershipPlan = {
  properties: CatalogPropertyGroup[];
  sourceLinks: PlannedCatalogSourceLink[];
  quarantinedSources: CatalogQuarantinedSource[];
  blockers: IdentityMigrationBlocker[];
};
type CatalogCandidate = {
  row: CatalogPropertySource;
  propertyId: string | null;
  strength: "strong" | "owner" | "quarantine" | "blocked";
  reason: CatalogQuarantineReason | null;
};

const TABLES = {
  booking: "booking_hotels",
  pms: "hotels",
  marketplace: "hotel_profiles",
} as const;
const QUARANTINE_REASONS = new Set<CatalogQuarantineReason>([
  "legacy_owner_quarantined",
  "missing_canonical_property",
  "ambiguous_canonical_property",
  "duplicate_pms_property",
  "duplicate_marketplace_profile",
]);

export function planCatalogOwnership(
  rows: IdentitySourceRow[],
  existingLinks: ExistingCatalogSourceLink[] = [],
  authoritativeOwnerLinks?: CatalogOwnerLink[],
): CatalogOwnershipPlan {
  const blockers: IdentityMigrationBlocker[] = [];
  const authUsers = new Map(
    rows
      .filter((row) => row.sourceDatabase === "auth" && row.sourceTable === "users")
      .flatMap((row) =>
        typeof row.data["id"] === "string" && typeof row.data["type"] === "string"
          ? [
              [
                row.data["id"].toLowerCase(),
                { type: row.data["type"], status: String(row.data["status"] ?? "") },
              ] as const,
            ]
          : [],
      ),
  );
  const authoritativeOwners = authoritativeOwnerLinks
    ? groupBy(authoritativeOwnerLinks, ownerKey)
    : undefined;
  const booking = parse(rows, "booking", blockers, authUsers, authoritativeOwners);
  const pms = parse(rows, "pms", blockers, authUsers, authoritativeOwners);
  const marketplace = parse(rows, "marketplace", blockers, authUsers, authoritativeOwners);
  const anchors = new Map(booking.map((row) => [row.sourceId, row]));
  const anchorsByUser = groupBy(booking, (row) => row.userId);
  const existing = new Map(existingLinks.map((link) => [sourceKey(link), link]));
  const groups = new Map(
    booking.map((row) => [
      row.sourceId,
      {
        propertyId: row.sourceId,
        primary: row,
        booking: row,
        pms: [],
        marketplace: [],
        migrationDisposition: "canonical",
        migrationDispositionReason: null,
      } as CatalogPropertyGroup,
    ]),
  );
  const sourceLinks: PlannedCatalogSourceLink[] = [];
  const quarantinedSources: CatalogQuarantinedSource[] = [];

  for (const row of booking) {
    const target = existing.get(sourceKey(row));
    const planned = link(row, row.sourceId, "canonical", null);
    if (target && target.propertyId !== row.sourceId)
      addBlocker(
        blockers,
        "CATALOG_SOURCE_LINK_CONFLICT",
        "booking.booking_hotels",
        row.sourceId,
        `Existing source link points to property ${target.propertyId}`,
      );
    validateRelationship(target, planned, blockers);
    sourceLinks.push(planned);
  }

  const candidates = [...pms, ...marketplace].map<CatalogCandidate>((row) => {
    const direct = row.sourceSystem === "pms" ? anchors.get(row.sourceId) : undefined;
    if (direct && direct.userId !== row.userId) {
      addBlocker(
        blockers,
        "PROPERTY_OWNER_CONFLICT",
        "pms.hotels",
        row.sourceId,
        "Matching Booking and PMS property IDs have different owners",
      );
      return { row, propertyId: null, strength: "blocked" as const, reason: null };
    }
    const target = existing.get(sourceKey(row));
    return {
      row,
      ...resolveCandidate(
        row,
        direct,
        anchorsByUser.get(row.userId) ?? [],
        target,
        anchors,
        blockers,
      ),
    };
  });

  const canonicalCandidates = groupBy(
    candidates.filter((candidate) => candidate.propertyId !== null),
    (candidate) => `${candidate.propertyId!}:${candidate.row.sourceSystem}`,
  );
  for (const sameType of canonicalCandidates.values()) {
    const strong = sameType.filter((candidate) => candidate.strength === "strong");
    const accepted = sameType.length === 1 ? sameType : strong.length === 1 ? strong : [];
    for (const candidate of sameType) {
      if (accepted.includes(candidate)) continue;
      candidate.propertyId = null;
      candidate.reason =
        candidate.row.sourceSystem === "pms"
          ? "duplicate_pms_property"
          : "duplicate_marketplace_profile";
    }
  }

  for (const candidate of candidates) {
    const { row } = candidate;
    const target = existing.get(sourceKey(row));
    if (!candidate.propertyId) {
      if (!candidate.reason) continue;
      const propertyId = privatePropertyId(row);
      const group: CatalogPropertyGroup = {
        propertyId,
        primary: row,
        booking: null,
        pms: row.sourceSystem === "pms" ? [row] : [],
        marketplace: row.sourceSystem === "marketplace" ? [row] : [],
        migrationDisposition: "private_quarantine",
        migrationDispositionReason: candidate.reason,
      };
      groups.set(propertyId, group);
      quarantinedSources.push({
        propertyId,
        sourceSystem: row.sourceSystem,
        sourceTable: row.sourceTable,
        sourceId: row.sourceId,
        reason: candidate.reason,
      });
      const planned = link(row, propertyId, "private_quarantine", candidate.reason);
      validateRelationship(target, planned, blockers);
      sourceLinks.push(planned);
      continue;
    }
    const group = groups.get(candidate.propertyId)!;
    if (row.sourceSystem === "pms") group.pms.push(row);
    else group.marketplace.push(row);
    const planned = link(row, candidate.propertyId, "canonical", null);
    validateRelationship(target, planned, blockers);
    sourceLinks.push(planned);
  }
  addDuplicateSlugs(booking, blockers);

  return {
    properties: sortedBy([...groups.values()], (row) => row.propertyId),
    sourceLinks: sortedBy(sourceLinks, sourceKey),
    quarantinedSources: sortedBy(quarantinedSources, sourceKey),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
}

function validateRelationship(
  target: ExistingCatalogSourceLink | undefined,
  planned: PlannedCatalogSourceLink,
  blockers: IdentityMigrationBlocker[],
): void {
  if (target?.status && target.status !== "active")
    addBlocker(
      blockers,
      "CATALOG_SOURCE_LINK_INACTIVE",
      `${planned.sourceSystem}.${planned.sourceTable}`,
      planned.sourceId,
      `Existing source link has status ${target.status}`,
    );
  if (target?.relationship && target.relationship !== planned.relationship)
    addBlocker(
      blockers,
      "CATALOG_SOURCE_RELATIONSHIP_CONFLICT",
      `${planned.sourceSystem}.${planned.sourceTable}`,
      planned.sourceId,
      `Existing relationship ${target.relationship} differs from ${planned.relationship}`,
    );
  if (target?.migrationDisposition && target.migrationDisposition !== planned.migrationDisposition)
    addBlocker(
      blockers,
      "CATALOG_SOURCE_DISPOSITION_CONFLICT",
      `${planned.sourceSystem}.${planned.sourceTable}`,
      planned.sourceId,
      `Existing disposition ${target.migrationDisposition} differs from ${planned.migrationDisposition}`,
    );
}

function parse(
  rows: IdentitySourceRow[],
  sourceSystem: CatalogSourceSystem,
  blockers: IdentityMigrationBlocker[],
  authUsers: ReadonlyMap<string, { type: string; status: string }>,
  authoritativeOwners?: ReadonlyMap<string, CatalogOwnerLink[]>,
): CatalogPropertySource[] {
  const sourceTable = TABLES[sourceSystem];
  return rows
    .filter((row) => row.sourceDatabase === sourceSystem && row.sourceTable === sourceTable)
    .flatMap((row) => {
      try {
        const sourceId = uuid(row.data["id"], "id");
        const status =
          sourceSystem === "booking"
            ? text(row.data["platform_status"], "platform_status")
            : sourceSystem === "marketplace"
              ? text(row.data["status"], "status")
              : "active";
        if (sourceSystem === "booking" && !["live", "demo", "test"].includes(status))
          throw new Error("platform_status is unsupported");
        if (
          sourceSystem === "marketplace" &&
          !["verified", "pending", "suspended", "rejected"].includes(status)
        )
          throw new Error("status is unsupported");
        const createdAt = date(row.data["created_at"], "created_at");
        const userId = uuid(row.data["user_id"], "user_id");
        const owner = authUsers.get(userId);
        const authoritative = authoritativeOwners?.get(ownerKey({ sourceSystem, sourceId }));
        if (authoritativeOwners && authoritative?.length !== 1) {
          addBlocker(
            blockers,
            authoritative?.length ? "AMBIGUOUS_CATALOG_OWNER" : "MISSING_CATALOG_OWNER",
            `${sourceSystem}.${sourceTable}`,
            sourceId,
            authoritative?.length
              ? "Source resolves to multiple authoritative target owners"
              : "Source has no authoritative target owner",
          );
          return [];
        }
        const ownerStatus = authoritative?.[0]?.status;
        return [
          {
            sourceSystem,
            sourceTable,
            sourceId,
            userId,
            propertyId: sourceId,
            name: text(row.data["name"], "name"),
            slug:
              sourceSystem === "marketplace"
                ? null
                : text(row.data["slug"], "slug").trim().toLowerCase(),
            status,
            ownershipQuarantined: authoritativeOwners
              ? ownerStatus !== "active"
              : !owner || owner.type !== "hotel",
            ownerPublicEligible: authoritativeOwners
              ? ownerStatus === "active"
              : owner?.type === "hotel" && owner.status === "verified",
            createdAt,
            updatedAt: optionalDate(row.data["updated_at"], "updated_at") ?? createdAt,
            data: row.data,
          },
        ];
      } catch (error) {
        addBlocker(
          blockers,
          "INVALID_CATALOG_SOURCE_ROW",
          `${sourceSystem}.${sourceTable}`,
          typeof row.data["id"] === "string" ? row.data["id"] : `row:${row.rowOrdinal}`,
          error instanceof Error ? error.message : "Invalid catalog source row",
        );
        return [];
      }
    });
}

function ownerKey(
  value: CatalogOwnerLink | { sourceSystem: CatalogSourceSystem; sourceId: string },
): string {
  if ("product" in value)
    return `${value.product}:${value.resourceType}:${value.resourceId.toLowerCase()}:${value.relationship}`;
  if (value.sourceSystem === "booking") return `booking:booking_hotel:${value.sourceId}:owner`;
  if (value.sourceSystem === "pms") return `pms:pms_hotel:${value.sourceId}:operator`;
  return `marketplace:hotel_profile:${value.sourceId}:owner`;
}

function resolveCandidate(
  row: CatalogPropertySource,
  direct: CatalogPropertySource | undefined,
  ownerAnchors: CatalogPropertySource[],
  target: ExistingCatalogSourceLink | undefined,
  anchors: Map<string, CatalogPropertySource>,
  blockers: IdentityMigrationBlocker[],
): {
  propertyId: string | null;
  strength: "strong" | "owner" | "quarantine";
  reason: CatalogQuarantineReason | null;
} {
  const strongCandidates = new Set<string>();
  if (direct) strongCandidates.add(direct.sourceId);
  const quarantineId = privatePropertyId(row);
  if (target?.migrationDisposition === "private_quarantine" && target.propertyId === quarantineId) {
    if (
      target.migrationDispositionReason &&
      !QUARANTINE_REASONS.has(target.migrationDispositionReason)
    ) {
      addBlocker(
        blockers,
        "CATALOG_SOURCE_DISPOSITION_CONFLICT",
        `${row.sourceSystem}.${row.sourceTable}`,
        row.sourceId,
        `Existing private disposition reason ${target.migrationDispositionReason} is unsupported`,
      );
      return { propertyId: null, strength: "quarantine", reason: null };
    }
    return {
      propertyId: null,
      strength: "quarantine",
      reason: target.migrationDispositionReason ?? quarantineReason(row, ownerAnchors),
    };
  }
  if (target) strongCandidates.add(target.propertyId);
  if (strongCandidates.size === 1) {
    const propertyId = [...strongCandidates][0]!;
    if (anchors.has(propertyId)) return { propertyId, strength: "strong", reason: null };
    addBlocker(
      blockers,
      "CATALOG_SOURCE_LINK_CONFLICT",
      `${row.sourceSystem}.${row.sourceTable}`,
      row.sourceId,
      `Existing source link points to missing canonical property ${propertyId}`,
    );
    return { propertyId: null, strength: "quarantine", reason: null };
  }
  if (strongCandidates.size > 1) {
    ambiguousCandidate(row, strongCandidates, blockers);
    return { propertyId: null, strength: "quarantine", reason: null };
  }

  const candidates = new Set(ownerAnchors.map((anchor) => anchor.sourceId));
  const accepted = [...candidates].filter((candidate) => anchors.has(candidate)).sort();
  if (accepted.length === 1 && accepted.length === candidates.size)
    return { propertyId: accepted[0]!, strength: "owner", reason: null };
  return {
    propertyId: null,
    strength: "quarantine",
    reason: quarantineReason(row, ownerAnchors),
  };
}

function quarantineReason(
  row: CatalogPropertySource,
  ownerAnchors: CatalogPropertySource[],
): CatalogQuarantineReason {
  if (row.ownershipQuarantined) return "legacy_owner_quarantined";
  return ownerAnchors.length === 0 ? "missing_canonical_property" : "ambiguous_canonical_property";
}

function privatePropertyId(row: CatalogPropertySource): string {
  return stableCatalogId("private-property", sourceKey(row));
}

function ambiguousCandidate(
  row: CatalogPropertySource,
  candidates: Set<string>,
  blockers: IdentityMigrationBlocker[],
): null {
  addBlocker(
    blockers,
    "AMBIGUOUS_CANONICAL_PROPERTY",
    `${row.sourceSystem}.${row.sourceTable}`,
    row.sourceId,
    `Source resolves to multiple properties: ${[...candidates].sort().join(", ")}`,
  );
  return null;
}

function addDuplicateSlugs(
  rows: CatalogPropertySource[],
  blockers: IdentityMigrationBlocker[],
): void {
  const owners = groupBy(
    rows.filter((row) => row.slug),
    (row) => row.slug!,
  );
  for (const [slug, sources] of owners)
    if (new Set(sources.map((row) => row.sourceId)).size > 1)
      addBlocker(
        blockers,
        "DUPLICATE_CANONICAL_SLUG",
        "booking.booking_hotels",
        slug,
        "Canonical slug belongs to multiple Booking properties",
      );
}

function link(
  row: CatalogPropertySource,
  propertyId: string,
  migrationDisposition: CatalogMigrationDisposition,
  migrationDispositionReason: CatalogQuarantineReason | null,
): PlannedCatalogSourceLink {
  return {
    propertyId,
    sourceSystem: row.sourceSystem,
    sourceTable: row.sourceTable,
    sourceId: row.sourceId,
    relationship:
      row.sourceSystem === "booking"
        ? "canonical_input"
        : row.sourceSystem === "pms"
          ? "operational_input"
          : "profile_input",
    migrationDisposition,
    migrationDispositionReason,
  };
}

function sourceKey(link: {
  sourceSystem: CatalogSourceSystem;
  sourceTable: string;
  sourceId: string;
}): string {
  return `${link.sourceSystem}:${link.sourceTable}:${link.sourceId}`;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}
