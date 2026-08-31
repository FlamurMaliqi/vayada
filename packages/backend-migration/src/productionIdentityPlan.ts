import { createHash } from "node:crypto";

import {
  planIdentityAudit,
  type ExistingAuditReference,
  type PlannedIdentityAuditEvent,
} from "./productionIdentityAudit.js";
import {
  planIdentityConsentSource,
  type PlannedUserConsent,
} from "./productionIdentityConsentSource.js";
import {
  planIdentityUserDisposition,
  type ExistingIdentityUser,
  type ExistingWorkosIdentity,
  type IdentityMigrationBlocker,
  type IdentitySourceRow,
  type PlannedIdentityUser,
} from "./productionIdentityDisposition.js";
import {
  planIdentityEntitlements,
  type ExistingEntitlement,
  type PlannedEntitlement,
} from "./productionIdentityEntitlements.js";
import { planIdentityOwnership } from "./productionIdentityOwnership.js";
import { sortedBy } from "./productionIdentityOwnershipPolicy.js";
import type {
  ExistingOwnershipState,
  PlannedMembership,
  PlannedOrganization,
  PlannedResourceLink,
} from "./productionIdentityOwnershipSource.js";
import {
  reconcileIdentityPrivacy,
  type ExistingCookieConsent,
  type ExistingPrivacyState,
} from "./productionIdentityPrivacyReconciliation.js";
import {
  planIdentityPrivacyRecordSource,
  type PlannedConsentHistory,
  type PlannedGdprRequest,
} from "./productionIdentityPrivacyRecordSource.js";
import { stableJson } from "./productionIdentitySourceValidation.js";

export type ProductionIdentityExistingState = {
  users: ExistingIdentityUser[];
  workosIdentities: ExistingWorkosIdentity[];
  ownership: ExistingOwnershipState;
  entitlements: ExistingEntitlement[];
  privacy: ExistingPrivacyState;
  auditEvents: Array<PlannedIdentityAuditEvent | ExistingAuditReference>;
};
export type ProductionIdentityPlan = {
  users: PlannedIdentityUser[];
  workosIdentities: ExistingWorkosIdentity[];
  organizations: PlannedOrganization[];
  memberships: PlannedMembership[];
  resourceLinks: PlannedResourceLink[];
  entitlements: PlannedEntitlement[];
  userConsents: PlannedUserConsent[];
  cookieConsents: ExistingCookieConsent[];
  consentHistory: PlannedConsentHistory[];
  gdprRequests: PlannedGdprRequest[];
  auditEvents: PlannedIdentityAuditEvent[];
  retiredAuthRows: Record<string, number>;
  blockers: IdentityMigrationBlocker[];
  counts: ProductionIdentityCounts;
  checksum: string;
};
export type ProductionIdentityCounts = {
  users: number;
  preservedNewerUsers: number;
  pendingTargetWrites: number;
  organizations: number;
  memberships: number;
  resourceLinks: number;
  entitlements: number;
  workosIdentities: number;
  userConsents: number;
  cookieConsents: number;
  consentHistory: number;
  gdprRequests: number;
  loginAuditEvents: number;
  retiredAuthRows: number;
};

export function buildProductionIdentityPlan(
  rows: IdentitySourceRow[],
  existing: ProductionIdentityExistingState = emptyProductionIdentityState(),
): ProductionIdentityPlan {
  const orderedRows = sortedBy(
    rows,
    (row) => `${row.sourceDatabase}:${row.sourceTable}:${row.rowOrdinal}:${stableJson(row.data)}`,
  );
  const current = canonicalExisting(existing);
  const disposition = planIdentityUserDisposition(
    orderedRows,
    current.users,
    current.workosIdentities,
  );
  const ownership = planIdentityOwnership(orderedRows, disposition.users, current.ownership);
  const entitlements = planIdentityEntitlements(
    orderedRows,
    ownership.resourceLinks,
    current.entitlements,
  );
  const userIds = disposition.users.map((user) => user.id);
  const consentSource = planIdentityConsentSource(orderedRows, userIds);
  const privacyRecordSource = planIdentityPrivacyRecordSource(orderedRows, userIds);
  const privacy = reconcileIdentityPrivacy(
    {
      userConsents: consentSource.userConsents,
      cookieConsents: consentSource.cookieConsents,
      consentHistory: privacyRecordSource.consentHistory,
      gdprRequests: privacyRecordSource.gdprRequests,
    },
    current.privacy,
  );
  const audit = planIdentityAudit(orderedRows, userIds, current.auditEvents);
  const blockers = sortedBy(
    [
      ...disposition.blockers,
      ...ownership.blockers,
      ...entitlements.blockers,
      ...consentSource.blockers,
      ...privacyRecordSource.blockers,
      ...privacy.blockers,
      ...audit.blockers,
    ],
    (row) => `${row.code}:${row.source}:${row.sourceId}`,
  );
  const content = {
    users: disposition.users,
    workosIdentities: disposition.workosIdentities,
    organizations: ownership.organizations,
    memberships: ownership.memberships,
    resourceLinks: ownership.resourceLinks,
    entitlements: entitlements.entitlements,
    userConsents: privacy.userConsents,
    cookieConsents: privacy.cookieConsents,
    consentHistory: privacy.consentHistory,
    gdprRequests: privacy.gdprRequests,
    auditEvents: audit.auditEvents,
    retiredAuthRows: consentSource.retiredAuthRows,
    blockers,
  };
  const counts = planCounts(content, current);
  const { pendingTargetWrites: _pendingTargetWrites, ...stableCounts } = counts;
  return {
    ...content,
    counts,
    checksum: createHash("sha256")
      .update(stableJson({ ...content, counts: stableCounts }))
      .digest("hex"),
  };
}

