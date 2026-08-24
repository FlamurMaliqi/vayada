import {
  createFakeVerifier,
  type IdentityLifecycleCommand,
  type IdentityLifecycleCommandBus,
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
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { agencyPropertyAccessRepository } from "./testAuthorization.js";
import {
  createPgMarketplaceCreatorSelfServiceRepository,
  type MarketplaceCreatorProfileMediaRepository,
  type MarketplaceCreatorSelfServiceRepository,
} from "./routes/marketplaceCreatorSelfService.js";
import type { PlatformMediaObjectRecord } from "./routes/platformMedia.js";

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
    const lifecycleCommandBus = createRecordingCommandBus();
    app = buildMarketplaceCreatorApp({
      linkedResources: [],
      lifecycleCommandBus,
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
      "profilePicture",
      "platforms",
    ]);
    expect(response.body.missingPlatforms).toBe(true);
    expect(calls).toEqual([
      "ensure:org_creator_workspace:user_creator",
      `get:org_creator_workspace:${creatorProfileId}`,
    ]);
    expect(lifecycleCommandBus.commands).toEqual([
      expect.objectContaining({
        commandType: "identity.access.grant",
        idempotencyKey: `marketplace-creator-profile:org_creator_workspace:${creatorProfileId}:owner`,
        payload: expect.objectContaining({
          userId: "user_creator",
          membership: expect.objectContaining({ propertyAccessMode: "assigned" }),
          resourceLinks: [
            {
              organizationId: "org_creator_workspace",
              product: "marketplace",
              resourceType: "creator_profile",
              resourceId: creatorProfileId,
              relationship: "owner",
              status: "active",
            },
          ],
        }),
      }),
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

  it("always reports a missing approved profile photo", async () => {
    app = buildMarketplaceCreatorApp({
      repository: {
        async ensureCreatorProfile() {
          throw new Error("existing profile link should not bootstrap");
        },
        async getCreatorProfile() {
          return profileDocument({
            profileComplete: false,
            profilePictureUrl: "https://cdn.example.com/unowned.jpg",
            profilePictureMediaObjectId: "media_not_owned",
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
        async updateCreatorProfile() {
          throw new Error("profile status should not update");
        },
      },
    });

    const response = await injectJson<{
      profilePhotoRequired: boolean;
      profileComplete: boolean;
      missingFields: string[];
      completionSteps: string[];
    }>(app, {
      method: "GET",
      url: "/api/marketplace/creators/me/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.profilePhotoRequired).toBe(true);
    expect(response.body.profileComplete).toBe(false);
    expect(response.body.missingFields).toContain("profilePicture");
    expect(response.body.completionSteps).toContain("add_profile_picture");
  });

  it("always reports a missing phone before a creator profile can be complete", async () => {
    app = buildMarketplaceCreatorApp({
      repository: {
        async ensureCreatorProfile() {
          throw new Error("existing profile link should not bootstrap");
        },
        async getCreatorProfile() {
          return profileDocument({
            phone: null,
            profilePictureUrl: "https://media.example.test/creator.webp",
            profilePictureMediaObjectId: "media_creator_profile",
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
        async updateCreatorProfile() {
          throw new Error("profile status should not update");
        },
      },
    });

    const response = await injectJson<{
      profileComplete: boolean;
      missingFields: string[];
      completionSteps: string[];
    }>(app, {
      method: "GET",
      url: "/api/marketplace/creators/me/profile-status",
      headers: { authorization: "Bearer valid-token" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body.profileComplete).toBe(false);
    expect(response.body.missingFields).toEqual(["phone"]);
    expect(response.body.completionSteps).toEqual(["add_phone"]);
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
        profilePictureMediaObjectId: "media_creator_profile_owned",
        platforms: [
          {
            platformId: null,
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
      profilePictureMediaObjectId: "media_creator_profile_owned",
      profilePictureUrl: "https://media.example/creator-profile.png",
      platforms: [
        {
          platformId: null,
          platform: "instagram",
          handle: "lina",
          followerCount: 1200,
          engagementRate: 4.2,
        },
      ],
    });
  });

  it("rejects raw profile updates that inflate connected provider metrics", async () => {
    const target = creatorPlatformRepositoryTarget(
      ["platform-1"],
      [
        {
          platformId: "platform-1",
          platform: "instagram",
          importedFields: ["followerCount", "engagementRate"],
        },
      ],
    );
    const repository = createPgMarketplaceCreatorSelfServiceRepository({
      connectionString: "postgres://unused",
      pool: target.pool as never,
    });
    app = buildMarketplaceCreatorApp({ repository });

    const response = await injectJson<{ code: string; detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        platforms: [
          {
            platformId: "platform-1",
            platform: "instagram",
            handle: "lina",
            followerCount: 9_999_999,
            engagementRate: 99,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({
      code: "profile_conflict",
      detail: expect.stringContaining("Synced platform data"),
    });
    expect(
      target.queries.some((query) =>
        query.text.trim().startsWith("UPDATE marketplace.creator_platforms"),
      ),
    ).toBe(false);
  });

  it("rejects profile picture URLs without an issued media object", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        profilePictureUrl: "https://example.invalid/unowned.png",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.detail).toBe("A verified profile picture media object is required");
  });

  it("reuses the current user's identity profile image across organizations", async () => {
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
            profilePictureUrl: input.patch.profilePictureUrl ?? null,
            profilePictureMediaObjectId: input.patch.profilePictureMediaObjectId ?? null,
          });
        },
      },
      mediaRepository: {
        persistent: true,
        publicCdnBaseUrl: "https://media.example/",
        async findMediaObject(mediaId) {
          return profileMediaObject({
            mediaId,
            ownerOrganizationId: "org_hotel_workspace",
          });
        },
      },
    });

    const response = await injectJson<CreatorProfileDocument>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: { profilePictureMediaObjectId: "media_identity_from_hotel_workspace" },
    });

    expect(response.statusCode).toBe(200);
    expect(patch).toMatchObject({
      profilePictureMediaObjectId: "media_identity_from_hotel_workspace",
      profilePictureUrl: "https://media.example/creator-profile.png",
    });
  });

  it("keeps creator-profile media scoped to its owning organization", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
      mediaRepository: {
        persistent: true,
        publicCdnBaseUrl: "https://media.example/",
        async findMediaObject(mediaId) {
          return profileMediaObject({
            mediaId,
            purpose: "marketplace.creator.profile_image",
            ownerOrganizationId: "org_other_creator_workspace",
            resourceProduct: "marketplace",
            resourceType: "creator_profile",
            resourceId: creatorProfileId,
          });
        },
      },
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: { profilePictureMediaObjectId: "media_other_creator_workspace" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.detail).toBe(
      "Profile picture media must be an owned, approved public image upload",
    );
  });

  it("clears the stored picture URL and media link together", async () => {
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
          return profileDocument();
        },
      },
    });

    const response = await injectJson<CreatorProfileDocument>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: { profilePictureUrl: null },
    });

    expect(response.statusCode).toBe(200);
    expect(patch).toEqual({ profilePictureUrl: null, profilePictureMediaObjectId: null });
  });

  it("rejects staging storage keys as creator profile picture URLs", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        profilePictureUrl: "staging/00000000-0000-4000-8000-000000000001/1/active/profile.png",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.detail).toBe("profilePictureUrl must be an absolute https URL");
  });

  it("rejects creator profile media that was not issued to the current creator", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        profilePictureMediaObjectId: "media_not_owned",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.detail).toBe(
      "Profile picture media must be an owned, approved public image upload",
    );
  });

  it("rejects owned creator media until it has a public variant", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        profilePictureMediaObjectId: "media_creator_profile_staged",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.detail).toBe(
      "Profile picture media must be an owned, approved public image upload",
    );
  });

  it("gates profile photo updates when persistent media validation is unavailable", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
      disableProfileMediaRepository: true,
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        profilePictureMediaObjectId: "media_creator_profile_owned",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body.detail).toBe("Profile picture validation is temporarily unavailable");
  });

  it("maps media repository failures to temporary validation unavailability", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
      mediaRepository: {
        persistent: true,
        publicCdnBaseUrl: "https://media.example/",
        async findMediaObject() {
          throw new Error("database unavailable");
        },
      },
    });

    const response = await injectJson<{ code: string; detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        profilePictureMediaObjectId: "media_creator_profile_owned",
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      code: "media_validation_unavailable",
      detail: "Profile picture validation is temporarily unavailable",
    });
  });

  it("rejects creator profile updates with too many platforms", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        platforms: Array.from({ length: 21 }, (_, index) => ({
          platform: "instagram",
          handle: `creator${index}`,
          followerCount: 1200,
          engagementRate: 4.2,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.detail).toBe("platforms must contain at most 20 entries");
  });

  it("rejects duplicate creator platform IDs", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        platforms: ["instagram", "youtube"].map((platform) => ({
          platformId: "platform-shared",
          platform,
          handle: "creator",
          followerCount: 1200,
          engagementRate: 4.2,
        })),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.detail).toBe("platforms[1].platformId must be unique");
  });

  it("requires a profile link for custom creator platforms", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        platforms: [
          {
            platform: "other",
            handle: "LinkedIn",
            followerCount: 1200,
            engagementRate: 4.2,
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.detail).toBe("platforms[0].profileUrl is required when platform is other");
  });

  it("rejects creator profile updates with too many audience entries", async () => {
    app = buildMarketplaceCreatorApp({
      repository: repositoryThatShouldNotBeCalled(),
    });

    const response = await injectJson<{ detail: string }>(app, {
      method: "PUT",
      url: "/api/marketplace/creators/me",
      headers: { authorization: "Bearer valid-token" },
      payload: {
        platforms: [
          {
            platform: "instagram",
            handle: "creator",
            followerCount: 1200,
            engagementRate: 4.2,
            audienceCountries: Array.from({ length: 51 }, (_, index) => ({
              country: `Country ${index}`,
              percentage: 1,
            })),
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body.detail).toBe(
      "platforms[0].audienceCountries must contain at most 50 entries",
    );
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

describe("marketplace creator platform persistence", () => {
  it("updates stable IDs, creates explicit new rows, and deletes only omitted rows", async () => {
    const target = creatorPlatformRepositoryTarget(["platform-1", "platform-removed"]);
    const repository = createPgMarketplaceCreatorSelfServiceRepository({
      connectionString: "postgres://unused",
      pool: target.pool as never,
    });

    await repository.updateCreatorProfile({
      organizationId: "org_creator_workspace",
      creatorProfileId,
      patch: {
        platforms: [
          {
            platformId: "platform-1",
            platform: "instagram",
            handle: "lina",
            followerCount: 1500,
            engagementRate: 4.5,
          },
          {
            platformId: null,
            platform: "youtube",
            handle: "lina-travels",
            followerCount: 800,
            engagementRate: 3.2,
            audienceCountries: [],
            audienceAgeGroups: [],
            audienceGenderSplit: null,
          },
        ],
      },
    });

    const update = target.queries.find((query) =>
      query.text.trim().startsWith("UPDATE marketplace.creator_platforms"),
    );
    expect(update?.text).toContain("verification_status = CASE");
    expect(update?.text).toContain("verification_status = 'verified'");
    expect(update?.text).not.toMatch(/source_system\s*=/);
    expect(update?.text).not.toMatch(/source_platform_id\s*=/);
    expect(update?.text).not.toMatch(/platform_metadata\s*=/);
    expect(update?.values?.slice(6, 14)).toEqual([
      false,
      null,
      false,
      "[]",
      false,
      "[]",
      false,
      "{}",
    ]);

    const insert = target.queries.find((query) =>
      query.text.trim().startsWith("INSERT INTO marketplace.creator_platforms"),
    );
    expect(insert).toBeDefined();
    const deletion = target.queries.find((query) =>
      query.text.trim().startsWith("DELETE FROM marketplace.creator_platforms"),
    );
    expect(deletion?.values?.[2]).toEqual(["platform-1", "platform-new-1"]);
  });

  it("persists and reads completeness through the shared profile policy", async () => {
    const target = creatorPlatformRepositoryTarget(["platform-1"]);
    const repository = createPgMarketplaceCreatorSelfServiceRepository({
      connectionString: "postgres://unused",
      pool: target.pool as never,
    });

    const profile = await repository.updateCreatorProfile({
      organizationId: "org_creator_workspace",
      creatorProfileId,
      patch: { displayName: "Lina Creator" },
    });

    expect(profile?.profileComplete).toBe(false);
    const completion = target.queries.find((query) => query.text.includes("WITH completion AS"));
    expect(completion?.text).toMatch(
      /marketplace\.creator_profile_is_complete\(\s*\$1::uuid,\s*\$2::uuid\s*\)/,
    );
    expect(completion?.text).toContain("WHERE profile.id = $1::uuid");
    expect(completion?.text).toContain("profile.organization_id = $2::uuid");
    expect(completion?.values).toEqual([creatorProfileId, "org_creator_workspace"]);

    const profileRead = target.queries.find(
      (query) =>
        query.text.includes("LEFT JOIN LATERAL") && query.text.includes("profile_complete"),
    );
    expect(profileRead?.text).toMatch(
      /marketplace\.creator_profile_is_complete\(\s*profile\.id,\s*profile\.organization_id\s*\)/,
    );
    expect(profileRead?.values).toEqual([creatorProfileId, "org_creator_workspace"]);
  });

  it("preserves omitted optional fields and supports explicit clears", async () => {
    const target = creatorPlatformRepositoryTarget(["platform-1"]);
    const repository = createPgMarketplaceCreatorSelfServiceRepository({
      connectionString: "postgres://unused",
      pool: target.pool as never,
    });

    await repository.updateCreatorProfile({
      organizationId: "org_creator_workspace",
      creatorProfileId,
      patch: {
        platforms: [
          {
            platformId: "platform-1",
            platform: "instagram",
            handle: "lina",
            profileUrl: null,
            followerCount: 1200,
            engagementRate: 4.2,
            audienceCountries: [],
            audienceAgeGroups: [],
            audienceGenderSplit: null,
          },
        ],
      },
    });

    const update = target.queries.find((query) =>
      query.text.trim().startsWith("UPDATE marketplace.creator_platforms"),
    );
    expect(update?.values?.slice(6, 14)).toEqual([true, null, true, "[]", true, "[]", true, "{}"]);
  });

  it("rolls back legacy snapshots and unknown IDs before mutating platform rows", async () => {
    for (const platforms of [
      [
        {
          platform: "instagram" as const,
          handle: "legacy",
          followerCount: 1200,
          engagementRate: 4.2,
        },
      ],
      [
        {
          platformId: "platform-foreign",
          platform: "instagram" as const,
          handle: "foreign",
          followerCount: 1200,
          engagementRate: 4.2,
        },
      ],
    ]) {
      const target = creatorPlatformRepositoryTarget(["platform-1"]);
      const repository = createPgMarketplaceCreatorSelfServiceRepository({
        connectionString: "postgres://unused",
        pool: target.pool as never,
      });

      await expect(
        repository.updateCreatorProfile({
          organizationId: "org_creator_workspace",
          creatorProfileId,
          patch: { platforms },
        }),
      ).rejects.toThrow(/refresh|changed/);

      expect(
        target.queries.filter((query) =>
          /^(UPDATE|INSERT INTO|DELETE FROM) marketplace\.creator_platforms/.test(
            query.text.trim(),
          ),
        ),
      ).toHaveLength(0);
      expect(target.queries.some((query) => query.text === "ROLLBACK")).toBe(true);
    }
  });

  it("requires the disconnect route before a connected account can be removed", async () => {
    const target = creatorPlatformRepositoryTarget(
      ["platform-1"],
      [{ platformId: "platform-1", platform: "instagram" }],
    );
    const repository = createPgMarketplaceCreatorSelfServiceRepository({
      connectionString: "postgres://unused",
      pool: target.pool as never,
    });

    await expect(
      repository.updateCreatorProfile({
        organizationId: "org_creator_workspace",
        creatorProfileId,
        patch: { platforms: [] },
      }),
    ).rejects.toThrow("Disconnect a connected account");

    expect(
      target.queries.some((query) =>
        query.text.trim().startsWith("DELETE FROM marketplace.creator_platforms"),
      ),
    ).toBe(false);
  });
});

function creatorPlatformRepositoryTarget(
  existingPlatformIds: string[],
  connectedPlatforms: Array<{
    platformId: string;
    platform: "instagram";
    importedFields?: string[];
  }> = [],
) {
  const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
  let insertedPlatformCount = 0;
  let persistedProfileComplete = false;
  const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
    queries.push({ text, values });
    const normalized = text.trim();
    if (
      normalized.startsWith('SELECT id::text AS "platformId"') &&
      normalized.includes("FROM marketplace.creator_platforms")
    ) {
      return {
        rows: existingPlatformIds.map((platformId) => ({
          platformId,
          platform: "instagram",
          handle: "lina",
          profileUrl: null,
          profileUrlImported: false,
          followerCount: 1_500,
          engagementRate: 4.5,
          audienceCountries: [],
          audienceAgeGroups: [],
          audienceGenderSplit: {},
        })),
      };
    }
    if (
      normalized.startsWith('SELECT platform_id::text AS "platformId"') &&
      normalized.includes("FROM marketplace.creator_platform_connections")
    ) {
      return {
        rows: connectedPlatforms.map((platform) => ({
          ...platform,
          importedFields: platform.importedFields ?? [],
        })),
      };
    }
    if (normalized.startsWith("UPDATE marketplace.creator_platforms")) {
      const platformId = String(values?.[14] ?? "");
      return {
        rows: existingPlatformIds.includes(platformId) ? [{ platformId }] : [],
      };
    }
    if (normalized.startsWith("INSERT INTO marketplace.creator_platforms")) {
      insertedPlatformCount += 1;
      return { rows: [{ platformId: `platform-new-${insertedPlatformCount}` }] };
    }
    if (normalized.startsWith("WITH completion AS")) {
      persistedProfileComplete = false;
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT") && normalized.includes("LEFT JOIN LATERAL")) {
      return {
        rows: [
          {
            creatorProfileId,
            organizationId: "org_creator_workspace",
            sourceCreatorId: null,
            displayName: "Lina Creator",
            creatorType: "travel",
            locationText: "Berlin",
            shortDescription: "Travel creator",
            portfolioUrl: null,
            phone: "+49 30 123456",
            profilePictureUrl: null,
            profilePictureMediaObjectId: null,
            profileComplete: false,
            profileCompletedAt: persistedProfileComplete ? "2026-07-05T10:00:00.000Z" : null,
            profileStatus: "pending",
            platforms: [],
            averageRating: 0,
            totalReviews: 0,
            createdAt: "2026-07-05T10:00:00.000Z",
            updatedAt: "2026-07-05T10:00:00.000Z",
          },
        ],
      };
    }
    if (normalized.startsWith("SELECT id") && normalized.includes("creator_profiles")) {
      return { rows: [{ id: creatorProfileId }] };
    }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  return {
    queries,
    pool: {
      query,
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    },
  };
}

function buildMarketplaceCreatorApp(options: {
  repository: MarketplaceCreatorSelfServiceRepository;
  disableProfileMediaRepository?: boolean;
  mediaRepository?: MarketplaceCreatorProfileMediaRepository;
  lifecycleCommandBus?: IdentityLifecycleCommandBus;
  permissions?: PermissionKey[];
  linkedResources?: LinkedResource[];
  organizationKind?: OrganizationKind;
}): FastifyInstance {
  return buildApp({
    logger: false,
    marketplaceCreatorSelfServiceRepository: options.repository,
    ...(options.disableProfileMediaRepository
      ? {}
      : {
          marketplaceCreatorProfileMediaRepository: options.mediaRepository ?? {
            persistent: true,
            publicCdnBaseUrl: "https://media.example/",
            async findMediaObject(mediaId: string) {
              if (mediaId === "media_creator_profile_owned") return profileMediaObject();
              if (mediaId === "media_creator_profile_staged") {
                return profileMediaObject({
                  mediaId,
                  visibility: "private",
                  approvalStatus: "pending_domain_approval",
                  lifecycleStatus: "staged",
                  storageKey: "staging/session/1/active/profile.png",
                  variants: [
                    {
                      variantName: "original_safe" as const,
                      visibility: "private" as const,
                      storageKey: "staging/session/1/variants/original_safe",
                      contentType: "image/png",
                      sizeBytes: 1024,
                      publicCdnUrl: null,
                    },
                  ],
                });
              }
              if (mediaId === "media_not_owned") {
                return profileMediaObject({ mediaId, actorUserId: "user_other_creator" });
              }
              return null;
            },
          },
        }),
    identityLifecycleCommandBus: options.lifecycleCommandBus ?? createRecordingCommandBus(),
    auth: {
      verifier: createFakeVerifier(new Map([["valid-token", session]])),
      repository: identityRepository({
        linkedResources: options.linkedResources,
        organizationKind: options.organizationKind,
      }),
      propertyAccessRepository: agencyPropertyAccessRepository,
      rolePermissionRepository: {
        async findPermissionsForRole() {
          return options.permissions ?? ["marketplace.profile.manage"];
        },
      },
    },
  });
}

function profileMediaObject(
  overrides: Partial<PlatformMediaObjectRecord> = {},
): PlatformMediaObjectRecord {
  return {
    mediaId: "media_creator_profile_owned",
    purpose: "identity.user.profile_image",
    visibility: "public",
    requestedVisibility: "public",
    approvalStatus: "approved",
    lifecycleStatus: "active",
    storageKind: "vayada_managed",
    bucket: "vayada-media-local",
    storageKey: "public/users/user_creator/profile.png",
    ownerOrganizationId: "org_creator_workspace",
    actorUserId: "user_creator",
    resourceProduct: "platform",
    resourceType: "user_profile",
    resourceId: "user_creator",
    contentType: "image/png",
    sizeBytes: 1024,
    originalFilename: "profile.png",
    variants: [
      {
        variantName: "original_safe",
        visibility: "public",
        storageKey: "public/users/user_creator/original_safe.png",
        contentType: "image/png",
        sizeBytes: 1024,
        publicCdnUrl: "https://media.example/creator-profile.png",
      },
    ],
    createdAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
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
        name: "Creator Workspace",
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

function createRecordingCommandBus(): IdentityLifecycleCommandBus & {
  commands: IdentityLifecycleCommand[];
} {
  const commands: IdentityLifecycleCommand[] = [];
  return {
    commands,
    async execute(command) {
      commands.push(command);
      return {
        status: "accepted",
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        userId:
          "payload" in command && "userId" in command.payload ? command.payload.userId : undefined,
        events: [],
      };
    },
  };
}

function repositoryThatShouldNotBeCalled(): MarketplaceCreatorSelfServiceRepository {
  return {
    async ensureCreatorProfile() {
      throw new Error("invalid body should not bootstrap");
    },
    async getCreatorProfile() {
      throw new Error("invalid body should not read");
    },
    async updateCreatorProfile() {
      throw new Error("invalid body should not update");
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
    phone: "+49 30 123456",
    profilePictureUrl: null,
    profilePictureMediaObjectId: null,
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
