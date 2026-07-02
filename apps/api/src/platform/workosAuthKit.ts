import { WorkOS } from "@workos-inc/node";

import type { AuthKitClient, AuthKitSession } from "../routes/authSession.js";
import type { MembershipStatus } from "@vayada/backend-auth";

type WorkOSAuthKitClientConfig = {
  apiKey: string;
  clientId: string;
  cookiePassword: string;
};

export function createWorkOSAuthKitClient(config: WorkOSAuthKitClientConfig): AuthKitClient {
  const workos = new WorkOS(config.apiKey, {
    clientId: config.clientId,
  });

  return {
    getAuthorizationUrl(input) {
      return workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        clientId: config.clientId,
        redirectUri: input.redirectUri,
        state: input.state,
        organizationId: input.organizationId,
        loginHint: input.loginHint,
        screenHint: input.screenHint,
      });
    },

    async authenticateWithCode(input) {
      const response = await workos.userManagement.authenticateWithCode({
        code: input.code,
        clientId: config.clientId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        session: {
          sealSession: true,
          cookiePassword: config.cookiePassword,
        },
      });
      return toAuthKitSession(response);
    },

    async authenticateSession(input) {
      const response = await workos.userManagement
        .loadSealedSession({
          sessionData: input.sealedSession,
          cookiePassword: config.cookiePassword,
        })
        .authenticate();
      if (!response.authenticated) return null;
      return toAuthKitSession({
        ...response,
        sealedSession: input.sealedSession,
      });
    },

    async refreshSession(input) {
      const loaded = workos.userManagement.loadSealedSession({
        sessionData: input.sealedSession,
        cookiePassword: config.cookiePassword,
      });
      const refreshed = await loaded.refresh({
        cookiePassword: config.cookiePassword,
        organizationId: input.organizationId,
      });
      if (!refreshed.authenticated || !refreshed.sealedSession) return null;

      const authenticated = await workos.userManagement
        .loadSealedSession({
          sessionData: refreshed.sealedSession,
          cookiePassword: config.cookiePassword,
        })
        .authenticate();
      if (!authenticated.authenticated) return null;
      return toAuthKitSession({
        ...authenticated,
        sealedSession: refreshed.sealedSession,
      });
    },

    async createSignupOrganization(input) {
      const organization = await workos.organizations.createOrganization(
        {
          name: input.name,
          externalId: input.externalId,
          metadata: input.metadata,
        },
        {
          idempotencyKey: input.externalId,
        },
      );
      return { organizationId: organization.id };
    },

    async ensureSignupOrganizationMembership(input) {
      const existing = await workos.userManagement.listOrganizationMemberships({
        userId: input.workosUserId,
        organizationId: input.workosOrganizationId,
        statuses: ["active", "pending"],
        limit: 1,
      });
      const existingMembership = existing.data[0];
      if (existingMembership) {
        return {
          membershipId: existingMembership.id,
          roleSlugs: membershipRoleSlugs(existingMembership, [input.roleKey]),
          status: membershipStatus(existingMembership.status),
        };
      }

      const membership = await workos.userManagement.createOrganizationMembership({
        userId: input.workosUserId,
        organizationId: input.workosOrganizationId,
        roleSlug: input.roleKey,
      });
      return {
        membershipId: membership.id,
        roleSlugs: membershipRoleSlugs(membership, [input.roleKey]),
        status: membershipStatus(membership.status),
      };
    },

    async getLogoutUrl(input) {
      return workos.userManagement
        .loadSealedSession({
          sessionData: input.sealedSession,
          cookiePassword: config.cookiePassword,
        })
        .getLogoutUrl({
          returnTo: input.returnTo,
        });
    },

    async updateUserExternalId(input) {
      await workos.userManagement.updateUser({
        userId: input.workosUserId,
        externalId: input.externalId,
      });
    },
  };
}

function membershipRoleSlugs(
  membership: { roles?: Array<{ slug: string }>; role?: { slug: string } },
  fallback: string[],
): string[] {
  const roleSlugs = membership.roles?.map((role) => role.slug).filter(Boolean) ?? [];
  if (roleSlugs.length > 0) return roleSlugs;
  if (membership.role?.slug) return [membership.role.slug];
  return fallback;
}

function membershipStatus(status: string | undefined): MembershipStatus | undefined {
  if (
    status === "active" ||
    status === "pending" ||
    status === "inactive" ||
    status === "suspended"
  ) {
    return status;
  }
  return undefined;
}

function toAuthKitSession(response: {
  accessToken: string;
  sealedSession?: string;
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    name?: string | null;
  };
  organizationId?: string;
  sessionId?: string;
}): AuthKitSession {
  if (!response.sealedSession) {
    throw new Error("WorkOS response did not include a sealed session");
  }
  return {
    accessToken: response.accessToken,
    sealedSession: response.sealedSession,
    user: {
      id: response.user.id,
      email: response.user.email,
      emailVerified: response.user.emailVerified,
      name: response.user.name,
    },
    organizationId: response.organizationId,
    sessionId: response.sessionId,
  };
}
