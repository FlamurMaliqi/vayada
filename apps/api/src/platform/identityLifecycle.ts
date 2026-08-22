import { randomUUID } from "node:crypto";
import type {
  CreateIdentityUserCommand,
  DeleteIdentityUserCommand,
  GrantIdentityAccessCommand,
  GrantIdentityResourceLinksCommand,
  IdentityLifecycleCommand,
  IdentityLifecycleCommandBus,
  IdentityLifecycleCommandResult,
  IdentityLifecycleEvent,
  RevokeIdentityAccessCommand,
  SuspendIdentityUserCommand,
  UpdateIdentityUserEmailCommand,
  UpdateIdentityUserProfileCommand,
  UpdateIdentityUserStatusCommand,
} from "@vayada/backend-auth";
import pg from "pg";

type PgIdentityLifecycleCommandBusConfig = {
  connectionString: string;
  max?: number;
};

export function createPgIdentityLifecycleCommandBus(
  config: PgIdentityLifecycleCommandBusConfig,
): IdentityLifecycleCommandBus {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });

  return {
    async execute(command) {
      switch (command.commandType) {
        case "identity.user.create":
          return createIdentityUser(pool, command);
        case "identity.user.profile.update":
          return updateIdentityUserProfile(pool, command);
        case "identity.user.email.update":
          return updateIdentityUserEmail(pool, command);
        case "identity.user.status.update":
          return updateIdentityUserStatus(pool, command);
        case "identity.user.suspend":
          return suspendIdentityUser(pool, command);
        case "identity.user.delete":
          return deleteIdentityUser(pool, command);
        case "identity.access.grant":
          return grantIdentityAccess(pool, command);
        case "identity.access.revoke":
          return revokeIdentityAccess(pool, command);
        case "identity.resource_links.grant":
          return grantIdentityResourceLinks(pool, command);
        default:
          throw new Error(`Unsupported identity lifecycle command: ${command.commandType}`);
      }
    },
  };
}

