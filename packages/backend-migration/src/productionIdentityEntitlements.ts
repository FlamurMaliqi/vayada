import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";
import {
  isNewer,
  newest,
  resourceIdentity,
  sortedBy,
} from "./productionIdentityOwnershipPolicy.js";
import type {
  OrganizationStatus,
  PlannedResourceLink,
} from "./productionIdentityOwnershipSource.js";

type EntitlementStatus = "active" | "suspended" | "expired";
type JsonRecord = Record<string, unknown>;

export type ExistingEntitlement = {
  organizationId: string;
  product: string;
  entitlementKey: string;
  status: EntitlementStatus;
  resourceProduct: string;
  resourceType: string;
  resourceId: string;
  startsAt: string | null;
  expiresAt: string | null;
  metadata: JsonRecord;
  createdAt: string;
  updatedAt: string;
};
export type PlannedEntitlement = ExistingEntitlement;
export type IdentityEntitlementPlan = {
  entitlements: PlannedEntitlement[];
  blockers: IdentityMigrationBlocker[];
};

const BASE_ENTITLEMENTS: Record<string, { product: string; entitlementKey: string }> = {
  "booking:booking_hotel": { product: "booking", entitlementKey: "booking-engine" },
  "marketplace:hotel_profile": {
    product: "marketplace",
    entitlementKey: "marketplace-hotel-profile",
  },
  "marketplace:creator_profile": {
    product: "marketplace",
    entitlementKey: "marketplace-creator-profile",
  },
  "affiliate:affiliate": { product: "affiliate", entitlementKey: "affiliate-payouts" },
};

export function planIdentityEntitlements(
  rows: IdentitySourceRow[],
  resourceLinks: PlannedResourceLink[],
  existing: ExistingEntitlement[] = [],
): IdentityEntitlementPlan {
  const blockers: IdentityMigrationBlocker[] = [];
  const generated: PlannedEntitlement[] = [];
  for (const link of resourceLinks) {
    const definition = BASE_ENTITLEMENTS[`${link.product}:${link.resourceType}`];
    if (!definition) continue;
    generated.push({
      organizationId: link.organizationId,
      ...definition,
      status: entitlementStatus(link.status),
      resourceProduct: link.product,
      resourceType: link.resourceType,
      resourceId: link.resourceId,
      startsAt: null,
      expiresAt: null,
      metadata: { source: "legacy_ownership" },
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    });
  }

  const pmsLinks = new Map(
    resourceLinks
      .filter((link) => link.product === "pms" && link.resourceType === "pms_hotel")
      .map((link) => [resourceIdentity(link), link]),
  );
  for (const row of rows.filter(
    (item) => item.sourceDatabase === "pms" && item.sourceTable === "property_module_activations",
  )) {
    try {
      const hotelId = uuid(row.data["hotel_id"], "hotel_id");
      const moduleId = text(row.data["module_id"], "module_id");
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(moduleId)) throw new Error("module_id is invalid");
      const link = pmsLinks.get(`pms:pms_hotel:${hotelId}`);
      if (!link) {
        block(
          blockers,
          "ORPHAN_ENTITLEMENT",
          row,
          `PMS module ${moduleId} has no accepted hotel owner`,
        );
        continue;
      }
      const active = bool(row.data["is_active"], "is_active");
      const startsAt = optionalDate(row.data["activated_at"], "activated_at");
      const expiresAt = optionalDate(row.data["deactivated_at"], "deactivated_at");
      if (active && expiresAt) throw new Error("active module cannot have deactivated_at");
      if (startsAt && expiresAt && Date.parse(startsAt) > Date.parse(expiresAt))
        throw new Error("activated_at cannot be after deactivated_at");
      const updatedAt = date(row.data["updated_at"], "updated_at");
      const derivedUpdatedAt = newest(
        [updatedAt, link.updatedAt, startsAt, expiresAt].filter(
          (value): value is string => value !== null,
        ),
      );
      generated.push({
        organizationId: link.organizationId,
        product: "pms",
        entitlementKey: moduleId,
        status: active ? entitlementStatus(link.status) : "expired",
        resourceProduct: "pms",
        resourceType: "pms_hotel",
        resourceId: hotelId,
        startsAt,
        expiresAt,
        metadata: { source: "pms.property_module_activations", moduleId },
        createdAt: startsAt ?? updatedAt,
        updatedAt: derivedUpdatedAt,
      });
    } catch (error) {
      block(
        blockers,
        "INVALID_SOURCE_ROW",
        row,
        error instanceof Error ? error.message : "Invalid module activation",
      );
    }
  }

  const unique = new Map<string, PlannedEntitlement>();
  for (const entitlement of generated) {
    const key = entitlementIdentity(entitlement);
    const duplicate = unique.get(key);
    if (duplicate && !sameEntitlement(duplicate, entitlement)) {
      blockRaw(
        blockers,
        "AMBIGUOUS_ENTITLEMENT",
        "identity.product_entitlements",
        key,
        "Conflicting source rows resolve to one entitlement",
      );
      continue;
    }
    unique.set(key, entitlement);
  }

  const existingByKey = new Map(
    existing.map((row) => {
      const normalized = canonicalEntitlement(row);
      return [entitlementIdentity(normalized), normalized];
    }),
  );
  const entitlements = [...unique].flatMap(([key, source]) => {
    const target = existingByKey.get(key);
    if (!target) return [source];
    if (isNewer(target, source))
      return [{ ...source, ...target, updatedAt: newest([target.updatedAt]) }];
    if (isNewer(source, target)) return [{ ...source, updatedAt: newest([source.updatedAt]) }];
    if (!sameState(target, source)) {
      blockRaw(
        blockers,
        "ENTITLEMENT_STATE_CONFLICT",
        "identity.product_entitlements",
        key,
        "Target and source disagree at equal freshness",
      );
      return [];
    }
    return [{ ...source, ...target, updatedAt: newest([target.updatedAt]) }];
  });
  return {
    entitlements: sortedBy(entitlements, entitlementIdentity),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
}

