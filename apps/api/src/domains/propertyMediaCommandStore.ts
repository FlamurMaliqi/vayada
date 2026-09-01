import {
  PROPERTY_MEDIA_PUBLIC_VARIANTS,
  PROPERTY_MEDIA_UPLOAD_PURPOSES,
  type PropertyMediaAssignment,
  type PropertyMediaCommandError,
} from "@vayada/domain-hotels";
import type { QueryResult, QueryResultRow } from "pg";

import type { PlatformMediaServingConfig } from "../platform/mediaServing.js";
import {
  ACTIVE_PROPERTY_MEDIA_PUBLICATION_PREDICATE,
  PROPERTY_MEDIA_PUBLICATION_JOB_TYPE as PUBLICATION_JOB_TYPE,
  PROPERTY_MEDIA_PUBLICATION_QUEUE as PUBLICATION_QUEUE,
} from "../platform/propertyMediaPublicationJob.js";
import { assertCanonicalPrivatePropertyVariants } from "../platform/propertyMediaVariantContract.js";
import { advancePublicProfileRevision } from "../platform/sharedHotelSetupStatusReadModel.js";
import {
  MEDIA_TYPE_BY_ROLE,
  OPERATIONS,
  PUBLICATION_JOB_LEASE_MS,
  PUBLICATION_JOB_MAX_ATTEMPTS,
  PUBLICATION_TERMINAL_RECONCILIATION_MS,
  PUBLICATION_TERMINAL_RECONCILIATION_PASSES,
  ROLE_BY_MEDIA_TYPE,
  commandAssignmentResponse,
  canonicalJson,
  isRecord,
  isUuid,
  mediaFailure,
  parsePublicationCleanupKeys,
  parsePublicationJobPayload,
  parseStoredResult,
  positiveInteger,
  preparePublicationMedia,
  propertyMediaCommandResultStatus,
  publicationCleanupKeys,
  publicationJobRowMatchesPayload,
  publicationRecoveryRowMatchesPayload,
  publicationRetryDelayMs,
  safeFailureMessage,
  sha256,
  type AssignmentRow,
  type IdempotencyRow,
  type InternalCommand,
  type InvalidPublicationJob,
  type InvalidPublicationRecoveryRow,
  type MediaRow,
  type PublicationClaim,
  type PublicationCommand,
  type PublicationJobPayload,
  type PublicationJobRow,
  type PlatformAdminPropertyRow,
  type PropertyMediaCommandResult,
  type PropertyRow,
  type ReadyMedia,
  type VariantRow,
} from "./propertyMediaCommandEnvelope.js";

export type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

export type CommandPoolClient = Queryable & { release(): void };
export type CommandPool = { connect(): Promise<CommandPoolClient>; end(): Promise<void> };
export type PropertyMediaReadModelSync = (
  client: Queryable,
  input: { propertyId: string },
) => Promise<void>;

export type PlatformAdminPropertyHeroRead = {
  propertyId: string;
  profileRevision: number;
  hero: { mediaObjectId: string; url: string } | null;
};
type CanonicalPrivatePropertyVariant = Parameters<
  typeof assertCanonicalPrivatePropertyVariants
>[0]["variants"][number];

