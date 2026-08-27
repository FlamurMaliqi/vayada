import { randomUUID } from "node:crypto";
import type {
  IdentityCommandAudit,
  IdentityLifecycleCommand,
  IdentityLifecycleCommandBus,
  InternalUserStatus,
} from "@vayada/backend-auth";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import { enforceRoutePolicy } from "./policy.js";

export const IDENTITY_ADMIN_USER_CREATE_CONTRACT = {
  method: "POST",
  path: "/api/identity/admin/users",
  owner: "identity",
  permission: "platform.user.suspend",
  resource: {
    product: "platform",
    resourceType: "platform",
    resourceId: "vayada",
    allowedRelationships: ["operator"],
  },
  commandType: "identity.user.create",
} as const;

export const IDENTITY_ADMIN_USER_LIST_CONTRACT = {
  method: "GET",
  path: "/api/identity/admin/users",
  owner: "identity",
  permission: "platform.user.suspend",
  resource: IDENTITY_ADMIN_USER_CREATE_CONTRACT.resource,
} as const;

export const IDENTITY_ADMIN_USER_DETAIL_CONTRACT = {
  method: "GET",
  path: "/api/identity/admin/users/:userId",
  owner: "identity",
  permission: "platform.user.suspend",
  resource: IDENTITY_ADMIN_USER_CREATE_CONTRACT.resource,
} as const;

export const IDENTITY_ADMIN_USER_UPDATE_CONTRACT = {
  method: "PATCH",
  path: "/api/identity/admin/users/:userId",
  owner: "identity",
  permission: "platform.user.suspend",
  resource: IDENTITY_ADMIN_USER_CREATE_CONTRACT.resource,
  commandTypes: [
    "identity.user.profile.update",
    "identity.user.email.update",
    "identity.user.status.update",
    "identity.user.suspend",
  ],
} as const;

export const IDENTITY_ADMIN_USER_DELETE_CONTRACT = {
  method: "DELETE",
  path: "/api/identity/admin/users/:userId",
  owner: "identity",
  permission: "platform.user.suspend",
  resource: IDENTITY_ADMIN_USER_CREATE_CONTRACT.resource,
  commandType: "identity.user.delete",
} as const;

export const IDENTITY_ADMIN_PLATFORM_ACCESS_CONTRACT = {
  method: "PUT",
  path: "/api/identity/admin/users/:userId/platform-access",
  owner: "identity",
  permission: "platform.user.suspend",
  resource: IDENTITY_ADMIN_USER_CREATE_CONTRACT.resource,
  commandTypes: ["identity.access.grant", "identity.access.revoke"],
} as const;

export type IdentityAdminUserType = "creator" | "hotel" | "admin";
export type LegacyAdminUserStatus = "pending" | "verified" | "rejected" | "suspended";

export type IdentityAdminCreateUserRequest = {
  email: string;
  name?: string;
  type: IdentityAdminUserType;
  status?: LegacyAdminUserStatus;
  emailVerified?: boolean;
};

export type IdentityAdminListUsersQuery = {
  type?: IdentityAdminUserType;
  status?: LegacyAdminUserStatus;
  search?: string;
  page?: string;
  page_size?: string;
};

export type IdentityAdminUpdateUserRequest = {
  email?: string;
  name?: string;
  status?: LegacyAdminUserStatus;
  emailVerified?: boolean;
};

export type IdentityAdminPlatformAccessRequest = {
  enabled: boolean;
  platformOrganizationId?: string;
  platformOrganizationName?: string;
};

export type IdentityAdminCommandResponse = {
  userId: string;
  status: "accepted" | "idempotent_replay";
  commands: {
    commandType: IdentityLifecycleCommand["commandType"];
    commandId: string;
    idempotencyKey: string;
    status: "accepted" | "idempotent_replay";
  }[];
};

export type IdentityAdminUser = {
  id: string;
  email: string;
  name: string;
  type: IdentityAdminUserType;
  status: LegacyAdminUserStatus;
  avatar: null;
  email_verified: boolean;
  created_at: string;
  updated_at: string;
};

export type IdentityAdminUsersListResponse = {
  users: IdentityAdminUser[];
  total: number;
};

export type IdentityAdminUserDetailResponse = Omit<IdentityAdminUser, "email_verified"> & {
  emailVerified: boolean;
  profile: null;
};

export type IdentityAdminUsersReadRepository = {
  listUsers(input: {
    type?: IdentityAdminUserType;
    status?: LegacyAdminUserStatus;
    search?: string;
    limit: number;
    offset: number;
  }): Promise<IdentityAdminUsersListResponse>;
  findUserById(userId: string): Promise<IdentityAdminUserDetailResponse | null>;
  close?(): Promise<void>;
};

