import type { CreatorPlatformProvider } from "@vayada/domain-marketplace";
import pg, { type QueryResultRow } from "pg";

export const CREATOR_PLATFORM_SYNC_QUEUE = "marketplace.creator-platform-sync";
export const CREATOR_PLATFORM_SYNC_JOB_TYPE = "creator-platform.sync";
const JOB_LEASE_MS = 10 * 60_000;

export type CreatorPlatformSyncJob = {
  jobId: string;
  connectionId: string | null;
  provider: CreatorPlatformProvider | null;
  scheduledAt: string;
  attemptNumber: number;
  maxAttempts: number;
  workerId: string;
  invalidPayload: boolean;
};

export type CreatorPlatformSyncStore = {
  schedule(input: { now: Date; syncIntervalMs: number; maxAttempts: number }): Promise<number>;
  claim(input: {
    now: Date;
    workerId: string;
    minimumSpacingMs: Record<CreatorPlatformProvider, number>;
  }): Promise<CreatorPlatformSyncJob | null>;
  succeed(
    job: CreatorPlatformSyncJob,
    input: { now: Date; outcome: "succeeded" | "reconnect_required" },
  ): Promise<boolean>;
  fail(
    job: CreatorPlatformSyncJob,
    input: { now: Date; code: string; retryAt: Date | null },
  ): Promise<boolean>;
  cancel(job: CreatorPlatformSyncJob, input: { now: Date; code: string }): Promise<boolean>;
  close(): Promise<void>;
};

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};
type Client = Queryable & { release(error?: Error | boolean): void };
type Pool = Queryable & {
  connect(): Promise<Client>;
  end(): Promise<void>;
};

type JobRow = {
  jobId: string;
  attemptsCount: number;
  maxAttempts: number;
  payload: unknown;
  provider: CreatorPlatformProvider | null;
  scheduledAt: Date | string;
};

export function createPgCreatorPlatformSyncStore(config: {
  connectionString: string;
  pool?: Pool;
}): CreatorPlatformSyncStore {
  const pool = config.pool ?? new pg.Pool({ connectionString: config.connectionString, max: 3 });
  return {
    schedule: (input) => schedule(pool, input),
    claim: (input) => claim(pool, input),
    succeed: (job, input) => finish(pool, job, input.now, "succeeded", input.outcome),
    fail: (job, input) => fail(pool, job, input),
    cancel: (job, input) => finish(pool, job, input.now, "canceled", input.code),
    close: () => pool.end(),
  };
}

async function schedule(
  pool: Pool,
  input: { now: Date; syncIntervalMs: number; maxAttempts: number },
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO platform.jobs (
       job_key, queue_name, job_type, status, max_attempts, run_after,
       tenant_scope, organization_id, resource_product, resource_type, resource_id, payload
     )
     SELECT 'creator-platform-sync:' || connection.id::text || ':' ||
              floor(extract(epoch FROM $1::timestamptz) * 1000 / $2::bigint)::bigint,
            $4, $5, 'pending', $3, $1::timestamptz,
            'organization', connection.organization_id, 'marketplace',
            'creator_platform_connection', connection.id::text,
            jsonb_build_object('connectionId', connection.id::text)
     FROM marketplace.creator_platform_connections connection
     WHERE connection.status = 'active'
       AND connection.credential_ref IS NOT NULL
       AND COALESCE(connection.last_successful_sync_at, connection.created_at)
           <= $1::timestamptz - ($2::bigint * interval '1 millisecond')
       AND NOT EXISTS (
         SELECT 1 FROM platform.jobs active_job
         WHERE active_job.queue_name = $4
           AND active_job.resource_type = 'creator_platform_connection'
           AND active_job.resource_id = connection.id::text
           AND active_job.status IN ('pending', 'running')
       )
     ON CONFLICT (queue_name, job_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      input.now.toISOString(),
      positive(input.syncIntervalMs),
      positive(input.maxAttempts),
      CREATOR_PLATFORM_SYNC_QUEUE,
      CREATOR_PLATFORM_SYNC_JOB_TYPE,
    ],
  );
  return result.rows.length;
}

