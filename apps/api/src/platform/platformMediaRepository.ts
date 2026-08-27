import { randomUUID } from "node:crypto";

import pg, { type QueryResult, type QueryResultRow } from "pg";

import {
  type ApprovedPublicProfileImageRepository,
  type PlatformMediaAuditEvent,
  PlatformMediaCompletionError,
  PlatformMediaPlanLimitError,
  PlatformMediaTargetInvalidError,
  isAutoApprovedPublicMediaPurpose,
  type PlatformMediaObjectRecord,
  type PlatformMediaRepository,
  type PlatformMediaSessionRecord,
  type PlatformMediaTargetResolver,
  type PlatformMediaVariantRecord,
} from "../routes/platformMedia.js";
import { readPropertyPlan } from "../domains/propertyPlanReadModel.js";
import {
  assertCanonicalPrivatePropertyVariants,
  isCanonicalPrivatePropertyMediaObject,
  normalizePlatformMediaPathPrefix,
} from "./propertyMediaVariantContract.js";

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
  mediaPathPrefix?: string;
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
  "booking.header_logo",
  "property.hero_image",
  "property.gallery_image",
  "property.logo",
  "marketplace.creator.profile_image",
  "marketplace.offer.media",
  "marketplace.collaboration_chat.attachment",
  "pms.room_type.media",
  "finance.expense.receipt",
]);
const propertyMediaPurposes = new Set([
  "property.hero_image",
  "property.gallery_image",
  "property.logo",
  "pms.room_type.media",
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
  const mediaPathPrefix = normalizePlatformMediaPathPrefix(config.mediaPathPrefix ?? "media");

  return {
    persistent: true,
    publicCdnBaseUrl: config.publicCdnBaseUrl,
    async createUploadSession(input) {
      const requestedVisibility = input.request.visibility ?? "private";
      if (!supportedPurposes.has(input.request.purpose)) {
        throw new Error("Persistent platform media does not support this upload purpose");
      }
      const isAutoApproved = input.policy.autoApprovePublicOnFinalize === true;
      const isPropertyMedia = isCanonicalPropertyMediaRequest(input.request);
      if (propertyMediaPurposes.has(input.request.purpose) && !isPropertyMedia) {
        throw new Error("Property media requires a canonical property target");
      }
      if (
        (isAutoApproved && requestedVisibility !== "public") ||
        (!isAutoApproved && input.policy.purpose !== input.request.purpose) ||
        (isPropertyMedia &&
          (isAutoApproved
            ? requestedVisibility !== "public" || input.policy.privateOnly
            : requestedVisibility !== "private" || !input.policy.privateOnly))
      ) {
        throw new Error("Persistent platform media policy does not support this upload");
      }
      if (isPropertyMedia) assertCanonicalPropertyMediaSessionInput(input);

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
        await assertRoomMediaUploadWithinPlan(client, session);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO platform.media_upload_sessions
             (id, upload_session_key, requested_purpose, requested_visibility,
              actor_user_id, owner_organization_id, property_id, resource_product,
              resource_type, resource_id, expected_content_type, expected_size_bytes,
              expected_file_count, staging_prefix, expires_at, session_status,
              completion_metadata, created_at, updated_at)
           VALUES
             ($1::uuid, $2, $3, $4, $5::uuid, $6::uuid, $7::uuid, $8, $9, $10,
              $11, $12, $13, $14, $15::timestamptz, 'signed', $16::jsonb,
              $17::timestamptz, $17::timestamptz)
           ON CONFLICT DO NOTHING
           RETURNING id::text AS id`,
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
        if (inserted.rows.length === 0) {
          const existing = await readSession(client, session.sessionId);
          if (!existing) {
            throw new Error("Platform media upload session idempotency conflict");
          }
          await client.query("COMMIT");
          return existing;
        }
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
    async findUploadSessionForActor(input) {
      return readSession(pool, input.sessionId, false, {
        actorUserId: input.actorUserId,
        ownerOrganizationId: input.ownerOrganizationId,
      });
    },
    async renewSignedUploadSession(input) {
      const renewed = {
        ...input.session,
        expiresAt: input.expiresAt,
        uploadTargets: input.session.uploadTargets.map((target) => ({
          ...target,
          expiresAt: input.expiresAt,
        })),
      };
      const result = await pool.query<SessionRow>(
        `UPDATE platform.media_upload_sessions
         SET expires_at = $4::timestamptz,
             completion_metadata = jsonb_set(
               completion_metadata,
               '{session}',
               $3::jsonb,
               true
             ),
             updated_at = $5::timestamptz
         WHERE id = $1::uuid
           AND session_status = 'signed'
           AND expires_at = $2::timestamptz
         RETURNING
           completion_metadata -> 'session' AS session,
           completed_media_object_id::text AS "completedMediaObjectId",
           completion_metadata -> 'mediaObjectIds' AS "mediaObjectIds"
         /* platform_media_upload_session_renewal */`,
        [
          input.session.sessionId,
          input.session.expiresAt,
          JSON.stringify(persistedSession(renewed)),
          input.expiresAt,
          input.now,
        ],
      );
      if (result.rows[0]?.session) return result.rows[0].session;

      const current = await readSession(pool, input.session.sessionId);
      if (!current) throw new Error("Platform media upload session was not found");
      return current;
    },
    async findMediaObject(mediaId) {
      return readMediaObject(pool, mediaId);
    },
    async resolveTarget(input) {
      return resolveTarget(pool, input);
    },
    async completeUploadSession(input) {
      return completeUploadSession(pool, input, mediaPathPrefix);
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

async function assertRoomMediaUploadWithinPlan(
  client: Queryable,
  session: PlatformMediaSessionRecord,
): Promise<void> {
  if (session.purpose !== "pms.room_type.media" || !isCanonicalPropertyMediaRequest(session)) {
    return;
  }
  const propertyId = session.target.propertyId;
  if (!propertyId) throw new PlatformMediaTargetInvalidError();
  const count = await client.query<{ currentCount: number | string }>(
    `SELECT GREATEST(
       CASE
         WHEN jsonb_typeof(room_type.media_snapshot) = 'array'
           THEN jsonb_array_length(room_type.media_snapshot)
         ELSE 0
       END,
       (SELECT count(*)::integer
        FROM pms.room_type_media assignment
        WHERE assignment.property_id = room_type.property_id
          AND assignment.room_type_id = room_type.id)
     ) AS "currentCount"
     FROM pms.room_types room_type
     WHERE room_type.property_id = $1::uuid
       AND room_type.id = $2::uuid
     FOR UPDATE`,
    [propertyId, session.target.resourceId],
  );
  if (count.rows.length !== 1) throw new PlatformMediaTargetInvalidError();
  const currentCount = Number(count.rows[0]!.currentCount);
  const propertyPlan = await readPropertyPlan(client, propertyId);
  if (currentCount + session.files.length > propertyPlan.limits.maxRoomPhotosPerType) {
    throw new PlatformMediaPlanLimitError(
      propertyPlan.plan,
      currentCount,
      propertyPlan.limits.maxRoomPhotosPerType,
    );
  }
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

  if (isCanonicalPropertyMediaRequest(input.request)) {
    const propertyId = input.request.resource.resourceId;
    const roomTypeId = input.request.resource.targetResourceId;
    if (
      !CANONICAL_UUID.test(propertyId) ||
      (input.request.purpose === "pms.room_type.media" &&
        (!roomTypeId || !CANONICAL_UUID.test(roomTypeId)))
    ) {
      return propertyMediaTargetForbidden();
    }
    const result =
      input.request.purpose === "pms.room_type.media"
        ? await queryable.query<PropertyTargetRow>(
            `SELECT room_type.property_id::text AS "propertyId"
             FROM pms.room_types room_type
             WHERE room_type.id = $1::uuid
               AND room_type.property_id = $2::uuid
             LIMIT 1`,
            [roomTypeId, propertyId],
          )
        : await queryable.query<PropertyTargetRow>(
            `SELECT property.id::text AS "propertyId"
             FROM hotel_catalog.properties property
             WHERE property.id = $1::uuid
             LIMIT 1`,
            [propertyId],
          );
    if (result.rows.length !== 1) return propertyMediaTargetForbidden();
    return {
      ok: true,
      target: {
        resourceProduct: input.policy.targetResourceProduct,
        resourceType: input.policy.targetResourceType,
        resourceId: input.request.purpose === "pms.room_type.media" ? roomTypeId! : propertyId,
        propertyId,
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
  return propertyMediaTargetForbidden();
}

function propertyMediaTargetForbidden() {
  return {
    ok: false as const,
    statusCode: 403 as const,
    code: "media_target_forbidden",
    message: "Property media target is unavailable.",
  };
}

function assertCanonicalPropertyMediaSessionInput(
  input: Parameters<PlatformMediaRepository["createUploadSession"]>[0],
): void {
  const propertyId = input.request.resource.resourceId;
  const roomTypeId = input.request.resource.targetResourceId;
  const isRoomMedia = input.request.purpose === "pms.room_type.media";
  const hasCanonicalResource =
    input.request.resource.product === "hotel_catalog" &&
    input.request.resource.resourceType === "property" &&
    CANONICAL_UUID.test(propertyId) &&
    (input.request.resource.propertyId === undefined ||
      input.request.resource.propertyId === propertyId);
  const hasCanonicalTarget =
    input.target.propertyId === propertyId &&
    (isRoomMedia
      ? CANONICAL_UUID.test(roomTypeId ?? "") &&
        input.target.resourceProduct === "pms" &&
        input.target.resourceType === "room_type" &&
        input.target.resourceId === roomTypeId
      : roomTypeId === undefined &&
        input.target.resourceProduct === "hotel_catalog" &&
        input.target.resourceType === "property" &&
        input.target.resourceId === propertyId);
  if (!hasCanonicalResource || !hasCanonicalTarget) {
    throw new Error("Property media requires a canonical property target");
  }
}

function isCanonicalPropertyMediaRequest(
  request: Pick<PlatformMediaSessionRecord, "purpose" | "resource">,
): boolean {
  return (
    propertyMediaPurposes.has(request.purpose) &&
    request.resource.product === "hotel_catalog" &&
    request.resource.resourceType === "property"
  );
}

async function completeUploadSession(
  pool: PlatformMediaPool,
  input: Parameters<PlatformMediaRepository["completeUploadSession"]>[0],
  mediaPathPrefix: string,
): ReturnType<PlatformMediaRepository["completeUploadSession"]> {
  const client = await pool.connect();
  let transactionStarted = false;
  let commitAttempted = false;
  let uncertainCommitError: unknown;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const session = await readSession(client, input.session.sessionId, true);
    if (!session) throw new Error("Platform media upload session was not found");
    if (session.status === "completed") {
      assertCompletedPropertyMediaIsCanonical(session, mediaPathPrefix);
      await recordAudit(client, input.auditEvent);
      commitAttempted = true;
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
    if (propertyMediaPurposes.has(session.purpose) && !isCanonicalPropertyMediaRequest(session)) {
      throw new PlatformMediaTargetInvalidError();
    }
    const isAutoApproved = isAutoApprovedPublicSession(session);
    if (
      (isAutoApproved &&
        (session.requestedVisibility !== "public" || session.effectiveVisibility !== "public")) ||
      (!isAutoApproved && session.effectiveVisibility !== "private")
    ) {
      throw new Error("Persistent platform media session has an invalid visibility state");
    }
    await lockCurrentRoomTarget(client, session);

    const files = bindCompletionFilesToSession(session, input.files);
    const mediaObjects = files.map((file, index) =>
      mediaObjectFor(
        session,
        file,
        input.variantSets[index] ?? [],
        input.bucketName,
        mediaPathPrefix,
        input.now,
      ),
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
    commitAttempted = true;
    await client.query("COMMIT");
    return { uploadSession: completedSession, mediaObjects };
  } catch (error) {
    if (!transactionStarted) {
      throw new PlatformMediaCompletionError("rolled_back", error);
    }
    if (!commitAttempted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new PlatformMediaCompletionError(
          "unknown",
          new AggregateError([error, rollbackError], "Platform media rollback failed"),
        );
      }
      if (error instanceof PlatformMediaTargetInvalidError) {
        throw error;
      }
      throw new PlatformMediaCompletionError("rolled_back", error);
    }
    uncertainCommitError = error;
  } finally {
    client.release();
  }

  try {
    const reconciled = await readSession(pool, input.session.sessionId);
    if (reconciled?.status === "completed") {
      assertCompletedPropertyMediaIsCanonical(reconciled, mediaPathPrefix);
      return {
        uploadSession: reconciled,
        mediaObjects:
          reconciled.completedMediaObjects ??
          (reconciled.completedMediaObject ? [reconciled.completedMediaObject] : []),
      };
    }
  } catch (reconciliationError) {
    throw new PlatformMediaCompletionError(
      "unknown",
      new AggregateError(
        [uncertainCommitError, reconciliationError],
        "Platform media commit reconciliation failed",
      ),
    );
  }
  throw new PlatformMediaCompletionError("unknown", uncertainCommitError);
}

function bindCompletionFilesToSession(
  session: PlatformMediaSessionRecord,
  files: Parameters<PlatformMediaRepository["completeUploadSession"]>[0]["files"],
): Parameters<PlatformMediaRepository["completeUploadSession"]>[0]["files"] {
  if (files.length !== session.files.length) {
    throw new Error("Platform media completion file count does not match the signed session");
  }
  const byUploadTargetId = new Map(files.map((file) => [file.uploadTarget.uploadTargetId, file]));
  if (byUploadTargetId.size !== files.length) {
    throw new Error("Platform media completion contains duplicate upload targets");
  }
  return session.files.map((sessionFile) => {
    const file = byUploadTargetId.get(sessionFile.uploadTargetId);
    if (!file) throw new Error("Platform media completion is missing a signed upload target");
    return { ...file, sessionFile };
  });
}

function isAutoApprovedPublicSession(session: PlatformMediaSessionRecord): boolean {
  return isAutoApprovedPublicMediaPurpose(session.purpose);
}

function mediaObjectFor(
  session: PlatformMediaSessionRecord,
  file: Parameters<PlatformMediaRepository["completeUploadSession"]>[0]["files"][number],
  variants: PlatformMediaVariantRecord[],
  bucketName: string,
  mediaPathPrefix: string,
  now: string,
): PlatformMediaObjectRecord {
  if (isCanonicalPropertyMediaRequest(session) && !isAutoApprovedPublicSession(session)) {
    assertCanonicalPrivatePropertyVariants({
      mediaId: file.sessionFile.mediaId,
      variants,
      mediaPathPrefix,
    });
  }
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
      session.purpose === "marketplace.collaboration_chat.attachment" ||
      session.purpose === "finance.expense.receipt"
        ? new Date(Date.parse(now) + 60 * 60 * 1000).toISOString()
        : null,
    variants,
    createdAt: now,
  };
}

async function lockCurrentRoomTarget(
  client: Queryable,
  session: PlatformMediaSessionRecord,
): Promise<void> {
  if (session.purpose !== "pms.room_type.media" || !isCanonicalPropertyMediaRequest(session)) {
    return;
  }
  const propertyId = session.target.propertyId;
  if (!propertyId || !CANONICAL_UUID.test(session.target.resourceId)) {
    throw new Error("PMS room media requires a canonical room target");
  }
  const result = await client.query<PropertyTargetRow>(
    `SELECT room_type.property_id::text AS "propertyId"
     FROM pms.room_types room_type
     WHERE room_type.id = $1::uuid
       AND room_type.property_id = $2::uuid
     FOR KEY SHARE`,
    [session.target.resourceId, propertyId],
  );
  if (result.rows.length !== 1) {
    throw new PlatformMediaTargetInvalidError();
  }
}

function assertCompletedPropertyMediaIsCanonical(
  session: PlatformMediaSessionRecord,
  mediaPathPrefix: string,
): void {
  if (!isCanonicalPropertyMediaRequest(session)) return;
  const mediaObjects =
    session.completedMediaObjects ??
    (session.completedMediaObject ? [session.completedMediaObject] : []);
  const expectedMediaIds = new Set(session.files.map(({ mediaId }) => mediaId));
  if (
    mediaObjects.length !== expectedMediaIds.size ||
    mediaObjects.some(
      (mediaObject) =>
        !expectedMediaIds.delete(mediaObject.mediaId) ||
        mediaObject.purpose !== session.purpose ||
        !(isAutoApprovedPublicSession(session)
          ? isCanonicalPublicRoomMediaObject(mediaObject)
          : isCanonicalPrivatePropertyMediaObject({ mediaObject, mediaPathPrefix })),
    )
  ) {
    throw new Error("Completed property media is not reusable");
  }
}

function isCanonicalPublicRoomMediaObject(mediaObject: PlatformMediaObjectRecord): boolean {
  return (
    mediaObject.purpose === "pms.room_type.media" &&
    mediaObject.visibility === "public" &&
    mediaObject.requestedVisibility === "public" &&
    mediaObject.approvalStatus === "approved" &&
    mediaObject.lifecycleStatus === "active" &&
    mediaObject.variants.length > 0 &&
    mediaObject.variants.every(
      (variant) => variant.visibility === "public" && variant.publicCdnUrl?.startsWith("https://"),
    )
  );
}

async function insertMediaObject(
  client: Queryable,
  mediaObject: PlatformMediaObjectRecord,
): Promise<void> {
  const sourceMetadata = {
    requestedVisibility: mediaObject.requestedVisibility,
    ...(mediaObject.purpose === "marketplace.collaboration_chat.attachment" ||
    mediaObject.purpose === "finance.expense.receipt"
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
          WHEN $5 IN ('marketplace.collaboration_chat.attachment', 'finance.expense.receipt')
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

async function readSession(
  queryable: Queryable,
  sessionId: string,
  forUpdate = false,
  scope?: { actorUserId: string; ownerOrganizationId: string },
): Promise<PlatformMediaSessionRecord | null> {
  if (
    !CANONICAL_UUID.test(sessionId) ||
    (scope &&
      (!CANONICAL_UUID.test(scope.actorUserId) || !CANONICAL_UUID.test(scope.ownerOrganizationId)))
  ) {
    return null;
  }
  const result = await queryable.query<SessionRow>(
    `SELECT completion_metadata -> 'session' AS session,
            completed_media_object_id::text AS "completedMediaObjectId",
            completion_metadata -> 'mediaObjectIds' AS "mediaObjectIds"
     FROM platform.media_upload_sessions
     WHERE id = $1::uuid
       ${scope ? "AND actor_user_id = $2::uuid AND owner_organization_id = $3::uuid" : ""}
     ${forUpdate ? "FOR UPDATE" : ""}`,
    scope ? [sessionId, scope.actorUserId, scope.ownerOrganizationId] : [sessionId],
  );
  const row = result.rows[0];
  if (!row?.session) return null;
  if (row.session.status !== "completed") return row.session;
  if (
    isCanonicalPropertyMediaRequest(row.session) &&
    (row.session.completedMediaObjects?.length || row.session.completedMediaObject)
  ) {
    return row.session;
  }

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
