import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";
import { readProductionIdentitySnapshot } from "./productionIdentitySnapshotReader.js";

export type WorkosBackfillMode = "dry-run" | "apply";

export type WorkosBackfillUser = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  emailVerified: boolean;
  workosUserId: string | null;
  workosIdentityCount: number;
  passwordHash: string | null;
  passwordHashType: "bcrypt" | null;
};

export type WorkosBackfillOrganization = {
  id: string;
  kind: string;
  name: string;
  slug: string;
  status: string;
  workosOrgId: string | null;
  workosExternalId: string | null;
};

export type WorkosBackfillMembership = {
  id: string;
  userId: string;
  organizationId: string;
  status: string;
  roleKey: string;
  workosMembershipId: string | null;
  workosRoleSlugs: string[];
};

export type WorkosBackfillSource = {
  users: WorkosBackfillUser[];
  organizations: WorkosBackfillOrganization[];
  memberships: WorkosBackfillMembership[];
};

export type LegacyAuthBackfillRow = {
  id: string;
  emailVerified: boolean | null;
  passwordHash: string | null;
};

export type WorkosBackfillCohort = {
  key: string;
  userIds: string[];
  organizationIds: string[];
  membershipIds?: string[];
};

export type WorkosBackfillRepository = {
  loadSource(): Promise<WorkosBackfillSource>;
  close?(): Promise<void>;
  linkUser(input: {
    userId: string;
    workosUserId: string;
    email: string;
    emailVerified: boolean;
    rawProfile: Record<string, unknown>;
    retireWorkosUserIds?: string[];
  }): Promise<void>;
  linkOrganization(input: {
    organizationId: string;
    workosOrgId: string;
    workosExternalId: string;
  }): Promise<void>;
  linkMembership(input: {
    membershipId: string;
    workosMembershipId: string;
    roleSlugs: string[];
  }): Promise<void>;
};

