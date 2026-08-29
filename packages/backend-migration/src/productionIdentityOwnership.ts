import { PLATFORM_ORGANIZATION_ID } from "./platformIdentityBootstrap.js";
import type {
  IdentityMigrationBlocker,
  IdentitySourceRow,
  PlannedIdentityUser,
} from "./productionIdentityDisposition.js";
import {
  type ExistingOwnershipState,
  type IdentityOwnershipPlan,
  type IdentityOwnershipSource,
  type OrganizationKind,
  type PlannedMembership,
  type PlannedOrganization,
  type PlannedResourceLink,
  parseIdentityOwnershipRows,
  stableOrganizationId,
} from "./productionIdentityOwnershipSource.js";
import {
  combinedResourceStatus,
  isNewer,
  membershipStatus,
  mergePlannedOrganizations,
  newest,
  oldest,
  organizationCandidates,
  organizationName,
  organizationStatus,
  OWNER_ROLE,
  resourceIdentity,
  resourceKey,
  selectTargetOrSourceOrganization,
  sortedBy,
} from "./productionIdentityOwnershipPolicy.js";

const KIND = {
  admin: "platform",
  hotel: "hotel_group",
  creator: "creator_workspace",
  affiliate: "affiliate_partner",
} as const;
export function planIdentityOwnership(
  rows: IdentitySourceRow[],
  users: PlannedIdentityUser[],
  existing: ExistingOwnershipState = { organizations: [], memberships: [], resourceLinks: [] },
): IdentityOwnershipPlan {
  const parsed = parseIdentityOwnershipRows(rows);
  const blockers = [...parsed.blockers];
  const usersById = new Map(users.map((user) => [user.id, user]));
  const groups = new Map<string, IdentityOwnershipSource[]>();
  for (const owner of parsed.owners) {
    const user = usersById.get(owner.userId);
    if (!user) {
      block(
        blockers,
        "ORPHAN_PRODUCT_USER",
        owner.source,
        owner.sourceId,
        `Owner ${owner.userId} is absent from auth.users`,
      );
      continue;
    }
    if (KIND[user.type] !== owner.kind) {
      block(
        blockers,
        "OWNER_TYPE_MISMATCH",
        owner.source,
        owner.sourceId,
        `User type ${user.type} cannot own ${owner.kind}`,
      );
      continue;
    }
    append(groups, `${owner.userId}:${owner.kind}`, owner);
  }
  for (const user of users) {
    const kind = KIND[user.type];
    if (kind === "platform" || user.isSuperadmin)
      groups.set(`${user.id}:platform`, groups.get(`${user.id}:platform`) ?? []);
    if (kind !== "platform" && user.status === "active" && !groups.has(`${user.id}:${kind}`))
      block(
        blockers,
        "ACTIVE_USER_WITHOUT_OWNERSHIP",
        "auth.users",
        user.id,
        `Active ${user.type} user has no accepted ownership`,
      );
  }

  const existingOrganizations = new Map(existing.organizations.map((row) => [row.id, row]));
  const organizations = new Map<string, PlannedOrganization>();
  const memberships: PlannedMembership[] = [];
  const resourceLinks: PlannedResourceLink[] = [];
  for (const [groupKey, owners] of sortedBy([...groups], ([key]) => key)) {
    const separator = groupKey.lastIndexOf(":");
    const userId = groupKey.slice(0, separator);
    const kind = groupKey.slice(separator + 1) as OrganizationKind;
    const user = usersById.get(userId)!;
    const candidates = organizationCandidates(userId, kind, owners, existing);
    if (candidates.size > 1) {
      block(
        blockers,
        "AMBIGUOUS_OWNER",
        "identity",
        groupKey,
        `Ownership resolves to multiple organizations: ${[...candidates].sort().join(", ")}`,
      );
      continue;
    }
    const organizationId =
      [...candidates][0] ??
      (kind === "platform" ? PLATFORM_ORGANIZATION_ID : stableOrganizationId(userId, kind));
    const currentOrganization = existingOrganizations.get(organizationId);
    if (currentOrganization && currentOrganization.kind !== kind) {
      block(
        blockers,
        "ORGANIZATION_KIND_CONFLICT",
        "identity.organizations",
        organizationId,
        `Expected ${kind}, found ${currentOrganization.kind}`,
      );
      continue;
    }
    const createdAt = oldest([user.createdAt, ...owners.map((row) => row.createdAt)]);
    const updatedAt = newest([user.updatedAt, ...owners.map((row) => row.updatedAt)]);
    const generatedOrganization: PlannedOrganization = {
      id: organizationId,
      kind,
      name: organizationName(user, kind, owners),
      slug:
        kind === "platform" ? "vayada-platform" : `legacy-${kind.replaceAll("_", "-")}-${userId}`,
      status: organizationStatus(user.status),
      createdAt,
      updatedAt,
    };
    const plannedOrganization = currentOrganization
      ? selectTargetOrSourceOrganization(currentOrganization, generatedOrganization)
      : generatedOrganization;
    if (!plannedOrganization) {
      block(
        blockers,
        "ORGANIZATION_STATE_CONFLICT",
        "identity.organizations",
        organizationId,
        "Target and source organization states conflict at equal freshness",
      );
      continue;
    }
    const prior = organizations.get(organizationId);
    const mergedOrganization = prior
      ? mergePlannedOrganizations(prior, plannedOrganization)
      : plannedOrganization;
    if (!mergedOrganization) {
      block(
        blockers,
        "AMBIGUOUS_ORGANIZATION_STATE",
        "identity.organizations",
        organizationId,
        "Equally fresh owner groups disagree on organization identity",
      );
      continue;
    }
    organizations.set(organizationId, mergedOrganization);

    const generatedMembership: PlannedMembership = {
      organizationId,
      userId,
      status: membershipStatus(user.status),
      roleKey: OWNER_ROLE[kind],
      propertyAccessMode: kind === "hotel_group" ? "all" : "assigned",
      accessOrigin: "agency",
      createdAt,
      updatedAt,
    };
    const currentMembership = existing.memberships.find(
      (row) => row.organizationId === organizationId && row.userId === userId,
    );
    if (
      currentMembership?.accessOrigin === "external_owner" &&
      !isNewer(currentMembership, generatedMembership)
    )
      block(
        blockers,
        "MEMBERSHIP_PROVENANCE_CONFLICT",
        "identity.organization_memberships",
        `${organizationId}:${userId}`,
        "External-owner membership cannot be rewritten as legacy agency ownership",
      );
    memberships.push(
      currentMembership && isNewer(currentMembership, generatedMembership)
        ? { ...generatedMembership, ...currentMembership, createdAt }
        : generatedMembership,
    );

    for (const owner of owners) {
      const matches = existing.resourceLinks.filter(
        (row) =>
          row.organizationId === organizationId &&
          resourceIdentity(row) === resourceIdentity(owner),
      );
      if (matches.length > 1) {
        block(
          blockers,
          "AMBIGUOUS_RESOURCE_LINK",
          owner.source,
          owner.sourceId,
          "Target has multiple links for this resource",
        );
        continue;
      }
      const generated: PlannedResourceLink = {
        organizationId,
        product: owner.product,
        resourceType: owner.resourceType,
        resourceId: owner.resourceId,
        relationship: owner.relationship,
        status: combinedResourceStatus(owner.status, user.status),
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
      };
      const current = matches[0];
      if (
        current &&
        current.relationship !== generated.relationship &&
        !isNewer(current, generated)
      ) {
        block(
          blockers,
          "RESOURCE_RELATIONSHIP_CONFLICT",
          owner.source,
          owner.sourceId,
          `Existing relationship ${current.relationship} conflicts with ${generated.relationship}`,
        );
        continue;
      }
      resourceLinks.push(
        current && isNewer(current, generated)
          ? { ...generated, ...current, createdAt: owner.createdAt }
          : generated,
      );
    }
  }
  return {
    organizations: sortedBy([...organizations.values()], (row) => row.id),
    memberships: sortedBy(memberships, (row) => `${row.organizationId}:${row.userId}`),
    resourceLinks: sortedBy(resourceLinks, resourceKey),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  map.set(key, [...(map.get(key) ?? []), value]);
}
function block(
  blockers: IdentityMigrationBlocker[],
  code: string,
  source: string,
  sourceId: string,
  message: string,
): void {
  blockers.push({ code, source, sourceId, message });
}