async function claim(
  pool: Pool,
  input: {
    now: Date;
    workerId: string;
    minimumSpacingMs: Record<CreatorPlatformProvider, number>;
  },
): Promise<CreatorPlatformSyncJob | null> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [CREATOR_PLATFORM_SYNC_QUEUE]);
    await deadLetterExpiredJobs(client, input.now);
    const result = await client.query<JobRow>(
      `WITH candidate AS MATERIALIZED (
       SELECT job.id, job.status, job.attempts_count, job.max_attempts,
              job.payload, connection.provider
       FROM platform.jobs job
       LEFT JOIN marketplace.creator_platform_connections connection
         ON connection.id::text = job.resource_id
       WHERE job.queue_name = $1 AND job.job_type = $2
         AND job.run_after <= $3::timestamptz
         AND job.attempts_count < job.max_attempts
         AND (
           job.status = 'pending'
           OR (job.status = 'running'
               AND job.locked_at <= $3::timestamptz - ($4::bigint * interval '1 millisecond'))
         )
         AND (
           connection.provider IS NULL OR (
             NOT EXISTS (
               SELECT 1 FROM platform.jobs running_job
               JOIN marketplace.creator_platform_connections running_connection
                 ON running_connection.id::text = running_job.resource_id
               WHERE running_job.queue_name = $1 AND running_job.status = 'running'
                 AND running_job.id <> job.id
                 AND running_connection.provider = connection.provider
             )
             AND NOT EXISTS (
               SELECT 1 FROM platform.job_attempts recent_attempt
               JOIN platform.jobs recent_job ON recent_job.id = recent_attempt.job_id
               JOIN marketplace.creator_platform_connections recent_connection
                 ON recent_connection.id::text = recent_job.resource_id
               WHERE recent_job.queue_name = $1
                 AND recent_connection.provider = connection.provider
                 AND recent_attempt.started_at > $3::timestamptz -
                   (CASE connection.provider
                      WHEN 'meta' THEN $6::bigint
                      WHEN 'tiktok' THEN $7::bigint
                      ELSE $8::bigint
                    END * interval '1 millisecond')
             )
           )
         )
       ORDER BY job.priority DESC, job.run_after, job.created_at
       FOR UPDATE OF job SKIP LOCKED LIMIT 1
     ), timed_out AS (
       UPDATE platform.job_attempts attempt
       SET status = 'timed_out', finished_at = $3::timestamptz,
           error_type = 'worker_lease_expired',
           error_message = 'Creator platform sync worker lease expired.'
       FROM candidate
       WHERE candidate.status = 'running' AND attempt.job_id = candidate.id
         AND attempt.attempt_number = candidate.attempts_count AND attempt.status = 'running'
     ), claimed AS (
       UPDATE platform.jobs job
       SET status = 'running', attempts_count = candidate.attempts_count + 1,
           locked_at = $3::timestamptz, locked_by = $5, updated_at = $3::timestamptz
       FROM candidate WHERE job.id = candidate.id
       RETURNING job.id, job.attempts_count, job.max_attempts, job.payload, job.created_at
     ), attempt AS (
       INSERT INTO platform.job_attempts (job_id, attempt_number, status, worker_id, started_at)
       SELECT claimed.id, claimed.attempts_count, 'running', $5, $3::timestamptz FROM claimed
       RETURNING job_id
     )
     SELECT claimed.id::text AS "jobId", claimed.attempts_count AS "attemptsCount",
            claimed.max_attempts AS "maxAttempts", claimed.payload, candidate.provider,
            claimed.created_at AS "scheduledAt"
     FROM claimed JOIN candidate ON candidate.id = claimed.id
     JOIN attempt ON attempt.job_id = claimed.id`,
      [
        CREATOR_PLATFORM_SYNC_QUEUE,
        CREATOR_PLATFORM_SYNC_JOB_TYPE,
        input.now.toISOString(),
        JOB_LEASE_MS,
        input.workerId,
        positive(input.minimumSpacingMs.meta),
        positive(input.minimumSpacingMs.tiktok),
        positive(input.minimumSpacingMs.google),
      ],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) return null;
    const connectionId = parseConnectionId(row.payload);
    return {
      jobId: row.jobId,
      connectionId,
      provider: row.provider,
      scheduledAt: new Date(row.scheduledAt).toISOString(),
      attemptNumber: row.attemptsCount,
      maxAttempts: row.maxAttempts,
      workerId: input.workerId,
      invalidPayload: connectionId === null,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError as Error;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function deadLetterExpiredJobs(client: Queryable, now: Date): Promise<void> {
  await client.query(
    `WITH expired AS (
       UPDATE platform.jobs job SET status = 'dead_lettered', finished_at = $3::timestamptz,
         locked_at = NULL, locked_by = NULL, updated_at = $3::timestamptz,
         job_metadata = job_metadata || '{"lastErrorCode":"worker_lease_expired"}'::jsonb
       WHERE job.queue_name = $1 AND job.job_type = $2 AND job.status = 'running'
         AND job.attempts_count >= job.max_attempts
         AND job.locked_at <= $3::timestamptz - ($4::bigint * interval '1 millisecond')
       RETURNING job.*
     ), attempt AS (
       UPDATE platform.job_attempts attempt SET status = 'timed_out',
         finished_at = $3::timestamptz, error_type = 'worker_lease_expired',
         error_message = 'Creator platform sync worker lease expired.'
       FROM expired WHERE attempt.job_id = expired.id
         AND attempt.attempt_number = expired.attempts_count AND attempt.status = 'running'
       RETURNING attempt.id, attempt.job_id
     )
     INSERT INTO platform.dead_letter_events (
       source_kind, job_id, job_attempt_id, tenant_scope, organization_id,
       resource_product, resource_type, resource_id, correlation_id,
       reason_code, failure_summary, failure_payload
     )
     SELECT 'job', expired.id, attempt.id, expired.tenant_scope, expired.organization_id,
       expired.resource_product, expired.resource_type, expired.resource_id,
       expired.correlation_id, 'creator_platform_sync_exhausted',
       'Creator platform sync worker lease expired after the final attempt.',
       jsonb_build_object('failureCode', 'worker_lease_expired')
     FROM expired JOIN attempt ON attempt.job_id = expired.id`,
    [CREATOR_PLATFORM_SYNC_QUEUE, CREATOR_PLATFORM_SYNC_JOB_TYPE, now.toISOString(), JOB_LEASE_MS],
  );
}

async function finish(
  pool: Pool,
  job: CreatorPlatformSyncJob,
  now: Date,
  status: "succeeded" | "canceled",
  outcome: string,
): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `WITH attempt AS (
       UPDATE platform.job_attempts SET status = $6, finished_at = $4::timestamptz
       WHERE job_id = $1::uuid AND attempt_number = $2 AND worker_id = $3
         AND status = 'running' RETURNING id
     )
     UPDATE platform.jobs SET status = $5, finished_at = $4::timestamptz,
       locked_at = NULL, locked_by = NULL, updated_at = $4::timestamptz,
       job_metadata = job_metadata || jsonb_build_object('outcome', $7::text)
     WHERE id = $1::uuid AND attempts_count = $2 AND locked_by = $3 AND status = 'running'
       AND EXISTS (SELECT 1 FROM attempt)
     RETURNING id::text AS id`,
    [
      job.jobId,
      job.attemptNumber,
      job.workerId,
      now.toISOString(),
      status,
      status === "succeeded" ? "succeeded" : "canceled",
      outcome,
    ],
  );
  return result.rows.length === 1;
}

