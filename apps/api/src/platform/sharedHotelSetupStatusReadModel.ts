import { createHash } from "node:crypto";

import type {
  PropertyProfileContact,
  PropertyProfileMapDisplayMode,
  PublicPropertyProfileMedia,
  PublicPropertyProfilePatch,
} from "@vayada/domain-hotels";
import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  AdaptivePropertySetupFacts,
  AdaptiveSetupTaskFact,
  SharedHotelSetupStatusRepository,
  SharedPropertyProfile,
  SharedPropertyProfileInput,
  SharedPublicPropertyProfile,
  UpdatePublicPropertyProfileResult,
} from "../routes/sharedHotelSetupStatus.js";
import { syncPropertyOfferReadModels } from "../routes/marketplaceAdmin.js";
import {
  ACTIVE_PROPERTY_MEDIA_PUBLICATION_PREDICATE,
  APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE,
} from "./propertyMediaPublicationJob.js";

type SharedHotelSetupQueryClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

type SharedHotelSetupStatusPool = SharedHotelSetupQueryClient & {
  connect?(): Promise<SharedHotelSetupQueryClient & { release(): void }>;
  end(): Promise<void>;
};

type AdaptiveHotelSetupFactsRow = {
  propertyId: string;
  publicId: string;
  displayName: string | null;
  propertyType: string | null;
  city: string | null;
  countryCode: string | null;
  hasStreetAddress: boolean;
  hasPostalCode: boolean;
  hasCity: boolean;
  hasCountryCode: boolean;
  hasTimezone: boolean;
  hasEmail: boolean;
  hasPhone: boolean;
  propertyUpdatedAt: unknown;
  locationUpdatedAt: unknown;
  contactUpdatedAt: unknown;
  hasDescription: boolean;
  hasApprovedMedia: boolean;
  localityPublic: boolean;
  profileUpdatedAt: unknown;
  mediaUpdatedAt: unknown;
  marketplaceProfileStatus: string | null;
  marketplaceProfileComplete: boolean;
  marketplaceProfileDescriptionInSync: boolean;
  marketplaceProfileUpdatedAt: unknown;
  marketplaceOfferStatus: string | null;
  marketplaceOfferHasTitle: boolean;
  marketplaceOfferHasDeliverable: boolean;
  marketplaceOfferHasCompensation: boolean;
  marketplaceOfferHasRequirement: boolean;
  marketplaceOfferPublic: boolean;
  marketplaceOfferUpdatedAt: unknown;
  marketplaceOfferChildrenUpdatedAt: unknown;
  marketplaceOfferProjectedAt: unknown;
  marketplaceOfferProjectionFresh: boolean;
  hasActiveRoomType: boolean;
  hasNonRetiredRoom: boolean;
  hasActiveRatePlan: boolean;
  hasFutureInventory: boolean;
  roomTypeUpdatedAt: unknown;
  roomUpdatedAt: unknown;
  ratePlanUpdatedAt: unknown;
  inventoryUpdatedAt: unknown;
  hasCheckInPolicy: boolean;
  hasCheckOutPolicy: boolean;
  hasCancellationPolicy: boolean;
  policyUpdatedAt: unknown;
  billingPlanSelected: boolean;
  billingPlanUpdatedAt: unknown;
  paymentsEnabled: boolean | null;
  hasAcceptedPaymentMethod: boolean;
  hasEffectivePaymentMethod: boolean;
  paymentRequiresManualReview: boolean;
  paymentSettingsUpdatedAt: unknown;
  bookabilityStatus: string | null;
  bookabilityFreshness: string | null;
  bookabilitySetupReady: boolean;
  bookabilityMissingEmpty: boolean;
  bookabilityExpired: boolean;
  bookabilityUpdatedAt: unknown;
};

type SharedPropertyProfileRow = {
  propertyId: string;
  profileRevision: unknown;
  displayName: string | null;
  propertyType: string | null;
  countryCode: string | null;
  city: string | null;
  streetAddress: string | null;
  postalCode: string | null;
  timezone: string | null;
  latitude: unknown;
  longitude: unknown;
  localityPublic: boolean | null;
  geoPublic: boolean | null;
  mapDisplayMode: string | null;
  contacts: unknown;
};

type PropertyProfileWriteRow = {
  propertyId: string;
};

type PropertyCreateIdempotencyRow = {
  status: string;
  requestFingerprintHash: string;
  propertyId: string | null;
};

type PublicPropertyProfileRow = {
  propertyId: string;
  profileRevision: unknown;
  locale: string;
  shortDescription: string | null;
  longDescription: string | null;
  media: unknown;
};

type LockedPublicPropertyRow = {
  profileRevision: unknown;
  locale: string;
};

type ApprovedPropertyMediaRow = {
  mediaObjectId: string;
  mediaType: PublicPropertyProfileMedia["mediaType"];
  url: string;
};

type SharedPropertyProfileWritePayload = {
  display_name: string;
  property_type: SharedPropertyProfileInput["propertyType"];
  country_code: string;
  city: string;
  street_address: string;
  postal_code: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  address_public: boolean;
  geo_public: boolean;
  map_display_mode: SharedPropertyProfileInput["location"]["mapDisplayMode"];
  contacts: Array<{
    channel_type: SharedPropertyProfileInput["contacts"][number]["channelType"];
    value: string;
    purpose: SharedPropertyProfileInput["contacts"][number]["purpose"];
    is_public: boolean;
  }>;
};

export function createPgSharedHotelSetupStatusRepository(config: {
  connectionString: string;
  max?: number;
  pool?: SharedHotelSetupStatusPool;
}): SharedHotelSetupStatusRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Shared hotel setup status repository connectionString must not be empty");
  }

  const ownsPool = config.pool === undefined;
  const pool = (config.pool ??
    new pg.Pool({
      connectionString: config.connectionString,
      max: config.max,
    })) as SharedHotelSetupStatusPool;

  return {
    async getHotelSetupStatus({ organizationId, propertyIds }) {
      const hotelGroup = await pool.query<{ displayName: string; websiteUrl: string | null }>(
        `SELECT name AS "displayName", website_url AS "websiteUrl"
         FROM identity.organizations
         WHERE id = $1::uuid
           AND kind = 'hotel_group'
           AND status = 'active'
         LIMIT 1`,
        [organizationId],
      );
      if (propertyIds.length === 0) {
        return {
          hotelGroupDisplayName: hotelGroup.rows[0]?.displayName ?? null,
          hotelGroupWebsiteUrl: hotelGroup.rows[0]?.websiteUrl ?? null,
          properties: [],
        };
      }

      const result = await pool.query<AdaptiveHotelSetupFactsRow>(adaptiveHotelSetupFactsSql(), [
        organizationId,
        propertyIds,
      ]);

      return {
        hotelGroupDisplayName: hotelGroup.rows[0]?.displayName ?? null,
        hotelGroupWebsiteUrl: hotelGroup.rows[0]?.websiteUrl ?? null,
        properties: result.rows.map(toAdaptivePropertySetupFacts),
      };
    },
    async getPropertyProfile({ organizationId, propertyId }) {
      return loadPropertyProfile(pool, organizationId, propertyId);
    },
    async createPropertyProfile(input) {
      const propertyId = await writePropertyProfile(pool, {
        ...input,
        mode: "create",
      });
      if (!propertyId) {
        throw new Error("Created shared property profile did not return a property id");
      }
      const created = await loadPropertyProfile(pool, input.organizationId, propertyId);
      if (!created) {
        throw new Error("Created shared property profile could not be loaded");
      }
      return created;
    },
    async updatePropertyProfile({ organizationId, propertyId, expectedProfileRevision, profile }) {
      const updatedPropertyId = await writePropertyProfile(pool, {
        organizationId,
        propertyId,
        expectedProfileRevision,
        profile,
        mode: "update",
      });
      if (!updatedPropertyId) return null;
      return loadPropertyProfile(pool, organizationId, updatedPropertyId);
    },
    async getPublicPropertyProfile({ organizationId, propertyId }) {
      return loadPublicPropertyProfile(pool, organizationId, propertyId);
    },
    async updatePublicPropertyProfile(input) {
      return writePublicPropertyProfile(pool, input);
    },
    async close() {
      if (ownsPool) {
        await pool.end();
      }
    },
  };
}

async function loadPropertyProfile(
  pool: SharedHotelSetupStatusPool,
  organizationId: string,
  propertyId: string,
): Promise<SharedPropertyProfile | null> {
  const result = await pool.query<SharedPropertyProfileRow>(propertyProfileSql(), [
    organizationId,
    propertyId,
  ]);
  const row = result.rows[0];
  return row ? toSharedPropertyProfile(row) : null;
}

async function loadPublicPropertyProfile(
  queryable: SharedHotelSetupQueryClient,
  organizationId: string,
  propertyId: string,
): Promise<SharedPublicPropertyProfile | null> {
  const result = await queryable.query<PublicPropertyProfileRow>(publicPropertyProfileSql(), [
    organizationId,
    propertyId,
  ]);
  const row = result.rows[0];
  return row ? toPublicPropertyProfile(row) : null;
}

