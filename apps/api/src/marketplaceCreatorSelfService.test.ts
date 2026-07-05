import {
  createFakeVerifier,
  type IdentityRepository,
  type LinkedResource,
  type OrganizationKind,
  type PermissionKey,
  type VerifiedSession,
} from "@vayada/backend-auth";
import { injectJson } from "@vayada/backend-test";
import type {
  CreatorProfileDocument,
  UpdateCreatorProfileRequest,
} from "@vayada/domain-marketplace";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { MarketplaceCreatorSelfServiceRepository } from "./routes/marketplaceCreatorSelfService.js";

const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
const creatorProfileId = "creator_profile_local";

const session: VerifiedSession = {
  workosUserId: "user_workos_creator",
  workosOrgId: "org_workos_creator_workspace",
  sessionId: "session_creator",
  expiresAt: futureExpiry,
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("marketplace creator self-service routes", () => {
  it("bootstraps a target creator profile when the selected creator workspace has no link", async () => {
    const calls: string[] = [];
    app = buildMarketplaceCreatorApp({
      linkedResources: [],
      repository: {
        async ensureCreatorProfile(input) {
          calls.push(`ensure:${input.organizationId}:${input.ownerUserId}`);
          return { creatorProfileId };
        },
        async getCreatorProfile(input) {
          calls.push(`get:${input.organizationId}:${input.creatorProfileId}`);
          return profileDocument({
            displayName: null,
            locationText: null,
            shortDescription: null,
            platforms: [],
          });
        },
        async updateCreatorProfile() {
          throw new Error("profile status should not update");
        },
      },
    });

    const response = await injectJson<{
      profileComplete: boolean;
      missingFields: string[];
      missingPlatforms: boolean;
    }>(app, {
      method: "GET",
      url: "/api/marketplace/creators/me/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.profileComplete).toBe(false);
    expect(response.body.missingFields).toEqual([
      "displayName",
      "locationText",
      "shortDescription",
      "platforms",
    ]);
    expect(response.body.missingPlatforms).toBe(true);
    expect(calls).toEqual([
      "ensure:org_creator_workspace:user_creator",
      `get:org_creator_workspace:${creatorProfileId}`,
    ]);
  });

  it("uses the existing active creator profile resource link", async () => {
    const calls: string[] = [];
    app = buildMarketplaceCreatorApp({
      repository: {
        async ensureCreatorProfile() {
          throw new Error("existing profile link should not bootstrap");
        },
        async getCreatorProfile(input) {
          calls.push(`${input.organizationId}:${input.creatorProfileId}`);
          return profileDocument({ displayName: "Lina Creator" });
        },
        async updateCreatorProfile() {
          throw new Error("profile read should not update");
        },
      },
    });

    const response = await injectJson<CreatorProfileDocument>(app, {
      method: "GET",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.creatorProfileId).toBe(creatorProfileId);
    expect(response.body.displayName).toBe("Lina Creator");
    expect(calls).toEqual([`org_creator_workspace:${creatorProfileId}`]);
  });

  it("forwards valid profile updates to the target repository", async () => {
    let patch: UpdateCreatorProfileRequest | undefined;
    app = buildMarketplaceCreatorApp({
      repository: {
        async ensureCreatorProfile() {
          throw new Error("existing profile link should not bootstrap");
        },
        async getCreatorProfile() {
          throw new Error("profile write should not read before update");
        },
        async updateCreatorProfile(input) {
          patch = input.patch;
          return profileDocument({
            displayName: input.patch.displayName ?? "Lina Creator",
            platforms: [
              {
                platformId: "platform_instagram",
                platform: "instagram",
                handle: "lina",
                profileUrl: null,
                followerCount: 1200,
                engagementRate: 4.2,
                audienceCountries: [],
                audienceAgeGroups: [],
                audienceGenderSplit: null,
                verificationStatus: "unverified",
              },
            ],
          });
        },
      },
    });

    const response = await injectJson<CreatorProfileDocument>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        displayName: "Lina Creator",
        creatorType: "travel",
        locationText: "Berlin",
        shortDescription: "Travel creator",
        platforms: [
          {
            platform: "instagram",
            handle: "lina",
            followerCount: 1200,
            engagementRate: 4.2,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.displayName).toBe("Lina Creator");
    expect(patch).toMatchObject({
      displayName: "Lina Creator",
      creatorType: "travel",
      locationText: "Berlin",
      shortDescription: "Travel creator",
      platforms: [
        {
          platform: "instagram",
          handle: "lina",
          followerCount: 1200,
          engagementRate: 4.2,
        },
      ],
    });
  });

  it("rejects non-creator selected organizations", async () => {
    app = buildMarketplaceCreatorApp({
      organizationKind: "hotel_group",
      repository: {
        async ensureCreatorProfile() {
          throw new Error("wrong organization kind should not bootstrap");
        },
        async getCreatorProfile() {
          throw new Error("wrong organization kind should not read");
        },
        async updateCreatorProfile() {
          throw new Error("wrong organization kind should not write");
        },
      },
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "GET",
      url: "/api/marketplace/creators/me/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.body.detail).toContain("only available for creators");
  });

  it("does not expose the old root creator self-service path", async () => {
    app = buildMarketplaceCreatorApp({
      repository: {
        async ensureCreatorProfile() {
          throw new Error("root path should not hit repository");
        },
        async getCreatorProfile() {
          throw new Error("root path should not hit repository");
        },
        async updateCreatorProfile() {
          throw new Error("root path should not hit repository");
        },
      },
    });

    const response = await injectJson<{ message: string }>(app, {
      method: "GET",
      url: "/creators/me",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(404);
  });
});

function buildMarketplaceCreatorApp(options: {
  repository: MarketplaceCreatorSelfServiceRepository;
  permissions?: PermissionKey[];
  linkedResources?: LinkedResource[];
  organizationKind?: OrganizationKind;
}): FastifyInstance {
  return buildApp({
    logger: false,
    marketplaceCreatorSelfServiceRepository: options.repository,
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository({
        linkedResources: options.linkedResources,
        organizationKind: options.organizationKind,
      }),
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["marketplace.profile.manage"];
        },
      },
    },
  });
}

function identityRepository(options: {
  linkedResources?: LinkedResource[];
  organizationKind?: OrganizationKind;
}): IdentityRepository {
  return {
    async findUserByProviderUserId() {
      return {
        userId: "user_creator",
        email: "creator@example.com",
        status: "active",
      };
    },
    async findOrganizationByWorkosOrgId() {
      return {
        organizationId: "org_creator_workspace",
        workosOrgId: session.workosOrgId ?? null,
        kind: options.organizationKind ?? "creator_workspace",
        status: "active",
      };
    },
    async findActiveMembership() {
      return {
        membershipId: "membership_creator",
        status: "active",
        roleKey: "creator_owner",
        workosMembershipId: "om_creator",
        workosRoleSlugs: ["creator_owner"],
      };
    },
    async findLinkedResources() {
      return options.linkedResources ?? [creatorProfileLink(creatorProfileId)];
    },
  };
}

function creatorProfileLink(resourceId: string): LinkedResource {
  return {
    product: "marketplace",
    resourceType: "creator_profile",
    resourceId,
    relationship: "owner",
    status: "active",
  };
}

function profileDocument(overrides: Partial<CreatorProfileDocument> = {}): CreatorProfileDocument {
  return {
    creatorProfileId,
    organizationId: "org_creator_workspace",
    sourceCreatorId: null,
    displayName: "Lina Creator",
    creatorType: "lifestyle",
    locationText: "Berlin",
    shortDescription: "Travel creator",
    portfolioUrl: null,
    phone: null,
    profilePictureUrl: null,
    profileComplete: false,
    profileCompletedAt: null,
    profileStatus: "pending",
    platforms: [],
    audienceSize: 0,
    rating: { averageRating: 0, totalReviews: 0 },
    createdAt: "2026-07-05T10:00:00.000Z",
    updatedAt: "2026-07-05T10:00:00.000Z",
    ...overrides,
  };
}
