import { randomUUID } from "node:crypto";

import type { IdentityLifecycleCommandBus, RequestContext } from "@vayada/backend-auth";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import type {
  MarketplaceCreatorMatchingPreferences,
  CreatorPlatformVerificationStatus,
  CreatorProfileCompletionStep,
  CreatorProfileDocument,
  CreatorProfileMissingField,
  CreatorProfilePlatform,
  CreatorProfilePlatformInput,
  CreatorProfileStatus,
  CreatorProfileStatusResult,
  MarketplaceCreatorType,
  MarketplacePlatformName,
  UpdateCreatorProfileRequest,
} from "@vayada/domain-marketplace";
import {
  MARKETPLACE_CREATOR_MATCHING_PREFERENCES_CONTRACT_VERSION,
  parseMarketplaceCreatorMatchingPreferences,
  parseMarketplaceCreatorMatchingPreferencesWrite,
} from "@vayada/domain-marketplace";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";
import {
  resolveApprovedPublicProfileImage,
  type ApprovedPublicProfileImageRepository,
} from "./platformMedia.js";

export type MarketplaceCreatorSelfServiceRepository = {
  ensureCreatorProfile(input: {
    organizationId: string;
    ownerUserId: string;
  }): Promise<{ creatorProfileId: string }>;
  getCreatorProfile(input: {
    organizationId: string;
    creatorProfileId: string;
  }): Promise<CreatorProfileDocument | null>;
  updateCreatorProfile(input: {
    organizationId: string;
    creatorProfileId: string;
    actorUserId: string;
    patch: UpdateCreatorProfileRequest;
  }): Promise<CreatorProfileDocument | null>;
  close?(): Promise<void>;
};

type MarketplaceCreatorSelfServiceRoutesOptions = {
  repository: MarketplaceCreatorSelfServiceRepository;
  lifecycleCommandBus: IdentityLifecycleCommandBus;
  mediaRepository?: MarketplaceCreatorProfileMediaRepository;
};

export type MarketplaceCreatorProfileMediaRepository = ApprovedPublicProfileImageRepository;

type MarketplaceCreatorSelfServiceClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

type MarketplaceCreatorSelfServicePoolClient = MarketplaceCreatorSelfServiceClient & {
  release(): void;
};

type MarketplaceCreatorSelfServicePool = MarketplaceCreatorSelfServiceClient & {
  connect(): Promise<MarketplaceCreatorSelfServicePoolClient>;
  end(): Promise<void>;
};

export type CreatorProfileAccess = {
  organizationId: string;
  creatorProfileId: string;
  actorUserId: string;
};

