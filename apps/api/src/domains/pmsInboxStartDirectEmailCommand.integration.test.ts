import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PmsInboxEmailReplyRouteReadPort, PmsInboxStartDirectEmailPort } from "./pmsInbox.js";
import { createPgPmsInboxStartDirectEmailPort } from "./pmsInboxStartDirectEmailCommand.js";

const URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "13736100-0000-4000-8000-000000000011";
const OTHER_PROPERTY = "13736100-0000-4000-8000-000000000012";
const BOOKING = "13736100-0000-4000-8000-000000000013";
const OTA_BOOKING = "13736100-0000-4000-8000-000000000014";
const OTHER_BOOKING = "13736100-0000-4000-8000-000000000015";
const ORGANIZATION = "13736100-0000-4000-8000-000000000016";
const ACTOR = "13736100-0000-4000-8000-000000000017";
const MEMBERSHIP = "13736100-0000-4000-8000-000000000018";
const NOW = "2026-09-03T12:00:00.000Z";
const OPERATION = "pms.inbox.thread.start_direct_email";
const EVENT_TYPE = "pms.inbox.thread.direct_email_started";

type Input = Parameters<PmsInboxStartDirectEmailPort["start"]>[0];

describe.skipIf(!URL)("PostgreSQL PMS Inbox direct-email thread", () => {
  const admin = new pg.Client({ connectionString: URL });
  let clock = NOW;
  const emailReplyRoutes: PmsInboxEmailReplyRouteReadPort = {
    async resolveReplyRoutes({ propertyId, threads }) {
      return threads.map(({ threadId, guestEmail }) => ({
        propertyId,
        threadId,
        route: guestEmail
          ? {
              state: "ready" as const,
              channel: "email" as const,
              providerChannel: null,
              reasonCode: null,
            }
          : {
              state: "held" as const,
              channel: null,
              providerChannel: null,
              reasonCode: "guest_email_unavailable" as const,
            },
      }));
    },
  };
  const command = createPgPmsInboxStartDirectEmailPort({
    connectionString: URL ?? "postgresql://integration-test-disabled",
    emailReplyRoutes,
    max: 4,
    now: () => new Date(clock),
  });

  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    await admin.connect();
  });

  beforeEach(async () => {
    clock = NOW;
    await cleanup();
    await seed();
  });

  afterAll(async () => {
    await command.close();
    await cleanup();
    await admin.end();
  });

  it("creates and replays one linked direct-email thread without messages or jobs", async () => {
    const input = start("create-direct");
    const first = await command.start(input);
    await expect(command.start(input)).resolves.toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      value: {
        propertyId: PROPERTY,
        bookingId: BOOKING,
        created: true,
        thread: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          source: "manual",
          sourceThreadId: `direct-email:${BOOKING}:v1`,
          attentionState: "needs_attention",
          channel: "email",
          version: 1,
          activityAt: NOW,
          replyRoute: {
            state: "ready",
            channel: "email",
            providerChannel: null,
            reasonCode: null,
          },
        },
      },
    });
    expect(await state()).toMatchObject({
      counts: { idempotency: 1, threads: 1, events: 1, audits: 1, messages: 0, jobs: 0 },
      thread: {
        guestBookingId: BOOKING,
        source: "manual",
        sourceThreadId: `direct-email:${BOOKING}:v1`,
        attentionState: "needs_attention",
        deliveryChannel: "email",
        version: "1",
      },
    });
  });

  it("returns the deterministic existing thread for a new key", async () => {
    const created = await command.start(start("first-key"));
    const existing = await command.start(start("second-key"));
    expect(created).toMatchObject({ ok: true, value: { created: true } });
    expect(existing).toMatchObject({
      ok: true,
      value: {
        created: false,
        thread: { id: created.ok ? created.value.thread.id : "unreachable" },
      },
    });
    expect((await state()).counts).toEqual({
      idempotency: 2,
      threads: 1,
      events: 1,
      audits: 1,
      messages: 0,
      jobs: 0,
    });
  });

  it("rejects OTA, pre-confirmation, and cross-property reservations", async () => {
    await expect(command.start({ ...start("ota"), bookingId: OTA_BOOKING })).resolves.toMatchObject(
      {
        ok: false,
        error: { code: "direct_email_not_allowed" },
      },
    );
    await admin.query(
      "UPDATE booking.guest_bookings SET lifecycle_status = 'pending_payment' WHERE id = $1::uuid",
      [BOOKING],
    );
    await expect(command.start(start("pending"))).resolves.toMatchObject({
      ok: false,
      error: { code: "direct_email_not_allowed" },
    });
    await expect(
      command.start({ ...start("foreign"), bookingId: OTHER_BOOKING }),
    ).resolves.toMatchObject({ ok: false, error: { code: "direct_email_not_allowed" } });
    expect((await state()).counts).toEqual({
      idempotency: 3,
      threads: 0,
      events: 0,
      audits: 0,
      messages: 0,
      jobs: 0,
    });
    expect((await state(OTHER_PROPERTY)).counts).toEqual({
      idempotency: 0,
      threads: 0,
      events: 0,
      audits: 0,
      messages: 0,
      jobs: 0,
    });
  });

  it("creates a visible held thread when the guest email is unavailable", async () => {
    await admin.query(
      "UPDATE booking.booking_guests SET email = NULL WHERE guest_booking_id = $1",
      [BOOKING],
    );
    await expect(command.start(start("held"))).resolves.toMatchObject({
      ok: true,
      value: {
        created: true,
        thread: {
          replyRoute: {
            state: "held",
            channel: null,
            reasonCode: "guest_email_unavailable",
          },
        },
      },
    });
    expect((await state()).counts).toMatchObject({ threads: 1, messages: 0, jobs: 0 });
  });

  it("canonicalizes adapter output before persisting the replay result", async () => {
    const adapter: PmsInboxEmailReplyRouteReadPort = {
      async resolveReplyRoutes({ propertyId, threads }) {
        return threads.map(({ threadId }) => ({
          propertyId,
          threadId,
          route: {
            state: "ready",
            channel: "email",
            providerChannel: null,
            reasonCode: null,
            privateAdapterValue: "must-not-persist",
          } as unknown as Awaited<
            ReturnType<PmsInboxEmailReplyRouteReadPort["resolveReplyRoutes"]>
          >[number]["route"],
        }));
      },
    };
    const canonicalCommand = createPgPmsInboxStartDirectEmailPort({
      connectionString: URL!,
      emailReplyRoutes: adapter,
      now: () => new Date(clock),
    });
    try {
      await expect(canonicalCommand.start(start("canonical-route"))).resolves.toMatchObject({
        ok: true,
        value: { thread: { replyRoute: { state: "ready", channel: "email" } } },
      });
      const stored = await admin.query<{ metadata: string }>(
        `SELECT idempotency_metadata::text AS metadata
         FROM platform.idempotency_keys
         WHERE property_id = $1::uuid AND operation = $2`,
        [PROPERTY, OPERATION],
      );
      expect(stored.rows[0]?.metadata).not.toContain("must-not-persist");
    } finally {
      await canonicalCommand.close();
    }
  });

  it("rolls back an invalid reply route instead of persisting it", async () => {
    const adapter: PmsInboxEmailReplyRouteReadPort = {
      async resolveReplyRoutes({ propertyId, threads }) {
        return threads.map(({ threadId }) => ({
          propertyId,
          threadId,
          route: {
            state: "held",
            channel: null,
            providerChannel: null,
            reasonCode: {
              privateAdapterValue: "must-not-persist",
              toString: () => "approved_sender_unavailable",
            },
          } as unknown as Awaited<
            ReturnType<PmsInboxEmailReplyRouteReadPort["resolveReplyRoutes"]>
          >[number]["route"],
        }));
      },
    };
    const invalidCommand = createPgPmsInboxStartDirectEmailPort({
      connectionString: URL!,
      emailReplyRoutes: adapter,
      now: () => new Date(clock),
    });
    try {
      await expect(invalidCommand.start(start("invalid-route"))).rejects.toThrow(
        "PMS Inbox direct-email command failed",
      );
      expect((await state()).counts).toEqual({
        idempotency: 0,
        threads: 0,
        events: 0,
        audits: 0,
        messages: 0,
        jobs: 0,
      });
    } finally {
      await invalidCommand.close();
    }
  });

  it("anchors idempotency completion and expiry to command completion", async () => {
    const completedAt = "2026-09-03T12:07:00.000Z";
    const adapter: PmsInboxEmailReplyRouteReadPort = {
      async resolveReplyRoutes(input) {
        clock = completedAt;
        return emailReplyRoutes.resolveReplyRoutes(input);
      },
    };
    const delayedCommand = createPgPmsInboxStartDirectEmailPort({
      connectionString: URL!,
      emailReplyRoutes: adapter,
      now: () => new Date(clock),
    });
    try {
      await expect(delayedCommand.start(start("completion-time"))).resolves.toMatchObject({
        ok: true,
      });
      const stored = await admin.query<{
        firstSeenAt: Date;
        completedAt: Date;
        expiresAt: Date;
      }>(
        `SELECT first_seen_at AS "firstSeenAt", completed_at AS "completedAt",
                expires_at AS "expiresAt"
         FROM platform.idempotency_keys
         WHERE property_id = $1::uuid AND operation = $2`,
        [PROPERTY, OPERATION],
      );
      expect(stored.rows[0]?.firstSeenAt.toISOString()).toBe(NOW);
      expect(stored.rows[0]?.completedAt.toISOString()).toBe(completedAt);
      expect(stored.rows[0]?.expiresAt.toISOString()).toBe("2026-10-03T12:07:00.000Z");
    } finally {
      await delayedCommand.close();
    }
  });

  it("serializes different keys into one thread and one creation event", async () => {
    const [first, second] = await Promise.all([
      command.start(start("concurrent-a")),
      command.start(start("concurrent-b")),
    ]);
    expect([first, second].filter((result) => result.ok && result.value.created)).toHaveLength(1);
    expect([first, second].filter((result) => result.ok && !result.value.created)).toHaveLength(1);
    expect((await state()).counts).toEqual({
      idempotency: 2,
      threads: 1,
      events: 1,
      audits: 1,
      messages: 0,
      jobs: 0,
    });
  });

  it("returns fingerprint conflicts and rejects invalid direct input", async () => {
    await expect(command.start(start("shared"))).resolves.toMatchObject({ ok: true });
    await expect(
      command.start({ ...start("shared"), bookingId: OTA_BOOKING }),
    ).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
    await expect(command.start({ ...start("invalid"), idempotencyKey: "" })).resolves.toEqual({
      ok: false,
      error: { code: "validation_failed", message: "Direct-email thread request is invalid." },
    });
    expect((await state()).counts).toMatchObject({ threads: 1, events: 1, audits: 1 });
  });

  function start(idempotencyKey: string): Input {
    return {
      propertyId: PROPERTY,
      bookingId: BOOKING,
      organizationId: ORGANIZATION,
      actorUserId: ACTOR,
      actorMembershipId: MEMBERSHIP,
      idempotencyKey,
      audit: {
        requestId: "request-direct-email",
        correlationId: "inbox-direct-email",
        requestedAt: NOW,
      },
    };
  }

  async function seed(): Promise<void> {
    await admin.query(
      `INSERT INTO identity.users (id, email, name, status)
       VALUES ($1::uuid, 'direct-email@example.test', 'Front Desk', 'active')`,
      [ACTOR],
    );
    await admin.query(
      `INSERT INTO identity.organizations (id, kind, name, slug, status)
       VALUES ($1::uuid, 'hotel_group', 'Inbox Direct Email', 'inbox-direct-email', 'active')`,
      [ORGANIZATION],
    );
    await admin.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1::uuid, 'inbox-direct-email', 'Direct Email Hotel'),
              ($2::uuid, 'inbox-direct-email-other', 'Other Direct Email Hotel')`,
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
              ($1::uuid, 'pms', 'pms_property', $3::uuid::text, 'owner', 'active')`,
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
      `INSERT INTO booking.guest_bookings
         (id, property_id, public_reference, source_system, source_booking_id, lifecycle_status,
          check_in, check_out, currency, booking_channel, direct_booking_source)
       VALUES ($1::uuid, $4::uuid, 'DIRECT-1', 'booking', NULL, 'confirmed',
               '2026-09-04', '2026-09-06', 'EUR', 'direct', 'booking_engine'),
              ($2::uuid, $4::uuid, 'OTA-1', 'migration', 'ota-1', 'confirmed',
               '2026-09-04', '2026-09-06', 'EUR', 'booking_com', NULL),
              ($3::uuid, $5::uuid, 'DIRECT-OTHER', 'booking', NULL, 'confirmed',
               '2026-09-04', '2026-09-06', 'EUR', 'direct', 'booking_engine')`,
      [BOOKING, OTA_BOOKING, OTHER_BOOKING, PROPERTY, OTHER_PROPERTY],
    );
    await admin.query(
      `INSERT INTO booking.booking_guests
         (guest_booking_id, guest_role, first_name, last_name, email)
       VALUES ($1::uuid, 'booker', 'Direct', 'Guest', 'guest@example.test'),
              ($2::uuid, 'booker', 'OTA', 'Guest', 'ota@example.test'),
              ($3::uuid, 'booker', 'Other', 'Guest', 'other@example.test')`,
      [BOOKING, OTA_BOOKING, OTHER_BOOKING],
    );
  }

  async function state(propertyId = PROPERTY) {
    const result = await admin.query(
      `SELECT jsonb_build_object(
         'idempotency', (SELECT count(*)::int FROM platform.idempotency_keys
                         WHERE property_id = $1::uuid AND operation = $2),
         'threads', (SELECT count(*)::int FROM pms.message_threads
                     WHERE property_id = $1::uuid AND source = 'manual'),
         'events', (SELECT count(*)::int FROM platform.domain_events
                    WHERE property_id = $1::uuid AND event_type = $3),
         'audits', (SELECT count(*)::int FROM platform.product_audit_events
                    WHERE property_id = $1::uuid AND action = $3),
         'messages', (SELECT count(*)::int FROM pms.messages WHERE property_id = $1::uuid),
         'jobs', (SELECT count(*)::int FROM platform.jobs WHERE property_id = $1::uuid)
       ) AS counts,
       (SELECT jsonb_build_object(
          'guestBookingId', guest_booking_id::text, 'source', source,
          'sourceThreadId', source_thread_id, 'attentionState', attention_state,
          'deliveryChannel', delivery_channel, 'version', version::text)
        FROM pms.message_threads WHERE property_id = $1::uuid AND source = 'manual') AS thread`,
      [propertyId, OPERATION, EVENT_TYPE],
    );
    return result.rows[0] as {
      counts: {
        idempotency: number;
        threads: number;
        events: number;
        audits: number;
        messages: number;
        jobs: number;
      };
      thread: Record<string, unknown> | null;
    };
  }

  async function cleanup(): Promise<void> {
    if (!admin.database) return;
    const properties = [PROPERTY, OTHER_PROPERTY];
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL session_replication_role = replica");
      for (const statement of [
        "DELETE FROM platform.product_audit_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.jobs WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.outbox_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.domain_events WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM platform.idempotency_keys WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.messages WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM pms.message_threads WHERE property_id = ANY($1::uuid[])",
        "DELETE FROM booking.booking_guests WHERE guest_booking_id = ANY($1::uuid[])",
        "DELETE FROM booking.guest_bookings WHERE id = ANY($1::uuid[])",
      ])
        await admin.query(statement, [
          statement.includes("booking") ? [BOOKING, OTA_BOOKING, OTHER_BOOKING] : properties,
        ]);
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
    throw new Error("Refusing to run Inbox direct-email tests outside a test database");
}