export async function findActivePublication(
  client: Queryable,
  propertyId: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT job.id::text AS id
     FROM platform.jobs job
     WHERE ${ACTIVE_PROPERTY_MEDIA_PUBLICATION_PREDICATE}
     ORDER BY job.created_at, job.id
     LIMIT 1
     FOR UPDATE`,
    [propertyId],
  );
  return result.rows[0]?.id ?? null;
}

export async function enqueuePublicationJob(
  client: Queryable,
  payload: PublicationJobPayload,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.jobs (
       job_key, queue_name, job_type, status, max_attempts,
       tenant_scope, property_id, resource_product, resource_type, resource_id,
       correlation_id, idempotency_key_hash, payload, job_metadata
     ) VALUES (
       $1, $2, $3, 'pending', $4,
       'property', $5::uuid, 'hotel_catalog', 'property_media_assignment', $5::uuid::text,
       $6, $7, $8::jsonb, jsonb_build_object(
         'publicationVersion', 2,
         'cleanupRequired', false,
         'cleanupKeys', $9::jsonb
       )
     )
     ON CONFLICT (queue_name, job_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      `${payload.command.propertyId}:${OPERATIONS[payload.command.operation]}:${payload.keyHash}`,
      PUBLICATION_QUEUE,
      PUBLICATION_JOB_TYPE,
      PUBLICATION_JOB_MAX_ATTEMPTS,
      payload.command.propertyId,
      payload.command.audit.correlationId ?? payload.command.audit.requestId,
      payload.keyHash,
      JSON.stringify(payload),
      JSON.stringify(publicationCleanupKeys(payload.media)),
    ],
  );
  const jobId = result.rows[0]?.id;
  if (!jobId) throw new Error("Property media publication job was not reserved");
  return jobId;
}

export async function markIdempotencyPending(
  client: Queryable,
  input: {
    idempotencyId: string;
    publicationJobId: string;
    acceptedProfileRevision: number;
    occurredAt: Date;
  },
): Promise<void> {
  const updated = await client.query(
    `UPDATE platform.idempotency_keys
     SET last_seen_at = $4::timestamptz,
         locked_until = $4::timestamptz + make_interval(secs => $5::double precision),
         idempotency_metadata = jsonb_build_object(
           'publication', jsonb_build_object(
             'jobId', $2::text,
             'acceptedProfileRevision', $3::integer,
             'status', 'pending'
           )
         )
     WHERE id = $1::uuid
       AND status = 'in_progress'`,
    [
      input.idempotencyId,
      input.publicationJobId,
      input.acceptedProfileRevision,
      input.occurredAt.toISOString(),
      PUBLICATION_JOB_LEASE_MS / 1_000,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new Error("Property media idempotency state lost its publication fence");
  }
}

export async function claimPublicationJob(
  pool: CommandPool,
  input: { jobId?: string; force: boolean; workerId: string; now: Date },
): Promise<
  { publicationClaim: PublicationClaim } | { invalidPublication: InvalidPublicationJob } | null
> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const leaseCutoff = new Date(input.now.getTime() - PUBLICATION_JOB_LEASE_MS);
    const result = await client.query<PublicationJobRow>(
      `SELECT
         job.id::text AS id,
         job.job_key AS "jobKey",
         job.status,
         job.attempts_count AS "attemptsCount",
         job.max_attempts AS "maxAttempts",
         job.locked_at AS "lockedAt",
         job.locked_by AS "lockedBy",
         job.property_id::text AS "propertyId",
         job.idempotency_key_hash AS "keyHash",
         job.tenant_scope AS "tenantScope",
         job.resource_product AS "resourceProduct",
         job.resource_type AS "resourceType",
         job.resource_id AS "resourceId",
         job.job_metadata @> '{"cleanupRequired": true}'::jsonb AS "cleanupRequired",
         job.job_metadata -> 'cleanupKeys' AS "cleanupKeys",
         job.payload
       FROM platform.jobs job
       WHERE job.queue_name = $1
         AND job.job_type = $2
         AND ($3::uuid IS NULL OR job.id = $3::uuid)
         AND (
           (
             job.status = 'pending'
             AND ($4::boolean OR job.run_after <= $5::timestamptz)
           )
           OR (
             job.status = 'running'
             AND job.locked_at <= $6::timestamptz
           )
         )
       ORDER BY job.priority DESC, job.run_after, job.created_at, job.id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [
        PUBLICATION_QUEUE,
        PUBLICATION_JOB_TYPE,
        input.jobId ?? null,
        input.force,
        input.now.toISOString(),
        leaseCutoff.toISOString(),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    const payload = parsePublicationJobPayload(row.payload);
    const cleanupKeys = parsePublicationCleanupKeys(row.cleanupKeys) ?? [];
    if (!payload || !publicationJobRowMatchesPayload(row, payload)) {
      if (row.status === "running" && row.attemptsCount > 0) {
        await timeoutReclaimedPublicationAttempt(client, row, input.now);
      }
      await lockInvalidPublicationCleanup(client, row.id, input.workerId, input.now);
      await client.query("COMMIT");
      return {
        invalidPublication: {
          jobId: row.id,
          workerId: input.workerId,
          force: input.force,
          reason: "invalid_envelope",
          cleanupKeys,
        },
      };
    }
    const idempotencyFence = await client.query(
      `SELECT idempotency.id
       FROM platform.idempotency_keys idempotency
       WHERE idempotency.id = $1::uuid
         AND idempotency.operation_scope = 'hotel_catalog'
         AND idempotency.operation = $2
         AND idempotency.tenant_scope = 'property'
         AND idempotency.property_id = $3::uuid
         AND idempotency.status = 'in_progress'
         AND idempotency.request_fingerprint_hash = $4
         AND idempotency.key_hash = $5
         AND idempotency.idempotency_metadata #>> '{publication,jobId}' = $6
       FOR UPDATE`,
      [
        payload.idempotencyId,
        OPERATIONS[payload.command.operation],
        payload.command.propertyId,
        payload.requestFingerprintHash,
        payload.keyHash,
        row.id,
      ],
    );
    if (idempotencyFence.rowCount !== 1) {
      if (row.status === "running" && row.attemptsCount > 0) {
        await timeoutReclaimedPublicationAttempt(client, row, input.now);
      }
      await lockInvalidPublicationCleanup(client, row.id, input.workerId, input.now);
      await client.query("COMMIT");
      return {
        invalidPublication: {
          jobId: row.id,
          workerId: input.workerId,
          force: input.force,
          reason: "missing_idempotency_fence",
          cleanupKeys,
        },
      };
    }
    const reclaimedRunningJob = row.status === "running";
    if (reclaimedRunningJob && row.attemptsCount > 0) {
      await timeoutReclaimedPublicationAttempt(client, row, input.now);
    }
    const exhaustedBeforeClaim = row.attemptsCount >= row.maxAttempts;
    const cleanupRequired = row.cleanupRequired || reclaimedRunningJob;
    const startsAttempt = !cleanupRequired && !exhaustedBeforeClaim;
    const attemptsCount = startsAttempt ? row.attemptsCount + 1 : row.attemptsCount;
    const claimed = await client.query(
      `UPDATE platform.jobs
       SET status = 'running', attempts_count = $3,
           locked_at = $4::timestamptz, locked_by = $2,
           finished_at = NULL, updated_at = $4::timestamptz
       WHERE id = $1::uuid`,
      [row.id, input.workerId, attemptsCount, input.now.toISOString()],
    );
    if (claimed.rowCount !== 1) throw new Error("Property media publication claim was lost");
    if (startsAttempt) {
      await startPublicationAttempt(client, {
        jobId: row.id,
        attemptNumber: attemptsCount,
        workerId: input.workerId,
        startedAt: input.now,
      });
    }
    const idempotency = await client.query(
      `UPDATE platform.idempotency_keys
       SET locked_until = $2::timestamptz + make_interval(secs => $3::double precision),
           last_seen_at = $2::timestamptz,
           idempotency_metadata = jsonb_set(
             idempotency_metadata,
             '{publication,status}',
             '"running"'::jsonb,
             true
           )
       WHERE id = $1::uuid
         AND operation_scope = 'hotel_catalog'
         AND operation = $4
         AND tenant_scope = 'property'
         AND property_id = $5::uuid
         AND status = 'in_progress'
         AND request_fingerprint_hash = $6
         AND key_hash = $7
         AND idempotency_metadata #>> '{publication,jobId}' = $8`,
      [
        payload.idempotencyId,
        input.now.toISOString(),
        PUBLICATION_JOB_LEASE_MS / 1_000,
        OPERATIONS[payload.command.operation],
        payload.command.propertyId,
        payload.requestFingerprintHash,
        payload.keyHash,
        row.id,
      ],
    );
    if (idempotency.rowCount !== 1) {
      throw new Error("Property media publication idempotency fence changed during claim");
    }
    await client.query("COMMIT");
    return {
      publicationClaim: {
        jobId: row.id,
        workerId: input.workerId,
        attemptsCount,
        maxAttempts: row.maxAttempts,
        exhaustedBeforeClaim,
        cleanupRequired,
        payload,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockInvalidPublicationCleanup(
  client: Queryable,
  jobId: string,
  workerId: string,
  lockedAt: Date,
): Promise<void> {
  const locked = await client.query(
    `UPDATE platform.jobs
     SET status = 'running',
         locked_at = $3::timestamptz,
         locked_by = $2,
         finished_at = NULL,
         updated_at = $3::timestamptz,
         job_metadata = job_metadata || jsonb_build_object('cleanupRequired', true)
     WHERE id = $1::uuid
       AND status IN ('pending', 'running')`,
    [jobId, workerId, lockedAt.toISOString()],
  );
  if (locked.rowCount !== 1) {
    throw new Error("Invalid property media publication cleanup lease was lost");
  }
}

export async function timeoutReclaimedPublicationAttempt(
  client: Queryable,
  job: PublicationJobRow,
  timedOutAt: Date,
): Promise<void> {
  await client.query(
    `UPDATE platform.job_attempts
     SET status = 'timed_out',
         finished_at = $3::timestamptz,
         error_type = 'property_media_publication_lease_expired',
         error_message = 'Property media publication worker lease expired',
         error_metadata = error_metadata || jsonb_build_object('retryable', true)
     WHERE job_id = $1::uuid
       AND attempt_number = $2
       AND status = 'running'`,
    [job.id, job.attemptsCount, timedOutAt.toISOString()],
  );
}

export async function startPublicationAttempt(
  client: Queryable,
  input: { jobId: string; attemptNumber: number; workerId: string; startedAt: Date },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.job_attempts (
       job_id, attempt_number, status, worker_id, started_at, error_metadata
     ) VALUES (
       $1::uuid, $2, 'running', $3, $4::timestamptz,
       jsonb_build_object('source', 'apps/api-property-media-publication')
     )
     ON CONFLICT (job_id, attempt_number) DO UPDATE SET
       status = 'running', worker_id = EXCLUDED.worker_id,
       started_at = EXCLUDED.started_at, finished_at = NULL, duration_ms = NULL,
       error_type = NULL, error_message = NULL, retry_after = NULL,
       error_metadata = EXCLUDED.error_metadata`,
    [input.jobId, input.attemptNumber, input.workerId, input.startedAt.toISOString()],
  );
}

export async function finishPublicationAttempt(
  client: Queryable,
  claim: PublicationClaim,
  input:
    | { status: "succeeded"; finishedAt: Date }
    | {
        status: "failed";
        finishedAt: Date;
        errorType: string;
        message: string;
        retryAt?: Date;
      },
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `UPDATE platform.job_attempts
     SET status = $4,
         finished_at = $5::timestamptz,
         error_type = $6,
         error_message = $7,
         retry_after = $8::timestamptz,
         error_metadata = error_metadata || $9::jsonb
     WHERE job_id = $1::uuid
       AND attempt_number = $2
       AND worker_id = $3
       AND status = 'running'
     RETURNING id::text AS id`,
    [
      claim.jobId,
      claim.attemptsCount,
      claim.workerId,
      input.status,
      input.finishedAt.toISOString(),
      input.status === "failed" ? input.errorType : null,
      input.status === "failed" ? safeFailureMessage(input.message) : null,
      input.status === "failed" ? (input.retryAt?.toISOString() ?? null) : null,
      JSON.stringify({ retryable: input.status === "failed" && Boolean(input.retryAt) }),
    ],
  );
  const attemptId = result.rows[0]?.id;
  if (!attemptId) throw new Error("Property media publication attempt fence was lost");
  return attemptId;
}

export async function loadFinishedPublicationAttemptId(
  client: Queryable,
  claim: PublicationClaim,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT attempt.id::text AS id
     FROM platform.job_attempts attempt
     WHERE attempt.job_id = $1::uuid
       AND attempt.attempt_number = $2
       AND attempt.status IN ('failed', 'timed_out')
     FOR UPDATE`,
    [claim.jobId, claim.attemptsCount],
  );
  const attemptId = result.rows[0]?.id;
  if (!attemptId) throw new Error("Property media publication has no finished terminal attempt");
  return attemptId;
}

export async function insertPublicationDeadLetter(
  client: Queryable,
  input: {
    jobId: string;
    attemptId: string;
    propertyId: string;
    correlationId: string | null;
    keyHash: string | null;
    message: string;
    reasonCode: "max_attempts_exhausted" | "non_retryable_error";
    attemptCount: number;
    replayEligible: boolean;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.dead_letter_events (
       source_kind, job_id, job_attempt_id, tenant_scope, property_id,
       resource_product, resource_type, resource_id, correlation_id,
       idempotency_key_hash, reason_code, failure_summary, failure_payload
     )
     SELECT
       'job', $1::uuid, $2::uuid, 'property', $3::uuid,
       'hotel_catalog', 'property_media_assignment', $3, $4,
       $5, $6, $7, $8::jsonb
     WHERE NOT EXISTS (
       SELECT 1
       FROM platform.dead_letter_events dead_letter
       WHERE dead_letter.source_kind = 'job'
         AND dead_letter.job_id = $1::uuid
         AND dead_letter.recovery_status = 'open'
     )`,
    [
      input.jobId,
      input.attemptId,
      input.propertyId,
      input.correlationId,
      input.keyHash,
      input.reasonCode,
      safeFailureMessage(input.message),
      JSON.stringify({
        ownerPackage: "domain-hotels",
        attemptCount: input.attemptCount,
        replayEligible: input.replayEligible,
      }),
    ],
  );
}

export async function finalizeInvalidPublicationJob(
  pool: CommandPool,
  invalid: InvalidPublicationJob,
  occurredAt: Date,
  syncReadModels: PropertyMediaReadModelSync,
  cleanupFailures: number,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const scope = await client.query<{ propertyId: string }>(
      `SELECT job.property_id::text AS "propertyId"
       FROM platform.jobs job
       WHERE job.id = $1::uuid
         AND job.queue_name = $2
         AND job.job_type = $3
         AND job.property_id IS NOT NULL`,
      [invalid.jobId, PUBLICATION_QUEUE, PUBLICATION_JOB_TYPE],
    );
    const propertyId = scope.rows[0]?.propertyId;
    if (!propertyId) {
      await client.query("ROLLBACK");
      return false;
    }
    const property = await client.query(
      `SELECT property.id
       FROM hotel_catalog.properties property
       WHERE property.id = $1::uuid
       FOR UPDATE`,
      [propertyId],
    );
    if (property.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    const leaseCutoff = new Date(occurredAt.getTime() - PUBLICATION_JOB_LEASE_MS);
    const jobResult = await client.query<InvalidPublicationRecoveryRow>(
      `SELECT
         job.property_id::text AS "propertyId",
         job.idempotency_key_hash AS "keyHash",
         job.correlation_id AS "correlationId",
         job.job_key AS "jobKey",
         job.status,
         job.attempts_count AS "attemptsCount",
         job.max_attempts AS "maxAttempts",
         job.tenant_scope AS "tenantScope",
         job.resource_product AS "resourceProduct",
         job.resource_type AS "resourceType",
         job.resource_id AS "resourceId",
         job.job_metadata -> 'cleanupKeys' AS "cleanupKeys",
         job.payload
       FROM platform.jobs job
       WHERE job.id = $1::uuid
         AND job.queue_name = $2
         AND job.job_type = $3
         AND job.property_id = $4::uuid
         AND (
           (job.status = 'pending' AND ($6::boolean OR job.run_after <= $5::timestamptz))
           OR (
             job.status = 'running'
             AND (job.locked_by = $8 OR job.locked_at <= $7::timestamptz)
           )
         )
       FOR UPDATE OF job`,
      [
        invalid.jobId,
        PUBLICATION_QUEUE,
        PUBLICATION_JOB_TYPE,
        propertyId,
        occurredAt.toISOString(),
        invalid.force,
        leaseCutoff.toISOString(),
        invalid.workerId,
      ],
    );
    const job = jobResult.rows[0];
    const parsedPayload = job ? parsePublicationJobPayload(job.payload) : null;
    if (
      !job ||
      (invalid.reason === "invalid_envelope" &&
        parsedPayload &&
        publicationRecoveryRowMatchesPayload(job, parsedPayload))
    ) {
      await client.query("ROLLBACK");
      return false;
    }
    const idempotency = job.keyHash
      ? await client.query<{ id: string }>(
          `SELECT idempotency.id::text AS id
           FROM platform.idempotency_keys idempotency
           WHERE idempotency.operation_scope = 'hotel_catalog'
             AND idempotency.operation = ANY($3::text[])
             AND idempotency.tenant_scope = 'property'
             AND idempotency.property_id = $1::uuid
             AND idempotency.key_hash = $2
             AND idempotency.status = 'in_progress'
             AND (
               idempotency.idempotency_metadata #>> '{publication,jobId}' = $4
               OR $5 = $1::uuid::text || ':' || idempotency.operation || ':' || idempotency.key_hash
             )
           FOR UPDATE`,
          [propertyId, job.keyHash, Object.values(OPERATIONS), invalid.jobId, job.jobKey],
        )
      : { rows: [], rowCount: 0 };
    const idempotencyId = idempotency.rows[0]?.id ?? null;
    const result: PropertyMediaCommandResult = {
      ok: false,
      error: { code: "media_publication_failed" },
    };
    const failureType =
      invalid.reason === "missing_idempotency_fence"
        ? "missing_publication_idempotency_fence"
        : "invalid_publication_envelope";
    const failureMessage =
      invalid.reason === "missing_idempotency_fence"
        ? "Property media publication lost its idempotency fence"
        : "Invalid property media publication envelope";
    if (idempotencyId) {
      await completeIdempotency(client, idempotencyId, result, occurredAt);
    }
    const removedPending = await removePendingAssignments(client, propertyId, invalid.jobId);
    if (removedPending > 0) {
      await advancePublicProfileRevision(client, propertyId);
      await syncReadModels(client, { propertyId });
    }
    const abandoned =
      job.status === "running"
        ? await client.query<{ id: string; attemptNumber: number }>(
            `UPDATE platform.job_attempts
             SET status = 'timed_out',
                 finished_at = $2::timestamptz,
                 error_type = 'property_media_publication_lease_expired',
                 error_message = 'Property media publication worker lease expired',
                 error_metadata = error_metadata || jsonb_build_object('retryable', false)
             WHERE job_id = $1::uuid
               AND status = 'running'
             RETURNING id::text AS id, attempt_number AS "attemptNumber"`,
            [invalid.jobId, occurredAt.toISOString()],
          )
        : { rows: [] };
    const abandonedAttempt = abandoned.rows.at(-1);
    const exhaustedAttempt =
      !abandonedAttempt && job.attemptsCount >= job.maxAttempts
        ? (
            await client.query<{ id: string; attemptNumber: number }>(
              `SELECT attempt.id::text AS id,
                      attempt.attempt_number AS "attemptNumber"
               FROM platform.job_attempts attempt
               WHERE attempt.job_id = $1::uuid
                 AND attempt.attempt_number = $2
                 AND attempt.status IN ('failed', 'timed_out', 'canceled')
               FOR UPDATE`,
              [invalid.jobId, job.maxAttempts],
            )
          ).rows[0]
        : undefined;
    const attemptNumber =
      abandonedAttempt?.attemptNumber ??
      exhaustedAttempt?.attemptNumber ??
      Math.min(job.attemptsCount + 1, job.maxAttempts);
    const attemptId =
      abandonedAttempt?.id ??
      exhaustedAttempt?.id ??
      (
        await client.query<{ id: string }>(
          `INSERT INTO platform.job_attempts (
             job_id, attempt_number, status, worker_id, started_at, finished_at,
             error_type, error_message, error_metadata
           ) VALUES (
             $1::uuid, $2, 'failed', 'property-media:invalid-payload',
             $3::timestamptz, $3::timestamptz,
             $4, $5,
             jsonb_build_object('retryable', false, 'source', 'apps/api-property-media-publication')
           )
           ON CONFLICT (job_id, attempt_number) DO UPDATE SET
             status = 'failed', worker_id = EXCLUDED.worker_id,
             finished_at = EXCLUDED.finished_at,
             error_type = EXCLUDED.error_type,
             error_message = EXCLUDED.error_message,
             error_metadata = EXCLUDED.error_metadata
           RETURNING id::text AS id`,
          [invalid.jobId, attemptNumber, occurredAt.toISOString(), failureType, failureMessage],
        )
      ).rows[0]?.id;
    if (!attemptId) throw new Error("Invalid property media attempt was not recorded");
    await client.query(
      `INSERT INTO platform.product_audit_events (
         audit_key, product, action, occurred_at, tenant_scope, property_id,
         actor_type, target_resource_product, target_resource_type, target_resource_id,
         job_id, idempotency_key_id, correlation_id, redacted_payload, audit_metadata
       ) VALUES (
         $1, 'hotel_catalog', 'property.media.command.rejected', $2::timestamptz,
         'property', $3::uuid, 'system', 'hotel_catalog', 'property', $3,
         $4::uuid, $5::uuid, $6, $7::jsonb, $8::jsonb
       )
       ON CONFLICT (product, audit_key) DO NOTHING`,
      [
        `property_media.${propertyId}.job.${invalid.jobId}.${failureType}.v1`,
        occurredAt.toISOString(),
        propertyId,
        invalid.jobId,
        idempotencyId,
        job.correlationId,
        JSON.stringify({ result: result.error }),
        JSON.stringify({
          publicationStatus: "dead_lettered",
          reason: failureType,
        }),
      ],
    );
    const failed = await client.query(
      `UPDATE platform.jobs
       SET status = 'dead_lettered', attempts_count = $3,
           finished_at = $2::timestamptz,
           locked_at = NULL, locked_by = NULL, updated_at = $2::timestamptz,
           run_after = $5::timestamptz,
           job_metadata = job_metadata || jsonb_build_object(
             'lastError', $4::text,
             'cleanupRequired', true,
             'cleanupReconcileAfter', $5::text,
             'cleanupPassesRemaining', $7::integer,
             'cleanupLastError', CASE
               WHEN $6::integer > 0
                 THEN $6::text || ' public object cleanup operation(s) failed'
               ELSE NULL
             END
           )
       WHERE id = $1::uuid
         AND status IN ('pending', 'running')`,
      [
        invalid.jobId,
        occurredAt.toISOString(),
        attemptNumber,
        failureMessage,
        new Date(occurredAt.getTime() + PUBLICATION_TERMINAL_RECONCILIATION_MS).toISOString(),
        cleanupFailures,
        PUBLICATION_TERMINAL_RECONCILIATION_PASSES,
      ],
    );
    if (failed.rowCount !== 1) {
      throw new Error("Invalid property media publication changed before dead-lettering");
    }
    await insertPublicationDeadLetter(client, {
      jobId: invalid.jobId,
      attemptId,
      propertyId,
      correlationId: job.correlationId,
      keyHash: job.keyHash,
      message: failureMessage,
      reasonCode: "non_retryable_error",
      attemptCount: attemptNumber,
      replayEligible: false,
    });
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function validatePublicationForCopy(
  pool: CommandPool,
  claim: PublicationClaim,
  serving: PlatformMediaServingConfig,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockAndValidatePublication(client, claim, serving);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function publicationCompleted(
  pool: CommandPool,
  claim: PublicationClaim,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ jobStatus: string; idempotencyStatus: string }>(
      `SELECT job.status AS "jobStatus", idempotency.status AS "idempotencyStatus"
       FROM platform.jobs job
       JOIN platform.idempotency_keys idempotency
         ON idempotency.id = $2::uuid
        AND idempotency.operation_scope = 'hotel_catalog'
        AND idempotency.operation = $3
        AND idempotency.tenant_scope = 'property'
        AND idempotency.property_id = $4::uuid
        AND idempotency.request_fingerprint_hash = $5
        AND idempotency.key_hash = $6
       WHERE job.id = $1::uuid
         AND job.queue_name = $7
         AND job.job_type = $8`,
      [
        claim.jobId,
        claim.payload.idempotencyId,
        OPERATIONS[claim.payload.command.operation],
        claim.payload.command.propertyId,
        claim.payload.requestFingerprintHash,
        claim.payload.keyHash,
        PUBLICATION_QUEUE,
        PUBLICATION_JOB_TYPE,
      ],
    );
    const row = result.rows[0];
    return row?.jobStatus === "succeeded" && row.idempotencyStatus === "completed";
  } finally {
    client.release();
  }
}

export async function publicationFailedTerminally(
  pool: CommandPool,
  claim: PublicationClaim,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ jobStatus: string; idempotencyStatus: string }>(
      `SELECT job.status AS "jobStatus", idempotency.status AS "idempotencyStatus"
       FROM platform.jobs job
       JOIN platform.idempotency_keys idempotency
         ON idempotency.id = $2::uuid
        AND idempotency.operation_scope = 'hotel_catalog'
        AND idempotency.operation = $3
        AND idempotency.tenant_scope = 'property'
        AND idempotency.property_id = $4::uuid
        AND idempotency.request_fingerprint_hash = $5
        AND idempotency.key_hash = $6
       WHERE job.id = $1::uuid
         AND job.queue_name = $7
         AND job.job_type = $8`,
      [
        claim.jobId,
        claim.payload.idempotencyId,
        OPERATIONS[claim.payload.command.operation],
        claim.payload.command.propertyId,
        claim.payload.requestFingerprintHash,
        claim.payload.keyHash,
        PUBLICATION_QUEUE,
        PUBLICATION_JOB_TYPE,
      ],
    );
    const row = result.rows[0];
    return row?.jobStatus === "dead_lettered" && row.idempotencyStatus === "completed";
  } finally {
    client.release();
  }
}

export async function renewPublicationLease(
  pool: CommandPool,
  claim: PublicationClaim,
  renewedAt: Date,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await client.query(
      `UPDATE platform.jobs
       SET locked_at = $3::timestamptz, updated_at = $3::timestamptz
       WHERE id = $1::uuid
         AND status = 'running'
         AND locked_by = $2`,
      [claim.jobId, claim.workerId, renewedAt.toISOString()],
    );
    if (job.rowCount !== 1) {
      throw new Error("Property media publication lost its lease during copying");
    }
    const idempotency = await client.query(
      `UPDATE platform.idempotency_keys
       SET locked_until = $2::timestamptz + make_interval(secs => $3::double precision),
           last_seen_at = $2::timestamptz
       WHERE id = $1::uuid
         AND operation_scope = 'hotel_catalog'
         AND operation = $4
         AND tenant_scope = 'property'
         AND property_id = $5::uuid
         AND status = 'in_progress'
         AND request_fingerprint_hash = $6
         AND key_hash = $7
         AND idempotency_metadata #>> '{publication,jobId}' = $8`,
      [
        claim.payload.idempotencyId,
        renewedAt.toISOString(),
        PUBLICATION_JOB_LEASE_MS / 1_000,
        OPERATIONS[claim.payload.command.operation],
        claim.payload.command.propertyId,
        claim.payload.requestFingerprintHash,
        claim.payload.keyHash,
        claim.jobId,
      ],
    );
    if (idempotency.rowCount !== 1) {
      throw new Error("Property media publication lost its idempotency lease during copying");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizePublication(
  pool: CommandPool,
  claim: PublicationClaim,
  options: {
    serving: PlatformMediaServingConfig;
    now: Date;
    syncReadModels: PropertyMediaReadModelSync;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentRevision = await lockAndValidatePublication(client, claim, options.serving);
    await promoteRegistryRows(client, claim.payload.media);
    await replaceAssignments(client, claim.payload.command, claim.payload.media);
    await advancePublicProfileRevision(client, claim.payload.command.propertyId);
    const completedProfileRevision = await loadProfileRevision(
      client,
      claim.payload.command.propertyId,
    );
    if (completedProfileRevision !== currentRevision + 1) {
      throw new Error("Property media publication advanced an unexpected profile revision");
    }
    await options.syncReadModels(client, { propertyId: claim.payload.command.propertyId });
    const after = await loadAssignments(client, claim.payload.command.propertyId);
    const result: PropertyMediaCommandResult = {
      ok: true,
      response: commandAssignmentResponse(
        "updated",
        completedProfileRevision,
        after,
        claim.payload.command,
      ),
    };
    await recordFinalAudit(client, {
      command: claim.payload.command,
      idempotencyId: claim.payload.idempotencyId,
      keyHash: claim.payload.keyHash,
      before: claim.payload.before,
      result,
      occurredAt: options.now,
    });
    await finishPublicationAttempt(client, claim, {
      status: "succeeded",
      finishedAt: options.now,
    });
    await completeIdempotency(client, claim.payload.idempotencyId, result, options.now);
    const completed = await client.query(
      `UPDATE platform.jobs
       SET status = 'succeeded', finished_at = $3::timestamptz,
           locked_at = NULL, locked_by = NULL, updated_at = $3::timestamptz,
           job_metadata = job_metadata || jsonb_build_object(
             'completedProfileRevision', $4::integer
           )
       WHERE id = $1::uuid
         AND status = 'running'
         AND locked_by = $2`,
      [claim.jobId, claim.workerId, options.now.toISOString(), completedProfileRevision],
    );
    if (completed.rowCount !== 1) {
      throw new Error("Property media publication lease was lost before completion");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockAndValidatePublication(
  client: Queryable,
  claim: PublicationClaim,
  serving: PlatformMediaServingConfig,
): Promise<number> {
  const property = await lockProperty(client, claim.payload.command);
  if (!property) throw new Error("Property media publication authorization is no longer active");
  const persistedPayload = await lockClaimedPublication(client, claim);
  if (canonicalJson(persistedPayload) !== canonicalJson(claim.payload)) {
    throw new Error("Property media publication payload changed after claim");
  }
  const currentRevision = positiveInteger(property.profileRevision);
  if (currentRevision < claim.payload.acceptedProfileRevision) {
    throw new Error("Property media publication revision fence moved backwards");
  }
  const activePublication = await findActivePublication(client, claim.payload.command.propertyId);
  if (activePublication !== claim.jobId) {
    throw new Error("Property media publication lost its aggregate fence");
  }
  await assertPendingAssignments(client, claim);
  const resolution = await resolveMedia(client, claim.payload.command, serving);
  if (!resolution.ok) {
    throw new Error(`Property media publication is no longer ${resolution.error.code}`);
  }
  const expectedMedia = preparePublicationMedia(
    resolution.media,
    claim.payload.publicationToken,
    serving,
  );
  if (canonicalJson(expectedMedia) !== canonicalJson(claim.payload.media)) {
    throw new Error("Property media publication source or destination changed after acceptance");
  }
  return currentRevision;
}

export async function lockClaimedPublication(
  client: Queryable,
  claim: PublicationClaim,
): Promise<PublicationJobPayload> {
  const result = await client.query<{ payload: unknown }>(
    `SELECT job.payload
     FROM platform.jobs job
     JOIN platform.idempotency_keys idempotency
       ON idempotency.id = $5::uuid
      AND idempotency.operation_scope = 'hotel_catalog'
      AND idempotency.operation = $6
      AND idempotency.tenant_scope = 'property'
      AND idempotency.property_id = $7::uuid
      AND idempotency.status = 'in_progress'
      AND idempotency.request_fingerprint_hash = $8
      AND idempotency.key_hash = $9
      AND idempotency.idempotency_metadata #>> '{publication,jobId}' = job.id::text
     WHERE job.id = $1::uuid
       AND job.queue_name = $3
       AND job.job_type = $4
       AND job.status = 'running'
       AND job.locked_by = $2
     FOR UPDATE OF job, idempotency`,
    [
      claim.jobId,
      claim.workerId,
      PUBLICATION_QUEUE,
      PUBLICATION_JOB_TYPE,
      claim.payload.idempotencyId,
      OPERATIONS[claim.payload.command.operation],
      claim.payload.command.propertyId,
      claim.payload.requestFingerprintHash,
      claim.payload.keyHash,
    ],
  );
  const payload = parsePublicationJobPayload(result.rows[0]?.payload);
  if (!payload) throw new Error("Property media publication lease or payload was lost");
  return payload;
}

export async function deferPublicationJob(
  pool: CommandPool,
  claim: PublicationClaim,
  occurredAt: Date,
  message: string,
  options: { finishAttempt: boolean; cleanupRequired: boolean },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const retryAt = new Date(occurredAt.getTime() + publicationRetryDelayMs(claim));
    const deferred = await client.query(
      `UPDATE platform.jobs
       SET status = 'pending',
           run_after = $4::timestamptz,
           locked_at = NULL, locked_by = NULL, finished_at = NULL,
           updated_at = $3::timestamptz,
           job_metadata = job_metadata || jsonb_build_object(
             'lastError', $5::text,
             'cleanupRequired', $6::boolean
           )
       WHERE id = $1::uuid
         AND status = 'running'
         AND locked_by = $2`,
      [
        claim.jobId,
        claim.workerId,
        occurredAt.toISOString(),
        retryAt.toISOString(),
        safeFailureMessage(message),
        options.cleanupRequired,
      ],
    );
    if (deferred.rowCount !== 1) {
      throw new Error("Property media publication lease was lost before deferral");
    }
    if (options.finishAttempt) {
      await finishPublicationAttempt(client, claim, {
        status: "failed",
        finishedAt: occurredAt,
        errorType: "property_media_publication_retryable",
        message,
        retryAt,
      });
    }
    const idempotency = await client.query(
      `UPDATE platform.idempotency_keys
       SET locked_until = NULL,
           last_seen_at = $2::timestamptz,
           idempotency_metadata = jsonb_set(
             idempotency_metadata,
             '{publication,status}',
             '"pending"'::jsonb,
             true
           )
       WHERE id = $1::uuid
         AND status = 'in_progress'
         AND request_fingerprint_hash = $3
         AND key_hash = $4
         AND idempotency_metadata #>> '{publication,jobId}' = $5`,
      [
        claim.payload.idempotencyId,
        occurredAt.toISOString(),
        claim.payload.requestFingerprintHash,
        claim.payload.keyHash,
        claim.jobId,
      ],
    );
    if (idempotency.rowCount !== 1) {
      throw new Error("Property media publication lost its idempotency fence before deferral");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizePublicationFailure(
  pool: CommandPool,
  claim: PublicationClaim,
  occurredAt: Date,
  message: string,
  syncReadModels: PropertyMediaReadModelSync,
  options: { attemptAlreadyFinished?: boolean } = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT property.id
       FROM hotel_catalog.properties property
       WHERE property.id = $1::uuid
       FOR UPDATE`,
      [claim.payload.command.propertyId],
    );
    await lockClaimedPublication(client, claim);
    const removedPending = await removePendingAssignments(
      client,
      claim.payload.command.propertyId,
      claim.jobId,
    );
    if (removedPending > 0) {
      await advancePublicProfileRevision(client, claim.payload.command.propertyId);
      await syncReadModels(client, { propertyId: claim.payload.command.propertyId });
    }
    const attemptId = options.attemptAlreadyFinished
      ? await loadFinishedPublicationAttemptId(client, claim)
      : await finishPublicationAttempt(client, claim, {
          status: "failed",
          finishedAt: occurredAt,
          errorType: "property_media_publication_terminal",
          message,
        });
    const result: PropertyMediaCommandResult = {
      ok: false,
      error: { code: "media_publication_failed" },
    };
    await recordFinalAudit(client, {
      command: claim.payload.command,
      idempotencyId: claim.payload.idempotencyId,
      keyHash: claim.payload.keyHash,
      before: claim.payload.before,
      result,
      occurredAt,
    });
    await completeIdempotency(client, claim.payload.idempotencyId, result, occurredAt);
    const failed = await client.query(
      `UPDATE platform.jobs
       SET status = 'dead_lettered', finished_at = $3::timestamptz,
           locked_at = NULL, locked_by = NULL, updated_at = $3::timestamptz,
           run_after = $5::timestamptz,
           job_metadata = job_metadata || jsonb_build_object(
             'lastError', $4::text,
             'cleanupRequired', true,
             'cleanupReconcileAfter', $5::text,
             'cleanupPassesRemaining', $6::integer
           )
       WHERE id = $1::uuid
         AND status = 'running'
         AND locked_by = $2`,
      [
        claim.jobId,
        claim.workerId,
        occurredAt.toISOString(),
        safeFailureMessage(message),
        new Date(occurredAt.getTime() + PUBLICATION_TERMINAL_RECONCILIATION_MS).toISOString(),
        PUBLICATION_TERMINAL_RECONCILIATION_PASSES,
      ],
    );
    if (failed.rowCount !== 1) {
      throw new Error("Property media publication lease was lost before dead-lettering");
    }
    await insertPublicationDeadLetter(client, {
      jobId: claim.jobId,
      attemptId,
      propertyId: claim.payload.command.propertyId,
      correlationId:
        claim.payload.command.audit.correlationId ?? claim.payload.command.audit.requestId,
      keyHash: claim.payload.keyHash,
      message,
      reasonCode: "max_attempts_exhausted",
      attemptCount: claim.attemptsCount,
      replayEligible: true,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readCompletedResult(
  pool: CommandPool,
  command: InternalCommand,
  keyHash: string,
  fingerprint: string,
  idempotentReplay = false,
): Promise<PropertyMediaCommandResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await findIdempotency(client, command, keyHash);
    const replay = row ? replayIdempotency(row, fingerprint) : null;
    await client.query("ROLLBACK");
    if (!replay) return { ok: false, error: { code: "command_in_progress" } };
    return replay.ok && idempotentReplay
      ? { ok: true, response: { ...replay.response, outcome: "idempotent_replay" } }
      : replay;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function lockProperty(
  client: Queryable,
  command: Pick<InternalCommand, "organizationId" | "propertyId" | "platformAdminHero">,
): Promise<PropertyRow | null> {
  if (command.platformAdminHero) {
    return lockPlatformAdminProperty(client, command.propertyId, command.organizationId);
  }
  const result = await client.query<PropertyRow>(
    `SELECT property.profile_revision AS "profileRevision"
     FROM hotel_catalog.properties property
     JOIN identity.organizations organization
       ON organization.id = $1::uuid
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     JOIN identity.organization_resource_links link
       ON link.organization_id = organization.id
      AND link.product = 'hotel_catalog'
      AND link.resource_type = 'property'
      AND link.resource_id = property.id::text
      AND link.relationship IN ('owner', 'operator')
      AND link.status = 'active'
     WHERE property.id = $2::uuid
     FOR UPDATE OF property
     FOR SHARE OF organization, link`,
    [command.organizationId, command.propertyId],
  );
  return result.rows[0] ?? null;
}

export async function lockPlatformAdminProperty(
  client: Queryable,
  propertyId: string,
  expectedOwnerOrganizationId?: string,
): Promise<PlatformAdminPropertyRow | null> {
  const result = await client.query<PlatformAdminPropertyRow>(
    `SELECT property.profile_revision AS "profileRevision",
            owner.organization_id::text AS "ownerOrganizationId"
     FROM hotel_catalog.properties property
     JOIN identity.organization_resource_links owner
       ON owner.product = 'hotel_catalog'
      AND owner.resource_type = 'property'
      AND owner.resource_id = property.id::text
      AND owner.relationship = 'owner'
      AND owner.status = 'active'
     JOIN identity.organizations organization
       ON organization.id = owner.organization_id
      AND organization.kind = 'hotel_group'
      AND organization.status = 'active'
     WHERE property.id = $1::uuid
       AND property.lifecycle_status <> 'retired'
     ORDER BY owner.organization_id
     FOR UPDATE OF property
     FOR SHARE OF owner, organization`,
    [propertyId],
  );
  const property = result.rows.length === 1 ? result.rows[0] : undefined;
  return property &&
    (!expectedOwnerOrganizationId ||
      property.ownerOrganizationId === expectedOwnerOrganizationId.toLowerCase())
    ? property
    : null;
}

export async function readPlatformAdminPropertyHero(
  pool: CommandPool,
  propertyId: string,
): Promise<PlatformAdminPropertyHeroRead | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      propertyId: string;
      profileRevision: string | number;
      mediaObjectId: string | null;
      url: string | null;
    }>(
      `SELECT property.id::text AS "propertyId",
              property.profile_revision AS "profileRevision",
              media_object.id::text AS "mediaObjectId",
              variant.public_cdn_url AS url
       FROM hotel_catalog.properties property
       JOIN identity.organization_resource_links owner
         ON owner.product = 'hotel_catalog'
        AND owner.resource_type = 'property'
        AND owner.resource_id = property.id::text
        AND owner.relationship = 'owner'
        AND owner.status = 'active'
       JOIN identity.organizations organization
         ON organization.id = owner.organization_id
        AND organization.kind = 'hotel_group'
        AND organization.status = 'active'
       LEFT JOIN hotel_catalog.property_media assignment
         ON assignment.property_id = property.id
        AND assignment.media_type = 'hero_image'
        AND assignment.source_system = 'platform'
        AND assignment.public_approved = TRUE
       LEFT JOIN platform.media_objects media_object
         ON media_object.id = assignment.platform_media_object_id
        AND media_object.owner_organization_id = owner.organization_id
        AND media_object.property_id = property.id
        AND media_object.purpose = 'property.hero_image'
        AND media_object.visibility = 'public'
        AND media_object.public_approved = TRUE
        AND media_object.lifecycle_status = 'active'
        AND media_object.storage_kind = 'vayada_managed'
       LEFT JOIN platform.media_variants variant
         ON variant.media_object_id = media_object.id
        AND variant.variant_name = 'original_safe'
        AND variant.visibility = 'public'
       WHERE property.id = $1::uuid
         AND property.lifecycle_status <> 'retired'
       ORDER BY owner.organization_id, assignment.id, variant.id`,
      [propertyId],
    );
    const row = result.rows.length === 1 ? result.rows[0] : undefined;
    if (!row) return null;
    return {
      propertyId: row.propertyId,
      profileRevision: positiveInteger(row.profileRevision),
      hero:
        row.mediaObjectId && row.url ? { mediaObjectId: row.mediaObjectId, url: row.url } : null,
    };
  } finally {
    client.release();
  }
}

export async function resolveMedia(
  client: Queryable,
  command: PublicationCommand,
  serving: PlatformMediaServingConfig,
): Promise<{ ok: true; media: ReadyMedia[] } | { ok: false; error: PropertyMediaCommandError }> {
  const requestedIds = [...new Set(command.assignments.map(({ mediaObjectId }) => mediaObjectId))];
  if (requestedIds.length === 0) return { ok: true, media: [] };
  const locked = await client.query<{ mediaObjectId: string }>(
    `SELECT media.id::text AS "mediaObjectId"
     FROM platform.media_objects media
     WHERE media.id = ANY($1::uuid[])
       AND media.owner_organization_id = $2::uuid
       AND media.property_id = $3::uuid
       AND media.purpose = ANY($4::text[])
     ORDER BY media.id
     FOR UPDATE OF media`,
    [requestedIds, command.organizationId, command.propertyId, PROPERTY_MEDIA_UPLOAD_PURPOSES],
  );
  const lockedIds = new Set(locked.rows.map(({ mediaObjectId }) => mediaObjectId));
  const inaccessible = requestedIds.filter((id) => !lockedIds.has(id));
  if (inaccessible.length) return mediaFailure("media_not_found", inaccessible);
  await client.query(
    `SELECT variant.id
     FROM platform.media_variants variant
     JOIN platform.media_objects media
       ON media.id = variant.media_object_id
      AND media.owner_organization_id = $2::uuid
      AND media.property_id = $3::uuid
     WHERE variant.media_object_id = ANY($1::uuid[])
     ORDER BY variant.media_object_id, variant.variant_name
     FOR UPDATE OF variant`,
    [requestedIds, command.organizationId, command.propertyId],
  );
  const result = await client.query<MediaRow>(
    `SELECT
       media.id::text AS "mediaObjectId",
       media.bucket,
       media.storage_key AS "storageKey",
       media.storage_kind AS "storageKind",
       media.visibility,
       media.purpose,
       media.owner_organization_id::text AS "ownerOrganizationId",
       media.property_id::text AS "propertyId",
       media.lifecycle_status AS "lifecycleStatus",
       media.public_approved AS "publicApproved",
       media.content_type AS "contentType",
       media.width_px AS "widthPx",
       media.height_px AS "heightPx",
       media.size_bytes AS "sizeBytes",
       media.checksum_sha256 AS "checksumSha256",
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'variantName', variant.variant_name,
           'visibility', variant.visibility,
           'storageKey', variant.storage_key,
           'contentType', variant.content_type,
           'widthPx', variant.width_px,
           'heightPx', variant.height_px,
           'sizeBytes', variant.size_bytes,
           'checksumSha256', variant.checksum_sha256,
           'publicUrl', variant.public_cdn_url
         ) ORDER BY variant.variant_name)
         FROM platform.media_variants variant
         WHERE variant.media_object_id = media.id
       ), '[]'::jsonb) AS variants
     FROM platform.media_objects media
     WHERE media.id = ANY($1::uuid[])
       AND media.owner_organization_id = $2::uuid
       AND media.property_id = $3::uuid
     ORDER BY media.id`,
    [requestedIds, command.organizationId, command.propertyId],
  );
  const byId = new Map(result.rows.map((row) => [row.mediaObjectId, row]));
  const unreadable = requestedIds.filter((id) => !byId.has(id));
  if (unreadable.length) return mediaFailure("media_not_found", unreadable);
  if (command.platformAdminHero) {
    const cover = command.assignments.find(({ role }) => role === "cover");
    if (cover && byId.get(cover.mediaObjectId)?.purpose !== "property.hero_image") {
      return mediaFailure("media_not_found", [cover.mediaObjectId]);
    }
  }
  const ready = requestedIds.map((id) => toReadyMedia(byId.get(id)!, serving));
  const notReady = ready.flatMap((media, index) => (media ? [] : [requestedIds[index]!]));
  if (notReady.length) return mediaFailure("media_not_ready", notReady);
  return { ok: true, media: ready as ReadyMedia[] };
}

export function toReadyMedia(
  row: MediaRow,
  serving: PlatformMediaServingConfig,
): ReadyMedia | null {
  if (
    row.storageKind !== "vayada_managed" ||
    row.bucket !== serving.bucketName ||
    !Array.isArray(row.variants)
  ) {
    return null;
  }
  const variants = row.variants.map(toVariantRow);
  if (
    variants.some((variant) => !variant) ||
    variants.length !== PROPERTY_MEDIA_PUBLIC_VARIANTS.length ||
    new Set(variants.map((variant) => variant!.variantName)).size !== variants.length ||
    PROPERTY_MEDIA_PUBLIC_VARIANTS.some(
      (name) => !variants.some((variant) => variant!.variantName === name),
    )
  ) {
    return null;
  }
  const parsed = variants as VariantRow[];
  const privateReady =
    row.visibility === "private" &&
    row.publicApproved === false &&
    row.lifecycleStatus === "staged";
  const publicReady =
    row.visibility === "public" && row.publicApproved === true && row.lifecycleStatus === "active";
  if (!privateReady && !publicReady) return null;
  if (
    publicReady &&
    !hasCanonicalPublicVariantKeys(parsed, row.mediaObjectId, serving.publicPathPrefix)
  ) {
    return null;
  }

  const expectedVisibility = privateReady ? "private" : "public";
  const canonicalPrivateVariants = parsed.map((variant) => {
    if (
      variant.visibility !== expectedVisibility ||
      (privateReady && variant.publicUrl !== null) ||
      (publicReady && !variant.storageKey.startsWith("public/"))
    ) {
      return null;
    }
    const privateStorageKey = privateReady
      ? variant.storageKey
      : `private/${serving.publicPathPrefix}/${row.mediaObjectId}/${variant.variantName}/sha256-${variant.checksumSha256 ?? ""}.webp`;
    return {
      variantName: variant.variantName as CanonicalPrivatePropertyVariant["variantName"],
      visibility: "private" as const,
      storageKey: privateStorageKey,
      contentType: variant.contentType,
      sizeBytes: variant.sizeBytes,
      checksumSha256: variant.checksumSha256 ?? undefined,
      widthPx: variant.widthPx ?? undefined,
      heightPx: variant.heightPx ?? undefined,
      publicCdnUrl: null,
    };
  });
  if (canonicalPrivateVariants.some((variant) => !variant)) return null;
  try {
    assertCanonicalPrivatePropertyVariants({
      mediaId: row.mediaObjectId,
      variants: canonicalPrivateVariants as CanonicalPrivatePropertyVariant[],
      mediaPathPrefix: serving.publicPathPrefix,
    });
  } catch {
    return null;
  }

  const promotion = parsed.map((variant) => {
    const publicStorageKey = privateReady
      ? `public/${variant.storageKey.slice("private/".length)}`
      : variant.storageKey;
    const publicUrl = new URL(
      publicStorageKey.slice("public/".length),
      `${serving.cdnBaseUrl}/`,
    ).toString();
    if (publicReady && variant.publicUrl !== publicUrl) {
      return null;
    }
    return {
      variantName: variant.variantName,
      privateStorageKey: variant.storageKey,
      publicStorageKey,
      publicUrl,
      contentType: variant.contentType,
    };
  });
  if (promotion.some((variant) => !variant)) return null;
  const originalSafe = promotion.find((variant) => variant!.variantName === "original_safe")!;
  const originalSafeRecord = parsed.find(({ variantName }) => variantName === "original_safe")!;
  const objectSize = nullableInteger(row.sizeBytes);
  const objectWidth = nullableInteger(row.widthPx);
  const objectHeight = nullableInteger(row.heightPx);
  if (
    row.storageKey !==
      (privateReady ? originalSafe.privateStorageKey : originalSafe.publicStorageKey) ||
    row.contentType !== originalSafe.contentType ||
    objectSize === undefined ||
    objectSize !== originalSafeRecord.sizeBytes ||
    row.checksumSha256 !== originalSafeRecord.checksumSha256 ||
    objectWidth === undefined ||
    objectWidth !== originalSafeRecord.widthPx ||
    objectHeight === undefined ||
    objectHeight !== originalSafeRecord.heightPx
  ) {
    return null;
  }
  return {
    mediaObjectId: row.mediaObjectId,
    originalSafeUrl: originalSafe.publicUrl,
    promotion: privateReady ? (promotion as ReadyMedia["promotion"]) : [],
  };
}

export function hasCanonicalPublicVariantKeys(
  variants: readonly VariantRow[],
  mediaObjectId: string,
  mediaPathPrefix: string,
): boolean {
  if (
    variants.every(
      (variant) =>
        variant.checksumSha256 !== null &&
        variant.storageKey ===
          `public/${mediaPathPrefix}/${mediaObjectId}/${variant.variantName}/sha256-${variant.checksumSha256}.webp`,
    )
  ) {
    return true;
  }
  let sharedToken: string | null = null;
  for (const variant of variants) {
    const keyPrefix = `public/${mediaPathPrefix}/${mediaObjectId}/${variant.variantName}/publication-`;
    if (!variant.storageKey.startsWith(keyPrefix) || !variant.storageKey.endsWith(".webp")) {
      return false;
    }
    const token = variant.storageKey.slice(keyPrefix.length, -".webp".length);
    if (!isUuid(token) || token !== token.toLowerCase()) return false;
    if (sharedToken && sharedToken !== token) return false;
    sharedToken = token;
  }
  return sharedToken !== null;
}

export function toVariantRow(value: unknown): VariantRow | null {
  if (!isRecord(value)) return null;
  const {
    variantName,
    visibility,
    storageKey,
    contentType,
    widthPx,
    heightPx,
    sizeBytes,
    checksumSha256,
    publicUrl,
  } = value;
  const parsedWidth = nullableInteger(widthPx);
  const parsedHeight = nullableInteger(heightPx);
  const parsedSize = nullableInteger(sizeBytes);
  return typeof variantName === "string" &&
    typeof visibility === "string" &&
    typeof storageKey === "string" &&
    typeof contentType === "string" &&
    parsedWidth !== undefined &&
    parsedHeight !== undefined &&
    parsedSize !== undefined &&
    parsedSize !== null &&
    (typeof checksumSha256 === "string" || checksumSha256 === null) &&
    (typeof publicUrl === "string" || publicUrl === null)
    ? {
        variantName,
        visibility,
        storageKey,
        contentType,
        widthPx: parsedWidth,
        heightPx: parsedHeight,
        sizeBytes: parsedSize,
        checksumSha256,
        publicUrl,
      }
    : null;
}

export function nullableInteger(value: unknown): number | null | undefined {
  if (value === null) return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function promoteRegistryRows(
  client: Queryable,
  media: readonly ReadyMedia[],
): Promise<void> {
  for (const item of media.filter(({ promotion }) => promotion.length > 0)) {
    const originalSafe = item.promotion.find(({ variantName }) => variantName === "original_safe")!;
    const updated = await client.query(
      `UPDATE platform.media_objects
       SET visibility = 'public',
           storage_key = $2,
           lifecycle_status = 'active',
           public_approved = TRUE,
           updated_at = now()
       WHERE id = $1::uuid
         AND visibility = 'private'
         AND lifecycle_status = 'staged'
         AND public_approved = FALSE
       RETURNING id`,
      [item.mediaObjectId, originalSafe.publicStorageKey],
    );
    if (updated.rowCount !== 1) throw new Error("Property media promotion lost its registry lock");
    for (const variant of item.promotion) {
      const promoted = await client.query(
        `UPDATE platform.media_variants
         SET visibility = 'public', storage_key = $3, public_cdn_url = $4
         WHERE media_object_id = $1::uuid
           AND variant_name = $2
           AND visibility = 'private'`,
        [item.mediaObjectId, variant.variantName, variant.publicStorageKey, variant.publicUrl],
      );
      if (promoted.rowCount !== 1) {
        throw new Error("Property media promotion lost a variant registry row");
      }
    }
  }
}

export async function stageAssignments(
  client: Queryable,
  command: PublicationCommand,
  publicationJobId: string,
): Promise<void> {
  const affectedTypes = affectedMediaTypes(command);
  await client.query(
    `DELETE FROM hotel_catalog.property_media
     WHERE property_id = $1::uuid
       AND media_type = ANY($2::text[])
       AND source_system = 'platform'
       AND public_approved = FALSE`,
    [command.propertyId, affectedTypes],
  );
  if (command.assignments.length === 0) return;
  const payload = command.assignments.map((assignment) => ({
    platform_media_object_id: assignment.mediaObjectId,
    media_type: MEDIA_TYPE_BY_ROLE[assignment.role],
    url: `urn:vayada:platform-media:${assignment.mediaObjectId}`,
    alt_text: assignment.altText,
    sort_order: assignment.sortOrder,
  }));
  await client.query(
    `INSERT INTO hotel_catalog.property_media (
       property_id, media_type, url, alt_text, sort_order, source_system,
       public_approved, rights_metadata, platform_media_object_id, updated_at
     )
     SELECT
       $1::uuid, input.media_type, input.url, input.alt_text, input.sort_order,
       'platform', FALSE,
       jsonb_build_object(
         'platformMediaObjectId', input.platform_media_object_id,
         'publicationJobId', $3::text,
         'publicationState', 'pending'
       ),
       input.platform_media_object_id, now()
     FROM jsonb_to_recordset($2::jsonb) AS input(
       platform_media_object_id uuid,
       media_type text,
       url text,
       alt_text text,
       sort_order integer
     )`,
    [command.propertyId, JSON.stringify(payload), publicationJobId],
  );
}

export async function removePendingAssignments(
  client: Queryable,
  propertyId: string,
  publicationJobId: string,
): Promise<number> {
  const removed = await client.query(
    `DELETE FROM hotel_catalog.property_media
     WHERE property_id = $1::uuid
       AND source_system = 'platform'
       AND public_approved = FALSE
       AND rights_metadata ->> 'publicationJobId' = $2
       AND rights_metadata ->> 'publicationState' = 'pending'`,
    [propertyId, publicationJobId],
  );
  return removed.rowCount ?? 0;
}

export async function replaceAssignments(
  client: Queryable,
  command: PublicationCommand,
  readyMedia: readonly ReadyMedia[],
): Promise<void> {
  const affectedTypes = affectedMediaTypes(command);
  await client.query(
    `DELETE FROM hotel_catalog.property_media
     WHERE property_id = $1::uuid
       AND media_type = ANY($2::text[])`,
    [command.propertyId, affectedTypes],
  );
  if (command.assignments.length === 0) return;
  const media = new Map(readyMedia.map((item) => [item.mediaObjectId, item]));
  const payload = command.assignments.map((assignment) => ({
    platform_media_object_id: assignment.mediaObjectId,
    media_type: MEDIA_TYPE_BY_ROLE[assignment.role],
    url: media.get(assignment.mediaObjectId)!.originalSafeUrl,
    alt_text: assignment.altText,
    sort_order: assignment.sortOrder,
  }));
  await client.query(
    `INSERT INTO hotel_catalog.property_media (
       property_id, media_type, url, alt_text, sort_order, source_system,
       public_approved, rights_metadata, platform_media_object_id, updated_at
     )
     SELECT
       $1::uuid, input.media_type, input.url, input.alt_text, input.sort_order,
       'platform', TRUE,
       jsonb_build_object('platformMediaObjectId', input.platform_media_object_id),
       input.platform_media_object_id, now()
     FROM jsonb_to_recordset($2::jsonb) AS input(
       platform_media_object_id uuid,
       media_type text,
       url text,
       alt_text text,
       sort_order integer
     )`,
    [command.propertyId, JSON.stringify(payload)],
  );
}

function affectedMediaTypes(command: PublicationCommand): string[] {
  if (command.operation === "logo") return ["logo"];
  return command.platformAdminHero ? ["hero_image"] : ["hero_image", "gallery_image"];
}

export async function loadAssignments(
  client: Queryable,
  propertyId: string,
): Promise<AssignmentRow[]> {
  const result = await client.query<AssignmentRow>(
    `SELECT
       media.platform_media_object_id::text AS "mediaObjectId",
       media.media_type AS "mediaType",
       media.alt_text AS "altText",
       media.sort_order AS "sortOrder"
     FROM hotel_catalog.property_media media
     WHERE media.property_id = $1::uuid
       AND media.source_system = 'platform'
       AND media.public_approved = TRUE
       AND media.platform_media_object_id IS NOT NULL
     ORDER BY CASE media.media_type WHEN 'logo' THEN 0 WHEN 'hero_image' THEN 1 ELSE 2 END,
              media.sort_order,
              media.id`,
    [propertyId],
  );
  return result.rows;
}

export async function assertPendingAssignments(
  client: Queryable,
  claim: Pick<PublicationClaim, "jobId" | "payload">,
): Promise<void> {
  const result = await client.query<AssignmentRow>(
    `SELECT
       media.platform_media_object_id::text AS "mediaObjectId",
       media.media_type AS "mediaType",
       media.alt_text AS "altText",
       media.sort_order AS "sortOrder"
     FROM hotel_catalog.property_media media
     WHERE media.property_id = $1::uuid
       AND media.source_system = 'platform'
       AND media.public_approved = FALSE
       AND media.platform_media_object_id IS NOT NULL
       AND media.rights_metadata ->> 'publicationJobId' = $2
       AND media.rights_metadata ->> 'publicationState' = 'pending'
     ORDER BY CASE media.media_type WHEN 'logo' THEN 0 WHEN 'hero_image' THEN 1 ELSE 2 END,
              media.sort_order,
              media.id`,
    [claim.payload.command.propertyId, claim.jobId],
  );
  const expected = claim.payload.command.assignments.map((assignment) => ({
    mediaObjectId: assignment.mediaObjectId,
    mediaType: MEDIA_TYPE_BY_ROLE[assignment.role],
    altText: assignment.altText,
    sortOrder: assignment.sortOrder,
  }));
  if (canonicalJson(result.rows) !== canonicalJson(expected)) {
    throw new Error("Property media publication lost its pending CAS assignment");
  }
}

export async function loadProfileRevision(client: Queryable, propertyId: string): Promise<number> {
  const result = await client.query<PropertyRow>(
    `SELECT profile_revision AS "profileRevision"
     FROM hotel_catalog.properties
     WHERE id = $1::uuid`,
    [propertyId],
  );
  const revision = result.rows[0]?.profileRevision;
  if (revision === undefined) throw new Error("Property profile revision was not advanced");
  return positiveInteger(revision);
}

export async function findIdempotency(
  client: Queryable,
  command: InternalCommand,
  keyHash: string,
): Promise<IdempotencyRow | null> {
  const result = await client.query<IdempotencyRow>(
    `SELECT id::text AS id, status,
            request_fingerprint_hash AS "requestFingerprintHash",
            response_status_code AS "responseStatusCode",
            response_body_hash AS "responseBodyHash",
            idempotency_metadata AS metadata
     FROM platform.idempotency_keys
     WHERE operation_scope = 'hotel_catalog'
       AND operation = $1
       AND key_hash = $2
       AND tenant_scope = 'property'
       AND property_id = $3::uuid
     FOR UPDATE`,
    [OPERATIONS[command.operation], keyHash, command.propertyId],
  );
  return result.rows[0] ?? null;
}

export function replayIdempotency(
  row: IdempotencyRow,
  fingerprint: string,
): PropertyMediaCommandResult | null {
  if (row.status !== "completed") return null;
  if (row.requestFingerprintHash !== fingerprint) {
    return { ok: false, error: { code: "idempotency_key_conflict" } };
  }
  const stored = isRecord(row.metadata) ? parseStoredResult(row.metadata["result"]) : null;
  if (!stored) return { ok: false, error: { code: "idempotency_key_conflict" } };
  const body = stored.ok ? stored.response : stored.error;
  if (
    row.responseStatusCode !== propertyMediaCommandResultStatus(stored) ||
    row.responseBodyHash !== sha256(canonicalJson(body))
  ) {
    return { ok: false, error: { code: "idempotency_key_conflict" } };
  }
  return stored;
}

export async function reserveIdempotency(
  client: Queryable,
  command: InternalCommand,
  keyHash: string,
  fingerprint: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO platform.idempotency_keys (
       operation_scope, operation, key_hash, request_fingerprint_hash,
       tenant_scope, property_id, correlation_id, expires_at
     ) VALUES (
       'hotel_catalog', $1, $2, $3, 'property', $4::uuid, $5,
       'infinity'::timestamptz
     )
     ON CONFLICT DO NOTHING
     RETURNING id::text AS id`,
    [
      OPERATIONS[command.operation],
      keyHash,
      fingerprint,
      command.propertyId,
      command.audit.correlationId ?? command.audit.requestId,
    ],
  );
  return result.rows[0]?.id ?? null;
}

export async function completeIdempotency(
  client: Queryable,
  id: string,
  result: PropertyMediaCommandResult,
  occurredAt: Date,
): Promise<void> {
  const body = result.ok ? result.response : result.error;
  const completed = await client.query(
    `UPDATE platform.idempotency_keys
     SET status = 'completed', response_status_code = $2,
         response_body_hash = $3, completed_at = $4::timestamptz,
         last_seen_at = $4::timestamptz,
         locked_until = NULL,
         idempotency_metadata = jsonb_build_object('result', $5::jsonb)
     WHERE id = $1::uuid AND status = 'in_progress'`,
    [
      id,
      propertyMediaCommandResultStatus(result),
      sha256(canonicalJson(body)),
      occurredAt.toISOString(),
      JSON.stringify(result),
    ],
  );
  if (completed.rowCount !== 1) throw new Error("Property media idempotency completion failed");
}

export async function recordAcceptedAudit(
  client: Queryable,
  payload: PublicationJobPayload,
  publicationJobId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, audit_metadata
     ) VALUES (
       $1, 'hotel_catalog', 'property.media.publication.accepted', $2::timestamptz,
       'property', $3::uuid, 'user', $4::uuid, 'hotel_catalog', 'property', $3,
       $5::uuid, $6, $7, $8::jsonb, $9::jsonb
     )`,
    [
      `property_media.${payload.command.operation}.${payload.command.propertyId}.key.${payload.keyHash}.accepted.v1`,
      payload.acceptedAt,
      payload.command.propertyId,
      payload.command.actorUserId,
      payload.idempotencyId,
      payload.command.audit.correlationId ?? payload.command.audit.requestId,
      payload.command.audit.requestId,
      JSON.stringify({
        publicationJobId,
        acceptedProfileRevision: payload.acceptedProfileRevision,
        before: payload.before,
        requestedAssignments: payload.command.assignments,
      }),
      JSON.stringify({
        source: payload.command.audit.source,
        requestId: payload.command.audit.requestId,
        publicationStatus: "pending",
      }),
    ],
  );
}

export async function recordFinalAudit(
  client: Queryable,
  input: {
    command: PublicationCommand;
    idempotencyId: string;
    keyHash: string;
    before: AssignmentRow[];
    result: PropertyMediaCommandResult;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id,
       actor_type, actor_user_id, target_resource_product, target_resource_type,
       target_resource_id, idempotency_key_id, correlation_id, causation_id,
       redacted_payload, audit_metadata
     ) VALUES (
       $1, 'hotel_catalog', $2, $3::timestamptz, 'property', $4::uuid,
       'user', $5::uuid, 'hotel_catalog', 'property', $4,
       $6::uuid, $7, $8, $9::jsonb, $10::jsonb
     )`,
    [
      `property_media.${input.command.operation}.${input.command.propertyId}.key.${input.keyHash}.completed.v1`,
      input.result.ok
        ? input.command.operation === "logo"
          ? "property.media.logo.assigned"
          : "property.media.presentation.replaced"
        : "property.media.command.rejected",
      input.occurredAt.toISOString(),
      input.command.propertyId,
      input.command.actorUserId,
      input.idempotencyId,
      input.command.audit.correlationId ?? input.command.audit.requestId,
      input.command.audit.requestId,
      JSON.stringify({
        before: input.before,
        expectedProfileRevision: input.command.expectedProfileRevision,
        requestedAssignments: input.command.assignments,
        result: input.result.ok ? input.result.response : input.result.error,
      }),
      JSON.stringify({
        source: input.command.audit.source,
        requestId: input.command.audit.requestId,
      }),
    ],
  );
}
