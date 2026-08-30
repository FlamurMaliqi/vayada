import type {
  PlannedIdentityUser,
  TargetIdentityUserStatus,
} from "./productionIdentityDisposition.js";
import type {
  ExistingOwnershipState,
  ExistingOrganization,
  IdentityOwnershipSource,
  MembershipStatus,
  OrganizationKind,
  OrganizationStatus,
  PlannedOrganization,
  PlannedResourceLink,
} from "./productionIdentityOwnershipSource.js";

export const OWNER_ROLE: Record<OrganizationKind, string> = {
  platform: "platform_admin",
  hotel_group: "hotel_owner",
  creator_workspace: "creator_owner",
  affiliate_partner: "affiliate_owner",
};

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

export function selectTargetOrSourceOrganization(
  target: ExistingOrganization,
  source: PlannedOrganization,
): PlannedOrganization | null {
  if (target.id !== source.id || target.kind !== source.kind) return null;
  if (isNewer(target, source))
    return {
      ...source,
      ...target,
      createdAt: source.createdAt,
      updatedAt: newest([target.updatedAt]),
    };
  if (isNewer(source, target)) return { ...source, updatedAt: newest([source.updatedAt]) };
  if (target.name !== source.name || target.slug !== source.slug || target.status !== source.status)
    return null;
  return {
    ...source,
    ...target,
    createdAt: source.createdAt,
    updatedAt: newest([target.updatedAt]),
  };
}

export function organizationCandidates(
  userId: string,
  kind: OrganizationKind,
  owners: IdentityOwnershipSource[],
  existing: ExistingOwnershipState,
): Set<string> {
  const organizations = new Map(existing.organizations.map((row) => [row.id, row]));
  const result = new Set(
    existing.memberships
      .filter(
        (row) =>
          row.userId === userId &&
          row.accessOrigin === "agency" &&
          row.roleKey === OWNER_ROLE[kind] &&
          organizations.get(row.organizationId)?.kind === kind,
      )
      .map((row) => row.organizationId),
  );
  for (const owner of owners)
    for (const link of existing.resourceLinks.filter(
      (row) => resourceIdentity(row) === resourceIdentity(owner),
    ))
      result.add(link.organizationId);
  if (kind === "platform")
    for (const organization of existing.organizations.filter((row) => row.kind === kind))
      result.add(organization.id);
  return result;
}

export function organizationName(
  user: PlannedIdentityUser,
  kind: OrganizationKind,
  owners: IdentityOwnershipSource[],
): string {
  if (kind === "platform") return "Vayada Platform";
  const names = [
    ...new Set(owners.map((row) => row.name).filter((name): name is string => Boolean(name))),
  ];
  return names.length === 1 ? names[0]! : `${user.name ?? user.email} ${kind.replaceAll("_", " ")}`;
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
  if (Number.isNaN(result)) throw new Error("Invalid timestamp");
  return result;
}
