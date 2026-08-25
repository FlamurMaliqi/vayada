import { createHash } from "node:crypto";
import pg from "pg";

import {
  hasValidStaffPermissionHierarchy,
  hotelStaffRoleKeys,
  staffAccessPermissionKeys,
  validateStaffInviteAccess,
  type CreateStaffInviteCommand,
  type HotelStaffRoleKey,
  type RemoveStaffCommand,
  type UpdateStaffAccessCommand,
  type UpdateStaffStatusCommand,
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
type StaffAccessTargetRow = {
  role_key: string;
  permission_overrides: unknown;
  property_ids: string[];
};
type StaffStatusTargetRow = {
  user_id: string;
  status: "active" | "suspended";
};
type StaffRemovalTargetRow = {
  user_id: string;
  status: "active" | "suspended";
  workos_membership_id: string | null;
  workos_org_id: string | null;
  workos_user_ids: string[];
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
const staffAccessUpdateOperation = "staff_access_update";
const staffStatusUpdateOperation = "staff_status_update";
const staffRemovalOperation = "staff_remove";

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
             AND membership.status IN ('active', 'suspended')
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
    async updateStatus(command: UpdateStaffStatusCommand) {
      const normalized = normalizeStaffStatusUpdate(command);
      if (!normalized) return { outcome: "rejected" as const, reason: "invalid_command" as const };
      const keyHash = hash(command.idempotencyKey).toString("hex");
      const fingerprint = hash(JSON.stringify(normalized)).toString("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const manager = await lockAuthorizedManager(
          client,
          normalized.organizationId,
          normalized.actorUserId,
        );
        if (!manager) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        const reservation = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope, operation, key_hash, request_fingerprint_hash, status,
              tenant_scope, organization_id, correlation_id, expires_at, idempotency_metadata)
           VALUES ('identity', $1, $2, $3, 'in_progress', 'organization', $4, $5,
                   now() + interval '30 days', jsonb_build_object('commandId', $6::text))
           ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
           RETURNING id::text AS id`,
          [
            staffStatusUpdateOperation,
            keyHash,
            fingerprint,
            normalized.organizationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
          ],
        );
        const reservationId = reservation.rows[0]?.id;
        if (!reservationId) {
          const replay = await client.query<{
            request_fingerprint_hash: string;
            status: string;
            response_resource_id: string | null;
          }>(
            `SELECT request_fingerprint_hash, status, response_resource_id
             FROM platform.idempotency_keys
             WHERE operation_scope = 'identity' AND operation = $1 AND key_hash = $2
               AND tenant_scope = 'organization' AND organization_id = $3
             FOR UPDATE`,
            [staffStatusUpdateOperation, keyHash, normalized.organizationId],
          );
          await client.query("ROLLBACK");
          const row = replay.rows[0];
          return row?.request_fingerprint_hash === fingerprint &&
            row.status === "completed" &&
            row.response_resource_id === normalized.membershipId
            ? {
                outcome: "idempotent_replay" as const,
                membershipId: row.response_resource_id,
                membershipStatus: normalized.membershipStatus,
              }
            : { outcome: "rejected" as const, reason: "idempotency_conflict" as const };
        }
        const target = await client.query<StaffStatusTargetRow>(
          `SELECT membership.user_id::text, membership.status
           FROM identity.organization_memberships membership
           JOIN identity.users staff ON staff.id = membership.user_id
           WHERE membership.organization_id = $1 AND membership.id = $2
             AND membership.role_key = ANY($3::text[])
             AND membership.status IN ('active', 'suspended') AND staff.status = 'active'
           FOR UPDATE OF membership, staff`,
          [normalized.organizationId, normalized.membershipId, hotelStaffRoleKeys],
        );
        const previous = target.rows[0];
        if (!previous) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "target_not_found" as const };
        }
        await client.query(
          `UPDATE identity.organization_memberships
           SET status = $3, updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [normalized.organizationId, normalized.membershipId, normalized.membershipStatus],
        );
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key, product, action, occurred_at, tenant_scope, organization_id,
              actor_type, actor_user_id, target_resource_product, target_resource_type,
              target_resource_id, idempotency_key_id, correlation_id, causation_id,
              redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
           VALUES ($1, 'identity', 'identity.staff.status.updated', $2, 'organization', $3,
                   'user', $4, 'identity', 'organization_membership', $5, $6, $7, $8,
                   $9::jsonb, $10::jsonb, $11::jsonb, 'security', 'confidential')`,
          [
            `staff.status.updated:${reservationId}`,
            command.audit.requestedAt,
            normalized.organizationId,
            normalized.actorUserId,
            normalized.membershipId,
            reservationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
            JSON.stringify({ outcome: "updated", membershipStatus: normalized.membershipStatus }),
            JSON.stringify({
              targetUserId: previous.user_id,
              previous: { membershipStatus: previous.status },
              next: { membershipStatus: normalized.membershipStatus },
            }),
            JSON.stringify({
              requestId: command.audit.requestId,
              source: command.audit.source,
              reason: command.audit.reason,
              actorNameSnapshot: manager.name ?? manager.email,
            }),
          ],
        );
        const result = {
          outcome: "updated" as const,
          membershipId: normalized.membershipId,
          membershipStatus: normalized.membershipStatus,
        };
        const completed = await client.query(
          `UPDATE platform.idempotency_keys
           SET status = 'completed', response_status_code = 200, completed_at = now(),
               response_body_hash = $2, response_resource_product = 'identity',
               response_resource_type = 'organization_membership', response_resource_id = $3,
               idempotency_metadata = idempotency_metadata || jsonb_build_object('outcome', 'updated')
           WHERE id = $1 AND status = 'in_progress'`,
          [reservationId, hash(JSON.stringify(result)).toString("hex"), normalized.membershipId],
        );
        if (completed.rowCount !== 1) throw new Error("Staff status idempotency completion failed");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async remove(command: RemoveStaffCommand) {
      const normalized = normalizeStaffRemoval(command);
      if (!normalized) return { outcome: "rejected" as const, reason: "invalid_command" as const };
      const keyHash = hash(command.idempotencyKey).toString("hex");
      const fingerprint = hash(JSON.stringify(normalized)).toString("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const manager = await lockAuthorizedManager(
          client,
          normalized.organizationId,
          normalized.actorUserId,
        );
        if (!manager) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        const reservation = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope, operation, key_hash, request_fingerprint_hash, status,
              tenant_scope, organization_id, correlation_id, expires_at, idempotency_metadata)
           VALUES ('identity', $1, $2, $3, 'in_progress', 'organization', $4, $5,
                   now() + interval '30 days', jsonb_build_object('commandId', $6::text))
           ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
           RETURNING id::text AS id`,
          [
            staffRemovalOperation,
            keyHash,
            fingerprint,
            normalized.organizationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
          ],
        );
        const reservationId = reservation.rows[0]?.id;
        if (!reservationId) {
          const replay = await client.query<{
            request_fingerprint_hash: string;
            status: string;
            response_resource_id: string | null;
            provider_revocation_job_id: string | null;
          }>(
            `SELECT request_fingerprint_hash, status, response_resource_id,
                    idempotency_metadata ->> 'providerRevocationJobId' AS provider_revocation_job_id
             FROM platform.idempotency_keys
             WHERE operation_scope = 'identity' AND operation = $1 AND key_hash = $2
               AND tenant_scope = 'organization' AND organization_id = $3
             FOR UPDATE`,
            [staffRemovalOperation, keyHash, normalized.organizationId],
          );
          await client.query("ROLLBACK");
          const row = replay.rows[0];
          return row?.request_fingerprint_hash === fingerprint &&
            row.status === "completed" &&
            row.response_resource_id === normalized.membershipId &&
            row.provider_revocation_job_id
            ? {
                outcome: "idempotent_replay" as const,
                membershipId: row.response_resource_id,
                providerRevocationJobId: row.provider_revocation_job_id,
              }
            : { outcome: "rejected" as const, reason: "idempotency_conflict" as const };
        }
        const target = await client.query<StaffRemovalTargetRow>(
          `SELECT membership.user_id::text, membership.status,
                  NULLIF(btrim(membership.workos_membership_id), '') AS workos_membership_id,
                  NULLIF(btrim(organization.workos_org_id), '') AS workos_org_id,
                  ARRAY(SELECT btrim(external.provider_user_id)
                        FROM identity.external_identities external
                        WHERE external.user_id = staff.id AND external.provider = 'workos'
                          AND NULLIF(btrim(external.provider_user_id), '') IS NOT NULL
                        ORDER BY external.id) AS workos_user_ids
           FROM identity.organization_memberships membership
           JOIN identity.users staff ON staff.id = membership.user_id
           JOIN identity.organizations organization ON organization.id = membership.organization_id
           WHERE membership.organization_id = $1 AND membership.id = $2
             AND membership.role_key = ANY($3::text[])
             AND membership.status IN ('active', 'suspended')
             AND staff.status IN ('active', 'suspended')
           FOR UPDATE OF membership, staff, organization`,
          [normalized.organizationId, normalized.membershipId, hotelStaffRoleKeys],
        );
        const previous = target.rows[0];
        if (!previous) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "target_not_found" as const };
        }
        await client.query(
          `UPDATE identity.organization_memberships
           SET status = 'inactive', updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [normalized.organizationId, normalized.membershipId],
        );
        const expectedWorkosUserId =
          previous.workos_user_ids.length === 1 ? previous.workos_user_ids[0] : null;
        const job = await client.query<{ id: string }>(
          `INSERT INTO platform.jobs
             (job_key, queue_name, job_type, max_attempts, tenant_scope, organization_id,
              resource_product, resource_type, resource_id, correlation_id,
              idempotency_key_hash, payload, job_metadata)
           VALUES ($1, 'identity-provider', 'workos.organization-membership.delete', 5,
                   'organization', $2, 'identity', 'organization_membership', $3, $4, $5,
                   jsonb_strip_nulls(jsonb_build_object(
                     'workosMembershipId', $6::text,
                     'expectedWorkosOrganizationId', $7::text,
                     'expectedWorkosUserId', $8::text
                   )),
                   jsonb_build_object('commandId', $9::text, 'idempotencyKeyId', $10::text))
           RETURNING id::text AS id`,
          [
            `identity.staff.remove:${reservationId}`,
            normalized.organizationId,
            normalized.membershipId,
            command.audit.correlationId ?? command.audit.requestId,
            keyHash,
            previous.workos_membership_id,
            previous.workos_org_id,
            expectedWorkosUserId,
            command.commandId,
            reservationId,
          ],
        );
        const providerRevocationJobId = job.rows[0]?.id;
        if (!providerRevocationJobId) throw new Error("Staff removal job insert failed");
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key, product, action, occurred_at, tenant_scope, organization_id,
              actor_type, actor_user_id, target_resource_product, target_resource_type,
              target_resource_id, idempotency_key_id, job_id, correlation_id, causation_id,
              redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
           VALUES ($1, 'identity', 'identity.staff.removed', $2, 'organization', $3,
                   'user', $4, 'identity', 'organization_membership', $5, $6, $7, $8, $9,
                   $10::jsonb, $11::jsonb, $12::jsonb, 'security', 'confidential')`,
          [
            `staff.removed:${reservationId}`,
            command.audit.requestedAt,
            normalized.organizationId,
            normalized.actorUserId,
            normalized.membershipId,
            reservationId,
            providerRevocationJobId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
            JSON.stringify({
              outcome: "access_revoked",
              providerRevocation:
                previous.workos_membership_id && previous.workos_org_id && expectedWorkosUserId
                  ? "pending"
                  : "reconciliation_required",
            }),
            JSON.stringify({
              targetUserId: previous.user_id,
              previous: { membershipStatus: previous.status },
              next: { membershipStatus: "inactive" },
              providerRevocationJobId,
            }),
            JSON.stringify({
              requestId: command.audit.requestId,
              source: command.audit.source,
              reason: command.audit.reason,
              actorNameSnapshot: manager.name ?? manager.email,
            }),
          ],
        );
        const result = {
          outcome: "removed" as const,
          membershipId: normalized.membershipId,
          providerRevocationJobId,
        };
        const completed = await client.query(
          `UPDATE platform.idempotency_keys
           SET status = 'completed', response_status_code = 202, completed_at = now(),
               response_body_hash = $2, response_resource_product = 'identity',
               response_resource_type = 'organization_membership', response_resource_id = $3,
               idempotency_metadata = idempotency_metadata ||
                 jsonb_build_object('outcome', 'removed', 'providerRevocationJobId', $4::text)
           WHERE id = $1 AND status = 'in_progress'`,
          [
            reservationId,
            hash(JSON.stringify(result)).toString("hex"),
            normalized.membershipId,
            providerRevocationJobId,
          ],
        );
        if (completed.rowCount !== 1)
          throw new Error("Staff removal idempotency completion failed");
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async updateAccess(command: UpdateStaffAccessCommand) {
      const normalized = normalizeStaffAccessUpdate(command);
      if (!normalized) return { outcome: "rejected" as const, reason: "invalid_command" as const };
      const keyHash = hash(command.idempotencyKey).toString("hex");
      const fingerprint = hash(JSON.stringify(normalized)).toString("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const manager = await lockAuthorizedManager(
          client,
          normalized.organizationId,
          normalized.actorUserId,
        );
        if (!manager) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "inviter_not_authorized" as const };
        }
        const reservation = await client.query<{ id: string }>(
          `INSERT INTO platform.idempotency_keys
             (operation_scope, operation, key_hash, request_fingerprint_hash, status,
              tenant_scope, organization_id, correlation_id, expires_at, idempotency_metadata)
           VALUES ('identity', $1, $2, $3, 'in_progress', 'organization', $4, $5,
                   now() + interval '30 days', jsonb_build_object('commandId', $6::text))
           ON CONFLICT (operation_scope, operation, key_hash, scope_key) DO NOTHING
           RETURNING id::text AS id`,
          [
            staffAccessUpdateOperation,
            keyHash,
            fingerprint,
            normalized.organizationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
          ],
        );
        const reservationId = reservation.rows[0]?.id;
        if (!reservationId) {
          const replay = await client.query<{
            request_fingerprint_hash: string;
            status: string;
            response_resource_id: string | null;
          }>(
            `SELECT request_fingerprint_hash, status, response_resource_id
             FROM platform.idempotency_keys
             WHERE operation_scope = 'identity' AND operation = $1 AND key_hash = $2
               AND tenant_scope = 'organization' AND organization_id = $3
             FOR UPDATE`,
            [staffAccessUpdateOperation, keyHash, normalized.organizationId],
          );
          await client.query("ROLLBACK");
          const row = replay.rows[0];
          return row?.request_fingerprint_hash === fingerprint &&
            row.status === "completed" &&
            row.response_resource_id === normalized.membershipId
            ? {
                outcome: "idempotent_replay" as const,
                membershipId: row.response_resource_id!,
              }
            : { outcome: "rejected" as const, reason: "idempotency_conflict" as const };
        }
        const target = await client.query<StaffAccessTargetRow>(
          `SELECT membership.role_key, membership.permission_overrides,
                  ARRAY(SELECT assignment.property_id::text
                        FROM identity.membership_property_assignments assignment
                        WHERE assignment.membership_id = membership.id
                        ORDER BY assignment.property_id) AS property_ids
           FROM identity.organization_memberships membership
           WHERE membership.organization_id = $1 AND membership.id = $2
             AND membership.role_key = ANY($3::text[])
             AND membership.status IN ('active', 'suspended')
           FOR UPDATE`,
          [normalized.organizationId, normalized.membershipId, hotelStaffRoleKeys],
        );
        const previous = target.rows[0];
        if (!previous) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "target_not_found" as const };
        }
        const linkedProperties = await client.query<{ property_id: string }>(
          `SELECT property.id::text AS property_id
           FROM identity.organization_resource_links link
           JOIN hotel_catalog.properties property ON property.id::text = link.resource_id
           WHERE link.organization_id = $1 AND link.product = 'hotel_catalog'
             AND link.resource_type = 'property' AND link.relationship IN ('owner', 'operator')
             AND link.status = 'active' AND property.id = ANY($2::uuid[])
           FOR SHARE OF link, property`,
          [normalized.organizationId, normalized.propertyIds],
        );
        if (
          new Set(linkedProperties.rows.map(({ property_id }) => property_id)).size !==
          normalized.propertyIds.length
        ) {
          await client.query("ROLLBACK");
          return { outcome: "rejected" as const, reason: "property_scope_invalid" as const };
        }
        await client.query(
          `UPDATE identity.organization_memberships
           SET role_key = $3, permission_overrides = $4::jsonb,
               property_access_mode = 'assigned', updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [
            normalized.organizationId,
            normalized.membershipId,
            normalized.roleKey,
            JSON.stringify(normalized.permissionOverrides),
          ],
        );
        await client.query(
          "DELETE FROM identity.membership_property_assignments WHERE membership_id = $1",
          [normalized.membershipId],
        );
        await client.query(
          `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
           SELECT $1, property_id FROM unnest($2::uuid[]) property_id`,
          [normalized.membershipId, normalized.propertyIds],
        );
        const next = {
          roleKey: normalized.roleKey,
          permissionOverrides: normalized.permissionOverrides,
          propertyIds: normalized.propertyIds,
        };
        await client.query(
          `INSERT INTO platform.product_audit_events
             (audit_key, product, action, occurred_at, tenant_scope, organization_id,
              actor_type, actor_user_id, target_resource_product, target_resource_type,
              target_resource_id, idempotency_key_id, correlation_id, causation_id,
              redacted_payload, private_payload, audit_metadata, retention_class, privacy_scope)
           VALUES ($1, 'identity', 'identity.staff.access.updated', now(), 'organization', $2,
                   'user', $3, 'identity', 'organization_membership', $4, $5, $6, $7,
                   $8::jsonb, $9::jsonb, $10::jsonb, 'security', 'confidential')`,
          [
            `staff.access.updated:${reservationId}`,
            normalized.organizationId,
            normalized.actorUserId,
            normalized.membershipId,
            reservationId,
            command.audit.correlationId ?? command.audit.requestId,
            command.commandId,
            JSON.stringify({
              outcome: "updated",
              roleKey: normalized.roleKey,
              propertyCount: normalized.propertyIds.length,
              permissionGrantCount: normalized.permissionOverrides.grant.length,
              permissionDenyCount: normalized.permissionOverrides.deny.length,
            }),
            JSON.stringify({
              previous: {
                roleKey: previous.role_key,
                permissionOverrides: previous.permission_overrides,
                propertyIds: previous.property_ids,
              },
              next,
            }),
            JSON.stringify({
              requestId: command.audit.requestId,
              source: command.audit.source,
              reason: command.audit.reason,
              requestedAt: command.audit.requestedAt,
              actorNameSnapshot: manager.name ?? manager.email,
            }),
          ],
        );
        const result = { outcome: "updated" as const, membershipId: normalized.membershipId };
        const completed = await client.query(
          `UPDATE platform.idempotency_keys
           SET status = 'completed', response_status_code = 200, completed_at = now(),
               response_body_hash = $2, response_resource_product = 'identity',
               response_resource_type = 'organization_membership', response_resource_id = $3,
               idempotency_metadata = idempotency_metadata || jsonb_build_object('outcome', 'updated')
           WHERE id = $1 AND status = 'in_progress'`,
          [reservationId, hash(JSON.stringify(result)).toString("hex"), normalized.membershipId],
        );
        if (completed.rowCount !== 1) throw new Error("Staff access idempotency completion failed");
        await client.query("COMMIT");
        return result;
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
    async persist(command: CreateStaffInviteCommand) {
      const normalized = normalize(command);
      if (!normalized) return { outcome: "rejected" as const, reason: "invalid_command" as const };
      const keyHash = hash(command.idempotencyKey);
      const fingerprint = hash(JSON.stringify(normalized));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inviterRow = await lockAuthorizedManager(
          client,
          normalized.organizationId,
          normalized.actorUserId,
        );
        if (!inviterRow) {
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

function normalizeStaffAccessUpdate(command: UpdateStaffAccessCommand) {
  const actor = command.audit.actor;
  if (
    actor.kind !== "user" ||
    actor.organizationId !== command.payload.organizationId ||
    !actor.userId ||
    !command.commandId.trim() ||
    !command.idempotencyKey.trim() ||
    !canonicalUuid(command.payload.membershipId) ||
    Number.isNaN(Date.parse(command.audit.requestedAt)) ||
    validateStaffInviteAccess(command.payload).length
  ) {
    return null;
  }
  return {
    organizationId: command.payload.organizationId,
    membershipId: command.payload.membershipId.toLowerCase(),
    roleKey: command.payload.roleKey,
    propertyIds: command.payload.propertyIds.map((id) => id.toLowerCase()).sort(),
    permissionOverrides: {
      grant: [...command.payload.permissionOverrides.grant].sort(),
      deny: [...command.payload.permissionOverrides.deny].sort(),
    },
    actorUserId: actor.userId,
  };
}

function normalizeStaffStatusUpdate(command: UpdateStaffStatusCommand) {
  const actor = command.audit.actor;
  if (
    actor.kind !== "user" ||
    actor.organizationId !== command.payload.organizationId ||
    !actor.userId ||
    !command.commandId.trim() ||
    !command.idempotencyKey.trim() ||
    !canonicalUuid(command.payload.membershipId) ||
    !["active", "suspended"].includes(command.payload.membershipStatus) ||
    Number.isNaN(Date.parse(command.audit.requestedAt))
  ) {
    return null;
  }
  return {
    organizationId: command.payload.organizationId,
    membershipId: command.payload.membershipId.toLowerCase(),
    membershipStatus: command.payload.membershipStatus,
    actorUserId: actor.userId,
  };
}

function normalizeStaffRemoval(command: RemoveStaffCommand) {
  const actor = command.audit.actor;
  if (
    actor.kind !== "user" ||
    actor.organizationId !== command.payload.organizationId ||
    !actor.userId ||
    !command.commandId.trim() ||
    !command.idempotencyKey.trim() ||
    !canonicalUuid(command.payload.membershipId) ||
    Number.isNaN(Date.parse(command.audit.requestedAt))
  ) {
    return null;
  }
  return {
    organizationId: command.payload.organizationId,
    membershipId: command.payload.membershipId.toLowerCase(),
    actorUserId: actor.userId,
  };
}

async function lockAuthorizedManager(
  client: pg.PoolClient,
  organizationId: string,
  actorUserId: string,
): Promise<InviterRow | null> {
  const result = await client.query<InviterRow>(
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
    [organizationId, actorUserId],
  );
  const row = result.rows[0];
  return row && hasStaffManage(row) ? row : null;
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

function canonicalUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPropertyScopeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; constraint?: string };
  return (
    value.code === "23503" &&
    [
      "fk_staff_invitation_property_assignment_canonical_scope",
      "staff_invitation_property_assignments_property_id_fkey",
      "fk_membership_property_assignment_canonical_scope",
      "membership_property_assignments_property_id_fkey",
    ].includes(value.constraint ?? "")
  );
}
