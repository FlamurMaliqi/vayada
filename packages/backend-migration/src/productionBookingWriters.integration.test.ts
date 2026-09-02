import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildProductionBookingPlan } from "./productionBookingPlan.js";
import {
  readProductionBookingOwnership,
  readProductionBookingTargetState,
} from "./productionBookingTargetReader.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import {
  writeProductionBookingInferences,
  writeProductionBookingQuarantines,
  writeProductionBookingRecords,
  writeProductionMigrationProvenance,
} from "./productionBookingWriter.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN = "vay1351-0123456789abcdef01234567";
const PROPERTY = "13550000-0000-4000-8000-000000000081";
const ORGANIZATION = "13550000-0000-4000-8000-000000000080";
const BOOKING_HOTEL = "13550000-0000-4000-8000-000000000082";
const PMS_HOTEL = "13550000-0000-4000-8000-000000000083";
const BOOKING = "13550000-0000-4000-8000-000000000084";
const DRAFT = "13550000-0000-4000-8000-000000000085";
const ADDON = "13550000-0000-4000-8000-000000000086";
const MISSING_ADDON = "13550000-0000-4000-8000-000000000096";
const PROMO = "13550000-0000-4000-8000-000000000087";
const LOGO_MEDIA = "13550000-0000-4000-8000-000000000098";
const HERO_MEDIA = "13550000-0000-4000-8000-000000000099";
const LOGO_SOURCE_URL = "https://legacy-media-test.s3.amazonaws.com/rooms/logo.png";
const HERO_SOURCE_URL = "https://legacy-media-test.s3.amazonaws.com/rooms/hero.png";
const HERO_CDN_URL = `https://media.example.test/media/${HERO_MEDIA}/original_safe/original.webp`;
const UPDATED = "2026-08-29T12:00:00Z";

