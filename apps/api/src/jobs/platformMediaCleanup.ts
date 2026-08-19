import { createHash } from "node:crypto";
import pg from "pg";

export const PLATFORM_MEDIA_CLEANUP_CONTRACT_VERSION = "platform-media-cleanup-jobs.v1";
export const PLATFORM_MEDIA_CLEANUP_QUEUE = "platform.media.cleanup";
export const DEFAULT_PLATFORM_MEDIA_CLEANUP_LIMIT = 100;

export type PlatformMediaCleanupRunName =
  | "abandonedStagingUploads"
  | "replacedPublicImages"
  | "privateAttachmentRetention"
  | "rollbackWindowCleanup";

export type PlatformMediaCleanupAction =
  | "abandoned-staging-upload"
  | "delete-replaced-public-image"
  | "delete-private-attachment-after-retention"
  | "cleanup-rollback-window-object";

export type PlatformMediaCleanupCandidate = {
  mediaObjectId?: string;
  uploadSessionId?: string;
  ownerOrganizationId?: string | null;
  propertyId?: string | null;
  resourceProduct: string;
  resourceType: string;
  resourceId: string;
  purpose?: string;
  visibility?: "public" | "private";
  lifecycleStatus: string;
  bucket?: string | null;
  storageKey?: string | null;
  stagingPrefix?: string | null;
  retainedUntil?: string | null;
  deletionRequestedAt?: string | null;
  expiresAt?: string | null;
  rollbackWindowEndsAt?: string | null;
  rollbackBucket?: string | null;
  rollbackStorageKey?: string | null;
  replacedByMediaObjectId?: string | null;
};

export type PlatformMediaCleanupContext = {
  now: Date;
  correlationId: string;
  workerId: string;
};

export type PlatformMediaCleanupMutation = {
  action: PlatformMediaCleanupAction;
  runName: PlatformMediaCleanupRunName;
  jobType: string;
  eventType: string;
  auditAction: string;
  deadlineOrWindow: string;
};

export type PlatformMediaCleanupMutationResult = {
  action: PlatformMediaCleanupAction;
  applied: boolean;
  resourceId: string;
  cleanupKey: string;
  jobKey: string;
};

export type PlatformMediaCleanupFailureResult = {
  action: PlatformMediaCleanupAction;
  resourceId: string;
  cleanupKey: string;
  jobKey: string;
  reasonCode: "media_storage_delete_failed" | "media_cleanup_apply_failed";
  errorType: string;
  errorMessage: string;
  deadLettered: boolean;
};

export type PlatformMediaCleanupRunResult = {
  name: PlatformMediaCleanupRunName;
  scanned: number;
  applied: number;
  skipped: number;
  failed: number;
  mutations: PlatformMediaCleanupMutationResult[];
  failures: PlatformMediaCleanupFailureResult[];
};

export type PlatformMediaCleanupSchedulerResult = {
  contractVersion: typeof PLATFORM_MEDIA_CLEANUP_CONTRACT_VERSION;
  runs: PlatformMediaCleanupRunResult[];
  scanned: number;
  applied: number;
  skipped: number;
  failed: number;
};

export type PlatformMediaCleanupStore = {
  findAbandonedStagingUploads(now: Date, limit: number): Promise<PlatformMediaCleanupCandidate[]>;
  findReplacedPublicImages(now: Date, limit: number): Promise<PlatformMediaCleanupCandidate[]>;
  findPrivateAttachmentsPastRetention(
    now: Date,
    limit: number,
  ): Promise<PlatformMediaCleanupCandidate[]>;
  findRollbackWindowCleanupCandidates(
    now: Date,
    limit: number,
  ): Promise<PlatformMediaCleanupCandidate[]>;
  applyCleanupMutation(
    candidate: PlatformMediaCleanupCandidate,
    mutation: PlatformMediaCleanupMutation,
    context: PlatformMediaCleanupContext,
  ): Promise<PlatformMediaCleanupMutationResult>;
  recordCleanupFailure(
    candidate: PlatformMediaCleanupCandidate,
    mutation: PlatformMediaCleanupMutation,
    error: unknown,
    context: PlatformMediaCleanupContext,
  ): Promise<PlatformMediaCleanupFailureResult>;
};

export type PlatformMediaCleanupSchedulerOptions = {
  now?: Date;
  workerId?: string;
  limit?: number;
  run?: readonly PlatformMediaCleanupRunName[];
};

type PgPlatformMediaCleanupStoreConfig = {
  connectionString: string;
  max?: number;
  objectDeleter: PlatformMediaObjectDeleter;
};

export type PlatformMediaObjectDeleter = {
  deleteObject(input: { bucket: string; storageKey: string }): Promise<void>;
  deletePrefix(input: { bucket?: string | null; prefix: string }): Promise<void>;
};

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type CandidateRow = {
  mediaObjectId?: string | null;
  uploadSessionId?: string | null;
  ownerOrganizationId?: string | null;
  propertyId?: string | null;
  resourceProduct: string;
  resourceType: string;
  resourceId: string;
  purpose?: string | null;
  visibility?: "public" | "private" | null;
  lifecycleStatus: string;
  bucket?: string | null;
  storageKey?: string | null;
  stagingPrefix?: string | null;
  retainedUntil?: string | Date | null;
  deletionRequestedAt?: string | Date | null;
  expiresAt?: string | Date | null;
  rollbackWindowEndsAt?: string | Date | null;
  rollbackBucket?: string | null;
  rollbackStorageKey?: string | null;
  replacedByMediaObjectId?: string | null;
};

const CLEANUP_RUNS: readonly PlatformMediaCleanupRunName[] = [
  "abandonedStagingUploads",
  "replacedPublicImages",
  "privateAttachmentRetention",
  "rollbackWindowCleanup",
];

const MUTATIONS: Record<
  PlatformMediaCleanupRunName,
  Omit<PlatformMediaCleanupMutation, "deadlineOrWindow">
