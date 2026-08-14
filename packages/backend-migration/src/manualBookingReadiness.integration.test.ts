import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type ManualBookingEvidenceManifest,
  runManualBookingReadiness,
} from "./manualBookingReadiness.js";
import { assertSafeTestDatabase } from "./testUtils.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "12590000-0000-4000-8000-000000000001";
const BOOKING = "12590000-0000-4000-8000-000000000002";
const ROOM = "12590000-0000-4000-8000-000000000003";
const ROOM_TYPE = "12590000-0000-4000-8000-000000000004";
const ADDON = "12590000-0000-4000-8000-000000000005";
const SHA = "a".repeat(64);

describe.skipIf(!TEST_DATABASE_URL)("manual-booking readiness (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await client.query(
      `INSERT INTO hotel_catalog.properties (id, public_id, display_name)
       VALUES ($1, 'manual-readiness-property', 'Manual readiness property')`,
      [PROPERTY],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings
        (id, property_id, public_reference, source_system, source_booking_id,
         lifecycle_status, payment_status, check_in, check_out, room_count,
         currency, total_amount, balance_amount, booking_metadata,
         expected_payment_method, booking_channel, direct_booking_source)
       VALUES ($1, $2, 'MANUAL-READINESS', 'pms', 'manual-readiness-command',
         'confirmed', 'unpaid', '2027-01-01', '2027-01-02', 1,
         'EUR', 10, 10, '{"contractVersion":"pms-manual-booking.v1"}',
         'cash', 'direct', 'call')`,
      [BOOKING, PROPERTY],
    );
    await client.query(
      `INSERT INTO booking.addon_definitions
        (id, property_id, name, pricing_model, price_amount, currency)
       VALUES ($1, $2, 'Malformed readiness add-on', 'per_night', 10, 'EUR')`,
      [ADDON, PROPERTY],
    );
    await client.query(
      `INSERT INTO booking.booking_addon_selections
        (property_id, guest_booking_id, addon_definition_id, addon_snapshot, quantity, total_amount, currency)
       VALUES ($1, $2, $3,
         '{"pricingModel":"per_night","unitPrice":{"amountDecimal":"10","currency":"EUR"},"serviceUnits":{"not":"an-array"}}',
         1, 10, 'EUR')`,
      [PROPERTY, BOOKING, ADDON],
    );
  });

  afterEach(async () => {
    try {
      await client.query("ROLLBACK");
      await client.query("DELETE FROM booking.guest_bookings WHERE id=$1", [BOOKING]);
      await client.query("DELETE FROM booking.addon_definitions WHERE id=$1", [ADDON]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [PROPERTY]);
    } finally {
      await client.end();
    }
  });

  it("executes the real query read-only and reports malformed add-on JSON", async () => {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const report = await runManualBookingReadiness(client, {
      manifest: manifest(),
      manifestSha256: SHA,
      reviewedSha256: SHA,
      now: new Date("2027-02-01T00:00:00Z"),
    });

    expect(report.status).toBe("blocked");
    expect(report.findings).toContainEqual({
      code: "ADDON_SNAPSHOT_INVALID",
      guestBookingId: BOOKING,
      message: "One or more add-on snapshots cannot reproduce their persisted totals.",
    });
    expect((await client.query("SHOW transaction_read_only")).rows[0]).toEqual({
      transaction_read_only: "on",
    });
    await client.query("SAVEPOINT verify_read_only");
    await expect(
      client.query("DELETE FROM booking.guest_bookings WHERE id=$1", [BOOKING]),
    ).rejects.toMatchObject({ code: "25006" });
    await client.query("ROLLBACK TO SAVEPOINT verify_read_only");
  });

  it("reports malformed unit-price JSON independently", async () => {
    await client.query(
      `UPDATE booking.booking_addon_selections
       SET addon_snapshot='{"pricingModel":"per_night","unitPrice":"malformed","serviceUnits":[{"serviceDate":"2027-01-01","guestCount":null}]}'
       WHERE guest_booking_id=$1`,
      [BOOKING],
    );
    await client.query("BEGIN TRANSACTION READ ONLY");
    const report = await runManualBookingReadiness(client, {
      manifest: manifest(),
      manifestSha256: SHA,
      reviewedSha256: SHA,
    });
    expect(report.findings.map(({ code }) => code)).toContain("ADDON_SNAPSHOT_INVALID");
  });
});

function manifest(): ManualBookingEvidenceManifest {
  return {
    contractVersion: "pms-manual-booking-rehearsal.v1",
    runId: "postgres-readiness-test",
    propertyIds: [PROPERTY],
    snapshot: { id: "snapshot-1", capturedAt: "2027-01-10T00:00:00Z" },
    restoreRehearsal: {
      id: "restore-1",
      completedAt: "2027-01-11T00:00:00Z",
      status: "passed",
    },
    cutover: {
      watermark: "2027-01-09T00:00:00Z",
      reviewedBy: "readiness-reviewer",
      reviewedAt: "2027-01-12T00:00:00Z",
    },
    cases: [
      {
        guestBookingId: BOOKING,
        propertyId: PROPERTY,
        scenarios: ["custom_rate"],
        expected: {
          currency: "EUR",
          directSource: "call",
          expectedPaymentMethod: "cash",
          paymentStatus: "unpaid",
          totalAmount: "10",
          balanceAmount: "10",
          stays: [
            {
              position: 1,
              roomId: ROOM,
              roomTypeId: ROOM_TYPE,
              checkIn: "2027-01-01",
              checkOut: "2027-01-02",
              adults: 1,
              children: 0,
              ratePlanId: null,
            },
          ],
          nightly: [{ position: 1, serviceDate: "2027-01-01", amount: "0" }],
          addOns: [],
          seasons: [],
        },
      },
    ],
  };
}