export function emptyProductionIdentityState(): ProductionIdentityExistingState {
  return {
    users: [],
    workosIdentities: [],
    ownership: { organizations: [], memberships: [], resourceLinks: [] },
    entitlements: [],
    privacy: { userConsents: [], cookieConsents: [], consentHistory: [], gdprRequests: [] },
    auditEvents: [],
  };
}

function canonicalExisting(
  existing: ProductionIdentityExistingState,
): ProductionIdentityExistingState {
  const order = <T>(values: T[]) => sortedBy(values, stableJson);
  return {
    users: order(existing.users),
    workosIdentities: order(existing.workosIdentities),
    ownership: {
      organizations: order(existing.ownership.organizations),
      memberships: order(existing.ownership.memberships),
      resourceLinks: order(existing.ownership.resourceLinks),
    },
    entitlements: order(existing.entitlements),
    privacy: {
      userConsents: order(existing.privacy.userConsents),
      cookieConsents: order(existing.privacy.cookieConsents),
      consentHistory: order(existing.privacy.consentHistory),
      gdprRequests: order(existing.privacy.gdprRequests),
    },
    auditEvents: order(existing.auditEvents),
  };
}

function planCounts(
  plan: Omit<ProductionIdentityPlan, "counts" | "checksum">,
  current: ProductionIdentityExistingState,
): ProductionIdentityCounts {
  return {
    users: plan.users.length,
    preservedNewerUsers: plan.users.filter((row) => row.disposition === "preserve_newer_target")
      .length,
    pendingTargetWrites: pendingTargetWrites(plan, current),
    organizations: plan.organizations.length,
    memberships: plan.memberships.length,
    resourceLinks: plan.resourceLinks.length,
    entitlements: plan.entitlements.length,
    workosIdentities: plan.workosIdentities.length,
    userConsents: plan.userConsents.length,
    cookieConsents: plan.cookieConsents.length,
    consentHistory: plan.consentHistory.length,
    gdprRequests: plan.gdprRequests.length,
    loginAuditEvents: plan.auditEvents.length,
    retiredAuthRows: Object.values(plan.retiredAuthRows).reduce((sum, count) => sum + count, 0),
  };
}

function pendingTargetWrites(
  plan: Omit<ProductionIdentityPlan, "counts" | "checksum">,
  current: ProductionIdentityExistingState,
): number {
  return (
    pendingMutable(plan.users, current.users, (row) => row.id) +
    pendingMutable(plan.organizations, current.ownership.organizations, (row) => row.id) +
    pendingMutable(
      plan.memberships,
      current.ownership.memberships,
      (row) => `${row.organizationId}:${row.userId}`,
    ) +
    pendingMutable(
      plan.resourceLinks,
      current.ownership.resourceLinks,
      (row) =>
        `${row.organizationId}:${row.product}:${row.resourceType}:${row.resourceId}:${row.relationship}`,
    ) +
    pendingMutable(
      plan.entitlements,
      current.entitlements,
      (row) =>
        `${row.organizationId}:${row.product}:${row.entitlementKey}:${row.resourceProduct}:${row.resourceType}:${row.resourceId}`,
    ) +
    pendingMutable(plan.userConsents, current.privacy.userConsents, (row) => row.userId) +
    pendingMutable(plan.cookieConsents, current.privacy.cookieConsents, (row) => row.visitorId) +
    pendingImmutable(plan.consentHistory, current.privacy.consentHistory, (row) => row.id) +
    pendingMutable(plan.gdprRequests, current.privacy.gdprRequests, (row) => row.id) +
    pendingImmutable(
      plan.auditEvents,
      current.auditEvents,
      (row) => `${row.product}:${row.auditKey}`,
    )
  );
}

function pendingMutable<T extends { updatedAt: string }>(
  planned: T[],
  existing: T[],
  key: (row: T) => string,
): number {
  const current = new Map(existing.map((row) => [key(row), row]));
  return planned.filter((row) => {
    const target = current.get(key(row));
    return !target || Date.parse(row.updatedAt) > Date.parse(target.updatedAt);
  }).length;
}

function pendingImmutable<T>(planned: T[], existing: T[], key: (row: T) => string): number {
  const current = new Set(existing.map(key));
  return planned.filter((row) => !current.has(key(row))).length;
}
