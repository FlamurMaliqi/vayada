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
  hasFutureOperationalBooking,
  parseIdentityOwnershipRows,
  stableOrganizationId,
  stableQuarantineOrganizationId,
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
  sourceHorizonAt?: string,
): IdentityOwnershipPlan {
  const parsed = parseIdentityOwnershipRows(rows);
  const blockers = [...parsed.blockers];
  const usersById = new Map(users.map((user) => [user.id, user]));
  const groups = new Map<string, IdentityOwnershipSource[]>();
  const quarantineGroups = new Map<string, IdentityOwnershipSource[]>();
  for (const owner of parsed.owners) {
    const user = usersById.get(owner.userId);
    if (!user) {
      if (hasFutureOperationalBooking(rows, owner, sourceHorizonAt))
        block(
          blockers,
          "ORPHAN_PRODUCT_USER_WITH_FUTURE_BOOKING",
          owner.source,
          owner.sourceId,
          "Missing owner has a future operational booking and requires reviewed reassignment",
        );
      else append(quarantineGroups, `${owner.userId}:${owner.kind}`, owner);
      continue;
    }
    if (KIND[user.type] !== owner.kind) {
      if (hasFutureOperationalBooking(rows, owner, sourceHorizonAt))
        block(
          blockers,
          "OWNER_TYPE_MISMATCH_WITH_FUTURE_BOOKING",
          owner.source,
          owner.sourceId,
          "Incompatible owner type has a future operational booking and requires reviewed reassignment",
        );
      else append(quarantineGroups, `${owner.userId}:${owner.kind}`, owner);
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
    const updatedAt = newest([user.updatedAt]);
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
    if (
      currentMembership &&
      sameInstant(currentMembership.updatedAt, generatedMembership.updatedAt) &&
      (currentMembership.status !== generatedMembership.status ||
        currentMembership.roleKey !== generatedMembership.roleKey ||
        currentMembership.propertyAccessMode !== generatedMembership.propertyAccessMode)
    )
      block(
        blockers,
        "MEMBERSHIP_STATE_CONFLICT",
        "identity.organization_memberships",
        `${organizationId}:${userId}`,
        "Target and source membership states conflict at equal freshness",
      );
    memberships.push(
      currentMembership && isNewer(currentMembership, generatedMembership)
        ? {
            ...generatedMembership,
            ...currentMembership,
            createdAt,
            updatedAt: newest([currentMembership.updatedAt]),
          }
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
        updatedAt: newest([owner.updatedAt, user.updatedAt]),
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
      if (
        current &&
        sameInstant(current.updatedAt, generated.updatedAt) &&
        current.status !== generated.status
      ) {
        block(
          blockers,
          "RESOURCE_STATE_CONFLICT",
          owner.source,
          owner.sourceId,
          "Target and source resource-link states conflict at equal freshness",
        );
        continue;
      }
      resourceLinks.push(
        current && isNewer(current, generated)
          ? {
              ...generated,
              ...current,
              createdAt: owner.createdAt,
              updatedAt: newest([current.updatedAt]),
            }
          : generated,
      );
    }
  }
  for (const [groupKey, owners] of sortedBy([...quarantineGroups], ([key]) => key)) {
    const separator = groupKey.lastIndexOf(":");
    const userId = groupKey.slice(0, separator);
    const kind = groupKey.slice(separator + 1) as OrganizationKind;
    const organizationId = stableQuarantineOrganizationId(userId, kind);
    const createdAt = oldest(owners.map((row) => row.createdAt));
    const updatedAt = newest(owners.map((row) => row.updatedAt));
    const currentOrganization = existingOrganizations.get(organizationId);
    if (
      currentOrganization &&
      (currentOrganization.kind !== kind || currentOrganization.status !== "archived")
    )
      block(
        blockers,
        "QUARANTINE_ORGANIZATION_CONFLICT",
        "identity.organizations",
        organizationId,
        "Existing quarantine organization is not archived with the expected kind",
      );
    const generatedOrganization: PlannedOrganization = {
      id: organizationId,
      kind,
      name: `Quarantined legacy ${kind.replaceAll("_", " ")}`,
      slug: `legacy-quarantine-${kind.replaceAll("_", "-")}-${organizationId}`,
      status: "archived",
      createdAt,
      updatedAt,
    };
    organizations.set(
      organizationId,
      currentOrganization && isNewer(currentOrganization, generatedOrganization)
        ? { ...generatedOrganization, ...currentOrganization, createdAt }
        : generatedOrganization,
    );
    for (const owner of owners) {
      const generated: PlannedResourceLink = {
        organizationId,
        product: owner.product,
        resourceType: owner.resourceType,
        resourceId: owner.resourceId,
        relationship: owner.relationship,
        status: "archived",
        createdAt: owner.createdAt,
        updatedAt: owner.updatedAt,
      };
      const matches = existing.resourceLinks.filter(
        (row) => resourceIdentity(row) === resourceIdentity(owner),
      );
      if (matches.length > 1) {
        block(
          blockers,
          "AMBIGUOUS_QUARANTINE_RESOURCE_LINK",
          owner.source,
          owner.sourceId,
          "Target has multiple ownership links for the quarantined resource",
        );
        continue;
      }
      const conflicting = matches.find(
        (row) => row.organizationId !== organizationId || row.status !== "archived",
      );
      if (conflicting) {
        block(
          blockers,
          "QUARANTINE_RESOURCE_CONFLICT",
          owner.source,
          owner.sourceId,
          "Existing target ownership must be reviewed before quarantining this resource",
        );
        continue;
      }
      const current = matches[0];
      resourceLinks.push(
        current && isNewer(current, generated)
          ? { ...generated, ...current, createdAt: generated.createdAt }
          : generated,
      );
    }
  }
  return {
    organizations: sortedBy([...organizations.values()], (row) => row.id),
    memberships: sortedBy(memberships, (row) => `${row.organizationId}:${row.userId}`),
    resourceLinks: sortedBy(resourceLinks, resourceKey),
    quarantinedOrganizations: quarantineGroups.size,
    quarantinedResourceLinks: [...quarantineGroups.values()].reduce(
      (count, owners) => count + owners.length,
      0,
    ),
    blockers: sortedBy(blockers, (row) => `${row.code}:${row.source}:${row.sourceId}`),
  };
}

const sameInstant = (left: string, right: string) => Date.parse(left) === Date.parse(right);

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
