import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runPmsInboxFollowUpReleaseJobs } from "./pmsInboxFollowUpRelease.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13736100-0000-4000-8000-000000000001";
const FOREIGN_PROPERTY = "13736100-0000-4000-8000-000000000002";
const THREAD = "13736100-0000-4000-8000-000000000003";
const JOB = "13736100-0000-4000-8000-000000000004";
const SECOND_THREAD = "13736100-0000-4000-8000-000000000005";
const SECOND_JOB = "13736100-0000-4000-8000-000000000006";
const MEMBERSHIP = "13736100-0000-4000-8000-000000000007";
const FOLLOW_UP_AT = "2026-09-03T01:00:00.000Z";

describe.skipIf(!URL)("PMS Inbox follow-up release worker", () => {
  const admin = new pg.Client({ connectionString: URL });

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seedProperty();
    await seedFollowUp({ jobId: JOB, threadId: THREAD, sourceThreadId: "due-follow-up" });
  });

  afterAll(async () => {
    await cleanup();
    await admin.end();
  });

  it("idempotently releases the exact due follow-up and records system evidence", async () => {
    await expect(run()).resolves.toEqual({ processed: 1, released: 1 });
    await expect(run()).resolves.toEqual({ processed: 0, released: 0 });

    await expect(thread(THREAD)).resolves.toEqual({
      attentionState: "needs_attention",
      followUpAt: null,
      followUpByMembershipId: null,
      followUpJobId: null,
      version: "5",
    });
    await expect(job(JOB)).resolves.toMatchObject({
      status: "succeeded",
      attemptsCount: 1,
      maxAttempts: 5,
      lockedAt: null,
      lockedBy: null,
      jobMetadata: {
        action: "release_follow_up",
        outcome: "released",
        threadVersion: 5,
      },
    });
    const evidence = await admin.query(
      `SELECT event.event_type AS "eventType", event.actor_type AS "eventActor",
              event.payload AS "eventPayload", audit.action, audit.job_id::text AS "auditJobId",
              audit.redacted_payload AS "auditPayload"
       FROM platform.domain_events event
       JOIN platform.product_audit_events audit ON audit.domain_event_id = event.id
       WHERE event.event_key = $1`,
      [`pms.inbox.follow-up.release:${JOB}:attempt:1:released`],
    );
    expect(evidence.rows).toEqual([
      {
        eventType: "pms.inbox.thread.follow_up_released",
        eventActor: "system",
        eventPayload: {
          propertyId: PROPERTY,
          threadId: THREAD,
          attentionState: "needs_attention",
          followUpAt: null,
          threadVersion: 5,
        },
        action: "pms.inbox.thread.follow_up.released",
        auditJobId: JOB,
        auditPayload: {
          outcome: "released",
          threadVersion: 5,
          scheduledFollowUpAt: FOLLOW_UP_AT,
        },
      },
    ]);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id = $1::uuid",
          [PROPERTY],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("succeeds as a no-op when the scheduled job was superseded", async () => {
    await admin.query(
      `UPDATE pms.message_threads
       SET attention_state = 'needs_attention', follow_up_at = NULL,
           follow_up_by_membership_id = NULL, follow_up_job_id = NULL
       WHERE id = $1::uuid`,
      [THREAD],
    );

    await expect(run()).resolves.toEqual({ processed: 1, released: 0 });
    await expect(thread(THREAD)).resolves.toMatchObject({
      attentionState: "needs_attention",
      version: "4",
    });
    await expect(job(JOB)).resolves.toMatchObject({
      status: "succeeded",
      jobMetadata: { action: "release_follow_up", outcome: "superseded", threadVersion: 4 },
    });
    await expect(
      admin.query(
        `SELECT action, domain_event_id AS "domainEventId", redacted_payload AS payload
         FROM platform.product_audit_events WHERE job_id = $1::uuid`,
        [JOB],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          action: "pms.inbox.thread.follow_up.release_skipped",
          domainEventId: null,
          payload: { outcome: "superseded", threadVersion: 4 },
        },
      ],
    });
  });

  it("does not claim a follow-up before its due time", async () => {
    await admin.query(
      "UPDATE platform.jobs SET run_after = now() + interval '1 day' WHERE id = $1",
      [JOB],
    );

    await expect(run()).resolves.toEqual({ processed: 0, released: 0 });
    await expect(thread(THREAD)).resolves.toMatchObject({
      attentionState: "follow_up",
      followUpJobId: JOB,
      version: "4",
    });
    await expect(job(JOB)).resolves.toMatchObject({ status: "pending", attemptsCount: 0 });
  });

  it("reschedules an early job when the matching thread follow-up is not yet due", async () => {
    const futureFollowUpAt = "2099-09-03T01:00:00.000Z";
    await admin.query(
      "UPDATE pms.message_threads SET follow_up_at = $2::timestamptz WHERE id = $1::uuid",
      [THREAD, futureFollowUpAt],
    );
    await admin.query(
      `UPDATE platform.jobs
       SET payload = jsonb_set(payload, '{followUpAt}', to_jsonb($2::text)),
           run_after = now() - interval '1 minute'
       WHERE id = $1::uuid`,
      [JOB, futureFollowUpAt],
    );

    await expect(run()).resolves.toEqual({ processed: 1, released: 0 });
    await expect(thread(THREAD)).resolves.toEqual({
      attentionState: "follow_up",
      followUpAt: futureFollowUpAt,
      followUpByMembershipId: MEMBERSHIP,
      followUpJobId: JOB,
      version: "4",
    });
    await expect(job(JOB)).resolves.toMatchObject({
      status: "pending",
      attemptsCount: 1,
      jobMetadata: { action: "release_follow_up", outcome: "not_due", threadVersion: 4 },
    });
    await expect(
      admin.query(
        `SELECT retry_after::text AS "retryAfter", error_metadata AS "errorMetadata"
         FROM platform.job_attempts WHERE job_id = $1::uuid`,
        [JOB],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          retryAfter: expect.stringContaining("2099-09-03 01:00:00"),
          errorMetadata: { outcome: "not_due" },
        },
      ],
    });
  });

  it("dead-letters a mismatched property envelope without changing the thread", async () => {
    await admin.query(
      `UPDATE platform.jobs
       SET payload = jsonb_set(payload, '{propertyId}', to_jsonb($2::text))
       WHERE id = $1::uuid`,
      [JOB, FOREIGN_PROPERTY],
    );

    await expect(run()).resolves.toEqual({ processed: 1, released: 0 });
    await expect(thread(THREAD)).resolves.toMatchObject({
      attentionState: "follow_up",
      followUpJobId: JOB,
      version: "4",
    });
    const failure = await admin.query(
      `SELECT job.status, attempt.status AS "attemptStatus", attempt.error_type AS "errorType",
              dead.reason_code AS "reasonCode"
       FROM platform.jobs job
       JOIN platform.job_attempts attempt ON attempt.job_id = job.id
       JOIN platform.dead_letter_events dead ON dead.job_id = job.id
       WHERE job.id = $1::uuid`,
      [JOB],
    );
    expect(failure.rows).toEqual([
      {
        status: "dead_lettered",
        attemptStatus: "failed",
        errorType: "invalid_job",
        reasonCode: "invalid_job",
      },
    ]);
  });

  it("records a poison job failure and continues to a later due release", async () => {
    await admin.query("UPDATE platform.jobs SET max_attempts = 1 WHERE id = $1::uuid", [JOB]);
    await seedFollowUp({
      jobId: SECOND_JOB,
      threadId: SECOND_THREAD,
      sourceThreadId: "after-poison-follow-up",
    });
    await admin.query(
      `CREATE FUNCTION platform.vay1373_fail_follow_up_release()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.event_key = 'pms.inbox.follow-up.release:${JOB}:attempt:1:released' THEN
           RAISE EXCEPTION 'deterministic follow-up release failure';
         END IF;
         RETURN NEW;
       END
       $$;
       CREATE TRIGGER vay1373_fail_follow_up_release
       BEFORE INSERT ON platform.domain_events
       FOR EACH ROW EXECUTE FUNCTION platform.vay1373_fail_follow_up_release()`,
    );
    try {
      await expect(run(2)).resolves.toEqual({ processed: 2, released: 1 });
    } finally {
      await dropFailureTrigger();
    }

    await expect(thread(THREAD)).resolves.toMatchObject({
      attentionState: "follow_up",
      followUpJobId: JOB,
      version: "4",
    });
    await expect(thread(SECOND_THREAD)).resolves.toMatchObject({
      attentionState: "needs_attention",
      followUpJobId: null,
      version: "5",
    });
    await expect(job(JOB)).resolves.toMatchObject({
      status: "dead_lettered",
      attemptsCount: 1,
      jobMetadata: { action: "release_follow_up", failureCode: "processing_error" },
    });
    await expect(job(SECOND_JOB)).resolves.toMatchObject({
      status: "succeeded",
      attemptsCount: 1,
      jobMetadata: { action: "release_follow_up", outcome: "released", threadVersion: 5 },
    });
  });

  it("recovers an expired final claim without stranding the followed-up thread", async () => {
    await admin.query(
      `UPDATE platform.jobs
       SET status = 'running', attempts_count = 1, max_attempts = 1,
           locked_at = now() - interval '6 minutes', locked_by = 'crashed-worker'
       WHERE id = $1::uuid`,
      [JOB],
    );
    await admin.query(
      `INSERT INTO platform.job_attempts
         (job_id, attempt_number, status, worker_id, started_at)
       VALUES ($1::uuid, 1, 'running', 'crashed-worker', now() - interval '6 minutes')`,
      [JOB],
    );

    await expect(run()).resolves.toEqual({ processed: 1, released: 1 });
    await expect(job(JOB)).resolves.toMatchObject({
      status: "succeeded",
      attemptsCount: 2,
      maxAttempts: 2,
      jobMetadata: {
        action: "release_follow_up",
        leaseReclaimCount: 1,
        outcome: "released",
        threadVersion: 5,
      },
    });
    const attempts = await admin.query(
      `SELECT status, error_type AS "errorType"
       FROM platform.job_attempts WHERE job_id = $1::uuid ORDER BY attempt_number`,
      [JOB],
    );
    expect(attempts.rows).toEqual([
      { status: "timed_out", errorType: "worker_timeout" },
      { status: "succeeded", errorType: null },
    ]);
  });

  it("dead-letters a repeatedly lost lease after the bounded reclaim allowance", async () => {
    await admin.query(
      `UPDATE platform.jobs
       SET status = 'running', attempts_count = 6, max_attempts = 6,
           locked_at = now() - interval '6 minutes', locked_by = 'crashed-worker',
           job_metadata = job_metadata || '{"leaseReclaimCount":5}'::jsonb
       WHERE id = $1::uuid`,
      [JOB],
    );
    await admin.query(
      `INSERT INTO platform.job_attempts
         (job_id, attempt_number, status, worker_id, started_at)
       VALUES ($1::uuid, 6, 'running', 'crashed-worker', now() - interval '6 minutes')`,
      [JOB],
    );

    await expect(run()).resolves.toEqual({ processed: 1, released: 0 });
    await expect(thread(THREAD)).resolves.toMatchObject({
      attentionState: "follow_up",
      followUpJobId: JOB,
      version: "4",
    });
    await expect(job(JOB)).resolves.toMatchObject({
      status: "dead_lettered",
      attemptsCount: 6,
      maxAttempts: 6,
      lockedAt: null,
      lockedBy: null,
      jobMetadata: { leaseReclaimCount: 5, failureCode: "lease_reclaim_exhausted" },
    });
    await expect(
      admin.query(
        `SELECT attempt.status AS "attemptStatus", attempt.error_type AS "errorType",
                dead.reason_code AS "reasonCode"
         FROM platform.job_attempts attempt
         JOIN platform.dead_letter_events dead ON dead.job_attempt_id = attempt.id
         WHERE attempt.job_id = $1::uuid`,
        [JOB],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          attemptStatus: "timed_out",
          errorType: "worker_timeout",
          reasonCode: "lease_reclaim_exhausted",
        },
      ],
    });
  });

  it("contains a lost lease while dead-lettering invalid input and continues the batch", async () => {
    await seedFollowUp({
      jobId: SECOND_JOB,
      threadId: SECOND_THREAD,
      sourceThreadId: "after-invalid-finalization",
    });
    await admin.query(
      `UPDATE platform.jobs
       SET payload = jsonb_set(payload, '{propertyId}', to_jsonb($2::text))
       WHERE id = $1::uuid`,
      [JOB, FOREIGN_PROPERTY],
    );
    await installFinalizationFailureTrigger();
    try {
      await expect(run(2)).resolves.toEqual({ processed: 2, released: 1 });
    } finally {
      await dropFinalizationFailureTrigger();
    }
    await expect(job(JOB)).resolves.toMatchObject({ status: "running", attemptsCount: 1 });
    await expect(thread(SECOND_THREAD)).resolves.toMatchObject({
      attentionState: "needs_attention",
      version: "5",
    });
  });

  it("contains a lost lease while finalizing processing failure and continues the batch", async () => {
    await admin.query("UPDATE platform.jobs SET max_attempts = 1 WHERE id = $1::uuid", [JOB]);
    await seedFollowUp({
      jobId: SECOND_JOB,
      threadId: SECOND_THREAD,
      sourceThreadId: "after-processing-finalization",
    });
    await admin.query(
      `CREATE FUNCTION platform.vay1373_fail_follow_up_release()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.event_key = 'pms.inbox.follow-up.release:${JOB}:attempt:1:released' THEN
           RAISE EXCEPTION 'deterministic follow-up release failure';
         END IF;
         RETURN NEW;
       END
       $$;
       CREATE TRIGGER vay1373_fail_follow_up_release
       BEFORE INSERT ON platform.domain_events
       FOR EACH ROW EXECUTE FUNCTION platform.vay1373_fail_follow_up_release()`,
    );
    await installFinalizationFailureTrigger();
    try {
      await expect(run(2)).resolves.toEqual({ processed: 2, released: 1 });
    } finally {
      await dropFailureTrigger();
      await dropFinalizationFailureTrigger();
    }
    await expect(job(JOB)).resolves.toMatchObject({ status: "running", attemptsCount: 1 });
    await expect(thread(SECOND_THREAD)).resolves.toMatchObject({
      attentionState: "needs_attention",
      version: "5",
    });
  });

  function run(limit = 25) {
    return runPmsInboxFollowUpReleaseJobs(URL!, {
      workerId: "inbox-follow-up-release-test",
      propertyId: PROPERTY,
      limit,
    });
  }

  async function seedProperty(): Promise<void> {
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'follow-up-release', 'Follow-up Release'),
              ($2::uuid, 'follow-up-release-foreign', 'Foreign Follow-up Release')`,
      [PROPERTY, FOREIGN_PROPERTY],
    );
  }

  async function seedFollowUp(input: {
    jobId: string;
    threadId: string;
    sourceThreadId: string;
  }): Promise<void> {
    await admin.query(
      `INSERT INTO platform.jobs
         (id, job_key, queue_name, job_type, status, max_attempts, run_after,
          tenant_scope, property_id, resource_product, resource_type, resource_id,
          correlation_id, idempotency_key_hash, payload, job_metadata)
       VALUES
         ($1::uuid, $2, 'pms.inbox.follow-up.release', 'pms.inbox.follow-up.release',
          'pending', 5, now() - interval '1 minute', 'property', $3::uuid,
          'pms', 'message_thread', $4::text, 'follow-up-release-correlation', repeat('a', 64),
          jsonb_build_object('propertyId', $3::text, 'threadId', $4::text,
                             'followUpAt', $5::text),
          '{"contractVersion":"native-guest-inbox.v2","action":"release_follow_up"}'::jsonb)`,
      [
        input.jobId,
        `pms.inbox.follow-up.release:test:${input.jobId}`,
        PROPERTY,
        input.threadId,
        FOLLOW_UP_AT,
      ],
    );
    await admin.query(
      `INSERT INTO pms.message_threads
         (id, property_id, source, source_thread_id, attention_state, delivery_channel,
          conversation_context_state, unread_count, version, follow_up_at,
          follow_up_by_membership_id, follow_up_job_id)
       VALUES
         ($1::uuid, $2::uuid, 'manual', $3, 'follow_up', 'email', 'unlinked', 0, 4,
          $4::timestamptz, $5::uuid, $6::uuid)`,
      [input.threadId, PROPERTY, input.sourceThreadId, FOLLOW_UP_AT, MEMBERSHIP, input.jobId],
    );
  }

  async function thread(threadId: string) {
    const result = await admin.query(
      `SELECT attention_state AS "attentionState",
              CASE WHEN follow_up_at IS NULL THEN NULL
                   ELSE to_char(follow_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              END AS "followUpAt",
              follow_up_by_membership_id::text AS "followUpByMembershipId",
              follow_up_job_id::text AS "followUpJobId", version::text
       FROM pms.message_threads WHERE id = $1::uuid`,
      [threadId],
    );
    return result.rows[0];
  }

  async function job(jobId: string) {
    const result = await admin.query(
      `SELECT status, attempts_count AS "attemptsCount", max_attempts AS "maxAttempts",
              locked_at AS "lockedAt", locked_by AS "lockedBy", job_metadata AS "jobMetadata"
       FROM platform.jobs WHERE id = $1::uuid`,
      [jobId],
    );
    return result.rows[0];
  }

  async function cleanup(): Promise<void> {
    if (!admin.database) return;
    await dropFailureTrigger();
    await dropFinalizationFailureTrigger();
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        "DELETE FROM platform.product_audit_events WHERE property_id = ANY($1::uuid[])",
        [[PROPERTY, FOREIGN_PROPERTY]],
      );
      await admin.query("DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])", [
        [PROPERTY, FOREIGN_PROPERTY],
      ]);
      await admin.query("DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])", [
        [PROPERTY, FOREIGN_PROPERTY],
      ]);
      await admin.query(
        `DELETE FROM platform.dead_letter_events
         WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id = ANY($1::uuid[]))`,
        [[PROPERTY, FOREIGN_PROPERTY]],
      );
      await admin.query(
        `DELETE FROM platform.job_attempts
         WHERE job_id IN (SELECT id FROM platform.jobs WHERE property_id = ANY($1::uuid[]))`,
        [[PROPERTY, FOREIGN_PROPERTY]],
      );
      await admin.query("DELETE FROM platform.jobs WHERE property_id = ANY($1::uuid[])", [
        [PROPERTY, FOREIGN_PROPERTY],
      ]);
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        [PROPERTY, FOREIGN_PROPERTY],
      ]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function dropFailureTrigger(): Promise<void> {
    await admin.query(
      `DROP TRIGGER IF EXISTS vay1373_fail_follow_up_release ON platform.domain_events;
       DROP FUNCTION IF EXISTS platform.vay1373_fail_follow_up_release()`,
    );
  }

  async function installFinalizationFailureTrigger(): Promise<void> {
    await admin.query(
      `CREATE FUNCTION platform.vay1373_fail_follow_up_finalization()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.job_id = '${JOB}'::uuid AND NEW.status = 'failed' THEN
           RAISE EXCEPTION 'deterministic follow-up finalization failure';
         END IF;
         RETURN NEW;
       END
       $$;
       CREATE TRIGGER vay1373_fail_follow_up_finalization
       BEFORE UPDATE OF status ON platform.job_attempts
       FOR EACH ROW EXECUTE FUNCTION platform.vay1373_fail_follow_up_finalization()`,
    );
  }

  async function dropFinalizationFailureTrigger(): Promise<void> {
    await admin.query(
      `DROP TRIGGER IF EXISTS vay1373_fail_follow_up_finalization ON platform.job_attempts;
       DROP FUNCTION IF EXISTS platform.vay1373_fail_follow_up_finalization()`,
    );
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(connectionString).pathname))
    throw new Error("Refusing to run Inbox follow-up tests outside a test database");
}
