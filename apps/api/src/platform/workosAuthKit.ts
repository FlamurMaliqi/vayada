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

  async function refreshSealedSession(input: {
    sealedSession: string;
    organizationId?: string;
  }): Promise<AuthKitSession | null> {
    let refreshed: Awaited<
      ReturnType<ReturnType<typeof workos.userManagement.loadSealedSession>["refresh"]>
    >;
    try {
      const loaded = workos.userManagement.loadSealedSession({
        sessionData: input.sealedSession,
        cookiePassword: config.cookiePassword,
      });
      refreshed = await loaded.refresh({
        cookiePassword: config.cookiePassword,
        organizationId: input.organizationId,
      });
    } catch (error) {
      if (isInvalidSealedSessionError(error) || isExpiredSealedSessionError(error)) return null;
      throw error;
    }
    if (!refreshed.authenticated || !refreshed.sealedSession || !refreshed.session) return null;
    const accessToken =
      "accessToken" in refreshed && typeof refreshed.accessToken === "string"
        ? refreshed.accessToken
        : refreshed.session.accessToken;
    return toAuthKitSession({
      ...refreshed,
      accessToken,
      sealedSession: refreshed.sealedSession,
    });
  }

  return {
    getAuthorizationUrl(input) {
      return workos.userManagement.getAuthorizationUrl({
        provider: input.provider,
        redirectUri: input.redirectUri,
        clientId: config.clientId,
        state: input.state,
        loginHint: input.loginHint,
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

    async authenticateWithPassword(input) {
      const response = await workos.userManagement.authenticateWithPassword({
        email: input.email,
        password: input.password,
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

    async authenticateWithEmailVerification(input) {
      const response = await workos.userManagement.authenticateWithEmailVerification({
        pendingAuthenticationToken: input.pendingAuthenticationToken,
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

    async createUser(input) {
      const user = await workos.userManagement.createUser({
        email: input.email,
        password: input.password,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadata: input.metadata,
      });
      return toAuthKitUser(user);
    },

    async resendVerificationEmail(input) {
      const verification = await workos.userManagement.getEmailVerification(
        input.emailVerificationId,
      );
      const result = await workos.userManagement.sendVerificationEmail({
        userId: verification.userId,
      });
      return { email: result.user.email };
    },

    async createPasswordReset(input) {
      await workos.userManagement.createPasswordReset({
        email: input.email,
      });
    },

    async resetPassword(input) {
      const result = await workos.userManagement.resetPassword({
        token: input.token,
        newPassword: input.newPassword,
      });
      return toAuthKitUser(result.user);
    },

    async authenticateSession(input) {
      const loaded = workos.userManagement.loadSealedSession({
        sessionData: input.sealedSession,
        cookiePassword: config.cookiePassword,
      });
      let response: Awaited<
        ReturnType<ReturnType<typeof workos.userManagement.loadSealedSession>["authenticate"]>
      >;
      try {
        response = await loaded.authenticate();
      } catch (error) {
        if (isExpiredSealedSessionError(error)) return refreshSealedSession(input);
        if (isInvalidSealedSessionError(error)) return null;
        throw error;
      }
      if (!response.authenticated) {
        return response.reason === "invalid_jwt" ? refreshSealedSession(input) : null;
      }
      return toAuthKitSession({
        ...response,
        sealedSession: input.sealedSession,
      });
    },

    async isSessionActive(input) {
      let after: string | undefined;
      do {
        const sessions = await workos.userManagement.listSessions(input.workosUserId, {
          limit: 100,
          ...(after ? { after } : {}),
        });
        if (
          sessions.data.some(
            (session) => session.id === input.sessionId && session.status === "active",
          )
        ) {
          return true;
        }
        after = sessions.listMetadata.after ?? undefined;
      } while (after);
      return false;
    },

    refreshSession: refreshSealedSession,

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

    async updateUserName(input) {
      await workos.userManagement.updateUser({
        userId: input.workosUserId,
        name: `${input.firstName} ${input.lastName}`,
        firstName: input.firstName,
        lastName: input.lastName,
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

function isInvalidSealedSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ERR_JWKS_NO_MATCHING_KEY" || error.name === "JWKSNoMatchingKey";
}

function isExpiredSealedSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ERR_JWT_EXPIRED" || error.name === "JWTExpired";
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

function toAuthKitUser(user: {
  id: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
}): AuthKitSession["user"] {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
  };
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
    user: toAuthKitUser(response.user),
    organizationId: response.organizationId,
    sessionId: response.sessionId,
  };
}