async function writePublicPropertyProfile(
  pool: SharedHotelSetupStatusPool,
  input: {
    organizationId: string;
    propertyId: string;
    expectedProfileRevision: number;
    patch: PublicPropertyProfilePatch;
  },
): Promise<UpdatePublicPropertyProfileResult> {
  if (!pool.connect) {
    throw new Error("Public property profile writes require a transactional database pool");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<LockedPublicPropertyRow>(
      `SELECT
         property.profile_revision AS "profileRevision",
         property.default_locale AS locale
       FROM hotel_catalog.properties property
       JOIN identity.organization_resource_links link
         ON link.organization_id = $1::uuid
        AND link.product = 'hotel_catalog'
        AND link.resource_type = 'property'
        AND link.resource_id = property.id::text
        AND link.relationship IN ('owner', 'operator')
        AND link.status = 'active'
       WHERE property.id = $2::uuid
       FOR UPDATE OF property`,
      [input.organizationId, input.propertyId],
    );
    const property = locked.rows[0];
    if (!property) {
      await client.query("ROLLBACK");
      return { status: "not_found" };
    }
    const currentRevision = positiveInteger(property.profileRevision);
    if (currentRevision !== input.expectedProfileRevision) {
      await client.query("ROLLBACK");
      return { status: "conflict", currentRevision };
    }

    if (input.patch.media !== undefined) {
      const pendingMediaCommand = await client.query(
        `SELECT job.id
         FROM platform.jobs job
         WHERE ${ACTIVE_PROPERTY_MEDIA_PUBLICATION_PREDICATE}
         LIMIT 1
         FOR UPDATE`,
        [input.propertyId],
      );
      if (pendingMediaCommand.rows.length > 0) {
        await client.query("ROLLBACK");
        return { status: "command_in_progress" };
      }
    }

    let approvedMedia: ApprovedPropertyMediaRow[] = [];
    if (input.patch.media !== undefined && input.patch.media.length > 0) {
      const mediaObjectIds = input.patch.media.map(({ mediaObjectId }) => mediaObjectId);
      const approved = await client.query<ApprovedPropertyMediaRow>(
        `SELECT
           media.id::text AS "mediaObjectId",
           CASE media.purpose
             WHEN 'property.hero_image' THEN 'hero_image'
             WHEN 'property.logo' THEN 'logo'
             ELSE 'gallery_image'
           END AS "mediaType",
           variant.public_cdn_url AS url
         FROM platform.media_objects media
         JOIN platform.media_variants variant
           ON variant.media_object_id = media.id
          AND variant.variant_name = 'original_safe'
          AND variant.visibility = 'public'
          AND NULLIF(variant.public_cdn_url, '') IS NOT NULL
         WHERE media.id = ANY($2::uuid[])
           AND media.property_id = $1::uuid
           AND media.purpose IN (
             'property.hero_image',
             'property.gallery_image',
             'property.logo'
           )
           AND media.visibility = 'public'
           AND media.public_approved = TRUE
           AND media.lifecycle_status = 'active'
         FOR SHARE OF media`,
        [input.propertyId, mediaObjectIds],
      );
      approvedMedia = approved.rows;
      const validIds = new Set(approvedMedia.map(({ mediaObjectId }) => mediaObjectId));
      const invalidIds = mediaObjectIds.filter((mediaObjectId) => !validIds.has(mediaObjectId));
      if (invalidIds.length > 0) {
        await client.query("ROLLBACK");
        return { status: "invalid_media", mediaObjectIds: invalidIds };
      }
    }

    if (
      Object.hasOwn(input.patch, "shortDescription") ||
      Object.hasOwn(input.patch, "longDescription")
    ) {
      await client.query(
        `INSERT INTO hotel_catalog.property_profiles (
           property_id,
           locale,
           short_description,
           long_description,
           source_confidence,
           updated_at
         )
         VALUES (
           $1::uuid,
           $2,
           CASE WHEN $3::boolean THEN $4::text ELSE NULL END,
           CASE WHEN $5::boolean THEN $6::text ELSE NULL END,
           'verified',
           now()
         )
         ON CONFLICT (property_id, locale) DO UPDATE
         SET short_description = CASE
               WHEN $3::boolean THEN EXCLUDED.short_description
               ELSE hotel_catalog.property_profiles.short_description
             END,
             long_description = CASE
               WHEN $5::boolean THEN EXCLUDED.long_description
               ELSE hotel_catalog.property_profiles.long_description
             END,
             source_confidence = 'verified',
             updated_at = now()`,
        [
          input.propertyId,
          property.locale,
          Object.hasOwn(input.patch, "shortDescription"),
          input.patch.shortDescription ?? null,
          Object.hasOwn(input.patch, "longDescription"),
          input.patch.longDescription ?? null,
        ],
      );
    }

    if (input.patch.media !== undefined) {
      await replacePublicPropertyMedia(client, input.propertyId, input.patch.media, approvedMedia);
    }

    await advancePublicProfileRevision(client, input.propertyId);
    await syncPropertyOfferReadModels(client, {
      propertyId: input.propertyId,
    });
    const updated = await loadPublicPropertyProfile(client, input.organizationId, input.propertyId);
    if (!updated) throw new Error("Updated public property profile could not be loaded");
    await client.query("COMMIT");
    return { status: "updated", profile: updated };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function replacePublicPropertyMedia(
  client: SharedHotelSetupQueryClient,
  propertyId: string,
  mediaPatch: NonNullable<PublicPropertyProfilePatch["media"]>,
  approvedMedia: ApprovedPropertyMediaRow[],
): Promise<void> {
  await client.query(
    `UPDATE hotel_catalog.property_media
     SET public_approved = FALSE,
         updated_at = now()
     WHERE property_id = $1::uuid
       AND public_approved = TRUE`,
    [propertyId],
  );
  if (mediaPatch.length === 0) return;

  const presentation = new Map(mediaPatch.map((item) => [item.mediaObjectId, item] as const));
  const payload = approvedMedia.map((media) => {
    const item = presentation.get(media.mediaObjectId)!;
    return {
      media_object_id: media.mediaObjectId,
      media_type: media.mediaType,
      url: media.url,
      alt_text: item.altText,
      sort_order: item.sortOrder,
    };
  });
  await client.query(
    `WITH media_input AS (
       SELECT *
       FROM jsonb_to_recordset($2::jsonb) AS input(
         media_object_id uuid,
         media_type text,
         url text,
         alt_text text,
         sort_order integer
       )
     ),
     updated AS (
       UPDATE hotel_catalog.property_media media
       SET media_type = input.media_type,
           url = input.url,
           alt_text = input.alt_text,
           sort_order = input.sort_order,
           source_system = 'platform',
           public_approved = TRUE,
           rights_metadata = COALESCE(media.rights_metadata, '{}'::jsonb)
             || jsonb_build_object('platformMediaObjectId', input.media_object_id),
           updated_at = now()
       FROM media_input input
       WHERE media.property_id = $1::uuid
         AND media.platform_media_object_id = input.media_object_id
       RETURNING media.platform_media_object_id
     )
     INSERT INTO hotel_catalog.property_media (
       property_id,
       media_type,
       url,
       alt_text,
       sort_order,
       source_system,
       public_approved,
       rights_metadata,
       platform_media_object_id,
       updated_at
     )
     SELECT
       $1::uuid,
       input.media_type,
       input.url,
       input.alt_text,
       input.sort_order,
       'platform',
       TRUE,
       jsonb_build_object('platformMediaObjectId', input.media_object_id),
       input.media_object_id,
       now()
     FROM media_input input
     WHERE NOT EXISTS (
       SELECT 1
       FROM updated
       WHERE updated.platform_media_object_id = input.media_object_id
     )`,
    [propertyId, JSON.stringify(payload)],
  );
}

export async function advancePublicProfileRevision(
  client: SharedHotelSetupQueryClient,
  propertyId: string,
): Promise<void> {
  return updatePublicProfileCompleteness(client, propertyId, true);
}

async function updatePublicProfileCompleteness(
  client: SharedHotelSetupQueryClient,
  propertyId: string,
  advanceRevision: boolean,
): Promise<void> {
  await client.query(
    `WITH completeness AS (
       SELECT
         property.id AS property_id,
         ARRAY_REMOVE(
           ARRAY[
             CASE WHEN NOT EXISTS (
               SELECT 1
               FROM hotel_catalog.property_profiles profile
               WHERE profile.property_id = property.id
                 AND profile.locale = property.default_locale
                 AND COALESCE(
                   NULLIF(BTRIM(profile.short_description), ''),
                   NULLIF(BTRIM(profile.long_description), '')
                 ) IS NOT NULL
             ) THEN 'description' END,
             CASE WHEN NOT EXISTS (
               SELECT 1
               FROM hotel_catalog.property_media media
               JOIN platform.media_objects media_object
                 ON media_object.id = media.platform_media_object_id
                AND media_object.property_id = media.property_id
                AND media_object.visibility = 'public'
                AND media_object.public_approved = TRUE
                AND media_object.lifecycle_status = 'active'
               JOIN platform.media_variants variant
                 ON variant.media_object_id = media_object.id
                AND variant.variant_name = 'original_safe'
                AND variant.visibility = 'public'
                AND NULLIF(variant.public_cdn_url, '') IS NOT NULL
               WHERE media.property_id = property.id
                 AND media.public_approved = TRUE
                 AND media.source_system = 'platform'
             ) THEN 'media' END
           ]::text[],
           NULL
         ) AS reasons
       FROM hotel_catalog.properties property
       WHERE property.id = $1::uuid
     )
     UPDATE hotel_catalog.properties property
     SET completeness_reasons = completeness.reasons,
         profile_status = CASE
           WHEN property.profile_status IN ('disabled', 'private') THEN property.profile_status
           WHEN cardinality(completeness.reasons) = 0 THEN 'complete'
           ELSE 'incomplete'
         END,
         profile_revision = property.profile_revision + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
         updated_at = now()
     FROM completeness
     WHERE property.id = completeness.property_id`,
    [propertyId, advanceRevision],
  );
}

async function writePropertyProfile(
  pool: SharedHotelSetupStatusPool,
  input:
    | {
        mode: "create";
        organizationId: string;
        idempotencyKey: string;
        correlationId: string;
        profile: SharedPropertyProfileInput;
        audit?: { actorUserId: string; requestId: string; receivedAt: string; reason?: string };
        targetAccountUserId?: string;
        provisioningReference?: string;
      }
    | {
        mode: "update";
        organizationId: string;
        propertyId: string;
        expectedProfileRevision: number;
        profile: SharedPropertyProfileInput;
      },
): Promise<string | null> {
  const payload = propertyProfileWritePayload(input.profile);
  if (input.mode === "create") {
    if (!pool.connect) {
      throw new Error("Property creation requires a transactional database pool");
    }
    const client = await pool.connect();
    const keyHash = sha256(input.idempotencyKey);
    const fingerprint = sha256(
      JSON.stringify({
        organizationId: input.organizationId,
        targetAccountUserId: input.targetAccountUserId ?? null,
        provisioningReference: input.provisioningReference ?? null,
        reason: input.audit?.reason ?? null,
        profile: payload,
      }),
    );
    try {
      await client.query("BEGIN");
      const organization = await client.query(
        `SELECT id
         FROM identity.organizations
         WHERE id = $1::uuid
           AND kind = 'hotel_group'
           AND status = 'active'
           AND ($2::uuid IS NULL OR EXISTS (
             SELECT 1 FROM identity.organization_memberships membership
             JOIN identity.users account ON account.id = membership.user_id
             WHERE membership.organization_id = identity.organizations.id
               AND membership.user_id = $2::uuid
               AND membership.status = 'active' AND account.status = 'active'
           ))
         FOR UPDATE`,
        [input.organizationId, input.targetAccountUserId ?? null],
      );
      if (organization.rows.length !== 1) {
        throw new Error("Active hotel-group organization was not found");
      }
      if (input.provisioningReference) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          input.provisioningReference,
        ]);
      }
      const replay = await findPropertyCreateReplay(
        client,
        input.organizationId,
        keyHash,
        fingerprint,
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      const provisionedPropertyId = input.provisioningReference
        ? await findProvisionedProperty(
            client,
            input.organizationId,
            input.provisioningReference,
            input.targetAccountUserId ?? null,
            fingerprint,
          )
        : null;
      const idempotencyId = await reservePropertyCreate(
        client,
        input.organizationId,
        input.correlationId,
        keyHash,
        fingerprint,
      );
      if (!idempotencyId) {
        const concurrentReplay = await findPropertyCreateReplay(
          client,
          input.organizationId,
          keyHash,
          fingerprint,
        );
        if (!concurrentReplay) throw propertyCreateConflict("command_in_progress");
        await client.query("COMMIT");
        return concurrentReplay;
      }
      if (provisionedPropertyId) {
        await completePropertyCreate(client, idempotencyId, provisionedPropertyId);
        await client.query("COMMIT");
        return provisionedPropertyId;
      }
      const result = await client.query<PropertyProfileWriteRow>(createPropertyProfileSql(), [
        input.organizationId,
        payload,
      ]);
      const propertyId = result.rows[0]?.propertyId;
      if (!propertyId)
        throw new Error("Created shared property profile did not return a property id");
      if (input.provisioningReference) {
        await linkProvisioningReference(client, {
          propertyId,
          provisioningReference: input.provisioningReference,
          targetAccountUserId: input.targetAccountUserId ?? null,
          fingerprint,
        });
      }
      if (input.audit) {
        await auditPropertyCreate(client, input, idempotencyId, propertyId);
      }
      await completePropertyCreate(client, idempotencyId, propertyId);
      await client.query("COMMIT");
      return propertyId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  if (input.mode === "update" && pool.connect) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<PropertyProfileWriteRow>(updatePropertyProfileSql(), [
        input.organizationId,
        input.propertyId,
        payload,
        input.expectedProfileRevision,
      ]);
      const propertyId = result.rows[0]?.propertyId ?? null;
      if (propertyId) {
        await syncPropertyOfferReadModels(client, {
          propertyId,
        });
      }
      await client.query("COMMIT");
      return propertyId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const result = await pool.query<PropertyProfileWriteRow>(updatePropertyProfileSql(), [
    input.organizationId,
    input.propertyId,
    payload,
    input.expectedProfileRevision,
  ]);

  return result.rows[0]?.propertyId ?? null;
}

async function findPropertyCreateReplay(
  client: SharedHotelSetupQueryClient,
  organizationId: string,
  keyHash: string,
  fingerprint: string,
): Promise<string | null> {
  const result = await client.query<PropertyCreateIdempotencyRow>(
    `SELECT
       status,
       request_fingerprint_hash AS "requestFingerprintHash",
       response_resource_id AS "propertyId"
     FROM platform.idempotency_keys
     WHERE operation_scope = 'hotel_catalog'
       AND operation = 'hotel_setup.property.create'
       AND key_hash = $1
       AND tenant_scope = 'organization'
       AND organization_id = $2::uuid
     FOR UPDATE`,
    [keyHash, organizationId],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (existing.requestFingerprintHash !== fingerprint) {
    throw propertyCreateConflict("idempotency_key_conflict", existing.propertyId ?? undefined);
  }
  if (existing.status !== "completed" || !existing.propertyId) {
    throw propertyCreateConflict("command_in_progress");
  }
  return existing.propertyId;
}

async function findProvisionedProperty(
  client: SharedHotelSetupQueryClient,
  organizationId: string,
  provisioningReference: string,
  targetAccountUserId: string | null,
  fingerprint: string,
): Promise<string | null> {
  const result = await client.query<{
    propertyId: string;
    belongsToOrganization: boolean;
    targetAccountUserId: string | null;
    fingerprint: string | null;
  }>(
    `SELECT source.property_id::text AS "propertyId",
       source.metadata ->> 'targetAccountUserId' AS "targetAccountUserId",
       source.metadata ->> 'requestFingerprint' AS fingerprint,
       EXISTS (
         SELECT 1 FROM identity.organization_resource_links owner_link
         WHERE owner_link.organization_id = $1::uuid
           AND owner_link.product = 'hotel_catalog'
           AND owner_link.resource_type = 'property'
           AND owner_link.resource_id = source.property_id::text
           AND owner_link.relationship = 'owner' AND owner_link.status = 'active'
       ) AS "belongsToOrganization"
     FROM hotel_catalog.property_source_links source
     WHERE source.source_system = 'platform'
       AND source.source_table = 'platform_admin_provisioning'
       AND source.source_id = $2
       AND source.status = 'active'`,
    [organizationId, provisioningReference],
  );
  const existing = result.rows[0];
  if (!existing) return null;
  if (
    !existing.belongsToOrganization ||
    existing.targetAccountUserId !== targetAccountUserId ||
    existing.fingerprint !== fingerprint
  ) {
    throw propertyCreateConflict("provisioning_reference_conflict", existing.propertyId);
  }
  return existing.propertyId;
}

async function linkProvisioningReference(
  client: SharedHotelSetupQueryClient,
  input: {
    propertyId: string;
    provisioningReference: string;
    targetAccountUserId: string | null;
    fingerprint: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO hotel_catalog.property_source_links (
       property_id, source_system, source_table, source_id, relationship, status, metadata
     ) VALUES (
       $1::uuid, 'platform', 'platform_admin_provisioning', $2, 'canonical_input', 'active',
       jsonb_build_object('targetAccountUserId', $3::text, 'requestFingerprint', $4::text)
     )`,
    [input.propertyId, input.provisioningReference, input.targetAccountUserId, input.fingerprint],
  );
}

async function auditPropertyCreate(
  client: SharedHotelSetupQueryClient,
  input: {
    organizationId: string;
    correlationId: string;
    audit?: { actorUserId: string; requestId: string; receivedAt: string; reason?: string };
    targetAccountUserId?: string;
    provisioningReference?: string;
  },
  idempotencyId: string,
  propertyId: string,
): Promise<void> {
  if (!input.audit) return;
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, organization_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, private_payload, audit_metadata, privacy_scope
     ) VALUES ($1, 'hotel_catalog', 'hotel_setup.property.create', $2::timestamptz,
       'organization', $3::uuid, 'user', $5::uuid, 'hotel_catalog', 'property', $4,
       $6::uuid, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, 'confidential')`,
    [
      `hotel-setup-property-create:${idempotencyId}`,
      input.audit.receivedAt,
      input.organizationId,
      propertyId,
      input.audit.actorUserId,
      idempotencyId,
      input.correlationId,
      input.audit.requestId,
      JSON.stringify({ outcome: "created" }),
      JSON.stringify({
        targetAccountUserId: input.targetAccountUserId ?? null,
        provisioningReference: input.provisioningReference ?? null,
        reason: input.audit.reason ?? null,
      }),
      JSON.stringify({ organizationId: input.organizationId }),
    ],
  );
}

async function reservePropertyCreate(
  client: SharedHotelSetupQueryClient,
  organizationId: string,
  correlationId: string,
  keyHash: string,
  fingerprint: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope,
       operation,
       key_hash,
       request_fingerprint_hash,
       tenant_scope,
       organization_id,
       correlation_id,
       expires_at
     )
     VALUES (
       'hotel_catalog',
       'hotel_setup.property.create',
       $1,
       $2,
       'organization',
       $3::uuid,
       $4,
       now() + interval '24 hours'
     )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [keyHash, fingerprint, organizationId, correlationId],
  );
  return result.rows[0]?.id ?? null;
}

async function completePropertyCreate(
  client: SharedHotelSetupQueryClient,
  idempotencyId: string,
  propertyId: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `UPDATE platform.idempotency_keys
     SET status = 'completed',
         response_status_code = 201,
         response_resource_product = 'hotel_catalog',
         response_resource_type = 'property',
         response_resource_id = $2,
         completed_at = now(),
         last_seen_at = now()
     WHERE id = $1::uuid
       AND status = 'in_progress'
     RETURNING id`,
    [idempotencyId, propertyId],
  );
  if (!result.rows[0]) throw new Error("Property creation idempotency completion failed");
}

