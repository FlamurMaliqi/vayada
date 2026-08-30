#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { WorkOS } from "@workos-inc/node";

import {
  createWorkosBackfillCohortForOrganizationKind,
  createWorkosBackfillCohortForEmail,
  createPgWorkosBackfillRepository,
  runWorkosBackfill,
  type WorkosBackfillClient,
  type WorkosBackfillCohort,
  type WorkosBackfillMode,
  type WorkosBackfillSummary,
} from "../workosBackfill.js";

function parseArgs(argv: string[]): {
  mode: WorkosBackfillMode;
  connectionString: string;
  legacyAuthConnectionString: string;
  sourceRunId: string;
  workosApiKey: string;
  cohortManifestPath?: string;
  email?: string;
  organizationId?: string;
  organizationKind?: string;
  confirm: string;
} {
  const args = argv.slice(2);
  let mode: WorkosBackfillMode = "dry-run";
  let connectionString = process.env["TARGET_DATABASE_URL"] ?? "";
  let legacyAuthConnectionString = process.env["WORKOS_BACKFILL_LEGACY_AUTH_DATABASE_URL"] ?? "";
  let sourceRunId = process.env["WORKOS_BACKFILL_SOURCE_RUN_ID"] ?? "";
  let workosApiKey = process.env["WORKOS_API_KEY"] ?? "";
  let cohortManifestPath = "";
  let email = "";
  let organizationId = "";
  let organizationKind = "";
  let confirm = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      mode = "dry-run";
    } else if (arg === "--apply") {
      mode = "apply";
    } else if (arg === "--connection-string" && args[i + 1]) {
      connectionString = args[++i];
    } else if (arg === "--legacy-auth-connection-string" && args[i + 1]) {
      legacyAuthConnectionString = args[++i];
    } else if (arg === "--source-run-id" && args[i + 1]) {
      sourceRunId = args[++i];
    } else if (arg === "--cohort-manifest" && args[i + 1]) {
      cohortManifestPath = args[++i];
    } else if (arg === "--email" && args[i + 1]) {
      email = args[++i];
    } else if (arg === "--organization-id" && args[i + 1]) {
      organizationId = args[++i];
    } else if (arg === "--organization-kind" && args[i + 1]) {
      organizationKind = args[++i];
    } else if (arg === "--confirm" && args[i + 1]) {
      confirm = args[++i];
    }
  }

  return {
    mode,
    connectionString,
    legacyAuthConnectionString,
    sourceRunId,
    workosApiKey,
    cohortManifestPath: cohortManifestPath || undefined,
    email: email || undefined,
    organizationId: organizationId || undefined,
    organizationKind: organizationKind || undefined,
    confirm,
  };
}

const {
  mode,
  connectionString,
  legacyAuthConnectionString,
  sourceRunId,
  workosApiKey,
  cohortManifestPath,
  email,
  organizationId,
  organizationKind,
  confirm,
} = parseArgs(process.argv);

if (!connectionString) {
  console.error("Error: TARGET_DATABASE_URL or --connection-string is required.");
  process.exit(1);
}
if (legacyAuthConnectionString && sourceRunId) {
  console.error("Error: use either --source-run-id or --legacy-auth-connection-string, not both.");
  process.exit(1);
}
const cohortSourceCount = [cohortManifestPath, email, organizationKind].filter(Boolean).length;
if (cohortSourceCount === 0) {
  console.error("Error: --cohort-manifest, --email, or --organization-kind is required.");
  process.exit(1);
}
if (cohortSourceCount > 1) {
  console.error("Error: pass only one of --cohort-manifest, --email, or --organization-kind.");
  process.exit(1);
}
if (organizationId && !email) {
  console.error("Error: --organization-id requires --email.");
  process.exit(1);
}
if (mode === "apply" && !workosApiKey) {
  console.error("Error: WORKOS_API_KEY is required with --apply.");
  process.exit(1);
}