function sameState(left: ExistingEntitlement, right: PlannedEntitlement): boolean {
  return (
    left.status === right.status &&
    sameInstant(left.startsAt, right.startsAt) &&
    sameInstant(left.expiresAt, right.expiresAt) &&
    JSON.stringify(canonicalJson(left.metadata)) === JSON.stringify(canonicalJson(right.metadata))
  );
}

function sameEntitlement(left: ExistingEntitlement, right: PlannedEntitlement): boolean {
  return (
    sameState(left, right) &&
    sameInstant(left.createdAt, right.createdAt) &&
    sameInstant(left.updatedAt, right.updatedAt)
  );
}

function canonicalEntitlement(row: ExistingEntitlement): ExistingEntitlement {
  return {
    ...row,
    startsAt: row.startsAt ? date(row.startsAt, "startsAt") : null,
    expiresAt: row.expiresAt ? date(row.expiresAt, "expiresAt") : null,
    metadata: canonicalJson(row.metadata) as JsonRecord,
    createdAt: date(row.createdAt, "createdAt"),
    updatedAt: date(row.updatedAt, "updatedAt"),
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  return value;
}

function sameInstant(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return Date.parse(left) === Date.parse(right);
}

function entitlementStatus(status: OrganizationStatus): EntitlementStatus {
  return status === "archived" ? "expired" : status;
}

function entitlementIdentity(row: ExistingEntitlement): string {
  return `${row.organizationId}:${row.product}:${row.entitlementKey}:${row.resourceProduct}:${row.resourceType}:${row.resourceId}`;
}

function block(
  blockers: IdentityMigrationBlocker[],
  code: string,
  row: IdentitySourceRow,
  message: string,
): void {
  blockRaw(
    blockers,
    code,
    `${row.sourceDatabase}.${row.sourceTable}`,
    typeof row.data["id"] === "string" ? row.data["id"] : `row:${row.rowOrdinal}`,
    message,
  );
}
function blockRaw(
  blockers: IdentityMigrationBlocker[],
  code: string,
  source: string,
  sourceId: string,
  message: string,
): void {
  blockers.push({ code, source, sourceId, message });
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value;
}
function uuid(value: unknown, field: string): string {
  const result = text(value, field).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result))
    throw new Error(`${field} must be a UUID`);
  return result;
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}
function date(value: unknown, field: string): string {
  if (typeof value !== "string" && !(value instanceof Date))
    throw new Error(`${field} must be a timestamp`);
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return result.toISOString();
}
function optionalDate(value: unknown, field: string): string | null {
  return value == null || value === "" ? null : date(value, field);
}
