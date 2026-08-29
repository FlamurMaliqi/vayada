import { createHash } from "node:crypto";

export type IdentitySourceRow = {
  sourceDatabase: "auth" | "booking" | "marketplace" | "pms";
  sourceTable: string;
  rowOrdinal: number;
  data: Record<string, unknown>;
  rowCountOnly?: number;
};

export type TargetIdentityUserStatus = "active" | "pending" | "suspended" | "deleted";
export type LegacyIdentityUserType = "admin" | "hotel" | "creator" | "affiliate";

export type IdentityMigrationBlocker = {
  code: string;
  source: string;
  sourceId: string;
  message: string;
};

export type ExistingIdentityUser = {
  id: string;
  email: string;
  name: string | null;
  status: TargetIdentityUserStatus;
  updatedAt: string;
};

export type ExistingWorkosIdentity = { userId: string; providerUserId: string };

export type PlannedIdentityUser = {
  id: string;
  email: string;
  name: string | null;
  sourceStatus: string;
  status: TargetIdentityUserStatus;
  type: LegacyIdentityUserType;
  emailVerified: boolean;
  isSuperadmin: boolean;
  disposition: "migrate" | "preserve_newer_target";
  createdAt: string;
  updatedAt: string;
  termsAcceptedAt: string | null;
  termsVersion: string | null;
  privacyAcceptedAt: string | null;
  privacyVersion: string | null;
  marketingConsent: boolean;
  marketingConsentAt: string | null;
};