const repository = createPgWorkosBackfillRepository({
  connectionString,
  legacyAuthConnectionString,
  sourceRunId,
});
try {
  const source = cohortManifestPath ? null : await repository.loadSource();
  const cohort = cohortManifestPath
    ? await loadCohortManifest(cohortManifestPath)
    : email
      ? createWorkosBackfillCohortForEmail(source!, email, organizationId)
      : createWorkosBackfillCohortForOrganizationKind(source!, organizationKind!);
  if (mode === "apply" && confirm !== cohort.key) {
    console.error(`Error: --apply requires --confirm ${cohort.key}.`);
    process.exitCode = 1;
  } else {
    console.log(`WorkOS backfill target cohort: ${cohort.key}`);
    console.log(`Database URL host: ${safeDatabaseTarget(connectionString)}`);
    if (legacyAuthConnectionString) {
      console.log(`Legacy auth DB host: ${safeDatabaseTarget(legacyAuthConnectionString)}`);
    }
    if (sourceRunId) console.log(`Immutable auth source run: ${sourceRunId}`);

    const summary = await runWorkosBackfill({
      mode,
      cohort,
      repository,
      workos: workosApiKey ? createSdkBackfillClient(workosApiKey) : undefined,
    });
    printSummary(summary);
    if (summary.warnings.length > 0 || (mode === "apply" && hasParityGaps(summary))) {
      process.exitCode = 2;
    }
  }
} finally {
  await repository.close?.();
}