async function createIdentityUser(
  pool: pg.Pool,
  command: CreateIdentityUserCommand,
): Promise<IdentityLifecycleCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existingProviderUserId = command.payload.providerIdentity?.providerUserId;
    if (existingProviderUserId) {
      const existingIdentity = await client.query<{ user_id: string }>(
        `SELECT user_id
         FROM identity.external_identities
         WHERE provider = $1 AND provider_user_id = $2
         LIMIT 1`,
        [command.payload.providerIdentity?.provider ?? "workos", existingProviderUserId],
      );
      const existingUserId = existingIdentity.rows[0]?.user_id;
      if (existingUserId) {
        const organizationId =
          command.payload.organization && command.payload.membership
            ? await grantIdentityAccessWithClient(client, {
                userId: existingUserId,
                organization: command.payload.organization,
                membership: command.payload.membership,
                resourceLinks: command.payload.resourceLinks,
              })
            : undefined;
        await client.query("COMMIT");
        return {
          status: "idempotent_replay",
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          userId: existingUserId,
          organizationId,
          events: [],
        };
      }
    }

    const existingEmail = await client.query<{ id: string }>(
      `SELECT id
       FROM identity.users
       WHERE lower(email) = lower($1)
         AND status <> 'deleted'
       ORDER BY created_at ASC
       LIMIT 1`,
      [command.payload.email],
    );
    const existingEmailUserId = existingEmail.rows[0]?.id;
    if (existingEmailUserId) {
      if (command.payload.providerIdentity?.providerUserId) {
        await insertExternalIdentityWithClient(client, existingEmailUserId, command);
      }
      const organizationId =
        command.payload.organization && command.payload.membership
          ? await grantIdentityAccessWithClient(client, {
              userId: existingEmailUserId,
              organization: command.payload.organization,
              membership: command.payload.membership,
              resourceLinks: command.payload.resourceLinks,
            })
          : undefined;
      await client.query("COMMIT");
      return {
        status: "idempotent_replay",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        userId: existingEmailUserId,
        organizationId,
        events: [],
      };
    }

    const user = await client.query<{ id: string }>(
      `INSERT INTO identity.users (email, name, status)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [command.payload.email, command.payload.name ?? null, command.payload.initialStatus],
    );
    const userId = user.rows[0]?.id;
    if (!userId) {
      throw new Error("identity.user.create did not return a user id");
    }

    if (command.payload.providerIdentity?.providerUserId) {
      await insertExternalIdentityWithClient(client, userId, command);
    }

    const organizationId =
      command.payload.organization && command.payload.membership
        ? await grantIdentityAccessWithClient(client, {
            userId,
            organization: command.payload.organization,
            membership: command.payload.membership,
            resourceLinks: command.payload.resourceLinks,
          })
        : undefined;

    const event: IdentityLifecycleEvent = {
      eventType: "identity.user.created",
      eventId: randomUUID(),
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      userId,
      organizationId,
      occurredAt: new Date().toISOString(),
      audit: command.audit,
      payload: command.payload,
    };
    await client.query(
      `INSERT INTO identity.auth_reconciliation_events
         (event_type, provider, provider_event_id, user_id, payload, processed_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [
        event.eventType,
        command.payload.providerIdentity?.provider ?? "workos",
        command.payload.providerIdentity?.providerUserId ?? null,
        userId,
        JSON.stringify(event),
      ],
    );

    await client.query("COMMIT");
    return {
      status: "accepted",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      userId,
      organizationId,
      events: [event],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateIdentityUserProfile(
  pool: pg.Pool,
  command: UpdateIdentityUserProfileCommand,
): Promise<IdentityLifecycleCommandResult> {
  await pool.query(
    `UPDATE identity.users
     SET name = COALESCE($2, name),
         phone = CASE WHEN $3::boolean THEN $4::text ELSE phone END,
         profile_picture_url = CASE
           WHEN $5::boolean THEN $6::text ELSE profile_picture_url
         END,
         profile_picture_media_object_id = CASE
           WHEN $7::boolean THEN $8::text ELSE profile_picture_media_object_id
         END,
         updated_at = now()
     WHERE id = $1`,
    [
      command.payload.userId,
      command.payload.name ?? null,
      Object.hasOwn(command.payload, "phone"),
      command.payload.phone ?? null,
      Object.hasOwn(command.payload, "profilePictureUrl"),
      command.payload.profilePictureUrl ?? null,
      Object.hasOwn(command.payload, "profilePictureMediaObjectId"),
      command.payload.profilePictureMediaObjectId ?? null,
    ],
  );
  return accepted(command, command.payload.userId, "identity.user.profile.updated");
}

async function insertExternalIdentityWithClient(
  client: pg.PoolClient,
  userId: string,
  command: CreateIdentityUserCommand,
): Promise<void> {
  const providerUserId = command.payload.providerIdentity?.providerUserId;
  if (!providerUserId) return;

  const result = await client.query<{ user_id: string }>(
    `INSERT INTO identity.external_identities
       (user_id, provider, provider_user_id, provider_email, provider_email_verified, last_login_at, raw_profile)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (provider, provider_user_id)
     WHERE provider_user_id IS NOT NULL
     DO UPDATE SET
       provider_email = EXCLUDED.provider_email,
       provider_email_verified = EXCLUDED.provider_email_verified,
       last_login_at = now(),
       updated_at = now()
     WHERE identity.external_identities.user_id = EXCLUDED.user_id
     RETURNING user_id`,
    [
      userId,
      command.payload.providerIdentity?.provider ?? "workos",
      providerUserId,
      command.payload.email,
      command.payload.providerIdentity?.providerEmailVerified ?? false,
      JSON.stringify({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        source: "authkit_jit",
      }),
    ],
  );
  if (result.rowCount === 0) {
    throw new Error("WorkOS provider identity is already linked to another user");
  }
}

async function updateIdentityUserEmail(
  pool: pg.Pool,
  command: UpdateIdentityUserEmailCommand,
): Promise<IdentityLifecycleCommandResult> {
  await pool.query(
    `UPDATE identity.users
     SET email = $2, updated_at = now()
     WHERE id = $1`,
    [command.payload.userId, command.payload.email],
  );
  await pool.query(
    `UPDATE identity.external_identities
     SET provider_email = $2,
         provider_email_verified = COALESCE($3, provider_email_verified),
         updated_at = now()
     WHERE user_id = $1`,
    [command.payload.userId, command.payload.email, command.payload.providerEmailVerified ?? null],
  );
  return accepted(command, command.payload.userId, "identity.user.email.updated");
}

async function updateIdentityUserStatus(
  pool: pg.Pool,
  command: UpdateIdentityUserStatusCommand,
): Promise<IdentityLifecycleCommandResult> {
  await pool.query(
    `UPDATE identity.users
     SET status = $2, updated_at = now()
     WHERE id = $1`,
    [command.payload.userId, command.payload.status],
  );
  return accepted(command, command.payload.userId, "identity.user.status.updated");
}

async function suspendIdentityUser(
  pool: pg.Pool,
  command: SuspendIdentityUserCommand,
): Promise<IdentityLifecycleCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE identity.users
       SET status = 'suspended', updated_at = now()
       WHERE id = $1`,
      [command.payload.userId],
    );
    if (command.payload.suspendMemberships) {
      await client.query(
        `UPDATE identity.organization_memberships
         SET status = 'suspended', updated_at = now()
         WHERE user_id = $1`,
        [command.payload.userId],
      );
    }
    if (command.payload.suspendResourceLinks) {
      await client.query(
        `UPDATE identity.organization_resource_links AS links
         SET status = 'suspended', updated_at = now()
         FROM identity.organization_memberships AS memberships
         WHERE memberships.organization_id = links.organization_id
           AND memberships.user_id = $1`,
        [command.payload.userId],
      );
    }
    await client.query("COMMIT");
    return accepted(command, command.payload.userId, "identity.user.suspended");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteIdentityUser(
  pool: pg.Pool,
  command: DeleteIdentityUserCommand,
): Promise<IdentityLifecycleCommandResult> {
  const email =
    command.payload.mode === "privacy_erasure"
      ? `deleted+${command.payload.userId}@deleted.vayada.local`
      : undefined;
  await pool.query(
    `UPDATE identity.users
     SET status = 'deleted',
         email = COALESCE($2, email),
         name = CASE WHEN $2 IS NULL THEN name ELSE NULL END,
         updated_at = now()
     WHERE id = $1`,
    [command.payload.userId, email ?? null],
  );
  return accepted(command, command.payload.userId, "identity.user.deleted");
}

async function grantIdentityAccess(
  pool: pg.Pool,
  command: GrantIdentityAccessCommand,
): Promise<IdentityLifecycleCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const organizationId = await grantIdentityAccessWithClient(client, command.payload);
    for (const grant of command.payload.permissionGrants ?? []) {
      await client.query(
        `INSERT INTO identity.role_permission_grants
           (organization_kind, role_key, permission_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING`,
        [grant.organizationKind, grant.roleKey, grant.permissionKey],
      );
    }
    await client.query("COMMIT");
    return accepted(command, command.payload.userId, "identity.access.granted", organizationId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function grantIdentityAccessWithClient(
  client: pg.PoolClient,
  payload: GrantIdentityAccessCommand["payload"],
): Promise<string> {
  const organizationId = await upsertOrganization(client, payload.organization);
  if (payload.organization.websiteUrl !== undefined) {
    await client.query(
      `UPDATE identity.organizations
       SET website_url = $2, updated_at = now()
       WHERE id = $1`,
      [organizationId, payload.organization.websiteUrl],
    );
  }
  await client.query(
    `INSERT INTO identity.organization_memberships
       (organization_id, user_id, status, role_key, property_access_mode, workos_membership_id, workos_role_slugs, invited_at)
     VALUES ($1, $2, COALESCE($3, 'active'), $4, $5, $6, COALESCE($7::text[], '{}'::text[]), $8)
     ON CONFLICT (organization_id, user_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       role_key = EXCLUDED.role_key,
       property_access_mode = EXCLUDED.property_access_mode,
       workos_membership_id = COALESCE(EXCLUDED.workos_membership_id, identity.organization_memberships.workos_membership_id),
       workos_role_slugs = EXCLUDED.workos_role_slugs,
       updated_at = now()`,
    [
      organizationId,
      payload.userId,
      payload.membership.status ?? "active",
      payload.membership.roleKey,
      payload.membership.propertyAccessMode,
      payload.membership.workosMembershipId ?? null,
      payload.membership.workosRoleSlugs ?? [],
      payload.membership.invitedAt ?? null,
    ],
  );
  await insertMembershipPermissionGrantsWithClient(client, payload);
  for (const link of payload.resourceLinks ?? []) {
    await client.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'active'))
       ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
       DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [
        link.organizationId ?? organizationId,
        link.product,
        link.resourceType,
        link.resourceId,
        link.relationship,
        link.status ?? "active",
      ],
    );
  }
  return organizationId;
}

async function insertMembershipPermissionGrantsWithClient(
  client: pg.PoolClient,
  payload: Pick<GrantIdentityAccessCommand["payload"], "organization" | "membership">,
): Promise<void> {
  for (const grant of membershipPermissionGrantRows(payload)) {
    await client.query(
      `INSERT INTO identity.role_permission_grants
         (organization_kind, role_key, permission_key)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_kind, role_key, permission_key) DO NOTHING`,
      [grant.organizationKind, grant.roleKey, grant.permissionKey],
    );
  }
}

export function membershipPermissionGrantRows(
  payload: Pick<GrantIdentityAccessCommand["payload"], "organization" | "membership">,
) {
  return (payload.membership.permissionKeys ?? []).map((permissionKey) => ({
    organizationKind: payload.organization.kind,
    roleKey: payload.membership.roleKey,
    permissionKey,
  }));
}

async function revokeIdentityAccess(
  pool: pg.Pool,
  command: RevokeIdentityAccessCommand,
): Promise<IdentityLifecycleCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (command.payload.membershipStatus) {
      await client.query(
        `UPDATE identity.organization_memberships
         SET status = $3, updated_at = now()
         WHERE organization_id = $1 AND user_id = $2`,
        [command.payload.organizationId, command.payload.userId, command.payload.membershipStatus],
      );
    }
    for (const link of command.payload.resourceLinks ?? []) {
      await client.query(
        `UPDATE identity.organization_resource_links
         SET status = $6, updated_at = now()
         WHERE organization_id = $1
           AND product = $2
           AND resource_type = $3
           AND resource_id = $4
           AND relationship = $5`,
        [
          command.payload.organizationId,
          link.product,
          link.resourceType,
          link.resourceId,
          link.relationship,
          link.status ?? "suspended",
        ],
      );
    }
    await client.query("COMMIT");
    return accepted(
      command,
      command.payload.userId,
      "identity.access.revoked",
      command.payload.organizationId,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function grantIdentityResourceLinks(
  pool: pg.Pool,
  command: GrantIdentityResourceLinksCommand,
): Promise<IdentityLifecycleCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const organization = await client.query<{ id: string }>(
      `SELECT id::text AS id
       FROM identity.organizations
       WHERE id = $1::uuid AND status = 'active'
       FOR SHARE`,
      [command.payload.organizationId],
    );
    if (!organization.rows[0]) {
      throw new Error("Cannot grant a resource link to an inactive organization");
    }

    for (const link of command.payload.resourceLinks) {
      const inserted = await client.query<{ status: string }>(
        `INSERT INTO identity.organization_resource_links
           (organization_id, product, resource_type, resource_id, relationship, status)
         VALUES ($1::uuid, $2, $3, $4, $5, 'active')
         ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
         DO NOTHING
         RETURNING status`,
        [
          command.payload.organizationId,
          link.product,
          link.resourceType,
          link.resourceId,
          link.relationship,
        ],
      );
      if (inserted.rows[0]) continue;

      const existing = await client.query<{ status: string }>(
        `SELECT status
         FROM identity.organization_resource_links
         WHERE organization_id = $1::uuid
           AND product = $2
           AND resource_type = $3
           AND resource_id = $4
           AND relationship = $5`,
        [
          command.payload.organizationId,
          link.product,
          link.resourceType,
          link.resourceId,
          link.relationship,
        ],
      );
      if (existing.rows[0]?.status !== "active") {
        throw new Error("An existing resource-link suspension cannot be overwritten");
      }
    }

    await client.query("COMMIT");
    return accepted(
      command,
      undefined,
      "identity.resource_links.granted",
      command.payload.organizationId,
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertOrganization(
  client: pg.PoolClient,
  organization: GrantIdentityAccessCommand["payload"]["organization"],
): Promise<string> {
  const slug = organization.slug ?? slugify(organization.name);
  if (!organization.organizationId && (organization.workosOrgId || organization.workosExternalId)) {
    const existing = await client.query<{ id: string }>(
      `SELECT id
       FROM identity.organizations
       WHERE ($1::text IS NOT NULL AND workos_org_id = $1)
          OR ($2::text IS NOT NULL AND workos_external_id = $2)
       ORDER BY CASE WHEN workos_org_id = $1 THEN 0 ELSE 1 END
       LIMIT 1`,
      [organization.workosOrgId ?? null, organization.workosExternalId ?? null],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId) {
      const result = await client.query<{ id: string }>(
        `UPDATE identity.organizations
         SET kind = $2,
             name = $3,
             slug = $4,
             status = COALESCE($5, 'active'),
             workos_org_id = COALESCE(identity.organizations.workos_org_id, $6),
             workos_external_id = COALESCE(identity.organizations.workos_external_id, $7),
             updated_at = now()
         WHERE id = $1
           AND ($6::text IS NULL OR workos_org_id IS NULL OR workos_org_id = $6)
           AND ($7::text IS NULL OR workos_external_id IS NULL OR workos_external_id = $7)
         RETURNING id`,
        [
          existingId,
          organization.kind,
          organization.name,
          slug,
          organization.status ?? "active",
          organization.workosOrgId ?? null,
          organization.workosExternalId ?? null,
        ],
      );
      const updatedId = result.rows[0]?.id;
      if (!updatedId) {
        throw new Error(
          "WorkOS organization identifiers are already linked to another organization",
        );
      }
      return updatedId;
    }
  }
  if (organization.organizationId) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO identity.organizations
         (id, kind, name, slug, status, workos_org_id, workos_external_id)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'active'), $6, $7)
       ON CONFLICT (id)
       DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         status = EXCLUDED.status,
         workos_org_id = COALESCE(EXCLUDED.workos_org_id, identity.organizations.workos_org_id),
         workos_external_id = COALESCE(EXCLUDED.workos_external_id, identity.organizations.workos_external_id),
         updated_at = now()
       RETURNING id`,
      [
        organization.organizationId,
        organization.kind,
        organization.name,
        slug,
        organization.status ?? "active",
        organization.workosOrgId ?? null,
        organization.workosExternalId ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  if (organization.workosOrgId) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO identity.organizations
         (kind, name, slug, status, workos_org_id, workos_external_id)
       VALUES ($1, $2, $3, COALESCE($4, 'active'), $5, $6)
       ON CONFLICT (workos_org_id)
       DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         status = EXCLUDED.status,
         workos_external_id = COALESCE(EXCLUDED.workos_external_id, identity.organizations.workos_external_id),
         updated_at = now()
       RETURNING id`,
      [
        organization.kind,
        organization.name,
        slug,
        organization.status ?? "active",
        organization.workosOrgId,
        organization.workosExternalId ?? null,
      ],
    );
    return result.rows[0]!.id;
  }

  if (organization.workosExternalId) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO identity.organizations
         (kind, name, slug, status, workos_external_id)
       VALUES ($1, $2, $3, COALESCE($4, 'active'), $5)
       ON CONFLICT (workos_external_id)
       DO UPDATE SET
         kind = EXCLUDED.kind,
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         status = EXCLUDED.status,
         updated_at = now()
       RETURNING id`,
      [
        organization.kind,
        organization.name,
        slug,
        organization.status ?? "active",
        organization.workosExternalId,
      ],
    );
    return result.rows[0]!.id;
  }

  const result = await client.query<{ id: string }>(
    `INSERT INTO identity.organizations
       (kind, name, slug, status, workos_org_id, workos_external_id)
     VALUES ($1, $2, $3, COALESCE($4, 'active'), $5, $6)
     RETURNING id`,
    [
      organization.kind,
      organization.name,
      slug,
      organization.status ?? "active",
      organization.workosOrgId ?? null,
      organization.workosExternalId ?? null,
    ],
  );
  return result.rows[0]!.id;
}

function accepted(
  command: IdentityLifecycleCommand,
  userId: string | undefined,
  eventType: IdentityLifecycleEvent["eventType"],
  organizationId?: string,
): IdentityLifecycleCommandResult {
  const event: IdentityLifecycleEvent = {
    eventType,
    eventId: randomUUID(),
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    userId,
    organizationId,
    occurredAt: new Date().toISOString(),
    audit: command.audit,
    payload: command.payload,
  } as IdentityLifecycleEvent;

  return {
    status: "accepted",
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    userId,
    organizationId,
    events: [event],
  };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "organization";
}
