import type { PropertyAccessRepository } from "@vayada/backend-authorization";

export const agencyPropertyAccessRepository: PropertyAccessRepository = {
  async findMembershipPropertyScope(context) {
    return {
      mode: "all",
      roleKey: context.membership.roleKey,
      accessOrigin: "agency",
      assignedPropertyIds: [],
    };
  },
};
