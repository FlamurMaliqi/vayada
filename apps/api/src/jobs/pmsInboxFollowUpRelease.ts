import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsInboxFollowUpReleaseClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxFollowUpReleasePool = {
  connect(): Promise<PmsInboxFollowUpReleaseClient>;
  end?(): Promise<void>;
};

type FollowUpReleaseJob = {
  id: string;
  attemptsCount: number;
  maxAttempts: number;
  workerId: string;
  propertyId: string | null;
  threadId: string;
  correlationId: string | null;
  idempotencyKeyHash: string | null;
  payloadPropertyId: string | null;
  payloadThreadId: string | null;
  followUpAt: string | null;
  action: string | null;
};

type ThreadRow = {
  attentionState: string;
  followUpAt: Date | string | null;
  followUpJobId: string | null;
  version: string | number;
  isDue: boolean;
};

type ReleaseOutcome = {
  outcome: "released" | "superseded" | "thread_missing" | "not_due";
  threadVersion: number | null;
};

const JOB_TYPE = "pms.inbox.follow-up.release";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function runPmsInboxFollowUpReleaseJobs(
  connectionString: string,
  options: {
    pool?: PmsInboxFollowUpReleasePool;
    workerId?: string;
    limit?: number;
    propertyId?: string;
  } = {},
): Promise<{ processed: number; released: number }> {
  const ownsPool = !options.pool;
  if (ownsPool && !connectionString.trim())
    throw new Error("PMS Inbox follow-up release connectionString must not be empty");
  if (options.propertyId && !UUID.test(options.propertyId))
    throw new Error("PMS Inbox follow-up release propertyId must be a UUID");
  const pool =
    options.pool ?? new pg.Pool({ connectionString, max: 2, application_name: JOB_TYPE });
  let processed = 0;
  let released = 0;
  try {
    for (let index = 0; index < (options.limit ?? 25); index += 1) {
      const job = await claimJob(
        pool,
        options.workerId ?? `${JOB_TYPE}:${process.pid}`,
        options.propertyId ?? null,
      );
      if (!job) break;
      processed += 1;
      if (!validJob(job)) {
        await deadLetterInvalidJob(pool, job);
        continue;
      }
      try {
        const result = await releaseFollowUp(pool, job);
        if (result.outcome === "released") released += 1;
      } catch {
        await failJob(pool, job);
      }
    }
    return { processed, released };
  } finally {
    if (ownsPool) await pool.end?.();
  }
}

export function startPmsInboxFollowUpReleaseWorker(options: {
  connectionString: string;
  pollIntervalMs?: number;
  workerId?: string;
  warn?: (error: unknown, message: string) => void;
}): { close(): Promise<void> } {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 2,
    application_name: JOB_TYPE,
  });
  let active: Promise<void> | undefined;
  let closing = false;
  const runNow = () => {
    if (closing || active) return;
    active = runPmsInboxFollowUpReleaseJobs(options.connectionString, {
      pool,
      workerId: options.workerId,
    })
      .then(() => undefined)
      .catch((error: unknown) => options.warn?.(error, "PMS Inbox follow-up release worker failed"))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(runNow, options.pollIntervalMs ?? 5_000);
  timer.unref();
  runNow();
  return {
    async close() {
      closing = true;
      clearInterval(timer);
      await active;
      await pool.end();
    },
  };
}