export type IdentityAdminUserRoutesOptions = {
  lifecycleCommandBus: IdentityLifecycleCommandBus;
  readRepository?: IdentityAdminUsersReadRepository;
  platformOrganizationId?: string;
  platformOrganizationName?: string;
};

export type IdentityAdminUsersPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
  end(): Promise<void>;
};

export function createPgIdentityAdminUsersReadRepository(config: {
  connectionString: string;
  max?: number;
  pool?: IdentityAdminUsersPool;
}): IdentityAdminUsersReadRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Identity admin users read repository connectionString must not be empty");
  }

  const pool =
    config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    });

  return {
    async listUsers(input) {
      const params: unknown[] = [];
      const filters = buildAdminUsersFilters(input, params);
      const filterParams = [...params];
      const queryParams = [...filterParams, input.limit, input.offset];
      const limitParam = queryParams.length - 1;
      const offsetParam = queryParams.length;

      const [users, count] = await Promise.all([
        pool.query<IdentityAdminUserRow>(
          `${ADMIN_USERS_SELECT_SQL}
           ${filters.sql}
           ORDER BY created_at DESC, id ASC
           LIMIT $${limitParam} OFFSET $${offsetParam}`,
          queryParams,
        ),
        pool.query<{ total: string }>(
          `SELECT count(*)::text AS total
           FROM (${ADMIN_USERS_SELECT_SQL} ${filters.sql}) AS filtered_users`,
          filterParams,
        ),
      ]);
      return {
        users: users.rows.map(serializeAdminUser),
        total: Number(count.rows[0]?.total ?? 0),
      };
    },
    async findUserById(userId) {
      const result = await pool.query<IdentityAdminUserRow>(
        `${ADMIN_USERS_SELECT_SQL}
         WHERE id = $1
         LIMIT 1`,
        [userId],
      );
      const user = result.rows[0] ? serializeAdminUser(result.rows[0]) : null;
      if (!user) return null;
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        type: user.type,
        status: user.status,
        avatar: null,
        emailVerified: user.email_verified,
        created_at: user.created_at,
        updated_at: user.updated_at,
        profile: null,
      };
    },
    async close() {
      await pool.end();
    },
  };
}

type UserParams = {
  userId: string;
};

