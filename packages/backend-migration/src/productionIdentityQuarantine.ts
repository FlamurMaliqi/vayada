import type {
  ExistingIdentityUser,
  IdentityMigrationBlocker,
  IdentitySourceRow,
  PlannedIdentityUser,
} from "./productionIdentityDisposition.js";
import {
  hasFutureOperationalBooking,
  parseIdentityOwnershipRows,
  type OrganizationKind,
} from "./productionIdentityOwnershipSource.js";
import { newest, oldest, sortedBy } from "./productionIdentityOwnershipPolicy.js";

export type MissingOwnerQuarantinePlan = {
  users: PlannedIdentityUser[];
  blockers: IdentityMigrationBlocker[];
};

const TYPE_BY_KIND = {
  hotel_group: "hotel",
  creator_workspace: "creator",
  affiliate_partner: "affiliate",
} as const;
export function planMissingOwnerQuarantine(
  rows: IdentitySourceRow[],
  sourceUsers: PlannedIdentityUser[],
  existingUsers: ExistingIdentityUser[] = [],
  sourceHorizonAt?: string,
): MissingOwnerQuarantinePlan {
  const knownUsers = new Set(sourceUsers.map((user) => user.id));
  const missing = new Map<string, ReturnType<typeof parseIdentityOwnershipRows>["owners"]>();
  for (const owner of parseIdentityOwnershipRows(rows).owners) {
    if (knownUsers.has(owner.userId)) continue;
    missing.set(owner.userId, [...(missing.get(owner.userId) ?? []), owner]);
  }
  const blockers: IdentityMigrationBlocker[] = [];
  const users: PlannedIdentityUser[] = [];
  const occupiedEmails = new Map(
    [...sourceUsers, ...existingUsers].map((user) => [user.email.trim().toLowerCase(), user.id]),
  );
  for (const [userId, owners] of sortedBy([...missing], ([id]) => id)) {
    const kinds = [...new Set(owners.map((owner) => owner.kind))];
    if (kinds.length !== 1 || kinds[0] === "platform") {
      blockers.push({
        code: "AMBIGUOUS_ORPHAN_OWNER_KIND",
        source: "identity.quarantine",
        sourceId: userId,
        message: "Missing owner spans incompatible organization kinds",
      });
      continue;
    }
    if (owners.some((owner) => hasFutureOperationalBooking(rows, owner, sourceHorizonAt))) continue;
    const kind = kinds[0] as Exclude<OrganizationKind, "platform">;
    const planned: PlannedIdentityUser = {
      id: userId,
      email: `retired-owner-${userId}@migration.invalid`,
      name: null,
      sourceStatus: "rejected",
      status: "deleted",
      type: TYPE_BY_KIND[kind],
      emailVerified: false,
      isSuperadmin: false,
      disposition: "quarantine_missing_owner",
      createdAt: oldest(owners.map((owner) => owner.createdAt)),
      updatedAt: newest(owners.map((owner) => owner.updatedAt)),
      termsAcceptedAt: null,
      termsVersion: null,
      privacyAcceptedAt: null,
      privacyVersion: null,
      marketingConsent: false,
      marketingConsentAt: null,
    };
    const current = existingUsers.find((user) => user.id === userId);
    const emailOwner = occupiedEmails.get(planned.email);
    if (emailOwner && emailOwner !== userId)
      blockers.push({
        code: "QUARANTINE_USER_EMAIL_CONFLICT",
        source: "identity.users",
        sourceId: userId,
        message: "Missing-owner quarantine email is already assigned to another identity",
      });
    if (
      current &&
      (current.email.trim().toLowerCase() !== planned.email ||
        current.name !== planned.name ||
        current.status !== "deleted" ||
        Date.parse(current.updatedAt) !== Date.parse(planned.updatedAt))
    ) {
      blockers.push({
        code: "QUARANTINE_USER_CONFLICT",
        source: "identity.users",
        sourceId: userId,
        message: "Existing target user conflicts with the missing-owner quarantine",
      });
    }
    users.push(planned);
  }
  return { users, blockers };
}
