import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../../app.js";
import { agencyPropertyAccessRepository } from "../../../testAuthorization.js";

const session: VerifiedSession = {
  workosUserId: "workos-platform-user",
  workosOrgId: "workos-platform-org",
  sessionId: "platform-session",
  expiresAt: Math.floor(Date.now() / 1_000) + 60,
};
const userId = "95500000-0000-4000-8000-000000000001";
const orgId = "95500000-0000-4000-8000-000000000002";
const url = `/api/platform/admin/users/${userId}/marketplace-accounts/${orgId}/activate`;
let app: ReturnType<typeof buildApp>;
afterEach(async () => {
  await app?.close();
});
function harness(
  permissions: PermissionKey[] = ["platform.admin.read", "platform.property.status.manage"],
  linked = true,
) {
  const updateTracks = vi.fn().mockResolvedValue({
    ok: true,
    response: {
      trackRevision: 2,
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      tracks: [],
    },
  });
  app = buildApp({
    logger: false,
    platformMarketplaceActivation: {
      accounts: { list: async () => [], close: async () => {} },
      tracks: { updateTracks },
    },
    auth: {
      verifier: createFakeVerifier(new Map([["platform-token", session]])),
      repository: identityRepository(linked),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return permissions;
        },
      },
    },
  });
  return updateTracks;
}
const payload = {
  expectedRevision: 1,
  selectedTracks: ["hotel_operations", "creator_marketplace"],
};
const headers = { authorization: "Bearer platform-token", "idempotency-key": "enable-955" };
describe("platform Marketplace activation", () => {
  it.each([undefined, "Bearer invalid"])(
    "rejects missing/invalid authentication",
    async (authorization) => {
      const calls = harness();
      const response = await app.inject({
        method: "POST",
        url,
        payload,
        headers: authorization ? { ...headers, authorization } : { "idempotency-key": "enable" },
      });
      expect(response.statusCode).toBe(401);
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it.each([
    {
      permissions: ["platform.admin.read", "platform.user.suspend"] as PermissionKey[],
      linked: true,
    },
    { permissions: ["platform.property.status.manage"] as PermissionKey[], linked: false },
  ])(
    "does not use moderation permission or missing platform resources",
    async ({ permissions, linked }) => {
      const calls = harness(permissions, linked);
      const response = await app.inject({ method: "POST", url, payload, headers });
      expect(response.statusCode).toBe(403);
      expect(calls).not.toHaveBeenCalled();
    },
  );
  it("passes explicit account and platform actor scope to the audited track command", async () => {
    const calls = harness();
    const response = await app.inject({ method: "POST", url, payload, headers });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        expectedRevision: 1,
        selectedTracks: payload.selectedTracks,
        idempotencyKey: "enable-955",
        actorUserId: "platform-user",
        adminActivation: {
          accountUserId: userId,
          platformOrganizationId: "platform-org",
          actorUserId: "platform-user",
        },
      }),
    );
  });
  it("requires Marketplace intent and a stable retry key", async () => {
    const calls = harness();
    for (const request of [
      { payload: { ...payload, selectedTracks: ["hotel_operations"] }, headers },
      { payload, headers: { authorization: headers.authorization } },
    ]) {
      const response = await app.inject({ method: "POST", url, ...request });
      expect(response.statusCode).toBe(400);
    }
    expect(calls).not.toHaveBeenCalled();
  });
});

function identityRepository(resourceAccess: boolean): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return { userId: "platform-user", email: "admin@vayada.com", status: "active" };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "platform-org",
        workosOrgId: "workos-platform-org",
        kind: "platform",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "platform-membership",
        status: "active",
        roleKey: "platform_admin",
        workosMembershipId: "workos-platform-membership",
        workosRoleSlugs: ["platform_admin"],
      };
    },
    async findLinkedResources() {
      return resourceAccess
        ? [
            {
              product: "platform",
              resourceType: "platform",
              resourceId: "vayada",
              relationship: "operator",
              status: "active",
            },
          ]
        : [];
    },
  };
}