type CreatorProfileRow = {
  creatorProfileId: string;
  organizationId: string;
  sourceCreatorId: string | null;
  displayName: string | null;
  creatorType: string;
  locationText: string | null;
  shortDescription: string | null;
  portfolioUrl: string | null;
  phone: string | null;
  profilePictureUrl: string | null;
  profilePictureMediaObjectId: string | null;
  profileComplete: boolean;
  profileCompletedAt: Date | string | null;
  profileStatus: CreatorProfileStatus;
  platforms: unknown;
  averageRating: number | string | null;
  totalReviews: number | string | null;
  matchingPreferences: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const platformNames = new Set<MarketplacePlatformName>([
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "blog",
  "x",
  "other",
]);

const creatorTypes = new Set<MarketplaceCreatorType>(["lifestyle", "travel", "other"]);
const maxCreatorPlatforms = 20;
const maxAudienceEntries = 50;

class CreatorPlatformConflictError extends Error {}

export async function registerMarketplaceCreatorSelfServiceRoutes(
  app: FastifyInstance,
  options: MarketplaceCreatorSelfServiceRoutesOptions,
): Promise<void> {
  const { lifecycleCommandBus, mediaRepository, repository } = options;
  const resolveAccess = (request: FastifyRequest, reply: FastifyReply) =>
    resolveCreatorProfileAccess(request, reply, repository, lifecycleCommandBus);

  app.addHook("onClose", async () => {
    await repository.close?.();
  });

  app.get("/creators/me/profile-status", async (request, reply) => {
    const access = await resolveAccess(request, reply);
    if (!access) return;

    const profile = await repository.getCreatorProfile(access);
    if (!profile) {
      return reply.status(404).send({
        code: "creator_profile_not_found",
        detail: "Creator profile was not found",
      });
    }
    return creatorProfileStatus(profile);
  });

  app.get("/creators/me", async (request, reply) => {
    const access = await resolveAccess(request, reply);
    if (!access) return;

    const profile = await repository.getCreatorProfile(access);
    if (!profile) {
      return reply.status(404).send({
        code: "creator_profile_not_found",
        detail: "Creator profile was not found",
      });
    }
    return profile;
  });

  app.put("/creators/me", async (request, reply) => {
    const access = await resolveAccess(request, reply);
    if (!access) return;

    const parsed = parseUpdateCreatorProfileRequest(request.body);
    if (!parsed.ok) {
      return reply.status(400).send({ code: "invalid_body", detail: parsed.error });
    }

    const mediaError = await validateCreatorProfileMediaPatch(
      parsed.value,
      access,
      mediaRepository,
    );
    if (mediaError) {
      return reply.status(mediaError.statusCode).send({
        code: mediaError.code,
        detail: mediaError.detail,
      });
    }

    let profile: CreatorProfileDocument | null;
    try {
      profile = await repository.updateCreatorProfile({
        ...access,
        patch: parsed.value,
      });
    } catch (error) {
      if (error instanceof CreatorPlatformConflictError) {
        return reply.status(409).send({
          code: "profile_conflict",
          detail: error.message,
        });
      }
      throw error;
    }
    if (!profile) {
      return reply.status(404).send({
        code: "creator_profile_not_found",
        detail: "Creator profile was not found",
      });
    }
    return profile;
  });
}

async function validateCreatorProfileMediaPatch(
  patch: UpdateCreatorProfileRequest,
  access: CreatorProfileAccess,
  mediaRepository?: MarketplaceCreatorProfileMediaRepository,
): Promise<{
  statusCode: 400 | 503;
  code: "invalid_profile_picture_media" | "media_validation_unavailable";
  detail: string;
} | null> {
  const includesUrl = has(patch, "profilePictureUrl");
  const includesMediaId = has(patch, "profilePictureMediaObjectId");
  if (!includesUrl && !includesMediaId) return null;

  if (!patch.profilePictureMediaObjectId) {
    if (patch.profilePictureUrl) {
      return {
        statusCode: 400,
        code: "invalid_profile_picture_media",
        detail: "A verified profile picture media object is required",
      };
    }
    if (includesUrl) patch.profilePictureMediaObjectId = null;
    if (includesMediaId) patch.profilePictureUrl = null;
    return null;
  }

  let resolved: Awaited<ReturnType<typeof resolveApprovedPublicProfileImage>>;
  try {
    resolved = await resolveApprovedPublicProfileImage({
      repository: mediaRepository,
      mediaId: patch.profilePictureMediaObjectId,
      actorUserId: access.actorUserId,
      ownerOrganizationId: access.organizationId,
      allowedTargets: [
        {
          purpose: "identity.user.profile_image",
          resourceProduct: "platform",
          resourceType: "user_profile",
          resourceId: access.actorUserId,
        },
        {
          purpose: "marketplace.creator.profile_image",
          resourceProduct: "marketplace",
          resourceType: "creator_profile",
          resourceId: access.creatorProfileId,
        },
      ],
    });
  } catch {
    resolved = { ok: false, reason: "unavailable" };
  }
  if (!resolved.ok && resolved.reason === "unavailable") {
    return {
      statusCode: 503,
      code: "media_validation_unavailable",
      detail: "Profile picture validation is temporarily unavailable",
    };
  }
  if (!resolved.ok) {
    return {
      statusCode: 400,
      code: "invalid_profile_picture_media",
      detail: "Profile picture media must be an owned, approved public image upload",
    };
  }

  const publicCdnUrl = resolved.publicCdnUrl;
  if (patch.profilePictureUrl && patch.profilePictureUrl !== publicCdnUrl) {
    return {
      statusCode: 400,
      code: "invalid_profile_picture_media",
      detail: "Profile picture URL does not match the uploaded media object",
    };
  }
  patch.profilePictureUrl = publicCdnUrl;
  return null;
}

export function createPgMarketplaceCreatorSelfServiceRepository(config: {
  connectionString: string;
  max?: number;
  pool?: MarketplaceCreatorSelfServicePool;
}): MarketplaceCreatorSelfServiceRepository {
  if (!config.connectionString.trim()) {
    throw new Error(
      "Marketplace creator self-service repository connectionString must not be empty",
    );
  }

  const pool: MarketplaceCreatorSelfServicePool =
    config.pool ??
    (new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    }) as unknown as MarketplaceCreatorSelfServicePool);
  return {
    async ensureCreatorProfile({ organizationId, ownerUserId }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT id FROM identity.organizations WHERE id::text = $1 FOR UPDATE`, [
          organizationId,
        ]);

        const existing = await client.query<{ creatorProfileId: string }>(
          `SELECT profile.id::text AS "creatorProfileId"
           FROM identity.organization_resource_links link
           JOIN marketplace.creator_profiles profile
             ON profile.id::text = link.resource_id
            AND profile.organization_id = link.organization_id
           WHERE link.organization_id::text = $1
             AND link.product = 'marketplace'
             AND link.resource_type = 'creator_profile'
             AND link.relationship = 'owner'
             AND link.status = 'active'
           ORDER BY profile.updated_at DESC, profile.id ASC
           LIMIT 1`,
          [organizationId],
        );
        const existingProfileId = existing.rows[0]?.creatorProfileId;
        if (existingProfileId) {
          await client.query("COMMIT");
          return { creatorProfileId: existingProfileId };
        }

        const existingProfile = await client.query<{ creatorProfileId: string }>(
          `SELECT profile.id::text AS "creatorProfileId"
           FROM marketplace.creator_profiles profile
           WHERE profile.organization_id::text = $1
             AND profile.source_system = 'marketplace'
           ORDER BY profile.updated_at DESC, profile.id ASC
           LIMIT 1`,
          [organizationId],
        );
        const existingUnlinkedProfileId = existingProfile.rows[0]?.creatorProfileId;
        if (existingUnlinkedProfileId) {
          await client.query("COMMIT");
          return { creatorProfileId: existingUnlinkedProfileId };
        }

        const inserted = await client.query<{ creatorProfileId: string }>(
          `INSERT INTO marketplace.creator_profiles
             (organization_id, owner_user_id, source_system, creator_type, profile_status)
           VALUES ($1, $2, 'marketplace', 'lifestyle', 'pending')
           RETURNING id::text AS "creatorProfileId"`,
          [organizationId, ownerUserId],
        );
        const creatorProfileId = inserted.rows[0]?.creatorProfileId;
        if (!creatorProfileId) {
          throw new Error("Failed to create creator profile");
        }

        await client.query("COMMIT");
        return { creatorProfileId };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async getCreatorProfile(input) {
      return readCreatorProfile(pool, input);
    },

    async updateCreatorProfile({ organizationId, creatorProfileId, actorUserId, patch }) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await updateProfileFields(client, { organizationId, creatorProfileId, patch });
        if (patch.platforms) {
          await replaceCreatorPlatforms(client, {
            organizationId,
            creatorProfileId,
            platforms: patch.platforms,
          });
        }
        if (has(patch, "matchingPreferences")) {
          await updateCreatorMatchingPreferences(client, {
            organizationId,
            creatorProfileId,
            actorUserId,
            preferences: patch.matchingPreferences ?? null,
          });
        }
        await recalculateProfileCompletion(client, { organizationId, creatorProfileId });
        const profile = await readCreatorProfile(client, { organizationId, creatorProfileId });
        await client.query("COMMIT");
        return profile;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}

export async function resolveCreatorProfileAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: MarketplaceCreatorSelfServiceRepository,
  lifecycleCommandBus: IdentityLifecycleCommandBus,
  options: { provisionIfMissing?: boolean } = {},
): Promise<CreatorProfileAccess | null> {
  try {
    const context = enforceRoutePolicy(request, { permission: "marketplace.profile.manage" });
    if (context.selectedOrganization.kind !== "creator_workspace") {
      reply.status(403).send({ detail: "This endpoint is only available for creators" });
      return null;
    }

    const creatorProfileLinks = context.linkedResources.filter(
      (resource) =>
        resource.status === "active" &&
        resource.product === "marketplace" &&
        resource.resourceType === "creator_profile" &&
        resource.relationship === "owner",
    );
    const creatorProfileIds = [
      ...new Set(creatorProfileLinks.map((resource) => resource.resourceId)),
    ];

    if (creatorProfileIds.length > 1) {
      reply.status(409).send({
        code: "ambiguous_marketplace_creator_profile",
        detail: "Selected organization has multiple active marketplace creator profile links",
      });
      return null;
    }

    let creatorProfileId = creatorProfileIds[0];
    if (!creatorProfileId) {
      if (options.provisionIfMissing === false) {
        reply.status(403).send({
          code: "marketplace_creator_profile_access_required",
          detail: "An active creator profile owner link is required",
        });
        return null;
      }
      const created = await repository.ensureCreatorProfile({
        organizationId: context.selectedOrganization.organizationId,
        ownerUserId: context.actor.internalUserId,
      });
      creatorProfileId = created.creatorProfileId;
      await grantCreatorProfileAccess(lifecycleCommandBus, context, creatorProfileId);
      context.linkedResources.push({
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: creatorProfileId,
        relationship: "owner",
        status: "active",
      });
    }

    enforceRoutePolicy(request, {
      permission: "marketplace.profile.manage",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: creatorProfileId,
        allowedRelationships: ["owner"],
      },
    });

    return {
      organizationId: context.selectedOrganization.organizationId,
      creatorProfileId,
      actorUserId: context.actor.internalUserId,
    };
  } catch (error) {
    const statusCode =
      typeof error === "object" && error !== null && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode)
        : 500;
    if (statusCode === 401 || statusCode === 403) {
      reply
        .status(statusCode)
        .send({ detail: error instanceof Error ? error.message : "Forbidden" });
      return null;
    }
    throw error;
  }
}

async function grantCreatorProfileAccess(
  lifecycleCommandBus: IdentityLifecycleCommandBus,
  context: RequestContext,
  creatorProfileId: string,
): Promise<void> {
  const organizationName = context.selectedOrganization.name;
  if (!organizationName) {
    throw new Error("Selected organization name is required to grant creator profile access");
  }

  await lifecycleCommandBus.execute({
    commandType: "identity.access.grant",
    commandId: randomUUID(),
    idempotencyKey: `marketplace-creator-profile:${context.selectedOrganization.organizationId}:${creatorProfileId}:owner`,
    audit: {
      actor: {
        kind: "user",
        userId: context.actor.internalUserId,
        organizationId: context.selectedOrganization.organizationId,
      },
      source: context.audit.source,
      requestId: context.audit.requestId,
      correlationId: context.audit.correlationId,
      reason: "Marketplace creator self-service profile bootstrap",
      requestedAt: context.audit.receivedAt,
    },
    payload: {
      userId: context.actor.internalUserId,
      organization: {
        organizationId: context.selectedOrganization.organizationId,
        kind: context.selectedOrganization.kind,
        name: organizationName,
        status: context.selectedOrganization.status,
        workosOrgId: context.selectedOrganization.workosOrgId,
      },
      membership: {
        status: context.membership.status,
        roleKey: context.membership.roleKey,
        propertyAccessMode: "assigned",
        permissionKeys: context.membership.permissions,
        workosMembershipId: context.membership.workosMembershipId,
        workosRoleSlugs: context.membership.workosRoleSlugs,
      },
      resourceLinks: [
        {
          organizationId: context.selectedOrganization.organizationId,
          product: "marketplace",
          resourceType: "creator_profile",
          resourceId: creatorProfileId,
          relationship: "owner",
          status: "active",
        },
      ],
    },
  });
}

async function readCreatorProfile(
  client: MarketplaceCreatorSelfServiceClient,
  input: { organizationId: string; creatorProfileId: string },
): Promise<CreatorProfileDocument | null> {
  const result = await client.query<CreatorProfileRow>(
    `SELECT
       profile.id::text AS "creatorProfileId",
       profile.organization_id::text AS "organizationId",
       profile.source_creator_id AS "sourceCreatorId",
       profile.display_name AS "displayName",
       profile.creator_type AS "creatorType",
       profile.location_text AS "locationText",
       profile.short_description AS "shortDescription",
       profile.portfolio_url AS "portfolioUrl",
       profile.phone,
       profile.profile_picture_url AS "profilePictureUrl",
       profile.profile_metadata ->> 'profilePictureMediaObjectId' AS "profilePictureMediaObjectId",
       marketplace.creator_profile_is_complete(
         profile.id,
         profile.organization_id
       ) AS "profileComplete",
       profile.profile_completed_at AS "profileCompletedAt",
       profile.profile_status AS "profileStatus",
       COALESCE(platforms.platforms, '[]'::jsonb) AS platforms,
       COALESCE(ROUND(ratings.average_rating::numeric, 2), 0) AS "averageRating",
       COALESCE(ratings.total_reviews, 0)::text AS "totalReviews",
       CASE
         WHEN matching_preferences.creator_profile_id IS NULL THEN NULL
         ELSE jsonb_build_object(
           'contractVersion', matching_preferences.contract_version,
           'evidenceSource', 'creator_declared',
           'revision', matching_preferences.revision,
           'updatedAt', matching_preferences.updated_at
         ) || matching_preferences.preferences
       END AS "matchingPreferences",
       profile.created_at AS "createdAt",
       profile.updated_at AS "updatedAt"
     FROM marketplace.creator_profiles profile
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
                jsonb_build_object(
                  'platformId', platform.id::text,
                  'platform', platform.platform,
                  'handle', platform.handle,
                  'profileUrl', platform.profile_url,
                  'followerCount', platform.follower_count,
                  'engagementRate', platform.engagement_rate,
                  'audienceCountries', platform.audience_countries,
                  'audienceAgeGroups', platform.audience_age_groups,
                  'audienceGenderSplit', platform.audience_gender_split,
                  'verificationStatus', platform.verification_status
                )
                ORDER BY platform.created_at DESC, platform.id ASC
              ) AS platforms
       FROM marketplace.creator_platforms platform
       WHERE platform.creator_profile_id = profile.id
         AND platform.organization_id = profile.organization_id
     ) platforms ON TRUE
     LEFT JOIN LATERAL (
       SELECT AVG(rating.rating) AS average_rating,
              COUNT(*) AS total_reviews
       FROM marketplace.creator_ratings rating
       WHERE rating.creator_profile_id = profile.id
         AND rating.creator_organization_id = profile.organization_id
     ) ratings ON TRUE
     LEFT JOIN marketplace.creator_matching_preferences matching_preferences
       ON matching_preferences.creator_profile_id = profile.id
      AND matching_preferences.organization_id = profile.organization_id
     WHERE profile.id::text = $1
       AND profile.organization_id::text = $2
     LIMIT 1`,
    [input.creatorProfileId, input.organizationId],
  );

  const row = result.rows[0];
  if (!row) return null;
  const platforms = parseCreatorPlatforms(row.platforms);
  return {
    creatorProfileId: row.creatorProfileId,
    organizationId: row.organizationId,
    sourceCreatorId: row.sourceCreatorId,
    displayName: row.displayName,
    creatorType: toPublicCreatorType(row.creatorType),
    locationText: row.locationText,
    shortDescription: row.shortDescription,
    portfolioUrl: row.portfolioUrl,
    phone: row.phone,
    profilePictureUrl: row.profilePictureUrl,
    profilePictureMediaObjectId: row.profilePictureMediaObjectId,
    profileComplete: row.profileComplete,
    profileCompletedAt:
      row.profileComplete && row.profileCompletedAt ? toIsoString(row.profileCompletedAt) : null,
    profileStatus: row.profileStatus,
    platforms,
    audienceSize: platforms.reduce((sum, platform) => sum + platform.followerCount, 0),
    rating: {
      averageRating: toNumber(row.averageRating),
      totalReviews: toInteger(row.totalReviews),
    },
    matchingPreferences: toCreatorMatchingPreferences(row.matchingPreferences),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

async function updateProfileFields(
  client: MarketplaceCreatorSelfServiceClient,
  input: {
    organizationId: string;
    creatorProfileId: string;
    patch: UpdateCreatorProfileRequest;
  },
): Promise<void> {
  const values: unknown[] = [input.creatorProfileId, input.organizationId];
  const setClauses: string[] = [];

  const addColumn = (column: string, value: unknown) => {
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  };

  if (has(input.patch, "displayName")) addColumn("display_name", input.patch.displayName);
  if (has(input.patch, "creatorType")) addColumn("creator_type", input.patch.creatorType);
  if (has(input.patch, "locationText")) addColumn("location_text", input.patch.locationText);
  if (has(input.patch, "shortDescription")) {
    addColumn("short_description", input.patch.shortDescription);
  }
  if (has(input.patch, "portfolioUrl")) addColumn("portfolio_url", input.patch.portfolioUrl);
  if (has(input.patch, "phone")) addColumn("phone", input.patch.phone);
  if (has(input.patch, "profilePictureUrl")) {
    addColumn("profile_picture_url", input.patch.profilePictureUrl);
  }
  if (has(input.patch, "profilePictureMediaObjectId")) {
    values.push(input.patch.profilePictureMediaObjectId ?? null);
    setClauses.push(
      `profile_metadata = CASE
         WHEN $${values.length}::text IS NULL THEN profile_metadata - 'profilePictureMediaObjectId'
         ELSE jsonb_set(profile_metadata, '{profilePictureMediaObjectId}', to_jsonb($${values.length}::text), true)
       END`,
    );
  }

  if (setClauses.length === 0) return;

  await client.query(
    `UPDATE marketplace.creator_profiles
     SET ${setClauses.join(", ")}, updated_at = now()
     WHERE id::text = $1
       AND organization_id::text = $2`,
    values,
  );
}

async function replaceCreatorPlatforms(
  client: MarketplaceCreatorSelfServiceClient,
  input: {
    organizationId: string;
    creatorProfileId: string;
    platforms: CreatorProfilePlatformInput[];
  },
): Promise<void> {
  const retainedPlatformIds: string[] = [];
  await client.query(
    `SELECT id
     FROM marketplace.creator_profiles
     WHERE id::text = $1
       AND organization_id::text = $2
     FOR UPDATE`,
    [input.creatorProfileId, input.organizationId],
  );
  const existing = await client.query<{
    platformId: string;
    platform: MarketplacePlatformName;
    handle: string;
    profileUrl: string | null;
    profileUrlImported: boolean;
    followerCount: number;
    engagementRate: number | string;
    audienceCountries: unknown;
    audienceAgeGroups: unknown;
    audienceGenderSplit: unknown;
  }>(
    `SELECT id::text AS "platformId", platform, handle,
            profile_url AS "profileUrl",
            COALESCE((platform_metadata ->> 'profileUrlImported')::boolean, false)
              AS "profileUrlImported",
            follower_count AS "followerCount",
            engagement_rate AS "engagementRate",
            audience_countries AS "audienceCountries",
            audience_age_groups AS "audienceAgeGroups",
            audience_gender_split AS "audienceGenderSplit"
     FROM marketplace.creator_platforms
     WHERE creator_profile_id::text = $1
       AND organization_id::text = $2
     ORDER BY id
     FOR UPDATE`,
    [input.creatorProfileId, input.organizationId],
  );
  const existingPlatformIds = new Set(existing.rows.map((row) => row.platformId));
  const existingPlatforms = new Map(existing.rows.map((row) => [row.platformId, row] as const));
  const connected = await client.query<{
    platformId: string;
    platform: MarketplacePlatformName;
    importedFields: string[];
  }>(
    `SELECT platform_id::text AS "platformId", platform,
            imported_fields AS "importedFields"
     FROM marketplace.creator_platform_connections
     WHERE creator_profile_id::text = $1
       AND organization_id::text = $2
       AND status <> 'revoked'
     FOR UPDATE`,
    [input.creatorProfileId, input.organizationId],
  );
  const connectedPlatforms = new Map(connected.rows.map((row) => [row.platformId, row] as const));
  const includesLegacyRows = input.platforms.some((platform) => !has(platform, "platformId"));

  if (includesLegacyRows && input.platforms.length > 0 && existingPlatformIds.size > 0) {
    throw new CreatorPlatformConflictError(
      "Your creator platforms must be refreshed before they can be updated.",
    );
  }
  for (const platform of input.platforms) {
    if (typeof platform.platformId === "string" && !existingPlatformIds.has(platform.platformId)) {
      throw new CreatorPlatformConflictError(
        "A creator platform changed while you were editing. Refresh and try again.",
      );
    }
    if (
      typeof platform.platformId === "string" &&
      connectedPlatforms.has(platform.platformId) &&
      connectedPlatforms.get(platform.platformId)?.platform !== platform.platform
    ) {
      throw new CreatorPlatformConflictError(
        "A connected account cannot be changed to another platform. Disconnect it first.",
      );
    }
  }

  const requestedPlatformIds = new Set(
    input.platforms.flatMap((platform) =>
      typeof platform.platformId === "string" ? [platform.platformId] : [],
    ),
  );
  if ([...connectedPlatforms.keys()].some((platformId) => !requestedPlatformIds.has(platformId))) {
    throw new CreatorPlatformConflictError(
      "Disconnect a connected account before removing it from your profile.",
    );
  }

  for (const platform of input.platforms) {
    if (typeof platform.platformId === "string") {
      const persistedPlatform = existingPlatforms.get(platform.platformId);
      const connection = connectedPlatforms.get(platform.platformId);
      if (
        persistedPlatform &&
        connection &&
        connectedPlatformFieldsChanged(platform, persistedPlatform, connection.importedFields)
      ) {
        throw new CreatorPlatformConflictError(
          "Synced platform data cannot be edited manually. Disconnect it or refresh the account.",
        );
      }
      const includesProfileUrl = has(platform, "profileUrl");
      const includesAudienceCountries = has(platform, "audienceCountries");
      const includesAudienceAgeGroups = has(platform, "audienceAgeGroups");
      const includesAudienceGenderSplit = has(platform, "audienceGenderSplit");
      const updated = await client.query<{ platformId: string }>(
        `UPDATE marketplace.creator_platforms
         SET verification_status = CASE
               WHEN NOT $16::boolean AND verification_status = 'verified' AND (
                 platform IS DISTINCT FROM $3::text
                 OR handle IS DISTINCT FROM $4::text
                 OR follower_count IS DISTINCT FROM $5::integer
                 OR engagement_rate IS DISTINCT FROM $6::numeric
                 OR ($7::boolean AND profile_url IS DISTINCT FROM $8::text)
                 OR ($9::boolean AND audience_countries IS DISTINCT FROM $10::jsonb)
                 OR ($11::boolean AND audience_age_groups IS DISTINCT FROM $12::jsonb)
                 OR ($13::boolean AND audience_gender_split IS DISTINCT FROM $14::jsonb)
               ) THEN 'stale'
               ELSE verification_status
             END,
             platform = $3,
             handle = $4,
             follower_count = $5,
             engagement_rate = $6,
             profile_url = CASE WHEN $7::boolean THEN $8::text ELSE profile_url END,
             audience_countries = CASE
               WHEN $9::boolean THEN $10::jsonb ELSE audience_countries
             END,
             audience_age_groups = CASE
               WHEN $11::boolean THEN $12::jsonb ELSE audience_age_groups
             END,
             audience_gender_split = CASE
               WHEN $13::boolean THEN $14::jsonb ELSE audience_gender_split
             END,
             updated_at = now()
         WHERE id::text = $15
           AND creator_profile_id::text = $1
           AND organization_id::text = $2
         RETURNING id::text AS "platformId"`,
        [
          input.creatorProfileId,
          input.organizationId,
          platform.platform,
          platform.handle,
          platform.followerCount,
          platform.engagementRate,
          includesProfileUrl,
          platform.profileUrl ?? null,
          includesAudienceCountries,
          JSON.stringify(platform.audienceCountries ?? []),
          includesAudienceAgeGroups,
          JSON.stringify(platform.audienceAgeGroups ?? []),
          includesAudienceGenderSplit,
          JSON.stringify(platform.audienceGenderSplit ?? {}),
          platform.platformId,
          Boolean(connection),
        ],
      );
      const platformId = updated.rows[0]?.platformId;
      if (!platformId) {
        throw new CreatorPlatformConflictError(
          "A creator platform changed while you were editing. Refresh and try again.",
        );
      }
      retainedPlatformIds.push(platformId);
      continue;
    }

    const inserted = await client.query<{ platformId: string }>(
      `INSERT INTO marketplace.creator_platforms (
         creator_profile_id,
         organization_id,
         source_system,
         platform,
         handle,
         profile_url,
         follower_count,
         engagement_rate,
         audience_countries,
         audience_age_groups,
         audience_gender_split
       )
       VALUES ($1, $2, 'marketplace', $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
       RETURNING id::text AS "platformId"`,
      [
        input.creatorProfileId,
        input.organizationId,
        platform.platform,
        platform.handle,
        platform.profileUrl ?? null,
        platform.followerCount,
        platform.engagementRate,
        JSON.stringify(platform.audienceCountries ?? []),
        JSON.stringify(platform.audienceAgeGroups ?? []),
        JSON.stringify(platform.audienceGenderSplit ?? {}),
      ],
    );
    const platformId = inserted.rows[0]?.platformId;
    if (!platformId) throw new Error("Failed to create creator platform");
    retainedPlatformIds.push(platformId);
  }

  await client.query(
    retainedPlatformIds.length > 0
      ? `DELETE FROM marketplace.creator_platforms
         WHERE creator_profile_id::text = $1
           AND organization_id::text = $2
           AND NOT (id::text = ANY($3::text[]))`
      : `DELETE FROM marketplace.creator_platforms
         WHERE creator_profile_id::text = $1
           AND organization_id::text = $2`,
    retainedPlatformIds.length > 0
      ? [input.creatorProfileId, input.organizationId, retainedPlatformIds]
      : [input.creatorProfileId, input.organizationId],
  );
}

async function updateCreatorMatchingPreferences(
  client: MarketplaceCreatorSelfServiceClient,
  input: {
    organizationId: string;
    creatorProfileId: string;
    actorUserId: string;
    preferences: NonNullable<UpdateCreatorProfileRequest["matchingPreferences"]> | null;
  },
): Promise<void> {
  if (input.preferences === null) {
    await client.query(
      `DELETE FROM marketplace.creator_matching_preferences
       WHERE creator_profile_id::text = $1 AND organization_id::text = $2`,
      [input.creatorProfileId, input.organizationId],
    );
    return;
  }

  await client.query(
    `INSERT INTO marketplace.creator_matching_preferences (
       creator_profile_id, organization_id, contract_version, preferences, updated_by_user_id
     )
     SELECT profile.id, profile.organization_id, $3, $4::jsonb, $5::uuid
     FROM marketplace.creator_profiles profile
     WHERE profile.id::text = $1 AND profile.organization_id::text = $2
     ON CONFLICT (creator_profile_id) DO UPDATE
     SET preferences = EXCLUDED.preferences,
         revision = marketplace.creator_matching_preferences.revision + 1,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = now()`,
    [
      input.creatorProfileId,
      input.organizationId,
      MARKETPLACE_CREATOR_MATCHING_PREFERENCES_CONTRACT_VERSION,
      JSON.stringify(input.preferences),
      input.actorUserId,
    ],
  );
}

async function recalculateProfileCompletion(
  client: MarketplaceCreatorSelfServiceClient,
  input: { organizationId: string; creatorProfileId: string },
): Promise<void> {
  await client.query(
    `WITH completion AS (
       SELECT marketplace.creator_profile_is_complete(
         $1::uuid,
         $2::uuid
       ) AS profile_complete
     )
     UPDATE marketplace.creator_profiles profile
     SET profile_complete = completion.profile_complete,
         profile_completed_at = CASE
           WHEN completion.profile_complete THEN COALESCE(profile.profile_completed_at, now())
           ELSE NULL
         END,
         updated_at = now()
     FROM completion
     WHERE profile.id = $1::uuid
       AND profile.organization_id = $2::uuid`,
    [input.creatorProfileId, input.organizationId],
  );
}

function creatorProfileStatus(profile: CreatorProfileDocument): CreatorProfileStatusResult {
  const missingFields = creatorProfileMissingFields(profile);
  const missingPlatforms = !hasCompletePlatform(profile.platforms);
  // SQL completeness checks these same fields plus photo approval, so residual
  // incompleteness maps to profilePicture. Keep both criteria in sync.
  if (missingFields.length === 0 && !missingPlatforms && !profile.profileComplete) {
    missingFields.push("profilePicture");
  }
  return {
    creatorProfileId: profile.creatorProfileId,
    organizationId: profile.organizationId,
    profilePhotoRequired: true,
    profileComplete: missingFields.length === 0 && !missingPlatforms,
    profileStatus: profile.profileStatus,
    missingFields: missingPlatforms ? [...missingFields, "platforms"] : missingFields,
    missingPlatforms,
    completionSteps: creatorProfileCompletionSteps(missingFields, missingPlatforms),
    canPublishToDiscovery:
      missingFields.length === 0 && !missingPlatforms && profile.profileStatus === "active",
    updatedAt: profile.updatedAt,
  };
}

function creatorProfileMissingFields(
  profile: CreatorProfileDocument,
): CreatorProfileMissingField[] {
  const missingFields: CreatorProfileMissingField[] = [];
  if (!profile.displayName?.trim()) missingFields.push("displayName");
  if (!profile.locationText?.trim()) missingFields.push("locationText");
  if (!profile.shortDescription?.trim()) missingFields.push("shortDescription");
  if (!profile.phone?.trim()) missingFields.push("phone");
  if (!profile.profilePictureUrl?.trim() || !profile.profilePictureMediaObjectId?.trim()) {
    missingFields.push("profilePicture");
  }
  return missingFields;
}

function creatorProfileCompletionSteps(
  missingFields: CreatorProfileMissingField[],
  missingPlatforms: boolean,
): CreatorProfileCompletionStep[] {
  const steps: CreatorProfileCompletionStep[] = [];
  if (missingFields.includes("displayName")) steps.push("add_display_name");
  if (missingFields.includes("locationText")) steps.push("set_location");
  if (missingFields.includes("shortDescription")) steps.push("add_short_description");
  if (missingFields.includes("phone")) steps.push("add_phone");
  if (missingFields.includes("profilePicture")) steps.push("add_profile_picture");
  if (missingPlatforms) steps.push("add_platform");
  return steps;
}

function hasCompletePlatform(platforms: CreatorProfilePlatform[]): boolean {
  return platforms.some(
    (platform) =>
      platform.handle.trim() &&
      platform.followerCount > 0 &&
      (platform.platform !== "other" || Boolean(platform.profileUrl?.trim())),
  );
}

function parseUpdateCreatorProfileRequest(
  body: unknown,
): { ok: true; value: UpdateCreatorProfileRequest } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "Request body must be an object" };

  const allowedKeys = new Set([
    "displayName",
    "creatorType",
    "locationText",
    "shortDescription",
    "portfolioUrl",
    "phone",
    "profilePictureUrl",
    "profilePictureMediaObjectId",
    "platforms",
    "matchingPreferences",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedKeys.has(key)) return { ok: false, error: `Unsupported field: ${key}` };
  }

  const patch: UpdateCreatorProfileRequest = {};
  if (has(body, "displayName")) {
    const value = requiredString(body.displayName, "displayName");
    if (!value.ok) return value;
    patch.displayName = value.value;
  }
  if (has(body, "creatorType")) {
    if (!creatorTypes.has(body.creatorType as MarketplaceCreatorType)) {
      return { ok: false, error: "creatorType must be lifestyle, travel, or other" };
    }
    patch.creatorType = body.creatorType as MarketplaceCreatorType;
  }
  if (has(body, "locationText")) {
    const value = nullableString(body.locationText, "locationText");
    if (!value.ok) return value;
    patch.locationText = value.value;
  }
  if (has(body, "shortDescription")) {
    const value = nullableString(body.shortDescription, "shortDescription");
    if (!value.ok) return value;
    patch.shortDescription = value.value ? value.value.slice(0, 500) : value.value;
  }
  if (has(body, "portfolioUrl")) {
    const value = nullableHttpsUrl(body.portfolioUrl, "portfolioUrl");
    if (!value.ok) return value;
    patch.portfolioUrl = value.value;
  }
  if (has(body, "phone")) {
    const value = nullableString(body.phone, "phone");
    if (!value.ok) return value;
    patch.phone = value.value;
  }
  if (has(body, "profilePictureUrl")) {
    const value = nullableHttpsUrl(body.profilePictureUrl, "profilePictureUrl");
    if (!value.ok) return value;
    patch.profilePictureUrl = value.value;
  }
  if (has(body, "profilePictureMediaObjectId")) {
    const value = nullableString(body.profilePictureMediaObjectId, "profilePictureMediaObjectId");
    if (!value.ok) return value;
    patch.profilePictureMediaObjectId = value.value;
  }
  if (has(body, "platforms")) {
    if (!Array.isArray(body.platforms)) {
      return { ok: false, error: "platforms must be an array" };
    }
    if (body.platforms.length > maxCreatorPlatforms) {
      return { ok: false, error: `platforms must contain at most ${maxCreatorPlatforms} entries` };
    }
    const platforms: CreatorProfilePlatformInput[] = [];
    const platformIds = new Set<string>();
    for (const [index, platform] of body.platforms.entries()) {
      const parsed = parsePlatformInput(platform, index);
      if (!parsed.ok) return parsed;
      if (parsed.value.platformId) {
        if (platformIds.has(parsed.value.platformId)) {
          return { ok: false, error: `platforms[${index}].platformId must be unique` };
        }
        platformIds.add(parsed.value.platformId);
      }
      platforms.push(parsed.value);
    }
    patch.platforms = platforms;
  }
  if (has(body, "matchingPreferences")) {
    if (body.matchingPreferences === null) {
      patch.matchingPreferences = null;
    } else {
      const preferences = parseMarketplaceCreatorMatchingPreferencesWrite(body.matchingPreferences);
      if (!preferences) return { ok: false, error: "matchingPreferences is invalid" };
      patch.matchingPreferences = preferences;
    }
  }

  return { ok: true, value: patch };
}

function parsePlatformInput(
  raw: unknown,
  index: number,
): { ok: true; value: CreatorProfilePlatformInput } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: `platforms[${index}] must be an object` };
  if (!platformNames.has(raw.platform as MarketplacePlatformName)) {
    return { ok: false, error: `platforms[${index}].platform is invalid` };
  }
  const includesPlatformId = has(raw, "platformId");
  const platformId = !includesPlatformId
    ? ({ ok: true, value: undefined } as const)
    : raw.platformId === null
      ? ({ ok: true, value: null } as const)
      : requiredString(raw.platformId, `platforms[${index}].platformId`);
  if (!platformId.ok) return platformId;
  const handle = requiredString(raw.handle, `platforms[${index}].handle`);
  if (!handle.ok) return handle;
  const followerCount = nonNegativeNumber(raw.followerCount, `platforms[${index}].followerCount`);
  if (!followerCount.ok) return followerCount;
  const engagementRate = nonNegativeNumber(
    raw.engagementRate,
    `platforms[${index}].engagementRate`,
  );
  if (!engagementRate.ok) return engagementRate;
  const includesProfileUrl = has(raw, "profileUrl");
  const profileUrl = nullableHttpsUrl(raw.profileUrl, `platforms[${index}].profileUrl`);
  if (!profileUrl.ok) return profileUrl;
  if (raw.platform === "other" && (!includesProfileUrl || !profileUrl.value)) {
    return {
      ok: false,
      error: `platforms[${index}].profileUrl is required when platform is other`,
    };
  }
  const includesAudienceCountries = has(raw, "audienceCountries");
  const audienceCountries = audienceCountryArray(
    raw.audienceCountries,
    `platforms[${index}].audienceCountries`,
  );
  if (!audienceCountries.ok) return audienceCountries;
  const includesAudienceAgeGroups = has(raw, "audienceAgeGroups");
  const audienceAgeGroups = audienceAgeGroupArray(
    raw.audienceAgeGroups,
    `platforms[${index}].audienceAgeGroups`,
  );
  if (!audienceAgeGroups.ok) return audienceAgeGroups;
  const includesAudienceGenderSplit = has(raw, "audienceGenderSplit");
  const audienceGenderSplit = genderSplit(
    raw.audienceGenderSplit,
    `platforms[${index}].audienceGenderSplit`,
  );
  if (!audienceGenderSplit.ok) return audienceGenderSplit;

  return {
    ok: true,
    value: {
      ...(includesPlatformId ? { platformId: platformId.value } : {}),
      platform: raw.platform as MarketplacePlatformName,
      handle: handle.value,
      ...(includesProfileUrl ? { profileUrl: profileUrl.value } : {}),
      followerCount: followerCount.value,
      engagementRate: engagementRate.value,
      ...(includesAudienceCountries ? { audienceCountries: audienceCountries.value } : {}),
      ...(includesAudienceAgeGroups ? { audienceAgeGroups: audienceAgeGroups.value } : {}),
      ...(includesAudienceGenderSplit ? { audienceGenderSplit: audienceGenderSplit.value } : {}),
    },
  };
}

function requiredString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${field} must contain text` };
  }
  return { ok: true, value: value.trim() };
}

