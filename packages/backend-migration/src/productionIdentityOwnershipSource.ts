import { createHash } from "node:crypto";

import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
} from "./productionIdentityDisposition.js";

export type OrganizationKind =
  | "platform"
  | "hotel_group"
  | "creator_workspace"
  | "affiliate_partner";
export type OrganizationStatus = "active" | "suspended" | "archived";
export type MembershipStatus = "active" | "pending" | "suspended" | "inactive";

export type ExistingOrganization = {
  id: string;
  kind: OrganizationKind;
  name: string;
  slug: string;
  status: OrganizationStatus;
  updatedAt: string;
};
export type ExistingMembership = {
  organizationId: string;
  userId: string;
  status: MembershipStatus;
  roleKey: string;
  propertyAccessMode: "all" | "assigned";
  accessOrigin: "agency" | "external_owner";
  updatedAt: string;
};
export type ExistingResourceLink = {
  organizationId: string;
  product: string;
  resourceType: string;
  resourceId: string;
  relationship: string;
  status: OrganizationStatus;
  updatedAt: string;
};
export type ExistingOwnershipState = {
  organizations: ExistingOrganization[];
  memberships: ExistingMembership[];
  resourceLinks: ExistingResourceLink[];
};
export type PlannedOrganization = ExistingOrganization & { createdAt: string };
export type PlannedMembership = ExistingMembership & { createdAt: string };
export type PlannedResourceLink = ExistingResourceLink & { createdAt: string };

export type IdentityOwnershipPlan = {
  organizations: PlannedOrganization[];
  memberships: PlannedMembership[];
  resourceLinks: PlannedResourceLink[];
  blockers: IdentityMigrationBlocker[];
};

export type IdentityOwnershipSource = {
  source: string;
  sourceId: string;
  userId: string;
  kind: OrganizationKind;
  product: string;
  resourceType: string;
  resourceId: string;
  relationship: string;
  status: OrganizationStatus;
  name: string | null;
  createdAt: string;
  updatedAt: string;
};

type OwnershipSpec = {
  database: IdentitySourceRow["sourceDatabase"];
  table: string;
  kind: Exclude<OrganizationKind, "platform">;
  product: string;
  resourceType: string;
  relationship: string;
  nameField?: string;
  statusField?: string;
  optionalUser?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SPECS: OwnershipSpec[] = [
  {
    database: "booking",
    table: "booking_hotels",
    kind: "hotel_group",
    product: "booking",
    resourceType: "booking_hotel",
    relationship: "owner",
    nameField: "name",
    statusField: "platform_status",
  },
  {
    database: "pms",
    table: "hotels",
    kind: "hotel_group",
    product: "pms",
    resourceType: "pms_hotel",
    relationship: "operator",
    nameField: "name",
  },
  {
    database: "marketplace",
    table: "hotel_profiles",
    kind: "hotel_group",
    product: "marketplace",
    resourceType: "hotel_profile",
    relationship: "owner",
    nameField: "name",
    statusField: "status",
  },
  {
    database: "marketplace",
    table: "creators",
    kind: "creator_workspace",
    product: "marketplace",
    resourceType: "creator_profile",
    relationship: "owner",
  },
  {
    database: "pms",
    table: "affiliates",
    kind: "affiliate_partner",
    product: "affiliate",
    resourceType: "affiliate",
    relationship: "owner",
    nameField: "full_name",
    statusField: "status",
    optionalUser: true,
  },
];

export function parseIdentityOwnershipRows(sourceRows: IdentitySourceRow[]): {
  owners: IdentityOwnershipSource[];
  blockers: IdentityMigrationBlocker[];
} {
  const owners: IdentityOwnershipSource[] = [];
  const blockers: IdentityMigrationBlocker[] = [];
  for (const spec of SPECS) {
    for (const row of sourceRows.filter(
      (item) => item.sourceDatabase === spec.database && item.sourceTable === spec.table,
    )) {
      try {
        const userId = optionalUuid(row.data["user_id"], "user_id");
        if (!userId && spec.optionalUser) continue;
        if (!userId) throw new Error("user_id is required for an owned product row");
        const source = `${spec.database}.${spec.table}`;
        const rawStatus = spec.statusField
          ? requiredText(row.data[spec.statusField], spec.statusField)
          : null;
        const status = mapOwnershipStatus(source, rawStatus);
        if (!status) throw new Error(`status ${rawStatus} is unsupported`);
        const createdAt = requiredDate(row.data["created_at"], "created_at");
        owners.push({
          source,
          sourceId: sourceId(row),
          userId,
          kind: spec.kind,
          product: spec.product,
          resourceType: spec.resourceType,
          resourceId: requiredUuid(row.data["id"], "id"),
          relationship: spec.relationship,
          status,
          name: spec.nameField ? requiredText(row.data[spec.nameField], spec.nameField) : null,
          createdAt,
          updatedAt: optionalDate(row.data["updated_at"], "updated_at") ?? createdAt,
        });
      } catch (error) {
        blockers.push({
          code: "INVALID_SOURCE_ROW",
          source: `${spec.database}.${spec.table}`,
          sourceId: sourceId(row),
          message: error instanceof Error ? error.message : "Invalid source row",
        });
      }
    }
  }
  return {
    owners: owners.sort((left, right) =>
      `${left.source}:${left.sourceId}`.localeCompare(`${right.source}:${right.sourceId}`),
    ),
    blockers: blockers.sort((left, right) =>
      `${left.source}:${left.sourceId}`.localeCompare(`${right.source}:${right.sourceId}`),
    ),
  };
}

export function mapOwnershipStatus(
  source: string,
  status: string | null,
): OrganizationStatus | null {
  if (!status) return "active";
  if (source === "booking.booking_hotels")
    return ["live", "demo", "test"].includes(status) ? "active" : null;
  if (source === "marketplace.hotel_profiles") {
    if (status === "verified") return "active";
  } else if (source === "pms.affiliates") {
    if (status === "approved") return "active";
  } else return null;
  if (status === "pending" || status === "suspended") return "suspended";
  return status === "rejected" ? "archived" : null;
}

export function stableOrganizationId(userId: string, kind: OrganizationKind): string {
  const namespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
  const bytes = Buffer.from(
    createHash("sha1")
      .update(namespace)
      .update(`vayada:${kind}:${userId}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

function requiredUuid(value: unknown, field: string): string {
  const result = requiredText(value, field).toLowerCase();
  if (!UUID.test(result)) throw new Error(`${field} must be a UUID`);
  return result;
}

function optionalUuid(value: unknown, field: string): string | null {
  return value == null || value === "" ? null : requiredUuid(value, field);
}

function requiredDate(value: unknown, field: string): string {
  if (typeof value !== "string" && !(value instanceof Date))
    throw new Error(`${field} must be a timestamp`);
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return result.toISOString();
}

function optionalDate(value: unknown, field: string): string | null {
  return value == null || value === "" ? null : requiredDate(value, field);
}

function sourceId(row: IdentitySourceRow): string {
  return typeof row.data["id"] === "string" ? row.data["id"] : `row:${row.rowOrdinal}`;
}
