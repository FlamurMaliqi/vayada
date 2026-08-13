import pg from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { captureDirectNightlyRevenueEvidence } from "../domains/stripeBookingSettlement.js";

const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "41000000-0000-4000-8000-000000000001";
const BOOKING = "41000000-0000-4000-8000-000000000002";

describe.skipIf(!DATABASE_URL)("direct nightly revenue capture (PostgreSQL)", () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  const booking = (dates: [string, string], amounts: [string, string]) => ({
    guestBookingId: BOOKING,
    propertyId: PROPERTY,
    checkIn: dates[0],
    checkOut: dates[1].endsWith("02") ? "2026-09-03" : "2026-09-04",
    bookingMetadata: {
      requestFingerprint: "a".repeat(64),
      selectedOffer: {
        roomTypeId: "41000000-0000-4000-8000-000000000003",
        nightlyRoomAmounts: dates.map((stayDate, i) => ({ stayDate, grossRoomAmount: amounts[i] })),
      },
    },
  });

  beforeAll(async () => {
    if (!/test/i.test(new URL(DATABASE_URL!).pathname)) throw new Error("Refusing non-test DB");
    await client.connect();
  });
  afterAll(() => client.end());

  it("replays, changes dates, and cancels without rewriting history", async () => {
    const original = booking(["2026-09-01", "2026-09-02"], ["70", "80"]);
    await client.query(
      "INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1,'revenue-test','Revenue test') ON CONFLICT DO NOTHING",
      [PROPERTY],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,public_reference,source_system,lifecycle_status,payment_status,
       check_in,check_out,room_count,currency,total_amount,balance_amount,booking_metadata)
      VALUES ($1,$2,'B-REVENUE','booking','confirmed','unpaid','2026-09-01','2026-09-03',
       2,'EUR',300,300,$3)`,
      [BOOKING, PROPERTY, JSON.stringify(original.bookingMetadata)],
    );
    for (let retry = 0; retry < 2; retry++)
      await captureDirectNightlyRevenueEvidence(client, original, { required: true });
    const changed = booking(["2026-09-02", "2026-09-03"], ["90", "100"]);
    await client.query(
      "UPDATE booking.guest_bookings SET check_in='2026-09-02',check_out='2026-09-04',booking_metadata=$1",
      [JSON.stringify(changed.bookingMetadata)],
    );
    await captureDirectNightlyRevenueEvidence(client, changed, {
      fingerprint: "b",
      recognizedOn: "2026-09-05",
      required: true,
    });
    await client.query("UPDATE booking.guest_bookings SET lifecycle_status='canceled'");
    await captureDirectNightlyRevenueEvidence(client, changed, {
      clear: true,
      fingerprint: "c",
      recognizedOn: "2026-09-06",
      required: true,
    });
    const result =
      await client.query(`SELECT SUM(gross_room_amount)=0 AND SUM(occupied_room_nights)=0
      AND COUNT(*)=14 valid FROM booking.nightly_revenue_evidence`);
    if (!result.rows[0]?.valid) throw new Error("Nightly revenue history was not preserved.");
  });
});
