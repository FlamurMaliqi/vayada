import pg from "pg";

import { normalizePgConnectionString } from "./pgConnection.js";

export const PLATFORM_ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001";
export const PLATFORM_RESOURCE_ID = "vayada";
export const PLATFORM_RESOURCE_RELATIONSHIP = "operator";
export const PLATFORM_WORKOS_ROLE_SLUG = "admin";
export const PLATFORM_BOOTSTRAP_CONFIRM = "platform-identity-bootstrap:v1";

export type PlatformIdentityBootstrapMode = "dry-run" | "apply";

export type LegacyUserStatus = "active" | "pending" | "suspended" | "deleted";

export type PlatformIdentityBootstrapSummary = {
  kind: "platform_identity_bootstrap";
  mode: PlatformIdentityBootstrapMode;
  legacyPlatformUsersTotal: number;
  activeLegacyPlatformUsersTotal: number;
  requestedTargetPlatformUsersTotal: number;
  targetPlatformMembershipsTotal: number;
  applyConfirm: string;
  platformOrganizationId: string;
  platformResourceId: string;
};

export type PlatformIdentityBootstrapUser = {
  id: string;
  email: string;
  name: string | null;
  targetStatus: LegacyUserStatus;
  createdAt: Date;
  updatedAt: Date;
};

export async function runPlatformIdentityBootstrap(config: {
  mode: PlatformIdentityBootstrapMode;
  targetConnectionString: string;
  legacyAuthConnectionString?: string;
  adminEmails?: string[];
  max?: number;
}): Promise<PlatformIdentityBootstrapSummary> {
  const targetPool = new pg.Pool({
    connectionString: normalizePgConnectionString(config.targetConnectionString),
    max: config.max,
  });
  const legacyAuthConnectionString = resolveLegacyAuthConnectionString(
    config.legacyAuthConnectionString,
    config.adminEmails,
  );
  const legacyPool = legacyAuthConnectionString
    ? new pg.Pool({
        connectionString: normalizePgConnectionString(legacyAuthConnectionString),
        max: config.max,
      })
    : null;

  try {
    const legacyUsers = legacyPool ? await loadLegacyPlatformUsers(legacyPool) : [];
    const requestedTargetUsers = await loadRequestedTargetPlatformUsers(
      targetPool,
      config.adminEmails ?? [],
    );
    const requestedEmails = new Set(requestedTargetUsers.map((user) => normalizeEmail(user.email)));
    const platformUsers = [
      ...legacyUsers.filter((user) => !requestedEmails.has(normalizeEmail(user.email))),
      ...requestedTargetUsers,
    ];
    if (!platformUsers.some((user) => user.targetStatus === "active")) {
      throw new Error("No active platform users found to bootstrap.");
    }

    if (config.mode === "apply") {
      await applyPlatformIdentityBootstrap(targetPool, platformUsers);
    }

    return {
      kind: "platform_identity_bootstrap",
      mode: config.mode,
      legacyPlatformUsersTotal: legacyUsers.length,
      activeLegacyPlatformUsersTotal: legacyUsers.filter((user) => user.targetStatus === "active")
        .length,
      requestedTargetPlatformUsersTotal: requestedTargetUsers.length,
      targetPlatformMembershipsTotal: await countPlatformMemberships(targetPool),
      applyConfirm: platformIdentityBootstrapConfirm(config.adminEmails),
      platformOrganizationId: PLATFORM_ORGANIZATION_ID,
      platformResourceId: PLATFORM_RESOURCE_ID,
    };
  } finally {
    await Promise.all([targetPool.end(), legacyPool?.end()]);
  }
}

export function mapLegacyUserStatus(status: string): LegacyUserStatus {
  switch (status) {
    case "verified":
    case "active":
      return "active";
    case "pending":
      return "pending";
    case "suspended":
      return "suspended";
    case "rejected":
    case "deleted":
      return "deleted";
    default:
      return "pending";
  }
}

export function platformIdentityBootstrapConfirm(adminEmails: string[] = []): string {
  const normalizedEmails = normalizeEmails(adminEmails);
  return normalizedEmails.length === 0
    ? PLATFORM_BOOTSTRAP_CONFIRM
    : `${PLATFORM_BOOTSTRAP_CONFIRM}:admin-email:${normalizedEmails.join(",")}`;
}

export function resolveLegacyAuthConnectionString(
  legacyAuthConnectionString: string | undefined,
  adminEmails: string[] = [],
): string | undefined {
  return normalizeEmails(adminEmails).length > 0 ? undefined : legacyAuthConnectionString;
}

