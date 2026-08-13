import { createHash } from "node:crypto";
import pg from "pg";

import type { PmsChannexManagementCommandInput } from "../domains/pmsChannexManagementCommands.js";
import { PMS_CHANNEX_MANAGEMENT_QUEUE } from "../domains/pmsChannexManagementReadModel.js";
import type {
  ChannexManagementJob,
  ChannexManagementProviderFailure,
  ChannexManagementProviderSuccess,
  ChannexManagementWorkerStore,
} from "./pmsChannexManagementWorker.js";

const LEASE_MS = 5 * 60_000;
export type ChannexManagementQueryClient = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  release(): void;
};
type Client = ChannexManagementQueryClient;
type Pool = { connect(): Promise<Client>; end(): Promise<void> };

export type ChannexManagementTargetStatePort = {
  succeed(
    client: ChannexManagementQueryClient,
    job: ChannexManagementJob,
    result: ChannexManagementProviderSuccess,
    now: Date,
  ): Promise<void>;
  fail(
    client: ChannexManagementQueryClient,
    job: ChannexManagementJob,
    failure: ChannexManagementProviderFailure,
    input: { now: Date; retryAt: Date | null },
  ): Promise<void>;
};

type JobRow = {
  jobId: string;
  propertyId: string;
  correlationId: string | null;
  status: "pending" | "running";
  attemptsCount: number;
  maxAttempts: number;
  payload: PmsChannexManagementCommandInput;
};

export function createPgPmsChannexManagementWorkerStore(config: {
  connectionString: string;
  targetState: ChannexManagementTargetStatePort;
  pool?: Pool;
}): ChannexManagementWorkerStore {
  const pool =
    config.pool ?? new pg.Pool({ connectionString: required(config.connectionString), max: 5 });
  return {
    claim: (input) => claim(pool, input),
    succeed: (job, result, input) => complete(pool, config.targetState, job, result, input),
    fail: (job, failure, input) => fail(pool, config.targetState, job, failure, input),
    async close() {
      await pool.end();
    },
  };
}

async function claim(
  pool: Pool,
  input: { workerId: string; now: Date },
): Promise<ChannexManagementJob | null> {
  return transaction(pool, async (client) => {
    const staleAt = new Date(input.now.getTime() - LEASE_MS);
    const result = await client.query<JobRow>(
      `SELECT id::text AS "jobId", property_id::text AS "propertyId",
         correlation_id AS "correlationId", status, attempts_count AS "attemptsCount",
         max_attempts AS "maxAttempts", payload
       FROM platform.jobs
       WHERE queue_name = $1 AND (
         (status = 'pending' AND run_after <= $2::timestamptz)
         OR (status = 'running' AND locked_at <= $3::timestamptz)
       )
       ORDER BY priority DESC, run_after, created_at
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [PMS_CHANNEX_MANAGEMENT_QUEUE, input.now.toISOString(), staleAt.toISOString()],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.status === "running" && row.attemptsCount > 0) {
      await client.query(
        `UPDATE platform.job_attempts SET status = 'timed_out', finished_at = $3::timestamptz,
           error_type = 'worker_lease_expired', error_message = 'Channex worker lease expired',
           error_metadata = error_metadata || '{"retryable":true}'::jsonb
         WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'`,
        [row.jobId, row.attemptsCount, input.now.toISOString()],
      );
    }
    const attemptNumber = row.attemptsCount + 1;
    if (attemptNumber > row.maxAttempts) throw new Error("Channex job exceeded max attempts");
    await client.query(
      `UPDATE platform.jobs SET status = 'running', attempts_count = $3,
         locked_at = $4::timestamptz, locked_by = $2, updated_at = $4::timestamptz
       WHERE id = $1::uuid`,
      [row.jobId, input.workerId, attemptNumber, input.now.toISOString()],
    );
    await client.query(
      `INSERT INTO platform.job_attempts (
         job_id, attempt_number, status, worker_id, started_at, error_metadata
       ) VALUES ($1::uuid, $2, 'running', $3, $4::timestamptz, '{"provider":"channex"}'::jsonb)`,
      [row.jobId, attemptNumber, input.workerId, input.now.toISOString()],
    );
    return {
      jobId: row.jobId,
      propertyId: row.propertyId,
      correlationId: row.correlationId,
      attemptNumber,
      maxAttempts: row.maxAttempts,
      input: row.payload,
    };
  });
}

async function complete(
  pool: Pool,
  targetState: ChannexManagementTargetStatePort,
  job: ChannexManagementJob,
  result: ChannexManagementProviderSuccess,
  input: { workerId: string; now: Date },
): Promise<void> {
  await transaction(pool, async (client) => {
    await targetState.succeed(client, job, result, input.now);
    await client.query(
      `UPDATE platform.job_attempts SET status = 'succeeded', finished_at = $4::timestamptz,
         error_metadata = error_metadata || jsonb_build_object('providerRequestId', $5)
       WHERE job_id = $1::uuid AND attempt_number = $2 AND worker_id = $3 AND status = 'running'`,
      [
        job.jobId,
        job.attemptNumber,
        input.workerId,
        input.now.toISOString(),
        result.providerRequestId,
      ],
    );
    await client.query(
      `UPDATE platform.jobs SET status = 'succeeded', finished_at = $3::timestamptz,
         locked_at = NULL, locked_by = NULL, updated_at = $3::timestamptz,
         job_metadata = job_metadata || jsonb_build_object('providerRequestId', $4)
       WHERE id = $1::uuid AND locked_by = $2`,
      [job.jobId, input.workerId, input.now.toISOString(), result.providerRequestId],
    );
    await finishIdempotency(client, job, input.now, "completed");
    await insertOutcomeAudit(client, job, input.now, "succeeded", result.providerRequestId);
  });
}

