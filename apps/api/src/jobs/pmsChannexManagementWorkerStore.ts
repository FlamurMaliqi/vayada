import { createHash } from "node:crypto";
import pg from "pg";

import type { PmsChannexManagementCommandInput } from "../domains/pmsChannexManagementCommands.js";
import { PMS_CHANNEX_MANAGEMENT_QUEUE } from "../domains/pmsChannexManagementReadModel.js";
import { GOOGLE_FREE_BOOKING_LINKS_SOURCE_FINGERPRINT_SQL } from "../domains/pmsGoogleFreeBookingLinks.js";
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
  release(error?: Error | boolean): void;
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
    claim: (input) => claim(pool, config.targetState, input),
    heartbeat: (job, input) => heartbeat(pool, job, input),
    succeed: (job, result, input) => complete(pool, config.targetState, job, result, input),
    fail: (job, failure, input) => fail(pool, config.targetState, job, failure, input),
    async close() {
      await pool.end();
    },
  };
}

async function claim(
  pool: Pool,
  targetState: ChannexManagementTargetStatePort,
  input: { workerId: string; now: Date },
): Promise<ChannexManagementJob | null> {
  return transaction(pool, async (client) => {
    await enqueueAutomaticGoogleReconciliation(client, input.now);
    const result = await client.query<JobRow>(
      `SELECT id::text AS "jobId", property_id::text AS "propertyId",
         correlation_id AS "correlationId", status, attempts_count AS "attemptsCount",
         max_attempts AS "maxAttempts", payload
       FROM platform.jobs
       WHERE queue_name = $1 AND (
         (status = 'pending' AND run_after <= now())
         OR (status = 'running' AND locked_at <= now() - ($2::bigint * interval '1 millisecond'))
       )
       ORDER BY priority DESC, run_after, created_at
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [PMS_CHANNEX_MANAGEMENT_QUEUE, LEASE_MS],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.status === "running" && row.attemptsCount > 0) {
      await client.query(
        `UPDATE platform.job_attempts SET status = 'timed_out', finished_at = now(),
           error_type = 'worker_lease_expired', error_message = 'Channex worker lease expired',
           error_metadata = error_metadata || '{"retryable":true}'::jsonb
         WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'`,
        [row.jobId, row.attemptsCount],
      );
    }
    const attemptNumber = row.attemptsCount + 1;
    if (attemptNumber > row.maxAttempts) {
      const expiredJob = toJob(row, row.attemptsCount);
      const failure: ChannexManagementProviderFailure = {
        ok: false,
        code: "provider_unavailable",
        message: "Channex worker lease expired after the final attempt",
      };
      await targetState.fail(client, expiredJob, failure, { now: input.now, retryAt: null });
      await client.query(
        `UPDATE platform.jobs SET status = 'dead_lettered', finished_at = now(),
           locked_at = NULL, locked_by = NULL, updated_at = now(),
           job_metadata = job_metadata || jsonb_build_object(
             'lastErrorCode', $2::text, 'lastErrorMessage', $3::text)
         WHERE id = $1::uuid`,
        [row.jobId, failure.code, failure.message],
      );
      await insertDeadLetter(client, expiredJob, {
        reasonCode: "max_attempts_exhausted",
        failureSummary: failure.message,
        replayEligible: true,
      });
      await finishIdempotency(client, expiredJob, input.now, "failed");
      await insertOutcomeAudit(client, expiredJob, input.now, "failed");
      return null;
    }
    await client.query(
      `UPDATE platform.jobs SET status = 'running', attempts_count = $3,
         locked_at = now(), locked_by = $2, updated_at = now()
       WHERE id = $1::uuid`,
      [row.jobId, input.workerId, attemptNumber],
    );
    await client.query(
      `INSERT INTO platform.job_attempts (
         job_id, attempt_number, status, worker_id, started_at, error_metadata
       ) VALUES ($1::uuid, $2, 'running', $3, now(), '{"provider":"channex"}'::jsonb)`,
      [row.jobId, attemptNumber, input.workerId],
    );
    return toJob(row, attemptNumber);
  });
}

