import type { QueryResultRow } from "pg";

import {
  PMS_INBOX_DELIVERY_JOB_TYPE,
  PMS_INBOX_DELIVERY_QUEUE,
  type PmsInboxDeliveryJob,
} from "../domains/pmsInboxDelivery.js";

export type PmsInboxDeliveryQueryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export async function claimPmsInboxDeliveryJob(
  pool: PmsInboxDeliveryQueryable,
  workerId: string,
): Promise<PmsInboxDeliveryJob | null> {
  const result = await pool.query<PmsInboxDeliveryJob>(
    `UPDATE platform.jobs job
     SET status = 'running', attempts_count = attempts_count + 1,
         locked_at = now(), locked_by = $3, updated_at = now()
     FROM (
       SELECT id
       FROM platform.jobs
       WHERE queue_name = $1 AND job_type = $2
         AND (
           status = 'pending'
           OR (status = 'running' AND locked_at < now() - interval '5 minutes')
         )
         AND run_after <= now() AND attempts_count < max_attempts
       ORDER BY priority DESC, run_after, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     ) candidate
     WHERE job.id = candidate.id
     RETURNING job.id::text AS id, job.locked_by AS "workerId",
       job.property_id::text AS "propertyId", job.resource_id AS "messageId",
       job.attempts_count AS "attemptNumber", job.max_attempts AS "maxAttempts",
       job.correlation_id AS "correlationId"`,
    [PMS_INBOX_DELIVERY_QUEUE, PMS_INBOX_DELIVERY_JOB_TYPE, workerId],
  );
  const job = result.rows[0] ?? null;
  if (!job) return null;

  await pool.query(
    `UPDATE platform.job_attempts
     SET status = 'timed_out', finished_at = now(),
         duration_ms = GREATEST(
           0, floor(extract(epoch FROM (now() - started_at)) * 1000)
         )::integer,
         error_type = 'worker_timeout', error_message = 'Worker lease expired.'
     WHERE job_id = $1::uuid AND attempt_number < $2 AND status = 'running'`,
    [job.id, job.attemptNumber],
  );
  await pool.query(
    `INSERT INTO platform.job_attempts (
       job_id, attempt_number, status, worker_id, started_at
     )
     VALUES ($1::uuid, $2, 'running', $3, now())
     ON CONFLICT (job_id, attempt_number) DO NOTHING`,
    [job.id, job.attemptNumber, workerId],
  );
  return job;
}