async function claimJob(
  pool: PmsInboxFollowUpReleasePool,
  workerId: string,
  propertyId: string | null,
): Promise<FollowUpReleaseJob | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<FollowUpReleaseJob>(
      `UPDATE platform.jobs job
       SET status = 'running', attempts_count = attempts_count + 1,
           max_attempts = CASE
             WHEN job.status = 'running' AND job.attempts_count >= job.max_attempts
               THEN job.max_attempts + 1
             ELSE job.max_attempts
           END,
           locked_at = now(), locked_by = $2, updated_at = now()
       FROM (
         SELECT id
         FROM platform.jobs
         WHERE queue_name = $1 AND job_type = $1
           AND tenant_scope = 'property' AND property_id IS NOT NULL
           AND (
             (status = 'pending' AND run_after <= now() AND attempts_count < max_attempts)
             OR (status = 'running' AND locked_at < now() - interval '5 minutes')
           )
           AND ($3::uuid IS NULL OR property_id = $3::uuid)
         ORDER BY priority DESC, run_after, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       ) candidate
       WHERE job.id = candidate.id
       RETURNING job.id::text AS id, job.attempts_count AS "attemptsCount",
         job.max_attempts AS "maxAttempts", job.locked_by AS "workerId",
         job.property_id::text AS "propertyId", job.resource_id AS "threadId",
         job.correlation_id AS "correlationId",
         job.idempotency_key_hash AS "idempotencyKeyHash",
         job.payload ->> 'propertyId' AS "payloadPropertyId",
         job.payload ->> 'threadId' AS "payloadThreadId",
         job.payload ->> 'followUpAt' AS "followUpAt",
         job.job_metadata ->> 'action' AS action`,
      [JOB_TYPE, workerId, propertyId],
    );
    const job = result.rows[0] ?? null;
    if (!job) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE platform.job_attempts
       SET status = 'timed_out', finished_at = now(),
           duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at)) * 1000))::integer,
           error_type = 'worker_timeout', error_message = 'Worker lease expired.'
       WHERE job_id = $1::uuid AND attempt_number < $2 AND status = 'running'`,
      [job.id, job.attemptsCount],
    );
    await client.query(
      `INSERT INTO platform.job_attempts
         (job_id, attempt_number, status, worker_id, started_at)
       VALUES ($1::uuid, $2, 'running', $3, now())`,
      [job.id, job.attemptsCount, workerId],
    );
    await client.query("COMMIT");
    return job;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function releaseFollowUp(
  pool: PmsInboxFollowUpReleasePool,
  job: FollowUpReleaseJob,
): Promise<ReleaseOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertLease(client, job);
    const thread = await client.query<ThreadRow>(
      `SELECT attention_state AS "attentionState", follow_up_at AS "followUpAt",
              follow_up_job_id::text AS "followUpJobId", version,
              follow_up_at <= now() AS "isDue"
       FROM pms.message_threads
       WHERE property_id = $1::uuid AND id = $2::uuid
       FOR UPDATE`,
      [job.propertyId, job.threadId],
    );
    const row = thread.rows[0];
    let outcome: ReleaseOutcome;
    if (!row) {
      outcome = { outcome: "thread_missing", threadVersion: null };
    } else if (
      row.attentionState !== "follow_up" ||
      row.followUpJobId !== job.id ||
      !sameInstant(row.followUpAt, job.followUpAt)
    ) {
      outcome = { outcome: "superseded", threadVersion: safeVersion(row.version) };
    } else if (!row.isDue) {
      outcome = { outcome: "not_due", threadVersion: safeVersion(row.version) };
    } else {
      const updated = await client.query<{ version: string | number }>(
        `UPDATE pms.message_threads
         SET attention_state = 'needs_attention', follow_up_at = NULL,
             follow_up_by_membership_id = NULL, follow_up_job_id = NULL,
             version = version + 1, updated_at = now()
         WHERE property_id = $1::uuid AND id = $2::uuid
           AND attention_state = 'follow_up' AND follow_up_job_id = $3::uuid
           AND follow_up_at = $4::timestamptz AND version = $5
         RETURNING version`,
        [job.propertyId, job.threadId, job.id, job.followUpAt, safeVersion(row.version)],
      );
      const threadVersion = safeVersion(updated.rows[0]?.version);
      if (threadVersion !== safeVersion(row.version) + 1)
        throw new Error("PMS Inbox follow-up release lost its thread lock");
      await insertReleaseEvidence(client, job, threadVersion);
      outcome = { outcome: "released", threadVersion };
    }
    await insertOutcomeAudit(client, job, outcome);
    if (outcome.outcome === "not_due") await rescheduleJob(client, job, outcome);
    else await finishJob(client, job, outcome);
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function assertLease(
  client: PmsInboxFollowUpReleaseClient,
  job: FollowUpReleaseJob,
): Promise<void> {
  const lease = await client.query(
    `SELECT 1 FROM platform.jobs
     WHERE id = $1::uuid AND status = 'running' AND attempts_count = $2 AND locked_by = $3
     FOR UPDATE`,
    [job.id, job.attemptsCount, job.workerId],
  );
  if (lease.rowCount !== 1) throw new Error("PMS Inbox follow-up release lost its worker lease");
}

async function insertReleaseEvidence(
  client: PmsInboxFollowUpReleaseClient,
  job: FollowUpReleaseJob,
  threadVersion: number,
): Promise<void> {
  const event = await client.query<{ id: string }>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, event_version, occurred_at, event_status,
        tenant_scope, property_id, resource_product, resource_type, resource_id,
        actor_type, correlation_id, causation_id, idempotency_key_hash,
        payload, event_metadata, privacy_scope)
     VALUES
       ('pms', $1, 'pms.inbox.thread.follow_up_released', 1, now(), 'recorded',
        'property', $2::uuid, 'pms', 'message_thread', $3, 'system', $4, $5, $6,
        jsonb_build_object('propertyId', $2::text, 'threadId', $3::text,
                           'attentionState', 'needs_attention', 'followUpAt', NULL,
                           'threadVersion', $7::integer),
        jsonb_build_object('contractVersion', 'native-guest-inbox.v2',
                           'scheduledFollowUpAt', $8::text, 'jobId', $5::text),
        'confidential')
     RETURNING id::text AS id`,
    [
      eventKey(job),
      job.propertyId,
      job.threadId,
      job.correlationId,
      job.id,
      job.idempotencyKeyHash,
      threadVersion,
      job.followUpAt,
    ],
  );
  if (!event.rows[0]?.id) throw new Error("PMS Inbox follow-up release event was not recorded");
}