function createSdkBackfillClient(apiKey: string): WorkosBackfillClient {
  const workos = new WorkOS(apiKey);

  return {
    async getUserByExternalId(externalId) {
      try {
        const user = await workos.userManagement.getUserByExternalId(externalId);
        return { id: user.id, externalId: user.externalId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async getUser(userId) {
      try {
        const user = await workos.userManagement.getUser(userId);
        return { id: user.id, externalId: user.externalId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async updateUserExternalId(userId, externalId) {
      await workos.userManagement.updateUser({ userId, externalId });
    },
    async updateUserPasswordHash(userId, passwordHash, passwordHashType) {
      await workos.userManagement.updateUser({ userId, passwordHash, passwordHashType });
    },
    async createUser(input) {
      const user = await workos.userManagement.createUser({
        email: input.email,
        name: input.name,
        emailVerified: input.emailVerified,
        externalId: input.externalId,
        metadata: input.metadata,
        passwordHash: input.passwordHash,
        passwordHashType: input.passwordHashType,
      });
      return { id: user.id, externalId: user.externalId };
    },
    async getOrganizationByExternalId(externalId) {
      try {
        const organization = await workos.organizations.getOrganizationByExternalId(externalId);
        return { id: organization.id, externalId: organization.externalId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async getOrganization(organizationId) {
      try {
        const organization = await workos.organizations.getOrganization(organizationId);
        return { id: organization.id, externalId: organization.externalId };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async updateOrganizationExternalId(organizationId, externalId) {
      await workos.organizations.updateOrganization({
        organization: organizationId,
        externalId,
      });
    },
    async createOrganization(input) {
      const organization = await workos.organizations.createOrganization(
        {
          name: input.name,
          externalId: input.externalId,
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: organization.id, externalId: organization.externalId };
    },
    async createOrganizationMembership(input) {
      const membership = await workos.userManagement.createOrganizationMembership({
        userId: input.userId,
        organizationId: input.organizationId,
        ...membershipRoleInput(input.roleSlugs),
      });
      return {
        id: membership.id,
        roleSlugs: membershipRoleSlugs(membership, input.roleSlugs),
        status: membership.status,
      };
    },
    async getOrganizationMembership(membershipId) {
      try {
        const membership = await workos.userManagement.getOrganizationMembership(membershipId);
        return {
          id: membership.id,
          userId: membership.userId,
          organizationId: membership.organizationId,
          roleSlugs: membershipRoleSlugs(membership),
          status: membership.status,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async updateOrganizationMembershipRoles(membershipId, roleSlugs) {
      const membership = await workos.userManagement.updateOrganizationMembership(membershipId, {
        ...membershipRoleInput(roleSlugs),
      });
      return {
        id: membership.id,
        roleSlugs: membershipRoleSlugs(membership, roleSlugs),
        status: membership.status,
      };
    },
    async findOrganizationMembership(input) {
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId: input.userId,
        organizationId: input.organizationId,
        statuses: ["active", "inactive"],
        limit: 1,
      });
      const membership = memberships.data[0];
      if (!membership) return null;
      return {
        id: membership.id,
        roleSlugs: membershipRoleSlugs(membership),
        status: membership.status,
      };
    },
  };
}

function membershipRoleInput(roleSlugs: string[]): { roleSlug?: string; roleSlugs?: string[] } {
  return roleSlugs.length === 1 ? { roleSlug: roleSlugs[0] } : { roleSlugs };
}

function membershipRoleSlugs(
  membership: { roles?: Array<{ slug: string }>; role?: { slug: string } },
  fallback: string[] = [],
): string[] {
  const roleSlugs = membership.roles?.map((role) => role.slug).filter(Boolean) ?? [];
  if (roleSlugs.length > 0) return roleSlugs;
  if (membership.role?.slug) return [membership.role.slug];
  return fallback;
}

function hasParityGaps(summary: WorkosBackfillSummary): boolean {
  return (
    summary.parity.missingLocalUserLinks > 0 ||
    summary.parity.missingLocalOrganizationLinks > 0 ||
    summary.parity.duplicateLocalOrganizationLinks > 0 ||
    summary.parity.missingLocalMembershipLinks > 0 ||
    summary.parity.staleLocalMembershipLinks > 0 ||
    summary.parity.membershipRoleMismatches > 0
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

function printSummary(summary: WorkosBackfillSummary): void {
  console.log(`WorkOS backfill ${summary.mode} summary for ${summary.cohortKey}`);
  console.log(`Users:         ${formatCounter(summary.users)}`);
  console.log(`Organizations: ${formatCounter(summary.organizations)}`);
  console.log(`Memberships:   ${formatCounter(summary.memberships)}`);
  console.log(
    `Parity missing links: users=${summary.parity.missingLocalUserLinks}, ` +
      `organizations=${summary.parity.missingLocalOrganizationLinks}, ` +
      `duplicateOrganizations=${summary.parity.duplicateLocalOrganizationLinks}, ` +
      `memberships=${summary.parity.missingLocalMembershipLinks}, ` +
      `staleMemberships=${summary.parity.staleLocalMembershipLinks}, ` +
      `membershipRoleMismatches=${summary.parity.membershipRoleMismatches}`,
  );
  if (summary.warnings.length > 0) {
    console.log("Warnings:");
    for (const warning of summary.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

function formatCounter(counter: WorkosBackfillSummary["users"]): string {
  return (
    `planned=${counter.planned}, created=${counter.created}, ` +
    `linkedExisting=${counter.linkedExisting}, skipped=${counter.skipped}, conflicts=${counter.conflicts}`
  );
}

async function loadCohortManifest(path: string): Promise<WorkosBackfillCohort> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cohort manifest must be a JSON object.");
  }
  const manifest = parsed as Partial<WorkosBackfillCohort>;
  return {
    key: requireString(manifest.key, "key"),
    userIds: requireStringArray(manifest.userIds, "userIds"),
    organizationIds: requireStringArray(manifest.organizationIds, "organizationIds"),
    membershipIds: optionalStringArray(manifest.membershipIds, "membershipIds"),
  };
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Cohort manifest ${key} must be a non-empty string.`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`Cohort manifest ${key} must be a non-empty string array.`);
  }
  return value;
}

function optionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`Cohort manifest ${key} must be a string array when provided.`);
  }
  return value;
}

function safeDatabaseTarget(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}/${url.pathname.replace(/^\//, "")}`;
}
