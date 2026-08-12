import pg, { type QueryResultRow } from "pg";

import {
  BOOKING_EMAIL_QUEUE,
  BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE,
  BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE,
} from "./bookingEmails.js";

export type BookingEmailDelivery = {
  send(input: { to: string; subject: string; text: string; idempotencyKey: string }): Promise<void>;
};

type BookingEmailJob = {
  id: string;
  jobKey: string;
  attemptsCount: number;
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
        await finishBookingEmailJob(pool, job, startedAt);
        processed += 1;
      } catch (error) {
        await failBookingEmailJob(pool, job, error, startedAt);
        failed += 1;
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
       job.payload`,
    [
      BOOKING_EMAIL_QUEUE,
      [BOOKING_RESERVED_PENDING_PAYMENT_EMAIL_JOB_TYPE, BOOKING_FINAL_CONFIRMATION_EMAIL_JOB_TYPE],
      workerId,
    ],
  );
  const job = result.rows[0] ?? null;
  if (job) {
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
): Promise<void> {
  await pool.query(
    `UPDATE platform.job_attempts
     SET status = 'succeeded', finished_at = now(), duration_ms = $3
     WHERE job_id = $1::uuid AND attempt_number = $2`,
    [job.id, job.attemptsCount, Date.now() - startedAt],
  );
  await pool.query(
    `UPDATE platform.jobs
     SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL,
         updated_at = now()
     WHERE id = $1::uuid`,
    [job.id],
  );
}

async function failBookingEmailJob(
  pool: BookingEmailPool,
  job: BookingEmailJob,
  error: unknown,
  startedAt: number,
): Promise<void> {
  const message = error instanceof Error ? error.message : "Booking email delivery failed.";
  await pool.query(
    `UPDATE platform.job_attempts
     SET status = 'failed', finished_at = now(), duration_ms = $3,
         error_type = 'delivery_error', error_message = $4,
         retry_after = now() + interval '30 seconds'
     WHERE job_id = $1::uuid AND attempt_number = $2`,
    [job.id, job.attemptsCount, Date.now() - startedAt, message],
  );
  await pool.query(
    `UPDATE platform.jobs
     SET status = CASE WHEN attempts_count >= max_attempts THEN 'dead_lettered' ELSE 'pending' END,
         run_after = now() + interval '30 seconds',
         finished_at = CASE WHEN attempts_count >= max_attempts THEN now() ELSE NULL END,
         locked_at = NULL, locked_by = NULL, updated_at = now(),
         job_metadata = COALESCE(job_metadata, '{}'::jsonb)
           || jsonb_build_object('lastError', $2::text)
     WHERE id = $1::uuid`,
    [job.id, message],
  );
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Booking email ${label} is missing.`);
  }
  return value.trim();
}
