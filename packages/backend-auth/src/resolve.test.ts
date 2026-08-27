import { describe, expect, it } from "vitest";

import { AuthError } from "./errors.js";
import {
  type IdentityMembership,
  type IdentityOrganization,
  type IdentityRepository,
  type IdentityResourceLink,
  type IdentityUser,
} from "./repository.js";
import { resolveRequestContext } from "./resolve.js";
import { type VerifiedSession } from "./verify.js";

// ---------------------------------------------------------------------------
// Fake repository builder
// ---------------------------------------------------------------------------

function fakeRepo(overrides: {
  user?: IdentityUser | null;
  org?: IdentityOrganization | null;
  membership?: IdentityMembership | null;
  resources?: IdentityResourceLink[];
}): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return overrides.user ?? null;
    },
    async findOrganizationByWorkosOrgId() {
      return overrides.org ?? null;
    },
    async findActiveMembership() {
      return overrides.membership ?? null;
    },
    async findLinkedResources() {
      return overrides.resources ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture data — mirrors the hotel owner case from requestContext.fixtures.ts
// ---------------------------------------------------------------------------

const FUTURE_EXPIRY = Math.floor(Date.now() / 1000) + 3600;

const SESSION: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: FUTURE_EXPIRY,
};

const OPTIONS = {
  requestId: "req_test_001",
  locale: "en-US",
  currency: "EUR",
  source: "web" as const,
};

const USER: IdentityUser = {
  userId: "user_hotel_owner",
  email: "owner@example.com",
  name: "Harper Owner",
  status: "active",
};

const ORG: IdentityOrganization = {
  organizationId: "org_hotel_group",
  workosOrgId: "org_workos_hotel_group",
  kind: "hotel_group",
  status: "active",
};

const MEMBERSHIP: IdentityMembership = {
  membershipId: "membership_hotel_owner",
  status: "active",
  roleKey: "hotel_owner",
  workosMembershipId: "om_hotel_owner",
  workosRoleSlugs: ["hotel_owner"],
};