export type IdentityDispositionPlan = {
  users: PlannedIdentityUser[];
  workosIdentities: ExistingWorkosIdentity[];
  blockers: IdentityMigrationBlocker[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USER_TYPES = new Set<LegacyIdentityUserType>(["admin", "hotel", "creator", "affiliate"]);

export function mapProductionLegacyUserStatus(status: string): TargetIdentityUserStatus | null {
  return (
    (
      {
        verified: "active",
        pending: "pending",
        suspended: "suspended",
        rejected: "deleted",
      } as Record<string, TargetIdentityUserStatus>
    )[status] ?? null
  );
}

export function planIdentityUserDisposition(
  sourceRows: IdentitySourceRow[],
  existingUsers: ExistingIdentityUser[] = [],
  existingWorkosIdentities: ExistingWorkosIdentity[] = [],
): IdentityDispositionPlan {
  const blockers: IdentityMigrationBlocker[] = [];
  const users: PlannedIdentityUser[] = [];
  for (const row of sourceRows.filter(
    (item) => item.sourceDatabase === "auth" && item.sourceTable === "users",
  )) {
    try {
      users.push(parseUser(row));
    } catch (error) {
      addBlocker(
        blockers,
        "INVALID_SOURCE_ROW",
        "auth.users",
        sourceId(row),
        error instanceof Error ? error.message : "Invalid source row",
      );
    }
  }

  addSourceDuplicateIdBlockers(users, blockers);
  const sourceIds = new Set(users.map((user) => user.id));
  const currentById = new Map(existingUsers.map((user) => [user.id, user]));
  for (const user of users) {
    const current = currentById.get(user.id);
    if (!current) continue;
    const currentUpdatedAt = isoDate(current.updatedAt, "existing updatedAt");
    const currentEmail = current.email.trim().toLowerCase();
    if (Date.parse(currentUpdatedAt) > Date.parse(user.updatedAt)) {
      user.email = currentEmail;
      user.name = current.name;
      user.status = current.status;
      user.updatedAt = currentUpdatedAt;
      user.disposition = "preserve_newer_target";
    } else if (
      currentUpdatedAt === user.updatedAt &&
      (currentEmail !== user.email || current.name !== user.name || current.status !== user.status)
    ) {
      addBlocker(
        blockers,
        "USER_EQUAL_TIME_CONFLICT",
        "identity.users",
        user.id,
        "Source and target user state disagrees at equal freshness",
      );
    }
  }

  addFinalEmailBlockers(users, blockers);
  const plannedByEmail = new Map(users.map((user) => [user.email, user]));
  for (const target of existingUsers) {
    const source = plannedByEmail.get(target.email.trim().toLowerCase());
    if (source && source.id !== target.id && !sourceIds.has(target.id)) {
      addBlocker(
        blockers,
        "TARGET_EMAIL_CONFLICT",
        "identity.users",
        target.id,
        `Target email conflicts with source user ${source.id}`,
      );
    }
  }

  const workosIdentities = validateWorkosLinks(existingWorkosIdentities, sourceIds, blockers);
  return {
    users: [...users].sort((left, right) => left.id.localeCompare(right.id)),
    workosIdentities,
    blockers: blockers.sort((left, right) =>
      `${left.code}:${left.source}:${left.sourceId}`.localeCompare(
        `${right.code}:${right.source}:${right.sourceId}`,
      ),
    ),
  };
}

function parseUser(row: IdentitySourceRow): PlannedIdentityUser {
  const sourceStatus = text(row.data["status"], "status");
  const status = mapProductionLegacyUserStatus(sourceStatus);
  if (!status) throw new Error("status is unsupported");
  const type = text(row.data["type"], "type") as LegacyIdentityUserType;
  if (!USER_TYPES.has(type)) throw new Error("type is unsupported");
  return {
    id: uuid(row.data["id"], "id"),
    email: text(row.data["email"], "email").trim().toLowerCase(),
    name: text(row.data["name"], "name"),
    sourceStatus,
    status,
    type,
    emailVerified: bool(row.data["email_verified"], "email_verified"),
    isSuperadmin: bool(row.data["is_superadmin"], "is_superadmin"),
    disposition: "migrate",
    createdAt: isoDate(row.data["created_at"], "created_at"),
    updatedAt: isoDate(row.data["updated_at"], "updated_at"),
    termsAcceptedAt: optionalDate(row.data["terms_accepted_at"], "terms_accepted_at"),
    termsVersion: optionalText(row.data["terms_version"], "terms_version"),
    privacyAcceptedAt: optionalDate(row.data["privacy_accepted_at"], "privacy_accepted_at"),
    privacyVersion: optionalText(row.data["privacy_version"], "privacy_version"),
    marketingConsent: optionalBool(row.data["marketing_consent"], "marketing_consent") ?? false,
    marketingConsentAt: optionalDate(row.data["marketing_consent_at"], "marketing_consent_at"),
  };
}

function addSourceDuplicateIdBlockers(
  users: PlannedIdentityUser[],
  blockers: IdentityMigrationBlocker[],
): void {
  const counts = new Map<string, number>();
  for (const user of users) counts.set(user.id, (counts.get(user.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1)
      addBlocker(
        blockers,
        "DUPLICATE_USER_ID",
        "auth.users",
        id,
        "Source user ID occurs more than once",
      );
  }
}

function addFinalEmailBlockers(
  users: PlannedIdentityUser[],
  blockers: IdentityMigrationBlocker[],
): void {
  const groups = new Map<string, Set<string>>();
  for (const user of users)
    groups.set(user.email, new Set([...(groups.get(user.email) ?? []), user.id]));
  for (const [email, userIds] of groups) {
    if (userIds.size > 1)
      addBlocker(
        blockers,
        "DUPLICATE_EMAIL",
        "auth.users",
        hashLabel(email),
        `Normalized email belongs to users ${[...userIds].sort().join(", ")}`,
      );
  }
}

function validateWorkosLinks(
  identities: ExistingWorkosIdentity[],
  sourceIds: Set<string>,
  blockers: IdentityMigrationBlocker[],
): ExistingWorkosIdentity[] {
  const accepted = identities.filter((identity) => sourceIds.has(identity.userId));
  for (const [label, key, value] of [
    [
      "user",
      (row: ExistingWorkosIdentity) => row.userId,
      (row: ExistingWorkosIdentity) => row.providerUserId,
    ],
    [
      "provider",
      (row: ExistingWorkosIdentity) => row.providerUserId,
      (row: ExistingWorkosIdentity) => row.userId,
    ],
  ] as const) {
    const groups = new Map<string, Set<string>>();
    for (const row of accepted)
      groups.set(key(row), new Set([...(groups.get(key(row)) ?? []), value(row)]));
    for (const [id, values] of groups) {
      if (values.size > 1)
        addBlocker(
          blockers,
          "INVALID_PROVIDER_LINK",
          "identity.external_identities",
          id,
          `WorkOS ${label} link is ambiguous`,
        );
    }
  }
  return accepted.sort((left, right) => left.userId.localeCompare(right.userId));
}

function addBlocker(
  blockers: IdentityMigrationBlocker[],
  code: string,
  source: string,
  sourceIdValue: string,
  message: string,
): void {
  blockers.push({ code, source, sourceId: sourceIdValue, message });
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  return value;
}

function uuid(value: unknown, field: string): string {
  const result = text(value, field).toLowerCase();
  if (!UUID.test(result)) throw new Error(`${field} must be a UUID`);
  return result;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalBool(value: unknown, field: string): boolean | null {
  return value == null ? null : bool(value, field);
}

function isoDate(value: unknown, field: string): string {
  if (typeof value !== "string" && !(value instanceof Date))
    throw new Error(`${field} must be a timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function optionalDate(value: unknown, field: string): string | null {
  return value == null || value === "" ? null : isoDate(value, field);
}

function sourceId(row: IdentitySourceRow): string {
  return typeof row.data["id"] === "string" ? row.data["id"] : `row:${row.rowOrdinal}`;
}

function hashLabel(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}
