import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PmsInboxStaffCommandPort } from "./pmsInbox.js";
import { createPgPmsInboxStaffCommandPort } from "./pmsInboxStaffCommand.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13734000-0000-4000-8000-000000000001";
const OTHER_PROPERTY = "13734000-0000-4000-8000-000000000002";
const THREAD = "13734000-0000-4000-8000-000000000003";
const OTHER_THREAD = "13734000-0000-4000-8000-000000000004";
const ORGANIZATION = "13734000-0000-4000-8000-000000000005";
const ACTOR = "13734000-0000-4000-8000-000000000006";
const ACTOR_MEMBERSHIP = "13734000-0000-4000-8000-000000000007";
const ASSIGNEE_USER = "13734000-0000-4000-8000-000000000008";
const ASSIGNEE_MEMBERSHIP = "13734000-0000-4000-8000-000000000009";
const INELIGIBLE_USER = "13734000-0000-4000-8000-000000000010";
const INELIGIBLE_MEMBERSHIP = "13734000-0000-4000-8000-000000000011";
const NOW = "2026-09-03T09:00:00.000Z";

type AssignInput = Parameters<PmsInboxStaffCommandPort["assign"]>[0];
type NoteInput = Parameters<PmsInboxStaffCommandPort["addNote"]>[0];

