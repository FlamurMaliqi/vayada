import pg from "pg";

import type { RepositoryConfig } from "./repository.js";

export type StaffInvitationProviderRole = "hotel_admin" | "hotel_member";

export type StaffInvitationDeliveryClaim = {
  invitationId: string;
  email: string;
  organizationId: string;
  inviterUserId: string;
  roleSlug: StaffInvitationProviderRole;
};

export type StaffInvitationProviderResponse = {
  invitationId: string;
  email: string;
  organizationId: string;
  inviterUserId: string;
  roleSlug: StaffInvitationProviderRole;
  state: "pending";
  expiresAt: string;
};

export interface StaffInvitationProvider {
  sendInvitation(
    input: StaffInvitationDeliveryClaim & { expiresInDays: 7 },
  ): Promise<StaffInvitationProviderResponse>;
}

export interface StaffInvitationDeliveryRepository {
  claim(invitationId: string): Promise<StaffInvitationDeliveryClaim | null>;
  markDelivered(
    invitationId: string,
    providerInvitationId: string,
    expiresAt: Date,
  ): Promise<boolean>;
  markUnknown(invitationId: string): Promise<void>;
}

type ClaimRow = {
  invitation_id: string;
  email: string;
  organization_id: string;
  inviter_user_id: string;
  role_key: "hotel_manager" | "front_desk" | "housekeeping" | "hotel_custom";
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createPgStaffInvitationDeliveryRepository(config: RepositoryConfig) {
  if (!config.connectionString.trim()) {
    throw new Error("Staff invitation delivery repository connectionString must not be empty");
  }
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    async claim(invitationId: string): Promise<StaffInvitationDeliveryClaim | null> {
      if (!uuidPattern.test(invitationId)) return null;
      const result = await pool.query<ClaimRow>(
        `UPDATE identity.staff_invitations invitation
         SET delivery_state = 'sending', delivery_attempted_at = now(), updated_at = now()
         FROM identity.organizations organization,
              identity.organization_memberships inviter_membership,
              identity.users inviter,
              identity.external_identities provider_identity
         WHERE invitation.id = $1::uuid
           AND invitation.status = 'pending' AND invitation.delivery_state = 'ready'
           AND invitation.role_key IN ('hotel_manager', 'front_desk', 'housekeeping', 'hotel_custom')
           AND organization.id = invitation.organization_id
           AND organization.kind = 'hotel_group' AND organization.status = 'active'
           AND organization.workos_org_id IS NOT NULL AND btrim(organization.workos_org_id) <> ''
           AND inviter_membership.id = invitation.inviter_membership_id
           AND inviter_membership.organization_id = invitation.organization_id
           AND inviter_membership.user_id = invitation.inviter_user_id
           AND inviter_membership.status = 'active'
           AND inviter_membership.workos_membership_id IS NOT NULL
           AND btrim(inviter_membership.workos_membership_id) <> ''
           AND inviter.id = invitation.inviter_user_id AND inviter.status = 'active'
           AND provider_identity.user_id = invitation.inviter_user_id
           AND provider_identity.provider = 'workos'
           AND provider_identity.provider_user_id IS NOT NULL
           AND btrim(provider_identity.provider_user_id) <> ''
           AND (SELECT count(*) FROM identity.external_identities candidate
                WHERE candidate.user_id = invitation.inviter_user_id
                  AND candidate.provider = 'workos'
                  AND candidate.provider_user_id IS NOT NULL
                  AND btrim(candidate.provider_user_id) <> '') = 1
         RETURNING invitation.id AS invitation_id, invitation.email,
                   organization.workos_org_id AS organization_id,
                   provider_identity.provider_user_id AS inviter_user_id,
                   invitation.role_key`,
        [invitationId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        invitationId: row.invitation_id,
        email: row.email,
        organizationId: row.organization_id,
        inviterUserId: row.inviter_user_id,
        roleSlug: row.role_key === "hotel_manager" ? "hotel_admin" : "hotel_member",
      };
    },

    async markDelivered(
      invitationId: string,
      providerInvitationId: string,
      expiresAt: Date,
    ): Promise<boolean> {
      if (
        !uuidPattern.test(invitationId) ||
        !providerInvitationId.trim() ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now()
      ) {
        return false;
      }
      const result = await pool.query(
        `UPDATE identity.staff_invitations
         SET delivery_state = 'delivered', provider_invitation_id = $2,
             expires_at = $3, updated_at = now()
         WHERE id = $1::uuid AND status = 'pending' AND delivery_state = 'sending'
           AND provider_invitation_id IS NULL AND expires_at IS NULL
         RETURNING id`,
        [invitationId, providerInvitationId.trim(), expiresAt],
      );
      return result.rowCount === 1;
    },

    async markUnknown(invitationId: string): Promise<void> {
      if (!uuidPattern.test(invitationId)) return;
      await pool.query(
        `UPDATE identity.staff_invitations
         SET delivery_state = 'unknown', updated_at = now()
         WHERE id = $1::uuid AND status = 'pending' AND delivery_state = 'sending'
           AND provider_invitation_id IS NULL AND expires_at IS NULL`,
        [invitationId],
      );
    },

    close: () => pool.end(),
  } satisfies StaffInvitationDeliveryRepository & { close(): Promise<void> };
}

export function createStaffInvitationDeliveryCoordinator(input: {
  repository: StaffInvitationDeliveryRepository;
  provider: StaffInvitationProvider;
}) {
  return {
    async deliver(invitationId: string) {
      const claim = await input.repository.claim(invitationId);
      if (!claim) return { outcome: "not_ready" as const, invitationId };
      try {
        const response = await input.provider.sendInvitation({ ...claim, expiresInDays: 7 });
        const providerInvitationId = response.invitationId.trim();
        const expiresAt = matchingProviderExpiry(claim, response);
        if (
          !providerInvitationId ||
          !expiresAt ||
          !(await input.repository.markDelivered(
            claim.invitationId,
            providerInvitationId,
            expiresAt,
          ))
        ) {
          await input.repository.markUnknown(claim.invitationId);
          return { outcome: "unknown" as const, invitationId: claim.invitationId };
        }
        return {
          outcome: "delivered" as const,
          invitationId: claim.invitationId,
          providerInvitationId,
        };
      } catch {
        await input.repository.markUnknown(claim.invitationId);
        return { outcome: "unknown" as const, invitationId: claim.invitationId };
      }
    },
  };
}

function matchingProviderExpiry(
  claim: StaffInvitationDeliveryClaim,
  response: StaffInvitationProviderResponse,
): Date | null {
  const expiresAt = new Date(response.expiresAt);
  if (
    response.state !== "pending" ||
    response.email.trim().toLowerCase() !== claim.email ||
    response.organizationId !== claim.organizationId ||
    response.inviterUserId !== claim.inviterUserId ||
    response.roleSlug !== claim.roleSlug ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() <= Date.now()
  ) {
    return null;
  }
  return expiresAt;
}
