import { WorkOS } from "@workos-inc/node";
import type { StaffInvitationProvider } from "@vayada/backend-auth";

export function createWorkOSStaffInvitationProvider(config: {
  apiKey: string;
}): StaffInvitationProvider {
  const workos = new WorkOS(config.apiKey, { maxRetries: 0 });

  return {
    async sendInvitation(input) {
      const invitation = await workos.userManagement.sendInvitation({
        email: input.email,
        organizationId: input.organizationId,
        inviterUserId: input.inviterUserId,
        roleSlug: input.roleSlug,
        expiresInDays: input.expiresInDays,
      });
      if (
        invitation.state !== "pending" ||
        !invitation.organizationId ||
        !invitation.inviterUserId ||
        (invitation.roleSlug !== "hotel_admin" && invitation.roleSlug !== "hotel_member")
      ) {
        throw new Error("WorkOS staff invitation response is not delivery-bindable");
      }
      return {
        invitationId: invitation.id,
        email: invitation.email,
        organizationId: invitation.organizationId,
        inviterUserId: invitation.inviterUserId,
        roleSlug: invitation.roleSlug,
        state: invitation.state,
        expiresAt: invitation.expiresAt,
      };
    },
  };
}