const RESOURCES: IdentityResourceLink[] = [
  {
    product: "booking",
    resourceType: "booking_hotel",
    resourceId: "booking_hotel_alpenrose",
    relationship: "owner",
    status: "active",
  },
  {
    product: "pms",
    resourceType: "pms_hotel",
    resourceId: "pms_hotel_alpenrose",
    relationship: "operator",
    status: "active",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveRequestContext", () => {
  it("resolves a complete RequestContext for a known hotel owner", async () => {
    const repo = fakeRepo({ user: USER, org: ORG, membership: MEMBERSHIP, resources: RESOURCES });
    const ctx = await resolveRequestContext(SESSION, repo, OPTIONS);

    expect(ctx.actor.internalUserId).toBe("user_hotel_owner");
    expect(ctx.actor.email).toBe("owner@example.com");
    expect(ctx.actor.name).toBe("Harper Owner");
    expect(ctx.actor.status).toBe("active");
    expect(ctx.actor.providerIdentity.provider).toBe("workos");
    expect(ctx.actor.providerIdentity.providerUserId).toBe("user_workos_hotel_owner");
    expect(ctx.actor.providerIdentity.sessionId).toBe("session_hotel_owner");

    expect(ctx.selectedOrganization.organizationId).toBe("org_hotel_group");
    expect(ctx.selectedOrganization.kind).toBe("hotel_group");
    expect(ctx.selectedOrganization.status).toBe("active");

    expect(ctx.membership.membershipId).toBe("membership_hotel_owner");
    expect(ctx.membership.roleKey).toBe("hotel_owner");
    expect(ctx.membership.workosRoleSlugs).toEqual(["hotel_owner"]);
    expect(ctx.membership.permissions).toEqual([]);

    expect(ctx.linkedResources).toHaveLength(2);
    expect(ctx.linkedResources[0].product).toBe("booking");
    expect(ctx.linkedResources[0].relationship).toBe("owner");

    expect(ctx.locale).toBe("en-US");
    expect(ctx.currency).toBe("EUR");
    expect(ctx.audit.requestId).toBe("req_test_001");
    expect(ctx.audit.source).toBe("web");
    expect(ctx.entitlements).toEqual([]);
  });

  it("populates authorization data through a resolver when provided", async () => {
    const repo = fakeRepo({ user: USER, org: ORG, membership: MEMBERSHIP, resources: RESOURCES });
    const ctx = await resolveRequestContext(SESSION, repo, {
      ...OPTIONS,
      authorizationResolver: async (baseContext) => {
        expect(baseContext.membership.permissions).toEqual([]);
        expect(baseContext.selectedOrganization.kind).toBe("hotel_group");
        expect(baseContext.membership.roleKey).toBe("hotel_owner");

        return {
          permissions: ["booking.settings.manage", "pms.booking.update"],
          entitlements: [
            {
              product: "booking",
              key: "booking-engine",
              status: "active",
            },
            {
              product: "pms",
              key: "pms-core",
              status: "active",
              resource: {
                product: "pms",
                resourceType: "pms_hotel",
                resourceId: "pms_hotel_alpenrose",
              },
            },
          ],
        };
      },
    });

    expect(ctx.membership.permissions).toEqual(["booking.settings.manage", "pms.booking.update"]);
    expect(ctx.entitlements).toEqual([
      {
        product: "booking",
        key: "booking-engine",
        status: "active",
      },
      {
        product: "pms",
        key: "pms-core",
        status: "active",
        resource: {
          product: "pms",
          resourceType: "pms_hotel",
          resourceId: "pms_hotel_alpenrose",
        },
      },
    ]);
  });

  it("uses default locale and currency when not provided", async () => {
    const repo = fakeRepo({ user: USER, org: ORG, membership: MEMBERSHIP });
    const ctx = await resolveRequestContext(SESSION, repo, { requestId: "req_defaults" });
    expect(ctx.locale).toBe("en");
    expect(ctx.currency).toBe("USD");
    expect(ctx.audit.source).toBe("api");
  });

  it("throws USER_NOT_FOUND when the WorkOS user has no internal identity", async () => {
    const repo = fakeRepo({ user: null });
    await expect(resolveRequestContext(SESSION, repo, OPTIONS)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "USER_NOT_FOUND",
    );
  });

  it("throws USER_SUSPENDED when the internal user is suspended", async () => {
    const repo = fakeRepo({ user: { ...USER, status: "suspended" } });
    await expect(resolveRequestContext(SESSION, repo, OPTIONS)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "USER_SUSPENDED",
    );
  });

  it("throws USER_SUSPENDED when the internal user is deleted", async () => {
    const repo = fakeRepo({ user: { ...USER, status: "deleted" } });
    await expect(resolveRequestContext(SESSION, repo, OPTIONS)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "USER_SUSPENDED",
    );
  });

  it("throws ORGANIZATION_NOT_FOUND when the session has no org_id claim", async () => {
    const repo = fakeRepo({ user: USER });
    const noOrgSession: VerifiedSession = { ...SESSION, workosOrgId: null };
    await expect(resolveRequestContext(noOrgSession, repo, OPTIONS)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "ORGANIZATION_NOT_FOUND",
    );
  });

  it("throws ORGANIZATION_NOT_FOUND when the WorkOS org has no internal match", async () => {
    const repo = fakeRepo({ user: USER, org: null });
    await expect(resolveRequestContext(SESSION, repo, OPTIONS)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "ORGANIZATION_NOT_FOUND",
    );
  });

  it("throws ORGANIZATION_SUSPENDED when the organization is suspended", async () => {
    const repo = fakeRepo({ user: USER, org: { ...ORG, status: "suspended" } });
    await expect(resolveRequestContext(SESSION, repo, OPTIONS)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "ORGANIZATION_SUSPENDED",
    );
  });

  it("throws MEMBERSHIP_NOT_FOUND when no membership exists", async () => {
    const repo = fakeRepo({ user: USER, org: ORG, membership: null });
    await expect(resolveRequestContext(SESSION, repo, OPTIONS)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "MEMBERSHIP_NOT_FOUND",
    );
  });

  it("throws MEMBERSHIP_NOT_FOUND when the membership is inactive", async () => {
    const repo = fakeRepo({
      user: USER,
      org: ORG,
      membership: { ...MEMBERSHIP, status: "inactive" },
    });
    await expect(resolveRequestContext(SESSION, repo, OPTIONS)).rejects.toSatisfy(
      (e: unknown) => e instanceof AuthError && e.code === "MEMBERSHIP_NOT_FOUND",
    );
  });
});
