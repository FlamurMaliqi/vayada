import {
  createFakeVerifier,
  type IdentityRepository,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { PlatformPropertyRetirementImpact } from "@vayada/domain-hotels";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../../app.js";
import { PlatformPropertyLifecycleError } from "../../../domains/platformPropertyLifecycleCommandRepository.js";

const propertyId = "11111111-1111-4111-8111-111111111111";
const accountUserId = "22222222-2222-4222-8222-222222222222";
const session: VerifiedSession = {
  workosUserId: "workos-platform-user",
  workosOrgId: "workos-platform-org",
  sessionId: "platform-session",
  expiresAt: Math.floor(Date.now() / 1_000) + 60,
};

describe("platform property lifecycle routes", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => app?.close());

  it("requires platform read permission and the operator resource before impact access", async () => {
    const target = lifecycleHarness();
    app = buildLifecycleApp(target, { permissions: [] });
    const missingPermission = await injectJson(app, {
      method: "GET",
      url: `/api/platform/admin/properties/${propertyId}/retirement-impact`,
      headers: { authorization: "Bearer platform-token" },
    });
    expect(missingPermission.statusCode).toBe(403);

    await app.close();
    app = buildLifecycleApp(target, { resourceAccess: false });
    const missingResource = await injectJson(app, {
      method: "GET",
      url: `/api/platform/admin/properties/${propertyId}/retirement-impact`,
      headers: { authorization: "Bearer platform-token" },
    });
    expect(missingResource.statusCode).toBe(403);
    expect(target.calls).toHaveLength(0);
  });

  it("returns full impact and explicitly blocks hard deletion", async () => {
    const target = lifecycleHarness();
    app = buildLifecycleApp(target);

    const impact = await injectJson<PlatformPropertyRetirementImpact>(app, {
      method: "GET",
      url: `/api/platform/admin/properties/${propertyId}/retirement-impact`,
      headers: { authorization: "Bearer platform-token" },
    });
    expect(impact.statusCode).toBe(200);
    expect(impact.body).toMatchObject({
      organizations: { linked: 1 },
      entitlements: { active: 2 },
      bookings: { total: 0, active: 0 },
      inventory: { roomTypes: 1, rooms: 3 },
      finance: {
        totalPayments: 0,
        unresolvedPayments: 0,
        totalPayouts: 0,
        openPayouts: 0,
        billingEntitlements: 0,
      },
      media: { objects: 2 },
      hardDeletion: { allowed: false, reason: "hard_delete_not_supported" },
    });

    const deletion = await injectJson(app, {
      method: "DELETE",
      url: `/api/platform/admin/properties/${propertyId}`,
      headers: { authorization: "Bearer platform-token" },
    });
    expect(deletion.statusCode).toBe(409);
    expect(deletion.body).toMatchObject({ code: "hard_delete_not_supported", impact: impact.body });
  });

  it("passes typed status and confirmed retirement commands with request audit", async () => {
    const target = lifecycleHarness();
    app = buildLifecycleApp(target);
    const headers = { authorization: "Bearer platform-token", "idempotency-key": "lifecycle-1" };

    const status = await injectJson(app, {
      method: "PATCH",
      url: `/api/platform/admin/properties/${propertyId}/status`,
      headers,
      payload: {
        expectedLifecycleRevision: 4,
        status: "suspended",
        reason: "Temporary owner hold",
      },
    });
    expect(status.statusCode).toBe(200);
    expect(target.calls.at(-1)).toMatchObject({
      operation: "status",
      propertyId,
      expectedLifecycleRevision: 4,
      idempotencyKey: "lifecycle-1",
      audit: { actorUserId: "platform-user", organizationId: "platform-org" },
    });

    const missingConfirmation = await injectJson(app, {
      method: "POST",
      url: `/api/platform/admin/properties/${propertyId}/retire`,
      headers,
      payload: { expectedLifecycleRevision: 5, reason: "Close property" },
    });
    expect(missingConfirmation.statusCode).toBe(400);

    const retirement = await injectJson(app, {
      method: "POST",
      url: `/api/platform/admin/properties/${propertyId}/retire`,
      headers: { ...headers, "idempotency-key": "retire-1" },
      payload: {
        expectedLifecycleRevision: 5,
        confirmation: "RETIRE",
        reason: "Close property",
      },
    });
    expect(retirement.statusCode).toBe(200);
    expect(target.calls.at(-1)).toMatchObject({ operation: "retire", propertyId });
  });

  it("provisions the intended account with the canonical full profile contract", async () => {
    const target = lifecycleHarness();
    app = buildLifecycleApp(target);
    const response = await injectJson(app, {
      method: "POST",
      url: "/api/platform/admin/properties/provision",
      headers: {
        authorization: "Bearer platform-token",
        "idempotency-key": "provision-1",
      },
      payload: {
        accountUserId,
        provisioningReference: "support-case-1280",
        reason: "Owner requested onboarding",
        profile: completeProfile(),
      },
    });

    expect(response.statusCode).toBe(201);
    expect(target.calls.at(-1)).toMatchObject({
      operation: "provision",
      accountUserId,
      provisioningReference: "support-case-1280",
      reason: "Owner requested onboarding",
      idempotencyKey: "provision-1",
    });
  });

  it("returns actionable retirement blockers and current revision conflicts", async () => {
    const target = lifecycleHarness({ commandError: "retirement_blocked" });
    app = buildLifecycleApp(target);
    const response = await injectJson(app, {
      method: "POST",
      url: `/api/platform/admin/properties/${propertyId}/retire`,
      headers: {
        authorization: "Bearer platform-token",
        "idempotency-key": "retire-blocked",
      },
      payload: {
        expectedLifecycleRevision: 4,
        confirmation: "RETIRE",
        reason: "Close property",
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: "retirement_blocked",
      impact: { blockers: [{ code: "active_bookings", count: 1 }] },
    });
  });
});

