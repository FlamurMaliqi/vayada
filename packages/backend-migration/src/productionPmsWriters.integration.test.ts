import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeProductionMigrationProvenance } from "./productionBookingWriter.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { buildProductionPmsPlan } from "./productionPmsPlan.js";
import {
  readProductionPmsPrerequisites,
  readProductionPmsTargetState,
} from "./productionPmsTargetReader.js";
import { writeProductionPmsRecords } from "./productionPmsWriter.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN = "vay1351-0123456789abcdef01234567";
const PROPERTY = "13560000-0000-4000-8000-000000000081";
const HOTEL = "13560000-0000-4000-8000-000000000082";
const ROOM_TYPE = "13560000-0000-4000-8000-000000000083";
const ROOM = "13560000-0000-4000-8000-000000000084";
const BOOKING = "13560000-0000-4000-8000-000000000085";
const CONNECTION = "13560000-0000-4000-8000-000000000086";
const EXTERNAL_PROPERTY = "13560000-0000-4000-8000-000000000087";
const EXTERNAL_ROOM = "13560000-0000-4000-8000-000000000088";
const EXTERNAL_RATE = "13560000-0000-4000-8000-000000000089";
const EXTERNAL_BOOKING = "13560000-0000-4000-8000-000000000090";
const ATTACHMENT = "13560000-0000-4000-8000-000000000104";
const ATTACHMENT_MEDIA = "13560000-0000-4000-8000-000000000105";
const ROOM_MEDIA = "13560000-0000-4000-8000-000000000106";
const ROOM_SOURCE_IMAGE = "https://legacy-media-test.s3.amazonaws.com/rooms/double.jpg";
const ROOM_CDN_IMAGE = `https://media.example.test/media/${ROOM_MEDIA}/original-safe.webp`;

