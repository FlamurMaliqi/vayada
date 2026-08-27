import pg, { type QueryResultRow } from "pg";

import { BOOKING_EMAIL_QUEUE, BOOKING_LIFECYCLE_EMAIL_JOB_TYPES } from "./bookingEmails.js";

export type BookingEmailDelivery = {
  send(input: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<void>;
};

type BookingEmailJob = {
  id: string;
  jobKey: string;
  attemptsCount: number;
  workerId: string;
  payload: Record<string, unknown>;
};

type BookingEmailPool = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end?(): Promise<void>;
};

export function createResendBookingEmailDelivery(config: {
  apiKey: string;
  from: string;
  fetch?: typeof fetch;
}): BookingEmailDelivery {
  const request = config.fetch ?? fetch;
  return {
    async send(input) {
      const response = await request("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({
          from: config.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
        }),
      });
      if (!response.ok) {
        throw new Error(`Booking email provider returned HTTP ${response.status}.`);
      }
    },
  };
}

export async function runBookingEmailDeliveryJobs(
  connectionString: string,
  delivery: BookingEmailDelivery,
  options: { workerId?: string; limit?: number; pool?: BookingEmailPool } = {},
): Promise<{ processed: number; failed: number }> {
  const ownsPool = !options.pool;
  const pool = options.pool ?? new pg.Pool({ connectionString, max: 2 });
  let processed = 0;
  let failed = 0;
  try {
    for (let index = 0; index < (options.limit ?? 25); index += 1) {
      const job = await claimBookingEmailJob(
        pool,
        options.workerId ?? `booking-email:${process.pid}`,
      );
      if (!job) break;
      const startedAt = Date.now();
      try {
        await delivery.send(emailInput(job));
        if (await finishBookingEmailJob(pool, job, startedAt)) processed += 1;
      } catch (error) {
        if (await failBookingEmailJob(pool, job, error, startedAt)) failed += 1;
      }
    }
    return { processed, failed };
  } finally {
    if (ownsPool) await pool.end?.();
  }
}

async function claimBookingEmailJob(
  pool: BookingEmailPool,
  workerId: string,
): Promise<BookingEmailJob | null> {
  const result = await pool.query<BookingEmailJob>(
    `UPDATE platform.jobs job
     SET status = 'running',
         attempts_count = attempts_count + 1,
         locked_at = now(),
         locked_by = $3,
         updated_at = now()
     FROM (
       SELECT id
       FROM platform.jobs
       WHERE queue_name = $1
         AND job_type = ANY($2::text[])
         AND (
           status = 'pending'
           OR (status = 'running' AND locked_at < now() - interval '5 minutes')
         )
         AND run_after <= now()
         AND attempts_count < max_attempts
       ORDER BY priority DESC, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     ) candidate
     WHERE job.id = candidate.id
     RETURNING job.id::text AS id,
       job.job_key AS "jobKey",
       job.attempts_count AS "attemptsCount",
       job.locked_by AS "workerId",
       job.payload`,
    [BOOKING_EMAIL_QUEUE, BOOKING_LIFECYCLE_EMAIL_JOB_TYPES, workerId],
  );
  const job = result.rows[0] ?? null;
  if (job) {
    await pool.query(
      `UPDATE platform.job_attempts
       SET status = 'timed_out', finished_at = now(),
           duration_ms = GREATEST(
             0,
             floor(extract(epoch FROM (now() - started_at)) * 1000)
           )::integer,
           error_type = 'worker_timeout', error_message = 'Worker lease expired.'
       WHERE job_id = $1::uuid
         AND attempt_number < $2
         AND status = 'running'`,
      [job.id, job.attemptsCount],
    );
    await pool.query(
      `INSERT INTO platform.job_attempts (
         job_id, attempt_number, status, worker_id, started_at
       )
       VALUES ($1::uuid, $2, 'running', $3, now())
       ON CONFLICT (job_id, attempt_number) DO NOTHING`,
      [job.id, job.attemptsCount, workerId],
    );
  }
  return job;
}

function emailInput(job: BookingEmailJob) {
  const to = requiredText(job.payload["to"], "recipient");
  const subject = requiredText(job.payload["subject"], "subject");
  const text = requiredText(job.payload["text"], "body");
  return { to, subject, text, idempotencyKey: job.jobKey };
}