function nullableString(
  value: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${field} must be a string` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed ? trimmed : null };
}

function nullableHttpsUrl(
  value: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const parsed = nullableString(value, field);
  if (!parsed.ok || !parsed.value) return parsed;
  try {
    const url = new URL(parsed.value);
    if (url.protocol !== "https:") throw new Error("not https");
    return { ok: true, value: url.toString() };
  } catch {
    return { ok: false, error: `${field} must be an absolute https URL` };
  }
}

function nonNegativeNumber(
  value: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return { ok: false, error: `${field} must be a non-negative number` };
  }
  return { ok: true, value: numberValue };
}

function audienceCountryArray(
  value: unknown,
  field: string,
):
  | { ok: true; value: Array<{ country: string; percentage: number }> }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be an array` };
  if (value.length > maxAudienceEntries) {
    return { ok: false, error: `${field} must contain at most ${maxAudienceEntries} entries` };
  }

  const entries: Array<{ country: string; percentage: number }> = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || typeof entry.country !== "string" || !entry.country.trim()) {
      return { ok: false, error: `${field}[${index}].country must contain text` };
    }
    const percentage = nonNegativeNumber(entry.percentage, `${field}[${index}].percentage`);
    if (!percentage.ok) return percentage;
    if (percentage.value > 100) {
      return { ok: false, error: `${field}[${index}].percentage must be at most 100` };
    }
    entries.push({
      country: entry.country.trim(),
      percentage: percentage.value,
    });
  }
  return { ok: true, value: entries };
}