function buildLifecycleApp(
  target: ReturnType<typeof lifecycleHarness>,
  options: { permissions?: PermissionKey[]; resourceAccess?: boolean } = {},
) {
  return buildApp({
    logger: false,
    platformPropertyLifecycle: target.repositories,
    auth: {
      verifier: createFakeVerifier(new Map([["platform-token", session]])),
      repository: identityRepository(options.resourceAccess !== false),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["platform.admin.read", "platform.property.status.manage"];
        },
      },
    },
  });
}

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

function lifecycleHarness(options: { commandError?: "retirement_blocked" } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const impact = makeImpact(options.commandError ? 1 : 0);
  const close = async () => {};
  return {
    calls,
    repositories: {
      impactRepository: {
        async getRetirementImpact(id: string) {
          calls.push({ operation: "impact", id });
          return impact;
        },
        close,
      },
      commandRepository: {
        async changeStatus(input: Record<string, unknown>) {
          calls.push({ operation: "status", ...input });
          return {
            contractVersion: "platform-property-lifecycle.v1",
            propertyId,
            lifecycleStatus: "suspended",
            lifecycleRevision: 5,
          } as const;
        },
        async retire(input: Record<string, unknown>) {
          calls.push({ operation: "retire", ...input });
          if (options.commandError)
            throw new PlatformPropertyLifecycleError(options.commandError, undefined, impact);
          return {
            contractVersion: "platform-property-lifecycle.v1",
            propertyId,
            lifecycleStatus: "retired",
            lifecycleRevision: 6,
          } as const;
        },
        close,
      },
      provisioningRepository: {
        async provision(input: Record<string, unknown>) {
          calls.push({ operation: "provision", ...input });
          return {
            contractVersion: "platform-property-lifecycle.v1",
            propertyId,
            lifecycleStatus: "provisioning",
            lifecycleRevision: 1,
          } as const;
        },
        close,
      },
    },
  };
}

function makeImpact(activeBookings: number): PlatformPropertyRetirementImpact {
  return {
    contractVersion: "platform-property-lifecycle.v1",
    propertyId,
    lifecycleStatus: "active",
    lifecycleRevision: 4,
    organizations: { linked: 1 },
    entitlements: { active: 2, suspended: 0 },
    bookings: { total: activeBookings, active: activeBookings },
    inventory: { roomTypes: 1, rooms: 3 },
    finance: {
      totalPayments: 0,
      unresolvedPayments: 0,
      totalPayouts: 0,
      openPayouts: 0,
      billingEntitlements: 0,
    },
    media: { objects: 2 },
    publicExposure: {
      marketplaceActive: true,
      distributionStatus: "public",
      bookingRevisionActive: true,
    },
    blockers: activeBookings
      ? [
          {
            code: "active_bookings",
            ownerDomain: "booking",
            count: activeBookings,
            message: "Resolve active bookings.",
          },
        ]
      : [],
    canRetire: activeBookings === 0,
    hardDeletion: { allowed: false, reason: "hard_delete_not_supported" },
  };
}

function completeProfile() {
  return {
    displayName: "Hotel Lifecycle",
    propertyType: "hotel",
    location: {
      streetAddress: "1 Test Street",
      postalCode: "10000",
      city: "Athens",
      countryCode: "GR",
      timezone: "Europe/Athens",
      latitude: null,
      longitude: null,
      localityPublic: true,
      geoPublic: false,
      mapDisplayMode: "approximate",
    },
    contacts: [
      { channelType: "email", value: "hotel@example.com", purpose: "general", isPublic: true },
      { channelType: "phone", value: "+302100000000", purpose: "operations", isPublic: false },
    ],
  };
}
