import { createHash } from "node:crypto";
import pg from "pg";

import {
  hasValidStaffPermissionHierarchy,
  hotelStaffRoleKeys,
  staffAccessPermissionKeys,
  validateStaffInviteAccess,
  type CreateStaffInviteCommand,
  type HotelStaffRoleKey,
} from "./lifecycle.js";
import type { RepositoryConfig } from "./repository.js";

type InviterRow = {
  membership_id: string;
  name: string | null;
  email: string;
  permission_overrides: unknown;
  role_permissions: string[];
};
type InvitationRow = {
  id: string;
  request_fingerprint_hash: Buffer;
  supersedes_invitation_id: string | null;
};
type StaffRosterRow = {
  id: string;
  name: string | null;
  email: string;
  role_key: HotelStaffRoleKey;
  property_ids: string[];
  status: StaffRosterMember["status"];
  last_active_at: Date | null;
};

export type StaffRosterMember = {
  id: string;
  name: string | null;
  email: string;
  roleKey: HotelStaffRoleKey;
  propertyIds: string[];
  status: "active" | "pending" | "deactivated";
  lastActiveAt: string | null;
};

const permissionKeys = new Set<string>(staffAccessPermissionKeys);

export function createPgStaffInvitationRepository(config: RepositoryConfig) {
  if (!config.connectionString.trim()) {
    throw new Error("Staff invitation repository connectionString must not be empty");
  }
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async listRoster(organizationId: string): Promise<StaffRosterMember[]> {
      const result = await pool.query<StaffRosterRow>(
        `WITH canonical_properties AS (
           SELECT DISTINCT property.id AS property_id
           FROM identity.organizations organization
           JOIN identity.organization_resource_links link
             ON link.organization_id = organization.id
           JOIN hotel_catalog.properties property ON property.id::text = link.resource_id
           WHERE organization.id = $1 AND organization.kind = 'hotel_group'
             AND organization.status = 'active' AND link.product = 'hotel_catalog'
             AND link.resource_type = 'property' AND link.relationship IN ('owner', 'operator')
             AND link.status = 'active'
         ), roster AS (
           SELECT membership.id, staff.name, staff.email, membership.role_key,
                  CASE WHEN membership.status = 'active' AND staff.status = 'active'
                    THEN 'active' ELSE 'deactivated' END AS status,
                  (SELECT max(external.last_login_at)
                   FROM identity.external_identities external
                   WHERE external.user_id = staff.id AND external.provider = 'workos') AS last_active_at,
                  ARRAY(
                    SELECT property.property_id::text FROM canonical_properties property
                    WHERE membership.property_access_mode = 'all'
                       OR EXISTS (
                         SELECT 1 FROM identity.membership_property_assignments assignment
                         WHERE assignment.membership_id = membership.id
                           AND assignment.property_id = property.property_id
                       )
                    ORDER BY property.property_id
                  ) AS property_ids
           FROM identity.organization_memberships membership
           JOIN identity.users staff ON staff.id = membership.user_id
           JOIN identity.organizations organization ON organization.id = membership.organization_id
           WHERE membership.organization_id = $1 AND organization.kind = 'hotel_group'
             AND organization.status = 'active'
             AND membership.role_key = ANY($2::text[])
             AND membership.status IN ('active', 'inactive', 'suspended')
           UNION ALL
           SELECT invitation.id, invitation.display_name, invitation.email, invitation.role_key,
                  'pending', NULL,
                  ARRAY(
                    SELECT property.property_id::text
                    FROM identity.staff_invitation_property_assignments assignment
                    JOIN canonical_properties property ON property.property_id = assignment.property_id
                    WHERE assignment.invitation_id = invitation.id
                    ORDER BY property.property_id
                  )
           FROM identity.staff_invitations invitation
           JOIN identity.organizations organization ON organization.id = invitation.organization_id
           WHERE invitation.organization_id = $1 AND organization.kind = 'hotel_group'
             AND organization.status = 'active' AND invitation.status = 'pending'
             AND (invitation.expires_at IS NULL OR invitation.expires_at > now())
         )
         SELECT id, name, email, role_key, property_ids, status, last_active_at
         FROM roster
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                  lower(COALESCE(name, email)), id`,
        [organizationId, hotelStaffRoleKeys],
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        roleKey: row.role_key,
        propertyIds: row.property_ids,
        status: row.status,
        lastActiveAt: row.last_active_at?.toISOString() ?? null,
      }));
    },
    async persist(command: CreateStaffInviteCommand) {
      const normalized = normalize(command);
      if (!normalized) return { outcome: "rejected" as const, reason: "invalid_command" as const };
      const keyHash = hash(command.idempotencyKey);
      const fingerprint = hash(JSON.stringify(normalized));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inviter = await client.query<InviterRow>(
          `SELECT membership.id AS membership_id, actor.name, actor.email, membership.permission_overrides,
                  ARRAY(SELECT grant_row.permission_key FROM identity.role_permission_grants grant_row
                        WHERE grant_row.organization_kind = organization.kind
                          AND grant_row.role_key = membership.role_key) AS role_permissions
           FROM identity.organization_memberships membership
           JOIN identity.organizations organization ON organization.id = membership.organization_id
           JOIN identity.users actor ON actor.id = membership.user_id
           WHERE membership.organization_id = $1 AND membership.user_id = $2
             AND membership.status = 'active' AND organization.kind = 'hotel_group'
             AND organization.status = 'active' AND actor.status = 'active'
           FOR UPDATE OF membership, organization, actor`,
          [normalized.organizationId, normalized.actorUserId],
        );
        const inviterRow = inviter.rows[0];
        if (!inviterRow || !hasStaffManage(inviterRow)) {
          await client.query("ROLLBACK");
          return {
            outcome: "rejected" as const,
            reason: "inviter_not_authorized" as const,
          };
        }

        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          keyHash.toString("hex"),
        ]);
        const replay = await client.query<InvitationRow>(
          `SELECT id, request_fingerprint_hash, supersedes_invitation_id FROM identity.staff_invitations
           WHERE idempotency_key_hash = $1
           FOR UPDATE`,
          [keyHash],
        );
        const replayRow = replay.rows[0];
        if (replayRow) {
          await client.query("ROLLBACK");
          if (!replayRow.request_fingerprint_hash.equals(fingerprint)) {
            return { outcome: "rejected" as const, reason: "idempotency_conflict" as const };
          }
          return {
            outcome: "idempotent_replay" as const,
            invitationId: replayRow.id,
            ...(replayRow.supersedes_invitation_id
              ? { supersededInvitationId: replayRow.supersedes_invitation_id }
              : {}),
          };
        }

        const revision = await client.query<{ id: string }>(
          `SELECT id FROM identity.staff_invitations WHERE organization_id = $1 AND email = $2
             AND configuration_revision = $3`,
          [normalized.organizationId, normalized.email, normalized.configurationRevision],
        );
        if (revision.rowCount) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "configuration_conflict" as const };
        }

        const previous = await client.query<{ id: string; status: string }>(
          `UPDATE identity.staff_invitations
           SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'revoked' END, updated_at = now()
           WHERE organization_id = $1 AND email = $2 AND status = 'pending'
           RETURNING id, status`,
          [normalized.organizationId, normalized.email],
        );
        const previousRow = previous.rows[0];
        const supersededId = previousRow?.status === "revoked" ? previousRow.id : null;
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO identity.staff_invitations
             (organization_id, email, display_name, inviter_membership_id, inviter_user_id, inviter_name_snapshot,
              role_key, permission_overrides, property_access_mode, configuration_revision, command_id,
              idempotency_key_hash, request_fingerprint_hash, supersedes_invitation_id, request_id,
              correlation_id, request_source, reason, requested_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'assigned', $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18)
           RETURNING id`,
          [
            normalized.organizationId,
            normalized.email,
            normalized.name,
            inviterRow.membership_id,
            normalized.actorUserId,
            inviterRow.name ?? inviterRow.email,
            normalized.roleKey,
            JSON.stringify(normalized.permissionOverrides),
            normalized.configurationRevision,
            command.commandId,
            keyHash,
            fingerprint,
            supersededId,
            command.audit.requestId,
            command.audit.correlationId ?? null,
            command.audit.source,
            command.audit.reason,
            new Date(command.audit.requestedAt),
          ],
        );
        const invitationId = inserted.rows[0]!.id;
        await client.query(
          `INSERT INTO identity.staff_invitation_property_assignments (invitation_id, property_id)
             SELECT $1, property_id FROM unnest($2::uuid[]) property_id`,
          [invitationId, normalized.propertyIds],
        );
        await client.query("COMMIT");
        return {
          outcome: "created" as const,
          invitationId,
          ...(supersededId ? { supersededInvitationId: supersededId } : {}),
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        if (isPropertyScopeError(error)) {
          return { outcome: "rejected" as const, reason: "property_scope_invalid" as const };
        }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

function normalize(command: CreateStaffInviteCommand) {
  const actor = command.audit.actor;
  if (
    actor.kind !== "user" ||
    actor.organizationId !== command.payload.organizationId ||
    !actor.userId ||
    !command.commandId.trim() ||
    !command.idempotencyKey.trim() ||
    !command.payload.email.trim() ||
    !Number.isInteger(command.payload.configurationRevision) ||
    command.payload.configurationRevision <= 0 ||
    Number.isNaN(Date.parse(command.audit.requestedAt)) ||
    validateStaffInviteAccess(command.payload).length
  ) {
    return null;
  }
  const propertyIds = command.payload.propertyIds.map((id) => id.toLowerCase()).sort();
  const permissionOverrides = {
    grant: [...command.payload.permissionOverrides.grant].sort(),
    deny: [...command.payload.permissionOverrides.deny].sort(),
  };
  return {
    organizationId: command.payload.organizationId,
    email: command.payload.email.trim().toLowerCase(),
    name: command.payload.name?.trim() || null,
    roleKey: command.payload.roleKey,
    propertyIds,
    permissionOverrides,
    configurationRevision: command.payload.configurationRevision,
    actorUserId: actor.userId,
  };
}

function hasStaffManage(row: InviterRow): boolean {
  if (row.permission_overrides === null) {
    return row.role_permissions.includes("identity.staff.manage");
  }
  if (
    !row.permission_overrides ||
    typeof row.permission_overrides !== "object" ||
    Array.isArray(row.permission_overrides)
  )
    return false;
  const value = row.permission_overrides as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "grant" && key !== "deny")) return false;
  const grant = value["grant"] ?? [];
  const deny = value["deny"] ?? [];
  if (!validPermissionList(grant) || !validPermissionList(deny)) return false;
  const combined = [...grant, ...deny];
  if (new Set(combined).size !== combined.length || grant.includes("identity.staff.manage")) {
    return false;
  }
  const effective = new Set(row.role_permissions);
  grant.forEach((key) => effective.add(key));
  deny.forEach((key) => effective.delete(key));
  return effective.has("identity.staff.manage") && hasValidStaffPermissionHierarchy(effective);
}

function validPermissionList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((key) => typeof key === "string" && permissionKeys.has(key))
  );
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isPropertyScopeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; constraint?: string };
  return (
    value.code === "23503" &&
    [
      "fk_staff_invitation_property_assignment_canonical_scope",
      "staff_invitation_property_assignments_property_id_fkey",
    ].includes(value.constraint ?? "")
  );
}
