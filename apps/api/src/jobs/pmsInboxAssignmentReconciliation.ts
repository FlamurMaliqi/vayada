import pg, { type QueryResult, type QueryResultRow } from "pg";

export type PmsInboxAssignmentReconciliationClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
  release(): void;
};

export type PmsInboxAssignmentReconciliationPool = {
  connect(): Promise<PmsInboxAssignmentReconciliationClient>;
  end?(): Promise<void>;
};

type ReconciliationJob = {
  id: string;
  attemptsCount: number;
  maxAttempts: number;
  workerId: string;
  organizationId: string | null;
  membershipId: string;
  correlationId: string | null;
  reason: string | null;
};

type InvalidAssignment = {
  threadId: string;
  propertyId: string;
  version: string | number;
};

class OrganizationScopeMismatch extends Error {}

const QUEUE = "pms-inbox";
const JOB_TYPE = "pms.inbox.assignment.reconcile";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function runPmsInboxAssignmentReconciliationJobs(
  connectionString: string,
  options: {
    pool?: PmsInboxAssignmentReconciliationPool;
    workerId?: string;
    limit?: number;
    organizationId?: string;
  } = {},
): Promise<{ processed: number; cleared: number }> {
  const ownsPool = !options.pool;
  if (ownsPool && !connectionString.trim())
    throw new Error("PMS Inbox assignment reconciliation connectionString must not be empty");
  if (options.organizationId && !UUID.test(options.organizationId))
    throw new Error("PMS Inbox assignment reconciliation organizationId must be a UUID");
  const pool =
    options.pool ?? new pg.Pool({ connectionString, max: 2, application_name: JOB_TYPE });
  let processed = 0;
  let cleared = 0;
  try {
    await deadLetterStaleFinalAttempts(pool, options.organizationId ?? null);
    await discoverInvalidAssignments(pool, options.organizationId ?? null);
    for (let index = 0; index < (options.limit ?? 25); index += 1) {
      const job = await claimJob(
        pool,
        options.workerId ?? `${JOB_TYPE}:${process.pid}`,
        options.organizationId ?? null,
      );
      if (!job) break;
      processed += 1;
      if (!validJob(job)) {
        await deadLetterJob(pool, job, "invalid_job");
        continue;
      }
      try {
        cleared += await reconcileJob(pool, job);
      } catch (error) {
        if (error instanceof OrganizationScopeMismatch)
          await deadLetterJob(pool, job, "organization_scope_mismatch");
        else await failJob(pool, job);
      }
    }
    return { processed, cleared };
  } finally {
    if (ownsPool) await pool.end?.();
  }
}