export type WorkosBackfillClient = {
  getUser(userId: string): Promise<{ id: string; externalId: string | null } | null>;
  getUserByExternalId(
    externalId: string,
  ): Promise<{ id: string; externalId: string | null } | null>;
  updateUserExternalId(userId: string, externalId: string): Promise<void>;
  updateUserPasswordHash(
    userId: string,
    passwordHash: string,
    passwordHashType: "bcrypt",
  ): Promise<void>;
  createUser(input: {
    email: string;
    name?: string;
    emailVerified: boolean;
    externalId: string;
    metadata: Record<string, string>;
    passwordHash?: string;
    passwordHashType?: "bcrypt";
  }): Promise<{ id: string; externalId: string | null }>;
  getOrganization(
    organizationId: string,
  ): Promise<{ id: string; externalId: string | null } | null>;
  getOrganizationByExternalId(
    externalId: string,
  ): Promise<{ id: string; externalId: string | null } | null>;
  updateOrganizationExternalId(organizationId: string, externalId: string): Promise<void>;
  createOrganization(input: {
    name: string;
    externalId: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; externalId: string | null }>;
  createOrganizationMembership(input: {
    userId: string;
    organizationId: string;
    roleSlugs: string[];
  }): Promise<{ id: string; roleSlugs: string[]; status?: string }>;
  getOrganizationMembership(membershipId: string): Promise<{
    id: string;
    userId: string;
    organizationId: string;
    roleSlugs: string[];
    status: string;
  } | null>;
  updateOrganizationMembershipRoles(
    membershipId: string,
    roleSlugs: string[],
  ): Promise<{ id: string; roleSlugs: string[]; status: string }>;
  findOrganizationMembership(input: {
    userId: string;
    organizationId: string;
  }): Promise<{ id: string; roleSlugs: string[]; status: string } | null>;
};

export type WorkosBackfillSummary = {
  mode: WorkosBackfillMode;
  cohortKey: string;
  users: BackfillCounter;
  organizations: BackfillCounter;
  memberships: BackfillCounter;
  parity: {
    missingLocalUserLinks: number;
    missingLocalOrganizationLinks: number;
    duplicateLocalOrganizationLinks: number;
    missingLocalMembershipLinks: number;
    staleLocalMembershipLinks: number;
    membershipRoleMismatches: number;
  };
  warnings: string[];
};

export type BackfillCounter = {
  planned: number;
  created: number;
  linkedExisting: number;
  skipped: number;
  conflicts: number;
};

export type WorkosBackfillConfig = {
  mode: WorkosBackfillMode;
  cohort: WorkosBackfillCohort;
  repository: WorkosBackfillRepository;
  workos?: WorkosBackfillClient;
};

export async function runWorkosBackfill(
  config: WorkosBackfillConfig,
): Promise<WorkosBackfillSummary> {
  assertValidCohort(config.cohort);
  if (config.mode === "apply" && !config.workos) {
    throw new Error("WorkOS backfill apply mode requires a WorkOS client.");
  }

  const source = filterSourceByCohort(await config.repository.loadSource(), config.cohort);
  const summary = emptySummary(config.mode, config.cohort.key, source);
  const workosUserIds = new Map<string, string>();
  const workosOrgIds = new Map<string, string>();

  for (const user of source.users) {
    if (user.workosUserId) {
      const verifiedUserId = await verifyExistingUserLink(config, user, summary);
      if (verifiedUserId) workosUserIds.set(user.id, verifiedUserId);
      continue;
    }
    if (user.status === "deleted") {
      summary.users.skipped++;
      summary.warnings.push(`Skipped deleted user ${user.id}`);
      continue;
    }

    if (!config.workos) {
      summary.users.planned++;
      workosUserIds.set(user.id, `planned:${user.id}`);
      continue;
    }

    const workos = config.workos;
    const existing = await workos.getUserByExternalId(user.id);
    if (existing && existing.externalId !== user.id) {
      summary.users.conflicts++;
      summary.warnings.push(`Conflicting WorkOS external_id for user ${user.id}`);
      continue;
    }
    if (config.mode === "dry-run") {
      existing ? summary.users.linkedExisting++ : summary.users.created++;
      workosUserIds.set(user.id, existing?.id ?? `planned:${user.id}`);
      continue;
    }

    const workosUser = existing ?? (await workos.createUser(createWorkosUserInput(user)));
    if (existing && user.passwordHash && user.passwordHashType) {
      await workos.updateUserPasswordHash(existing.id, user.passwordHash, user.passwordHashType);
    }
    existing ? summary.users.linkedExisting++ : summary.users.created++;
    workosUserIds.set(user.id, workosUser.id);
    await config.repository.linkUser({
      userId: user.id,
      workosUserId: workosUser.id,
      email: user.email,
      emailVerified: user.emailVerified,
      rawProfile: { externalId: user.id, source: "vayada-backfill" },
    });
  }

  for (const organization of source.organizations) {
    if (organization.workosOrgId) {
      const verified = await verifyExistingOrganizationLink(config, organization, summary);
      if (verified) {
        workosOrgIds.set(organization.id, organization.workosOrgId);
        if (config.mode === "apply" && organization.workosExternalId !== organization.id) {
          await config.repository.linkOrganization({
            organizationId: organization.id,
            workosOrgId: organization.workosOrgId,
            workosExternalId: organization.id,
          });
        }
      }
      continue;
    }
    if (organization.status === "archived") {
      summary.organizations.skipped++;
      summary.warnings.push(`Skipped archived organization ${organization.id}`);
      continue;
    }
    if (!config.workos) {
      summary.organizations.planned++;
      workosOrgIds.set(organization.id, `planned:${organization.id}`);
      continue;
    }

    const workos = config.workos;
    const existing = await workos.getOrganizationByExternalId(organization.id);
    if (existing && existing.externalId !== organization.id) {
      summary.organizations.conflicts++;
      summary.warnings.push(`Conflicting WorkOS external_id for organization ${organization.id}`);
      continue;
    }
    if (config.mode === "dry-run") {
      existing ? summary.organizations.linkedExisting++ : summary.organizations.created++;
      workosOrgIds.set(organization.id, existing?.id ?? `planned:${organization.id}`);
      continue;
    }

    const workosOrganization =
      existing ??
      (await workos.createOrganization({
        name: organization.name,
        externalId: organization.id,
        idempotencyKey: `vayada-org-backfill:${organization.id}`,
        metadata: {
          vayada_organization_id: organization.id,
          vayada_kind: organization.kind,
          source: "vayada-backfill",
        },
      }));
    existing ? summary.organizations.linkedExisting++ : summary.organizations.created++;
    workosOrgIds.set(organization.id, workosOrganization.id);
    await config.repository.linkOrganization({
      organizationId: organization.id,
      workosOrgId: workosOrganization.id,
      workosExternalId: organization.id,
    });
  }

  for (const membership of source.memberships) {
    if (membership.status !== "active") {
      summary.memberships.skipped++;
      summary.warnings.push(`Skipped non-active membership ${membership.id}`);
      continue;
    }
    const userId = workosUserIds.get(membership.userId);
    const organizationId = workosOrgIds.get(membership.organizationId);
    if (!userId || !organizationId) {
      summary.memberships.skipped++;
      summary.warnings.push(
        `Skipped membership ${membership.id} because user/org is not WorkOS-linked`,
      );
      continue;
    }
    const roleSlugs = normalizedRoleSlugs(membership);
    if (membership.workosMembershipId) {
      if (!config.workos) {
        summary.memberships.skipped++;
        continue;
      }
      await verifyExistingMembershipLink(
        config,
        membership,
        userId,
        organizationId,
        roleSlugs,
        summary,
      );
      continue;
    }
    if (config.mode === "dry-run") {
      if (!config.workos) {
        summary.memberships.planned++;
        continue;
      }
      const existing = await config.workos.findOrganizationMembership({ userId, organizationId });
      existing ? summary.memberships.linkedExisting++ : summary.memberships.created++;
      continue;
    }

    const workos = config.workos!;
    const existing = await workos.findOrganizationMembership({
      userId,
      organizationId,
    });
    if (existing && existing.status !== "active" && existing.status !== "inactive") {
      summary.memberships.conflicts++;
      summary.warnings.push(
        `Conflicting WorkOS membership ${existing.id} has unsupported status ${existing.status}`,
      );
      continue;
    }
    const workosMembership =
      existing?.status === "active"
        ? await ensureMembershipRoles(config, existing, roleSlugs, summary)
        : await workos.createOrganizationMembership({
            userId,
            organizationId,
            roleSlugs,
          });
    existing ? summary.memberships.linkedExisting++ : summary.memberships.created++;
    await config.repository.linkMembership({
      membershipId: membership.id,
      workosMembershipId: workosMembership.id,
      roleSlugs: workosMembership.roleSlugs.length > 0 ? workosMembership.roleSlugs : roleSlugs,
    });
  }

  if (config.mode === "apply") {
    const staleLocalMembershipLinks = summary.parity.staleLocalMembershipLinks;
    const postApplySource = filterSourceByCohort(
      await config.repository.loadSource(),
      config.cohort,
    );
    summary.parity = {
      ...computeParity(postApplySource),
      staleLocalMembershipLinks,
    };
  }

  return summary;
}

function createWorkosUserInput(user: WorkosBackfillUser) {
  return {
    email: user.email,
    name: user.name ?? undefined,
    emailVerified: user.emailVerified,
    externalId: user.id,
    metadata: {
      vayada_user_id: user.id,
      source: "vayada-backfill",
    },
    passwordHash: user.passwordHash ?? undefined,
    passwordHashType: user.passwordHashType ?? undefined,
  };
}

export function createWorkosBackfillCohortForEmail(
  source: WorkosBackfillSource,
  email: string,
  organizationId?: string,
): WorkosBackfillCohort {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("WorkOS backfill email is required.");
  }

  const matchingUsers = source.users.filter((user) => user.email.toLowerCase() === normalizedEmail);
  if (matchingUsers.length === 0) {
    throw new Error(`No target identity user found for email ${email}.`);
  }
  const users = matchingUsers.filter((user) => user.status !== "deleted");
  if (users.length === 0) {
    throw new Error(`No non-deleted target identity user found for email ${email}.`);
  }
  if (users.length > 1) {
    throw new Error(`Multiple non-deleted target identity users found for email ${email}.`);
  }

  const user = users[0];
  const normalizedOrganizationId = organizationId?.trim();
  const memberships = source.memberships.filter(
    (membership) =>
      membership.userId === user.id &&
      (!normalizedOrganizationId || membership.organizationId === normalizedOrganizationId),
  );
  if (normalizedOrganizationId && memberships.length === 0) {
    throw new Error(
      `No target membership found for email ${email} and organization ${normalizedOrganizationId}.`,
    );
  }
  return {
    key: normalizedOrganizationId
      ? `email:${user.email}:organization:${normalizedOrganizationId}`
      : `email:${user.email}`,
    userIds: [user.id],
    organizationIds: Array.from(
      new Set(memberships.map((membership) => membership.organizationId)),
    ),
    membershipIds: memberships.map((membership) => membership.id),
  };
}