function propertyCreateConflict(
  code: "idempotency_key_conflict" | "command_in_progress" | "provisioning_reference_conflict",
  propertyId?: string,
): Error & { code: string; propertyId?: string } {
  return Object.assign(new Error(code), { code, ...(propertyId ? { propertyId } : {}) });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toSharedPropertyProfile(row: SharedPropertyProfileRow): SharedPropertyProfile {
  return {
    propertyId: row.propertyId,
    profileRevision: positiveInteger(row.profileRevision),
    profile: {
      displayName: nonEmpty(row.displayName) ?? "",
      propertyType: nonEmpty(row.propertyType) ?? "",
      location: {
        countryCode: nonEmpty(row.countryCode) ?? "",
        city: nonEmpty(row.city) ?? "",
        streetAddress: nonEmpty(row.streetAddress) ?? "",
        postalCode: nonEmpty(row.postalCode) ?? "",
        timezone: nonEmpty(row.timezone) ?? "",
        latitude: numberOrNull(row.latitude),
        longitude: numberOrNull(row.longitude),
        localityPublic: row.localityPublic ?? false,
        geoPublic: row.geoPublic ?? false,
        mapDisplayMode: mapDisplayMode(row.mapDisplayMode),
      },
      contacts: contactItems(row.contacts),
    },
  };
}

function toPublicPropertyProfile(row: PublicPropertyProfileRow): SharedPublicPropertyProfile {
  return {
    propertyId: row.propertyId,
    profileRevision: positiveInteger(row.profileRevision),
    publicProfile: {
      locale: nonEmpty(row.locale) ?? "en",
      shortDescription: nonEmpty(row.shortDescription),
      longDescription: nonEmpty(row.longDescription),
      media: publicPropertyMediaItems(row.media),
    },
  };
}

function toAdaptivePropertySetupFacts(row: AdaptiveHotelSetupFactsRow): AdaptivePropertySetupFacts {
  const identityReasons = [
    !nonEmpty(row.displayName) && "missing_display_name",
    !nonEmpty(row.propertyType) && "missing_property_type",
    !row.hasStreetAddress && "missing_street_address",
    !row.hasPostalCode && "missing_postal_code",
    !row.hasCity && "missing_city",
    !row.hasCountryCode && "missing_country_code",
    !row.hasTimezone && "missing_timezone",
    !row.hasEmail && "missing_email_contact",
    !row.hasPhone && "missing_phone_contact",
  ].filter(isReasonCode);
  const publicProfileReasons = [
    !row.hasDescription && "missing_default_locale_description",
    !row.hasApprovedMedia && "missing_public_media",
    !row.localityPublic && "missing_public_locality_consent",
  ].filter(isReasonCode);
  const roomReasons = [
    !row.hasActiveRoomType && "missing_active_room_type",
    !row.hasNonRetiredRoom && "missing_non_retired_room",
    !row.hasActiveRatePlan && "missing_active_rate_plan",
    !row.hasFutureInventory && "missing_future_inventory",
  ].filter(isReasonCode);
  const policyReasons = [
    !row.hasCheckInPolicy && "missing_check_in_policy",
    !row.hasCheckOutPolicy && "missing_check_out_policy",
    !row.hasCancellationPolicy && "missing_cancellation_policy",
  ].filter(isReasonCode);

  return {
    propertyId: row.propertyId,
    publicId: row.publicId,
    displayName: nonEmpty(row.displayName),
    locationSummary:
      [nonEmpty(row.city), nonEmpty(row.countryCode)].filter(Boolean).join(", ") || null,
    taskFacts: {
      shared_identity: basicTaskFact(
        "shared_identity",
        identityReasons,
        Boolean(nonEmpty(row.displayName)),
        latest(row.propertyUpdatedAt, row.locationUpdatedAt, row.contactUpdatedAt),
      ),
      public_profile: publicProfileFact(row, publicProfileReasons),
      creator_offer: creatorOfferFact(row),
      rooms_rates_availability: basicTaskFact(
        "rooms_rates_availability",
        roomReasons,
        row.hasActiveRoomType ||
          row.hasNonRetiredRoom ||
          row.hasActiveRatePlan ||
          row.hasFutureInventory,
        latest(
          row.roomTypeUpdatedAt,
          row.roomUpdatedAt,
          row.ratePlanUpdatedAt,
          row.inventoryUpdatedAt,
        ),
      ),
      guest_settings_policies: basicTaskFact(
        "guest_settings_policies",
        policyReasons,
        Boolean(row.policyUpdatedAt),
        toIsoString(row.policyUpdatedAt),
      ),
      billing_plan: basicTaskFact(
        "billing_plan",
        row.billingPlanSelected ? [] : ["billing_plan_not_selected"],
        row.billingPlanSelected,
        toIsoString(row.billingPlanUpdatedAt),
      ),
      payment: paymentFact(row),
      direct_booking_publication: publicationFact(row),
    },
  };
}

function basicTaskFact(
  taskId: AdaptiveSetupTaskFact["taskId"],
  reasonCodes: string[],
  started: boolean,
  sourceRevision: string | null,
): AdaptiveSetupTaskFact {
  const complete = reasonCodes.length === 0;
  return {
    taskId,
    ownerProgress: complete ? "owner_complete" : started ? "in_progress" : "not_started",
    readiness: complete ? "complete" : "actionable",
    reasonCodes,
    sourceRevision: taskRevision(sourceRevision, reasonCodes),
    freshness: "fresh",
  };
}

function publicProfileFact(
  row: AdaptiveHotelSetupFactsRow,
  canonicalReasons: string[],
): AdaptiveSetupTaskFact {
  const status = row.marketplaceProfileStatus;
  const marketplaceComplete = row.marketplaceProfileComplete === true;
  const marketplaceDescriptionInSync = row.marketplaceProfileDescriptionInSync === true;
  const canonicalComplete = canonicalReasons.length === 0;
  const canonicalStarted = row.hasDescription || row.hasApprovedMedia || row.localityPublic;
  const readiness =
    status === "rejected"
      ? "rejected"
      : status === "suspended" || status === "archived"
        ? "blocked"
        : status === "pending" &&
            marketplaceComplete &&
            marketplaceDescriptionInSync &&
            canonicalComplete
          ? "pending_review"
          : status === "verified" &&
              marketplaceComplete &&
              marketplaceDescriptionInSync &&
              canonicalComplete
            ? "complete"
            : "actionable";
  const actionableReasons = [
    ...canonicalReasons,
    !status && "marketplace_profile_not_started",
    status !== null &&
      (!marketplaceComplete || (status !== "pending" && status !== "verified")) &&
      "marketplace_profile_incomplete",
    row.hasDescription &&
      marketplaceComplete &&
      !marketplaceDescriptionInSync &&
      "marketplace_profile_description_out_of_sync",
  ].filter(isReasonCode);
  return {
    taskId: "public_profile",
    ownerProgress:
      readiness === "complete" || readiness === "pending_review"
        ? "owner_complete"
        : canonicalStarted || status !== null
          ? "in_progress"
          : "not_started",
    readiness,
    reasonCodes:
      readiness === "complete"
        ? []
        : readiness === "actionable"
          ? actionableReasons
          : [...canonicalReasons, `marketplace_profile_${status}`],
    sourceRevision: taskRevision(
      latest(
        row.profileUpdatedAt,
        row.mediaUpdatedAt,
        row.locationUpdatedAt,
        row.marketplaceProfileUpdatedAt,
      ),
      status,
      marketplaceComplete,
      canonicalReasons,
      marketplaceDescriptionInSync,
    ),
    freshness: "fresh",
  };
}

function creatorOfferFact(row: AdaptiveHotelSetupFactsRow): AdaptiveSetupTaskFact {
  const status = row.marketplaceOfferStatus;
  const structuralReasons = [
    !row.marketplaceOfferHasTitle && "missing_offer_title",
    !row.marketplaceOfferHasDeliverable && "missing_offer_deliverable",
    !row.marketplaceOfferHasCompensation && "missing_offer_compensation",
    !row.marketplaceOfferHasRequirement && "missing_offer_requirement",
  ].filter(isReasonCode);
  if (!status) {
    return basicTaskFact(
      "creator_offer",
      ["creator_offer_not_started"],
      false,
      latest(row.marketplaceOfferUpdatedAt, row.marketplaceOfferChildrenUpdatedAt),
    );
  }
  const structurallyComplete = structuralReasons.length === 0;
  const projectionReady =
    row.marketplaceOfferPublic === true && row.marketplaceOfferProjectionFresh === true;
  const readiness =
    status === "rejected"
      ? "rejected"
      : status === "suspended" || status === "archived"
        ? "blocked"
        : status === "pending" && structurallyComplete
          ? "pending_review"
          : status === "verified" && structurallyComplete && projectionReady
            ? "complete"
            : status === "verified" && structurallyComplete && row.marketplaceOfferPublic !== true
              ? "blocked"
              : status === "verified" &&
                  structurallyComplete &&
                  !row.marketplaceOfferProjectionFresh
                ? "pending_sync"
                : "actionable";
  return {
    taskId: "creator_offer",
    ownerProgress:
      structurallyComplete && (status === "pending" || status === "verified")
        ? "owner_complete"
        : "in_progress",
    readiness,
    reasonCodes:
      readiness === "complete"
        ? []
        : readiness === "actionable"
          ? structuralReasons.length > 0
            ? structuralReasons
            : ["creator_offer_not_submitted"]
          : readiness === "blocked" && status === "verified"
            ? ["creator_offer_not_public"]
            : [`creator_offer_${readiness}`],
    sourceRevision: taskRevision(
      latest(
        row.marketplaceOfferUpdatedAt,
        row.marketplaceOfferChildrenUpdatedAt,
        row.marketplaceOfferProjectedAt,
      ),
      status,
      structuralReasons,
      row.marketplaceOfferPublic,
      row.marketplaceOfferProjectionFresh,
    ),
    freshness:
      status === "verified" && structurallyComplete && !row.marketplaceOfferProjectionFresh
        ? "stale"
        : "fresh",
  };
}

function paymentFact(row: AdaptiveHotelSetupFactsRow): AdaptiveSetupTaskFact {
  const enabled = row.paymentsEnabled === true;
  const configured = enabled && row.hasAcceptedPaymentMethod;
  const paymentEffective = enabled && row.hasEffectivePaymentMethod;
  const pendingReview = paymentEffective && row.paymentRequiresManualReview;
  const complete = paymentEffective && !row.paymentRequiresManualReview;
  return {
    taskId: "payment",
    ownerProgress: paymentEffective ? "owner_complete" : configured ? "in_progress" : "not_started",
    readiness: complete ? "complete" : pendingReview ? "pending_review" : "actionable",
    reasonCodes: complete
      ? []
      : unique([
          !enabled ? "payments_not_enabled" : "",
          enabled && !row.hasAcceptedPaymentMethod ? "missing_accepted_payment_method" : "",
          enabled && row.hasAcceptedPaymentMethod && !row.hasEffectivePaymentMethod
            ? "no_supported_checkout_payment_method"
            : "",
          pendingReview ? "manual_payment_review_pending" : "",
        ]).filter(isReasonCode),
    sourceRevision: taskRevision(
      toIsoString(row.paymentSettingsUpdatedAt),
      enabled,
      row.hasAcceptedPaymentMethod,
      row.hasEffectivePaymentMethod,
      row.paymentRequiresManualReview,
    ),
    freshness: "fresh",
  };
}

function publicationFact(row: AdaptiveHotelSetupFactsRow): AdaptiveSetupTaskFact {
  const status = row.bookabilityStatus;
  const isPublic = status === "public";
  const projectionFresh = row.bookabilityFreshness === "fresh" && !row.bookabilityExpired;
  const setupComplete = row.bookabilitySetupReady && row.bookabilityMissingEmpty;
  const complete = isPublic && projectionFresh && setupComplete;
  const readiness = complete
    ? "complete"
    : status === null || !setupComplete
      ? "actionable"
      : status === "unavailable"
        ? "blocked"
        : "pending_sync";
  return {
    taskId: "direct_booking_publication",
    ownerProgress: setupComplete ? "owner_complete" : status ? "in_progress" : "not_started",
    readiness,
    reasonCodes:
      readiness === "complete"
        ? []
        : unique([
            !isPublic ? "direct_booking_not_public" : "",
            row.bookabilityFreshness !== "fresh" ? "bookability_stale" : "",
            row.bookabilityExpired ? "bookability_expired" : "",
            !row.bookabilitySetupReady ? "bookability_setup_not_ready" : "",
            !row.bookabilityMissingEmpty ? "bookability_setup_missing" : "",
          ]).filter(isReasonCode),
    sourceRevision: taskRevision(
      toIsoString(row.bookabilityUpdatedAt),
      status,
      row.bookabilityFreshness,
      row.bookabilitySetupReady,
      row.bookabilityMissingEmpty,
      row.bookabilityExpired,
    ),
    freshness: status === null || projectionFresh ? "fresh" : "stale",
  };
}

function isReasonCode(value: string | false): value is string {
  return typeof value === "string" && value.length > 0;
}

function taskRevision(...facts: unknown[]): string {
  return JSON.stringify(facts);
}

function propertyProfileWritePayload(
  profile: SharedPropertyProfileInput,
): SharedPropertyProfileWritePayload {
  return {
    display_name: profile.displayName,
    property_type: profile.propertyType,
    country_code: profile.location.countryCode,
    city: profile.location.city,
    street_address: profile.location.streetAddress,
    postal_code: profile.location.postalCode,
    timezone: profile.location.timezone,
    latitude: profile.location.latitude,
    longitude: profile.location.longitude,
    address_public: profile.location.localityPublic,
    geo_public: profile.location.geoPublic,
    map_display_mode: profile.location.mapDisplayMode,
    contacts: profile.contacts.map((item) => ({
      channel_type: item.channelType,
      value: item.value,
      purpose: item.purpose,
      is_public: item.isPublic,
    })),
  };
}

function propertyProfileSql(): string {
  return `
    SELECT
      property.id::text AS "propertyId",
      property.profile_revision AS "profileRevision",
      NULLIF(property.display_name, '') AS "displayName",
      NULLIF(property.property_type, '') AS "propertyType",
      NULLIF(location.country_code::text, '') AS "countryCode",
      NULLIF(location.city, '') AS city,
      NULLIF(location.street_address, '') AS "streetAddress",
      NULLIF(location.postal_code, '') AS "postalCode",
      NULLIF(location.timezone, '') AS timezone,
      location.latitude,
      location.longitude,
      COALESCE(location.address_public, FALSE) AS "localityPublic",
      COALESCE(location.geo_public, FALSE) AS "geoPublic",
      COALESCE(location.map_display_mode, 'hidden') AS "mapDisplayMode",
      COALESCE(contacts.items, '[]'::jsonb) AS contacts
    FROM hotel_catalog.properties property
    JOIN identity.organization_resource_links link
      ON link.organization_id = $1::uuid
     AND link.product = 'hotel_catalog'
     AND link.resource_type = 'property'
     AND link.resource_id = property.id::text
     AND link.relationship IN ('owner', 'operator')
     AND link.status = 'active'
    LEFT JOIN hotel_catalog.property_locations location
      ON location.property_id = property.id
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(
          jsonb_build_object(
            'channelType', contact.channel_type,
            'value', contact.value,
            'purpose', contact.purpose,
            'isPublic', contact.is_public
          )
          ORDER BY contact.created_at, contact.id
        ) AS items
      FROM hotel_catalog.property_contact_channels contact
      WHERE contact.property_id = property.id
        AND contact.source_system = 'platform'
    ) contacts ON TRUE
    WHERE property.id = $2::uuid
    LIMIT 1
  `;
}

function publicPropertyProfileSql(): string {
  return `
    SELECT
      property.id::text AS "propertyId",
      property.profile_revision AS "profileRevision",
      property.default_locale AS locale,
      NULLIF(profile.short_description, '') AS "shortDescription",
      NULLIF(profile.long_description, '') AS "longDescription",
      COALESCE(public_media.items, '[]'::jsonb) AS media
    FROM hotel_catalog.properties property
    JOIN identity.organization_resource_links link
      ON link.organization_id = $1::uuid
     AND link.product = 'hotel_catalog'
     AND link.resource_type = 'property'
     AND link.resource_id = property.id::text
     AND link.relationship IN ('owner', 'operator')
     AND link.status = 'active'
    LEFT JOIN hotel_catalog.property_profiles profile
      ON profile.property_id = property.id
     AND profile.locale = property.default_locale
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
        jsonb_build_object(
          'mediaObjectId', media_object.id::text,
          'mediaType', media.media_type,
          'url', variant.public_cdn_url,
          'altText', media.alt_text,
          'sortOrder', media.sort_order
        )
        ORDER BY
          CASE media.media_type WHEN 'logo' THEN 0 WHEN 'hero_image' THEN 1 ELSE 2 END,
          media.sort_order,
          media.created_at,
          media.id
      ) AS items
      FROM hotel_catalog.property_media media
      JOIN platform.media_objects media_object
        ON media_object.id = media.platform_media_object_id
       AND media_object.property_id = property.id
       AND ${APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE}
      JOIN platform.media_variants variant
        ON variant.media_object_id = media_object.id
       AND variant.variant_name = 'original_safe'
       AND variant.visibility = 'public'
       AND NULLIF(variant.public_cdn_url, '') IS NOT NULL
      WHERE media.property_id = property.id
        AND media.public_approved = TRUE
        AND media.source_system = 'platform'
    ) public_media ON TRUE
    WHERE property.id = $2::uuid
    LIMIT 1
  `;
}

function createPropertyProfileSql(): string {
  return `
    WITH profile_input AS (
      SELECT *
      FROM jsonb_to_record($2::jsonb) AS input(
        display_name text,
        property_type text,
        country_code text,
        city text,
        street_address text,
        postal_code text,
        timezone text,
        latitude numeric,
        longitude numeric,
        address_public boolean,
        geo_public boolean,
        map_display_mode text,
        contacts jsonb
      )
    ),
    generated_property AS (
      SELECT gen_random_uuid() AS property_id
    ),
    created_property AS (
      INSERT INTO hotel_catalog.properties (
        id,
        public_id,
        display_name,
        property_type
      )
      SELECT
        generated_property.property_id,
        'prop_' || replace(generated_property.property_id::text, '-', ''),
        profile_input.display_name,
        profile_input.property_type
      FROM generated_property, profile_input
      RETURNING
        id AS property_id
    ),
    linked_property AS (
      INSERT INTO identity.organization_resource_links (
        organization_id,
        product,
        resource_type,
        resource_id,
        relationship,
        status
      )
      SELECT
        $1::uuid,
        'hotel_catalog',
        'property',
        created_property.property_id::text,
        'owner',
        'active'
      FROM created_property
      ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
      DO UPDATE SET status = 'active', updated_at = now()
      RETURNING product, resource_id
    ),
    setup_product_keys(product, entitlement_key) AS (
      VALUES
        ('booking'::text, 'booking-engine'::text),
        ('pms'::text, 'property-management'::text),
        ('marketplace'::text, 'marketplace-hotel-profile'::text)
    ),
    effective_products AS (
      SELECT candidate.product
      FROM setup_product_keys candidate
      WHERE EXISTS (
        SELECT 1
        FROM identity.product_entitlements entitlement
        WHERE entitlement.organization_id = $1::uuid
          AND entitlement.product = candidate.product
          AND entitlement.entitlement_key = candidate.entitlement_key
          AND entitlement.resource_product IS NULL
          AND entitlement.resource_type IS NULL
          AND entitlement.resource_id IS NULL
          AND entitlement.status = 'active'
          AND (entitlement.starts_at IS NULL OR entitlement.starts_at <= now())
          AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
      )
        AND NOT EXISTS (
          SELECT 1
          FROM identity.product_entitlements suspension
          WHERE suspension.organization_id = $1::uuid
            AND suspension.product = candidate.product
            AND suspension.entitlement_key = candidate.entitlement_key
            AND suspension.resource_product IS NULL
            AND suspension.resource_type IS NULL
            AND suspension.resource_id IS NULL
            AND suspension.status = 'suspended'
            AND (suspension.expires_at IS NULL OR suspension.expires_at > now())
        )
        AND NOT EXISTS (
          SELECT 1
          FROM finance.billing_entitlements billing
          WHERE billing.organization_id = $1::uuid
            AND billing.product = candidate.product
            AND billing.entitlement_key = candidate.entitlement_key
            AND (billing.starts_at IS NULL OR billing.starts_at <= now())
            AND (billing.expires_at IS NULL OR billing.expires_at > now())
            AND billing.billing_status IN ('past_due', 'suspended')
        )
        AND (
          NOT EXISTS (
            SELECT 1
            FROM finance.billing_entitlements billing
            WHERE billing.organization_id = $1::uuid
              AND billing.product = candidate.product
              AND billing.entitlement_key = candidate.entitlement_key
          )
          OR EXISTS (
            SELECT 1
            FROM finance.billing_entitlements billing
            WHERE billing.organization_id = $1::uuid
              AND billing.product = candidate.product
              AND billing.entitlement_key = candidate.entitlement_key
              AND (billing.starts_at IS NULL OR billing.starts_at <= now())
              AND (billing.expires_at IS NULL OR billing.expires_at > now())
              AND billing.billing_status IN ('trialing', 'active')
          )
        )
    ),
    enabled_products AS (
      SELECT effective.product
      FROM effective_products effective
      JOIN hotel_catalog.organization_setup_track_intents intent
        ON intent.organization_id = $1::uuid
      WHERE (
        effective.product = 'marketplace'
        AND 'creator_marketplace' = ANY(intent.selected_tracks)
      )
      OR (
        effective.product IN ('booking', 'pms')
        AND 'hotel_operations' = ANY(intent.selected_tracks)
        AND EXISTS (SELECT 1 FROM effective_products WHERE product = 'booking')
        AND EXISTS (SELECT 1 FROM effective_products WHERE product = 'pms')
      )
    ),
    linked_product_properties AS (
      INSERT INTO identity.organization_resource_links (
        organization_id,
        product,
        resource_type,
        resource_id,
        relationship,
        status
      )
      SELECT
        $1::uuid,
        entitlement.product,
        CASE entitlement.product
          WHEN 'booking' THEN 'booking_hotel'
          WHEN 'pms' THEN 'pms_property'
          WHEN 'marketplace' THEN 'hotel_profile'
        END,
        created_property.property_id::text,
        'owner',
        'active'
      FROM created_property
      JOIN enabled_products entitlement ON TRUE
      ON CONFLICT (organization_id, product, resource_type, resource_id, relationship)
      DO UPDATE SET status = 'active', updated_at = now()
      RETURNING product, resource_id
    ),
    initialized_marketplace_profile AS (
      INSERT INTO marketplace.marketplace_hotel_profiles (
        property_id,
        organization_id,
        source_system,
        source_hotel_profile_id
      )
      SELECT resource_id::uuid, $1::uuid, 'marketplace', resource_id
      FROM linked_product_properties
      WHERE product = 'marketplace'
      ON CONFLICT (property_id) DO NOTHING
      RETURNING property_id
    ),
    initialized_booking_settings AS (
      INSERT INTO booking.booking_settings (property_id)
      SELECT resource_id::uuid
      FROM linked_product_properties
      WHERE product = 'booking'
      ON CONFLICT (property_id) DO NOTHING
      RETURNING property_id
    ),
    written_property AS (
      SELECT * FROM created_property
    )
    ${propertyProfileMutationCtes()}
    SELECT written_property.property_id::text AS "propertyId"
    FROM written_property
  `;
}

function updatePropertyProfileSql(): string {
  return `
    WITH profile_input AS (
      SELECT *
      FROM jsonb_to_record($3::jsonb) AS input(
        display_name text,
        property_type text,
        country_code text,
        city text,
        street_address text,
        postal_code text,
        timezone text,
        latitude numeric,
        longitude numeric,
        address_public boolean,
        geo_public boolean,
        map_display_mode text,
        contacts jsonb
      )
    ),
    target_property AS (
      SELECT property.id AS property_id
      FROM hotel_catalog.properties property
      JOIN identity.organization_resource_links link
        ON link.organization_id = $1::uuid
       AND link.product = 'hotel_catalog'
       AND link.resource_type = 'property'
       AND link.resource_id = property.id::text
       AND link.relationship IN ('owner', 'operator')
       AND link.status = 'active'
      WHERE property.id = $2::uuid
      LIMIT 1
    ),
    updated_property AS (
      UPDATE hotel_catalog.properties property
      SET display_name = profile_input.display_name,
          property_type = profile_input.property_type,
          profile_revision = property.profile_revision + 1,
          updated_at = now()
      FROM target_property, profile_input
      WHERE property.id = target_property.property_id
        AND property.profile_revision = $4::bigint
      RETURNING
        property.id AS property_id
    ),
    written_property AS (
      SELECT * FROM updated_property
    )
    ${propertyProfileMutationCtes()}
    SELECT written_property.property_id::text AS "propertyId"
    FROM written_property
  `;
}

function propertyProfileMutationCtes(): string {
  return `,
    upserted_location AS (
      INSERT INTO hotel_catalog.property_locations (
        property_id,
        country_code,
        city,
        street_address,
        postal_code,
        latitude,
        longitude,
        timezone,
        address_public,
        geo_public,
        map_display_mode,
        source_confidence,
        updated_at
      )
      SELECT
        written_property.property_id,
        NULLIF(profile_input.country_code, '')::char(2),
        profile_input.city,
        profile_input.street_address,
        profile_input.postal_code,
        profile_input.latitude,
        profile_input.longitude,
        profile_input.timezone,
        profile_input.address_public,
        profile_input.geo_public,
        COALESCE(profile_input.map_display_mode, 'hidden'),
        'verified',
        now()
      FROM written_property, profile_input
      ON CONFLICT (property_id) DO UPDATE
      SET country_code = EXCLUDED.country_code,
          city = EXCLUDED.city,
          street_address = EXCLUDED.street_address,
          postal_code = EXCLUDED.postal_code,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          timezone = EXCLUDED.timezone,
          address_public = EXCLUDED.address_public,
          geo_public = EXCLUDED.geo_public,
          map_display_mode = EXCLUDED.map_display_mode,
          source_confidence = EXCLUDED.source_confidence,
          updated_at = now()
      RETURNING property_id
    ),
    contact_input AS (
      SELECT
        written_property.property_id,
        contact.channel_type,
        contact.value,
        contact.purpose,
        contact.is_public
      FROM written_property, profile_input
      JOIN LATERAL jsonb_to_recordset(COALESCE(profile_input.contacts, '[]'::jsonb))
        AS contact(channel_type text, value text, purpose text, is_public boolean) ON TRUE
    ),
    deleted_contacts AS (
      DELETE FROM hotel_catalog.property_contact_channels contact
      USING written_property
      WHERE contact.property_id = written_property.property_id
        AND contact.source_system = 'platform'
        AND NOT EXISTS (
          SELECT 1
          FROM contact_input
          WHERE contact_input.channel_type = contact.channel_type
            AND contact_input.value IS NOT NULL
            AND contact_input.value = contact.value
        )
      RETURNING contact.property_id
    ),
    upserted_contacts AS (
      INSERT INTO hotel_catalog.property_contact_channels (
        property_id,
        channel_type,
        value,
        purpose,
        is_public,
        source_system,
        updated_at
      )
      SELECT
        contact_input.property_id,
        contact_input.channel_type,
        contact_input.value,
        contact_input.purpose,
        contact_input.is_public,
        'platform',
        now()
      FROM contact_input
      ON CONFLICT (property_id, channel_type, value) DO UPDATE
      SET purpose = EXCLUDED.purpose,
          is_public = EXCLUDED.is_public,
          source_system = EXCLUDED.source_system,
          updated_at = now()
      RETURNING property_id
    )
  `;
}

function adaptiveHotelSetupFactsSql(): string {
  return `
    SELECT
      property.id::text AS "propertyId",
      property.public_id AS "publicId",
      NULLIF(property.display_name, '') AS "displayName",
      NULLIF(property.property_type, '') AS "propertyType",
      NULLIF(location.city, '') AS city,
      NULLIF(location.country_code::text, '') AS "countryCode",
      NULLIF(location.street_address, '') IS NOT NULL AS "hasStreetAddress",
      NULLIF(location.postal_code, '') IS NOT NULL AS "hasPostalCode",
      NULLIF(location.city, '') IS NOT NULL AS "hasCity",
      NULLIF(location.country_code::text, '') IS NOT NULL AS "hasCountryCode",
      NULLIF(location.timezone, '') IS NOT NULL AS "hasTimezone",
      COALESCE(contacts.has_email, FALSE) AS "hasEmail",
      COALESCE(contacts.has_phone, FALSE) AS "hasPhone",
      property.updated_at AS "propertyUpdatedAt",
      location.updated_at AS "locationUpdatedAt",
      contacts.updated_at AS "contactUpdatedAt",
      public_profile.normalized_description IS NOT NULL AS "hasDescription",
      COALESCE(public_media.has_approved_media, FALSE) AS "hasApprovedMedia",
      COALESCE(location.address_public, FALSE) AS "localityPublic",
      public_profile.updated_at AS "profileUpdatedAt",
      public_media.updated_at AS "mediaUpdatedAt",
      marketplace_profile.marketplace_profile_status AS "marketplaceProfileStatus",
      COALESCE(marketplace_profile.profile_complete, FALSE) AS "marketplaceProfileComplete",
      COALESCE(
        public_profile.normalized_description =
          NULLIF(BTRIM(marketplace_profile.host_summary), ''),
        FALSE
      ) AS "marketplaceProfileDescriptionInSync",
      marketplace_profile.updated_at AS "marketplaceProfileUpdatedAt",
      marketplace_offer.offer_status AS "marketplaceOfferStatus",
      COALESCE(marketplace_offer.has_title, FALSE) AS "marketplaceOfferHasTitle",
      COALESCE(marketplace_offer.has_deliverable, FALSE) AS "marketplaceOfferHasDeliverable",
      COALESCE(marketplace_offer.has_compensation, FALSE) AS "marketplaceOfferHasCompensation",
      COALESCE(marketplace_offer.has_requirement, FALSE) AS "marketplaceOfferHasRequirement",
      COALESCE(marketplace_offer.is_public, FALSE) AS "marketplaceOfferPublic",
      marketplace_offer.updated_at AS "marketplaceOfferUpdatedAt",
      marketplace_offer.children_updated_at AS "marketplaceOfferChildrenUpdatedAt",
      marketplace_offer.projected_at AS "marketplaceOfferProjectedAt",
      COALESCE(
        marketplace_offer.projection_fresh,
        FALSE
      ) AS "marketplaceOfferProjectionFresh",
      COALESCE(room_readiness.has_active_room_type, FALSE) AS "hasActiveRoomType",
      COALESCE(room_readiness.has_non_retired_room, FALSE) AS "hasNonRetiredRoom",
      COALESCE(room_readiness.has_active_rate_plan, FALSE) AS "hasActiveRatePlan",
      COALESCE(room_readiness.has_future_inventory, FALSE) AS "hasFutureInventory",
      room_readiness.room_type_updated_at AS "roomTypeUpdatedAt",
      room_readiness.room_updated_at AS "roomUpdatedAt",
      room_readiness.rate_plan_updated_at AS "ratePlanUpdatedAt",
      room_readiness.inventory_updated_at AS "inventoryUpdatedAt",
      policy.check_in_time IS NOT NULL AS "hasCheckInPolicy",
      policy.check_out_time IS NOT NULL AS "hasCheckOutPolicy",
      (
        NULLIF(policy.cancellation_summary, '') IS NOT NULL
        OR NULLIF(policy.cancellation_terms_url, '') IS NOT NULL
      ) AS "hasCancellationPolicy",
      policy.updated_at AS "policyUpdatedAt",
      COALESCE(
        billing.plan_key = 'fixed'
        OR billing.checkout_session_ref IS NOT NULL
        OR NULLIF(billing.entitlement_metadata ->> 'planSelectedAt', '') IS NOT NULL,
        FALSE
      ) AS "billingPlanSelected",
      billing.updated_at AS "billingPlanUpdatedAt",
      payment.payments_enabled AS "paymentsEnabled",
      COALESCE(cardinality(payment.accepted_methods) > 0, FALSE)
        AS "hasAcceptedPaymentMethod",
      COALESCE(
        payment.payments_enabled
        AND (
          (
            'pay_at_property' = ANY(payment.accepted_methods)
            AND payment.accepted_methods && ARRAY['cash', 'manual_card']::text[]
          )
          OR (
            'bank_transfer' = ANY(payment.accepted_methods)
            AND NULLIF(BTRIM(payment.deposit_policy ->> 'bankTransferInstructions'), '')
              IS NOT NULL
          )
          OR (
            'paypal' = ANY(payment.accepted_methods)
            AND BTRIM(payment.deposit_policy ->> 'paypalEmail')
              ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
          )
          OR (
            'card' = ANY(payment.accepted_methods)
            AND payment_provider.provider = 'stripe'
            AND payment_provider.status = 'active'
            AND payment_provider.onboarding_status = 'completed'
            AND payment_provider.charges_enabled = TRUE
          )
        ),
        FALSE
      ) AS "hasEffectivePaymentMethod",
      COALESCE(payment.requires_manual_review, FALSE) AS "paymentRequiresManualReview",
      payment.updated_at AS "paymentSettingsUpdatedAt",
      bookability.profile_status AS "bookabilityStatus",
      bookability.freshness_status AS "bookabilityFreshness",
      COALESCE(
        bookability.public_setup_completeness ->> 'status' = 'ready',
        FALSE
      ) AS "bookabilitySetupReady",
      COALESCE(
        CASE
          WHEN jsonb_typeof(bookability.public_setup_completeness -> 'missing') = 'array'
            THEN jsonb_array_length(bookability.public_setup_completeness -> 'missing') = 0
          ELSE FALSE
        END,
        FALSE
      ) AS "bookabilityMissingEmpty",
      (
        bookability.expires_at IS NOT NULL
        AND bookability.expires_at <= now()
      ) AS "bookabilityExpired",
      bookability.updated_at AS "bookabilityUpdatedAt"
    FROM unnest($2::uuid[]) AS scoped(property_id)
    JOIN hotel_catalog.properties property
      ON property.id = scoped.property_id
    LEFT JOIN hotel_catalog.property_locations location
      ON location.property_id = property.id
    LEFT JOIN hotel_catalog.property_public_profile_read_model catalog_public_profile
      ON catalog_public_profile.property_id = property.id
    LEFT JOIN LATERAL (
      SELECT
        bool_or(
          contact.channel_type = 'email'
          AND NULLIF(contact.value, '') IS NOT NULL
        ) AS has_email,
        bool_or(
          contact.channel_type = 'phone'
          AND NULLIF(contact.value, '') IS NOT NULL
        ) AS has_phone,
        max(contact.updated_at) AS updated_at
      FROM hotel_catalog.property_contact_channels contact
      WHERE contact.property_id = property.id
        AND contact.channel_type IN ('email', 'phone')
    ) contacts ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(
          NULLIF(BTRIM(profile.short_description), ''),
          NULLIF(BTRIM(profile.long_description), '')
        ) AS normalized_description,
        profile.updated_at
      FROM hotel_catalog.property_profiles profile
      WHERE profile.property_id = property.id
        AND profile.locale = property.default_locale
      LIMIT 1
    ) public_profile ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        count(*) > 0 AS has_approved_media,
        max(media.updated_at) AS updated_at
      FROM hotel_catalog.property_media media
      JOIN platform.media_objects media_object
        ON media_object.id = media.platform_media_object_id
       AND media_object.property_id = property.id
       AND ${APPROVED_PUBLIC_PROPERTY_MEDIA_OBJECT_PREDICATE}
      JOIN platform.media_variants media_variant
        ON media_variant.media_object_id = media_object.id
       AND media_variant.variant_name = 'original_safe'
       AND media_variant.visibility = 'public'
       AND NULLIF(media_variant.public_cdn_url, '') IS NOT NULL
      WHERE media.property_id = property.id
        AND media.public_approved = TRUE
        AND media.source_system = 'platform'
    ) public_media ON TRUE
    LEFT JOIN marketplace.marketplace_hotel_profiles marketplace_profile
      ON marketplace_profile.property_id = property.id
     AND marketplace_profile.organization_id = $1::uuid
    LEFT JOIN LATERAL (
      SELECT
        candidate.offer_status,
        candidate.has_title,
        candidate.has_deliverable,
        candidate.has_compensation,
        candidate.has_requirement,
        candidate.is_public,
        candidate.updated_at,
        candidate.children_updated_at,
        candidate.projected_at,
        candidate.projection_fresh
      FROM (
        SELECT
          facts.*,
          COALESCE(
            catalog_public_profile.projected_at IS NOT NULL
            AND facts.projected_at >= GREATEST(
                facts.updated_at,
                facts.children_updated_at,
                catalog_public_profile.projected_at
              ),
            FALSE
          ) AS projection_fresh
        FROM (
          SELECT
            offer.id AS offer_id,
            offer.offer_status,
            NULLIF(offer.title, '') IS NOT NULL AS has_title,
            EXISTS (
              SELECT 1
              FROM marketplace.offer_deliverables deliverable
              WHERE deliverable.offer_id = offer.id
                AND deliverable.property_id = offer.property_id
                AND deliverable.organization_id = offer.organization_id
            ) AS has_deliverable,
            EXISTS (
              SELECT 1
              FROM marketplace.offer_compensation_options compensation
              WHERE compensation.offer_id = offer.id
                AND compensation.property_id = offer.property_id
                AND compensation.organization_id = offer.organization_id
            ) AS has_compensation,
            EXISTS (
              SELECT 1
              FROM marketplace.offer_creator_requirements requirement
              WHERE requirement.offer_id = offer.id
                AND requirement.property_id = offer.property_id
                AND requirement.organization_id = offer.organization_id
            ) AS has_requirement,
            projection.visibility_status = 'public' AS is_public,
            offer.updated_at,
            GREATEST(
              (
                SELECT max(deliverable.updated_at)
                FROM marketplace.offer_deliverables deliverable
                WHERE deliverable.offer_id = offer.id
                  AND deliverable.property_id = offer.property_id
                  AND deliverable.organization_id = offer.organization_id
              ),
              (
                SELECT max(compensation.updated_at)
                FROM marketplace.offer_compensation_options compensation
                WHERE compensation.offer_id = offer.id
                  AND compensation.property_id = offer.property_id
                  AND compensation.organization_id = offer.organization_id
              ),
              (
                SELECT max(requirement.updated_at)
                FROM marketplace.offer_creator_requirements requirement
                WHERE requirement.offer_id = offer.id
                  AND requirement.property_id = offer.property_id
                  AND requirement.organization_id = offer.organization_id
              )
            ) AS children_updated_at,
            projection.projected_at
          FROM marketplace.marketplace_offers offer
          LEFT JOIN marketplace.marketplace_offer_read_model projection
            ON projection.offer_id = offer.id
           AND projection.property_id = offer.property_id
          WHERE offer.property_id = property.id
            AND offer.organization_id = $1::uuid
            AND offer.offer_status <> 'archived'
        ) facts
      ) candidate
      ORDER BY
        CASE
          WHEN candidate.offer_status = 'verified'
            AND candidate.has_title
            AND candidate.has_deliverable
            AND candidate.has_compensation
            AND candidate.has_requirement
            AND candidate.is_public
            AND candidate.projection_fresh
            THEN 0
          WHEN candidate.offer_status = 'verified'
            AND candidate.has_title
            AND candidate.has_deliverable
            AND candidate.has_compensation
            AND candidate.has_requirement
            AND candidate.is_public
            AND NOT candidate.projection_fresh
            THEN 1
          WHEN candidate.offer_status = 'pending'
            AND candidate.has_title
            AND candidate.has_deliverable
            AND candidate.has_compensation
            AND candidate.has_requirement
            THEN 2
          WHEN candidate.offer_status = 'verified'
            AND candidate.has_title
            AND candidate.has_deliverable
            AND candidate.has_compensation
            AND candidate.has_requirement
            THEN 3
          WHEN candidate.offer_status IN ('draft', 'pending', 'verified')
            THEN 4
          WHEN candidate.offer_status = 'rejected'
            THEN 5
          ELSE 6
        END,
        candidate.updated_at DESC,
        candidate.offer_id DESC
      LIMIT 1
    ) marketplace_offer ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        count(*) > 0 AS has_active_room_type,
        COALESCE(bool_or(candidate.has_non_retired_room), FALSE)
          AS has_non_retired_room,
        COALESCE(
          bool_or(
            candidate.has_non_retired_room
            AND candidate.has_active_rate_plan
          ),
          FALSE
        ) AS has_active_rate_plan,
        COALESCE(
          bool_or(
            candidate.has_non_retired_room
            AND candidate.has_active_rate_plan
            AND candidate.has_future_inventory
          ),
          FALSE
        ) AS has_future_inventory,
        max(candidate.room_type_updated_at) AS room_type_updated_at,
        max(candidate.room_updated_at) AS room_updated_at,
        max(candidate.rate_plan_updated_at) AS rate_plan_updated_at,
        max(candidate.inventory_updated_at) AS inventory_updated_at
      FROM (
        SELECT
          room_type.updated_at AS room_type_updated_at,
          COALESCE(room_facts.exists, FALSE) AS has_non_retired_room,
          room_facts.updated_at AS room_updated_at,
          COALESCE(rate_plan_facts.exists, FALSE) AS has_active_rate_plan,
          rate_plan_facts.updated_at AS rate_plan_updated_at,
          COALESCE(inventory_facts.exists, FALSE) AS has_future_inventory,
          inventory_facts.updated_at AS inventory_updated_at
        FROM pms.room_types room_type
        LEFT JOIN LATERAL (
          SELECT count(*) > 0 AS exists, max(room.updated_at) AS updated_at
          FROM pms.rooms room
          WHERE room.property_id = room_type.property_id
            AND room.room_type_id = room_type.id
            AND room.status <> 'retired'
        ) room_facts ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*) > 0 AS exists, max(rate_plan.updated_at) AS updated_at
          FROM pms.rate_plans rate_plan
          WHERE rate_plan.property_id = room_type.property_id
            AND rate_plan.room_type_id = room_type.id
            AND rate_plan.active = TRUE
        ) rate_plan_facts ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*) > 0 AS exists, max(day.updated_at) AS updated_at
          FROM pms.inventory_days day
          WHERE day.property_id = room_type.property_id
            AND day.room_type_id = room_type.id
            AND day.stay_date >= CURRENT_DATE
        ) inventory_facts ON TRUE
        WHERE room_type.property_id = property.id
          AND room_type.active = TRUE
      ) candidate
    ) room_readiness ON TRUE
    LEFT JOIN hotel_catalog.property_policy_summaries policy
      ON policy.property_id = property.id
    LEFT JOIN LATERAL (
      SELECT entitlement.plan_key,
             entitlement.checkout_session_ref,
             entitlement.entitlement_metadata,
             entitlement.updated_at
      FROM finance.billing_entitlements entitlement
      WHERE entitlement.property_id = property.id
        AND entitlement.organization_id = $1::uuid
        AND entitlement.product = 'booking'
        AND entitlement.entitlement_key = 'direct-booking-finance'
      ORDER BY entitlement.updated_at DESC
      LIMIT 1
    ) billing ON TRUE
    LEFT JOIN finance.payment_settings payment
      ON payment.property_id = property.id
    LEFT JOIN finance.payment_provider_accounts payment_provider
      ON payment_provider.id = payment.provider_account_id
     AND payment_provider.property_id = property.id
    LEFT JOIN distribution.public_hotel_bookability_profiles bookability
      ON bookability.property_id = property.id
    ORDER BY array_position($2::uuid[], property.id)
  `;
}

function publicPropertyMediaItems(value: unknown): PublicPropertyProfileMedia[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): PublicPropertyProfileMedia | null => {
      const media = objectValue(item);
      const mediaObjectId = nonEmpty(media["mediaObjectId"] ?? media["media_object_id"]);
      const mediaType = nonEmpty(media["mediaType"] ?? media["media_type"]);
      const url = nonEmpty(media["url"]);
      const parsedSortOrder = Number(media["sortOrder"] ?? media["sort_order"]);
      if (
        !mediaObjectId ||
        !url ||
        (mediaType !== "hero_image" && mediaType !== "gallery_image" && mediaType !== "logo") ||
        !Number.isSafeInteger(parsedSortOrder) ||
        parsedSortOrder < 0
      ) {
        return null;
      }
      return {
        mediaObjectId,
        mediaType,
        url,
        altText: nonEmpty(media["altText"] ?? media["alt_text"]),
        sortOrder: parsedSortOrder,
      };
    })
    .filter((item): item is PublicPropertyProfileMedia => item !== null);
}

