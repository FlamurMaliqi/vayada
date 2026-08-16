import { AuthError } from "./errors.js";
import { type IdentityRepository } from "./repository.js";
import {
  type LinkedResource,
  type PermissionKey,
  type Product,
  type ProductEntitlement,
  type RequestContext,
  type RequestSource,
  type ResourceRelationship,
  type ResourceType,
} from "./types.js";
import { type VerifiedSession } from "./verify.js";

export type AuthorizationResolution = {
  permissions: PermissionKey[];
  entitlements?: ProductEntitlement[];
};

export type AuthorizationResolver = (context: RequestContext) => Promise<AuthorizationResolution>;

export type ResolveOptions = {
  requestId: string;
  locale?: string;
  currency?: string;
  source?: RequestSource;
  sourceIp?: string;
  userAgent?: string;
  authorizationResolver?: AuthorizationResolver;
};

/**
 * Resolves a fully typed RequestContext from a verified WorkOS session.
 *
 * Throws AuthError when:
 * - The WorkOS user ID has no matching internal identity (USER_NOT_FOUND)
 * - The internal user is suspended or deleted (USER_SUSPENDED)
 * - The session has no org_id claim (ORGANIZATION_NOT_FOUND)
 * - The WorkOS org has no matching internal organization (ORGANIZATION_NOT_FOUND)
 * - The internal organization is not active (ORGANIZATION_SUSPENDED)
 * - No membership exists for (user, organization) (MEMBERSHIP_NOT_FOUND)
 * - The membership is not active (MEMBERSHIP_NOT_FOUND)
 *
 * Note: permissions and entitlements are left empty — they are populated by
 * backend-authorization (follow-up ticket). Resource links are resolved here
 * since they are pure identity state.
 */
export async function resolveRequestContext(
  session: VerifiedSession,
  repo: IdentityRepository,
  options: ResolveOptions,
): Promise<RequestContext> {
  const user = await repo.findUserByProviderUserId("workos", session.workosUserId);
  if (!user) {
    throw new AuthError(
      "USER_NOT_FOUND",
      `No internal user for WorkOS user ${session.workosUserId}`,
    );
  }
  if (user.status === "suspended" || user.status === "deleted") {
    throw new AuthError("USER_SUSPENDED", `User account is ${user.status}`);
  }

  if (!session.workosOrgId) {
    throw new AuthError("ORGANIZATION_NOT_FOUND", "No organization selected in WorkOS session");
  }

  const org = await repo.findOrganizationByWorkosOrgId(session.workosOrgId);
  if (!org) {
    throw new AuthError(
      "ORGANIZATION_NOT_FOUND",
      `No internal organization for WorkOS org ${session.workosOrgId}`,
    );
  }
  if (org.status !== "active") {
    throw new AuthError("ORGANIZATION_SUSPENDED", `Organization is ${org.status}`);
  }

  const membership = await repo.findActiveMembership(user.userId, org.organizationId);
  if (!membership) {
    throw new AuthError(
      "MEMBERSHIP_NOT_FOUND",
      `No membership for user ${user.userId} in organization ${org.organizationId}`,
    );
  }
  if (membership.status !== "active") {
    throw new AuthError("MEMBERSHIP_NOT_FOUND", `Membership status is ${membership.status}`);
  }

  const resourceLinks = await repo.findLinkedResources(org.organizationId);

  const context: RequestContext = {
    actor: {
      internalUserId: user.userId,
      providerIdentity: {
        provider: "workos",
        providerUserId: session.workosUserId,
        sessionId: session.sessionId ?? undefined,
        providerOrganizationId: session.workosOrgId,
      },
      email: user.email,
      name: user.name,
      status: user.status,
    },
    selectedOrganization: {
      organizationId: org.organizationId,
      workosOrgId: org.workosOrgId ?? undefined,
      name: org.name,
      kind: org.kind,
      status: org.status,
    },
    membership: {
      membershipId: membership.membershipId,
      status: membership.status,
      roleKey: membership.roleKey,
      workosMembershipId: membership.workosMembershipId ?? undefined,
      workosRoleSlugs: membership.workosRoleSlugs,
      permissions: [],
    },
    linkedResources: resourceLinks.map(
      (r): LinkedResource => ({
        product: r.product as Product,
        resourceType: r.resourceType as ResourceType,
        resourceId: r.resourceId,
        relationship: r.relationship as ResourceRelationship,
        status: r.status as LinkedResource["status"],
      }),
    ),
    entitlements: [],
    locale: options.locale ?? "en",
    currency: options.currency ?? "USD",
    audit: {
      requestId: options.requestId,
      source: options.source ?? "api",
      sourceIp: options.sourceIp,
      userAgent: options.userAgent,
      receivedAt: new Date().toISOString(),
    },
  };

  if (!options.authorizationResolver) {
    return context;
  }

  const authorization = await options.authorizationResolver(context);

  return {
    ...context,
    membership: {
      ...context.membership,
      permissions: authorization.permissions,
    },
    entitlements: authorization.entitlements ?? context.entitlements,
  };
}
