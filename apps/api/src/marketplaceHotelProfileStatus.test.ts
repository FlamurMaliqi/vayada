import {
  createFakeVerifier,
  type LinkedResource,
  type IdentityRepository,
  type PermissionKey,
  type ProductEntitlement,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type { FastifyInstance } from "fastify";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import type {
  HotelProfileStatusResponse,
  MarketplaceHotelProfileStatusRepository,
} from "./routes/marketplaceHotelProfileStatus.js";
import { createPgMarketplaceHotelProfileStatusRepository } from "./routes/marketplaceHotelProfileStatus.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const hotelProfileResourceId = "profile_property_id";

const session: VerifiedSession = {
  workosUserId: "user_workos_hotel_owner",
  workosOrgId: "org_workos_hotel_group",
  sessionId: "session_hotel_owner",
  expiresAt: futureExpiry,
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("marketplace hotel profile status route", () => {
  it("serves the target hotel profile-status path from the selected hotel group", async () => {
    const calls: string[] = [];
    app = buildMarketplaceHotelProfileStatusApp({
      repository: {
        async getHotelProfileStatus(input) {
          calls.push(`${input.organizationId}:${input.profileResourceId}`);
          return {
            profile_complete: true,
            missing_fields: [],
            has_defaults: { location: false },
            missing_offers: false,
            completion_steps: [],
          };
        },
      },
    });

    const response = await injectJson<HotelProfileStatusResponse>(app, {
      method: "GET",
      url: `/api/marketplace/properties/${hotelProfileResourceId}/profile-status`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.profile_complete).toBe(true);
    expect(response.body.missing_offers).toBe(false);
    expect(calls).toEqual([`org_hotel_group:${hotelProfileResourceId}`]);
  });

  it("returns incomplete instead of 404 when the hotel profile row is missing", async () => {
    app = buildMarketplaceHotelProfileStatusApp({
      repository: {
        async getHotelProfileStatus() {
          return null;
        },
      },
    });

    const response = await injectJson<HotelProfileStatusResponse>(app, {
      method: "GET",
      url: "/api/marketplace/hotels/me/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      profile_complete: false,
      missing_fields: ["profile"],
      missing_offers: true,
    });
  });

  it("does not expose the old root profile-status path", async () => {
    app = buildMarketplaceHotelProfileStatusApp({
      repository: {
        async getHotelProfileStatus() {
          throw new Error("root path should not hit the repository");
        },
      },
    });

    const response = await injectJson<{ message: string }>(app, {
      method: "GET",
      url: "/hotels/me/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects hotel users without an active hotel profile resource link", async () => {
    app = buildMarketplaceHotelProfileStatusApp({
      linkedResources: [],
      repository: {
        async getHotelProfileStatus() {
          throw new Error("missing profile link should not hit the repository");
        },
      },
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "GET",
      url: "/api/marketplace/hotels/me/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.detail).toContain("hotel profile resource link");
  });

  it("rejects ambiguous active hotel profile resource links", async () => {
    app = buildMarketplaceHotelProfileStatusApp({
      linkedResources: [hotelProfileLink("first_profile"), hotelProfileLink("second_profile")],
      repository: {
        async getHotelProfileStatus() {
          throw new Error("ambiguous profile link should not hit the repository");
        },
      },
    });

    const response = await injectJson<{ code: string }>(app, {
      method: "GET",
      url: "/api/marketplace/hotels/me/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe("ambiguous_marketplace_hotel_profile");
  });

  it("allows multiple relationships to the same active hotel profile resource", async () => {
    app = buildMarketplaceHotelProfileStatusApp({
      linkedResources: [
        hotelProfileLink(hotelProfileResourceId, "owner"),
        hotelProfileLink(hotelProfileResourceId, "operator"),
      ],
      repository: {
        async getHotelProfileStatus() {
          return {
            profile_complete: true,
            missing_fields: [],
            has_defaults: { location: false },
            missing_offers: false,
            completion_steps: [],
          };
        },
      },
    });

    const response = await injectJson<HotelProfileStatusResponse>(app, {
      method: "GET",
      url: "/api/marketplace/hotels/me/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.profile_complete).toBe(true);
  });

  it("selects an explicit property when the account has multiple hotel profiles", async () => {
    const calls: string[] = [];
    app = buildMarketplaceHotelProfileStatusApp({
      linkedResources: [hotelProfileLink("property-one"), hotelProfileLink("property-two")],
      repository: {
        async getHotelProfileStatus(input) {
          calls.push(input.profileResourceId);
          return {
            profile_complete: true,
            missing_fields: [],
            has_defaults: { location: false },
            missing_offers: false,
            completion_steps: [],
          };
        },
      },
    });

    const response = await injectJson<HotelProfileStatusResponse>(app, {
      method: "GET",
      url: "/api/marketplace/properties/property-two/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(["property-two"]);
  });

  it("rejects profile status while Marketplace access is suspended", async () => {
    app = buildMarketplaceHotelProfileStatusApp({
      entitlements: [
        { product: "marketplace", key: "marketplace-hotel-profile", status: "suspended" },
      ],
      repository: {
        async getHotelProfileStatus() {
          throw new Error("suspended access should not hit the repository");
        },
      },
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "GET",
      url: `/api/marketplace/properties/${hotelProfileResourceId}/profile-status`,
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
  });

  it("queries profile status inside the authorized profile resource scope", async () => {
    const query = vi.fn(async (_text: string, _values?: readonly unknown[]) => ({
      rows: [{ profileComplete: true, hasOffers: true }],
    }));
    const pool = {
      query: async <T extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[],
      ) => {
        const result = await query(text, values);
        return { rows: result.rows as unknown as T[] };
      },
      end: vi.fn(async () => undefined),
    };
    const repository = createPgMarketplaceHotelProfileStatusRepository({
      connectionString: "postgresql://target-db",
      pool,
    });

    await expect(
      repository.getHotelProfileStatus({
        organizationId: "org_hotel_group",
        profileResourceId: hotelProfileResourceId,
      }),
    ).resolves.toMatchObject({
      profile_complete: true,
      missing_offers: false,
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("profile.property_id::text"), [
      "org_hotel_group",
      hotelProfileResourceId,
    ]);
  });
});

function buildMarketplaceHotelProfileStatusApp(options: {
  repository: MarketplaceHotelProfileStatusRepository;
  permissions?: PermissionKey[];
  linkedResources?: LinkedResource[];
  entitlements?: ProductEntitlement[];
}): FastifyInstance {
  return buildApp({
    logger: false,
    marketplaceHotelProfileStatusRepository: options.repository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository(options.linkedResources),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["marketplace.profile.manage"];
        },
      },
      entitlementRepository: {
        async findEntitlementsForContext() {
          return (
            options.entitlements ?? [
              {
                product: "marketplace",
                key: "marketplace-hotel-profile",
                status: "active",
              },
            ]
          );
        },
      },
    },
  });
}

function identityRepository(linkedResources?: LinkedResource[]): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_hotel_owner",
        email: "owner@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "org_hotel_group",
        workosOrgId: session.workosOrgId ?? null,
        kind: "hotel_group",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_hotel_owner",
        status: "active",
        roleKey: "hotel_owner",
        workosMembershipId: "om_hotel_owner",
        workosRoleSlugs: ["hotel_owner"],
      };
    },
    async findLinkedResources() {
      return linkedResources ?? [hotelProfileLink(hotelProfileResourceId)];
    },
  };
}

function hotelProfileLink(
  resourceId: string,
  relationship: LinkedResource["relationship"] = "owner",
): LinkedResource {
  return {
    product: "marketplace",
    resourceType: "hotel_profile",
    resourceId,
    relationship,
    status: "active",
  };
}
