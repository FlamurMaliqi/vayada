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

export type CatalogSourceSystem = "booking" | "pms" | "marketplace";
export type CatalogSourceRelationship = "canonical_input" | "operational_input" | "profile_input";
export type ExistingCatalogSourceLink = {
  propertyId: string;
  sourceSystem: CatalogSourceSystem;
  sourceTable: string;
  sourceId: string;
  relationship?: CatalogSourceRelationship;
  migrationRunId?: string | null;
};
export type PlannedCatalogSourceLink = ExistingCatalogSourceLink & {
  relationship: CatalogSourceRelationship;
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
  createdAt: string;
  updatedAt: string;
  data: Record<string, unknown>;
};
export type CatalogPropertyGroup = {
  propertyId: string;
  booking: CatalogPropertySource;
  pms: CatalogPropertySource[];
  marketplace: CatalogPropertySource[];
};
export type CatalogOwnershipPlan = {
  properties: CatalogPropertyGroup[];
  sourceLinks: PlannedCatalogSourceLink[];
  blockers: IdentityMigrationBlocker[];
};

const TABLES = {
  booking: "booking_hotels",
  pms: "hotels",
  marketplace: "hotel_profiles",
} as const;

export function planCatalogOwnership(
  rows: IdentitySourceRow[],
  existingLinks: ExistingCatalogSourceLink[] = [],
): CatalogOwnershipPlan {
  const blockers: IdentityMigrationBlocker[] = [];
  const booking = parse(rows, "booking", blockers);
  const pms = parse(rows, "pms", blockers);
  const marketplace = parse(rows, "marketplace", blockers);
  const anchors = new Map(booking.map((row) => [row.sourceId, row]));
  const anchorsByUser = groupBy(booking, (row) => row.userId);
  const existing = new Map(existingLinks.map((link) => [sourceKey(link), link]));
  const groups = new Map(
    booking.map((row) => [
      row.sourceId,
      { propertyId: row.sourceId, booking: row, pms: [], marketplace: [] } as CatalogPropertyGroup,
    ]),
  );
  const sourceLinks: PlannedCatalogSourceLink[] = [];

  for (const row of booking) {
    const target = existing.get(sourceKey(row));
    const planned = link(row, row.sourceId);
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

  for (const row of [...pms, ...marketplace]) {
    const candidates = new Set<string>();
    const direct = row.sourceSystem === "pms" ? anchors.get(row.sourceId) : undefined;
    if (direct && direct.userId !== row.userId) {
      addBlocker(
        blockers,
        "PROPERTY_OWNER_CONFLICT",
        "pms.hotels",
        row.sourceId,
        "Matching Booking and PMS property IDs have different owners",
      );
      continue;
    }
    if (direct) candidates.add(row.sourceId);
    for (const anchor of anchorsByUser.get(row.userId) ?? []) candidates.add(anchor.sourceId);
    const target = existing.get(sourceKey(row));
    if (target) candidates.add(target.propertyId);
    const propertyId = onlyCandidate(row, candidates, anchors, blockers);
    if (!propertyId) continue;
    const group = groups.get(propertyId)!;
    if (row.sourceSystem === "pms") group.pms.push(row);
    else group.marketplace.push(row);
    const planned = link(row, propertyId);
    validateRelationship(target, planned, blockers);
    sourceLinks.push(planned);
  }

  for (const group of groups.values()) {
    if (group.pms.length > 1)
      addBlocker(
        blockers,
        "DUPLICATE_PMS_PROPERTY",
        "pms.hotels",
        group.propertyId,
        "Multiple PMS hotels resolve to one canonical property",
      );
    if (group.marketplace.length > 1)
      addBlocker(
        blockers,
        "DUPLICATE_MARKETPLACE_PROFILE",
        "marketplace.hotel_profiles",
        group.propertyId,
        "Multiple Marketplace profiles resolve to one canonical property",
      );
  }
  addDuplicateSlugs(booking, blockers);

  return {
    properties: sortedBy([...groups.values()], (row) => row.propertyId),
    sourceLinks: sortedBy(sourceLinks, sourceKey),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
}

function validateRelationship(
  target: ExistingCatalogSourceLink | undefined,
  planned: PlannedCatalogSourceLink,
  blockers: IdentityMigrationBlocker[],
): void {
  if (target?.relationship && target.relationship !== planned.relationship)
    addBlocker(
      blockers,
      "CATALOG_SOURCE_RELATIONSHIP_CONFLICT",
      `${planned.sourceSystem}.${planned.sourceTable}`,
      planned.sourceId,
      `Existing relationship ${target.relationship} differs from ${planned.relationship}`,
    );
}

function parse(
  rows: IdentitySourceRow[],
  sourceSystem: CatalogSourceSystem,
  blockers: IdentityMigrationBlocker[],
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
        return [
          {
            sourceSystem,
            sourceTable,
            sourceId,
            userId: uuid(row.data["user_id"], "user_id"),
            propertyId: sourceId,
            name: text(row.data["name"], "name"),
            slug:
              sourceSystem === "marketplace"
                ? null
                : text(row.data["slug"], "slug").trim().toLowerCase(),
            status,
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

function onlyCandidate(
  row: CatalogPropertySource,
  candidates: Set<string>,
  anchors: Map<string, CatalogPropertySource>,
  blockers: IdentityMigrationBlocker[],
): string | null {
  const accepted = [...candidates].filter((candidate) => anchors.has(candidate)).sort();
  if (accepted.length === 1 && accepted.length === candidates.size) return accepted[0]!;
  addBlocker(
    blockers,
    accepted.length === 0 ? "MISSING_CANONICAL_PROPERTY" : "AMBIGUOUS_CANONICAL_PROPERTY",
    `${row.sourceSystem}.${row.sourceTable}`,
    row.sourceId,
    accepted.length === 0
      ? "No exact ID or owner link resolves to a Booking property"
      : `Source resolves to multiple properties: ${accepted.join(", ")}`,
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

function link(row: CatalogPropertySource, propertyId: string): PlannedCatalogSourceLink {
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