export function startPmsInboxAssignmentReconciliationWorker(options: {
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
    active = runPmsInboxAssignmentReconciliationJobs(options.connectionString, {
      pool,
      workerId: options.workerId,
    })
      .then(() => undefined)
      .catch((error: unknown) =>
        options.warn?.(error, "PMS Inbox assignment reconciliation worker failed"),
      )
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

async function discoverInvalidAssignments(
  pool: PmsInboxAssignmentReconciliationPool,
  organizationId: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `WITH invalid_memberships AS (
         SELECT membership.id, membership.organization_id,
                CASE WHEN membership.status <> 'active' OR organization.status <> 'active'
                           OR staff.status <> 'active'
                     THEN 'membership_suspended'
                     ELSE 'property_access_removed'
                END AS reason,
                md5(string_agg(thread.id::text || ':' || thread.version::text,
                               ',' ORDER BY thread.id)) AS state_key
         FROM pms.message_threads thread
         JOIN identity.organization_memberships membership
           ON membership.id = thread.assigned_to_membership_id
         JOIN identity.organizations organization ON organization.id = membership.organization_id
         JOIN identity.users staff ON staff.id = membership.user_id
         WHERE thread.assigned_to_membership_id IS NOT NULL
           AND ($1::uuid IS NULL OR membership.organization_id = $1::uuid)
           AND NOT EXISTS (
             SELECT 1
             FROM identity.organization_resource_links resource
             WHERE membership.status = 'active' AND organization.status = 'active'
               AND staff.status = 'active'
               AND resource.organization_id = membership.organization_id
               AND resource.product = 'pms' AND resource.resource_type = 'pms_property'
               AND resource.resource_id = thread.property_id::text
               AND resource.relationship IN ('owner', 'operator', 'front_desk')
               AND resource.status = 'active'
               AND (membership.property_access_mode = 'all' OR EXISTS (
                 SELECT 1 FROM identity.membership_property_assignments assignment
                 WHERE assignment.membership_id = membership.id
                   AND assignment.property_id = thread.property_id
               ))
           )
           AND NOT EXISTS (
             SELECT 1 FROM platform.jobs pending
             WHERE pending.queue_name = $2 AND pending.job_type = $3
               AND pending.organization_id = membership.organization_id
               AND pending.resource_id = membership.id::text
               AND pending.status IN ('pending', 'running')
           )
         GROUP BY membership.id, membership.organization_id, membership.status,
                  organization.status, staff.status
       ), scheduled AS (
         INSERT INTO platform.jobs
         (job_key, queue_name, job_type, max_attempts, tenant_scope, organization_id,
          resource_product, resource_type, resource_id, payload, job_metadata)
       SELECT $3 || ':sweep:' || invalid.id::text || ':' || invalid.state_key,
              $2, $3, 5, 'organization', invalid.organization_id,
              'pms', 'inbox_assignment', invalid.id::text,
              jsonb_build_object('membershipId', invalid.id::text),
              jsonb_build_object('reason', invalid.reason, 'discovery', 'safety_sweep')
       FROM invalid_memberships invalid
       ON CONFLICT (queue_name, job_key) DO UPDATE
       SET status = 'pending',
           max_attempts = GREATEST(platform.jobs.max_attempts,
                                   platform.jobs.attempts_count + 5),
           run_after = now(), locked_at = NULL, locked_by = NULL, finished_at = NULL,
           payload = EXCLUDED.payload, job_metadata = EXCLUDED.job_metadata,
           updated_at = now()
       WHERE platform.jobs.status = 'succeeded'
          OR (platform.jobs.status = 'dead_lettered'
              AND platform.jobs.job_key LIKE $3 || ':sweep:%'
              AND platform.jobs.job_metadata ->> 'failureCode' = 'worker_lease_expired')
       RETURNING id
       )
       UPDATE platform.dead_letter_events dead
       SET recovery_status = 'requeued', requeued_job_id = scheduled.id
       FROM scheduled
       WHERE dead.job_id = scheduled.id AND dead.recovery_status = 'open'
         AND dead.reason_code = 'worker_lease_expired'`,
      [organizationId, QUEUE, JOB_TYPE],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function deadLetterStaleFinalAttempts(
  pool: PmsInboxAssignmentReconciliationPool,
  organizationId: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stale = await client.query<ReconciliationJob>(
      `SELECT id::text AS id, attempts_count AS "attemptsCount",
              max_attempts AS "maxAttempts", locked_by AS "workerId",
              organization_id::text AS "organizationId", resource_id AS "membershipId",
              correlation_id AS "correlationId", job_metadata ->> 'reason' AS reason
       FROM platform.jobs
       WHERE queue_name = $1 AND job_type = $2 AND tenant_scope = 'organization'
         AND organization_id IS NOT NULL AND status = 'running'
         AND locked_at < now() - interval '5 minutes'
         AND attempts_count >= max_attempts
         AND ($3::uuid IS NULL OR organization_id = $3::uuid)
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 25`,
      [QUEUE, JOB_TYPE, organizationId],
    );
    for (const job of stale.rows) {
      const attempt = await client.query<{ id: string }>(
        `UPDATE platform.job_attempts
         SET status = 'timed_out', finished_at = now(),
             duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at)) * 1000))::integer,
             error_type = 'worker_timeout', error_message = 'Worker lease expired.'
         WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'
         RETURNING id::text AS id`,
        [job.id, job.attemptsCount],
      );
      const failed = await client.query(
        `UPDATE platform.jobs
         SET status = 'dead_lettered', finished_at = now(), locked_at = NULL, locked_by = NULL,
             updated_at = now(),
             job_metadata = job_metadata || '{"failureCode":"worker_lease_expired"}'::jsonb
         WHERE id = $1::uuid AND status = 'running' AND attempts_count = $2
           AND locked_by = $3
         RETURNING id`,
        [job.id, job.attemptsCount, job.workerId],
      );
      if (failed.rowCount !== 1)
        throw new Error("PMS Inbox assignment reconciliation lost its worker lease");
      await insertDeadLetter(client, job, attempt.rows[0]?.id ?? null, "worker_lease_expired");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function claimJob(
  pool: PmsInboxAssignmentReconciliationPool,
  workerId: string,
  organizationId: string | null,
): Promise<ReconciliationJob | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ReconciliationJob>(
      `UPDATE platform.jobs job
       SET status = 'running', attempts_count = attempts_count + 1,
           locked_at = now(), locked_by = $3, updated_at = now()
       FROM (
         SELECT id
         FROM platform.jobs
         WHERE queue_name = $1 AND job_type = $2
           AND tenant_scope = 'organization' AND organization_id IS NOT NULL
           AND (status = 'pending'
                OR (status = 'running' AND locked_at < now() - interval '5 minutes'))
           AND ($4::uuid IS NULL OR organization_id = $4::uuid)
           AND run_after <= now() AND attempts_count < max_attempts
         ORDER BY priority DESC, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       ) candidate
       WHERE job.id = candidate.id
       RETURNING job.id::text AS id, job.attempts_count AS "attemptsCount",
         job.max_attempts AS "maxAttempts", job.locked_by AS "workerId",
         job.organization_id::text AS "organizationId",
         job.resource_id AS "membershipId", job.correlation_id AS "correlationId",
         job.job_metadata ->> 'reason' AS reason`,
      [QUEUE, JOB_TYPE, workerId, organizationId],
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

async function reconcileJob(
  pool: PmsInboxAssignmentReconciliationPool,
  job: ReconciliationJob,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lease = await client.query(
      `SELECT 1 FROM platform.jobs
       WHERE id = $1::uuid AND status = 'running' AND attempts_count = $2 AND locked_by = $3
       FOR UPDATE`,
      [job.id, job.attemptsCount, job.workerId],
    );
    if (lease.rowCount !== 1)
      throw new Error("PMS Inbox assignment reconciliation lost its worker lease");
    const membership = await client.query(
      `SELECT 1
       FROM identity.organization_memberships membership
       JOIN identity.organizations organization ON organization.id = membership.organization_id
       JOIN identity.users staff ON staff.id = membership.user_id
       WHERE membership.id = $1::uuid AND membership.organization_id = $2::uuid
       FOR SHARE OF membership, organization, staff`,
      [job.membershipId, job.organizationId],
    );
    if (membership.rowCount !== 1) throw new OrganizationScopeMismatch();
    const assignments = await findInvalidAssignments(client, job);
    for (const assignment of assignments) await clearAssignment(client, job, assignment);
    await finishJob(client, job, assignments.length);
    await client.query("COMMIT");
    return assignments.length;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function findInvalidAssignments(
  client: PmsInboxAssignmentReconciliationClient,
  job: ReconciliationJob,
): Promise<InvalidAssignment[]> {
  const result = await client.query<InvalidAssignment>(
    `SELECT thread.id::text AS "threadId", thread.property_id::text AS "propertyId",
            thread.version
     FROM pms.message_threads thread
     WHERE thread.assigned_to_membership_id = $1::uuid
       AND NOT EXISTS (
         SELECT 1
         FROM identity.organization_memberships membership
         JOIN identity.organizations organization
           ON organization.id = membership.organization_id AND organization.status = 'active'
         JOIN identity.users staff
           ON staff.id = membership.user_id AND staff.status = 'active'
         JOIN identity.organization_resource_links resource
           ON resource.organization_id = membership.organization_id
          AND resource.product = 'pms' AND resource.resource_type = 'pms_property'
          AND resource.resource_id = thread.property_id::text
          AND resource.relationship IN ('owner', 'operator', 'front_desk')
          AND resource.status = 'active'
         WHERE membership.id = thread.assigned_to_membership_id
           AND membership.organization_id = $2::uuid AND membership.status = 'active'
           AND (membership.property_access_mode = 'all' OR EXISTS (
             SELECT 1 FROM identity.membership_property_assignments assignment
             WHERE assignment.membership_id = membership.id
               AND assignment.property_id = thread.property_id
           ))
       )
     ORDER BY thread.property_id, thread.id
     FOR UPDATE OF thread`,
    [job.membershipId, job.organizationId],
  );
  return result.rows;
}

async function clearAssignment(
  client: PmsInboxAssignmentReconciliationClient,
  job: ReconciliationJob,
  assignment: InvalidAssignment,
): Promise<void> {
  const previousVersion = safeVersion(assignment.version);
  const updated = await client.query<{ version: string | number }>(
    `UPDATE pms.message_threads
     SET assigned_to_membership_id = NULL, version = version + 1, updated_at = now()
     WHERE property_id = $1::uuid AND id = $2::uuid
       AND assigned_to_membership_id = $3::uuid AND version = $4
     RETURNING version`,
    [assignment.propertyId, assignment.threadId, job.membershipId, previousVersion],
  );
  const threadVersion = safeVersion(updated.rows[0]?.version);
  if (threadVersion !== previousVersion + 1)
    throw new Error("PMS Inbox assignment reconciliation lost its thread lock");
  const event = await client.query<{ id: string }>(
    `INSERT INTO platform.domain_events
       (source_system, event_key, event_type, event_version, occurred_at, event_status,
        tenant_scope, property_id, resource_product, resource_type, resource_id,
        actor_type, correlation_id, causation_id, payload, event_metadata, privacy_scope)
     VALUES
       ('pms', $1, 'pms.inbox.thread.assignment_reconciled', 1, now(), 'recorded',
        'property', $2::uuid, 'pms', 'message_thread', $3, 'system', $4, $5,
        jsonb_build_object('propertyId', $2::text, 'threadId', $3::text,
                           'assigneeMembershipId', NULL, 'threadVersion', $6::integer),
        jsonb_build_object('contractVersion', 'native-guest-inbox.v2',
                           'previousAssigneeMembershipId', $7::text,
                           'reason', $8::text, 'jobId', $5::text),
        'confidential')
     RETURNING id::text AS id`,
    [
      `${JOB_TYPE}:${job.id}:attempt:${job.attemptsCount}:${assignment.threadId}`,
      assignment.propertyId,
      assignment.threadId,
      job.correlationId,
      job.id,
      threadVersion,
      job.membershipId,
      job.reason,
    ],
  );
  const eventId = event.rows[0]?.id;
  if (!eventId) throw new Error("PMS Inbox assignment reconciliation event was not recorded");
  await client.query(
    `INSERT INTO platform.product_audit_events
       (audit_key, product, action, occurred_at, tenant_scope, property_id, actor_type,
        target_resource_product, target_resource_type, target_resource_id,
        domain_event_id, correlation_id, causation_id, redacted_payload,
        private_payload, audit_metadata, retention_class, privacy_scope)
     VALUES
       ($1, 'pms', 'pms.inbox.thread.assignment.reconciled', now(), 'property', $2::uuid,
        'system', 'pms', 'message_thread', $3, $4::uuid, $5, $6,
        jsonb_build_object('outcome', 'cleared', 'threadVersion', $7::integer),
        jsonb_build_object('previousAssigneeMembershipId', $8::text),
        jsonb_build_object('contractVersion', 'native-guest-inbox.v2',
                           'reason', $9::text, 'jobId', $6::text),
        'guest_pii', 'confidential')`,
    [
      `${JOB_TYPE}:${job.id}:attempt:${job.attemptsCount}:${assignment.threadId}`,
      assignment.propertyId,
      assignment.threadId,
      eventId,
      job.correlationId,
      job.id,
      threadVersion,
      job.membershipId,
      job.reason,
    ],
  );
}

async function finishJob(
  client: PmsInboxAssignmentReconciliationClient,
  job: ReconciliationJob,
  cleared: number,
): Promise<void> {
  const attempt = await client.query(
    `UPDATE platform.job_attempts
     SET status = 'succeeded', finished_at = now(),
         duration_ms = GREATEST(0, floor(extract(epoch FROM (now() - started_at)) * 1000))::integer
     WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'
       AND worker_id = $3`,
    [job.id, job.attemptsCount, job.workerId],
  );
  const completed = await client.query(
    `UPDATE platform.jobs
     SET status = 'succeeded', finished_at = now(), locked_at = NULL, locked_by = NULL,
         updated_at = now(), job_metadata = job_metadata || jsonb_build_object('cleared', $4::integer)
     WHERE id = $1::uuid AND status = 'running' AND attempts_count = $2 AND locked_by = $3`,
    [job.id, job.attemptsCount, job.workerId, cleared],
  );
  if (attempt.rowCount !== 1 || completed.rowCount !== 1)
    throw new Error("PMS Inbox assignment reconciliation lost its worker lease");
}

async function deadLetterJob(
  pool: PmsInboxAssignmentReconciliationPool,
  job: ReconciliationJob,
  reasonCode: "invalid_job" | "organization_scope_mismatch",
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const attempt = await client.query<{ id: string }>(
      `UPDATE platform.job_attempts
       SET status = 'failed', finished_at = now(), error_type = $4,
           error_message = 'Inbox assignment reconciliation job is invalid.'
       WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'
         AND worker_id = $3
       RETURNING id::text AS id`,
      [job.id, job.attemptsCount, job.workerId, reasonCode],
    );
    const failed = await client.query(
      `UPDATE platform.jobs
       SET status = 'dead_lettered', finished_at = now(), locked_at = NULL, locked_by = NULL,
           updated_at = now(), job_metadata = job_metadata || jsonb_build_object('failureCode', $4::text)
       WHERE id = $1::uuid AND status = 'running' AND attempts_count = $2 AND locked_by = $3
       RETURNING id`,
      [job.id, job.attemptsCount, job.workerId, reasonCode],
    );
    const attemptId = attempt.rows[0]?.id;
    if (!attemptId || failed.rowCount !== 1)
      throw new Error("PMS Inbox assignment reconciliation lost its worker lease");
    await insertDeadLetter(client, job, attemptId, reasonCode);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function failJob(
  pool: PmsInboxAssignmentReconciliationPool,
  job: ReconciliationJob,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const terminal = job.attemptsCount >= job.maxAttempts;
    const attempt = await client.query<{ id: string }>(
      `UPDATE platform.job_attempts
       SET status = 'failed', finished_at = now(), error_type = 'processing_error',
           error_message = 'Inbox assignment reconciliation failed.',
           retry_after = CASE WHEN $4::boolean THEN NULL ELSE now() + interval '30 seconds' END
       WHERE job_id = $1::uuid AND attempt_number = $2 AND status = 'running'
         AND worker_id = $3
       RETURNING id::text AS id`,
      [job.id, job.attemptsCount, job.workerId, terminal],
    );
    const failed = await client.query(
      `UPDATE platform.jobs
       SET status = CASE WHEN $4::boolean THEN 'dead_lettered' ELSE 'pending' END,
           run_after = CASE WHEN $4::boolean THEN run_after ELSE now() + interval '30 seconds' END,
           finished_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
           locked_at = NULL, locked_by = NULL, updated_at = now(),
           job_metadata = job_metadata || '{"failureCode":"processing_error"}'::jsonb
       WHERE id = $1::uuid AND status = 'running' AND attempts_count = $2 AND locked_by = $3
       RETURNING id`,
      [job.id, job.attemptsCount, job.workerId, terminal],
    );
    const attemptId = attempt.rows[0]?.id;
    if (!attemptId || failed.rowCount !== 1)
      throw new Error("PMS Inbox assignment reconciliation lost its worker lease");
    if (terminal) await insertDeadLetter(client, job, attemptId, "processing_error");
    await client.query("COMMIT");
  } catch (failureError) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw failureError;
  } finally {
    client.release();
  }
}

async function insertDeadLetter(
  client: PmsInboxAssignmentReconciliationClient,
  job: ReconciliationJob,
  attemptId: string | null,
  reasonCode: string,
): Promise<void> {
  await client.query(
    `INSERT INTO platform.dead_letter_events
       (source_kind, job_id, job_attempt_id, tenant_scope, organization_id,
        resource_product, resource_type, resource_id, correlation_id,
        reason_code, failure_summary, failure_payload)
     VALUES
       ('job', $1::uuid, $2::uuid, 'organization', $3::uuid,
        'pms', 'inbox_assignment', $4, $5, $6,
        'Inbox assignment reconciliation could not be completed.',
        jsonb_build_object('attemptNumber', $7::integer, 'replayEligible', TRUE))`,
    [
      job.id,
      attemptId,
      job.organizationId,
      job.membershipId,
      job.correlationId,
      reasonCode,
      job.attemptsCount,
    ],
  );
}

function validJob(job: ReconciliationJob): boolean {
  return Boolean(
    job.organizationId &&
    UUID.test(job.organizationId) &&
    UUID.test(job.membershipId) &&
    validReason(job.reason),
  );
}

function validReason(
  value: string | null,
): value is "membership_removed" | "membership_suspended" | "property_access_removed" {
  return (
    value === "membership_removed" ||
    value === "membership_suspended" ||
    value === "property_access_removed"
  );
}

function safeVersion(value: string | number | undefined): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("PMS Inbox assignment reconciliation thread version is invalid");
  return version;
}