function audienceAgeGroupArray(
  value: unknown,
  field: string,
):
  | { ok: true; value: Array<{ ageRange: string; percentage: number }> }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, error: `${field} must be an array` };
  if (value.length > maxAudienceEntries) {
    return { ok: false, error: `${field} must contain at most ${maxAudienceEntries} entries` };
  }

  const entries: Array<{ ageRange: string; percentage: number }> = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || typeof entry.ageRange !== "string" || !entry.ageRange.trim()) {
      return { ok: false, error: `${field}[${index}].ageRange must contain text` };
    }
    const percentage = nonNegativeNumber(entry.percentage, `${field}[${index}].percentage`);
    if (!percentage.ok) return percentage;
    if (percentage.value > 100) {
      return { ok: false, error: `${field}[${index}].percentage must be at most 100` };
    }
    entries.push({
      ageRange: entry.ageRange.trim(),
      percentage: percentage.value,
    });
  }
  return { ok: true, value: entries };
}

function genderSplit(
  value: unknown,
  field: string,
):
  | { ok: true; value: { male: number; female: number; other?: number } | null }
  | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (!isRecord(value)) return { ok: false, error: `${field} must be an object` };

  const male = percentage(value.male, `${field}.male`);
  if (!male.ok) return male;
  const female = percentage(value.female, `${field}.female`);
  if (!female.ok) return female;
  if (value.other === undefined)
    return { ok: true, value: { male: male.value, female: female.value } };

  const other = percentage(value.other, `${field}.other`);
  if (!other.ok) return other;
  return { ok: true, value: { male: male.value, female: female.value, other: other.value } };
}

