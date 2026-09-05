import pg, { type QueryResultRow } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PmsInboxQuickReplyPort } from "./pmsInbox.js";
import {
  createPgPmsInboxQuickReplyPort,
  type PmsInboxQuickReplyPool,
} from "./pmsInboxQuickReply.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13736000-0000-4000-8000-000000000001";
const OTHER_PROPERTY = "13736000-0000-4000-8000-000000000002";
const THREAD = "13736000-0000-4000-8000-000000000003";
const INQUIRY_THREAD = "13736000-0000-4000-8000-000000000004";
const OTHER_THREAD = "13736000-0000-4000-8000-000000000005";
const BOOKING = "13736000-0000-4000-8000-000000000006";
const BOOKING_GUEST = "13736000-0000-4000-8000-000000000007";
const ORGANIZATION = "13736000-0000-4000-8000-000000000008";
const ACTOR = "13736000-0000-4000-8000-000000000009";
const MEMBERSHIP = "13736000-0000-4000-8000-000000000010";
const FOREIGN_QUICK_REPLY = "13736000-0000-4000-8000-000000000011";
const NOW = "2026-09-03T10:00:00.000Z";

type CreateInput = Parameters<PmsInboxQuickReplyPort["create"]>[0];

describe.skipIf(!URL)("PostgreSQL PMS Inbox quick replies", () => {
  const admin = new pg.Client({ connectionString: URL });
  const quickReplies = createPgPmsInboxQuickReplyPort({
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
    await quickReplies.close();
    await cleanup();
    await admin.end();
  });

  it("creates, lists, and replays one property-scoped quick reply", async () => {
    const input = create("create-once", {
      name: "  Welcome  ",
      text: "  Hello {{guest_first_name}}.  ",
      approvedVariables: ["guest_first_name"],
    });
    const first = await quickReplies.create(input);
    await expect(quickReplies.create(input)).resolves.toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      value: {
        propertyId: PROPERTY,
        quickReply: {
          name: "Welcome",
          text: "Hello {{guest_first_name}}.",
          approvedVariables: ["guest_first_name"],
          version: 1,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    });
    await expect(quickReplies.list({ propertyId: PROPERTY })).resolves.toEqual([
      (first as Extract<typeof first, { ok: true }>).value.quickReply,
    ]);

    const persisted = await state();
    expect(persisted.counts).toEqual({
      quickReplies: 1,
      idempotency: 1,
      events: 1,
      audits: 1,
      messages: 0,
      jobs: 0,
      outbox: 0,
    });
    expect(JSON.stringify([persisted.events, persisted.audits])).not.toContain(
      "Hello {{guest_first_name}}.",
    );
    expect(JSON.stringify([persisted.events, persisted.audits])).not.toContain("create-once");
  });

  it("does not release a replay client until rollback is complete", async () => {
    const input = create("delayed-rollback");
    const first = await quickReplies.create(input);
    if (!first.ok) throw new Error("fixture quick reply was not created");
    const backingPool = new pg.Pool({ connectionString: URL, max: 1 });
    let finishRollback!: () => void;
    let reportRollbackStarted!: () => void;
    let released = false;
    const rollbackGate = new Promise<void>((resolve) => {
      finishRollback = resolve;
    });
    const rollbackStarted = new Promise<void>((resolve) => {
      reportRollbackStarted = resolve;
    });
    const pool: PmsInboxQuickReplyPool = {
      query: async <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
        const result = await backingPool.query<T>(text, values ? [...values] : undefined);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      connect: async () => {
        const client = await backingPool.connect();
        return {
          query: async <T extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
            if (text === "ROLLBACK") {
              reportRollbackStarted();
              await rollbackGate;
            }
            const result = await client.query<T>(text, values ? [...values] : undefined);
            return { rows: result.rows, rowCount: result.rowCount };
          },
          release: () => {
            released = true;
            client.release();
          },
        };
      },
    };
    const replayPort = createPgPmsInboxQuickReplyPort({ connectionString: "", pool });
    try {
      const replay = replayPort.create(input);
      await rollbackStarted;
      expect(released).toBe(false);
      finishRollback();
      await expect(replay).resolves.toEqual(first);
      expect(released).toBe(true);
    } finally {
      finishRollback();
      await backingPool.end();
    }
  });

  it("updates with optimistic versioning and preserves the original replay", async () => {
    const created = await quickReplies.create(create("create"));
    if (!created.ok) throw new Error("fixture quick reply was not created");
    const quickReplyId = created.value.quickReply.id;
    const update = command("update", quickReplyId, {
      expectedVersion: 1,
      name: "Arrival details",
      text: "Arrive on {{arrival_date}}.",
      approvedVariables: ["arrival_date"],
    });
    const firstUpdate = await quickReplies.update(update);
    expect(firstUpdate).toMatchObject({
      ok: true,
      value: {
        quickReply: {
          id: quickReplyId,
          version: 2,
          name: "Arrival details",
          text: "Arrive on {{arrival_date}}.",
        },
      },
    });
    await expect(quickReplies.create(create("create"))).resolves.toEqual(created);
    await expect(quickReplies.update(update)).resolves.toEqual(firstUpdate);
    await expect(
      quickReplies.update(command("stale", quickReplyId, { expectedVersion: 1 })),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "quick_reply_version_conflict",
        message: "The quick reply changed. Refresh and try again.",
        currentVersion: 2,
      },
    });
  });

  it("serializes names case-insensitively and records one winner", async () => {
    const [first, second] = await Promise.all([
      quickReplies.create(create("first", { name: "Arrival" })),
      quickReplies.create(create("second", { name: "arrival" })),
    ]);
    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      {
        ok: false,
        error: {
          code: "quick_reply_name_conflict",
          message: "An active quick reply already uses this name.",
        },
      },
    ]);
    expect((await state()).counts).toMatchObject({
      quickReplies: 1,
      idempotency: 2,
      events: 1,
      audits: 1,
    });
  });

  it("archives without deleting audit history and permits deliberate name reuse", async () => {
    const created = await quickReplies.create(create("create", { name: "Welcome" }));
    if (!created.ok) throw new Error("fixture quick reply was not created");
    const quickReplyId = created.value.quickReply.id;
    const archive = command("archive", quickReplyId, { expectedVersion: 1 });
    const archived = await quickReplies.archive(archive);
    await expect(quickReplies.archive(archive)).resolves.toEqual(archived);
    expect(archived).toEqual({
      ok: true,
      value: { propertyId: PROPERTY, quickReplyId, version: 2, archivedAt: NOW },
    });
    await expect(quickReplies.list({ propertyId: PROPERTY })).resolves.toEqual([]);
    await expect(quickReplies.create(create("reuse", { name: "welcome" }))).resolves.toMatchObject({
      ok: true,
      value: { quickReply: { name: "welcome", version: 1 } },
    });
    expect((await state()).counts).toMatchObject({
      quickReplies: 2,
      idempotency: 3,
      events: 3,
      audits: 3,
    });
  });

  it("previews only approved target data and leaves unavailable variables unresolved", async () => {
    const created = await quickReplies.create(
      create("preview-template", {
        text:
          "Hi {{guest_first_name}}, welcome to {{property_name}} for {{nights}} nights. " +
          "Room {{room_number}}. {{unapproved}}",
        approvedVariables: ["guest_first_name", "property_name", "nights", "room_number"],
      }),
    );
    if (!created.ok) throw new Error("fixture quick reply was not created");
    const before = await state();
    const input = {
      ...actor("preview"),
      quickReplyId: created.value.quickReply.id,
      threadId: THREAD,
    };
    const preview = await quickReplies.preview(input);
    expect(preview).toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        quickReplyId: created.value.quickReply.id,
        threadId: THREAD,
        renderedText:
          "Hi Ada, welcome to Test Hotel for 3 nights. Room {{room_number}}. {{unapproved}}",
        unresolvedVariables: ["room_number", "unapproved"],
        composerUseAllowed: false,
      },
    });
    if (!preview.ok) throw new Error("fixture quick-reply preview failed");
    await expect(quickReplies.preview(input)).resolves.toEqual(preview);
    await expect(quickReplies.preview({ ...input, threadId: INQUIRY_THREAD })).resolves.toEqual({
      ok: false,
      error: {
        code: "idempotency_conflict",
        message: "Idempotency key was used for a different quick-reply command.",
      },
    });
    const after = await state();
    expect(after.counts).toEqual({
      ...before.counts,
      idempotency: before.counts.idempotency + 1,
      events: before.counts.events + 1,
      audits: before.counts.audits + 1,
    });
    expect(JSON.stringify([after.events, after.audits])).not.toContain("Ada");
    expect(JSON.stringify([after.events, after.audits])).not.toContain("Test Hotel");
    expect(JSON.stringify([after.events, after.audits])).not.toContain(preview.value.renderedText);
  });

  it("matches the unresolved-room fixture for an inquiry without inventing a booking", async () => {
    const created = await quickReplies.create(
      create("inquiry-template", {
        text: "Your room {{room_number}} is ready.",
        approvedVariables: ["room_number"],
      }),
    );
    if (!created.ok) throw new Error("fixture quick reply was not created");
    await expect(
      quickReplies.preview({
        ...actor("inquiry-preview"),
        quickReplyId: created.value.quickReply.id,
        threadId: INQUIRY_THREAD,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        quickReplyId: created.value.quickReply.id,
        threadId: INQUIRY_THREAD,
        renderedText: "Your room {{room_number}} is ready.",
        unresolvedVariables: ["room_number"],
        composerUseAllowed: false,
      },
    });
  });

  it("blocks malformed long placeholders instead of enabling composer use", async () => {
    const variable = "x".repeat(101);
    const text = `Unknown {{${variable}}}`;
    const created = await quickReplies.create(
      create("long-variable", { text, approvedVariables: [] }),
    );
    if (!created.ok) throw new Error("fixture quick reply was not created");
    await expect(
      quickReplies.preview({
        ...actor("long-variable-preview"),
        quickReplyId: created.value.quickReply.id,
        threadId: THREAD,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        quickReplyId: created.value.quickReply.id,
        threadId: THREAD,
        renderedText: text,
        unresolvedVariables: ["invalid_variable"],
        composerUseAllowed: false,
      },
    });
  });

  it("returns a stable validation result when substitutions exceed the composer bound", async () => {
    await admin.query(`UPDATE hotel_catalog.properties SET display_name = $2 WHERE id = $1::uuid`, [
      PROPERTY,
      "P".repeat(200),
    ]);
    const created = await quickReplies.create(
      create("expanding-template", {
        text: "{{property_name}}".repeat(1_000),
        approvedVariables: ["property_name"],
      }),
    );
    if (!created.ok) throw new Error("fixture quick reply was not created");
    const input = {
      ...actor("expanding-preview"),
      quickReplyId: created.value.quickReply.id,
      threadId: THREAD,
    };
    const expected = {
      ok: false as const,
      error: {
        code: "validation_failed" as const,
        message: "Rendered Inbox quick reply exceeds the maximum length.",
      },
    };
    await expect(quickReplies.preview(input)).resolves.toEqual(expected);
    await expect(quickReplies.preview(input)).resolves.toEqual(expected);
    expect((await state()).counts).toMatchObject({
      idempotency: 2,
      events: 1,
      audits: 1,
      messages: 0,
      jobs: 0,
      outbox: 0,
    });
  });

  it("rechecks current Inbox permissions before mutation, replay, or guest-context preview", async () => {
    const input = create("authorized");
    const created = await quickReplies.create(input);
    if (!created.ok) throw new Error("fixture quick reply was not created");
    await admin.query(
      `UPDATE identity.organization_memberships
       SET permission_overrides = '{"grant":[],"deny":["pms.inbox.read","pms.inbox.reply"]}'::jsonb
       WHERE id = $1::uuid`,
      [MEMBERSHIP],
    );

    await expect(quickReplies.create(input)).rejects.toThrow(
      "PMS Inbox quick-reply command failed",
    );
    await expect(quickReplies.create(create("revoked-create"))).rejects.toThrow(
      "PMS Inbox quick-reply command failed",
    );
    await expect(
      quickReplies.preview({
        ...actor("revoked-preview"),
        quickReplyId: created.value.quickReply.id,
        threadId: THREAD,
      }),
    ).rejects.toThrow("PMS Inbox quick-reply preview failed");
    expect((await state()).counts).toMatchObject({
      quickReplies: 1,
      idempotency: 1,
      events: 1,
      audits: 1,
    });
  });

  it("never reads or mutates another property's quick replies or threads", async () => {
    await expect(
      quickReplies.preview({
        ...actor("foreign-quick-reply"),
        quickReplyId: FOREIGN_QUICK_REPLY,
        threadId: THREAD,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "quick_reply_not_found", message: "Inbox quick reply was not found." },
    });
    const created = await quickReplies.create(create("local"));
    if (!created.ok) throw new Error("fixture quick reply was not created");
    await expect(
      quickReplies.preview({
        ...actor("foreign-thread"),
        quickReplyId: created.value.quickReply.id,
        threadId: OTHER_THREAD,
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "thread_not_found", message: "Inbox thread was not found." },
    });
    await expect(quickReplies.list({ propertyId: PROPERTY })).resolves.toHaveLength(1);
    await expect(quickReplies.list({ propertyId: OTHER_PROPERTY })).resolves.toEqual([
      expect.objectContaining({ propertyId: OTHER_PROPERTY, id: FOREIGN_QUICK_REPLY }),
    ]);
  });

  function actor(key: string) {
    return {
      propertyId: PROPERTY,
      organizationId: ORGANIZATION,
      actorUserId: ACTOR,
      actorMembershipId: MEMBERSHIP,
      idempotencyKey: key,
      audit: { requestId: `request-${key}`, correlationId: "inbox-quick-reply", requestedAt: NOW },
    };
  }

  function create(key: string, overrides: Partial<CreateInput> = {}): CreateInput {
    return {
      ...actor(key),
      name: "Welcome",
      text: "Welcome to {{property_name}}.",
      approvedVariables: ["property_name"],
      ...overrides,
    };
  }

  function command(
    key: string,
    quickReplyId: string,
    overrides: Partial<Parameters<PmsInboxQuickReplyPort["update"]>[0]> = {},
  ): Parameters<PmsInboxQuickReplyPort["update"]>[0] {
    return {
      ...actor(key),
      quickReplyId,
      expectedVersion: 1,
      name: "Welcome",
      text: "Welcome to {{property_name}}.",
      approvedVariables: ["property_name"],
      ...overrides,
    };
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'quick-reply-actor@example.test', 'Front Desk', 'active')`,
      [ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Inbox Quick Replies', 'inbox-quick-replies', 'active')`,
      [ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'inbox-quick-replies', 'Test Hotel'),
              ($2::uuid, 'inbox-quick-replies-other', 'Other Hotel')`,
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
      `INSERT INTO booking.guest_bookings
         (id, property_id, public_reference, lifecycle_status, check_in, check_out, currency)
       VALUES ($1::uuid, $2::uuid, 'BOOK-QUICK-1', 'confirmed', '2026-09-10', '2026-09-13', 'EUR')`,
      [BOOKING, PROPERTY],
    );
    await admin.query(
      `INSERT INTO booking.booking_guests
         (id, guest_booking_id, guest_role, first_name, last_name, email)
       VALUES ($1::uuid, $2::uuid, 'booker', 'Ada', 'Lovelace', 'ada@example.test')`,
      [BOOKING_GUEST, BOOKING],
    );
    await admin.query(
      `INSERT INTO pms.message_threads
         (id, property_id, guest_booking_id, source, source_thread_id, attention_state,
          delivery_channel, conversation_context_state, unread_count, version,
          inquiry_arrival_date, inquiry_departure_date)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'channex', 'quick-thread', 'needs_attention',
          'ota', 'linked', 1, 1, NULL, NULL),
         ($4::uuid, $2::uuid, NULL, 'channex', 'quick-inquiry', 'needs_attention',
          'ota', 'inquiry', 1, 1, '2026-09-20', '2026-09-22'),
         ($5::uuid, $6::uuid, NULL, 'channex', 'quick-other', 'needs_attention',
          'ota', 'unlinked', 1, 1, NULL, NULL)`,
      [THREAD, PROPERTY, BOOKING, INQUIRY_THREAD, OTHER_THREAD, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO pms.message_quick_replies
         (id, property_id, name, body_template, approved_variables,
          created_by_membership_id, updated_by_membership_id)
       VALUES ($1::uuid, $2::uuid, 'Foreign', 'Foreign body', '{}', $3::uuid, $3::uuid)`,
      [FOREIGN_QUICK_REPLY, OTHER_PROPERTY, MEMBERSHIP],
    );
  }

  async function state() {
    const result = await admin.query(
      `SELECT jsonb_build_object(
         'quickReplies', (SELECT count(*)::int FROM pms.message_quick_replies WHERE property_id = $1::uuid),
         'idempotency', (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid),
         'events', (SELECT count(*)::int FROM platform.domain_events WHERE property_id = $1::uuid),
         'audits', (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id = $1::uuid),
         'messages', (SELECT count(*)::int FROM pms.messages WHERE property_id = $1::uuid),
         'jobs', (SELECT count(*)::int FROM platform.jobs WHERE property_id = $1::uuid),
         'outbox', (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid)
       ) AS counts,
       (SELECT jsonb_agg(jsonb_build_object('payload', payload, 'metadata', event_metadata))
        FROM platform.domain_events WHERE property_id = $1::uuid) AS events,
       (SELECT jsonb_agg(jsonb_build_object(
          'redactedPayload', redacted_payload, 'metadata', audit_metadata))
        FROM platform.product_audit_events WHERE property_id = $1::uuid) AS audits`,
      [PROPERTY],
    );
    return result.rows[0] as {
      counts: {
        quickReplies: number;
        idempotency: number;
        events: number;
        audits: number;
        messages: number;
        jobs: number;
        outbox: number;
      };
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
        "DELETE FROM pms.message_quick_replies WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.messages WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.jobs WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
      ])
        await admin.query(statement, [properties]);
      await admin.query("DELETE FROM booking.booking_guests WHERE guest_booking_id = $1::uuid", [
        BOOKING,
      ]);
      await admin.query("DELETE FROM booking.guest_bookings WHERE id = $1::uuid", [BOOKING]);
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
    throw new Error("Refusing to run Inbox quick-reply tests outside a test database");
}
