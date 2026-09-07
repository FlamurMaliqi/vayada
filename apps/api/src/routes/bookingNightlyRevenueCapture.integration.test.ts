import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureDirectNightlyRevenueEvidence } from "../domains/stripeBookingSettlement.js";

const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = randomUUID();
const BOOKING = randomUUID();
const ROOM_TYPE = randomUUID();

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
        roomTypeId: ROOM_TYPE,
        nightlyRoomAmounts: dates.map((stayDate, i) => ({ stayDate, grossRoomAmount: amounts[i] })),
      },
    },
  });

  beforeAll(async () => {
    if (!/test/i.test(new URL(DATABASE_URL!).pathname)) throw new Error("Refusing non-test DB");
    await client.connect();
    await client.query("BEGIN");
  });
  afterAll(() => client.query("ROLLBACK").then(() => client.end()));

  it("replays, changes dates, and cancels without rewriting history", async () => {
    const original = booking(["2026-09-01", "2026-09-02"], ["70", "80"]);
    await client.query(
      "INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1,$2,'Revenue test')",
      [PROPERTY, `revenue-${PROPERTY}`],
    );
    await client.query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,public_reference,source_system,lifecycle_status,payment_status,
       check_in,check_out,room_count,currency,total_amount,balance_amount,booking_metadata)
      VALUES ($1::uuid,$2,$1,'booking','confirmed','unpaid','2026-09-01','2026-09-03',
       2,'EUR',300,300,$3)`,
      [BOOKING, PROPERTY, JSON.stringify(original.bookingMetadata)],
    );
    for (let retry = 0; retry < 2; retry++)
      await captureDirectNightlyRevenueEvidence(client, original, { required: true });
    const changed = booking(["2026-09-02", "2026-09-03"], ["90", "100"]);
    await client.query(
      "UPDATE booking.guest_bookings SET check_in='2026-09-02',check_out='2026-09-04',booking_metadata=$1 WHERE id=$2",
      [JSON.stringify(changed.bookingMetadata), BOOKING],
    );
    await captureDirectNightlyRevenueEvidence(client, changed, {
      fingerprint: "b",
      recognizedOn: "2026-09-05",
      required: true,
    });
    await client.query(
      "UPDATE booking.guest_bookings SET lifecycle_status='canceled' WHERE id=$1",
      [BOOKING],
    );
    await captureDirectNightlyRevenueEvidence(client, changed, {
      clear: true,
      fingerprint: "c",
      recognizedOn: "2026-09-06",
      required: true,
    });
    const result = await client.query(
      `SELECT SUM(gross_room_amount)=0 AND SUM(occupied_room_nights)=0 AND COUNT(*)=14 valid FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1`,
      [BOOKING],
    );
    if (!result.rows[0]?.valid) throw new Error("Nightly revenue history was not preserved.");
  });
  it("captures and reverses each mixed room type without multiplying the first rate", async () => {
    const id = randomUUID();
    const secondRoomType = randomUUID();
    const lines = [
      {
        roomTypeId: ROOM_TYPE,
        publicOfferKey: ROOM_TYPE,
        guests: [
          { adults: 2, children: 0 },
          { adults: 2, children: 0 },
        ],
        offer: {
          nightlyRoomAmounts: [
            { stayDate: "2026-09-01", grossRoomAmount: "70" },
            { stayDate: "2026-09-02", grossRoomAmount: "80" },
          ],
        },
      },
      {
        roomTypeId: secondRoomType,
        publicOfferKey: secondRoomType,
        guests: [{ adults: 2, children: 0 }],
        offer: {
          nightlyRoomAmounts: [
            { stayDate: "2026-09-01", grossRoomAmount: "110" },
            { stayDate: "2026-09-02", grossRoomAmount: "130" },
          ],
        },
      },
    ];
    const mixed = {
      guestBookingId: id,
      propertyId: PROPERTY,
      checkIn: "2026-09-01",
      checkOut: "2026-09-03",
      bookingMetadata: {
        requestFingerprint: id,
        selectedOffer: {
          roomTypeId: ROOM_TYPE,
          roomSelection: { contractVersion: "booking-room-selection.v1", lines },
          roomLines: lines,
        },
      },
    };
    await client.query(
      `INSERT INTO booking.guest_bookings(id,property_id,public_reference,source_system,lifecycle_status,
      check_in,check_out,adults,room_count,currency,total_amount,balance_amount,booking_metadata)
      VALUES($1::uuid,$2::uuid,$1::text,'booking','confirmed','2026-09-01','2026-09-03',6,3,'EUR',540,540,$3::jsonb)`,
      [id, PROPERTY, JSON.stringify(mixed.bookingMetadata)],
    );
    const invalid = structuredClone(mixed);
    invalid.bookingMetadata.selectedOffer.roomLines[1]!.offer.nightlyRoomAmounts.pop();
    await expect(
      captureDirectNightlyRevenueEvidence(client, invalid, { required: true }),
    ).rejects.toThrow();
    expect(
      (
        await client.query(
          "SELECT count(*)::int count FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
          [id],
        )
      ).rows[0].count,
    ).toBe(0);
    for (let retry = 0; retry < 2; retry++)
      await captureDirectNightlyRevenueEvidence(client, mixed, { required: true });
    const amounts = (
      await client.query(
        `SELECT room_type_id::text, SUM(gross_room_amount)::text amount,
      SUM(occupied_room_nights)::int nights, count(*)::int count FROM booking.nightly_revenue_evidence
      WHERE guest_booking_id=$1 GROUP BY room_type_id`,
        [id],
      )
    ).rows;
    expect(amounts).toEqual(
      expect.arrayContaining([
        { room_type_id: ROOM_TYPE, amount: "300.0000", nights: 4, count: 4 },
        { room_type_id: secondRoomType, amount: "240.0000", nights: 2, count: 2 },
      ]),
    );
    const reordered = structuredClone(mixed);
    reordered.bookingMetadata.selectedOffer.roomLines = [
      ...reordered.bookingMetadata.selectedOffer.roomLines,
    ].reverse();
    reordered.bookingMetadata.selectedOffer.roomSelection.lines =
      reordered.bookingMetadata.selectedOffer.roomLines;
    await captureDirectNightlyRevenueEvidence(client, reordered, { required: true });
    expect(
      (
        await client.query(
          "SELECT count(*)::int count FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
          [id],
        )
      ).rows[0].count,
    ).toBe(6);
    const expanded = structuredClone(mixed);
    expanded.bookingMetadata.selectedOffer.roomLines[0]!.guests.push({ adults: 2, children: 0 });
    await client.query(
      "UPDATE booking.guest_bookings SET room_count=4,total_amount=690,balance_amount=690 WHERE id=$1",
      [id],
    );
    for (let retry = 0; retry < 2; retry++)
      await captureDirectNightlyRevenueEvidence(client, expanded, {
        required: true,
        fingerprint: `expand-${id}`,
      });
    expect(
      (
        await client.query(
          "SELECT SUM(gross_room_amount)::text amount,SUM(occupied_room_nights)::int nights,count(*)::int count FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ amount: "690.0000", nights: 8, count: 8 });
    const single = {
      ...mixed,
      bookingMetadata: {
        requestFingerprint: `single-${id}`,
        selectedOffer: {
          roomTypeId: secondRoomType,
          nightlyRoomAmounts: lines[1]!.offer.nightlyRoomAmounts,
        },
      },
    };
    await client.query(
      "UPDATE booking.guest_bookings SET room_count=1,total_amount=240,balance_amount=240 WHERE id=$1",
      [id],
    );
    for (let retry = 0; retry < 2; retry++)
      await captureDirectNightlyRevenueEvidence(client, single, { required: true });
    expect(
      (
        await client.query(
          "SELECT SUM(gross_room_amount)::text amount,SUM(occupied_room_nights)::int nights FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1",
          [id],
        )
      ).rows[0],
    ).toEqual({ amount: "240.0000", nights: 2 });
    await client.query(
      "UPDATE booking.guest_bookings SET lifecycle_status='canceled' WHERE id=$1",
      [id],
    );
    await captureDirectNightlyRevenueEvidence(client, mixed, {
      required: true,
      clear: true,
      fingerprint: `cancel-${id}`,
    });
    const canceled = (
      await client.query(
        `SELECT SUM(gross_room_amount)::text amount,SUM(occupied_room_nights)::int nights
      FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 GROUP BY room_type_id`,
        [id],
      )
    ).rows;
    expect(canceled).toEqual([
      { amount: "0.0000", nights: 0 },
      { amount: "0.0000", nights: 0 },
    ]);
  });
});