function percentage(
  value: unknown,
  field: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const numberValue = nonNegativeNumber(value, field);
  if (!numberValue.ok) return numberValue;
  if (numberValue.value > 100) return { ok: false, error: `${field} must be at most 100` };
  return numberValue;
}

function parseCreatorPlatforms(raw: unknown): CreatorProfilePlatform[] {
  const platforms = Array.isArray(raw) ? raw : [];
  return platforms.flatMap((entry): CreatorProfilePlatform[] => {
    if (!isRecord(entry)) return [];
    const platform = String(entry.platform ?? "");
    if (!platformNames.has(platform as MarketplacePlatformName)) return [];
    return [
      {
        platformId: String(entry.platformId ?? ""),
        platform: platform as MarketplacePlatformName,
        handle: String(entry.handle ?? ""),
        profileUrl: entry.profileUrl ? String(entry.profileUrl) : null,
        followerCount: toInteger(entry.followerCount),
        engagementRate: toNumber(entry.engagementRate),
        audienceCountries: parseAudienceCountries(entry.audienceCountries),
        audienceAgeGroups: parseAudienceAgeGroups(entry.audienceAgeGroups),
        audienceGenderSplit: parseAudienceGenderSplit(entry.audienceGenderSplit),
        verificationStatus: toVerificationStatus(entry.verificationStatus),
      },
    ];
  });
}