export async function registerIdentityAdminUserRoutes(
  app: FastifyInstance,
  options: IdentityAdminUserRoutesOptions,
): Promise<void> {
  app.addHook("onClose", async () => {
    await options.readRepository?.close?.();
  });

  app.get<{ Querystring: IdentityAdminListUsersQuery }>("/users", async (request, reply) => {
    requirePlatformAdminUserAccess(request);
    if (!options.readRepository) {
      return sendAdminUserError(reply, 503, "Identity admin user reads are not configured.");
    }
    const page = parsePositiveInteger(request.query.page, 1);
    const pageSize = Math.min(parsePositiveInteger(request.query.page_size, 20), 100);
    return options.readRepository.listUsers({
      type: request.query.type,
      status: request.query.status,
      search: request.query.search,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
  });

  app.get<{ Params: UserParams }>("/users/:userId", async (request, reply) => {
    requirePlatformAdminUserAccess(request);
    if (!options.readRepository) {
      return sendAdminUserError(reply, 503, "Identity admin user reads are not configured.");
    }
    const user = await options.readRepository.findUserById(request.params.userId);
    if (!user) {
      return sendAdminUserError(reply, 404, "User was not found.");
    }
    return user;
  });

  app.post<{ Body: IdentityAdminCreateUserRequest }>("/users", async (request, reply) => {
    const audit = adminAudit(request, "Create identity user through Vayada admin");
    const body = request.body;
    if (!body?.email || !body.type) {
      return sendAdminUserError(reply, 422, "email and type are required.");
    }

    const command: IdentityLifecycleCommand = {
      commandType: "identity.user.create",
      commandId: randomUUID(),
      idempotencyKey: `admin:user:create:${body.email.toLowerCase()}`,
      audit,
      payload: {
        email: body.email,
        name: body.name,
        legacyUserType: body.type,
        initialStatus: toIdentityStatus(body.status),
        providerIdentity: {
          provider: "workos",
          providerEmailVerified: body.emailVerified ?? false,
        },
      },
    };
    const result = await options.lifecycleCommandBus.execute(command);
    return reply.status(201).send(commandResponse(result.userId ?? "", [command], [result]));
  });

  app.patch<{ Params: UserParams; Body: IdentityAdminUpdateUserRequest }>(
    "/users/:userId",
    async (request, reply) => {
      const userId = request.params.userId;
      const audit = adminAudit(request, `Update identity user ${userId} through Vayada admin`);
      const commands: IdentityLifecycleCommand[] = [];
      if (request.body?.name !== undefined) {
        commands.push({
          commandType: "identity.user.profile.update",
          commandId: randomUUID(),
          idempotencyKey: `admin:user:${userId}:profile:${request.body.name}`,
          audit,
          payload: { userId, name: request.body.name },
        });
      }
      if (request.body?.email !== undefined) {
        commands.push({
          commandType: "identity.user.email.update",
          commandId: randomUUID(),
          idempotencyKey: `admin:user:${userId}:email:${request.body.email.toLowerCase()}`,
          audit,
          payload: {
            userId,
            email: request.body.email,
            providerEmailVerified: request.body.emailVerified,
          },
        });
      }
      if (request.body?.status !== undefined) {
        const status = toIdentityStatus(request.body.status);
        commands.push(
          status === "suspended"
            ? {
                commandType: "identity.user.suspend",
                commandId: randomUUID(),
                idempotencyKey: `admin:user:${userId}:suspend`,
                audit,
                payload: {
                  userId,
                  reason: "Vayada admin user status update",
                  suspendMemberships: true,
                  suspendResourceLinks: true,
                },
              }
            : {
                commandType: "identity.user.status.update",
                commandId: randomUUID(),
                idempotencyKey: `admin:user:${userId}:status:${status}`,
                audit,
                payload: { userId, status },
              },
        );
      }
      if (commands.length === 0) {
        return sendAdminUserError(reply, 422, "At least one identity-owned field is required.");
      }
      const results = [];
      for (const command of commands) {
        results.push(await options.lifecycleCommandBus.execute(command));
      }
      return commandResponse(userId, commands, results);
    },
  );

  app.put<{ Params: UserParams; Body: IdentityAdminPlatformAccessRequest }>(
    "/users/:userId/platform-access",
    async (request) => {
      const userId = request.params.userId;
      const platformOrganizationId =
        request.body?.platformOrganizationId ??
        options.platformOrganizationId ??
        "00000000-0000-0000-0000-000000000001";
      const platformOrganizationName =
        request.body?.platformOrganizationName ??
        options.platformOrganizationName ??
        "Vayada Platform";
      const audit = adminAudit(
        request,
        `${request.body?.enabled ? "Grant" : "Revoke"} platform access for ${userId}`,
      );
      const command: IdentityLifecycleCommand = request.body?.enabled
        ? {
            commandType: "identity.access.grant",
            commandId: randomUUID(),
            idempotencyKey: `platform:${userId}:superadmin:true`,
            audit,
            payload: {
              userId,
              organization: {
                organizationId: platformOrganizationId,
                kind: "platform",
                name: platformOrganizationName,
                slug: "vayada-platform",
              },
              membership: {
                roleKey: "platform_admin",
                status: "active",
                propertyAccessMode: "assigned",
                permissionKeys: ["platform.user.suspend"],
              },
              resourceLinks: [
                {
                  organizationId: platformOrganizationId,
                  product: "platform",
                  resourceType: "platform",
                  resourceId: "vayada",
                  relationship: "operator",
                  status: "active",
                },
              ],
              permissionGrants: [
                {
                  organizationKind: "platform",
                  roleKey: "platform_admin",
                  permissionKey: "platform.user.suspend",
                },
              ],
            },
          }
        : {
            commandType: "identity.access.revoke",
            commandId: randomUUID(),
            idempotencyKey: `platform:${userId}:superadmin:false`,
            audit,
            payload: {
              userId,
              organizationId: platformOrganizationId,
              membershipStatus: "inactive",
              resourceLinks: [
                {
                  product: "platform",
                  resourceType: "platform",
                  resourceId: "vayada",
                  relationship: "operator",
                },
              ],
            },
          };
      const result = await options.lifecycleCommandBus.execute(command);
      return commandResponse(userId, [command], [result]);
    },
  );

  app.delete<{ Params: UserParams }>("/users/:userId", async (request) => {
    const userId = request.params.userId;
    const audit = adminAudit(request, `Delete identity user ${userId} through Vayada admin`);
    const command: IdentityLifecycleCommand = {
      commandType: "identity.user.delete",
      commandId: randomUUID(),
      idempotencyKey: `admin:user:${userId}:delete:soft`,
      audit,
      payload: {
        userId,
        mode: "soft_delete",
      },
    };
    const result = await options.lifecycleCommandBus.execute(command);
    return commandResponse(userId, [command], [result]);
  });
}

export function requirePlatformAdminUserAccess(
  request: FastifyRequest,
): ReturnType<typeof enforceRoutePolicy> {
  return enforceRoutePolicy(request, {
    permission: "platform.user.suspend",
    resource: IDENTITY_ADMIN_USER_CREATE_CONTRACT.resource,
  });
}

function adminAudit(request: FastifyRequest, reason: string): IdentityCommandAudit {
  const context = requirePlatformAdminUserAccess(request);
  return {
    actor: {
      kind: "user",
      userId: context.actor.internalUserId,
      organizationId: context.selectedOrganization.organizationId,
    },
    source: "admin",
    requestId: context.audit.requestId,
    correlationId: context.audit.correlationId,
    reason,
    requestedAt: new Date().toISOString(),
  };
}

function commandResponse(
  userId: string,
  commands: IdentityLifecycleCommand[],
  results: { status: "accepted" | "idempotent_replay" }[],
): IdentityAdminCommandResponse {
  return {
    userId,
    status: results.some((result) => result.status === "accepted")
      ? "accepted"
      : "idempotent_replay",
    commands: commands.map((command, index) => ({
      commandType: command.commandType,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      status: results[index]?.status ?? "accepted",
    })),
  };
}

function toIdentityStatus(status: LegacyAdminUserStatus | undefined): InternalUserStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "suspended":
    case "rejected":
      return "suspended";
    case "verified":
    default:
      return "active";
  }
}

