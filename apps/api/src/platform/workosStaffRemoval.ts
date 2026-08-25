import { NotFoundException, WorkOS } from "@workos-inc/node";
import type { StaffRemovalProvider } from "@vayada/backend-auth";

export function createWorkOSStaffRemovalProvider(config: { apiKey: string }): StaffRemovalProvider {
  const workos = new WorkOS(config.apiKey, { maxRetries: 0 });

  return {
    async getMembership(id) {
      try {
        const membership = await workos.userManagement.getOrganizationMembership(id);
        return {
          id: membership.id,
          organizationId: membership.organizationId,
          userId: membership.userId,
        };
      } catch (error) {
        if (error instanceof NotFoundException) return null;
        throw error;
      }
    },

    async deleteMembership(id) {
      try {
        await workos.userManagement.deleteOrganizationMembership(id);
        return "deleted";
      } catch (error) {
        if (error instanceof NotFoundException) return "already_absent";
        throw error;
      }
    },
  };
}