function connectedPlatformFieldsChanged(
  platform: CreatorProfilePlatformInput,
  persisted: {
    platform: MarketplacePlatformName;
    handle: string;
    profileUrl: string | null;
    profileUrlImported: boolean;
    followerCount: number;
    engagementRate: number | string;
    audienceCountries: unknown;
    audienceAgeGroups: unknown;
    audienceGenderSplit: unknown;
  },
  importedFields: string[],
): boolean {
  const imported = new Set(importedFields);
  if (platform.platform !== persisted.platform || platform.handle !== persisted.handle) return true;
  if (
    persisted.profileUrlImported &&
    has(platform, "profileUrl") &&
    (platform.profileUrl ?? null) !== persisted.profileUrl
  ) {
    return true;
  }
  if (imported.has("followerCount") && platform.followerCount !== Number(persisted.followerCount)) {
    return true;
  }
  if (
    imported.has("engagementRate") &&
    platform.engagementRate !== Number(persisted.engagementRate)
  ) {
    return true;
  }
  return (
    (imported.has("audienceCountries") &&
      has(platform, "audienceCountries") &&
      !sameJson(platform.audienceCountries ?? [], persisted.audienceCountries)) ||
    (imported.has("audienceAgeGroups") &&
      has(platform, "audienceAgeGroups") &&
      !sameJson(platform.audienceAgeGroups ?? [], persisted.audienceAgeGroups)) ||
    (imported.has("audienceGenderSplit") &&
      has(platform, "audienceGenderSplit") &&
      !sameJson(platform.audienceGenderSplit ?? {}, persisted.audienceGenderSplit))
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function parseAudienceCountries(raw: unknown): Array<{ country: string; percentage: number }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) =>
    isRecord(entry) && typeof entry.country === "string"
      ? [{ country: entry.country, percentage: toNumber(entry.percentage) }]
      : [],
  );
}

