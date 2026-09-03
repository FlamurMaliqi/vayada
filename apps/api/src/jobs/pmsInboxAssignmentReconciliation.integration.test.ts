import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runPmsInboxAssignmentReconciliationJobs } from "./pmsInboxAssignmentReconciliation.js";

const URL = process.env["TEST_DATABASE_URL"];
const ORGANIZATION = "13736000-0000-4000-8000-000000000001";
const USER = "13736000-0000-4000-8000-000000000002";
const MEMBERSHIP = "13736000-0000-4000-8000-000000000003";
const RETAINED_PROPERTY = "13736000-0000-4000-8000-000000000004";
const REMOVED_PROPERTY = "13736000-0000-4000-8000-000000000005";
const RETAINED_THREAD = "13736000-0000-4000-8000-000000000006";
const CLEARED_THREAD = "13736000-0000-4000-8000-000000000007";
const JOB = "13736000-0000-4000-8000-000000000008";
const FOREIGN_ORGANIZATION = "13736000-0000-4000-8000-000000000009";
const FOREIGN_JOB = "13736000-0000-4000-8000-000000000010";
const SECOND_JOB = "13736000-0000-4000-8000-000000000011";

describe.skipIf(!URL)("PMS Inbox assignment reconciliation worker", () => {
  const admin = new pg.Client({ connectionString: URL });

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await cleanup();
    await admin.end();
  });

  it("clears only assignments whose member lost property access and audits the job", async () => {
    await expect(
      runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-test",
        organizationId: ORGANIZATION,
      }),
    ).resolves.toEqual({ processed: 1, cleared: 1 });
    await expect(
      runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-test-replay",
        organizationId: ORGANIZATION,
      }),
    ).resolves.toEqual({ processed: 0, cleared: 0 });

    const threads = await admin.query(
      `SELECT id::text, assigned_to_membership_id::text AS "assignedToMembershipId",
              version::text
       FROM pms.message_threads WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[RETAINED_THREAD, CLEARED_THREAD]],
    );
    expect(threads.rows).toEqual([
      { id: RETAINED_THREAD, assignedToMembershipId: MEMBERSHIP, version: "4" },
      { id: CLEARED_THREAD, assignedToMembershipId: null, version: "5" },
    ]);

    const job = await admin.query(
      `SELECT status, attempts_count AS "attemptsCount", locked_at AS "lockedAt",
              locked_by AS "lockedBy", job_metadata AS "jobMetadata"
       FROM platform.jobs WHERE id = $1::uuid`,
      [JOB],
    );
    expect(job.rows).toEqual([
      {
        status: "succeeded",
        attemptsCount: 1,
        lockedAt: null,
        lockedBy: null,
        jobMetadata: { reason: "property_access_removed", cleared: 1 },
      },
    ]);
    await expect(
      admin.query(
        `SELECT status, worker_id AS "workerId" FROM platform.job_attempts
         WHERE job_id = $1::uuid`,
        [JOB],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: "succeeded", workerId: "inbox-assignment-test" }],
    });

    const evidence = await admin.query(
      `SELECT event.event_type AS "eventType", event.property_id::text AS "eventPropertyId",
              event.resource_id AS "eventResourceId", audit.action,
              audit.property_id::text AS "auditPropertyId", audit.causation_id AS "jobId",
              audit.redacted_payload AS "redactedPayload", audit.private_payload AS "privatePayload"
       FROM platform.domain_events event
       JOIN platform.product_audit_events audit ON audit.domain_event_id = event.id
       WHERE event.event_key = $1`,
      [`pms.inbox.assignment.reconcile:${JOB}:attempt:1:${CLEARED_THREAD}`],
    );
    expect(evidence.rows).toEqual([
      {
        eventType: "pms.inbox.thread.assignment_reconciled",
        eventPropertyId: REMOVED_PROPERTY,
        eventResourceId: CLEARED_THREAD,
        action: "pms.inbox.thread.assignment.reconciled",
        auditPropertyId: REMOVED_PROPERTY,
        jobId: JOB,
        redactedPayload: { outcome: "cleared", threadVersion: 5 },
        privatePayload: { previousAssigneeMembershipId: MEMBERSHIP },
      },
    ]);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
          [[RETAINED_PROPERTY, REMOVED_PROPERTY]],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("discovers invalid assignments even when the access-loss writer did not enqueue a job", async () => {
    await admin.query("DELETE FROM platform.jobs WHERE id = $1::uuid", [JOB]);
    await admin.query("UPDATE identity.users SET status = 'suspended' WHERE id = $1::uuid", [USER]);

    await expect(
      runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-safety-sweep",
        organizationId: ORGANIZATION,
      }),
    ).resolves.toEqual({ processed: 1, cleared: 2 });

    const threads = await admin.query(
      `SELECT assigned_to_membership_id::text AS "assignedToMembershipId"
       FROM pms.message_threads WHERE id = ANY($1::uuid[])`,
      [[RETAINED_THREAD, CLEARED_THREAD]],
    );
    expect(threads.rows).toEqual([
      { assignedToMembershipId: null },
      { assignedToMembershipId: null },
    ]);
    await expect(
      admin.query(
        `SELECT status, resource_id AS "resourceId", job_metadata AS "jobMetadata"
         FROM platform.jobs
         WHERE organization_id = $1::uuid AND job_type = 'pms.inbox.assignment.reconcile'`,
        [ORGANIZATION],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: "succeeded",
          resourceId: MEMBERSHIP,
          jobMetadata: {
            reason: "membership_suspended",
            discovery: "safety_sweep",
            cleared: 2,
          },
        },
      ],
    });
  });

  it("dead-letters a foreign-organization job without mutating the membership assignments", async () => {
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Foreign', 'inbox-reconciliation-foreign', 'active')`,
      [FOREIGN_ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO platform.jobs
         (id, job_key, queue_name, job_type, tenant_scope, organization_id,
          resource_product, resource_type, resource_id, job_metadata)
       VALUES ($1::uuid, 'reconcile-foreign-scope-test', 'pms-inbox',
               'pms.inbox.assignment.reconcile', 'organization', $2::uuid,
               'pms', 'inbox_assignment', $3::text,
               '{"reason":"property_access_removed"}'::jsonb)`,
      [FOREIGN_JOB, FOREIGN_ORGANIZATION, MEMBERSHIP],
    );

    await expect(
      runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-foreign-scope",
        organizationId: FOREIGN_ORGANIZATION,
      }),
    ).resolves.toEqual({ processed: 1, cleared: 0 });

    const threads = await admin.query(
      `SELECT assigned_to_membership_id::text AS "assignedToMembershipId"
       FROM pms.message_threads WHERE id = ANY($1::uuid[])`,
      [[RETAINED_THREAD, CLEARED_THREAD]],
    );
    expect(threads.rows).toEqual([
      { assignedToMembershipId: MEMBERSHIP },
      { assignedToMembershipId: MEMBERSHIP },
    ]);
    await expect(
      admin.query(
        `SELECT job.status, job.job_metadata ->> 'failureCode' AS "failureCode",
                attempt.error_type AS "attemptError",
                dead.reason_code AS "deadReason"
         FROM platform.jobs job
         JOIN platform.job_attempts attempt ON attempt.job_id = job.id
         JOIN platform.dead_letter_events dead ON dead.job_id = job.id
         WHERE job.id = $1::uuid`,
        [FOREIGN_JOB],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: "dead_lettered",
          failureCode: "organization_scope_mismatch",
          attemptError: "organization_scope_mismatch",
          deadReason: "organization_scope_mismatch",
        },
      ],
    });
  });

  it("persists a failed attempt and continues to the next job", async () => {
    await admin.query("UPDATE platform.jobs SET max_attempts = 1 WHERE id = $1::uuid", [JOB]);
    await admin.query(
      `INSERT INTO platform.jobs
         (id, job_key, queue_name, job_type, tenant_scope, organization_id,
          resource_product, resource_type, resource_id, job_metadata)
       VALUES ($1::uuid, 'reconcile-after-poison-test', 'pms-inbox',
               'pms.inbox.assignment.reconcile', 'organization', $2::uuid,
               'pms', 'inbox_assignment', $3::text,
               '{"reason":"property_access_removed"}'::jsonb)`,
      [SECOND_JOB, ORGANIZATION, MEMBERSHIP],
    );
    await admin.query(
      `CREATE FUNCTION platform.vay1373_fail_first_reconciliation()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.event_key = 'pms.inbox.assignment.reconcile:${JOB}:attempt:1:${CLEARED_THREAD}' THEN
           RAISE EXCEPTION 'deterministic reconciliation failure';
         END IF;
         RETURN NEW;
       END
       $$;
       CREATE TRIGGER vay1373_fail_first_reconciliation
       BEFORE INSERT ON platform.domain_events
       FOR EACH ROW EXECUTE FUNCTION platform.vay1373_fail_first_reconciliation()`,
    );
    try {
      await expect(
        runPmsInboxAssignmentReconciliationJobs(URL!, {
          workerId: "inbox-assignment-poison-progress",
          organizationId: ORGANIZATION,
          limit: 2,
        }),
      ).resolves.toEqual({ processed: 2, cleared: 1 });
    } finally {
      await dropFailureTrigger();
    }

    const jobs = await admin.query(
      `SELECT id::text, status, attempts_count AS "attemptsCount"
       FROM platform.jobs WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[JOB, SECOND_JOB]],
    );
    expect(jobs.rows).toEqual([
      { id: JOB, status: "dead_lettered", attemptsCount: 1 },
      { id: SECOND_JOB, status: "succeeded", attemptsCount: 1 },
    ]);
    await expect(
      admin.query(
        `SELECT attempt.status, attempt.error_type AS "errorType", dead.reason_code AS "reasonCode"
         FROM platform.job_attempts attempt
         JOIN platform.dead_letter_events dead ON dead.job_attempt_id = attempt.id
         WHERE attempt.job_id = $1::uuid`,
        [JOB],
      ),
    ).resolves.toMatchObject({
      rows: [{ status: "failed", errorType: "processing_error", reasonCode: "processing_error" }],
    });
  });

  it("dead-letters a crashed final attempt and lets safety discovery repair the assignment", async () => {
    await admin.query("DELETE FROM platform.jobs WHERE id = $1::uuid", [JOB]);
    await expect(
      runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-discover-before-crash",
        organizationId: ORGANIZATION,
        limit: 0,
      }),
    ).resolves.toEqual({ processed: 0, cleared: 0 });
    const discovered = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM platform.jobs
       WHERE organization_id = $1::uuid AND job_type = 'pms.inbox.assignment.reconcile'
         AND job_key LIKE 'pms.inbox.assignment.reconcile:sweep:%'`,
      [ORGANIZATION],
    );
    const crashedJobId = discovered.rows[0]?.id;
    expect(crashedJobId).toBeTruthy();
    await admin.query(
      `UPDATE platform.jobs
       SET status = 'running', attempts_count = 1, max_attempts = 1,
           locked_at = now() - interval '6 minutes', locked_by = 'crashed-worker'
       WHERE id = $1::uuid`,
      [crashedJobId],
    );
    await admin.query(
      `INSERT INTO platform.job_attempts
         (job_id, attempt_number, status, worker_id, started_at)
       VALUES ($1::uuid, 1, 'running', 'crashed-worker', now() - interval '6 minutes')`,
      [crashedJobId],
    );

    await expect(
      runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-crash-recovery",
        organizationId: ORGANIZATION,
      }),
    ).resolves.toEqual({ processed: 1, cleared: 1 });

    await expect(
      admin.query(
        `SELECT job.status, job.attempts_count AS "attemptsCount",
                array_agg(attempt.status ORDER BY attempt.attempt_number) AS attempts,
                dead.reason_code AS "reasonCode", dead.recovery_status AS "recoveryStatus",
                dead.requeued_job_id::text AS "requeuedJobId"
         FROM platform.jobs job
         JOIN platform.job_attempts attempt ON attempt.job_id = job.id
         JOIN platform.dead_letter_events dead ON dead.job_id = job.id
         WHERE job.id = $1::uuid
         GROUP BY job.id, dead.reason_code, dead.recovery_status, dead.requeued_job_id`,
        [crashedJobId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          status: "succeeded",
          attemptsCount: 2,
          attempts: ["timed_out", "succeeded"],
          reasonCode: "worker_lease_expired",
          recoveryStatus: "requeued",
          requeuedJobId: crashedJobId,
        },
      ],
    });
    expect(
      (
        await admin.query(
          `SELECT assigned_to_membership_id::text AS assignee
           FROM pms.message_threads WHERE id = $1::uuid`,
          [CLEARED_THREAD],
        )
      ).rows[0]?.assignee,
    ).toBeNull();
  });

  it("reuses a completed safety job when the identical access loss happens again", async () => {
    await admin.query("DELETE FROM platform.jobs WHERE id = $1::uuid", [JOB]);

    await expect(
      runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-repeat-discovery",
        organizationId: ORGANIZATION,
        limit: 0,
      }),
    ).resolves.toEqual({ processed: 0, cleared: 0 });
    await admin.query(
      `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
       VALUES ($1::uuid, $2::uuid)`,
      [MEMBERSHIP, REMOVED_PROPERTY],
    );
    await expect(
      runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-restored-before-processing",
        organizationId: ORGANIZATION,
        limit: 1,
      }),
    ).resolves.toEqual({ processed: 1, cleared: 0 });

    await admin.query(
      `DELETE FROM identity.membership_property_assignments
       WHERE membership_id = $1::uuid AND property_id = $2::uuid`,
      [MEMBERSHIP, REMOVED_PROPERTY],
    );
    await expect(
      runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-repeated-loss",
        organizationId: ORGANIZATION,
        limit: 1,
      }),
    ).resolves.toEqual({ processed: 1, cleared: 1 });

    const safetyJob = await admin.query(
      `SELECT status, attempts_count AS "attemptsCount",
              (SELECT array_agg(status ORDER BY attempt_number)
               FROM platform.job_attempts WHERE job_id = job.id) AS attempts
       FROM platform.jobs job
       WHERE organization_id = $1::uuid AND job_type = 'pms.inbox.assignment.reconcile'`,
      [ORGANIZATION],
    );
    expect(safetyJob.rows).toEqual([
      { status: "succeeded", attemptsCount: 2, attempts: ["succeeded", "succeeded"] },
    ]);
  });

  it("waits for a concurrent access restoration before deciding whether to clear", async () => {
    const restorer = new pg.Client({
      connectionString: URL,
      application_name: "inbox-assignment-access-restorer",
    });
    await restorer.connect();
    try {
      await restorer.query("BEGIN");
      await restorer.query(
        `SELECT 1 FROM identity.organization_memberships
         WHERE id = $1::uuid FOR UPDATE`,
        [MEMBERSHIP],
      );
      await restorer.query(
        `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
         VALUES ($1::uuid, $2::uuid)`,
        [MEMBERSHIP, REMOVED_PROPERTY],
      );

      const reconciliation = runPmsInboxAssignmentReconciliationJobs(URL!, {
        workerId: "inbox-assignment-concurrent-restore",
        organizationId: ORGANIZATION,
        limit: 1,
      });
      await expect(waitForMembershipLock()).resolves.toBe(true);
      await restorer.query("COMMIT");
      await expect(reconciliation).resolves.toEqual({ processed: 1, cleared: 0 });
    } catch (error) {
      await restorer.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await restorer.end();
    }

    await expect(
      admin.query(
        `SELECT assigned_to_membership_id::text AS "assignedToMembershipId", version::text
         FROM pms.message_threads WHERE id = $1::uuid`,
        [CLEARED_THREAD],
      ),
    ).resolves.toMatchObject({
      rows: [{ assignedToMembershipId: MEMBERSHIP, version: "4" }],
    });
  });

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'reconcile@example.test', 'Front Desk', 'active')`,
      [USER],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Reconciliation', 'inbox-reconciliation', 'active')`,
      [ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'inbox-reconcile-retained', 'Retained'),
              ($2::uuid, 'inbox-reconcile-removed', 'Removed')`,
      [RETAINED_PROPERTY, REMOVED_PROPERTY],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key, property_access_mode, access_origin)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', 'front_desk', 'assigned', 'agency')`,
      [MEMBERSHIP, ORGANIZATION, USER],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'front_desk', 'active'),
              ($1::uuid, 'pms', 'pms_property', $3::uuid::text, 'front_desk', 'active'),
              ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'owner', 'active'),
              ($1::uuid, 'hotel_catalog', 'property', $3::uuid::text, 'owner', 'active')`,
      [ORGANIZATION, RETAINED_PROPERTY, REMOVED_PROPERTY],
    );
    await admin.query(
      `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
       VALUES ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)`,
      [MEMBERSHIP, RETAINED_PROPERTY, REMOVED_PROPERTY],
    );
    await admin.query(
      `INSERT INTO pms.message_threads
         (id, property_id, source, source_thread_id, attention_state, delivery_channel,
          conversation_context_state, unread_count, version, assigned_to_membership_id)
       VALUES
         ($1::uuid, $2::uuid, 'channex', 'retained-assignment', 'needs_attention',
          'ota', 'unlinked', 0, 4, $5::uuid),
         ($3::uuid, $4::uuid, 'channex', 'removed-assignment', 'needs_attention',
          'ota', 'unlinked', 0, 4, $5::uuid)`,
      [RETAINED_THREAD, RETAINED_PROPERTY, CLEARED_THREAD, REMOVED_PROPERTY, MEMBERSHIP],
    );
    await admin.query(
      `DELETE FROM identity.membership_property_assignments
       WHERE membership_id = $1::uuid AND property_id = $2::uuid`,
      [MEMBERSHIP, REMOVED_PROPERTY],
    );
    await admin.query(
      `INSERT INTO platform.jobs
         (id, job_key, queue_name, job_type, tenant_scope, organization_id,
          resource_product, resource_type, resource_id, correlation_id, job_metadata)
       VALUES ($1::uuid, 'reconcile-access-test', 'pms-inbox',
               'pms.inbox.assignment.reconcile', 'organization', $2::uuid,
               'pms', 'inbox_assignment', $3::text, 'reconcile-correlation',
               '{"reason":"property_access_removed"}'::jsonb)`,
      [JOB, ORGANIZATION, MEMBERSHIP],
    );
  }

  async function cleanup(): Promise<void> {
    if (!admin.database) return;
    await dropFailureTrigger();
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      await admin.query(
        "DELETE FROM platform.product_audit_events WHERE property_id = ANY($1::uuid[])",
        [[RETAINED_PROPERTY, REMOVED_PROPERTY]],
      );
      await admin.query("DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])", [
        [RETAINED_PROPERTY, REMOVED_PROPERTY],
      ]);
      await admin.query(
        `DELETE FROM platform.dead_letter_events
         WHERE job_id IN (
           SELECT id FROM platform.jobs
           WHERE job_type = 'pms.inbox.assignment.reconcile'
             AND organization_id = ANY($1::uuid[])
         )`,
        [[ORGANIZATION, FOREIGN_ORGANIZATION]],
      );
      await admin.query(
        `DELETE FROM platform.job_attempts
         WHERE job_id IN (
           SELECT id FROM platform.jobs
           WHERE job_type = 'pms.inbox.assignment.reconcile'
             AND organization_id = ANY($1::uuid[])
         )`,
        [[ORGANIZATION, FOREIGN_ORGANIZATION]],
      );
      await admin.query(
        `DELETE FROM platform.jobs
         WHERE job_type = 'pms.inbox.assignment.reconcile'
           AND organization_id = ANY($1::uuid[])`,
        [[ORGANIZATION, FOREIGN_ORGANIZATION]],
      );
      await admin.query("DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])", [
        [RETAINED_PROPERTY, REMOVED_PROPERTY],
      ]);
      await admin.query(
        "DELETE FROM identity.membership_property_assignments WHERE membership_id = $1::uuid",
        [MEMBERSHIP],
      );
      await admin.query(
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        [ORGANIZATION],
      );
      await admin.query(
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
        [ORGANIZATION],
      );
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        [RETAINED_PROPERTY, REMOVED_PROPERTY],
      ]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [ORGANIZATION]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [
        FOREIGN_ORGANIZATION,
      ]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [USER]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }

  async function dropFailureTrigger(): Promise<void> {
    await admin.query(
      `DROP TRIGGER IF EXISTS vay1373_fail_first_reconciliation ON platform.domain_events;
       DROP FUNCTION IF EXISTS platform.vay1373_fail_first_reconciliation()`,
    );
  }

  async function waitForMembershipLock(): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const blocked = await admin.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE application_name = 'pms.inbox.assignment.reconcile'
           AND wait_event_type = 'Lock'
           AND query LIKE '%FOR SHARE OF membership%'`,
      );
      if (blocked.rowCount) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(connectionString).pathname))
    throw new Error("Refusing to run Inbox reconciliation tests outside a test database");
}