export function selectRequestedPlatformUsersByEmail(
  users: PlatformIdentityBootstrapUser[],
  adminEmails: string[],
): PlatformIdentityBootstrapUser[] {
  return normalizeEmails(adminEmails).map((email) => {
    const activeUsers = users.filter(
      (user) => normalizeEmail(user.email) === email && user.targetStatus === "active",
    );
    if (activeUsers.length === 0) {
      throw new Error(`No active target identity user found for admin email ${email}.`);
    }
    if (activeUsers.length > 1) {
      throw new Error(`Multiple active target identity users found for admin email ${email}.`);
    }
    return activeUsers[0];
  });
}

async function loadLegacyPlatformUsers(pool: pg.Pool): Promise<PlatformIdentityBootstrapUser[]> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    name: string | null;
    status: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id::text, email, name, status, created_at, updated_at
     FROM public.users
     WHERE is_superadmin = true OR type = 'admin'
     ORDER BY email`,
  );

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    targetStatus: mapLegacyUserStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function loadRequestedTargetPlatformUsers(
  pool: pg.Pool,
  adminEmails: string[],
): Promise<PlatformIdentityBootstrapUser[]> {
  const normalizedEmails = normalizeEmails(adminEmails);
  if (normalizedEmails.length === 0) return [];

  const { rows } = await pool.query<{
    id: string;
    email: string;
    name: string | null;
    status: LegacyUserStatus;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id::text, email, name, status, created_at, updated_at
     FROM identity.users
     WHERE lower(email) = ANY($1::text[])
     ORDER BY lower(email), id`,
    [normalizedEmails],
  );

  return selectRequestedPlatformUsersByEmail(
    rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      targetStatus: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    normalizedEmails,
  );
}

async function applyPlatformIdentityBootstrap(
  pool: pg.Pool,
  legacyUsers: PlatformIdentityBootstrapUser[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO identity.users (id, email, name, status, created_at, updated_at)
       SELECT id, email, name, status, created_at, updated_at
       FROM jsonb_to_recordset($1::jsonb) AS users(
         id uuid,
         email text,
         name text,
         status text,
         created_at timestamptz,
         updated_at timestamptz
       )
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(legacyUsers.map(toUserRecord))],
    );

    await client.query(
      `INSERT INTO identity.organizations
         (id, kind, name, slug, status, created_at, updated_at)
       VALUES ($1, 'platform', 'Vayada Platform', 'vayada-platform', 'active', now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         status = EXCLUDED.status,
         updated_at = now()`,
      [PLATFORM_ORGANIZATION_ID],
    );

    await client.query(
      `INSERT INTO identity.organization_memberships
         (organization_id, user_id, status, role_key, property_access_mode, access_origin, workos_role_slugs, created_at, updated_at)
       SELECT
         $1::uuid,
         id,
         status,
         'platform_admin',
         'assigned',
         'agency',
         ARRAY[$3::text],
         created_at,
         updated_at
       FROM jsonb_to_recordset($2::jsonb) AS users(
         id uuid,
         status text,
         created_at timestamptz,
         updated_at timestamptz
       )
       ON CONFLICT (organization_id, user_id) DO UPDATE SET
         status = EXCLUDED.status,
         role_key = EXCLUDED.role_key,
         property_access_mode = EXCLUDED.property_access_mode,
         workos_role_slugs = EXCLUDED.workos_role_slugs,
         updated_at = EXCLUDED.updated_at`,
      [
        PLATFORM_ORGANIZATION_ID,
        JSON.stringify(legacyUsers.map(toMembershipRecord)),
        PLATFORM_WORKOS_ROLE_SLUG,
      ],
    );

    await client.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1, 'platform', 'platform', $2, $3, 'active')
       ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
       DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [PLATFORM_ORGANIZATION_ID, PLATFORM_RESOURCE_ID, PLATFORM_RESOURCE_RELATIONSHIP],
    );

    await client.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status, resource_product, resource_type, resource_id)
       VALUES ($1, 'platform', 'platform-admin', 'active', 'platform', 'platform', $2)
       ON CONFLICT (
         organization_id,
         product,
         entitlement_key,
         COALESCE(resource_product, ''),
         COALESCE(resource_type, ''),
         COALESCE(resource_id, '')
       ) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [PLATFORM_ORGANIZATION_ID, PLATFORM_RESOURCE_ID],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function countPlatformMemberships(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count
     FROM identity.organization_memberships
     WHERE organization_id = $1 AND status = 'active'`,
    [PLATFORM_ORGANIZATION_ID],
  );
  return Number(rows[0].count);
}

function toUserRecord(user: PlatformIdentityBootstrapUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.targetStatus,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}

function toMembershipRecord(user: PlatformIdentityBootstrapUser) {
  return {
    id: user.id,
    status: user.targetStatus === "active" ? "active" : "inactive",
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeEmails(emails: string[]): string[] {
  return Array.from(new Set(emails.map(normalizeEmail).filter(Boolean))).sort();
}