function parseAudienceAgeGroups(raw: unknown): Array<{ ageRange: string; percentage: number }> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) =>
    isRecord(entry) && typeof entry.ageRange === "string"
      ? [{ ageRange: entry.ageRange, percentage: toNumber(entry.percentage) }]
      : [],
  );
}

function parseAudienceGenderSplit(
  raw: unknown,
): { male: number; female: number; other?: number } | null {
  if (!isRecord(raw) || raw.male === undefined || raw.female === undefined) return null;
  return {
    male: toNumber(raw.male),
    female: toNumber(raw.female),
    ...(raw.other !== undefined ? { other: toNumber(raw.other) } : {}),
  };
}

function toVerificationStatus(raw: unknown): CreatorPlatformVerificationStatus {
  return raw === "verified" || raw === "rejected" || raw === "stale" ? raw : "unverified";
}

function toCreatorMatchingPreferences(raw: unknown): MarketplaceCreatorMatchingPreferences | null {
  if (raw === null || raw === undefined) return null;
  const preferences = parseMarketplaceCreatorMatchingPreferences(raw);
  if (!preferences) throw new Error("Stored Marketplace creator matching preferences are invalid");
  return preferences;
}

function toPublicCreatorType(value: string): MarketplaceCreatorType {
  return value === "lifestyle" || value === "travel" ? value : "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNumber(value: unknown): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toInteger(value: unknown): number {
  return Math.trunc(toNumber(value));
}
