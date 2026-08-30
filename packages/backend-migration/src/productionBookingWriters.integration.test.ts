import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildProductionBookingPlan } from "./productionBookingPlan.js";
import {
  readProductionBookingOwnership,
  readProductionBookingTargetState,
} from "./productionBookingTargetReader.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import { writeProductionBookingRecords, writeProductionMigrationProvenance } from "./productionBookingWriter.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const URL = process.env["TEST_DATABASE_URL"];
const RUN = "vay1351-0123456789abcdef01234567";
const PROPERTY = "13550000-0000-4000-8000-000000000081";
const BOOKING_HOTEL = "13550000-0000-4000-8000-000000000082";
const PMS_HOTEL = "13550000-0000-4000-8000-000000000083";
const BOOKING = "13550000-0000-4000-8000-000000000084";
const DRAFT = "13550000-0000-4000-8000-000000000085";
const ADDON = "13550000-0000-4000-8000-000000000086";
const PROMO = "13550000-0000-4000-8000-000000000087";
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
      const ownership = await readProductionBookingOwnership(client);
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
           (SELECT to_jsonb(summary) FROM booking.direct_booking_summary_read_model summary
             WHERE guest_booking_id = $1) AS summary,
           (SELECT redacted_payload FROM platform.product_audit_events
             WHERE product = 'booking' LIMIT 1) AS audit`,
        [BOOKING, DRAFT],
      );
      expect(stored.rows[0]).toMatchObject({
        bookings: 1,
        guests: 2,
        addons: 1,
        promos: 1,
        draft_status: "converted",
        audit: { page: "checkout" },
      });
      const publicSummary = JSON.stringify(stored.rows[0].summary);
      expect(publicSummary).not.toContain("private@example.test");
      expect(publicSummary).not.toContain("+43123");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});

async function seedCatalog(client: pg.Client): Promise<void> {
  await client.query(
    `INSERT INTO hotel_catalog.properties(id, public_id, display_name)
       VALUES ($1, 'booking-integration', 'Booking Integration')`,
    [PROPERTY],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_source_links
       (property_id, source_system, source_table, source_id, relationship)
       VALUES
         ($1, 'booking', 'booking_hotels', $2, 'canonical_input'),
         ($1, 'pms', 'hotels', $3, 'canonical_input')`,
    [PROPERTY, BOOKING_HOTEL, PMS_HOTEL],
  );
  await client.query(
    `INSERT INTO hotel_catalog.property_slugs(property_id, slug, purpose, status)
       VALUES ($1, 'booking-integration', 'canonical', 'active')`,
    [PROPERTY],
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
    addon_ids: [ADDON],
    addon_quantities: { [ADDON]: 1 },
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