describe.skipIf(!URL)("production PMS writers (PostgreSQL)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });
  afterAll(async () => client.end());

  it("writes and verifies a complete inert PMS migration flow", async () => {
    await client.query("BEGIN");
    try {
      await seedPrerequisites(client);
      const prerequisites = await readProductionPmsPrerequisites(client, RUN);
      const source = sourceRows();
      const plan = buildProductionPmsPlan({
        sourceRunId: RUN,
        snapshotAt: "2026-08-30T00:00:00Z",
        completedAt: "2026-08-30T00:00:00Z",
        rows: source,
        target: { ...prerequisites, records: [], provenance: [] },
      });
      expect(plan.blockers).toEqual([]);
      const expectedCounts = Object.fromEntries(
        [...new Set(plan.writes.map((row) => row.targetTable))].map((table) => [
          table,
          plan.writes.filter((row) => row.targetTable === table).length,
        ]),
      );
      expect(await writeProductionPmsRecords(client, plan.writes)).toEqual(expectedCounts);
      expect(await writeProductionMigrationProvenance(client, plan.provenance, RUN)).toBe(
        plan.provenance.length,
      );

      const target = await readProductionPmsTargetState(client, plan.records, prerequisites);
      const verified = buildProductionPmsPlan({
        sourceRunId: RUN,
        snapshotAt: "2026-08-30T00:00:00Z",
        completedAt: "2026-08-30T00:00:00Z",
        rows: source,
        target,
      });
      expect(verified.blockers).toEqual([]);
      expect(verified.writes).toEqual([]);
      expect(verified.checksum).toBe(plan.checksum);

      const stored = await client.query(
        `SELECT
           (SELECT count(*)::int FROM pms.inventory_days WHERE property_id = $1) AS inventory,
           (SELECT count(*)::int FROM pms.operational_booking_assignments WHERE guest_booking_id = $2) AS assignments,
           (SELECT count(*)::int FROM pms.channel_booking_mappings WHERE guest_booking_id = $2) AS mappings,
           (SELECT count(*)::int FROM pms.room_type_media WHERE room_type_id = $3) AS room_media,
           (SELECT media_snapshot FROM pms.room_types WHERE id = $3) AS media_snapshot,
           (SELECT delivery_status FROM platform.external_webhook_events WHERE provider = 'channex' LIMIT 1) AS webhook_status,
           (SELECT normalized_domain_event_id FROM platform.external_webhook_events WHERE provider = 'channex' LIMIT 1) AS domain_event,
           (SELECT count(*)::int FROM platform.outbox_events) AS outbox_count,
           (SELECT count(*)::int FROM platform.jobs) AS job_count`,
        [PROPERTY, BOOKING, ROOM_TYPE],
      );
      expect(stored.rows[0]).toMatchObject({
        inventory: 366,
        assignments: 1,
        mappings: 1,
        room_media: 1,
        media_snapshot: [
          {
            mediaObjectId: ROOM_MEDIA,
            url: ROOM_CDN_IMAGE,
            source: "pms",
            sourceTable: "room_types",
            publicApproved: true,
          },
        ],
        webhook_status: "observed",
        domain_event: null,
        outbox_count: 0,
        job_count: 0,
      });
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("commits exact migration reservations before physical rooms are assigned", async () => {
    const propertyId = "13560000-0000-4000-8000-000000000181";
    const roomTypeId = "13560000-0000-4000-8000-000000000182";
    const bookingId = "13560000-0000-4000-8000-000000000183";
    let committed = false;
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties(id, public_id, display_name)
         VALUES ($1, 'pms-unassigned-integration', 'PMS Unassigned Integration')`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO pms.room_types(id, property_id, name, base_rate_amount, currency)
         VALUES ($1, $2, 'Unassigned', 100, 'EUR')`,
        [roomTypeId, propertyId],
      );
      await client.query(
        `INSERT INTO booking.guest_bookings
           (id, property_id, public_reference, lifecycle_status, check_in, check_out,
            adults, children, room_count, currency)
         VALUES ($1, $2, 'PMS-UNASSIGNED', 'confirmed', '2026-09-01', '2026-09-03',
                 2, 0, 2, 'EUR')`,
        [bookingId, propertyId],
      );
      await client.query(
        `INSERT INTO pms.operational_booking_assignments
           (property_id, guest_booking_id, room_type_id, room_id, position,
            assignment_status, source, assignment_payload, stay_evidence_kind,
            check_in, check_out, adults, children)
         SELECT $1, $2, $3, NULL, position, 'pending', 'migration', $4::jsonb,
                'exact', '2026-09-01', '2026-09-03', 1, 0
         FROM unnest(ARRAY[1, 2]) position`,
        [propertyId, bookingId, roomTypeId, JSON.stringify({ migrationRunId: RUN })],
      );
      await client.query("COMMIT");
      committed = true;
      await expect(
        client.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM pms.operational_booking_assignments
           WHERE guest_booking_id=$1 AND room_id IS NULL AND stay_evidence_kind='exact'`,
          [bookingId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 2 }] });
    } finally {
      if (!committed) await client.query("ROLLBACK").catch(() => undefined);
      await client.query("BEGIN");
      try {
        await client.query(
          "DELETE FROM pms.operational_booking_assignments WHERE guest_booking_id=$1",
          [bookingId],
        );
        await client.query("DELETE FROM booking.guest_bookings WHERE id=$1", [bookingId]);
        await client.query("DELETE FROM pms.room_types WHERE id=$1", [roomTypeId]);
        await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  });

  it("rejects linked stop-sell without canonical or immutable migration evidence", async () => {
    const propertyId = "13560000-0000-4000-8000-000000000281";
    const roomTypeId = "13560000-0000-4000-8000-000000000282";
    await client.query("BEGIN");
    try {
      await client.query(
        `INSERT INTO hotel_catalog.properties(id, public_id, display_name)
         VALUES ($1, 'pms-linked-constraint', 'PMS Linked Constraint')`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO pms.room_types(id, property_id, name, base_rate_amount, currency)
         VALUES ($1, $2, 'Linked constraint', 100, 'EUR')`,
        [roomTypeId, propertyId],
      );
      await expect(
        client.query(
          `INSERT INTO pms.inventory_days
             (property_id, room_type_id, stay_date, total_count, available_count,
              linked_stop_sell, linked_source_revision, source_freshness)
           VALUES ($1, $2, '2026-09-01', 1, 0, true, 1, '{}'::jsonb)`,
          [propertyId, roomTypeId],
        ),
      ).rejects.toMatchObject({ constraint: "chk_pms_inventory_days_linked_requires_revision" });
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

async function seedPrerequisites(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO hotel_catalog.properties(id, public_id, display_name)
       VALUES ($1, 'pms-integration', 'PMS Integration')`,
    [PROPERTY],
  );
  await client.query(
    `INSERT INTO platform.media_objects
       (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
        resource_product, resource_type, resource_id, lifecycle_status, content_type,
        size_bytes, checksum_sha256, width_px, height_px, original_filename, source_url,
        source_system, source_table, source_row_id, source_metadata, public_approved)
     VALUES ($1, 'platform-media-test', $2, 'vayada_managed', 'public',
             'pms.room_type.media', $3, 'pms', 'room_type', $4, 'active', 'image/webp',
             100, $5, 100, 80, 'double.jpg', $6, 'pms', 'room_types', $7, $8::jsonb, TRUE)`,
    [
      ROOM_MEDIA,
      `public/media/${ROOM_MEDIA}/original_safe/sha256-${"c".repeat(64)}.webp`,
      PROPERTY,
      ROOM_TYPE,
      "c".repeat(64),
      ROOM_SOURCE_IMAGE,
      `${ROOM_TYPE}:images:1`,
      JSON.stringify({ migrationRunId: RUN, migrationTicket: "VAY-1055" }),
    ],
  );
  await client.query(
    `INSERT INTO platform.media_variants
       (media_object_id, variant_name, visibility, storage_key, content_type,
        width_px, height_px, size_bytes, checksum_sha256, public_cdn_url)
     VALUES ($1, 'original_safe', 'public', $2, 'image/webp', 100, 80, 100, $3, $4)`,
    [
      ROOM_MEDIA,
      `public/media/${ROOM_MEDIA}/original_safe/sha256-${"c".repeat(64)}.webp`,
      "c".repeat(64),
      ROOM_CDN_IMAGE,
    ],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_source_links
       (property_id, source_system, source_table, source_id, relationship, metadata)
       VALUES ($1, 'pms', 'hotels', $2, 'operational_input', $3::jsonb)`,
    [PROPERTY, HOTEL, JSON.stringify({ migrationRunId: RUN })],
  );
  await client.query(
    `INSERT INTO booking.guest_bookings
       (id, property_id, public_reference, source_system, source_booking_id,
        lifecycle_status, payment_status, check_in, check_out, adults, children,
        room_count, currency, total_amount, balance_amount, booking_channel,
        created_at, updated_at)
     VALUES ($1::uuid, $2, 'PMS-INTEGRATION', 'pms', ($1::uuid)::text, 'confirmed', 'paid',
             '2026-09-01', '2026-09-03', 2, 0, 1, 'EUR', 200, 0, 'booking_com',
             '2026-08-01T00:00:00Z', '2026-08-29T00:00:00Z')`,
    [BOOKING, PROPERTY],
  );
  await client.query(
    `INSERT INTO platform.production_migration_source_links
       (source_database, source_table, source_id, target_product, target_table, target_id,
        first_run_id, last_run_id, source_checksum, source_updated_at)
     VALUES ('pms', 'bookings', $1, 'booking', 'guest_bookings', $1,
             $2, $2, $3, '2026-08-29T00:00:00Z')`,
    [BOOKING, RUN, "a".repeat(64)],
  );
  await client.query(
    `INSERT INTO platform.media_objects
       (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
        resource_product, resource_type, resource_id, lifecycle_status, content_type,
        size_bytes, checksum_sha256, original_filename, source_url, source_system,
        source_table, source_row_id, source_metadata, public_approved)
     VALUES ($1, 'platform-media-test', $2, 'vayada_managed', 'private',
             'pms.messaging.attachment', $3, 'pms', 'message_attachment', $4,
             'active', 'application/pdf', 123, $5, 'file.pdf',
             'https://legacy-media-test.s3.amazonaws.com/legacy/messages/file.pdf',
             'pms', 'message_attachments', $6, $7::jsonb, FALSE)`,
    [
      ATTACHMENT_MEDIA,
      `private/media/${ATTACHMENT_MEDIA}/provider_original/sha256-${"b".repeat(64)}.pdf`,
      PROPERTY,
      ATTACHMENT,
      "b".repeat(64),
      `${ATTACHMENT}:s3_key`,
      JSON.stringify({ migrationRunId: RUN, migrationTicket: "VAY-1055" }),
    ],
  );
}

function sourceRows(): IdentitySourceRow[] {
  return [
    row("hotels", {
      id: HOTEL,
      timezone: "UTC",
      same_day_bookings_enabled: true,
      same_day_booking_cutoff_time: null,
      calendar_auto_open_enabled: false,
      calendar_auto_open_through: null,
    }),
    row("room_types", {
      id: ROOM_TYPE,
      hotel_id: HOTEL,
      name: "Double",
      total_rooms: 1,
      base_rate: "100.00",
      currency: "EUR",
      is_active: true,
      images: [ROOM_SOURCE_IMAGE],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-29T00:00:00Z",
    }),
    row("rooms", {
      id: ROOM,
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      room_number: "101",
      status: "available",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-29T00:00:00Z",
    }),
    row("bookings", {
      id: BOOKING,
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      room_id: ROOM,
      booking_reference: "PMS-INTEGRATION",
      number_of_rooms: 1,
      status: "confirmed",
      payment_status: "paid",
      channel: "booking.com",
      check_in: "2026-09-01",
      check_out: "2026-09-03",
      adults: 2,
      children: 0,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-29T00:00:00Z",
    }),
    row("room_blocks", {
      id: "13560000-0000-4000-8000-000000000091",
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      start_date: "2027-10-01",
      end_date: "2027-10-02",
      blocked_count: 1,
      reason: "maintenance",
      created_at: "2026-08-20T00:00:00Z",
    }),
    row("checkin_checklist_templates", {
      hotel_id: HOTEL,
      steps: [{ id: "identity", label: "Verify identity" }],
      updated_at: "2026-08-20T00:00:00Z",
    }),
    row("checkout_inspection_templates", {
      hotel_id: HOTEL,
      steps: [{ id: "keys", label: "Return keys" }],
      updated_at: "2026-08-20T00:00:00Z",
    }),
    row("booking_checkin_records", {
      id: "13560000-0000-4000-8000-000000000092",
      booking_id: BOOKING,
      completed_at: "2026-09-01T12:00:00Z",
      step_results: [],
      pending_flags: [],
    }),
    row("booking_checkout_charges", {
      id: "13560000-0000-4000-8000-000000000093",
      hotel_id: HOTEL,
      booking_id: BOOKING,
      label: "Minibar",
      amount: "5.00",
      original_amount: "5.00",
      status: "paid",
      created_at: "2026-09-03T09:00:00Z",
      settled_at: "2026-09-03T09:05:00Z",
    }),
    row("booking_checkout_records", {
      id: "13560000-0000-4000-8000-000000000094",
      booking_id: BOOKING,
      completed_at: "2026-09-03T10:00:00Z",
      inspection_results: [],
      charges_settled: [],
      pending_flags: [],
    }),
    row("booking_notes", {
      id: "13560000-0000-4000-8000-000000000095",
      hotel_id: HOTEL,
      booking_id: BOOKING,
      author_name: "Host",
      body: "Quiet room requested",
      created_at: "2026-08-20T00:00:00Z",
    }),
    ...channelRows(),
    ...messageRows(),
    row("booking_events", {
      id: "13560000-0000-4000-8000-000000000096",
      booking_id: BOOKING,
      hotel_id: HOTEL,
      event_type: "room_moved",
      payload: { source: "host" },
      created_at: "2026-08-28T00:00:00Z",
    }),
    row("booking_notification_deliveries", {
      booking_id: BOOKING,
      notification_type: "guest_confirmation",
      recipient_email: "guest@example.test",
      delivered_at: "2026-08-28T01:00:00Z",
    }),
    row("channex_webhook_events", {
      id: "13560000-0000-4000-8000-000000000097",
      event_type: "booking_revision",
      property_id: EXTERNAL_PROPERTY,
      received_at: "2026-08-28T02:00:00Z",
      processed_ok: true,
      payload: { booking_id: EXTERNAL_BOOKING },
    }),
  ];
}

function channelRows(): IdentitySourceRow[] {
  return [
    row("channex_connections", {
      id: CONNECTION,
      hotel_id: HOTEL,
      channex_property_id: EXTERNAL_PROPERTY,
      is_active: true,
      last_booking_sync_at: "2026-08-28T00:00:00Z",
      last_ari_sync_at: "2026-08-28T00:00:00Z",
      messaging_app_installed: true,
      last_message_sync_at: "2026-08-28T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    }),
    row("channex_room_type_mappings", {
      id: "13560000-0000-4000-8000-000000000098",
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      channex_room_type_id: EXTERNAL_ROOM,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    }),
    row("channex_rate_plan_mappings", {
      id: "13560000-0000-4000-8000-000000000099",
      hotel_id: HOTEL,
      room_type_id: ROOM_TYPE,
      channex_rate_plan_id: EXTERNAL_RATE,
      channex_room_type_id: EXTERNAL_ROOM,
      sell_mode: "per_room",
      plan_name: "Flexible",
      channel: "booking.com",
      meal_plan_code: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    }),
    row("channex_booking_mappings", {
      id: "13560000-0000-4000-8000-000000000100",
      hotel_id: HOTEL,
      booking_id: BOOKING,
      channex_booking_id: EXTERNAL_BOOKING,
      channel_source: "booking.com",
      channex_room_index: 0,
      last_synced_at: "2026-08-28T00:00:00Z",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    }),
    row("channex_channel_markups", {
      id: "13560000-0000-4000-8000-000000000101",
      hotel_id: HOTEL,
      channel: "booking.com",
      markup_pct: "12.5",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    }),
  ];
}

function messageRows(): IdentitySourceRow[] {
  const thread = "13560000-0000-4000-8000-000000000102";
  const message = "13560000-0000-4000-8000-000000000103";
  return [
    row("message_threads", {
      id: thread,
      hotel_id: HOTEL,
      source: "channex",
      source_thread_id: "thread-ext",
      booking_id: BOOKING,
      status: "open",
      unread_count: 1,
      created_at: "2026-08-20T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
    }),
    row("messages", {
      id: message,
      thread_id: thread,
      source_message_id: "message-ext",
      direction: "inbound",
      body: "Hello",
      sent_at: "2026-08-28T00:00:00Z",
      received_at: "2026-08-28T00:00:01Z",
      raw_payload: {},
    }),
    row("message_attachments", {
      id: ATTACHMENT,
      message_id: message,
      s3_key: "legacy/messages/file.pdf",
      filename: "file.pdf",
      created_at: "2026-08-28T00:00:02Z",
    }),
  ];
}

function row(sourceTable: string, data: Record<string, unknown>): IdentitySourceRow {
  return { sourceDatabase: "pms", sourceTable, rowOrdinal: 1, data };
}