function contactItems(value: unknown): PropertyProfileContact[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): PropertyProfileContact | null => {
      const contact = objectValue(item);
      const channelType = nonEmpty(contact["channelType"] ?? contact["channel_type"]);
      const contactValue = nonEmpty(contact["value"]);
      const purpose = nonEmpty(contact["purpose"]);
      if (
        !contactValue ||
        !(
          channelType === "email" ||
          channelType === "phone" ||
          channelType === "website" ||
          channelType === "whatsapp" ||
          channelType === "instagram" ||
          channelType === "facebook" ||
          channelType === "x"
        ) ||
        !(
          purpose === "general" ||
          purpose === "operations" ||
          purpose === "guest" ||
          purpose === "creator"
        )
      ) {
        return null;
      }
      return {
        channelType,
        value: contactValue,
        purpose,
        isPublic: contact["isPublic"] === true || contact["is_public"] === true,
      };
    })
    .filter((item): item is PropertyProfileContact => item !== null);
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function positiveInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function mapDisplayMode(value: string | null): PropertyProfileMapDisplayMode {
  if (value === "approximate" || value === "exact") return value;
  return "hidden";
}

function latest(...values: unknown[]): string | null {
  const timestamps = values
    .map((value) => {
      const iso = toIsoString(value);
      return iso ? Date.parse(iso) : Number.NaN;
    })
    .filter(Number.isFinite);
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
