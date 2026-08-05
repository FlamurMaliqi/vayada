import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureTargetNightlyRevenueEvidence } from "./bookingWebPublic.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "41000000-0000-4000-8000-000000000001";
const BOOKING = "41000000-0000-4000-8000-000000000002";
const ROOM_TYPE = "41000000-0000-4000-8000-000000000003";
const migrationPath = (name: string) =>
  join(import.meta.dirname, "../../../../packages/backend-migration/migrations", name);
const [migration, adjustments] = await Promise.all([
  readFile(migrationPath("0069_booking_nightly_revenue_evidence.sql"), "utf8"),
  readFile(migrationPath("0070_booking_nightly_revenue_adjustments.sql"), "utf8"),
]);

describe.skipIf(!TEST_DATABASE_URL)("direct nightly revenue capture (PostgreSQL)", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const booking = {
    guestBookingId: BOOKING,
    propertyId: PROPERTY,
    publicReference: "B-NIGHTLY",
    sourceSystem: "booking",
    lifecycleStatus: "confirmed",
    paymentStatus: "unpaid",
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    adults: 2,
    children: 0,
    roomCount: 2,
    currency: "EUR",
    totalAmount: "300.00",
    balanceAmount: "300.00",
    bookingMetadata: {},
    createdAt: "2026-08-01T10:00:00.000Z",
  };
  const selectedOffer = (nights: Array<[string, string]>) => ({
    roomTypeId: ROOM_TYPE,
    nightlyRoomAmounts: nights.map(([stayDate, grossRoomAmount]) => ({
      stayDate,
      grossRoomAmount,
    })),
  });
  const context = (fingerprint: string) => ({
    fingerprint: fingerprint.repeat(64),
    occurredAt: new Date("2026-08-05T10:00:00.000Z"),
  });

  beforeAll(async () => {
    const database = new URL(TEST_DATABASE_URL!).pathname;
    if (!/test/i.test(database)) throw new Error(`Refusing non-test database ${database}`);
    await client.connect();
    await client.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto; DROP SCHEMA IF EXISTS booking CASCADE;
      CREATE SCHEMA booking; CREATE TABLE booking.guest_bookings (
        id UUID PRIMARY KEY, property_id UUID NOT NULL, currency CHAR(3) NOT NULL,
        room_count INTEGER NOT NULL, lifecycle_status TEXT NOT NULL, source_system TEXT NOT NULL,
        check_in DATE NOT NULL, check_out DATE NOT NULL, UNIQUE (id, property_id));`);
    await client.query(migration);
    await client.query(adjustments);
  });
  afterAll(async () => {
    await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
    await client.end();
  });

  it("atomically replays, rejects conflicts, versions date changes, and cancels", async () => {
    const original = selectedOffer([
      ["2026-09-01", "70"],
      ["2026-09-02", "80"],
    ]);
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO booking.guest_bookings VALUES ($1, $2, 'EUR', 2, 'confirmed', 'booking', '2026-09-01', '2026-09-03')`,
      [BOOKING, PROPERTY],
    );
    await captureTargetNightlyRevenueEvidence(client, booking, original, context("a"));
    await client.query("COMMIT");
    await captureTargetNightlyRevenueEvidence(client, booking, original, context("a"));
    await expect(
      captureTargetNightlyRevenueEvidence(
        client,
        booking,
        selectedOffer([
          ["2026-09-01", "71"],
          ["2026-09-02", "80"],
        ]),
        context("a"),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect(
      (await client.query("SELECT COUNT(*)::INT AS count FROM booking.nightly_revenue_evidence"))
        .rows[0],
    ).toEqual({ count: 4 });

    const rejectedBooking = { ...booking, guestBookingId: "41000000-0000-4000-8000-000000000004" };
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO booking.guest_bookings VALUES ($1, $2, 'EUR', 2, 'confirmed', 'booking', '2026-09-01', '2026-09-03')`,
      [rejectedBooking.guestBookingId, PROPERTY],
    );
    await expect(
      captureTargetNightlyRevenueEvidence(client, rejectedBooking, original, context("a")),
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK");
    expect(
      (
        await client.query(
          "SELECT COUNT(*)::INT AS count FROM booking.guest_bookings WHERE id = $1",
          [rejectedBooking.guestBookingId],
        )
      ).rows[0],
    ).toEqual({ count: 0 });

    Object.assign(booking, {
      checkIn: "2026-09-02",
      checkOut: "2026-09-04",
    });
    await client.query(
      "UPDATE booking.guest_bookings SET check_in = '2026-09-02', check_out = '2026-09-04'",
    );
    await captureTargetNightlyRevenueEvidence(
      client,
      booking,
      selectedOffer([
        ["2026-09-02", "90"],
        ["2026-09-03", "100"],
      ]),
      context("b"),
      "2026-08-05",
    );
    expect(await aggregate()).toEqual({ amount: "380.0000", occupied: 4 });

    Object.assign(booking, {
      checkIn: "2026-09-01",
      checkOut: "2026-09-02",
    });
    await client.query(
      "UPDATE booking.guest_bookings SET check_in = '2026-09-01', check_out = '2026-09-02'",
    );
    await captureTargetNightlyRevenueEvidence(
      client,
      booking,
      selectedOffer([["2026-09-01", "75"]]),
      context("c"),
      "2026-08-05",
    );
    expect(await aggregate()).toEqual({ amount: "150.0000", occupied: 2 });

    booking.lifecycleStatus = "canceled";
    await client.query("UPDATE booking.guest_bookings SET lifecycle_status = 'canceled'");
    await captureTargetNightlyRevenueEvidence(
      client,
      booking,
      selectedOffer([]),
      context("d"),
      null,
      true,
    );
    expect(await aggregate()).toEqual({ amount: "0.0000", occupied: 0 });
    expect(
      (
        await client.query(
          `SELECT COUNT(*)::INT AS count FROM booking.nightly_revenue_evidence
       WHERE lifecycle_state = 'canceled' AND occupied_room_nights = -1
         AND recognized_on = stay_date`,
        )
      ).rows[0],
    ).toEqual({ count: 2 });
  });

  async function aggregate() {
    return (
      await client.query(
        `SELECT SUM(gross_room_amount)::TEXT AS amount,
        SUM(occupied_room_nights)::INT AS occupied FROM booking.nightly_revenue_evidence`,
      )
    ).rows[0];
  }
});