async function fail(
  pool: Pool,
  targetState: ChannexManagementTargetStatePort,
  job: ChannexManagementJob,
  failure: ChannexManagementProviderFailure,
  input: { workerId: string; now: Date; retryable: boolean; retryAt: Date | null },
): Promise<"retry_scheduled" | "dead_lettered"> {
  return transaction(pool, async (client) => {
    await client.query(
      `UPDATE platform.job_attempts SET status = 'failed', finished_at = $4::timestamptz,
         error_type = $5, error_message = $6, retry_after = $7::timestamptz,
         error_metadata = error_metadata || jsonb_build_object(
           'retryable', $8, 'statusCode', $9, 'providerRequestId', $10)
       WHERE job_id = $1::uuid AND attempt_number = $2 AND worker_id = $3 AND status = 'running'`,
      [
        job.jobId,
        job.attemptNumber,
        input.workerId,
        input.now.toISOString(),
        failure.code,
        failure.message.slice(0, 500),
        input.retryAt?.toISOString() ?? null,
        input.retryable,
        failure.statusCode ?? null,
        failure.providerRequestId ?? null,
      ],
    );
    await targetState.fail(client, job, failure, input);
    if (input.retryAt) {
      await client.query(
        `UPDATE platform.jobs SET status = 'pending', run_after = $3::timestamptz,
           locked_at = NULL, locked_by = NULL, updated_at = $4::timestamptz,
           job_metadata = job_metadata || jsonb_build_object(
             'lastErrorCode', $5, 'lastErrorMessage', $6)
         WHERE id = $1::uuid AND locked_by = $2`,
        [
          job.jobId,
          input.workerId,
          input.retryAt.toISOString(),
          input.now.toISOString(),
          failure.code,
          failure.message.slice(0, 500),
        ],
      );
      return "retry_scheduled";
    }
    await client.query(
      `UPDATE platform.jobs SET status = 'dead_lettered', finished_at = $3::timestamptz,
         locked_at = NULL, locked_by = NULL, updated_at = $3::timestamptz,
         job_metadata = job_metadata || jsonb_build_object(
           'lastErrorCode', $4, 'lastErrorMessage', $5)
       WHERE id = $1::uuid AND locked_by = $2`,
      [
        job.jobId,
        input.workerId,
        input.now.toISOString(),
        failure.code,
        failure.message.slice(0, 500),
      ],
    );
    await client.query(
      `INSERT INTO platform.dead_letter_events (
         source_kind, job_id, job_attempt_id, tenant_scope, property_id,
         resource_product, resource_type, resource_id, correlation_id,
         idempotency_key_hash, reason_code, failure_summary, failure_payload
       ) SELECT 'job', $1::uuid, attempt.id, 'property', $2::uuid,
         'pms', 'channex_connection', $2, $3, $4, $5, $6,
         jsonb_build_object('operationType', $7, 'attemptCount', $8, 'replayEligible', $9)
       FROM platform.job_attempts attempt
       WHERE attempt.job_id = $1::uuid AND attempt.attempt_number = $8
       ON CONFLICT DO NOTHING`,
      [
        job.jobId,
        job.propertyId,
        job.correlationId,
        sha256(job.input.idempotencyKey),
        input.retryable ? "max_attempts_exhausted" : "non_retryable_error",
        failure.message.slice(0, 500),
        job.input.operationType,
        job.attemptNumber,
        input.retryable,
      ],
    );
    await finishIdempotency(client, job, input.now, "failed");
    await insertOutcomeAudit(client, job, input.now, "failed", failure.providerRequestId);
    return "dead_lettered";
  });
}

async function finishIdempotency(
  client: Client,
  job: ChannexManagementJob,
  now: Date,
  status: "completed" | "failed",
) {
  await client.query(
    `UPDATE platform.idempotency_keys SET status = $4, completed_at = $5::timestamptz,
       response_status_code = $6, response_resource_product = 'pms',
       response_resource_type = 'channex_operation', response_resource_id = $3
     WHERE operation_scope = 'pms' AND operation = 'channex_management'
       AND key_hash = $1 AND property_id = $2::uuid`,
    [
      sha256(job.input.idempotencyKey),
      job.propertyId,
      job.jobId,
      status,
      now.toISOString(),
      status === "completed" ? 202 : 502,
    ],
  );
}

async function insertOutcomeAudit(
  client: Client,
  job: ChannexManagementJob,
  now: Date,
  outcome: "succeeded" | "failed",
  providerRequestId?: string,
) {
  await client.query(
    `INSERT INTO platform.product_audit_events (
       audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
       target_resource_product, target_resource_type, target_resource_id, job_id,
       correlation_id, redacted_payload, audit_metadata
     ) VALUES ($1, 'pms', $2, $3::timestamptz, 'property', $4::uuid, 'system',
       'pms', 'channex_connection', $4, $5::uuid, $6,
       jsonb_build_object('operationType', $7, 'outcome', $8),
       jsonb_build_object('providerRequestId', $9))
     ON CONFLICT (product, audit_key) DO NOTHING`,
    [
      `channex.management.${outcome}:${job.jobId}`,
      `pms.channex.${job.input.operationType}.${outcome}`,
      now.toISOString(),
      job.propertyId,
      job.jobId,
      job.correlationId,
      job.input.operationType,
      outcome,
      providerRequestId ?? null,
    ],
  );
}

async function transaction<T>(pool: Pool, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function required(value: string) {
  if (!value.trim()) throw new Error("PMS Channex connectionString must not be empty");
  return value;
}
