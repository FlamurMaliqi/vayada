import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPgPmsInboxMarkReadPort } from "./pmsInboxMarkReadCommand.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13731000-0000-4000-8000-000000000001";
const OTHER_PROPERTY = "13731000-0000-4000-8000-000000000002";
const THREAD = "13731000-0000-4000-8000-000000000003";
const OTHER_THREAD = "13731000-0000-4000-8000-000000000004";
const ORGANIZATION = "13731000-0000-4000-8000-000000000005";
const ACTOR = "13731000-0000-4000-8000-000000000006";
const MEMBERSHIP = "13731000-0000-4000-8000-000000000007";
const EARLY = "13731000-0000-4000-8000-000000000008";
const BOUNDARY = "13731000-0000-4000-8000-000000000009";
const LATER = "13731000-0000-4000-8000-000000000010";
const OUTBOUND = "13731000-0000-4000-8000-000000000011";
const FOREIGN = "13731000-0000-4000-8000-000000000012";
const CONCURRENT = "13731000-0000-4000-8000-000000000013";
const NOW = "2026-09-03T09:00:00.000Z";
const MARK_READER_APPLICATION = "vay1373_mark_read_test";

describe.skipIf(!URL)("PostgreSQL PMS Inbox mark-read transaction", () => {
  const admin = new pg.Client({ connectionString: URL });
  const markReadConnection = URL ? new globalThis.URL(URL) : null;
  markReadConnection?.searchParams.set("application_name", MARK_READER_APPLICATION);
  const read = createPgPmsInboxMarkReadPort({
    connectionString: markReadConnection?.toString() ?? "postgresql://integration-test-disabled",
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
    await read.close();
    await cleanup();
    await admin.end();
  });

  it("marks only inbound messages through the named boundary and replays exactly", async () => {
    const input = command("read-through-boundary");
    const first = await read.markRead(input);
    await expect(read.markRead(input)).resolves.toEqual(first);
    expect(first).toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        readThroughMessageId: BOUNDARY,
        unreadCount: 1,
      },
    });

    const persisted = await state();
    expect(persisted.threadUnreadCount).toBe(1);
    expect(persisted.messages).toEqual([
      { id: EARLY, direction: "inbound", readAt: NOW },
      { id: OUTBOUND, direction: "outbound", readAt: null },
      { id: BOUNDARY, direction: "inbound", readAt: NOW },
      { id: LATER, direction: "inbound", readAt: null },
    ]);
    expect(persisted.counts).toEqual({ idempotency: 1, events: 1, audits: 1, outbox: 0 });
    const evidence = JSON.stringify([persisted.events, persisted.audits]);
    expect(evidence).not.toContain("read-through-boundary");
  });

  it("stores outbound and cross-thread boundaries as validation failures", async () => {
    for (const [key, readThroughMessageId] of [
      ["outbound", OUTBOUND],
      ["foreign", FOREIGN],
    ])
      await expect(read.markRead(command(key, { readThroughMessageId }))).resolves.toEqual({
        ok: false,
        error: {
          code: "validation_failed",
          message: "Read-through message must be an inbound message in this thread.",
        },
      });

    const persisted = await state();
    expect(persisted.threadUnreadCount).toBe(3);
    expect(persisted.messages.filter(({ readAt }) => readAt !== null)).toHaveLength(0);
    expect(persisted.counts).toEqual({ idempotency: 2, events: 0, audits: 0, outbox: 0 });
  });

  it("replays concurrent commands with the same key and payload once", async () => {
    const input = command("same-key-same-boundary");
    const [first, second] = await Promise.all([read.markRead(input), read.markRead(input)]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ ok: true, value: { unreadCount: 1 } });
    const persisted = await state();
    expect(persisted.counts).toEqual({ idempotency: 1, events: 1, audits: 1, outbox: 0 });
  });

  it("rejects one concurrent payload when the same key is reused", async () => {
    const [first, second] = await Promise.all([
      read.markRead(command("same-key-different-boundary", { readThroughMessageId: EARLY })),
      read.markRead(command("same-key-different-boundary", { readThroughMessageId: BOUNDARY })),
    ]);

    const results = [first, second];
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: {
          code: "idempotency_conflict",
          message: "Idempotency key was already used for a different mark-read command.",
        },
      },
    ]);
    const persisted = await state();
    expect(persisted.counts).toEqual({ idempotency: 1, events: 1, audits: 1, outbox: 0 });
  });

  it("keeps a concurrently accepted inbound message unread despite its older sent time", async () => {
    const blocker = new pg.Client({ connectionString: URL });
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT 1 FROM pms.message_threads
         WHERE property_id = $1::uuid AND id = $2::uuid FOR UPDATE`,
        [PROPERTY, THREAD],
      );
      const marking = read.markRead(command("concurrent-inbound"));
      await waitForMarkReadLock();
      await blocker.query(
        `INSERT INTO pms.messages
           (id, property_id, thread_id, source_message_id, direction, sender_type,
            body, sent_at, received_at, raw_payload)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'concurrent-inbound', 'inbound', 'guest',
                 'Concurrent', '2026-09-03T08:56:00.000Z', $4::timestamptz, '{}'::jsonb)`,
        [CONCURRENT, PROPERTY, THREAD, NOW],
      );
      await blocker.query(
        `UPDATE pms.message_threads SET unread_count = unread_count + 1
         WHERE property_id = $1::uuid AND id = $2::uuid`,
        [PROPERTY, THREAD],
      );
      await blocker.query("COMMIT");

      await expect(marking).resolves.toMatchObject({ ok: true, value: { unreadCount: 2 } });
      const persisted = await state();
      expect(persisted.threadUnreadCount).toBe(2);
      expect(persisted.messages).toEqual(
        expect.arrayContaining([
          { id: LATER, direction: "inbound", readAt: null },
          { id: CONCURRENT, direction: "inbound", readAt: null },
        ]),
      );
    } catch (error) {
      await blocker.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await blocker.end();
    }
  });

  function command(key: string, overrides: Record<string, unknown> = {}) {
    return {
      propertyId: PROPERTY,
      threadId: THREAD,
      organizationId: ORGANIZATION,
      actorUserId: ACTOR,
      actorMembershipId: MEMBERSHIP,
      idempotencyKey: key,
      readThroughMessageId: BOUNDARY,
      audit: { requestId: `request-${key}`, correlationId: "inbox-integration", requestedAt: NOW },
      ...overrides,
    };
  }

  async function waitForMarkReadLock(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await admin.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE application_name = $1 AND wait_event_type = 'Lock'
             AND query LIKE '%SELECT 1 FROM pms.message_threads%'
         ) AS waiting`,
        [MARK_READER_APPLICATION],
      );
      if (waiting.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Mark-read command did not reach the thread lock");
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'mark-reader@example.test', 'Front Desk', 'active')`,
      [ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Inbox Mark Read', 'inbox-mark-read', 'active')`,
      [ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'inbox-mark-read', 'Inbox Mark Read'),
              ($2::uuid, 'inbox-mark-read-other', 'Inbox Mark Read Other')`,
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
         ($1::uuid, $2::uuid, 'channex', 'mark-read-thread', 'needs_attention',
          'ota', 'unlinked', 3, 4),
         ($3::uuid, $4::uuid, 'channex', 'mark-read-other', 'needs_attention',
          'ota', 'unlinked', 1, 4)`,
      [THREAD, PROPERTY, OTHER_THREAD, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO pms.messages
         (id, property_id, thread_id, source_message_id, direction, sender_type,
          body, sent_at, received_at, raw_payload)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'early', 'inbound', 'guest',
          'Early', '2026-09-03T08:57:00.000Z', $9::timestamptz, '{}'::jsonb),
         ($4::uuid, $2::uuid, $3::uuid, 'boundary', 'inbound', 'guest',
          'Boundary', '2026-09-03T08:58:00.000Z', $9::timestamptz, '{}'::jsonb),
         ($5::uuid, $2::uuid, $3::uuid, 'later', 'inbound', 'guest',
          'Later', '2026-09-03T09:01:00.000Z', $9::timestamptz, '{}'::jsonb),
         ($6::uuid, $2::uuid, $3::uuid, 'outbound', 'outbound', 'property_user',
          'Reply', '2026-09-03T08:57:30.000Z', $9::timestamptz, '{}'::jsonb),
         ($7::uuid, $8::uuid, $10::uuid, 'foreign', 'inbound', 'guest',
          'Foreign', '2026-09-03T08:57:00.000Z', $9::timestamptz, '{}'::jsonb)`,
      [
        EARLY,
        PROPERTY,
        THREAD,
        BOUNDARY,
        LATER,
        OUTBOUND,
        FOREIGN,
        OTHER_PROPERTY,
        NOW,
        OTHER_THREAD,
      ],
    );
  }

  async function state() {
    const result = await admin.query(
      `SELECT
         (SELECT unread_count FROM pms.message_threads
          WHERE property_id = $1::uuid AND id = $2::uuid) AS "threadUnreadCount",
         (SELECT jsonb_agg(jsonb_build_object(
            'id', id::text, 'direction', direction,
            'readAt', CASE WHEN read_at IS NULL THEN NULL
              ELSE to_char(read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
            ORDER BY sent_at, id)
          FROM pms.messages WHERE property_id = $1::uuid AND thread_id = $2::uuid) AS messages,
         jsonb_build_object(
           'idempotency', (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid),
           'events', (SELECT count(*)::int FROM platform.domain_events WHERE property_id = $1::uuid),
           'audits', (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id = $1::uuid),
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
      threadUnreadCount: number;
      messages: Array<{ id: string; direction: string; readAt: string | null }>;
      counts: { idempotency: number; events: number; audits: number; outbox: number };
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
        "DELETE FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.messages WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])",
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
    throw new Error("Refusing to run Inbox mark-read tests outside a test database");
}