async function enqueueAutomaticGoogleReconciliation(client: Client, now: Date) {
  const candidate = await client.query<{ propertyId: string; stateFingerprint: string }>(
    `SELECT connection.property_id::text AS "propertyId",
       md5(concat_ws('|', source.fingerprint,
         (SELECT string_agg(
           concat_ws(':', mapping.room_type_id::text, mapping.status,
             mapping.external_room_type_id), ',' ORDER BY mapping.room_type_id
         ) FROM pms.channel_room_type_mappings mapping
           WHERE mapping.connection_id = connection.id),
         (SELECT string_agg(
           concat_ws(':', mapping.rate_plan_id::text, mapping.channel, mapping.status,
             mapping.external_rate_plan_id), ',' ORDER BY mapping.rate_plan_id, mapping.channel
         ) FROM pms.channel_rate_plan_mappings mapping
           WHERE mapping.connection_id = connection.id)
       )) AS "stateFingerprint"
     FROM pms.channel_connections connection
     JOIN hotel_catalog.properties property ON property.id = connection.property_id
     LEFT JOIN hotel_catalog.property_locations location ON location.property_id = property.id
     LEFT JOIN distribution.public_hotel_bookability_profiles profile
       ON profile.property_id = property.id
     CROSS JOIN LATERAL (
       SELECT ${GOOGLE_FREE_BOOKING_LINKS_SOURCE_FINGERPRINT_SQL} AS fingerprint
     ) source
     WHERE connection.provider = 'channex'
       AND connection.connection_status IN ('connected', 'degraded')
       AND connection.external_property_id IS NOT NULL
       AND COALESCE(
         connection.connection_metadata #>> '{googleFreeBookingLinks,businessProfileConfirmedAt}',
         ''
       ) <> ''
       AND (
         source.fingerprint IS DISTINCT FROM
           connection.connection_metadata #>> '{googleFreeBookingLinks,sourceFingerprint}'
         OR EXISTS (
           SELECT 1 FROM pms.room_types room
           WHERE room.property_id = property.id AND room.active
             AND NOT EXISTS (
               SELECT 1 FROM pms.channel_room_type_mappings mapping
               WHERE mapping.connection_id = connection.id AND mapping.room_type_id = room.id
                 AND mapping.status = 'active'
             )
         )
         OR EXISTS (
           SELECT 1 FROM pms.rate_plans plan
           JOIN pms.room_types room ON room.id = plan.room_type_id AND room.active
           WHERE plan.property_id = property.id AND plan.active
             AND NOT EXISTS (
               SELECT 1 FROM pms.channel_rate_plan_mappings mapping
               WHERE mapping.connection_id = connection.id AND mapping.rate_plan_id = plan.id
                 AND mapping.channel = 'google_hotel' AND mapping.status = 'active'
             )
         )
         OR EXISTS (
           SELECT 1 FROM pms.channel_rate_plan_mappings mapping
           JOIN pms.rate_plans plan ON plan.id = mapping.rate_plan_id
           JOIN pms.room_types room ON room.id = mapping.room_type_id
           WHERE mapping.connection_id = connection.id
             AND mapping.channel = 'google_hotel' AND mapping.status = 'active'
             AND (NOT plan.active OR NOT room.active)
         )
         OR EXISTS (
           SELECT 1 FROM pms.channel_room_type_mappings mapping
           JOIN pms.room_types room ON room.id = mapping.room_type_id
           WHERE mapping.connection_id = connection.id AND mapping.status = 'active'
             AND NOT room.active
         )
       )
     ORDER BY connection.property_id
     FOR UPDATE OF connection SKIP LOCKED
     LIMIT 1`,
  );
  const row = candidate.rows[0];
  if (!row) return;
  const idempotencyKey = `google-reconcile:${row.stateFingerprint}`;
  const payload: PmsChannexManagementCommandInput = {
    commandId: idempotencyKey,
    idempotencyKey,
    operationType: "setup_google",
    businessProfileConfirmed: false,
    actorUserId: null,
  };
  await client.query(
    `INSERT INTO platform.jobs (
       job_key, queue_name, job_type, status, max_attempts, run_after, tenant_scope,
       property_id, resource_product, resource_type, resource_id, correlation_id,
       idempotency_key_hash, payload, job_metadata
     ) VALUES (
       $1, $2, 'channex.setup_google', 'pending', 5, $3::timestamptz, 'property',
       $4::uuid, 'pms', 'channex_connection', $4, $5, $6, $7::jsonb,
       jsonb_build_object('source', 'automatic-google-reconciliation')
     ) ON CONFLICT (queue_name, job_key) DO NOTHING`,
    [
      `channex.management:setup_google:property:${row.propertyId}:${idempotencyKey}:v1`,
      PMS_CHANNEX_MANAGEMENT_QUEUE,
      now.toISOString(),
      row.propertyId,
      `automatic-google-reconciliation:${row.propertyId}`,
      sha256(idempotencyKey),
      JSON.stringify(payload),
    ],
  );
}

