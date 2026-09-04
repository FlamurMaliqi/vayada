import { createHash } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PmsInboxProviderActionPort } from "./pmsInbox.js";
import { createPgPmsInboxProviderActionPort } from "./pmsInboxProviderActionCommand.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13736000-0000-4000-8000-000000000011";
const OTHER_PROPERTY = "13736000-0000-4000-8000-000000000012";
const THREAD = "13736000-0000-4000-8000-000000000013";
const OTHER_THREAD = "13736000-0000-4000-8000-000000000014";
const FOREIGN_THREAD = "13736000-0000-4000-8000-000000000015";
const ORGANIZATION = "13736000-0000-4000-8000-000000000016";
const ACTOR = "13736000-0000-4000-8000-000000000017";
const MEMBERSHIP = "13736000-0000-4000-8000-000000000018";
const NOW = "2026-09-03T11:00:00.000Z";
const SOURCE_CONVERSATION = "booking-conversation-secret";
const JOB_TYPE = "pms.inbox.provider-action.deliver";

type Input = Parameters<PmsInboxProviderActionPort["noReplyNeeded"]>[0];

describe.skipIf(!URL)("PostgreSQL PMS Inbox provider action", () => {
  const admin = new pg.Client({ connectionString: URL });
  const command = createPgPmsInboxProviderActionPort({
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
    await command.close();
    await cleanup();
    await admin.end();
  });

  it("atomically enqueues one stable provider action without changing Inbox triage", async () => {
    const input = action("provider-no-reply-1");
    const first = await command.noReplyNeeded(input);
    await expect(command.noReplyNeeded(input)).resolves.toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        action: "booking_com_no_reply_needed",
        jobId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        acceptedAt: NOW,
        attentionStateChanged: false,
      },
    });
    const persisted = await state();
    expect(persisted.counts).toEqual({
      idempotency: 1,
      events: 1,
      audits: 1,
      outbox: 1,
      jobs: 1,
    });
    expect(persisted.thread).toEqual({ attentionState: "needs_attention", version: "4" });
    expect(persisted.job).toMatchObject({
      queueName: JOB_TYPE,
      jobType: JOB_TYPE,
      status: "pending",
      sourceDomainEventId: expect.any(String),
      sourceOutboxEventId: expect.any(String),
      payload: {
        propertyId: PROPERTY,
        threadId: THREAD,
        action: "booking_com_no_reply_needed",
        provider: "channex",
        providerChannel: "booking.com",
        providerConversationId: SOURCE_CONVERSATION,
        providerIdempotencyReference: expect.stringMatching(/^vayada-no-reply-[0-9a-f]{64}$/),
      },
      metadata: {
        ambiguousOutcomePolicy: "hold_for_review",
        retryPolicy: "classified_failures_only",
      },
    });
    expect(persisted.outbox).toMatchObject({
      destination: JOB_TYPE,
      eventType: JOB_TYPE,
      sourceDomainEventId: persisted.job?.sourceDomainEventId,
      payload: persisted.job?.payload,
    });
    expect(persisted.outbox?.id).toBe(persisted.job?.sourceOutboxEventId);
    const publicEvidence = JSON.stringify([
      persisted.events,
      persisted.audits,
      persisted.idempotency,
    ]);
    expect(publicEvidence).not.toContain("provider-no-reply-1");
    expect(publicEvidence).not.toContain(SOURCE_CONVERSATION);
    expect(publicEvidence).not.toContain(
      String(persisted.job?.payload.providerIdempotencyReference),
    );
  });

  it("revalidates provider and connection capability before enqueue", async () => {
    await admin.query(
      "UPDATE pms.message_threads SET provider_channel = 'airbnb' WHERE id = $1::uuid",
      [THREAD],
    );
    await expect(command.noReplyNeeded(action("wrong-provider"))).resolves.toEqual({
      ok: false,
      error: {
        code: "provider_action_unavailable",
        message: "Booking.com no reply needed is unavailable for this conversation.",
      },
    });
    await admin.query(
      "UPDATE pms.message_threads SET provider_channel = 'booking.com' WHERE id = $1::uuid",
      [THREAD],
    );
    await admin.query(
      "UPDATE pms.channel_connections SET connection_status = 'disconnected' WHERE property_id = $1::uuid",
      [PROPERTY],
    );
    await expect(command.noReplyNeeded(action("disconnected"))).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_action_unavailable" },
    });
    expect((await state()).counts).toEqual({
      idempotency: 2,
      events: 0,
      audits: 0,
      outbox: 0,
      jobs: 0,
    });
  });

  it("returns missing and fingerprint conflicts without a second side effect", async () => {
    await expect(
      command.noReplyNeeded({ ...action("missing"), threadId: crypto.randomUUID() }),
    ).resolves.toMatchObject({ ok: false, error: { code: "thread_not_found" } });
    await expect(command.noReplyNeeded(action("shared-key"))).resolves.toMatchObject({ ok: true });
    await expect(
      command.noReplyNeeded({ ...action("shared-key"), threadId: OTHER_THREAD }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "idempotency_conflict",
        message: "Idempotency key was used for a different Inbox provider action.",
      },
    });
    expect((await state()).counts).toMatchObject({ events: 1, audits: 1, outbox: 1, jobs: 1 });
  });

  it("serializes concurrent same-key acceptance into one stable result", async () => {
    const input = action("concurrent-replay");
    const [first, second] = await Promise.all([
      command.noReplyNeeded(input),
      command.noReplyNeeded(input),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true });
    expect((await state()).counts).toEqual({
      idempotency: 1,
      events: 1,
      audits: 1,
      outbox: 1,
      jobs: 1,
    });
  });

  it("serializes concurrent fingerprint conflicts without a second side effect", async () => {
    const [first, second] = await Promise.all([
      command.noReplyNeeded(action("concurrent-conflict")),
      command.noReplyNeeded({
        ...action("concurrent-conflict"),
        threadId: OTHER_THREAD,
      }),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: {
          code: "idempotency_conflict",
          message: "Idempotency key was used for a different Inbox provider action.",
        },
      },
    ]);
    expect((await state()).counts).toEqual({
      idempotency: 1,
      events: 1,
      audits: 1,
      outbox: 1,
      jobs: 1,
    });
  });

  it("rechecks current permissions before replay", async () => {
    const input = action("permission-replay");
    await expect(command.noReplyNeeded(input)).resolves.toMatchObject({ ok: true });
    await admin.query(
      `UPDATE identity.organization_memberships
       SET permission_overrides = '{"grant":[],"deny":["pms.inbox.read","pms.inbox.reply"]}'::jsonb
       WHERE id = $1::uuid`,
      [MEMBERSHIP],
    );
    await expect(command.noReplyNeeded(input)).rejects.toThrow(
      "PMS Inbox provider-action command failed",
    );
    expect((await state()).counts).toMatchObject({ events: 1, audits: 1, outbox: 1, jobs: 1 });
  });

  it("returns property-scoped missing for another accessible property's thread", async () => {
    await expect(
      command.noReplyNeeded({ ...action("foreign-thread"), threadId: FOREIGN_THREAD }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "thread_not_found", message: "Inbox thread was not found." },
    });
    expect((await state()).counts).toEqual({
      idempotency: 1,
      events: 0,
      audits: 0,
      outbox: 0,
      jobs: 0,
    });
    expect((await state(OTHER_PROPERTY, FOREIGN_THREAD)).counts).toEqual({
      idempotency: 0,
      events: 0,
      audits: 0,
      outbox: 0,
      jobs: 0,
    });
  });

  it("does not accept after an assigned-property grant is concurrently revoked", async () => {
    await admin.query(
      "UPDATE identity.organization_memberships SET property_access_mode = 'assigned' WHERE id = $1::uuid",
      [MEMBERSHIP],
    );
    await admin.query(
      `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
       VALUES ($1::uuid, $2::uuid)`,
      [MEMBERSHIP, PROPERTY],
    );
    const blocker = new pg.Client({ connectionString: URL });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      `DELETE FROM identity.membership_property_assignments
       WHERE membership_id = $1::uuid AND property_id = $2::uuid`,
      [MEMBERSHIP, PROPERTY],
    );
    const pending = command.noReplyNeeded(action("concurrent-assignment-revoke"));
    let committed = false;
    try {
      await waitForBlockedQuery("identity.membership_property_assignments");
      await blocker.query("COMMIT");
      committed = true;
      await expect(pending).rejects.toThrow("PMS Inbox provider-action command failed");
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      await pending.catch(() => undefined);
      await blocker.end();
    }
    expect((await state()).counts).toEqual({
      idempotency: 0,
      events: 0,
      audits: 0,
      outbox: 0,
      jobs: 0,
    });
  });

  it("does not accept after the provider connection is concurrently disconnected", async () => {
    const blocker = new pg.Client({ connectionString: URL });
    await blocker.connect();
    await blocker.query("BEGIN");
    await blocker.query(
      `UPDATE pms.channel_connections SET connection_status = 'disconnected'
       WHERE property_id = $1::uuid AND provider = 'channex'`,
      [PROPERTY],
    );
    const pending = command.noReplyNeeded(action("concurrent-disconnect"));
    let committed = false;
    try {
      await waitForBlockedQuery("pms.channel_connections");
      await blocker.query("COMMIT");
      committed = true;
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: "provider_action_unavailable" },
      });
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      await pending.catch(() => undefined);
      await blocker.end();
    }
    expect((await state()).counts).toEqual({
      idempotency: 1,
      events: 0,
      audits: 0,
      outbox: 0,
      jobs: 0,
    });
  });

  it("rolls back event, audit, outbox, and idempotency when job enqueue fails", async () => {
    const key = "rollback";
    const keyHash = createHash("sha256").update(key).digest("hex");
    await admin.query(
      `INSERT INTO platform.jobs
         (job_key, queue_name, job_type, tenant_scope, property_id,
          resource_product, resource_type, resource_id)
       VALUES ($1, $2, $2, 'property', $3::uuid, 'pms', 'message_thread', $4::text)`,
      [`${JOB_TYPE}:thread:${THREAD}:key:${keyHash}:v1`, JOB_TYPE, PROPERTY, THREAD],
    );
    await expect(command.noReplyNeeded(action(key))).rejects.toThrow(
      "PMS Inbox provider-action command failed",
    );
    expect((await state()).counts).toEqual({
      idempotency: 0,
      events: 0,
      audits: 0,
      outbox: 0,
      jobs: 1,
    });
  });

  it("rejects invalid direct input and closes its owned pool", async () => {
    await expect(
      command.noReplyNeeded({ ...action("invalid"), idempotencyKey: "" }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "validation_failed", message: "Inbox provider-action request is invalid." },
    });
    const owned = createPgPmsInboxProviderActionPort({ connectionString: URL! });
    await owned.close();
    await expect(owned.noReplyNeeded(action("after-close"))).rejects.toThrow();
  });

  function action(idempotencyKey: string): Input {
    return {
      propertyId: PROPERTY,
      threadId: THREAD,
      organizationId: ORGANIZATION,
      actorUserId: ACTOR,
      actorMembershipId: MEMBERSHIP,
      idempotencyKey,
      audit: {
        requestId: "request-provider-action",
        correlationId: "inbox-provider-action",
        requestedAt: NOW,
      },
    };
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'provider-action@example.test', 'Front Desk', 'active')`,
      [ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Inbox Provider Action', 'inbox-provider-action', 'active')`,
      [ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'inbox-provider-action', 'Provider Action Hotel'),
              ($2::uuid, 'inbox-provider-action-other', 'Other Hotel')`,
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
       VALUES ($1::uuid, 'pms', 'pms_property', $2::uuid::text, 'owner', 'active'),
              ($1::uuid, 'pms', 'pms_property', $3::uuid::text, 'owner', 'active'),
              ($1::uuid, 'hotel_catalog', 'property', $2::uuid::text, 'owner', 'active'),
              ($1::uuid, 'hotel_catalog', 'property', $3::uuid::text, 'owner', 'active')`,
      [ORGANIZATION, PROPERTY, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO identity.product_entitlements
         (organization_id, product, entitlement_key, status,
          resource_product, resource_type, resource_id)
       VALUES ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $2::uuid::text),
              ($1::uuid, 'pms', 'property-management', 'active',
               'pms', 'pms_property', $3::uuid::text)`,
      [ORGANIZATION, PROPERTY, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO pms.message_threads
         (id, property_id, source, source_thread_id, attention_state, delivery_channel,
          provider_channel, conversation_context_state, unread_count, version)
       VALUES ($1::uuid, $2::uuid, 'channex', $3, 'needs_attention',
               'ota', 'booking.com', 'unlinked', 1, 4),
              ($4::uuid, $2::uuid, 'channex', 'booking-conversation-other', 'needs_attention',
               'ota', 'booking.com', 'unlinked', 0, 1),
              ($5::uuid, $6::uuid, 'channex', 'booking-conversation-foreign', 'needs_attention',
               'ota', 'booking.com', 'unlinked', 0, 1)`,
      [THREAD, PROPERTY, SOURCE_CONVERSATION, OTHER_THREAD, FOREIGN_THREAD, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO pms.channel_connections
         (property_id, provider, connection_status, messaging_app_installed)
       VALUES ($1::uuid, 'channex', 'connected', TRUE),
              ($2::uuid, 'channex', 'connected', TRUE)`,
      [PROPERTY, OTHER_PROPERTY],
    );
  }

  async function state(propertyId = PROPERTY, threadId = THREAD) {
    const result = await admin.query(
      `SELECT jsonb_build_object(
         'idempotency', (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid AND operation = 'pms.inbox.provider.no_reply_needed'),
         'events', (SELECT count(*)::int FROM platform.domain_events WHERE property_id = $1::uuid AND event_type = 'pms.inbox.provider.no_reply_needed.accepted'),
         'audits', (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id = $1::uuid AND action = 'pms.inbox.provider.no_reply_needed.accepted'),
         'outbox', (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid AND event_type = $2),
         'jobs', (SELECT count(*)::int FROM platform.jobs WHERE property_id = $1::uuid AND job_type = $2)
       ) AS counts,
       (SELECT jsonb_build_object('attentionState', attention_state, 'version', version::text)
        FROM pms.message_threads WHERE id = $3::uuid) AS thread,
       (SELECT jsonb_build_object(
          'sourceDomainEventId', source_domain_event_id::text,
          'sourceOutboxEventId', source_outbox_event_id::text,
          'queueName', queue_name, 'jobType', job_type, 'status', status,
          'payload', payload, 'metadata', job_metadata)
        FROM platform.jobs WHERE property_id = $1::uuid AND job_type = $2 ORDER BY created_at DESC LIMIT 1) AS job,
       (SELECT jsonb_build_object(
          'id', id::text, 'sourceDomainEventId', domain_event_id::text,
          'destination', destination, 'eventType', event_type, 'payload', payload)
        FROM platform.outbox_events WHERE property_id = $1::uuid AND event_type = $2) AS outbox,
       (SELECT jsonb_agg(jsonb_build_object('payload', payload, 'metadata', event_metadata))
        FROM platform.domain_events WHERE property_id = $1::uuid AND event_type = 'pms.inbox.provider.no_reply_needed.accepted') AS events,
       (SELECT jsonb_agg(jsonb_build_object('payload', redacted_payload, 'metadata', audit_metadata))
        FROM platform.product_audit_events WHERE property_id = $1::uuid AND action = 'pms.inbox.provider.no_reply_needed.accepted') AS audits,
       (SELECT jsonb_agg(idempotency_metadata)
        FROM platform.idempotency_keys WHERE property_id = $1::uuid AND operation = 'pms.inbox.provider.no_reply_needed') AS idempotency`,
      [propertyId, JOB_TYPE, threadId],
    );
    return result.rows[0] as {
      counts: { idempotency: number; events: number; audits: number; outbox: number; jobs: number };
      thread: { attentionState: string; version: string };
      job: null | {
        sourceDomainEventId: string;
        sourceOutboxEventId: string;
        queueName: string;
        jobType: string;
        status: string;
        payload: Record<string, unknown>;
        metadata: Record<string, unknown>;
      };
      outbox: null | {
        id: string;
        sourceDomainEventId: string;
        destination: string;
        eventType: string;
        payload: Record<string, unknown>;
      };
      events: unknown;
      audits: unknown;
      idempotency: unknown;
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
        "DELETE FROM platform.jobs WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_assistance_results WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.messages WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.channel_connections WHERE property_id = ANY($1::uuid[])",
      ])
        await admin.query(statement, [properties]);
      await admin.query(
        "DELETE FROM identity.membership_property_assignments WHERE membership_id = $1::uuid",
        [MEMBERSHIP],
      );
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

  async function waitForBlockedQuery(tableName: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await admin.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock' AND query LIKE '%' || $1 || '%'
           AND query LIKE '%FOR SHARE%'
         LIMIT 1`,
        [tableName],
      );
      if (waiting.rows[0]) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${tableName} contention`);
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(connectionString).pathname))
    throw new Error("Refusing to run Inbox provider-action tests outside a test database");
}