> = {
  abandonedStagingUploads: {
    action: "abandoned-staging-upload",
    runName: "abandonedStagingUploads",
    jobType: "platform.media.cleanup.abandoned-staging-upload",
    eventType: "platform_media.upload_session.expired",
    auditAction: "platform_media.cleanup.abandoned_staging_upload",
  },
  replacedPublicImages: {
    action: "delete-replaced-public-image",
    runName: "replacedPublicImages",
    jobType: "platform.media.cleanup.delete-replaced-public-image",
    eventType: "platform_media.object.deleted",
    auditAction: "platform_media.cleanup.replaced_public_image_deleted",
  },
  privateAttachmentRetention: {
    action: "delete-private-attachment-after-retention",
    runName: "privateAttachmentRetention",
    jobType: "platform.media.cleanup.private-attachment-retention",
    eventType: "platform_media.private_attachment.deleted_after_retention",
    auditAction: "platform_media.cleanup.private_attachment_deleted_after_retention",
  },
  rollbackWindowCleanup: {
    action: "cleanup-rollback-window-object",
    runName: "rollbackWindowCleanup",
    jobType: "platform.media.cleanup.rollback-window-object",
    eventType: "platform_media.rollback_window.cleaned",
    auditAction: "platform_media.cleanup.rollback_window_object_deleted",
  },
};

export function createPgPlatformMediaCleanupStore(
  config: PgPlatformMediaCleanupStoreConfig,
): PlatformMediaCleanupStore & { close(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
  });
  const objectDeleter = config.objectDeleter;

  return {
    async findAbandonedStagingUploads(now, limit) {
      return selectAbandonedStagingUploads(pool, now, limit);
    },
    async findReplacedPublicImages(now, limit) {
      return selectReplacedPublicImages(pool, now, limit);
    },
    async findPrivateAttachmentsPastRetention(now, limit) {
      return selectPrivateAttachmentsPastRetention(pool, now, limit);
    },
    async findRollbackWindowCleanupCandidates(now, limit) {
      return selectRollbackWindowCleanupCandidates(pool, now, limit);
    },
    async applyCleanupMutation(candidate, mutation, context) {
      return applyPgCleanupMutation(pool, objectDeleter, candidate, mutation, context);
    },
    async recordCleanupFailure(candidate, mutation, error, context) {
      return recordPgCleanupFailure(pool, candidate, mutation, error, context);
    },
    async close() {
      await pool.end();
    },
  };
}

export async function runPlatformMediaCleanupJobs(
  store: PlatformMediaCleanupStore,
  options: PlatformMediaCleanupSchedulerOptions = {},
): Promise<PlatformMediaCleanupSchedulerResult> {
  const now = options.now ?? new Date();
  const context: PlatformMediaCleanupContext = {
    now,
    correlationId: `platform.media.cleanup:${now.toISOString()}`,
    workerId: options.workerId ?? "platform-media-cleanup-scheduler",
  };
  const limit = options.limit ?? DEFAULT_PLATFORM_MEDIA_CLEANUP_LIMIT;
  const selectedRuns = options.run ?? CLEANUP_RUNS;
  const runs: PlatformMediaCleanupRunResult[] = [];

  for (const runName of selectedRuns) {
    runs.push(await runPlatformMediaCleanupJob(store, runName, { now, limit, context }));
  }

  return {
    contractVersion: PLATFORM_MEDIA_CLEANUP_CONTRACT_VERSION,
    runs,
    scanned: sumBy(runs, "scanned"),
    applied: sumBy(runs, "applied"),
    skipped: sumBy(runs, "skipped"),
    failed: sumBy(runs, "failed"),
  };
}

export function buildPlatformMediaCleanupKey(input: {
  action: PlatformMediaCleanupAction;
  resourceId: string;
  deadlineOrWindow: string;
}): string {
  return `platform.media.cleanup:${input.resourceId}:${input.action}:${input.deadlineOrWindow}:v1`;
}

export function buildPlatformMediaCleanupJobKey(input: {
  action: PlatformMediaCleanupAction;
  resourceId: string;
  deadlineOrWindow: string;
}): string {
  return `platform.media.cleanup:job:${input.resourceId}:${input.action}:${input.deadlineOrWindow}:v1`;
}

async function runPlatformMediaCleanupJob(
  store: PlatformMediaCleanupStore,
  runName: PlatformMediaCleanupRunName,
  input: { now: Date; limit: number; context: PlatformMediaCleanupContext },
): Promise<PlatformMediaCleanupRunResult> {
  const candidates = await selectCandidatesForRun(store, runName, input);
  const mutationTemplate = MUTATIONS[runName];
  const mutations: PlatformMediaCleanupMutationResult[] = [];
  const failures: PlatformMediaCleanupFailureResult[] = [];

  for (const candidate of candidates) {
    const mutation = {
      ...mutationTemplate,
      deadlineOrWindow: deadlineOrWindowForCandidate(candidate, runName, input.now),
    };
    try {
      mutations.push(await store.applyCleanupMutation(candidate, mutation, input.context));
    } catch (error) {
      failures.push(await store.recordCleanupFailure(candidate, mutation, error, input.context));
    }
  }

  const applied = mutations.filter((mutation) => mutation.applied).length;
  return {
    name: runName,
    scanned: candidates.length,
    applied,
    skipped: candidates.length - applied - failures.length,
    failed: failures.length,
    mutations,
    failures,
  };
}

function selectCandidatesForRun(
  store: PlatformMediaCleanupStore,
  runName: PlatformMediaCleanupRunName,
  input: { now: Date; limit: number },
): Promise<PlatformMediaCleanupCandidate[]> {
  switch (runName) {
    case "abandonedStagingUploads":
      return store.findAbandonedStagingUploads(input.now, input.limit);
    case "replacedPublicImages":
      return store.findReplacedPublicImages(input.now, input.limit);
    case "privateAttachmentRetention":
      return store.findPrivateAttachmentsPastRetention(input.now, input.limit);
    case "rollbackWindowCleanup":
      return store.findRollbackWindowCleanupCandidates(input.now, input.limit);
  }
}

