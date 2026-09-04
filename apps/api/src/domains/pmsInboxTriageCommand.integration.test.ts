import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PmsInboxTriagePort } from "./pmsInbox.js";
import { createPgPmsInboxTriagePort } from "./pmsInboxTriageCommand.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13732000-0000-4000-8000-000000000001";
const THREAD = "13732000-0000-4000-8000-000000000002";
const ORGANIZATION = "13732000-0000-4000-8000-000000000003";
const ACTOR = "13732000-0000-4000-8000-000000000004";
const MEMBERSHIP = "13732000-0000-4000-8000-000000000005";
const OTHER_PROPERTY = "13732000-0000-4000-8000-000000000006";
const OTHER_THREAD = "13732000-0000-4000-8000-000000000007";
const NOW = "2026-09-03T09:00:00.000Z";
const FOLLOW_UP_AT = "2026-09-03T10:00:00.000Z";
const LATER_FOLLOW_UP_AT = "2026-09-03T11:00:00.000Z";

type TriageInput = Parameters<PmsInboxTriagePort["transition"]>[0];

describe.skipIf(!URL)("PostgreSQL PMS Inbox triage transaction", () => {
  const admin = new pg.Client({ connectionString: URL });
  const triage = createPgPmsInboxTriagePort({
    connectionString: URL ?? "postgresql://integration-test-disabled",
    max: 4,
    now: () => new Date(NOW),
  });

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await triage.close();
    await cleanup();
    await admin.end();
  });

  it("marks a thread done once and preserves complete evidence on replay", async () => {
    const input = command("done-once", { action: "done" });
    const first = await triage.transition(input);
    await expect(triage.transition(input)).resolves.toEqual(first);
    expect(first).toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        attentionState: "done",
        followUpAt: null,
        threadVersion: 5,
      },
    });

    const persisted = await state();
    expect(persisted.thread).toMatchObject({
      attentionState: "done",
      version: "5",
      followUpAt: null,
      followUpByMembershipId: null,
      followUpJobId: null,
      doneAt: NOW,
      doneByMembershipId: MEMBERSHIP,
      doneReason: "staff_marked_done",
    });
    expect(persisted.counts).toEqual({ idempotency: 1, events: 1, audits: 1, jobs: 0, outbox: 0 });
    expect(JSON.stringify([persisted.events, persisted.audits])).not.toContain("done-once");
  });

  it("schedules and reschedules follow-up jobs, then reopens without touching providers", async () => {
    await expect(
      triage.transition(
        command("follow-up-one", { action: "follow_up", followUpAt: FOLLOW_UP_AT }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { attentionState: "follow_up", threadVersion: 5 },
    });
    const first = await state();
    expect(first.thread).toMatchObject({
      attentionState: "follow_up",
      version: "5",
      followUpAt: FOLLOW_UP_AT,
      followUpByMembershipId: MEMBERSHIP,
      doneAt: null,
      doneByMembershipId: null,
      doneReason: null,
    });
    expect(first.thread.followUpJobId).toBe(first.jobs[0]?.id);
    expect(first.jobs).toEqual([
      expect.objectContaining({
        queueName: "pms.inbox.follow-up.release",
        jobType: "pms.inbox.follow-up.release",
        status: "pending",
        runAfter: FOLLOW_UP_AT,
        propertyId: PROPERTY,
        resourceId: THREAD,
        payload: { propertyId: PROPERTY, threadId: THREAD, followUpAt: FOLLOW_UP_AT },
      }),
    ]);

    await expect(
      triage.transition(
        command("follow-up-two", {
          action: "follow_up",
          followUpAt: LATER_FOLLOW_UP_AT,
          expectedThreadVersion: 5,
        }),
      ),
    ).resolves.toMatchObject({
      ok: true,
      value: { followUpAt: LATER_FOLLOW_UP_AT, threadVersion: 6 },
    });
    const rescheduled = await state();
    expect(rescheduled.jobs).toHaveLength(2);
    expect(rescheduled.thread.followUpJobId).toBe(rescheduled.jobs[1]?.id);
    expect(rescheduled.jobs[0]?.id).not.toBe(rescheduled.thread.followUpJobId);

    await expect(
      triage.transition(command("reopen", { action: "reopen", expectedThreadVersion: 6 })),
    ).resolves.toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        attentionState: "needs_attention",
        followUpAt: null,
        threadVersion: 7,
      },
    });
    const reopened = await state();
    expect(reopened.thread).toMatchObject({
      attentionState: "needs_attention",
      version: "7",
      followUpAt: null,
      followUpByMembershipId: null,
      followUpJobId: null,
      doneAt: null,
      doneByMembershipId: null,
      doneReason: null,
    });
    expect(reopened.counts).toEqual({ idempotency: 3, events: 3, audits: 3, jobs: 2, outbox: 0 });
  });

  it("commits an expired follow-up validation result without mutating the thread", async () => {
    const input = command("expired", { action: "follow_up", followUpAt: NOW });
    const expected = {
      ok: false as const,
      error: {
        code: "validation_failed" as const,
        message: "Follow-up time must be in the future.",
      },
    };
    await expect(triage.transition(input)).resolves.toEqual(expected);
    await expect(triage.transition(input)).resolves.toEqual(expected);

    const persisted = await state();
    expect(persisted.thread).toMatchObject({ attentionState: "needs_attention", version: "4" });
    expect(persisted.counts).toEqual({ idempotency: 1, events: 0, audits: 0, jobs: 0, outbox: 0 });
  });

  it("does not cross the property boundary for a foreign thread ID", async () => {
    await expect(
      triage.transition(command("foreign-thread", { threadId: OTHER_THREAD })),
    ).resolves.toEqual({
      ok: false,
      error: { code: "thread_not_found", message: "Inbox thread was not found." },
    });

    const persisted = await state();
    expect(persisted.thread).toMatchObject({ attentionState: "needs_attention", version: "4" });
    expect(persisted.counts).toEqual({ idempotency: 1, events: 0, audits: 0, jobs: 0, outbox: 0 });
    await expect(
      admin.query(
        `SELECT attention_state AS "attentionState", version::text
         FROM pms.message_threads
         WHERE property_id = $1::uuid AND id = $2::uuid`,
        [OTHER_PROPERTY, OTHER_THREAD],
      ),
    ).resolves.toMatchObject({ rows: [{ attentionState: "needs_attention", version: "4" }] });
  });

  it("serializes same-key follow-up requests into one mutation and one job", async () => {
    const input = command("same-key", { action: "follow_up", followUpAt: FOLLOW_UP_AT });
    const [first, second] = await Promise.all([triage.transition(input), triage.transition(input)]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ ok: true, value: { threadVersion: 5 } });
    expect((await state()).counts).toEqual({
      idempotency: 1,
      events: 1,
      audits: 1,
      jobs: 1,
      outbox: 0,
    });
  });

  it("allows only one of two different commands with the same expected version", async () => {
    const [done, reopen] = await Promise.all([
      triage.transition(command("race-done", { action: "done" })),
      triage.transition(command("race-reopen", { action: "reopen" })),
    ]);

    const results = [done, reopen];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: {
          code: "thread_version_conflict",
          message: "The conversation changed. Refresh and try again.",
          currentVersion: 5,
        },
      },
    ]);
    expect((await state()).counts).toEqual({
      idempotency: 2,
      events: 1,
      audits: 1,
      jobs: 0,
      outbox: 0,
    });
  });

  function command(key: string, overrides: Partial<TriageInput> = {}): TriageInput {
    return {
      propertyId: PROPERTY,
      threadId: THREAD,
      organizationId: ORGANIZATION,
      actorUserId: ACTOR,
      actorMembershipId: MEMBERSHIP,
      action: "done",
      idempotencyKey: key,
      expectedThreadVersion: 4,
      followUpAt: null,
      audit: { requestId: `request-${key}`, correlationId: "inbox-triage", requestedAt: NOW },
      ...overrides,
    };
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'triage@example.test', 'Front Desk', 'active')`,
      [ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Inbox Triage', 'inbox-triage', 'active')`,
      [ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'inbox-triage', 'Inbox Triage'),
              ($2::uuid, 'inbox-triage-other', 'Inbox Triage Other')`,
      [PROPERTY, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key, property_access_mode, access_origin)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', 'owner', 'all', 'agency')`,
      [MEMBERSHIP, ORGANIZATION, ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organization_resource_links
         (organization_id, product, resource_type, resource_id, relationship, status)
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active')`,
      [ORGANIZATION, PROPERTY],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text)`,
      [ORGANIZATION, PROPERTY],
    );
    await admin.query(
      `INSERT INTO pms.message_threads
         (id, property_id, source, source_thread_id, attention_state, delivery_channel,
          conversation_context_state, unread_count, version)
       VALUES
         ($1::uuid, $2::uuid, 'channex', 'triage-thread', 'needs_attention',
          'ota', 'unlinked', 1, 4),
         ($3::uuid, $4::uuid, 'channex', 'triage-thread-other', 'needs_attention',
          'ota', 'unlinked', 1, 4)`,
      [THREAD, PROPERTY, OTHER_THREAD, OTHER_PROPERTY],
    );
  }

  async function state() {
    const result = await admin.query(
      `SELECT
         (SELECT jsonb_build_object(
            'attentionState', attention_state,
            'version', version::text,
            'followUpAt', CASE WHEN follow_up_at IS NULL THEN NULL
              ELSE to_char(follow_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
            'followUpByMembershipId', follow_up_by_membership_id::text,
            'followUpJobId', follow_up_job_id::text,
            'doneAt', CASE WHEN done_at IS NULL THEN NULL
              ELSE to_char(done_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
            'doneByMembershipId', done_by_membership_id::text,
            'doneReason', done_reason)
          FROM pms.message_threads WHERE property_id = $1::uuid AND id = $2::uuid) AS thread,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', id::text, 'queueName', queue_name, 'jobType', job_type, 'status', status,
            'runAfter', to_char(run_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'propertyId', property_id::text, 'resourceId', resource_id, 'payload', payload)
            ORDER BY run_after, id)
          FROM platform.jobs WHERE property_id = $1::uuid), '[]'::jsonb) AS jobs,
         jsonb_build_object(
           'idempotency', (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid),
           'events', (SELECT count(*)::int FROM platform.domain_events WHERE property_id = $1::uuid),
           'audits', (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id = $1::uuid),
           'jobs', (SELECT count(*)::int FROM platform.jobs WHERE property_id = $1::uuid),
           'outbox', (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid)
         ) AS counts,
         (SELECT jsonb_agg(jsonb_build_object('payload', payload, 'metadata', event_metadata))
          FROM platform.domain_events WHERE property_id = $1::uuid) AS events,
         (SELECT jsonb_agg(jsonb_build_object(
            'redactedPayload', redacted_payload, 'metadata', audit_metadata))
          FROM platform.product_audit_events WHERE property_id = $1::uuid) AS audits`,
      [PROPERTY, THREAD],
    );
    return result.rows[0] as {
      thread: {
        attentionState: string;
        version: string;
        followUpAt: string | null;
        followUpByMembershipId: string | null;
        followUpJobId: string | null;
        doneAt: string | null;
        doneByMembershipId: string | null;
        doneReason: string | null;
      };
      jobs: Array<{
        id: string;
        queueName: string;
        jobType: string;
        status: string;
        runAfter: string;
        propertyId: string;
        resourceId: string;
        payload: unknown;
      }>;
      counts: { idempotency: number; events: number; audits: number; jobs: number; outbox: number };
      events: unknown;
      audits: unknown;
    };
  }

  async function cleanup(): Promise<void> {
    if (!admin.database) return;
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      const properties = [PROPERTY, OTHER_PROPERTY];
      for (const statement of [
        "DELETE FROM platform.product_audit_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.jobs WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
      ])
        await admin.query(statement, [properties]);
      for (const statement of [
        "DELETE FROM identity.product_entitlements WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organization_resource_links WHERE organization_id = $1::uuid",
        "DELETE FROM identity.organization_memberships WHERE organization_id = $1::uuid",
      ])
        await admin.query(statement, [ORGANIZATION]);
      await admin.query("DELETE FROM hotel_catalog.properties WHERE id = ANY($1::uuid[])", [
        properties,
      ]);
      await admin.query("DELETE FROM identity.organizations WHERE id = $1::uuid", [ORGANIZATION]);
      await admin.query("DELETE FROM identity.users WHERE id = $1::uuid", [ACTOR]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(connectionString).pathname))
    throw new Error("Refusing to run Inbox triage tests outside a test database");
}