export function createWorkosBackfillCohortForOrganizationKind(
  source: WorkosBackfillSource,
  organizationKind: string,
): WorkosBackfillCohort {
  const normalizedKind = organizationKind.trim().toLowerCase();
  if (!normalizedKind) {
    throw new Error("WorkOS backfill organization kind is required.");
  }

  const organizations = source.organizations.filter(
    (organization) => organization.kind === normalizedKind && organization.status === "active",
  );
  if (organizations.length === 0) {
    throw new Error(`No active target organizations found for kind ${normalizedKind}.`);
  }

  const organizationIds = new Set(organizations.map((organization) => organization.id));
  const activeUserIds = new Set(
    source.users.filter((user) => user.status === "active").map((user) => user.id),
  );
  const memberships = source.memberships.filter(
    (membership) =>
      membership.status === "active" &&
      organizationIds.has(membership.organizationId) &&
      activeUserIds.has(membership.userId),
  );
  if (memberships.length === 0) {
    throw new Error(`No active memberships found for organization kind ${normalizedKind}.`);
  }

  return {
    key: `organization-kind:${normalizedKind}`,
    userIds: Array.from(new Set(memberships.map((membership) => membership.userId))),
    organizationIds: Array.from(organizationIds),
    membershipIds: memberships.map((membership) => membership.id),
  };
}