async function finishBookingEmailJob(
  pool: BookingEmailPool,
  job: BookingEmailJob,
  startedAt: number,
): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `WITH completed_attempt AS (
       UPDATE platform.job_attempts
       SET status = 'succeeded', finished_at = now(), duration_ms = $3
       WHERE job_id = $1::uuid AND attempt_number = $2
         AND status = 'running'
         AND worker_id = $5
       RETURNING id
     ), completed_job AS (
       UPDATE platform.jobs
       SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL,
           updated_at = now()
       WHERE id = $1::uuid
         AND status = 'running'
         AND locked_by = $5
         AND attempts_count = $2
         AND EXISTS (SELECT 1 FROM completed_attempt)
       RETURNING *
     )
     INSERT INTO platform.product_audit_events (
       audit_key, product, action, action_version, occurred_at,
       tenant_scope, property_id, actor_type,
       target_resource_product, target_resource_type, target_resource_id,
       job_id, correlation_id, redacted_payload, private_payload,
       audit_metadata, retention_class, privacy_scope
     )
     SELECT
       $4, 'booking', 'booking.notification.delivery_succeeded', 1, now(),
       job.tenant_scope, job.property_id, 'system',
       job.resource_product, job.resource_type, job.resource_id,
       job.id, job.correlation_id,
       jsonb_build_object('outcome', 'succeeded', 'attemptNumber', $2::integer),
       '{}'::jsonb,
       jsonb_build_object('jobType', job.job_type, 'queueName', job.queue_name),
       'guest_pii', 'confidential'
     FROM completed_job job
     CROSS JOIN completed_attempt
     ON CONFLICT (product, audit_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      job.id,
      job.attemptsCount,
      Date.now() - startedAt,
      deliveryAuditKey(job, "succeeded"),
      job.workerId,
    ],
  );
  return result.rows.length > 0;
}

async function failBookingEmailJob(
  pool: BookingEmailPool,
  job: BookingEmailJob,
  error: unknown,
  startedAt: number,
): Promise<boolean> {
  const message = sanitizedDeliveryError(error);
  const result = await pool.query<{ id: string }>(
    `WITH failed_attempt AS (
       UPDATE platform.job_attempts
       SET status = 'failed', finished_at = now(), duration_ms = $3,
           error_type = 'delivery_error', error_message = $4,
           retry_after = now() + interval '30 seconds'
       WHERE job_id = $1::uuid AND attempt_number = $2
         AND status = 'running'
         AND worker_id = $6
       RETURNING id
     ), failed_job AS (
       UPDATE platform.jobs
       SET status = CASE WHEN attempts_count >= max_attempts THEN 'dead_lettered' ELSE 'pending' END,
           run_after = now() + interval '30 seconds',
           finished_at = CASE WHEN attempts_count >= max_attempts THEN now() ELSE NULL END,
           locked_at = NULL, locked_by = NULL, updated_at = now(),
           job_metadata = COALESCE(job_metadata, '{}'::jsonb)
             || jsonb_build_object('lastError', $4::text)
       WHERE id = $1::uuid
         AND status = 'running'
         AND locked_by = $6
         AND attempts_count = $2
         AND EXISTS (SELECT 1 FROM failed_attempt)
       RETURNING *
     ), dead_letter AS (
       INSERT INTO platform.dead_letter_events (
         source_kind, job_id, job_attempt_id, tenant_scope, property_id,
         resource_product, resource_type, resource_id, correlation_id,
         idempotency_key_hash, reason_code, failure_summary, failure_payload
       )
       SELECT
         'job', job.id, attempt.id, job.tenant_scope, job.property_id,
         job.resource_product, job.resource_type, job.resource_id, job.correlation_id,
         job.idempotency_key_hash, 'booking_email_delivery_exhausted', $4,
         jsonb_build_object('attemptNumber', $2, 'jobType', job.job_type)
       FROM failed_job job
       CROSS JOIN failed_attempt attempt
       WHERE job.status = 'dead_lettered'
       RETURNING id
     )
     INSERT INTO platform.product_audit_events (
       audit_key, product, action, action_version, occurred_at,
       tenant_scope, property_id, actor_type,
       target_resource_product, target_resource_type, target_resource_id,
       job_id, correlation_id, redacted_payload, private_payload,
       audit_metadata, retention_class, privacy_scope
     )
     SELECT
       $5, 'booking', 'booking.notification.delivery_failed', 1, now(),
       job.tenant_scope, job.property_id, 'system',
       job.resource_product, job.resource_type, job.resource_id,
       job.id, job.correlation_id,
       jsonb_build_object('outcome', 'failed', 'attemptNumber', $2::integer),
       jsonb_build_object('error', $4::text),
       jsonb_build_object(
         'jobType', job.job_type,
         'queueName', job.queue_name,
         'deadLettered', job.status = 'dead_lettered'
       ),
       'guest_pii', 'confidential'
     FROM failed_job job
     ON CONFLICT (product, audit_key) DO NOTHING
     RETURNING id::text AS id`,
    [
      job.id,
      job.attemptsCount,
      Date.now() - startedAt,
      message,
      deliveryAuditKey(job, "failed"),
      job.workerId,
    ],
  );
  return result.rows.length > 0;
}

function deliveryAuditKey(job: BookingEmailJob, outcome: "succeeded" | "failed") {
  return `booking.email.delivery:${job.id}:attempt:${job.attemptsCount}:${outcome}`;
}

function sanitizedDeliveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Booking email delivery failed.";
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .slice(0, 500);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Booking email ${label} is missing.`);
  }
  return value.trim();
}
