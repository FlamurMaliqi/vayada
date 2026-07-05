import { randomUUID } from "node:crypto";

import type { IdentityLifecycleCommandBus, RequestContext } from "@vayada/backend-auth";
import pg, { type QueryResult, type QueryResultRow } from "pg";
import type {
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
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { enforceRoutePolicy } from "./policy.js";

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
    patch: UpdateCreatorProfileRequest;
  }): Promise<CreatorProfileDocument | null>;
  close?(): Promise<void>;
};

type MarketplaceCreatorSelfServiceRoutesOptions = {
  repository: MarketplaceCreatorSelfServiceRepository;
  lifecycleCommandBus: IdentityLifecycleCommandBus;
};

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

type CreatorProfileAccess = {
  organizationId: string;
  creatorProfileId: string;
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
  profileComplete: boolean;
  profileCompletedAt: Date | string | null;
  profileStatus: CreatorProfileStatus;
  platforms: unknown;
  averageRating: number | string | null;
  totalReviews: number | string | null;
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

export async function registerMarketplaceCreatorSelfServiceRoutes(
  app: FastifyInstance,
  options: MarketplaceCreatorSelfServiceRoutesOptions,
): Promise<void> {
  const { lifecycleCommandBus, repository } = options;
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
    const parsed = parseUpdateCreatorProfileRequest(request.body);
    if (!parsed.ok) {
      return reply.status(400).send({ code: "invalid_body", detail: parsed.error });
    }

    const access = await resolveAccess(request, reply);
    if (!access) return;

    const profile = await repository.updateCreatorProfile({
      ...access,
      patch: parsed.value,
    });
    if (!profile) {
      return reply.status(404).send({
        code: "creator_profile_not_found",
        detail: "Creator profile was not found",
      });
    }
    return profile;
  });
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

    async updateCreatorProfile({ organizationId, creatorProfileId, patch }) {
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

async function resolveCreatorProfileAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: MarketplaceCreatorSelfServiceRepository,
  lifecycleCommandBus: IdentityLifecycleCommandBus,
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
       profile.profile_complete AS "profileComplete",
       profile.profile_completed_at AS "profileCompletedAt",
       profile.profile_status AS "profileStatus",
       COALESCE(platforms.platforms, '[]'::jsonb) AS platforms,
       COALESCE(ROUND(ratings.average_rating::numeric, 2), 0) AS "averageRating",
       COALESCE(ratings.total_reviews, 0)::text AS "totalReviews",
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
    profileComplete: row.profileComplete,
    profileCompletedAt: row.profileCompletedAt ? toIsoString(row.profileCompletedAt) : null,
    profileStatus: row.profileStatus,
    platforms,
    audienceSize: platforms.reduce((sum, platform) => sum + platform.followerCount, 0),
    rating: {
      averageRating: toNumber(row.averageRating),
      totalReviews: toInteger(row.totalReviews),
    },
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
  await client.query(
    `DELETE FROM marketplace.creator_platforms
     WHERE creator_profile_id::text = $1
       AND organization_id::text = $2`,
    [input.creatorProfileId, input.organizationId],
  );

  for (const platform of input.platforms) {
    await client.query(
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
       VALUES ($1, $2, 'marketplace', $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)`,
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
  }
}

async function recalculateProfileCompletion(
  client: MarketplaceCreatorSelfServiceClient,
  input: { organizationId: string; creatorProfileId: string },
): Promise<void> {
  await client.query(
    `WITH completion AS (
       SELECT (
         NULLIF(BTRIM(profile.display_name), '') IS NOT NULL
         AND NULLIF(BTRIM(profile.location_text), '') IS NOT NULL
         AND NULLIF(BTRIM(profile.short_description), '') IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM marketplace.creator_platforms platform
           WHERE platform.creator_profile_id = profile.id
             AND platform.organization_id = profile.organization_id
             AND NULLIF(BTRIM(platform.handle), '') IS NOT NULL
             AND platform.follower_count > 0
         )
       ) AS profile_complete
       FROM marketplace.creator_profiles profile
       WHERE profile.id::text = $1
         AND profile.organization_id::text = $2
     )
     UPDATE marketplace.creator_profiles profile
     SET profile_complete = completion.profile_complete,
         profile_completed_at = CASE
           WHEN completion.profile_complete THEN COALESCE(profile.profile_completed_at, now())
           ELSE NULL
         END,
         updated_at = now()
     FROM completion
     WHERE profile.id::text = $1
       AND profile.organization_id::text = $2`,
    [input.creatorProfileId, input.organizationId],
  );
}

function creatorProfileStatus(profile: CreatorProfileDocument): CreatorProfileStatusResult {
  const missingFields = creatorProfileMissingFields(profile);
  const missingPlatforms = !hasCompletePlatform(profile.platforms);
  return {
    creatorProfileId: profile.creatorProfileId,
    organizationId: profile.organizationId,
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
  if (missingPlatforms) steps.push("add_platform");
  return steps;
}

function hasCompletePlatform(platforms: CreatorProfilePlatform[]): boolean {
  return platforms.some((platform) => platform.handle.trim() && platform.followerCount > 0);
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
    for (const [index, platform] of body.platforms.entries()) {
      const parsed = parsePlatformInput(platform, index);
      if (!parsed.ok) return parsed;
      platforms.push(parsed.value);
    }
    patch.platforms = platforms;
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
  const handle = requiredString(raw.handle, `platforms[${index}].handle`);
  if (!handle.ok) return handle;
  const followerCount = nonNegativeNumber(raw.followerCount, `platforms[${index}].followerCount`);
  if (!followerCount.ok) return followerCount;
  const engagementRate = nonNegativeNumber(
    raw.engagementRate,
    `platforms[${index}].engagementRate`,
  );
  if (!engagementRate.ok) return engagementRate;
  const profileUrl = nullableHttpsUrl(raw.profileUrl, `platforms[${index}].profileUrl`);
  if (!profileUrl.ok) return profileUrl;
  const audienceCountries = audienceCountryArray(
    raw.audienceCountries,
    `platforms[${index}].audienceCountries`,
  );
  if (!audienceCountries.ok) return audienceCountries;
  const audienceAgeGroups = audienceAgeGroupArray(
    raw.audienceAgeGroups,
    `platforms[${index}].audienceAgeGroups`,
  );
  if (!audienceAgeGroups.ok) return audienceAgeGroups;
  const audienceGenderSplit = genderSplit(
    raw.audienceGenderSplit,
    `platforms[${index}].audienceGenderSplit`,
  );
  if (!audienceGenderSplit.ok) return audienceGenderSplit;

  return {
    ok: true,
    value: {
      platform: raw.platform as MarketplacePlatformName,
      handle: handle.value,
      profileUrl: profileUrl.value,
      followerCount: followerCount.value,
      engagementRate: engagementRate.value,
      audienceCountries: audienceCountries.value,
      audienceAgeGroups: audienceAgeGroups.value,
      audienceGenderSplit: audienceGenderSplit.value,
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