export function createPgWorkosBackfillRepository(config: {
  connectionString: string;
  legacyAuthConnectionString?: string;
  sourceRunId?: string;
  max?: number;
}): WorkosBackfillRepository {
  if (config.legacyAuthConnectionString && config.sourceRunId) {
    throw new Error("Use either a legacy auth connection or an immutable source run, not both.");
  }
  const pool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.connectionString),
    max: config.max,
  });
  const legacyAuthPool = config.legacyAuthConnectionString
    ? new pg.Pool({
        connectionString: normalizePgConnectionString(config.legacyAuthConnectionString),
        max: config.max,
      })
    : null;

  return {
    async close() {
      await Promise.all([pool.end(), legacyAuthPool?.end()]);
    },
    async loadSource() {
      const [users, organizations, memberships] = await Promise.all([
        pool.query<WorkosBackfillUser>(
          `SELECT
             users.id::text AS id,
             users.email,
             users.name,
             users.status,
             COALESCE((
               SELECT bool_or(provider_email_verified)
               FROM identity.external_identities
               WHERE user_id = users.id AND provider = 'workos'
             ), false) AS "emailVerified",
             (
               SELECT provider_user_id
               FROM identity.external_identities
               WHERE user_id = users.id
                 AND provider = 'workos'
                 AND provider_user_id IS NOT NULL
               ORDER BY created_at
               LIMIT 1
             ) AS "workosUserId",
             (
               SELECT count(*)::int
               FROM identity.external_identities
               WHERE user_id = users.id
                 AND provider = 'workos'
                 AND provider_user_id IS NOT NULL
             ) AS "workosIdentityCount",
             NULL::text AS "passwordHash",
             NULL::text AS "passwordHashType"
           FROM identity.users users
           ORDER BY users.id`,
        ),
        pool.query<WorkosBackfillOrganization>(
          `SELECT
             id::text,
             kind,
             name,
             slug,
             status,
             workos_org_id AS "workosOrgId",
             workos_external_id AS "workosExternalId"
           FROM identity.organizations
           ORDER BY id`,
        ),
        pool.query<WorkosBackfillMembership>(
          `SELECT
             id::text,
             user_id::text AS "userId",
             organization_id::text AS "organizationId",
             status,
             role_key AS "roleKey",
             workos_membership_id AS "workosMembershipId",
             workos_role_slugs AS "workosRoleSlugs"
           FROM identity.organization_memberships
           ORDER BY id`,
        ),
      ]);

      return {
        users: config.sourceRunId
          ? await attachSnapshotAuthFields(users.rows, pool, config.sourceRunId)
          : await attachLegacyAuthFields(users.rows, legacyAuthPool),
        organizations: organizations.rows,
        memberships: memberships.rows,
      };
    },
    async linkUser(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const existing = await client.query<{ id: string; provider_user_id: string | null }>(
          `SELECT id::text, provider_user_id
           FROM identity.external_identities
           WHERE user_id = $1 AND provider = 'workos'
           FOR UPDATE`,
          [input.userId],
        );
        const canonicalRow = existing.rows.find(
          (row) => row.provider_user_id === input.workosUserId,
        );
        const linkedProviderUserIds = existing.rows
          .map((row) => row.provider_user_id)
          .filter((providerUserId): providerUserId is string => Boolean(providerUserId));
        const requestedRetireIds = new Set(input.retireWorkosUserIds ?? []);
        const conflictingProviderUserId = linkedProviderUserIds.find(
          (providerUserId) =>
            providerUserId !== input.workosUserId && !requestedRetireIds.has(providerUserId),
        );
        if (conflictingProviderUserId) {
          throw new Error(
            `User ${input.userId} is already linked to different WorkOS user ${conflictingProviderUserId}`,
          );
        }
        const existingProviderMapping = await client.query<{
          id: string;
          user_id: string;
          mapped_email: string;
          mapped_status: string;
          target_email: string;
          target_status: string;
        }>(
          `SELECT
             external_identities.id::text,
             external_identities.user_id::text,
             mapped_user.email AS mapped_email,
             mapped_user.status AS mapped_status,
             target_user.email AS target_email,
             target_user.status AS target_status
           FROM identity.external_identities
           JOIN identity.users mapped_user ON mapped_user.id = external_identities.user_id
           JOIN identity.users target_user ON target_user.id = $2
           WHERE external_identities.provider = 'workos'
             AND external_identities.provider_user_id = $1
           FOR UPDATE OF external_identities, mapped_user, target_user`,
          [input.workosUserId, input.userId],
        );
        const mappedIdentity = existingProviderMapping.rows[0];
        let transferredFromUserId: string | null = null;
        if (mappedIdentity && mappedIdentity.user_id !== input.userId) {
          const sameEmail =
            mappedIdentity.mapped_email.trim().toLowerCase() ===
            mappedIdentity.target_email.trim().toLowerCase();
          if (
            mappedIdentity.mapped_status !== "deleted" ||
            mappedIdentity.target_status !== "active" ||
            !sameEmail
          ) {
            throw new Error(
              `WorkOS user ${input.workosUserId} is already linked to user ${mappedIdentity.user_id}`,
            );
          }
          transferredFromUserId = mappedIdentity.user_id;
          await client.query(
            `UPDATE identity.external_identities
             SET raw_profile = jsonb_set(
                   COALESCE(raw_profile, '{}'::jsonb),
                   '{provider_link_history}',
                   COALESCE(raw_profile -> 'provider_link_history', '[]'::jsonb) ||
                     jsonb_build_array(jsonb_build_object(
                       'provider_user_id', provider_user_id,
                       'reason', 'duplicate_user_consolidation',
                       'to_user_id', $2::text,
                       'at', now()
                     ))
                 ),
                 provider_user_id = NULL,
                 provider_email_verified = false,
                 updated_at = now()
             WHERE id = $1`,
            [mappedIdentity.id, input.userId],
          );
        }

        const retiredWorkosUserIds = linkedProviderUserIds.filter((providerUserId) =>
          requestedRetireIds.has(providerUserId),
        );
        if (retiredWorkosUserIds.length > 0) {
          await client.query(
            `UPDATE identity.external_identities
               SET raw_profile = jsonb_set(
                     COALESCE(raw_profile, '{}'::jsonb),
                     '{provider_link_history}',
                     COALESCE(raw_profile -> 'provider_link_history', '[]'::jsonb) ||
                       jsonb_build_array(jsonb_build_object(
                         'provider_user_id', provider_user_id,
                         'reason', 'workos_user_missing',
                         'at', now()
                       ))
                   ),
                   provider_user_id = NULL,
                   provider_email_verified = false,
                   updated_at = now()
               WHERE user_id = $1
                 AND provider = 'workos'
                 AND provider_user_id IS NOT NULL
                 AND provider_user_id = ANY($2::text[])`,
            [input.userId, retiredWorkosUserIds],
          );
        }
        const updated = await client.query(
          `UPDATE identity.external_identities
           SET provider_user_id = $2,
               provider_email = $3,
               provider_email_verified = $4,
               raw_profile = COALESCE(raw_profile, '{}'::jsonb) || $5::jsonb,
               updated_at = now()
           WHERE id = COALESCE(
             $6::uuid,
             (
               SELECT id
               FROM identity.external_identities
               WHERE user_id = $1
                 AND provider = 'workos'
                 AND provider_user_id IS NULL
               ORDER BY created_at
               LIMIT 1
             )
           )`,
          [
            input.userId,
            input.workosUserId,
            input.email,
            input.emailVerified,
            JSON.stringify(input.rawProfile),
            canonicalRow?.id ?? null,
          ],
        );
        if (updated.rowCount === 0) {
          await client.query(
            `INSERT INTO identity.external_identities
               (user_id, provider, provider_user_id, provider_email, provider_email_verified, raw_profile)
             VALUES ($1, 'workos', $2, $3, $4, $5)
             ON CONFLICT (provider, provider_user_id) WHERE provider_user_id IS NOT NULL
             DO UPDATE SET
               user_id = EXCLUDED.user_id,
               provider_email = EXCLUDED.provider_email,
               provider_email_verified = EXCLUDED.provider_email_verified,
               raw_profile = EXCLUDED.raw_profile,
               updated_at = now()
             WHERE identity.external_identities.user_id = EXCLUDED.user_id`,
            [
              input.userId,
              input.workosUserId,
              input.email,
              input.emailVerified,
              JSON.stringify(input.rawProfile),
            ],
          );
        }
        await insertReconciliationEvent(client, {
          eventType: "workos.backfill.user.linked",
          providerEventId: `backfill:user:${input.userId}`,
          userId: input.userId,
          payload: {
            workosUserId: input.workosUserId,
            retiredWorkosUserIds,
            transferredFromUserId,
          },
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async linkOrganization(input) {
      const result = await pool.query(
        `UPDATE identity.organizations
         SET workos_org_id = $2,
             workos_external_id = $3,
             updated_at = now()
         WHERE id = $1
           AND (workos_org_id IS NULL OR workos_org_id = $2)
           AND (workos_external_id IS NULL OR workos_external_id = $3)`,
        [input.organizationId, input.workosOrgId, input.workosExternalId],
      );
      if (result.rowCount !== 1) {
        throw new Error(`Organization ${input.organizationId} has conflicting WorkOS mapping`);
      }
      await insertReconciliationEvent(pool, {
        eventType: "workos.backfill.organization.linked",
        providerEventId: `backfill:organization:${input.organizationId}`,
        organizationId: input.organizationId,
        payload: { workosOrgId: input.workosOrgId, workosExternalId: input.workosExternalId },
      });
    },
    async linkMembership(input) {
      const result = await pool.query(
        `UPDATE identity.organization_memberships
         SET workos_membership_id = $2,
             workos_role_slugs = $3,
             updated_at = now()
         WHERE id = $1
           AND (workos_membership_id IS NULL OR workos_membership_id = $2)`,
        [input.membershipId, input.workosMembershipId, input.roleSlugs],
      );
      if (result.rowCount !== 1) {
        throw new Error(`Membership ${input.membershipId} has conflicting WorkOS mapping`);
      }
      await insertReconciliationEvent(pool, {
        eventType: "workos.backfill.membership.linked",
        providerEventId: `backfill:membership:${input.membershipId}`,
        payload: { workosMembershipId: input.workosMembershipId, roleSlugs: input.roleSlugs },
      });
    },
  };
}

async function attachSnapshotAuthFields(
  users: WorkosBackfillUser[],
  pool: pg.Pool,
  sourceRunId: string,
): Promise<WorkosBackfillUser[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = await readProductionIdentitySnapshot(client, sourceRunId);
    const acceptedUserIds = new Set(users.map((user) => user.id));
    const legacyRows = snapshot.rows
      .filter(
        (row) =>
          row.sourceDatabase === "auth" &&
          row.sourceTable === "users" &&
          typeof row.data["id"] === "string" &&
          acceptedUserIds.has(row.data["id"]),
      )
      .map(snapshotAuthUser);
    await client.query("COMMIT");
    return mergeLegacyAuthBackfillFields(users, legacyRows);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function snapshotAuthUser(row: { data: Record<string, unknown> }): LegacyAuthBackfillRow {
  const id = row.data["id"];
  const emailVerified = row.data["email_verified"];
  if (typeof id !== "string" || typeof emailVerified !== "boolean")
    throw new Error("Immutable auth user credentials have an unsupported shape.");
  const rawPasswordHash = row.data["password_hash"];
  const passwordHash =
    typeof rawPasswordHash === "string" && /^\$2[aby]\$/.test(rawPasswordHash)
      ? rawPasswordHash
      : null;
  return { id, emailVerified, passwordHash };
}

async function attachLegacyAuthFields(
  users: WorkosBackfillUser[],
  legacyAuthPool: pg.Pool | null,
): Promise<WorkosBackfillUser[]> {
  if (!legacyAuthPool || users.length === 0) return users;

  const { rows } = await legacyAuthPool.query<LegacyAuthBackfillRow>(
    `SELECT
       id::text,
       email_verified AS "emailVerified",
       CASE
         WHEN password_hash LIKE '$2a$%'
           OR password_hash LIKE '$2b$%'
           OR password_hash LIKE '$2y$%'
         THEN password_hash
         ELSE NULL
       END AS "passwordHash"
     FROM users
     WHERE id = ANY($1::uuid[])`,
    [users.map((user) => user.id)],
  );
  return mergeLegacyAuthBackfillFields(users, rows);
}

export function mergeLegacyAuthBackfillFields(
  users: WorkosBackfillUser[],
  legacyRows: LegacyAuthBackfillRow[],
): WorkosBackfillUser[] {
  const legacyByUserId = new Map(legacyRows.map((row) => [row.id, row]));
  return users.map((user) => {
    const legacy = legacyByUserId.get(user.id);
    const passwordHash = legacy?.passwordHash ?? null;
    return {
      ...user,
      emailVerified: legacy?.emailVerified ?? user.emailVerified,
      passwordHash,
      passwordHashType: passwordHash ? "bcrypt" : null,
    };
  });
}

async function insertReconciliationEvent(
  pool: pg.Pool | pg.PoolClient,
  input: {
    eventType: string;
    providerEventId: string;
    userId?: string;
    organizationId?: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO identity.auth_reconciliation_events
       (event_type, provider, provider_event_id, user_id, organization_id, payload, processed_at)
     VALUES ($1, 'workos', $2, $3, $4, $5, now())`,
    [
      input.eventType,
      input.providerEventId,
      input.userId ?? null,
      input.organizationId ?? null,
      JSON.stringify(input.payload),
    ],
  );
}

function emptySummary(
  mode: WorkosBackfillMode,
  cohortKey: string,
  source: WorkosBackfillSource,
): WorkosBackfillSummary {
  return {
    mode,
    cohortKey,
    users: emptyCounter(),
    organizations: emptyCounter(),
    memberships: emptyCounter(),
    parity: {
      ...computeParity(source),
    },
    warnings: [],
  };
}

function computeParity(source: WorkosBackfillSource): WorkosBackfillSummary["parity"] {
  const eligibleUsers = source.users.filter((user) => user.status !== "deleted");
  const eligibleOrganizations = source.organizations.filter(
    (organization) => organization.status !== "archived",
  );
  const eligibleMemberships = source.memberships.filter(
    (membership) => membership.status === "active",
  );
  const duplicateOrganizationIds = duplicatedValues(
    eligibleOrganizations
      .map((organization) => organization.workosOrgId)
      .filter((workosOrgId): workosOrgId is string => Boolean(workosOrgId)),
  );

  return {
    missingLocalUserLinks: eligibleUsers.filter((user) => user.workosIdentityCount !== 1).length,
    missingLocalOrganizationLinks: eligibleOrganizations.filter(
      (organization) =>
        !organization.workosOrgId || organization.workosExternalId !== organization.id,
    ).length,
    duplicateLocalOrganizationLinks: eligibleOrganizations.filter(
      (organization) =>
        organization.workosOrgId && duplicateOrganizationIds.has(organization.workosOrgId),
    ).length,
    missingLocalMembershipLinks: eligibleMemberships.filter(
      (membership) => !membership.workosMembershipId,
    ).length,
    staleLocalMembershipLinks: 0,
    membershipRoleMismatches: eligibleMemberships.filter(
      (membership) =>
        membership.workosMembershipId &&
        !sameStringSet(membership.workosRoleSlugs, normalizedRoleSlugs(membership)),
    ).length,
  };
}

function duplicatedValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function emptyCounter(): BackfillCounter {
  return { planned: 0, created: 0, linkedExisting: 0, skipped: 0, conflicts: 0 };
}

function normalizedRoleSlugs(membership: WorkosBackfillMembership): string[] {
  return [workosRoleSlug(membership.roleKey)];
}

function workosRoleSlug(roleKey: string): string {
  if (roleKey === "owner" || roleKey === "hotel_owner" || roleKey === "platform_admin") {
    return "admin";
  }
  return roleKey;
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function assertValidCohort(cohort: WorkosBackfillCohort): void {
  if (!cohort.key.trim()) {
    throw new Error("WorkOS backfill cohort key is required.");
  }
  if (
    cohort.userIds.length === 0 &&
    cohort.organizationIds.length === 0 &&
    (cohort.membershipIds?.length ?? 0) === 0
  ) {
    throw new Error(`WorkOS backfill cohort ${cohort.key} is empty.`);
  }
}

function filterSourceByCohort(
  source: WorkosBackfillSource,
  cohort: WorkosBackfillCohort,
): WorkosBackfillSource {
  const userIds = new Set(cohort.userIds);
  const organizationIds = new Set(cohort.organizationIds);
  const membershipIds = new Set(cohort.membershipIds ?? []);
  const users = source.users.filter((user) => userIds.has(user.id));
  const organizations = source.organizations.filter((organization) =>
    organizationIds.has(organization.id),
  );
  const memberships = source.memberships.filter(
    (membership) =>
      membershipIds.has(membership.id) ||
      (userIds.has(membership.userId) && organizationIds.has(membership.organizationId)),
  );
  return { users, organizations, memberships };
}

async function verifyExistingUserLink(
  config: WorkosBackfillConfig,
  user: WorkosBackfillUser,
  summary: WorkosBackfillSummary,
): Promise<string | null> {
  if (!config.workos) {
    summary.users.skipped++;
    return user.workosUserId;
  }

  const workosUser = await config.workos.getUser(user.workosUserId!);
  if (!workosUser) {
    const canonicalUser = await config.workos.getUserByExternalId(user.id);
    if (!canonicalUser || canonicalUser.externalId !== user.id) {
      summary.users.conflicts++;
      summary.warnings.push(
        `Local user ${user.id} points at missing WorkOS user ${user.workosUserId}`,
      );
      return null;
    }
    if (config.mode === "apply") {
      await config.repository.linkUser({
        userId: user.id,
        workosUserId: canonicalUser.id,
        email: user.email,
        emailVerified: user.emailVerified,
        rawProfile: { externalId: user.id, source: "vayada-backfill" },
        retireWorkosUserIds: [user.workosUserId!],
      });
    } else {
      summary.warnings.push(
        `Would replace missing WorkOS user ${user.workosUserId} with ${canonicalUser.id} for local user ${user.id}`,
      );
    }
    summary.users.linkedExisting++;
    return canonicalUser.id;
  }
  if (workosUser.externalId && workosUser.externalId !== user.id) {
    summary.users.conflicts++;
    summary.warnings.push(`WorkOS user ${workosUser.id} external_id does not match ${user.id}`);
    return null;
  }
  if (!workosUser.externalId) {
    if (config.mode === "apply") {
      await config.workos.updateUserExternalId(workosUser.id, user.id);
    }
    summary.users.linkedExisting++;
    return workosUser.id;
  }
  summary.users.skipped++;
  return workosUser.id;
}

async function verifyExistingOrganizationLink(
  config: WorkosBackfillConfig,
  organization: WorkosBackfillOrganization,
  summary: WorkosBackfillSummary,
): Promise<boolean> {
  if (organization.workosExternalId && organization.workosExternalId !== organization.id) {
    summary.organizations.conflicts++;
    summary.warnings.push(
      `Local organization ${organization.id} has mismatched workos_external_id ${organization.workosExternalId}`,
    );
    return false;
  }
  if (!config.workos) {
    summary.organizations.skipped++;
    return true;
  }

  const workosOrganization = await config.workos.getOrganization(organization.workosOrgId!);
  if (!workosOrganization) {
    summary.organizations.conflicts++;
    summary.warnings.push(
      `Local organization ${organization.id} points at missing WorkOS organization ${organization.workosOrgId}`,
    );
    return false;
  }
  if (workosOrganization.externalId && workosOrganization.externalId !== organization.id) {
    summary.organizations.conflicts++;
    summary.warnings.push(
      `WorkOS organization ${workosOrganization.id} external_id does not match ${organization.id}`,
    );
    return false;
  }
  if (!workosOrganization.externalId) {
    if (config.mode === "apply") {
      await config.workos.updateOrganizationExternalId(workosOrganization.id, organization.id);
    }
    summary.organizations.linkedExisting++;
    return true;
  }
  summary.organizations.skipped++;
  return true;
}

async function verifyExistingMembershipLink(
  config: WorkosBackfillConfig,
  membership: WorkosBackfillMembership,
  userId: string,
  organizationId: string,
  roleSlugs: string[],
  summary: WorkosBackfillSummary,
): Promise<void> {
  const workos = config.workos!;
  const workosMembership = await workos.getOrganizationMembership(membership.workosMembershipId!);
  if (!workosMembership) {
    summary.memberships.conflicts++;
    summary.parity.staleLocalMembershipLinks++;
    summary.warnings.push(
      `Local membership ${membership.id} points at missing WorkOS membership ${membership.workosMembershipId}`,
    );
    return;
  }
  if (workosMembership.userId !== userId || workosMembership.organizationId !== organizationId) {
    summary.memberships.conflicts++;
    summary.parity.staleLocalMembershipLinks++;
    summary.warnings.push(
      `Local membership ${membership.id} points at WorkOS membership ${workosMembership.id} for a different user/org`,
    );
    return;
  }
  if (workosMembership.status !== "active" && workosMembership.status !== "inactive") {
    summary.memberships.conflicts++;
    summary.parity.staleLocalMembershipLinks++;
    summary.warnings.push(
      `Local membership ${membership.id} points at WorkOS membership ${workosMembership.id} with unsupported status ${workosMembership.status}`,
    );
    return;
  }

  const repairedMembership =
    workosMembership.status === "inactive" && config.mode === "apply"
      ? await workos.createOrganizationMembership({ userId, organizationId, roleSlugs })
      : await ensureMembershipRoles(config, workosMembership, roleSlugs, summary);

  summary.memberships.linkedExisting++;
  if (config.mode === "apply") {
    await config.repository.linkMembership({
      membershipId: membership.id,
      workosMembershipId: repairedMembership.id,
      roleSlugs: repairedMembership.roleSlugs.length > 0 ? repairedMembership.roleSlugs : roleSlugs,
    });
  }
}

async function ensureMembershipRoles(
  config: WorkosBackfillConfig,
  membership: { id: string; roleSlugs: string[]; status?: string },
  roleSlugs: string[],
  summary: WorkosBackfillSummary,
): Promise<{ id: string; roleSlugs: string[]; status?: string }> {
  const currentRoleSlugs = membership.roleSlugs;
  if (sameStringSet(currentRoleSlugs, roleSlugs)) {
    return membership;
  }

  if (config.mode === "dry-run") {
    summary.parity.membershipRoleMismatches++;
    summary.warnings.push(`WorkOS membership ${membership.id} role slugs differ from local roles`);
    return membership;
  }
  return config.workos!.updateOrganizationMembershipRoles(membership.id, roleSlugs);
}