async function fail(
  pool: Pool,
  job: CreatorPlatformSyncJob,
  input: { now: Date; code: string; retryAt: Date | null },
): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `WITH attempt AS (
       UPDATE platform.job_attempts SET status = 'failed', finished_at = $4::timestamptz,
         error_type = $5, error_message = 'Creator platform sync failed.',
         retry_after = $6::timestamptz,
         error_metadata = jsonb_build_object('retryable', $6::timestamptz IS NOT NULL)
       WHERE job_id = $1::uuid AND attempt_number = $2 AND worker_id = $3
         AND status = 'running' RETURNING id
     ), failed_job AS (
       UPDATE platform.jobs SET status = CASE WHEN $6::timestamptz IS NULL
           OR attempts_count >= max_attempts
           THEN 'dead_lettered' ELSE 'pending' END,
         run_after = CASE WHEN $6::timestamptz IS NOT NULL
           AND attempts_count < max_attempts THEN $6::timestamptz ELSE run_after END,
         finished_at = CASE WHEN $6::timestamptz IS NULL OR attempts_count >= max_attempts
           THEN $4::timestamptz ELSE NULL END,
         locked_at = NULL, locked_by = NULL, updated_at = $4::timestamptz,
         job_metadata = job_metadata || jsonb_build_object('lastErrorCode', $5::text)
       WHERE id = $1::uuid AND attempts_count = $2 AND locked_by = $3 AND status = 'running'
         AND EXISTS (SELECT 1 FROM attempt) RETURNING *
     ), dead_letter AS (
       INSERT INTO platform.dead_letter_events (
         source_kind, job_id, job_attempt_id, tenant_scope, organization_id,
         resource_product, resource_type, resource_id, correlation_id,
         reason_code, failure_summary, failure_payload
       )
       SELECT 'job', failed_job.id, attempt.id, failed_job.tenant_scope,
         failed_job.organization_id, failed_job.resource_product, failed_job.resource_type,
         failed_job.resource_id, failed_job.correlation_id, 'creator_platform_sync_exhausted',
         'Creator platform sync exhausted its retry policy.',
         jsonb_build_object('failureCode', $5::text)
       FROM failed_job CROSS JOIN attempt WHERE failed_job.status = 'dead_lettered'
     )
     SELECT id::text AS id FROM failed_job`,
    [
      job.jobId,
      job.attemptNumber,
      job.workerId,
      input.now.toISOString(),
      input.code,
      input.retryAt?.toISOString() ?? null,
    ],
  );
  return result.rows.length === 1;
}

function parseConnectionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const entries = Object.entries(payload);
  if (entries.length !== 1 || entries[0]?.[0] !== "connectionId") return null;
  const value = entries[0][1];
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Expected a positive integer");
  return value;
}