async function heartbeat(pool: Pool, job: ChannexManagementJob, input: { workerId: string }) {
  const client = await pool.connect();
  try {
    await assertLease(client, job, input);
  } finally {
    client.release();
  }
}

async function complete(
  pool: Pool,
  targetState: ChannexManagementTargetStatePort,
  job: ChannexManagementJob,
  result: ChannexManagementProviderSuccess,
  input: { workerId: string; now: Date },
): Promise<void> {
  await transaction(pool, async (client) => {
    await assertLease(client, job, input);
    await targetState.succeed(client, job, result, input.now);
    const attemptUpdate = await client.query(
      `UPDATE platform.job_attempts SET status = 'succeeded', finished_at = $4::timestamptz,
         error_metadata = error_metadata || jsonb_build_object('providerRequestId', $5::text)
       WHERE job_id = $1::uuid AND attempt_number = $2 AND worker_id = $3 AND status = 'running'`,
      [
        job.jobId,
        job.attemptNumber,
        input.workerId,
        input.now.toISOString(),
        result.providerRequestId,
      ],
    );
    assertLeaseUpdated(attemptUpdate);
    const jobUpdate = await client.query(
      `UPDATE platform.jobs SET status = 'succeeded', finished_at = $4::timestamptz,
         locked_at = NULL, locked_by = NULL, updated_at = $4::timestamptz,
         job_metadata = job_metadata || jsonb_build_object('providerRequestId', $5::text)
       WHERE id = $1::uuid AND locked_by = $2 AND attempts_count = $3 AND status = 'running'`,
      [
        job.jobId,
        input.workerId,
        job.attemptNumber,
        input.now.toISOString(),
        result.providerRequestId,
      ],
    );
    assertLeaseUpdated(jobUpdate);
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
    await assertLease(client, job, input);
    const attemptUpdate = await client.query(
      `UPDATE platform.job_attempts SET status = 'failed', finished_at = $4::timestamptz,
         error_type = $5, error_message = $6, retry_after = $7::timestamptz,
         error_metadata = error_metadata || jsonb_build_object(
           'retryable', $8::boolean, 'statusCode', $9::integer,
           'providerRequestId', $10::text)
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
    assertLeaseUpdated(attemptUpdate);
    await targetState.fail(client, job, failure, input);
    if (input.retryAt) {
      const jobUpdate = await client.query(
        `UPDATE platform.jobs SET status = 'pending', run_after = $4::timestamptz,
           locked_at = NULL, locked_by = NULL, updated_at = $5::timestamptz,
           job_metadata = job_metadata || jsonb_build_object(
             'lastErrorCode', $6::text, 'lastErrorMessage', $7::text)
         WHERE id = $1::uuid AND locked_by = $2 AND attempts_count = $3 AND status = 'running'`,
        [
          job.jobId,
          input.workerId,
          job.attemptNumber,
          input.retryAt.toISOString(),
          input.now.toISOString(),
          failure.code,
          failure.message.slice(0, 500),
        ],
      );
      assertLeaseUpdated(jobUpdate);
      return "retry_scheduled";
    }
    const jobUpdate = await client.query(
      `UPDATE platform.jobs SET status = 'dead_lettered', finished_at = $4::timestamptz,
         locked_at = NULL, locked_by = NULL, updated_at = $4::timestamptz,
         job_metadata = job_metadata || jsonb_build_object(
           'lastErrorCode', $5::text, 'lastErrorMessage', $6::text)
       WHERE id = $1::uuid AND locked_by = $2 AND attempts_count = $3 AND status = 'running'`,
      [
        job.jobId,
        input.workerId,
        job.attemptNumber,
        input.now.toISOString(),
        failure.code,
        failure.message.slice(0, 500),
      ],
    );
    assertLeaseUpdated(jobUpdate);
    await insertDeadLetter(client, job, {
      reasonCode: input.retryable ? "max_attempts_exhausted" : "non_retryable_error",
      failureSummary: failure.message.slice(0, 500),
      replayEligible: input.retryable,
    });
    await finishIdempotency(client, job, input.now, "failed");
    await insertOutcomeAudit(client, job, input.now, "failed", failure.providerRequestId);
    return "dead_lettered";
  });
}

async function assertLease(client: Client, job: ChannexManagementJob, input: { workerId: string }) {
  const result = await client.query(
    `UPDATE platform.jobs SET locked_at = now(), updated_at = now()
     WHERE id = $1::uuid AND locked_by = $2 AND status = 'running'
       AND attempts_count = $3
     RETURNING id`,
    [job.jobId, input.workerId, job.attemptNumber],
  );
  if (result.rowCount !== 1) throw new Error(`Lost Channex job lease ${job.jobId}`);
}

async function insertDeadLetter(
  client: Client,
  job: ChannexManagementJob,
  input: { reasonCode: string; failureSummary: string; replayEligible: boolean },
) {
  await client.query(
    `INSERT INTO platform.dead_letter_events (
       source_kind, job_id, job_attempt_id, tenant_scope, property_id,
       resource_product, resource_type, resource_id, correlation_id,
       idempotency_key_hash, reason_code, failure_summary, failure_payload
     ) SELECT 'job', $1::uuid, attempt.id, 'property', $2::uuid,
       'pms', 'channex_connection', $2::text, $3, $4, $5, $6,
       jsonb_build_object('operationType', $7::text, 'attemptCount', $8::integer,
         'replayEligible', $9::boolean)
     FROM platform.job_attempts attempt
     WHERE attempt.job_id = $1::uuid AND attempt.attempt_number = $8
     ON CONFLICT DO NOTHING`,
    [
      job.jobId,
      job.propertyId,
      job.correlationId,
      sha256(job.input.idempotencyKey),
      input.reasonCode,
      input.failureSummary,
      job.input.operationType,
      job.attemptNumber,
      input.replayEligible,
    ],
  );
}

function toJob(row: JobRow, attemptNumber: number): ChannexManagementJob {
  return {
    jobId: row.jobId,
    propertyId: row.propertyId,
    correlationId: row.correlationId,
    attemptNumber,
    maxAttempts: row.maxAttempts,
    input: row.payload,
  };
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
       'pms', 'channex_connection', $4::text, $5::uuid, $6,
       jsonb_build_object('operationType', $7::text, 'outcome', $8::text),
       jsonb_build_object('providerRequestId', $9::text))
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
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError = rollbackError instanceof Error ? rollbackError : new Error("Rollback failed");
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

function assertLeaseUpdated(result: { rowCount?: number | null }) {
  if (result.rowCount !== 1) throw new Error("Channex job lease lost");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function required(value: string) {
  if (!value.trim()) throw new Error("PMS Channex connectionString must not be empty");
  return value;
}
