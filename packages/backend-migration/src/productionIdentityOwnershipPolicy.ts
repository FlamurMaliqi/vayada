import type { TargetIdentityUserStatus } from "./productionIdentityDisposition.js";
import type {
  MembershipStatus,
  OrganizationStatus,
  PlannedOrganization,
  PlannedResourceLink,
} from "./productionIdentityOwnershipSource.js";

export function mergePlannedOrganizations(
  left: PlannedOrganization,
  right: PlannedOrganization,
): PlannedOrganization | null {
  if (left.id !== right.id) throw new Error("Cannot merge different organizations");
  const leftTime = epoch(left.updatedAt);
  const rightTime = epoch(right.updatedAt);
  if (
    leftTime === rightTime &&
    (left.kind !== right.kind || left.name !== right.name || left.slug !== right.slug)
  )
    return null;
  const fresher = rightTime > leftTime ? right : left;
  return {
    ...fresher,
    status: moreAvailable(left.status, right.status),
    createdAt: oldest([left.createdAt, right.createdAt]),
    updatedAt: new Date(Math.max(leftTime, rightTime)).toISOString(),
  };
}

export function organizationStatus(status: TargetIdentityUserStatus): OrganizationStatus {
  return status === "active" ? "active" : status === "deleted" ? "archived" : "suspended";
}

export function membershipStatus(status: TargetIdentityUserStatus): MembershipStatus {
  return status === "deleted" ? "inactive" : status;
}

export function combinedResourceStatus(
  source: OrganizationStatus,
  user: TargetIdentityUserStatus,
): OrganizationStatus {
  if (source === "archived" || user === "deleted") return "archived";
  return source === "suspended" || user !== "active" ? "suspended" : "active";
}

export function isNewer(left: { updatedAt: string }, right: { updatedAt: string }): boolean {
  return epoch(left.updatedAt) > epoch(right.updatedAt);
}

export function oldest(values: string[]): string {
  return extreme(values, Math.min);
}

export function newest(values: string[]): string {
  return extreme(values, Math.max);
}

export function sortedBy<T>(values: T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

export function resourceIdentity(row: {
  product: string;
  resourceType: string;
  resourceId: string;
}): string {
  return `${row.product}:${row.resourceType}:${row.resourceId}`;
}

export function resourceKey(row: PlannedResourceLink): string {
  return `${resourceIdentity(row)}:${row.relationship}`;
}

function moreAvailable(left: OrganizationStatus, right: OrganizationStatus): OrganizationStatus {
  const rank = { archived: 0, suspended: 1, active: 2 };
  return rank[left] >= rank[right] ? left : right;
}

function extreme(values: string[], pick: (...values: number[]) => number): string {
  if (values.length === 0) throw new Error("Timestamp collection cannot be empty");
  return new Date(pick(...values.map(epoch))).toISOString();
}

function epoch(value: string): number {
  const result = Date.parse(value);
  if (Number.isNaN(result)) throw new Error(`Invalid timestamp ${value}`);
  return result;
}