async function insertOutcomeAudit(
  client: PmsInboxFollowUpReleaseClient,
  job: FollowUpReleaseJob,
  outcome: ReleaseOutcome,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        target_resource_product, target_resource_type, target_resource_id,
        domain_event_id, job_id, correlation_id, causation_id, redacted_payload,
        audit_metadata, retention_class, privacy_scope)
     VALUES
       ($1, 'pms', $2, now(), 'property', $3::uuid, 'system',
        'pms', 'message_thread', $4,
        (SELECT id FROM platform.domain_events WHERE event_key = $5),
        $6::uuid, $7, $6,
        jsonb_strip_nulls(jsonb_build_object(
          'outcome', $8::text, 'threadVersion', $9::integer,
          'scheduledFollowUpAt', $10::text)),
        jsonb_build_object('contractVersion', 'native-guest-inbox.v2',
                           'attemptNumber', $11::integer),
        'guest_pii', 'confidential')`,
    [
      auditKey(job),
      outcome.outcome === "released"
        ? "pms.inbox.thread.follow_up.released"
        : "pms.inbox.thread.follow_up.release_skipped",
      job.propertyId,
      job.threadId,
      eventKey(job),
      job.id,
      job.correlationId,
      outcome.outcome,
      outcome.threadVersion,
      job.followUpAt,
      job.attemptsCount,
    ],
  );
}

async function finishJob(
  client: PmsInboxFollowUpReleaseClient,
  job: FollowUpReleaseJob,
  outcome: ReleaseOutcome,
): Promise<void> {
  const attempt = await client.query(
    `UPDATE platform.job_attempts
     SET status = 'succeeded', finished_at = now(),
         duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at)) * 1000))::integer,
         error_metadata = jsonb_build_object('outcome', $4::text)
     WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'
       AND worker_id = $3`,
    [job.id, job.attemptsCount, job.workerId, outcome.outcome],
  );
  const completed = await client.query(
    `UPDATE platform.jobs
     SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL,
         updated_at = now(),
         job_metadata = job_metadata || jsonb_strip_nulls(jsonb_build_object(
           'outcome', $4::text, 'threadVersion', $5::integer))
     WHERE id = $1::uuid AND status = 'running' AND attempts_count = $2 AND locked_by = $3`,
    [job.id, job.attemptsCount, job.workerId, outcome.outcome, outcome.threadVersion],
  );
  if (attempt.rowCount !== 1 || completed.rowCount !== 1)
    throw new Error("PMS Inbox follow-up release lost its worker lease");
}

async function rescheduleJob(
  client: PmsInboxFollowUpReleaseClient,
  job: FollowUpReleaseJob,
  outcome: ReleaseOutcome,
): Promise<void> {
  const attempt = await client.query(
    `UPDATE platform.job_attempts
     SET status = 'succeeded', finished_at = now(), retry_after = $4::timestamptz,
         duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at)) * 1000))::integer,
         error_metadata = jsonb_build_object('outcome', 'not_due')
     WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'
       AND worker_id = $3`,
    [job.id, job.attemptsCount, job.workerId, job.followUpAt],
  );
  const deferred = await client.query(
    `UPDATE platform.jobs
     SET status = 'pending', run_after = $4::timestamptz,
         max_attempts = GREATEST(max_attempts, attempts_count + 1),
         finished_at = NULL, locked_at = NULL, locked_by = NULL, updated_at = now(),
         job_metadata = job_metadata || jsonb_build_object(
           'outcome', $5::text, 'threadVersion', $6::integer)
     WHERE id = $1::uuid AND status = 'running' AND attempts_count = $2 AND locked_by = $3`,
    [
      job.id,
      job.attemptsCount,
      job.workerId,
      job.followUpAt,
      outcome.outcome,
      outcome.threadVersion,
    ],
  );
  if (attempt.rowCount !== 1 || deferred.rowCount !== 1)
    throw new Error("PMS Inbox follow-up release lost its worker lease");
}

async function deadLetterInvalidJob(
  pool: PmsInboxFollowUpReleasePool,
  job: FollowUpReleaseJob,
): Promise<void> {
  await finalizeFailure(pool, job, "invalid_job", true);
}

async function failJob(pool: PmsInboxFollowUpReleasePool, job: FollowUpReleaseJob): Promise<void> {
  await finalizeFailure(pool, job, "processing_error", job.attemptsCount >= job.maxAttempts);
}

async function finalizeFailure(
  pool: PmsInboxFollowUpReleasePool,
  job: FollowUpReleaseJob,
  reasonCode: "invalid_job" | "processing_error",
  terminal: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const attempt = await client.query<{ id: string }>(
      `UPDATE platform.job_attempts
       SET status = 'failed', finished_at = now(), error_type = $4,
           error_message = 'Inbox follow-up release could not be completed.',
           retry_after = CASE WHEN $5::boolean THEN NULL ELSE now() + interval '30 seconds' END
       WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'
         AND worker_id = $3
       RETURNING id::text AS id`,
      [job.id, job.attemptsCount, job.workerId, reasonCode, terminal],
    );
    const failed = await client.query(
      `UPDATE platform.jobs
       SET status = CASE WHEN $4::boolean THEN 'dead_lettered' ELSE 'pending' END,
           run_after = CASE WHEN $4::boolean THEN run_after ELSE now() + interval '30 seconds' END,
           finished_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
           locked_at = NULL, locked_by = NULL, updated_at = now(),
           job_metadata = job_metadata || jsonb_build_object('failureCode', $5::text)
       WHERE id = $1::uuid AND status = 'running' AND attempts_count = $2 AND locked_by = $3
       RETURNING id`,
      [job.id, job.attemptsCount, job.workerId, terminal, reasonCode],
    );
    const attemptId = attempt.rows[0]?.id;
    if (!attemptId || failed.rowCount !== 1)
      throw new Error("PMS Inbox follow-up release lost its worker lease");
    if (terminal) await insertDeadLetter(client, job, attemptId, reasonCode);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertDeadLetter(
  client: PmsInboxFollowUpReleaseClient,
  job: FollowUpReleaseJob,
  attemptId: string,
  reasonCode: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.dead_letter_events
       (source_kind, job_id, job_attempt_id, tenant_scope, property_id,
        resource_product, resource_type, resource_id, correlation_id,
        idempotency_key_hash, reason_code, failure_summary, failure_payload)
     VALUES
       ('job', $1::uuid, $2::uuid, 'property', $3::uuid,
        'pms', 'message_thread', $4, $5, $6, $7,
        'Inbox follow-up release could not be completed.',
        jsonb_build_object('attemptNumber', $8::integer, 'replayEligible', TRUE))`,
    [
      job.id,
      attemptId,
      job.propertyId,
      job.threadId,
      job.correlationId,
      job.idempotencyKeyHash,
      reasonCode,
      job.attemptsCount,
    ],
  );
}

function validJob(job: FollowUpReleaseJob): boolean {
  return Boolean(
    job.propertyId &&
    UUID.test(job.propertyId) &&
    UUID.test(job.threadId) &&
    job.payloadPropertyId === job.propertyId &&
    job.payloadThreadId === job.threadId &&
    job.action === "release_follow_up" &&
    validInstant(job.followUpAt),
  );
}

function sameInstant(left: Date | string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return new Date(left).getTime() === new Date(right).getTime();
}

function validInstant(value: string | null): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function safeVersion(value: string | number | undefined): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("PMS Inbox follow-up release thread version is invalid");
  return version;
}

function eventKey(job: FollowUpReleaseJob): string {
  return `${JOB_TYPE}:${job.id}:attempt:${job.attemptsCount}:released`;
}

function auditKey(job: FollowUpReleaseJob): string {
  return `${JOB_TYPE}:${job.id}:attempt:${job.attemptsCount}`;
}