type IdentityAdminUserRow = {
  id: string;
  email: string;
  name: string | null;
  type: IdentityAdminUserType | null;
  status: InternalUserStatus;
  email_verified: boolean | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const ADMIN_USERS_SELECT_SQL = `
  SELECT *
  FROM (
    WITH created_user_events AS (
      SELECT DISTINCT ON (event.user_id)
        event.user_id,
        event.payload->'payload'->>'legacyUserType' AS legacy_type,
        (event.payload->'payload'->'providerIdentity'->>'providerEmailVerified')::boolean AS event_email_verified
      FROM identity.auth_reconciliation_events AS event
      WHERE event.event_type = 'identity.user.created'
        AND event.user_id IS NOT NULL
      ORDER BY event.user_id, event.created_at DESC
    ),
    external_identity_status AS (
      SELECT
        user_id,
        bool_or(provider_email_verified) AS provider_email_verified
      FROM identity.external_identities
      GROUP BY user_id
    ),
    platform_members AS (
      SELECT DISTINCT membership.user_id
      FROM identity.organization_memberships AS membership
      JOIN identity.organizations AS organization
        ON organization.id = membership.organization_id
      WHERE organization.kind = 'platform'
        AND membership.status = 'active'
    )
    SELECT
      users.id::text AS id,
      users.email,
      COALESCE(users.name, '') AS name,
      COALESCE(
        CASE WHEN platform_members.user_id IS NOT NULL THEN 'admin' END,
        created_user_events.legacy_type,
        'creator'
      ) AS type,
      users.status,
      COALESCE(
        external_identity_status.provider_email_verified,
        created_user_events.event_email_verified,
        false
      ) AS email_verified,
      users.created_at,
      users.updated_at
    FROM identity.users AS users
    LEFT JOIN created_user_events
      ON created_user_events.user_id = users.id
    LEFT JOIN external_identity_status
      ON external_identity_status.user_id = users.id
    LEFT JOIN platform_members
      ON platform_members.user_id = users.id
  ) AS identity_admin_users
`;

function buildAdminUsersFilters(
  input: {
    type?: IdentityAdminUserType;
    status?: LegacyAdminUserStatus;
    search?: string;
  },
  values: unknown[],
): { sql: string } {
  const filters: string[] = [];
  if (input.type) {
    values.push(input.type);
    filters.push(`type = $${values.length}`);
  }
  if (input.status) {
    values.push(toIdentityStatus(input.status));
    filters.push(`status = $${values.length}`);
  }
  if (input.search?.trim()) {
    values.push(`%${input.search.trim()}%`);
    filters.push(`(email ILIKE $${values.length} OR name ILIKE $${values.length})`);
  }
  return {
    sql: filters.length ? `WHERE ${filters.join(" AND ")}` : "",
  };
}

function serializeAdminUser(row: IdentityAdminUserRow): IdentityAdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? "",
    type: row.type ?? "creator",
    status: fromIdentityStatus(row.status),
    avatar: null,
    email_verified: Boolean(row.email_verified),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function fromIdentityStatus(status: InternalUserStatus): LegacyAdminUserStatus {
  switch (status) {
    case "pending":
      return "pending";
    case "suspended":
    case "deleted":
      return "suspended";
    case "active":
    default:
      return "verified";
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sendAdminUserError(reply: FastifyReply, statusCode: number, message: string) {
  return reply.status(statusCode).send({
    statusCode,
    code: "invalid_payload",
    category: "validation",
    message,
  });
}
