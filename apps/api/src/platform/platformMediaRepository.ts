import { randomUUID } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";

import type {
  ApprovedPublicProfileImageRepository,
  PlatformMediaAuditEvent,
  PlatformMediaObjectRecord,
  PlatformMediaRepository,
  PlatformMediaSessionRecord,
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

type SessionRow = { session: PlatformMediaSessionRecord };
type MediaObjectRow = { record: PlatformMediaObjectRecord };

const supportedPurposes = new Set([
  "identity.user.profile_image",
  "marketplace.creator.profile_image",
]);

export function createPgPlatformMediaRepository(
  config: PgPlatformMediaRepositoryConfig,
): PlatformMediaRepository & ApprovedPublicProfileImageRepository {
  if (!config.connectionString.trim()) {
    throw new Error("Platform media repository connectionString must not be empty");
  }
  if (!config.publicCdnBaseUrl.trim()) {
    throw new Error("Platform media repository publicCdnBaseUrl must not be empty");
  }

  const pool: PlatformMediaPool =
    config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: config.max });

  return {
    persistent: true,
    publicCdnBaseUrl: config.publicCdnBaseUrl,
    async createUploadSession(input) {
      const requestedVisibility = input.request.visibility ?? "private";
      if (
        !supportedPurposes.has(input.request.purpose) ||
        requestedVisibility !== "public" ||
        !input.policy.autoApprovePublicOnFinalize
      ) {
        throw new Error("Persistent platform media currently supports public profile images only");
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
        effectiveVisibility: "public",
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
      await pool.end();
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
    if (
      !supportedPurposes.has(session.purpose) ||
      session.requestedVisibility !== "public" ||
      session.effectiveVisibility !== "public"
    ) {
      throw new Error("Persistent platform media can only finalize public profile images");
    }

    const mediaObjects = input.files.map((file, index) =>
      mediaObjectFor(session, file, input.variantSets[index] ?? [], input.bucketName, input.now),
    );
    for (const mediaObject of mediaObjects) {
      await insertMediaObject(client, mediaObject);
      for (const variant of mediaObject.variants) {
        await insertVariant(client, mediaObject.mediaId, variant, input.now);
      }
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
  const originalSafe = variants.find(({ variantName }) => variantName === "original_safe");
  if (!originalSafe) throw new Error("Profile images require an original_safe variant");
  if (
    variants.some(
      (variant) =>
        variant.visibility !== "public" ||
        !variant.publicCdnUrl?.startsWith("https://") ||
        !variant.checksumSha256?.match(/^[a-f0-9]{64}$/),
    )
  ) {
    throw new Error("Profile image variants must be checksummed public HTTPS media");
  }

  return {
    mediaId: file.sessionFile.mediaId,
    purpose: session.purpose,
    visibility: "public",
    requestedVisibility: "public",
    approvalStatus: "approved",
    lifecycleStatus: "active",
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
    variants,
    createdAt: now,
  };
}

async function insertMediaObject(
  client: Queryable,
  mediaObject: PlatformMediaObjectRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.media_objects
       (id, bucket, storage_key, storage_kind, visibility, purpose,
        owner_organization_id, property_id, resource_product, resource_type,
        resource_id, lifecycle_status, content_type, size_bytes, checksum_sha256,
        width_px, height_px, original_filename, source_metadata, public_approved,
        created_by_user_id, created_at, updated_at)
     VALUES
       ($1::uuid, $2, $3, 'vayada_managed', 'public', $4, $5::uuid, $6::uuid,
        $7, $8, $9, 'active', $10, $11, $12, $13, $14, $15, $16::jsonb,
        TRUE, $17::uuid, $18::timestamptz, $18::timestamptz)`,
    [
      mediaObject.mediaId,
      mediaObject.bucket,
      mediaObject.storageKey,
      mediaObject.purpose,
      mediaObject.ownerOrganizationId,
      mediaObject.propertyId ?? null,
      mediaObject.resourceProduct,
      mediaObject.resourceType,
      mediaObject.resourceId,
      mediaObject.contentType,
      mediaObject.sizeBytes,
      mediaObject.checksumSha256 ?? null,
      mediaObject.widthPx ?? null,
      mediaObject.heightPx ?? null,
      mediaObject.originalFilename,
      JSON.stringify({ requestedVisibility: mediaObject.requestedVisibility }),
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
     VALUES ($1::uuid, $2, 'public', $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
    [
      mediaId,
      variant.variantName,
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

async function readSession(
  queryable: Queryable,
  sessionId: string,
  forUpdate = false,
): Promise<PlatformMediaSessionRecord | null> {
  const result = await queryable.query<SessionRow>(
    `SELECT completion_metadata -> 'session' AS session
     FROM platform.media_upload_sessions
     WHERE id = $1::uuid${forUpdate ? " FOR UPDATE" : ""}`,
    [sessionId],
  );
  return result.rows[0]?.session ?? null;
}

async function readMediaObject(
  queryable: Queryable,
  mediaId: string,
): Promise<PlatformMediaObjectRecord | null> {
  const result = await queryable.query<MediaObjectRow>(
    `SELECT jsonb_strip_nulls(jsonb_build_object(
       'mediaId', media.id::text,
       'purpose', media.purpose,
       'visibility', media.visibility,
       'requestedVisibility', COALESCE(media.source_metadata ->> 'requestedVisibility', media.visibility),
       'approvalStatus', CASE WHEN media.public_approved THEN 'approved' ELSE 'pending_domain_approval' END,
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
       'createdAt', media.created_at
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
      JSON.stringify(event.metadata),
      JSON.stringify({ requestId: event.requestId, source: "apps/api-platform-media" }),
    ],
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