describe.skipIf(!URL)("PostgreSQL PMS Inbox staff-command transactions", () => {
  const admin = new pg.Client({ connectionString: URL });
  const commands = createPgPmsInboxStaffCommandPort({
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
    await commands.close();
    await cleanup();
    await admin.end();
  });

  it("assigns and clears eligible staff with one mutation per key", async () => {
    const input = assignment("assign", { assigneeMembershipId: ASSIGNEE_MEMBERSHIP });
    const first = await commands.assign(input);
    await expect(commands.assign(input)).resolves.toEqual(first);
    expect(first).toEqual({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        assignedTo: { membershipId: ASSIGNEE_MEMBERSHIP, displayName: "Night Manager" },
        threadVersion: 5,
      },
    });
    await expect(
      commands.assign(
        assignment("clear", { expectedThreadVersion: 5, assigneeMembershipId: null }),
      ),
    ).resolves.toMatchObject({ ok: true, value: { assignedTo: null, threadVersion: 6 } });

    const persisted = await state();
    expect(persisted.thread).toMatchObject({ assignedToMembershipId: null, version: "6" });
    expect(persisted.counts).toEqual({
      idempotency: 2,
      events: 2,
      audits: 2,
      notes: 0,
      jobs: 0,
      outbox: 0,
    });
    const evidence = JSON.stringify([persisted.events, persisted.audits]);
    expect(evidence).not.toContain('"assign"');
    expect(evidence).not.toContain('"clear"');
  });

  it("stores an ineligible assignee result without changing the thread", async () => {
    const input = assignment("ineligible", { assigneeMembershipId: INELIGIBLE_MEMBERSHIP });
    const expected = {
      ok: false as const,
      error: {
        code: "validation_failed" as const,
        message: "Assignee must have active access to this property.",
      },
    };
    await expect(commands.assign(input)).resolves.toEqual(expected);
    await expect(commands.assign(input)).resolves.toEqual(expected);

    const persisted = await state();
    expect(persisted.thread).toMatchObject({ assignedToMembershipId: null, version: "4" });
    expect(persisted.counts).toEqual({
      idempotency: 1,
      events: 0,
      audits: 0,
      notes: 0,
      jobs: 0,
      outbox: 0,
    });
  });

  it("adds and replays one canonical internal note without copying content into evidence", async () => {
    const input = note("note-once", { text: "  Guest prefers a quiet room.  " });
    const first = await commands.addNote(input);
    await expect(commands.addNote(input)).resolves.toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      value: {
        propertyId: PROPERTY,
        threadId: THREAD,
        note: {
          author: { membershipId: ACTOR_MEMBERSHIP, displayName: "Front Desk" },
          text: "Guest prefers a quiet room.",
          occurredAt: NOW,
        },
        threadVersion: 5,
      },
    });

    const persisted = await state();
    expect(persisted.thread).toMatchObject({ version: "5", lastInternalNoteAt: NOW });
    expect(persisted.notes).toEqual([
      expect.objectContaining({
        authorMembershipId: ACTOR_MEMBERSHIP,
        authorDisplayName: "Front Desk",
        text: "Guest prefers a quiet room.",
        occurredAt: NOW,
      }),
    ]);
    expect(persisted.counts).toEqual({
      idempotency: 1,
      events: 1,
      audits: 1,
      notes: 1,
      jobs: 0,
      outbox: 0,
    });
    expect(
      JSON.stringify([persisted.events, persisted.audits, persisted.idempotency]),
    ).not.toContain("Guest prefers a quiet room.");
    expect(JSON.stringify([persisted.events, persisted.audits])).not.toContain("note-once");
  });

  it("allows the same opaque key for distinct assignment and note operations", async () => {
    await expect(
      commands.assign(assignment("shared", { assigneeMembershipId: ASSIGNEE_MEMBERSHIP })),
    ).resolves.toMatchObject({ ok: true, value: { threadVersion: 5 } });
    await expect(
      commands.addNote(note("shared", { expectedThreadVersion: 5 })),
    ).resolves.toMatchObject({ ok: true, value: { threadVersion: 6 } });

    expect((await state()).counts).toEqual({
      idempotency: 2,
      events: 2,
      audits: 2,
      notes: 1,
      jobs: 0,
      outbox: 0,
    });
  });

  it("serializes concurrent same-key notes into one note and evidence set", async () => {
    const input = note("same-note");
    const [first, second] = await Promise.all([commands.addNote(input), commands.addNote(input)]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ ok: true, value: { threadVersion: 5 } });
    expect((await state()).counts).toEqual({
      idempotency: 1,
      events: 1,
      audits: 1,
      notes: 1,
      jobs: 0,
      outbox: 0,
    });
  });

  it("allows only one different command with the same expected thread version", async () => {
    const [assigned, noted] = await Promise.all([
      commands.assign(assignment("race-assignment", { assigneeMembershipId: ASSIGNEE_MEMBERSHIP })),
      commands.addNote(note("race-note")),
    ]);
    const results = [assigned, noted];
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
    const persisted = await state();
    expect(persisted.thread.version).toBe("5");
    expect(persisted.counts).toMatchObject({ idempotency: 2, events: 1, audits: 1 });
    expect(persisted.counts.notes).toBe(noted.ok ? 1 : 0);
  });

  it("does not mutate a foreign property's thread", async () => {
    await expect(
      commands.assign(assignment("foreign-thread", { threadId: OTHER_THREAD })),
    ).resolves.toEqual({
      ok: false,
      error: { code: "thread_not_found", message: "Inbox thread was not found." },
    });
    await expect(
      commands.addNote(note("foreign-note", { threadId: OTHER_THREAD })),
    ).resolves.toEqual({
      ok: false,
      error: { code: "thread_not_found", message: "Inbox thread was not found." },
    });
    await expect(
      admin.query(
        `SELECT version::text, assigned_to_membership_id::text AS "assignedToMembershipId"
         FROM pms.message_threads WHERE property_id = $1::uuid AND id = $2::uuid`,
        [OTHER_PROPERTY, OTHER_THREAD],
      ),
    ).resolves.toMatchObject({ rows: [{ version: "4", assignedToMembershipId: null }] });
    expect((await state()).counts).toMatchObject({
      idempotency: 2,
      events: 0,
      audits: 0,
      notes: 0,
    });
  });

  function assignment(key: string, overrides: Partial<AssignInput> = {}): AssignInput {
    return {
      propertyId: PROPERTY,
      threadId: THREAD,
      organizationId: ORGANIZATION,
      actorUserId: ACTOR,
      actorMembershipId: ACTOR_MEMBERSHIP,
      idempotencyKey: key,
      expectedThreadVersion: 4,
      assigneeMembershipId: null,
      audit: { requestId: `request-${key}`, correlationId: "inbox-staff", requestedAt: NOW },
      ...overrides,
    };
  }

  function note(key: string, overrides: Partial<NoteInput> = {}): NoteInput {
    return {
      propertyId: PROPERTY,
      threadId: THREAD,
      organizationId: ORGANIZATION,
      actorUserId: ACTOR,
      actorMembershipId: ACTOR_MEMBERSHIP,
      idempotencyKey: key,
      expectedThreadVersion: 4,
      text: "Prepare late arrival.",
      audit: { requestId: `request-${key}`, correlationId: "inbox-staff", requestedAt: NOW },
      ...overrides,
    };
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES
         ($1::uuid, 'staff-actor@example.test', 'Front Desk', 'active'),
         ($2::uuid, 'staff-assignee@example.test', 'Night Manager', 'active'),
         ($3::uuid, 'staff-ineligible@example.test', 'Other Property', 'active')`,
      [ACTOR, ASSIGNEE_USER, INELIGIBLE_USER],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Inbox Staff', 'inbox-staff', 'active')`,
      [ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'inbox-staff', 'Inbox Staff'),
              ($2::uuid, 'inbox-staff-other', 'Inbox Staff Other')`,
      [PROPERTY, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO identity.organization_memberships
         (id, organization_id, user_id, status, role_key, property_access_mode, access_origin)
       VALUES
         ($1::uuid, $4::uuid, $5::uuid, 'active', 'owner', 'all', 'agency'),
         ($2::uuid, $4::uuid, $6::uuid, 'active', 'manager', 'assigned', 'agency'),
         ($3::uuid, $4::uuid, $7::uuid, 'active', 'manager', 'assigned', 'agency')`,
      [
        ACTOR_MEMBERSHIP,
        ASSIGNEE_MEMBERSHIP,
        INELIGIBLE_MEMBERSHIP,
        ORGANIZATION,
        ACTOR,
        ASSIGNEE_USER,
        INELIGIBLE_USER,
      ],
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
      `INSERT INTO identity.membership_property_assignments (membership_id, property_id)
       VALUES ($1::uuid, $3::uuid), ($2::uuid, $4::uuid)`,
      [ASSIGNEE_MEMBERSHIP, INELIGIBLE_MEMBERSHIP, PROPERTY, OTHER_PROPERTY],
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
         ($1::uuid, $2::uuid, 'channex', 'staff-thread', 'needs_attention',
          'ota', 'unlinked', 1, 4),
         ($3::uuid, $4::uuid, 'channex', 'staff-thread-other', 'needs_attention',
          'ota', 'unlinked', 1, 4)`,
      [THREAD, PROPERTY, OTHER_THREAD, OTHER_PROPERTY],
    );
  }

  async function state() {
    const result = await admin.query(
      `SELECT
         (SELECT jsonb_build_object(
            'version', version::text,
            'assignedToMembershipId', assigned_to_membership_id::text,
            'lastInternalNoteAt', CASE WHEN last_internal_note_at IS NULL THEN NULL
              ELSE to_char(last_internal_note_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END)
          FROM pms.message_threads WHERE property_id = $1::uuid AND id = $2::uuid) AS thread,
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', id::text, 'authorMembershipId', author_membership_id::text,
            'authorDisplayName', author_display_name, 'text', body,
            'occurredAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
            ORDER BY created_at, id)
          FROM pms.message_internal_notes WHERE property_id = $1::uuid), '[]'::jsonb) AS notes,
         jsonb_build_object(
           'idempotency', (SELECT count(*)::int FROM platform.idempotency_keys WHERE property_id = $1::uuid),
           'events', (SELECT count(*)::int FROM platform.domain_events WHERE property_id = $1::uuid),
           'audits', (SELECT count(*)::int FROM platform.product_audit_events WHERE property_id = $1::uuid),
           'notes', (SELECT count(*)::int FROM pms.message_internal_notes WHERE property_id = $1::uuid),
           'jobs', (SELECT count(*)::int FROM platform.jobs WHERE property_id = $1::uuid),
           'outbox', (SELECT count(*)::int FROM platform.outbox_events WHERE property_id = $1::uuid)
         ) AS counts,
         (SELECT jsonb_agg(jsonb_build_object('payload', payload, 'metadata', event_metadata))
          FROM platform.domain_events WHERE property_id = $1::uuid) AS events,
         (SELECT jsonb_agg(jsonb_build_object(
            'redactedPayload', redacted_payload, 'metadata', audit_metadata))
          FROM platform.product_audit_events WHERE property_id = $1::uuid) AS audits,
         (SELECT jsonb_agg(idempotency_metadata)
          FROM platform.idempotency_keys WHERE property_id = $1::uuid) AS idempotency`,
      [PROPERTY, THREAD],
    );
    return result.rows[0] as {
      thread: {
        version: string;
        assignedToMembershipId: string | null;
        lastInternalNoteAt: string | null;
      };
      notes: Array<{
        id: string;
        authorMembershipId: string;
        authorDisplayName: string;
        text: string;
        occurredAt: string;
      }>;
      counts: {
        idempotency: number;
        events: number;
        audits: number;
        notes: number;
        jobs: number;
        outbox: number;
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
        "DELETE FROM pms.message_internal_notes WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.jobs WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
      ])
        await admin.query(statement, [properties]);
      await admin.query(
        "DELETE FROM identity.membership_property_assignments WHERE membership_id = ANY($1::uuid[])",
        [[ASSIGNEE_MEMBERSHIP, INELIGIBLE_MEMBERSHIP]],
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
      await admin.query("DELETE FROM identity.users WHERE id = ANY($1::uuid[])", [
        [ACTOR, ASSIGNEE_USER, INELIGIBLE_USER],
      ]);
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK");
      throw error;
    }
  }
});

function assertSafeTestDatabase(connectionString: string): void {
  if (!/(^|[_-])(test|verify)([_-]|$)/i.test(new globalThis.URL(connectionString).pathname))
    throw new Error("Refusing to run Inbox staff-command tests outside a test database");
}