describe.skipIf(!URL)("production Booking writers (PostgreSQL)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    assertSafeTestDatabase(URL!);
    client = new pg.Client({ connectionString: URL });
    await client.connect();
  });
  afterAll(async () => client.end());

  it("writes and verifies a complete stale-safe Booking flow", async () => {
    await client.query("BEGIN");
    try {
      await seedCatalog(client);
      const ownership = await readProductionBookingOwnership(client, RUN);
      const source = sourceRows();
      const plan = buildProductionBookingPlan({
        sourceRunId: RUN,
        completedAt: "2026-08-30T00:00:00Z",
        rows: source,
        target: { ...ownership, records: [], provenance: [] },
      });
      expect(plan.blockers).toEqual([]);
      const expectedCounts = Object.fromEntries(
        [...new Set(plan.writes.map((row) => row.targetTable))].map((table) => [
          table,
          plan.writes.filter((row) => row.targetTable === table).length,
        ]),
      );
      expect(await writeProductionBookingRecords(client, plan.writes)).toEqual(expectedCounts);
      expect(await writeProductionBookingQuarantines(client, plan.quarantines, RUN)).toBe(
        plan.quarantines.length,
      );
      expect(await writeProductionBookingInferences(client, plan.inferences, RUN)).toBe(
        plan.inferences.length,
      );
      expect(await writeProductionBookingInferences(client, plan.inferences, RUN)).toBe(
        plan.inferences.length,
      );
      expect(await writeProductionBookingQuarantines(client, plan.quarantines, RUN)).toBe(
        plan.quarantines.length,
      );
      expect(await writeProductionMigrationProvenance(client, plan.provenance, RUN)).toBe(
        plan.provenance.length,
      );

      const target = await readProductionBookingTargetState(client, plan.records, ownership);
      const verified = buildProductionBookingPlan({
        sourceRunId: RUN,
        completedAt: "2026-08-30T00:00:00Z",
        rows: source,
        target,
      });
      expect(verified.blockers).toEqual([]);
      expect(verified.writes).toEqual([]);
      expect(verified.checksum).toBe(plan.checksum);

      const stored = await client.query(
        `SELECT
           (SELECT count(*)::int FROM booking.guest_bookings WHERE id = $1) AS bookings,
           (SELECT count(*)::int FROM booking.booking_guests WHERE guest_booking_id = $1) AS guests,
           (SELECT count(*)::int FROM booking.booking_addon_selections WHERE guest_booking_id = $1) AS addons,
           (SELECT count(*)::int FROM booking.promo_applications WHERE guest_booking_id = $1) AS promos,
           (SELECT status FROM booking.checkout_contexts WHERE id = $2) AS draft_status,
           (SELECT pii_retention_until::text FROM booking.checkout_contexts WHERE id = $2) AS draft_pii_retention,
           (SELECT to_jsonb(summary) FROM booking.direct_booking_summary_read_model summary
             WHERE guest_booking_id = $1) AS summary,
           (SELECT redacted_payload FROM platform.product_audit_events
             WHERE product = 'booking' LIMIT 1) AS audit,
           (SELECT header_logo_media_object_id::text FROM booking.booking_settings
             WHERE property_id = $3) AS header_logo_media_object_id,
           (SELECT hero_image_url FROM booking.booking_settings
             WHERE property_id = $3) AS hero_image_url,
           (SELECT count(*)::int FROM platform.production_booking_migration_quarantines
             WHERE source_run_id = $4) AS quarantines,
           (SELECT count(*)::int FROM platform.production_booking_migration_inferences
             WHERE source_run_id = $4) AS inferences,
           (SELECT jsonb_agg(jsonb_build_object(
                     'addonKey', item.addon_key,
                     'name', item.addon_name,
                     'quantity', item.quantity,
                     'serviceDates', item.service_dates
                   ) ORDER BY item.item_ordinality)
              FROM booking.booking_addon_selection_items item
             WHERE item.guest_booking_id = $1) AS addon_items,
           (SELECT SUM(selection.total_amount)::text
              FROM booking.booking_addon_selections selection
             WHERE selection.guest_booking_id = $1) AS addon_total`,
        [BOOKING, DRAFT, PROPERTY, RUN],
      );
      expect(stored.rows[0]).toMatchObject({
        bookings: 1,
        guests: 2,
        addons: 1,
        promos: 1,
        draft_status: "converted",
        draft_pii_retention: "2026-08-30",
        audit: { page: "checkout" },
        header_logo_media_object_id: LOGO_MEDIA,
        hero_image_url: HERO_CDN_URL,
        quarantines: 1,
        inferences: 1,
        addon_items: [
          {
            addonKey: ADDON,
            name: "Breakfast",
            quantity: 2,
            serviceDates: ["2026-09-02"],
          },
          {
            addonKey: MISSING_ADDON,
            name: "Airport transfer",
            quantity: 1,
            serviceDates: ["2026-09-02", "2026-09-03"],
          },
        ],
        addon_total: "30.00",
      });
      const publicSummary = JSON.stringify(stored.rows[0].summary);
      expect(publicSummary).not.toContain("private@example.test");
      expect(publicSummary).not.toContain("+43123");

      await client.query("SAVEPOINT immutable_quarantine");
      await expect(
        client.query(
          `UPDATE platform.production_booking_migration_quarantines
              SET source_value_sha256 = $1
            WHERE source_run_id = $2`,
          ["c".repeat(64), RUN],
        ),
      ).rejects.toThrow("immutable");
      await client.query("ROLLBACK TO SAVEPOINT immutable_quarantine");

      await client.query("SAVEPOINT immutable_inference");
      await expect(
        client.query(
          `UPDATE platform.production_booking_migration_inferences
              SET inferred_value = 'commission'
            WHERE source_run_id = $1`,
          [RUN],
        ),
      ).rejects.toThrow("immutable");
      await client.query("ROLLBACK TO SAVEPOINT immutable_inference");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

async function seedCatalog(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO platform.source_extraction_runs
       (run_id, environment, source_schema_revision, status, finished_at, duration_ms)
     VALUES ($1, 'local', $2, 'completed', now(), 1)
     ON CONFLICT (run_id) DO NOTHING`,
    [RUN, "a".repeat(40)],
  );
  await client.query(
    `INSERT INTO hotel_catalog.properties(id, public_id, display_name)
       VALUES ($1, 'booking-integration', 'Booking Integration')`,
    [PROPERTY],
  );
  await client.query(
    `INSERT INTO identity.organizations(id, kind, name, slug)
       VALUES ($1, 'hotel_group', 'Booking Integration', 'booking-integration')`,
    [ORGANIZATION],
  );
  await client.query(
    `INSERT INTO identity.organization_resource_links
       (organization_id, product, resource_type, resource_id, relationship)
     VALUES
       ($1, 'booking', 'booking_hotel', $2, 'owner'),
       ($1, 'pms', 'pms_hotel', $3, 'operator')`,
    [ORGANIZATION, BOOKING_HOTEL, PMS_HOTEL],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_source_links
       (property_id, source_system, source_table, source_id, relationship, metadata)
       VALUES
         ($1, 'booking', 'booking_hotels', $2, 'canonical_input', $4::jsonb),
         ($1, 'pms', 'hotels', $3, 'operational_input', $4::jsonb)`,
    [PROPERTY, BOOKING_HOTEL, PMS_HOTEL, JSON.stringify({ migrationRunId: RUN })],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_slugs(property_id, slug, purpose, status)
       VALUES ($1, 'booking-integration', 'canonical', 'active')`,
    [PROPERTY],
  );
  await client.query(
    `INSERT INTO platform.media_objects
       (id, bucket, storage_key, storage_kind, visibility, purpose, property_id, resource_product,
        resource_type, resource_id, lifecycle_status, content_type, size_bytes,
        checksum_sha256, original_filename, source_url, source_system, source_table,
        source_row_id, source_metadata, public_approved)
     VALUES ($1::uuid, 'platform-media-test',
             'public/media/' || $1::uuid::text || '/original_safe/original.webp',
             'vayada_managed', 'public', 'booking.header_logo', $2, 'booking',
             'booking_hotel', $3, 'active',
             'image/webp', 10, $4, 'logo.png', $5, 'booking', 'booking_hotels', $6,
             $7::jsonb, TRUE)`,
    [
      LOGO_MEDIA,
      PROPERTY,
      BOOKING_HOTEL,
      "a".repeat(64),
      LOGO_SOURCE_URL,
      `${BOOKING_HOTEL}:branding_logo_url:booking_header`,
      JSON.stringify({ migrationRunId: RUN }),
    ],
  );
  await client.query(
    `INSERT INTO platform.media_variants
       (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
     VALUES ($1::uuid, 'original_safe', 'public',
             'public/media/' || $1::uuid::text || '/original_safe/original.webp', 'image/webp',
             'https://media.example.test/media/' || $1::uuid::text || '/original_safe/original.webp')`,
    [LOGO_MEDIA],
  );
  await client.query(
    `INSERT INTO platform.media_objects
       (id, bucket, storage_key, storage_kind, visibility, purpose, property_id,
        resource_product, resource_type, resource_id, lifecycle_status, content_type,
        size_bytes, checksum_sha256, original_filename, source_url, source_system,
        source_table, source_row_id, source_metadata, public_approved)
     VALUES ($1::uuid, 'platform-media-test',
             'public/media/' || $1::uuid::text || '/original_safe/original.webp', 'vayada_managed',
             'public', 'property.hero_image', $2::uuid, 'hotel_catalog', 'property', $2::uuid::text,
             'active', 'image/webp', 10, $3, 'hero.png', $4, 'booking',
             'booking_hotels', $5, $6::jsonb, TRUE)`,
    [
      HERO_MEDIA,
      PROPERTY,
      "b".repeat(64),
      HERO_SOURCE_URL,
      `${BOOKING_HOTEL}:hero_image`,
      JSON.stringify({ migrationRunId: RUN }),
    ],
  );
  await client.query(
    `INSERT INTO platform.media_variants
       (media_object_id, variant_name, visibility, storage_key, content_type, public_cdn_url)
     VALUES ($1::uuid, 'original_safe', 'public',
             'public/media/' || $1::uuid::text || '/original_safe/original.webp', 'image/webp', $2)`,
    [HERO_MEDIA, HERO_CDN_URL],
  );
}

function sourceRows(): IdentitySourceRow[] {
  return [
    row("booking", "booking_hotels", {
      id: BOOKING_HOTEL,
      currency: "EUR",
      supported_currencies: ["EUR"],
      supported_languages: ["en"],
      instant_book: true,
      branding_logo_url: LOGO_SOURCE_URL,
      hero_image: HERO_SOURCE_URL,
      updated_at: UPDATED,
    }),
    row("booking", "booking_addons", {
      id: ADDON,
      hotel_id: BOOKING_HOTEL,
      name: "Breakfast",
      price: "15",
      currency: "EUR",
      per_person: false,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: UPDATED,
    }),
    row("booking", "booking_promo_codes", {
      id: PROMO,
      hotel_id: BOOKING_HOTEL,
      code: "SUMMER",
      discount_type: "percentage",
      discount_value: "10",
      is_active: true,
      max_uses: 20,
      current_uses: 1,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: UPDATED,
    }),
    row("booking", "booking_events", {
      id: "13550000-0000-4000-8000-000000000088",
      hotel_slug: "booking-integration",
      event_type: "checkout_started",
      session_id: "session-private",
      metadata: { page: "checkout", guestEmail: "private@example.test" },
      created_at: UPDATED,
    }),
    booking(),
    row("pms", "booking_drafts", {
      id: DRAFT,
      hotel_id: PMS_HOTEL,
      room_type_id: "13550000-0000-4000-8000-000000000089",
      check_in: "2026-09-01",
      check_out: "2026-09-04",
      number_of_rooms: 1,
      booking_reference: "VAY-INTEGRATION",
      stripe_payment_intent_id: "pi_integration",
      payload: {
        guest_first_name: "Mira",
        guest_last_name: "Guest",
        guest_email: "private@example.test",
        guest_phone: "+43123",
        adults: 2,
        children: 0,
        currency: "EUR",
        total_amount: "420",
        addon_ids: [ADDON],
      },
      materialized_booking_id: BOOKING,
      expires_at: "2026-08-30T00:15:00Z",
      created_at: "2026-08-30T00:00:00Z",
    }),
    row("pms", "booking_additional_guests", {
      id: "13550000-0000-4000-8000-000000000090",
      booking_id: BOOKING,
      first_name: "Leo",
      last_name: "Guest",
      nationality: "DE",
      passport_number: "private-passport",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: UPDATED,
    }),
    row("pms", "booking_change_requests", {
      id: "13550000-0000-4000-8000-000000000091",
      booking_id: BOOKING,
      status: "approved",
      old_check_in: "2026-09-01",
      old_check_out: "2026-09-04",
      requested_check_in: "2026-09-02",
      requested_check_out: "2026-09-05",
      currency: "EUR",
      decided_at: UPDATED,
      created_at: "2026-08-20T00:00:00Z",
    }),
    row("pms", "booking_promo_usage_state", {
      booking_reference: "VAY-INTEGRATION",
      promo_code: "SUMMER",
      desired_state: "active",
      applied_state: "active",
      attempt_count: 1,
      created_at: "2026-08-01T00:00:00Z",
    }),
  ];
}

function booking(): IdentitySourceRow {
  return row("pms", "bookings", {
    id: BOOKING,
    hotel_id: PMS_HOTEL,
    room_type_id: "13550000-0000-4000-8000-000000000089",
    booking_reference: "VAY-INTEGRATION",
    guest_first_name: "Mira",
    guest_last_name: "Guest",
    guest_email: "private@example.test",
    guest_phone: "+43123",
    guest_country: "AT",
    check_in: "2026-09-01",
    check_out: "2026-09-04",
    adults: 2,
    children: 0,
    number_of_rooms: 1,
    currency: "EUR",
    total_amount: "420",
    balance_amount: "0",
    status: "confirmed",
    payment_status: "captured",
    payment_method: "card",
    channel: "direct",
    billing_plan_at_creation: null,
    addon_ids: [ADDON, MISSING_ADDON],
    addon_names: ["Breakfast", "Airport transfer"],
    addon_quantities: { [ADDON]: 2, [MISSING_ADDON]: 1 },
    addon_dates: {
      [ADDON]: ["2026-09-02"],
      [MISSING_ADDON]: ["2026-09-02", "2026-09-03"],
    },
    addon_total: "30",
    promo_code: "SUMMER",
    promo_discount: "10",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: UPDATED,
  });
}

function row(
  sourceDatabase: "booking" | "pms",
  sourceTable: string,
  data: Record<string, unknown>,
): IdentitySourceRow {
  return { sourceDatabase, sourceTable, rowOrdinal: 1, data };
}