async function selectAbandonedStagingUploads(
  queryable: Queryable,
  now: Date,
  limit: number,
): Promise<PlatformMediaCleanupCandidate[]> {
  const result = await queryable.query<CandidateRow>(
    `SELECT
       NULL::text AS "mediaObjectId",
       id::text AS "uploadSessionId",
       owner_organization_id::text AS "ownerOrganizationId",
       property_id::text AS "propertyId",
       resource_product AS "resourceProduct",
       resource_type AS "resourceType",
       COALESCE(resource_id, id::text) AS "resourceId",
       requested_purpose AS purpose,
       requested_visibility AS visibility,
       session_status AS "lifecycleStatus",
       NULL::text AS bucket,
       NULL::text AS "storageKey",
       staging_prefix AS "stagingPrefix",
       NULL::timestamptz AS "retainedUntil",
       NULL::timestamptz AS "deletionRequestedAt",
       expires_at AS "expiresAt",
       NULL::timestamptz AS "rollbackWindowEndsAt",
       NULL::text AS "rollbackBucket",
       NULL::text AS "rollbackStorageKey",
       NULL::text AS "replacedByMediaObjectId"
     FROM platform.media_upload_sessions
     WHERE session_status IN ('requested', 'signed', 'uploaded', 'failed')
       AND expires_at <= $1::timestamptz
     ORDER BY expires_at ASC, created_at ASC
     LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows.map(candidateFromRow);
}

async function selectReplacedPublicImages(
  queryable: Queryable,
  now: Date,
  limit: number,
): Promise<PlatformMediaCleanupCandidate[]> {
  const result = await queryable.query<CandidateRow>(
    `SELECT
       id::text AS "mediaObjectId",
       NULL::text AS "uploadSessionId",
       owner_organization_id::text AS "ownerOrganizationId",
       property_id::text AS "propertyId",
       resource_product AS "resourceProduct",
       resource_type AS "resourceType",
       COALESCE(resource_id, id::text) AS "resourceId",
       purpose,
       visibility,
       lifecycle_status AS "lifecycleStatus",
       bucket,
       storage_key AS "storageKey",
       NULL::text AS "stagingPrefix",
       retained_until AS "retainedUntil",
       deletion_requested_at AS "deletionRequestedAt",
       NULL::timestamptz AS "expiresAt",
       NULLIF(source_metadata ->> 'rollbackWindowEndsAt', '')::timestamptz AS "rollbackWindowEndsAt",
       source_metadata ->> 'rollbackBucket' AS "rollbackBucket",
       source_metadata ->> 'rollbackStorageKey' AS "rollbackStorageKey",
       source_metadata ->> 'replacedByMediaObjectId' AS "replacedByMediaObjectId"
     FROM platform.media_objects
     WHERE visibility = 'public'
       AND lifecycle_status = 'delete_requested'
       AND deletion_requested_at <= $1::timestamptz
       AND COALESCE(source_metadata ->> 'replacementReason', '') = 'replaced'
     ORDER BY deletion_requested_at ASC, updated_at ASC
     LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows.map(candidateFromRow);
}

async function selectPrivateAttachmentsPastRetention(
  queryable: Queryable,
  now: Date,
  limit: number,
): Promise<PlatformMediaCleanupCandidate[]> {
  const result = await queryable.query<CandidateRow>(
    `SELECT
       id::text AS "mediaObjectId",
       NULL::text AS "uploadSessionId",
       owner_organization_id::text AS "ownerOrganizationId",
       property_id::text AS "propertyId",
       resource_product AS "resourceProduct",
       resource_type AS "resourceType",
       COALESCE(resource_id, id::text) AS "resourceId",
       purpose,
       visibility,
       lifecycle_status AS "lifecycleStatus",
       bucket,
       storage_key AS "storageKey",
       NULL::text AS "stagingPrefix",
       retained_until AS "retainedUntil",
       deletion_requested_at AS "deletionRequestedAt",
       NULL::timestamptz AS "expiresAt",
       NULLIF(source_metadata ->> 'rollbackWindowEndsAt', '')::timestamptz AS "rollbackWindowEndsAt",
       source_metadata ->> 'rollbackBucket' AS "rollbackBucket",
       source_metadata ->> 'rollbackStorageKey' AS "rollbackStorageKey",
       NULL::text AS "replacedByMediaObjectId"
     FROM platform.media_objects
     WHERE visibility = 'private'
       AND purpose IN ('marketplace.collaboration_chat.attachment', 'pms.messaging.attachment', 'finance.expense.receipt')
       AND lifecycle_status IN ('staged', 'active', 'retained', 'delete_requested')
       AND retained_until IS NOT NULL
       AND retained_until <= $1::timestamptz
     ORDER BY retained_until ASC, updated_at ASC
     LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows.map(candidateFromRow);
}

async function selectRollbackWindowCleanupCandidates(
  queryable: Queryable,
  now: Date,
  limit: number,
): Promise<PlatformMediaCleanupCandidate[]> {
  const result = await queryable.query<CandidateRow>(
    `SELECT
       id::text AS "mediaObjectId",
       NULL::text AS "uploadSessionId",
       owner_organization_id::text AS "ownerOrganizationId",
       property_id::text AS "propertyId",
       resource_product AS "resourceProduct",
       resource_type AS "resourceType",
       COALESCE(resource_id, id::text) AS "resourceId",
       purpose,
       visibility,
       lifecycle_status AS "lifecycleStatus",
       bucket,
       storage_key AS "storageKey",
       NULL::text AS "stagingPrefix",
       retained_until AS "retainedUntil",
       deletion_requested_at AS "deletionRequestedAt",
       NULL::timestamptz AS "expiresAt",
       NULLIF(source_metadata ->> 'rollbackWindowEndsAt', '')::timestamptz AS "rollbackWindowEndsAt",
       source_metadata ->> 'rollbackBucket' AS "rollbackBucket",
       source_metadata ->> 'rollbackStorageKey' AS "rollbackStorageKey",
       source_metadata ->> 'replacedByMediaObjectId' AS "replacedByMediaObjectId"
     FROM platform.media_objects
     WHERE source_system = 'migration'
       AND storage_kind = 'vayada_managed'
       AND NULLIF(source_metadata ->> 'rollbackWindowEndsAt', '')::timestamptz <= $1::timestamptz
       AND NULLIF(source_metadata ->> 'rollbackStorageKey', '') IS NOT NULL
       AND COALESCE(source_metadata ->> 'rollbackCleanupStatus', '') <> 'completed'
     ORDER BY NULLIF(source_metadata ->> 'rollbackWindowEndsAt', '')::timestamptz ASC, updated_at ASC
     LIMIT $2`,
    [now.toISOString(), limit],
  );
  return result.rows.map(candidateFromRow);
}

async function applyPgCleanupMutation(
  pool: pg.Pool,
  objectDeleter: PlatformMediaObjectDeleter,
  candidate: PlatformMediaCleanupCandidate,
  mutation: PlatformMediaCleanupMutation,
  context: PlatformMediaCleanupContext,
): Promise<PlatformMediaCleanupMutationResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result =
      mutation.action === "abandoned-staging-upload"
        ? await expireUploadSession(client, objectDeleter, candidate, mutation, context)
        : await updateMediaObjectLifecycle(client, objectDeleter, candidate, mutation, context);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function expireUploadSession(
  client: pg.PoolClient,
  objectDeleter: PlatformMediaObjectDeleter,
  candidate: PlatformMediaCleanupCandidate,
  mutation: PlatformMediaCleanupMutation,
  context: PlatformMediaCleanupContext,
): Promise<PlatformMediaCleanupMutationResult> {
  if (candidate.stagingPrefix) {
    await deleteStoragePrefixForCandidate(objectDeleter, candidate, candidate.stagingPrefix);
  }
  const updated = await client.query<{ resourceId: string }>(
    `UPDATE platform.media_upload_sessions
        SET session_status = 'expired',
            failure_reason = COALESCE(failure_reason, 'abandoned_staging_upload_cleanup'),
            updated_at = $2::timestamptz
      WHERE id = $1::uuid
        AND session_status IN ('requested', 'signed', 'uploaded', 'failed')
      RETURNING COALESCE(resource_id, id::text) AS "resourceId"`,
    [requiredCandidateId(candidate), context.now.toISOString()],
  );
  return insertCleanupSideEffects(client, candidate, mutation, context, {
    applied: Boolean(updated.rows[0]),
  });
}

async function updateMediaObjectLifecycle(
  client: pg.PoolClient,
  objectDeleter: PlatformMediaObjectDeleter,
  candidate: PlatformMediaCleanupCandidate,
  mutation: PlatformMediaCleanupMutation,
  context: PlatformMediaCleanupContext,
): Promise<PlatformMediaCleanupMutationResult> {
  if (mutation.action === "abandoned-staging-upload") {
    throw new Error("Upload-session cleanup cannot mutate a media object");
  }
  if (candidate.propertyId) {
    await client.query("SELECT id FROM hotel_catalog.properties WHERE id=$1::uuid FOR KEY SHARE", [
      candidate.propertyId,
    ]);
  }
  const storage = await lockEligibleMediaStorageForCleanup(
    client,
    requiredCandidateId(candidate),
    mutation.action,
    context.now,
  );
  if (!storage) return skippedCleanupMutation(candidate, mutation);

  if (mutation.action === "cleanup-rollback-window-object") {
    if (storage.rollbackStorageKey) {
      await deleteStorageObjectForCandidate(
        objectDeleter,
        candidate,
        requiredBucket(storage.rollbackBucket ?? storage.bucket, candidate),
        storage.rollbackStorageKey,
      );
    }
  } else {
    const storageKeys = distinctPlatformMediaStorageKeys(
      storage.storageKey,
      storage.variantStorageKeys,
    );
    if (storageKeys.length > 0) {
      const bucket = requiredBucket(storage.bucket, candidate);
      for (const storageKey of storageKeys) {
        await deleteStorageObjectForCandidate(objectDeleter, candidate, bucket, storageKey);
      }
    }
  }
  const updated =
    mutation.action === "cleanup-rollback-window-object"
      ? await client.query<{ resourceId: string }>(
          `UPDATE platform.media_objects
              SET source_metadata = source_metadata || $3::jsonb,
                  updated_at = $2::timestamptz
            WHERE id = $1::uuid
              AND COALESCE(source_metadata ->> 'rollbackCleanupStatus', '') <> 'completed'
            RETURNING COALESCE(resource_id, id::text) AS "resourceId"`,
          [
            requiredCandidateId(candidate),
            context.now.toISOString(),
            JSON.stringify({
              rollbackCleanupStatus: "completed",
              rollbackCleanupCompletedAt: context.now.toISOString(),
            }),
          ],
        )
      : await client.query<{ resourceId: string }>(
          `UPDATE platform.media_objects
              SET lifecycle_status = 'deleted',
                  deletion_requested_at = COALESCE(deletion_requested_at, $2::timestamptz),
                  deleted_at = COALESCE(deleted_at, $2::timestamptz),
                  source_metadata = source_metadata || $3::jsonb,
                  updated_at = $2::timestamptz
            WHERE id = $1::uuid
              AND lifecycle_status <> 'deleted'
            RETURNING COALESCE(resource_id, id::text) AS "resourceId"`,
          [
            requiredCandidateId(candidate),
            context.now.toISOString(),
            JSON.stringify({ cleanupAction: mutation.action }),
          ],
        );
  return insertCleanupSideEffects(client, candidate, mutation, context, {
    applied: Boolean(updated.rows[0]),
  });
}

async function lockEligibleMediaStorageForCleanup(
  client: pg.PoolClient,
  mediaObjectId: string,
  action: Exclude<PlatformMediaCleanupAction, "abandoned-staging-upload">,
  now: Date,
): Promise<{
  bucket: string | null;
  storageKey: string | null;
  variantStorageKeys: string[];
  rollbackBucket: string | null;
  rollbackStorageKey: string | null;
} | null> {
  const result = await client.query<{
    bucket: string | null;
    storageKey: string | null;
    variantStorageKeys: string[];
    rollbackBucket: string | null;
    rollbackStorageKey: string | null;
  }>(
    `SELECT media.bucket,
            media.storage_key AS "storageKey",
            media.source_metadata ->> 'rollbackBucket' AS "rollbackBucket",
            media.source_metadata ->> 'rollbackStorageKey' AS "rollbackStorageKey",
            ARRAY(
              SELECT variant.storage_key
              FROM platform.media_variants variant
              WHERE variant.media_object_id = media.id
              ORDER BY variant.variant_name, variant.id
            ) AS "variantStorageKeys"
     FROM platform.media_objects media
     WHERE media.id = $1::uuid
       AND ${mediaCleanupEligibilitySql(action)}
     FOR UPDATE`,
    [mediaObjectId, now.toISOString()],
  );
  return result.rows[0] ?? null;
}

function mediaCleanupEligibilitySql(
  action: Exclude<PlatformMediaCleanupAction, "abandoned-staging-upload">,
): string {
  switch (action) {
    case "delete-replaced-public-image":
      return `media.visibility = 'public'
       AND media.lifecycle_status = 'delete_requested'
       AND media.deletion_requested_at <= $2::timestamptz
       AND COALESCE(media.source_metadata ->> 'replacementReason', '') = 'replaced'`;
    case "delete-private-attachment-after-retention":
      return `media.visibility = 'private'
       AND media.purpose IN ('marketplace.collaboration_chat.attachment', 'pms.messaging.attachment', 'finance.expense.receipt')
       AND media.lifecycle_status IN ('staged', 'active', 'retained', 'delete_requested')
       AND media.retained_until IS NOT NULL
       AND media.retained_until <= $2::timestamptz`;
    case "cleanup-rollback-window-object":
      return `media.source_system = 'migration'
       AND media.storage_kind = 'vayada_managed'
       AND NULLIF(media.source_metadata ->> 'rollbackWindowEndsAt', '')::timestamptz <= $2::timestamptz
       AND NULLIF(media.source_metadata ->> 'rollbackStorageKey', '') IS NOT NULL
       AND COALESCE(media.source_metadata ->> 'rollbackCleanupStatus', '') <> 'completed'`;
  }
}

function skippedCleanupMutation(
  candidate: PlatformMediaCleanupCandidate,
  mutation: PlatformMediaCleanupMutation,
): PlatformMediaCleanupMutationResult {
  const resourceId = cleanupResourceId(candidate);
  return {
    action: mutation.action,
    applied: false,
    resourceId,
    cleanupKey: buildPlatformMediaCleanupKey({
      action: mutation.action,
      resourceId,
      deadlineOrWindow: mutation.deadlineOrWindow,
    }),
    jobKey: buildPlatformMediaCleanupJobKey({
      action: mutation.action,
      resourceId,
      deadlineOrWindow: mutation.deadlineOrWindow,
    }),
  };
}

export function distinctPlatformMediaStorageKeys(
  canonicalStorageKey: string | null | undefined,
  variantStorageKeys: readonly string[],
): string[] {
  return [...new Set([canonicalStorageKey, ...variantStorageKeys].filter(isStorageKey))];
}

function isStorageKey(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

async function insertCleanupSideEffects(
  client: pg.PoolClient,
  candidate: PlatformMediaCleanupCandidate,
  mutation: PlatformMediaCleanupMutation,
  context: PlatformMediaCleanupContext,
  result: { applied: boolean },
): Promise<PlatformMediaCleanupMutationResult> {
  const resourceId = cleanupResourceId(candidate);
  const cleanupKey = buildPlatformMediaCleanupKey({
    action: mutation.action,
    resourceId,
    deadlineOrWindow: mutation.deadlineOrWindow,
  });
  const jobKey = buildPlatformMediaCleanupJobKey({
    action: mutation.action,
    resourceId,
    deadlineOrWindow: mutation.deadlineOrWindow,
  });
  const keyHash = sha256Key(cleanupKey);
  const fingerprint = sha256Key(stableJson({ cleanupKey, action: mutation.action, resourceId }));
  const payload = auditSafeCleanupPayload(candidate, mutation, result.applied);
  const idempotencyKeyId = await insertCompletedCleanupIdempotencyKey(client, {
    candidate,
    mutation,
    cleanupKey,
    keyHash,
    fingerprint,
    resourceId,
    context,
  });
  const domainEventId = await insertOrFindCleanupDomainEvent(client, {
    candidate,
    mutation,
    cleanupKey,
    keyHash,
    payload,
    resourceId,
    context,
  });
  const jobId = await insertOrFindSucceededCleanupJob(client, {
    candidate,
    mutation,
    jobKey,
    keyHash,
    payload,
    resourceId,
    domainEventId,
    context,
  });
  await insertCleanupJobAttempt(client, jobId, "succeeded", context);
  await insertCleanupAudit(client, {
    candidate,
    mutation,
    cleanupKey,
    payload,
    idempotencyKeyId,
    domainEventId,
    jobId,
    context,
  });

  return {
    action: mutation.action,
    applied: result.applied,
    resourceId,
    cleanupKey,
    jobKey,
  };
}

async function recordPgCleanupFailure(
  pool: pg.Pool,
  candidate: PlatformMediaCleanupCandidate,
  mutation: PlatformMediaCleanupMutation,
  error: unknown,
  context: PlatformMediaCleanupContext,
): Promise<PlatformMediaCleanupFailureResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const failure = await insertCleanupFailureRows(client, candidate, mutation, error, context);
    await client.query("COMMIT");
    return failure;
  } catch (recordError) {
    await client.query("ROLLBACK");
    throw recordError;
  } finally {
    client.release();
  }
}

async function insertCleanupFailureRows(
  client: pg.PoolClient,
  candidate: PlatformMediaCleanupCandidate,
  mutation: PlatformMediaCleanupMutation,
  error: unknown,
  context: PlatformMediaCleanupContext,
): Promise<PlatformMediaCleanupFailureResult> {
  const resourceId = cleanupResourceId(candidate);
  const cleanupKey = buildPlatformMediaCleanupKey({
    action: mutation.action,
    resourceId,
    deadlineOrWindow: mutation.deadlineOrWindow,
  });
  const jobKey = buildPlatformMediaCleanupJobKey({
    action: mutation.action,
    resourceId,
    deadlineOrWindow: mutation.deadlineOrWindow,
  });
  const keyHash = sha256Key(cleanupKey);
  const errorInfo = errorDetails(error);
  const jobId = await insertOrFindFailedCleanupJob(client, {
    candidate,
    mutation,
    jobKey,
    keyHash,
    errorInfo,
    resourceId,
    context,
  });
  const attemptId = await insertCleanupJobAttempt(client, jobId, "failed", context, errorInfo);
  await client.query(
    `INSERT INTO platform.dead_letter_events
       (
         source_kind,
         job_id,
         job_attempt_id,
         tenant_scope,
         organization_id,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         reason_code,
         failure_summary,
         failure_payload
       )
     VALUES (
       'job',
       $1::uuid,
       $2::uuid,
       $3,
       $4::uuid,
       $5::uuid,
       'platform',
       $6,
       $7,
       $8,
       $9,
       $10,
       $11,
       $12::jsonb
     )
     ON CONFLICT DO NOTHING`,
    [
      jobId,
      attemptId,
      tenantScope(candidate),
      scopeOrganizationId(candidate),
      scopePropertyId(candidate),
      cleanupTargetResourceType(candidate),
      resourceId,
      context.correlationId,
      keyHash,
      failureReasonCode(error),
      errorInfo.message,
      JSON.stringify({
        cleanupKey,
        jobKey,
        action: mutation.action,
        errorType: errorInfo.type,
        errorMessage: errorInfo.message,
      }),
    ],
  );
  return {
    action: mutation.action,
    resourceId,
    cleanupKey,
    jobKey,
    reasonCode: failureReasonCode(error),
    errorType: errorInfo.type,
    errorMessage: errorInfo.message,
    deadLettered: true,
  };
}

async function insertCompletedCleanupIdempotencyKey(
  client: pg.PoolClient,
  input: {
    candidate: PlatformMediaCleanupCandidate;
    mutation: PlatformMediaCleanupMutation;
    cleanupKey: string;
    keyHash: string;
    fingerprint: string;
    resourceId: string;
    context: PlatformMediaCleanupContext;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys
       (
         operation_scope,
         operation,
         key_hash,
         request_fingerprint_hash,
         status,
         tenant_scope,
         organization_id,
         property_id,
         response_status_code,
         response_body_hash,
         response_resource_product,
         response_resource_type,
         response_resource_id,
         correlation_id,
         completed_at,
         expires_at,
         idempotency_metadata
       )
     VALUES (
       'platform',
       $1,
       $2,
       $3,
       'completed',
       $4,
       $5::uuid,
       $6::uuid,
       200,
       $3,
       'platform',
       $7,
       $8,
       $9,
       $10::timestamptz,
       $11::timestamptz,
       $12::jsonb
     )
     ON CONFLICT (operation_scope, operation, key_hash, scope_key)
     DO UPDATE SET
       last_seen_at = now(),
       status = 'completed',
       completed_at = COALESCE(platform.idempotency_keys.completed_at, EXCLUDED.completed_at)
     RETURNING id`,
    [
      input.mutation.action,
      input.keyHash,
      input.fingerprint,
      tenantScope(input.candidate),
      scopeOrganizationId(input.candidate),
      scopePropertyId(input.candidate),
      cleanupTargetResourceType(input.candidate),
      input.resourceId,
      input.context.correlationId,
      input.context.now.toISOString(),
      new Date(input.context.now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify({
        cleanupKey: input.cleanupKey,
        source: "apps/api-platform-media-cleanup",
      }),
    ],
  );
  return result.rows[0]!.id;
}

async function insertOrFindCleanupDomainEvent(
  client: pg.PoolClient,
  input: {
    candidate: PlatformMediaCleanupCandidate;
    mutation: PlatformMediaCleanupMutation;
    cleanupKey: string;
    keyHash: string;
    payload: Record<string, unknown>;
    resourceId: string;
    context: PlatformMediaCleanupContext;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `WITH inserted AS (
       INSERT INTO platform.domain_events
         (
           source_system,
           event_key,
           event_type,
           occurred_at,
           tenant_scope,
           organization_id,
           property_id,
           resource_product,
           resource_type,
           resource_id,
           actor_type,
           correlation_id,
           causation_id,
           idempotency_key_hash,
           payload,
           event_metadata,
           privacy_scope
         )
       VALUES (
         'platform',
         $1,
         $2,
         $3::timestamptz,
         $4,
         $5::uuid,
         $6::uuid,
         'platform',
         $7,
         $8,
         'system',
         $9,
         $10,
         $11,
         $12::jsonb,
         $13::jsonb,
         'internal'
       )
       ON CONFLICT (source_system, event_key) DO NOTHING
       RETURNING id
     )
     SELECT id FROM inserted
     UNION ALL
     SELECT id FROM platform.domain_events WHERE source_system = 'platform' AND event_key = $1
     LIMIT 1`,
    [
      input.cleanupKey,
      input.mutation.eventType,
      input.context.now.toISOString(),
      tenantScope(input.candidate),
      scopeOrganizationId(input.candidate),
      scopePropertyId(input.candidate),
      cleanupTargetResourceType(input.candidate),
      input.resourceId,
      input.context.correlationId,
      input.mutation.jobType,
      input.keyHash,
      JSON.stringify(input.payload),
      JSON.stringify({
        action: input.mutation.action,
        source: "apps/api-platform-media-cleanup",
      }),
    ],
  );
  return result.rows[0]!.id;
}

async function insertOrFindSucceededCleanupJob(
  client: pg.PoolClient,
  input: {
    candidate: PlatformMediaCleanupCandidate;
    mutation: PlatformMediaCleanupMutation;
    jobKey: string;
    keyHash: string;
    payload: Record<string, unknown>;
    resourceId: string;
    domainEventId: string;
    context: PlatformMediaCleanupContext;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.jobs
       (
         job_key,
         queue_name,
         job_type,
         source_domain_event_id,
         status,
         attempts_count,
         run_after,
         finished_at,
         tenant_scope,
         organization_id,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         payload,
         job_metadata
       )
     VALUES (
       $1,
       $2,
       $3,
       $4::uuid,
       'succeeded',
       1,
       $5::timestamptz,
       $5::timestamptz,
       $6,
       $7::uuid,
       $8::uuid,
       'platform',
       $9,
       $10,
       $11,
       $12,
       $13::jsonb,
       $14::jsonb
     )
     ON CONFLICT (queue_name, job_key)
     DO UPDATE SET
       updated_at = now(),
       status = CASE
         WHEN platform.jobs.status IN ('succeeded', 'dead_lettered', 'canceled')
         THEN platform.jobs.status
         ELSE 'succeeded'
       END,
       finished_at = COALESCE(platform.jobs.finished_at, EXCLUDED.finished_at)
     RETURNING id`,
    [
      input.jobKey,
      PLATFORM_MEDIA_CLEANUP_QUEUE,
      input.mutation.jobType,
      input.domainEventId,
      input.context.now.toISOString(),
      tenantScope(input.candidate),
      scopeOrganizationId(input.candidate),
      scopePropertyId(input.candidate),
      cleanupTargetResourceType(input.candidate),
      input.resourceId,
      input.context.correlationId,
      input.keyHash,
      JSON.stringify(input.payload),
      JSON.stringify({
        action: input.mutation.action,
        workerId: input.context.workerId,
        source: "apps/api-platform-media-cleanup",
      }),
    ],
  );
  return result.rows[0]!.id;
}

async function insertOrFindFailedCleanupJob(
  client: pg.PoolClient,
  input: {
    candidate: PlatformMediaCleanupCandidate;
    mutation: PlatformMediaCleanupMutation;
    jobKey: string;
    keyHash: string;
    errorInfo: { type: string; message: string };
    resourceId: string;
    context: PlatformMediaCleanupContext;
  },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.jobs
       (
         job_key,
         queue_name,
         job_type,
         status,
         attempts_count,
         max_attempts,
         run_after,
         finished_at,
         tenant_scope,
         organization_id,
         property_id,
         resource_product,
         resource_type,
         resource_id,
         correlation_id,
         idempotency_key_hash,
         payload,
         job_metadata
       )
     VALUES (
       $1,
       $2,
       $3,
       'dead_lettered',
       1,
       1,
       $4::timestamptz,
       $4::timestamptz,
       $5,
       $6::uuid,
       $7::uuid,
       'platform',
       $8,
       $9,
       $10,
       $11,
       $12::jsonb,
       $13::jsonb
     )
     ON CONFLICT (queue_name, job_key)
     DO UPDATE SET
       updated_at = now(),
       status = 'dead_lettered',
       finished_at = COALESCE(platform.jobs.finished_at, EXCLUDED.finished_at)
     RETURNING id`,
    [
      input.jobKey,
      PLATFORM_MEDIA_CLEANUP_QUEUE,
      input.mutation.jobType,
      input.context.now.toISOString(),
      tenantScope(input.candidate),
      scopeOrganizationId(input.candidate),
      scopePropertyId(input.candidate),
      cleanupTargetResourceType(input.candidate),
      input.resourceId,
      input.context.correlationId,
      input.keyHash,
      JSON.stringify({
        action: input.mutation.action,
        resourceId: input.resourceId,
      }),
      JSON.stringify({
        workerId: input.context.workerId,
        errorType: input.errorInfo.type,
        errorMessage: input.errorInfo.message,
      }),
    ],
  );
  return result.rows[0]!.id;
}

async function insertCleanupJobAttempt(
  client: pg.PoolClient,
  jobId: string,
  status: "succeeded" | "failed",
  context: PlatformMediaCleanupContext,
  errorInfo?: { type: string; message: string },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.job_attempts
       (
         job_id,
         attempt_number,
         status,
         worker_id,
         started_at,
         finished_at,
         duration_ms,
         error_type,
         error_message,
         error_metadata
       )
     VALUES (
       $1::uuid,
       1,
       $2,
       $3,
       $4::timestamptz,
       $4::timestamptz,
       0,
       $5,
       $6,
       $7::jsonb
     )
     ON CONFLICT (job_id, attempt_number)
     DO UPDATE SET
       status = EXCLUDED.status,
       finished_at = COALESCE(platform.job_attempts.finished_at, EXCLUDED.finished_at),
       error_type = COALESCE(platform.job_attempts.error_type, EXCLUDED.error_type),
       error_message = COALESCE(platform.job_attempts.error_message, EXCLUDED.error_message)
     RETURNING id`,
    [
      jobId,
      status,
      context.workerId,
      context.now.toISOString(),
      errorInfo?.type ?? null,
      errorInfo?.message ?? null,
      JSON.stringify(errorInfo ? { source: "apps/api-platform-media-cleanup" } : {}),
    ],
  );
  return result.rows[0]!.id;
}

async function insertCleanupAudit(
  client: pg.PoolClient,
  input: {
    candidate: PlatformMediaCleanupCandidate;
    mutation: PlatformMediaCleanupMutation;
    cleanupKey: string;
    payload: Record<string, unknown>;
    idempotencyKeyId: string;
    domainEventId: string;
    jobId: string;
    context: PlatformMediaCleanupContext;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (
         audit_key,
         product,
         action,
         occurred_at,
         tenant_scope,
         organization_id,
         property_id,
         actor_type,
         target_resource_product,
         target_resource_type,
         target_resource_id,
         domain_event_id,
         job_id,
         idempotency_key_id,
         correlation_id,
         causation_id,
         redacted_payload,
         private_payload,
         audit_metadata,
         retention_class,
         privacy_scope
       )
     VALUES (
       $1,
       'platform',
       $2,
       $3::timestamptz,
       $4,
       $5::uuid,
       $6::uuid,
       'system',
       'platform',
       $7,
       $8::uuid,
       $9::uuid,
       $10::uuid,
       $11,
       $12,
       $13,
       $14::jsonb,
       '{}'::jsonb,
       $15::jsonb,
       'standard',
       'internal'
     )
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      input.cleanupKey,
      input.mutation.auditAction,
      input.context.now.toISOString(),
      tenantScope(input.candidate),
      scopeOrganizationId(input.candidate),
      scopePropertyId(input.candidate),
      cleanupTargetResourceType(input.candidate),
      cleanupResourceId(input.candidate),
      input.domainEventId,
      input.jobId,
      input.idempotencyKeyId,
      input.context.correlationId,
      input.mutation.jobType,
      JSON.stringify(input.payload),
      JSON.stringify({
        source: "apps/api-platform-media-cleanup",
        workerId: input.context.workerId,
      }),
    ],
  );
}

function candidateFromRow(row: CandidateRow): PlatformMediaCleanupCandidate {
  return {
    mediaObjectId: row.mediaObjectId ?? undefined,
    uploadSessionId: row.uploadSessionId ?? undefined,
    ownerOrganizationId: row.ownerOrganizationId ?? undefined,
    propertyId: row.propertyId ?? undefined,
    resourceProduct: row.resourceProduct,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    purpose: row.purpose ?? undefined,
    visibility: row.visibility ?? undefined,
    lifecycleStatus: row.lifecycleStatus,
    bucket: row.bucket ?? undefined,
    storageKey: row.storageKey ?? undefined,
    stagingPrefix: row.stagingPrefix ?? undefined,
    retainedUntil: dateValue(row.retainedUntil),
    deletionRequestedAt: dateValue(row.deletionRequestedAt),
    expiresAt: dateValue(row.expiresAt),
    rollbackWindowEndsAt: dateValue(row.rollbackWindowEndsAt),
    rollbackBucket: row.rollbackBucket ?? undefined,
    rollbackStorageKey: row.rollbackStorageKey ?? undefined,
    replacedByMediaObjectId: row.replacedByMediaObjectId ?? undefined,
  };
}

function deadlineOrWindowForCandidate(
  candidate: PlatformMediaCleanupCandidate,
  runName: PlatformMediaCleanupRunName,
  now: Date,
): string {
  switch (runName) {
    case "abandonedStagingUploads":
      return candidate.expiresAt ?? `expired-before-${now.toISOString()}`;
    case "replacedPublicImages":
      return candidate.deletionRequestedAt ?? `delete-requested-before-${now.toISOString()}`;
    case "privateAttachmentRetention":
      return candidate.retainedUntil ?? `retained-until-${now.toISOString()}`;
    case "rollbackWindowCleanup":
      return candidate.rollbackWindowEndsAt ?? `rollback-ended-before-${now.toISOString()}`;
  }
}

function auditSafeCleanupPayload(
  candidate: PlatformMediaCleanupCandidate,
  mutation: PlatformMediaCleanupMutation,
  applied: boolean,
): Record<string, unknown> {
  return {
    action: mutation.action,
    runName: mutation.runName,
    mediaObjectId: candidate.mediaObjectId ?? null,
    uploadSessionId: candidate.uploadSessionId ?? null,
    resourceProduct: candidate.resourceProduct,
    resourceType: candidate.resourceType,
    resourceId: candidate.resourceId,
    purpose: candidate.purpose ?? null,
    visibility: candidate.visibility ?? null,
    lifecycleStatus: candidate.lifecycleStatus,
    applied,
    deadlineOrWindow: mutation.deadlineOrWindow,
    replacedByMediaObjectId: candidate.replacedByMediaObjectId ?? null,
  };
}

function cleanupResourceId(candidate: PlatformMediaCleanupCandidate): string {
  return candidate.mediaObjectId ?? candidate.uploadSessionId ?? candidate.resourceId;
}

function cleanupTargetResourceType(candidate: PlatformMediaCleanupCandidate): string {
  return candidate.uploadSessionId ? "media_upload_session" : "media_object";
}

function requiredCandidateId(candidate: PlatformMediaCleanupCandidate): string {
  const id = candidate.mediaObjectId ?? candidate.uploadSessionId;
  if (!id) {
    throw new Error(
      `Platform media cleanup candidate lacks durable id for ${candidate.resourceId}`,
    );
  }
  return id;
}

function requiredBucket(
  bucket: string | null | undefined,
  candidate: PlatformMediaCleanupCandidate,
): string {
  if (!bucket) {
    throw new Error(
      `Platform media cleanup candidate lacks bucket for ${cleanupResourceId(candidate)}`,
    );
  }
  return bucket;
}

async function deleteStorageObjectForCandidate(
  objectDeleter: PlatformMediaObjectDeleter,
  candidate: PlatformMediaCleanupCandidate,
  bucket: string,
  storageKey: string,
): Promise<void> {
  try {
    await objectDeleter.deleteObject({ bucket, storageKey });
  } catch (error) {
    throw new PlatformMediaStorageDeleteError(cleanupResourceId(candidate), error);
  }
}

async function deleteStoragePrefixForCandidate(
  objectDeleter: PlatformMediaObjectDeleter,
  candidate: PlatformMediaCleanupCandidate,
  prefix: string,
): Promise<void> {
  try {
    await objectDeleter.deletePrefix({ bucket: candidate.bucket, prefix });
  } catch (error) {
    throw new PlatformMediaStorageDeleteError(cleanupResourceId(candidate), error);
  }
}

function tenantScope(
  candidate: PlatformMediaCleanupCandidate,
): "platform" | "organization" | "property" {
  if (candidate.propertyId) return "property";
  if (candidate.ownerOrganizationId) return "organization";
  return "platform";
}

function scopeOrganizationId(candidate: PlatformMediaCleanupCandidate): string | null {
  return tenantScope(candidate) === "organization" ? (candidate.ownerOrganizationId ?? null) : null;
}

function scopePropertyId(candidate: PlatformMediaCleanupCandidate): string | null {
  return tenantScope(candidate) === "property" ? (candidate.propertyId ?? null) : null;
}

function errorDetails(error: unknown): { type: string; message: string } {
  if (error instanceof PlatformMediaStorageDeleteError) {
    return { type: error.name, message: error.message };
  }
  if (error instanceof Error) {
    return { type: error.name, message: error.message };
  }
  return { type: "UnknownError", message: String(error) };
}

function failureReasonCode(
  error: unknown,
): "media_storage_delete_failed" | "media_cleanup_apply_failed" {
  return error instanceof PlatformMediaStorageDeleteError
    ? "media_storage_delete_failed"
    : "media_cleanup_apply_failed";
}

function dateValue(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function sha256Key(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}

function sumBy<T extends Record<K, number>, K extends keyof T>(items: T[], key: K): number {
  return items.reduce((total, item) => total + item[key], 0);
}

class PlatformMediaStorageDeleteError extends Error {
  constructor(resourceId: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to delete media storage for ${resourceId}: ${message}`);
    this.name = "PlatformMediaStorageDeleteError";
  }
}
