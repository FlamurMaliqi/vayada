import { randomUUID } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  ApprovedPublicProfileImageRepository,
  PlatformMediaAuditEvent,
  PlatformMediaObjectRecord,
  PlatformMediaRepository,
  PlatformMediaSessionRecord,
  PlatformMediaTargetResolver,
  PlatformMediaVariantRecord,
} from "../routes/platformMedia.js";

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

type PlatformMediaPoolClient = Queryable & { release(): void };
type PlatformMediaPool = Queryable & {
  connect(): Promise<PlatformMediaPoolClient>;
  end(): Promise<void>;
};

type PgPlatformMediaRepositoryConfig = {
  connectionString: string;
  publicCdnBaseUrl: string;
  max?: number;
  pool?: PlatformMediaPool;
};

type SessionRow = {
  session: PlatformMediaSessionRecord;
  completedMediaObjectId: string | null;
  mediaObjectIds: string[] | null;
};
type MediaObjectRow = { record: PlatformMediaObjectRecord };
type PropertyTargetRow = { propertyId: string };
type CollaborationTargetRow = { collaborationId: string; propertyId: string };

const supportedPurposes = new Set([
  "identity.user.profile_image",
  "property.hero_image",
  "property.gallery_image",
  "marketplace.creator.profile_image",
  "marketplace.offer.media",
  "marketplace.collaboration_chat.attachment",
]);
const autoApprovedPublicPurposes = new Set([
  "identity.user.profile_image",
  "property.hero_image",
  "property.gallery_image",
  "marketplace.creator.profile_image",
]);
const CANONICAL_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createPgPlatformMediaRepository(
  config: PgPlatformMediaRepositoryConfig,
): PlatformMediaRepository & ApprovedPublicProfileImageRepository & PlatformMediaTargetResolver {
  if (!config.connectionString.trim()) {
    throw new Error("Platform media repository connectionString must not be empty");
  }
  if (!config.publicCdnBaseUrl.trim()) {
    throw new Error("Platform media repository publicCdnBaseUrl must not be empty");
  }

  const ownsPool = !config.pool;
  const pool: PlatformMediaPool = config.pool ?? createPlatformMediaPool(config);

  return {
    persistent: true,
    publicCdnBaseUrl: config.publicCdnBaseUrl,
    async createUploadSession(input) {
      const requestedVisibility = input.request.visibility ?? "private";
      if (!supportedPurposes.has(input.request.purpose)) {
        throw new Error("Persistent platform media does not support this upload purpose");
      }
      const isAutoApproved = autoApprovedPublicPurposes.has(input.request.purpose);
      if (
        (isAutoApproved &&
          (requestedVisibility !== "public" || !input.policy.autoApprovePublicOnFinalize)) ||
        (!isAutoApproved &&
          (input.policy.purpose !== input.request.purpose ||
            input.policy.autoApprovePublicOnFinalize === true))
      ) {
        throw new Error("Persistent platform media policy does not support this upload");
      }

      const files = input.request.files.map((file, index) => {
        const uploadTarget = input.uploadTargets[index];
        if (!uploadTarget) throw new Error("Every platform media file requires an upload target");
        return {
          ...file,
          clientFileId: file.clientFileId?.trim() || `file_${index + 1}`,
          uploadTargetId: uploadTarget.uploadTargetId,
          mediaId: randomUUID(),
        };
      });
      const session: PlatformMediaSessionRecord = {
        sessionId: input.sessionId,
        uploadSessionKey: input.uploadSessionKey,
        purpose: input.request.purpose,
        requestedVisibility,
        effectiveVisibility: isAutoApproved ? "public" : "private",
        actorUserId: input.context.actor.internalUserId,
        ownerOrganizationId: input.context.selectedOrganization.organizationId,
        resource: input.request.resource,
        target: input.target,
        files,
        uploadTargets: input.uploadTargets,
        stagingPrefix: input.stagingPrefix,
        status: "signed",
        expiresAt: input.expiresAt,
        createdAt: input.now,
      };

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO platform.media_upload_sessions
             (id, upload_session_key, requested_purpose, requested_visibility,
              actor_user_id, owner_organization_id, property_id, resource_product,
              resource_type, resource_id, expected_content_type, expected_size_bytes,
              expected_file_count, staging_prefix, expires_at, session_status,
              completion_metadata, created_at, updated_at)
           VALUES
             ($1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8, $9, $10,
              $11, $12, $13, $14, $15::timestamptz, 'signed', $16::jsonb,
              $17::timestamptz, $17::timestamptz)`,
          [
            session.sessionId,
            session.uploadSessionKey,
            session.purpose,
            session.requestedVisibility,
            session.actorUserId,
            session.ownerOrganizationId,
            session.target.propertyId ?? null,
            session.target.resourceProduct,
            session.target.resourceType,
            session.target.resourceId,
            files[0]?.contentType ?? null,
            files[0]?.sizeBytes ?? null,
            files.length,
            session.stagingPrefix,
            session.expiresAt,
            JSON.stringify({ session: persistedSession(session) }),
            session.createdAt,
          ],
        );
        await recordAudit(client, input.auditEvent);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return session;
    },
    async findUploadSession(sessionId) {
      return readSession(pool, sessionId);
    },
    async findMediaObject(mediaId) {
      return readMediaObject(pool, mediaId);
    },
    async resolveTarget(input) {
      return resolveTarget(pool, input);
    },
    async completeUploadSession(input) {
      return completeUploadSession(pool, input);
    },
    async createImportJob() {
      throw new Error(
        "Persistent platform media imports are not enabled for the profile-image slice",
      );
    },
    async recordAudit(event) {
      await recordAudit(pool, event);
    },
    async close() {
      if (ownsPool) await pool.end();
    },
  };
}

async function resolveTarget(
  queryable: Queryable,
  input: Parameters<PlatformMediaTargetResolver["resolveTarget"]>[0],
): ReturnType<PlatformMediaTargetResolver["resolveTarget"]> {
  if (input.request.purpose === "marketplace.collaboration_chat.attachment") {
    const targetResourceId = input.request.resource.targetResourceId?.trim();
    if (!targetResourceId) {
      return {
        ok: false,
        statusCode: 403,
        code: "media_target_forbidden",
        message: "Chat attachments require a collaboration target.",
      };
    }

    const sourceColumn =
      input.request.resource.resourceType === "creator_profile" ? "creator_profile_id" : "offer_id";
    const result = await queryable.query<CollaborationTargetRow>(
      `SELECT collaboration.id::text AS "collaborationId",
              collaboration.property_id::text AS "propertyId"
       FROM marketplace.collaborations collaboration
       WHERE collaboration.source_collaboration_id = $1
         AND collaboration.${sourceColumn}::text = $2
       LIMIT 1`,
      [targetResourceId, input.request.resource.resourceId],
    );
    const collaboration = result.rows[0];
    if (!collaboration) {
      return {
        ok: false,
        statusCode: 403,
        code: "media_target_forbidden",
        message: "Chat attachment source is not linked to this collaboration.",
      };
    }
    return {
      ok: true,
      target: {
        resourceProduct: "marketplace",
        resourceType: "collaboration",
        resourceId: collaboration.collaborationId,
        propertyId: collaboration.propertyId,
      },
    };
  }

  if (input.policy.targetResourceProduct !== "hotel_catalog") {
    return {
      ok: true,
      target: {
        resourceProduct: input.policy.targetResourceProduct,
        resourceType: input.policy.targetResourceType,
        resourceId:
          input.request.resource.targetResourceId ??
          input.request.resource.propertyId ??
          input.request.resource.resourceId,
        propertyId: input.request.resource.propertyId,
      },
    };
  }

  const sourceTable =
    input.request.resource.product === "booking" ? "booking_hotels" : "hotel_profiles";
  const result = await queryable.query<PropertyTargetRow>(
    `WITH property_candidates AS (
       SELECT property.id
       FROM hotel_catalog.properties property
       WHERE property.id::text = $3
       UNION
       SELECT source.property_id
       FROM hotel_catalog.property_source_links source
       WHERE source.source_system = $1
         AND source.source_table = $2
         AND source.source_id = $3
         AND source.status = 'active'
     )
     SELECT id::text AS "propertyId"
     FROM property_candidates
     LIMIT 2`,
    [input.request.resource.product, sourceTable, input.request.resource.resourceId],
  );
  if (result.rows.length !== 1) {
    return {
      ok: false,
      statusCode: 403,
      code: "media_target_forbidden",
      message: "Property media target is not linked to this hotel resource.",
    };
  }

  const propertyId = result.rows[0]!.propertyId;
  return {
    ok: true,
    target: {
      resourceProduct: "hotel_catalog",
      resourceType: "property",
      resourceId: propertyId,
      propertyId,
    },
  };
}

async function completeUploadSession(
  pool: PlatformMediaPool,
  input: Parameters<PlatformMediaRepository["completeUploadSession"]>[0],
): ReturnType<PlatformMediaRepository["completeUploadSession"]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await readSession(client, input.session.sessionId, true);
    if (!session) throw new Error("Platform media upload session was not found");
    if (session.status === "completed") {
      await recordAudit(client, input.auditEvent);
      await client.query("COMMIT");
      return {
        uploadSession: session,
        mediaObjects:
          session.completedMediaObjects ??
          (session.completedMediaObject ? [session.completedMediaObject] : []),
      };
    }
    if (session.status !== "signed") {
      throw new Error("Platform media upload session is not finalizable");
    }
    if (!supportedPurposes.has(session.purpose)) {
      throw new Error("Persistent platform media cannot finalize this purpose");
    }
    const isAutoApproved = autoApprovedPublicPurposes.has(session.purpose);
    if (
      (isAutoApproved &&
        (session.requestedVisibility !== "public" || session.effectiveVisibility !== "public")) ||
      (!isAutoApproved && session.effectiveVisibility !== "private")
    ) {
      throw new Error("Persistent platform media session has an invalid visibility state");
    }

    const mediaObjects = input.files.map((file, index) =>
      mediaObjectFor(session, file, input.variantSets[index] ?? [], input.bucketName, input.now),
    );
    for (const mediaObject of mediaObjects) {
      await insertMediaObject(client, mediaObject);
      for (const variant of mediaObject.variants) {
        await insertVariant(client, mediaObject.mediaId, variant, input.now);
      }
      await upsertPropertyMediaProjection(client, mediaObject, input.now);
    }

    const completedSession: PlatformMediaSessionRecord = {
      ...session,
      status: "completed",
      completedAt: input.now,
      completedMediaObject: mediaObjects[0],
      completedMediaObjects: mediaObjects,
    };
    await client.query(
      `UPDATE platform.media_upload_sessions
       SET session_status = 'completed', completed_media_object_id = $2::uuid,
           completion_metadata = $3::jsonb, completed_at = $4::timestamptz,
           updated_at = $4::timestamptz
       WHERE id = $1::uuid`,
      [
        session.sessionId,
        mediaObjects[0]!.mediaId,
        JSON.stringify({
          session: completedSession,
          mediaObjectIds: mediaObjects.map(({ mediaId }) => mediaId),
        }),
        input.now,
      ],
    );
    await recordAudit(client, input.auditEvent);
    await client.query("COMMIT");
    return { uploadSession: completedSession, mediaObjects };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function mediaObjectFor(
  session: PlatformMediaSessionRecord,
  file: Parameters<PlatformMediaRepository["completeUploadSession"]>[0]["files"][number],
  variants: PlatformMediaVariantRecord[],
  bucketName: string,
  now: string,
): PlatformMediaObjectRecord {
  const originalSafe =
    variants.find(({ variantName }) => variantName === "original_safe") ??
    variants.find(({ variantName }) => variantName === "provider_original");
  if (!originalSafe) throw new Error("Platform images require a canonical media variant");
  if (
    variants.some(
      (variant) =>
        variant.visibility !== session.effectiveVisibility ||
        (session.effectiveVisibility === "public"
          ? !variant.publicCdnUrl?.startsWith("https://")
          : variant.publicCdnUrl !== null) ||
        !variant.checksumSha256?.match(/^[a-f0-9]{64}$/),
    )
  ) {
    throw new Error("Platform image variants do not match the session visibility");
  }

  const autoApproved =
    session.requestedVisibility === "public" && session.effectiveVisibility === "public";

  return {
    mediaId: file.sessionFile.mediaId,
    purpose: session.purpose,
    visibility: session.effectiveVisibility,
    requestedVisibility: session.requestedVisibility,
    approvalStatus: autoApproved
      ? "approved"
      : session.requestedVisibility === "public"
        ? "pending_domain_approval"
        : "private",
    lifecycleStatus:
      autoApproved || session.purpose === "marketplace.collaboration_chat.attachment"
        ? "active"
        : "staged",
    storageKind: "vayada_managed",
    bucket: bucketName,
    storageKey: originalSafe.storageKey,
    ownerOrganizationId: session.ownerOrganizationId,
    actorUserId: session.actorUserId,
    resourceProduct: session.target.resourceProduct,
    resourceType: session.target.resourceType,
    resourceId: session.target.resourceId,
    propertyId: session.target.propertyId,
    contentType: originalSafe.contentType,
    sizeBytes: originalSafe.sizeBytes,
    widthPx: originalSafe.widthPx,
    heightPx: originalSafe.heightPx,
    checksumSha256: originalSafe.checksumSha256,
    originalFilename: file.sessionFile.filename,
    retainedUntil:
      session.purpose === "marketplace.collaboration_chat.attachment"
        ? new Date(Date.parse(now) + 60 * 60 * 1000).toISOString()
        : null,
    variants,
    createdAt: now,
  };
}

async function insertMediaObject(
  client: Queryable,
  mediaObject: PlatformMediaObjectRecord,
): Promise<void> {
  const sourceMetadata = {
    requestedVisibility: mediaObject.requestedVisibility,
    ...(mediaObject.purpose === "marketplace.collaboration_chat.attachment"
      ? { attachmentState: "orphan" }
      : {}),
  };
  await client.query(
    `INSERT INTO platform.media_objects
       (id, bucket, storage_key, storage_kind, visibility, purpose,
        owner_organization_id, property_id, resource_product, resource_type,
        resource_id, lifecycle_status, content_type, size_bytes, checksum_sha256,
        width_px, height_px, original_filename, source_metadata, public_approved,
        retained_until, created_by_user_id, created_at, updated_at)
     VALUES
       ($1::uuid, $2, $3, 'vayada_managed', $4, $5, $6::uuid, $7::uuid,
        $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb,
        $19,
        CASE
          WHEN $5 = 'marketplace.collaboration_chat.attachment'
            THEN $21::timestamptz + interval '1 hour'
          ELSE NULL
        END,
        $20::uuid, $21::timestamptz, $21::timestamptz)`,
    [
      mediaObject.mediaId,
      mediaObject.bucket,
      mediaObject.storageKey,
      mediaObject.visibility,
      mediaObject.purpose,
      mediaObject.ownerOrganizationId,
      mediaObject.propertyId ?? null,
      mediaObject.resourceProduct,
      mediaObject.resourceType,
      mediaObject.resourceId,
      mediaObject.lifecycleStatus,
      mediaObject.contentType,
      mediaObject.sizeBytes,
      mediaObject.checksumSha256 ?? null,
      mediaObject.widthPx ?? null,
      mediaObject.heightPx ?? null,
      mediaObject.originalFilename,
      JSON.stringify(sourceMetadata),
      mediaObject.approvalStatus === "approved",
      mediaObject.actorUserId,
      mediaObject.createdAt,
    ],
  );
}

async function insertVariant(
  client: Queryable,
  mediaId: string,
  variant: PlatformMediaVariantRecord,
  now: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.media_variants
       (media_object_id, variant_name, visibility, storage_key, content_type,
        width_px, height_px, size_bytes, checksum_sha256, public_cdn_url, created_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
    [
      mediaId,
      variant.variantName,
      variant.visibility,
      variant.storageKey,
      variant.contentType,
      variant.widthPx ?? null,
      variant.heightPx ?? null,
      variant.sizeBytes,
      variant.checksumSha256 ?? null,
      variant.publicCdnUrl,
      now,
    ],
  );
}

async function upsertPropertyMediaProjection(
  client: Queryable,
  mediaObject: PlatformMediaObjectRecord,
  now: string,
): Promise<void> {
  if (
    mediaObject.purpose !== "property.hero_image" &&
    mediaObject.purpose !== "property.gallery_image"
  ) {
    return;
  }
  const propertyId = mediaObject.propertyId;
  const publicUrl = mediaObject.variants.find(
    ({ variantName }) => variantName === "original_safe",
  )?.publicCdnUrl;
  if (
    !propertyId ||
    !publicUrl?.startsWith("https://") ||
    mediaObject.approvalStatus !== "approved" ||
    mediaObject.lifecycleStatus !== "active"
  ) {
    throw new Error("Approved property media requires a canonical property and public URL");
  }

  const mediaType = mediaObject.purpose === "property.hero_image" ? "hero_image" : "gallery_image";
  const rightsMetadata = JSON.stringify({ platformMediaObjectId: mediaObject.mediaId });
  await client.query(
    `WITH superseded_hero AS (
       UPDATE hotel_catalog.property_media
       SET public_approved = FALSE,
           updated_at = $6::timestamptz
       WHERE $3 = 'hero_image'
         AND property_id = $2::uuid
         AND media_type = 'hero_image'
         AND source_system = 'platform'
         AND platform_media_object_id IS DISTINCT FROM $1::uuid
       RETURNING id
     ),
     updated AS (
       UPDATE hotel_catalog.property_media
       SET property_id = $2::uuid,
           media_type = $3,
           url = $4,
           sort_order = CASE WHEN $3 = 'hero_image' THEN 0 ELSE sort_order END,
           source_system = 'platform',
           public_approved = TRUE,
           rights_metadata = COALESCE(rights_metadata, '{}'::jsonb) || $5::jsonb,
           updated_at = $6::timestamptz
       WHERE platform_media_object_id = $1::uuid
       RETURNING id
     ),
     next_sort AS (
       SELECT CASE
         WHEN $3 = 'hero_image' THEN 0
         ELSE GREATEST(COALESCE(MAX(sort_order) + 1, 1), 1)
       END AS sort_order
       FROM hotel_catalog.property_media
       WHERE property_id = $2::uuid
     )
     INSERT INTO hotel_catalog.property_media
       (property_id, media_type, url, alt_text, sort_order, source_system,
        public_approved, rights_metadata, platform_media_object_id, created_at, updated_at)
     SELECT $2::uuid, $3, $4, NULL, next_sort.sort_order, 'platform',
            TRUE, $5::jsonb, $1::uuid, $6::timestamptz, $6::timestamptz
     FROM next_sort
     WHERE NOT EXISTS (SELECT 1 FROM updated)`,
    [mediaObject.mediaId, propertyId, mediaType, publicUrl, rightsMetadata, now],
  );
}

async function readSession(
  queryable: Queryable,
  sessionId: string,
  forUpdate = false,
): Promise<PlatformMediaSessionRecord | null> {
  if (!CANONICAL_UUID.test(sessionId)) return null;
  const result = await queryable.query<SessionRow>(
    `SELECT completion_metadata -> 'session' AS session,
            completed_media_object_id::text AS "completedMediaObjectId",
            completion_metadata -> 'mediaObjectIds' AS "mediaObjectIds"
     FROM platform.media_upload_sessions
     WHERE id = $1::uuid${forUpdate ? " FOR UPDATE" : ""}`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row?.session) return null;
  if (row.session.status !== "completed") return row.session;

  const mediaObjectIds = completedMediaObjectIds(row);
  if (mediaObjectIds.length === 0) {
    throw new Error("Completed platform media upload session has no media objects");
  }
  const mediaObjects: PlatformMediaObjectRecord[] = [];
  for (const mediaId of mediaObjectIds) {
    const mediaObject = await readMediaObject(queryable, mediaId);
    if (!mediaObject) {
      throw new Error(`Completed platform media object ${mediaId} was not found`);
    }
    mediaObjects.push(mediaObject);
  }
  return {
    ...row.session,
    completedMediaObject: mediaObjects[0],
    completedMediaObjects: mediaObjects,
  };
}

async function readMediaObject(
  queryable: Queryable,
  mediaId: string,
): Promise<PlatformMediaObjectRecord | null> {
  if (!CANONICAL_UUID.test(mediaId)) return null;
  const result = await queryable.query<MediaObjectRow>(
    `SELECT jsonb_strip_nulls(jsonb_build_object(
       'mediaId', media.id::text,
       'purpose', media.purpose,
       'visibility', media.visibility,
       'requestedVisibility', COALESCE(media.source_metadata ->> 'requestedVisibility', media.visibility),
       'approvalStatus', CASE
         WHEN media.public_approved THEN 'approved'
         WHEN COALESCE(media.source_metadata ->> 'requestedVisibility', media.visibility) = 'public'
           THEN 'pending_domain_approval'
         ELSE 'private'
       END,
       'lifecycleStatus', media.lifecycle_status,
       'storageKind', media.storage_kind,
       'bucket', media.bucket,
       'storageKey', media.storage_key,
       'ownerOrganizationId', media.owner_organization_id::text,
       'actorUserId', media.created_by_user_id::text,
       'resourceProduct', media.resource_product,
       'resourceType', media.resource_type,
       'resourceId', media.resource_id,
       'propertyId', media.property_id::text,
       'contentType', media.content_type,
       'sizeBytes', media.size_bytes,
       'checksumSha256', media.checksum_sha256,
       'widthPx', media.width_px,
       'heightPx', media.height_px,
       'originalFilename', media.original_filename,
       'sourceMetadata', media.source_metadata,
       'retainedUntil', CASE
         WHEN media.retained_until IS NULL THEN NULL
         ELSE to_char(
           media.retained_until AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
       END,
       'variants', COALESCE((
         SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'variantName', variant.variant_name,
           'visibility', variant.visibility,
           'storageKey', variant.storage_key,
           'contentType', variant.content_type,
           'widthPx', variant.width_px,
           'heightPx', variant.height_px,
           'sizeBytes', variant.size_bytes,
           'checksumSha256', variant.checksum_sha256,
           'publicCdnUrl', variant.public_cdn_url
         )) ORDER BY variant.created_at, variant.id)
         FROM platform.media_variants variant
         WHERE variant.media_object_id = media.id
       ), '[]'::jsonb),
       'createdAt', to_char(
         media.created_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
     )) AS record
     FROM platform.media_objects media
     WHERE media.id = $1::uuid
     LIMIT 1`,
    [mediaId],
  );
  return result.rows[0]?.record ?? null;
}

async function recordAudit(queryable: Queryable, event: PlatformMediaAuditEvent): Promise<void> {
  await queryable.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, organization_id,
        actor_type, actor_user_id, target_resource_product, target_resource_type,
        target_resource_id, correlation_id, redacted_payload, audit_metadata,
        retention_class, privacy_scope)
     VALUES
       ($1, 'platform', $2, now(), 'organization', $3::uuid, 'user', $4::uuid,
        'platform', $5, $6, $7, $8::jsonb, $9::jsonb, 'standard', 'internal')
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      event.auditKey,
      event.action,
      event.organizationId,
      event.actorUserId,
      event.targetType,
      event.targetId,
      event.requestId,
      JSON.stringify(sanitizeAuditMetadata(event.metadata)),
      JSON.stringify({ requestId: event.requestId, source: "apps/api-platform-media" }),
    ],
  );
}

function createPlatformMediaPool(
  config: Omit<PgPlatformMediaRepositoryConfig, "pool">,
): PlatformMediaPool {
  const pool = new pg.Pool({ connectionString: config.connectionString, max: config.max });
  pool.on("error", (error) => {
    process.emitWarning("Platform media PostgreSQL pool emitted an idle-client error", {
      code: "PLATFORM_MEDIA_POOL_ERROR",
      detail: error.message,
    });
  });
  return pool;
}

function completedMediaObjectIds(row: SessionRow): string[] {
  const snapshotIds =
    row.session.completedMediaObjects?.map(({ mediaId }) => mediaId) ??
    (row.session.completedMediaObject ? [row.session.completedMediaObject.mediaId] : []);
  return [
    ...new Set([
      ...(row.completedMediaObjectId ? [row.completedMediaObjectId] : []),
      ...(Array.isArray(row.mediaObjectIds) ? row.mediaObjectIds : []),
      ...snapshotIds,
    ]),
  ].filter(
    (mediaId): mediaId is string => typeof mediaId === "string" && CANONICAL_UUID.test(mediaId),
  );
}

const redactedAuditMetadataKeys = new Set([
  "effectiveVisibility",
  "fileCount",
  "mediaIds",
  "product",
  "propertyId",
  "purpose",
  "requestedVisibility",
  "resource",
  "resourceId",
  "resourceProduct",
  "resourceType",
  "sourceImageCount",
  "target",
  "targetResourceId",
  "variantNames",
]);

function sanitizeAuditMetadata(value: unknown): unknown {
  if (typeof value === "string") {
    if (CANONICAL_UUID.test(value)) return value;
    return value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(/\+?\d[\d\s().-]{7,}\d/g, "[redacted-phone]");
  }
  if (Array.isArray(value)) return value.map(sanitizeAuditMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => redactedAuditMetadataKeys.has(key))
      .map(([key, entry]) => [key, sanitizeAuditMetadata(entry)]),
  );
}

function persistedSession(session: PlatformMediaSessionRecord): PlatformMediaSessionRecord {
  return {
    ...session,
    uploadTargets: session.uploadTargets.map((target) => ({
      ...target,
      uploadUrl: "",
      headers: {},
    })),
  };
}
