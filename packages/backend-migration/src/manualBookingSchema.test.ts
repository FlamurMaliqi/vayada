import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertSafeTestDatabase } from "./testUtils.js";

const migration = await readFile(
  join(import.meta.dirname, "../migrations/0064_manual_booking_command_schema.sql"),
  "utf8",
);
const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = "30000000-0000-4000-8000-000000000001";
const OTHER_PROPERTY = "30000000-0000-4000-8000-000000000002";
const SUMMARY_BOOKING = "40000000-0000-4000-8000-000000000001";
const EXACT_BOOKING = "40000000-0000-4000-8000-000000000002";
const GAP_BOOKING = "40000000-0000-4000-8000-000000000003";
const OTHER_BOOKING = "40000000-0000-4000-8000-000000000004";
const TYPE_A = "50000000-0000-4000-8000-000000000001";
const TYPE_B = "50000000-0000-4000-8000-000000000002";
const OTHER_TYPE = "50000000-0000-4000-8000-000000000003";
const ROOM_A = "60000000-0000-4000-8000-000000000001";
const ROOM_B = "60000000-0000-4000-8000-000000000002";
const OTHER_ROOM = "60000000-0000-4000-8000-000000000003";
const PLAN_A = "70000000-0000-4000-8000-000000000001";
const OTHER_PLAN = "70000000-0000-4000-8000-000000000002";

describe.skipIf(!TEST_DATABASE_URL)("manual-booking target schema (PostgreSQL)", () => {
  let client: pg.Client;

  beforeEach(async () => {
    assertSafeTestDatabase(TEST_DATABASE_URL!);
    client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await createPredecessorSchema(client);
    await client.query(migration);
  });

  afterEach(async () => {
    try {
      await client.query("DROP SCHEMA IF EXISTS pms CASCADE");
      await client.query("DROP SCHEMA IF EXISTS booking CASCADE");
      await client.query("DROP SCHEMA IF EXISTS hotel_catalog CASCADE");
    } finally {
      await client.end();
    }
  });

  it("keeps migrated assignments summary-only and old reads compatible", async () => {
    const result = await client.query(
      `SELECT guest_booking_id::text AS "guestBookingId", position, assignment_status,
              stay_evidence_kind AS "evidenceKind", check_in, adults
       FROM pms.operational_booking_assignments WHERE guest_booking_id = $1::uuid`,
      [SUMMARY_BOOKING],
    );
    expect(result.rows).toEqual([
      {
        guestBookingId: SUMMARY_BOOKING,
        position: 1,
        assignment_status: "assigned",
        evidenceKind: "summary_only",
        check_in: null,
        adults: null,
      },
    ]);
  });

  it("stores heterogeneous exact stays without JSON authority", async () => {
    await client.query("BEGIN");
    await insertExact(client, { id: 2, roomTypeId: TYPE_A, roomId: ROOM_A, ratePlanId: PLAN_A });
    await insertExact(client, {
      id: 3,
      position: 2,
      roomTypeId: TYPE_B,
      roomId: ROOM_B,
      ratePlanId: null,
      checkIn: "2026-09-03",
      checkOut: "2026-09-07",
      adults: 1,
      children: 2,
    });
    await client.query("COMMIT");

    const result = await client.query(
      `SELECT position, room_type_id::text AS "roomTypeId", rate_plan_id::text AS "ratePlanId",
              check_in::text AS "checkIn", check_out::text AS "checkOut", adults, children
       FROM pms.operational_booking_assignments
       WHERE guest_booking_id = $1::uuid ORDER BY position`,
      [EXACT_BOOKING],
    );
    expect(result.rows).toEqual([
      {
        position: 1,
        roomTypeId: TYPE_A,
        ratePlanId: PLAN_A,
        checkIn: "2026-09-01",
        checkOut: "2026-09-04",
        adults: 2,
        children: 0,
      },
      {
        position: 2,
        roomTypeId: TYPE_B,
        ratePlanId: null,
        checkIn: "2026-09-03",
        checkOut: "2026-09-07",
        adults: 1,
        children: 2,
      },
    ]);
  });

  it("rejects incomplete dates, occupancy, evidence kind, and position gaps", async () => {
    for (const override of [
      { checkOut: null },
      { checkOut: "2026-08-31" },
      { adults: 0 },
      { children: -1 },
      { roomId: null },
      { position: 21 },
    ]) {
      await expect(insertExact(client, { id: 10, ...override })).rejects.toMatchObject({
        code: "23514",
      });
    }
    await expect(
      client.query(
        `INSERT INTO pms.operational_booking_assignments
         (id, property_id, guest_booking_id, room_type_id, room_id, position,
            assignment_status, source)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 1, 'assigned', 'manual')`,
        [PROPERTY, EXACT_BOOKING, TYPE_A, ROOM_A],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertExact(client, { id: 11, guestBookingId: GAP_BOOKING, position: 2 }),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "chk_pms_operational_assignments_positions_contiguous",
    });
  });

  it("rejects cross-property booking, room type, room, and rate plan evidence", async () => {
    for (const override of [
      { propertyId: OTHER_PROPERTY, guestBookingId: EXACT_BOOKING },
      { roomTypeId: OTHER_TYPE },
      { roomId: OTHER_ROOM },
      { ratePlanId: OTHER_PLAN },
    ]) {
      await expect(insertExact(client, { id: 20, ...override })).rejects.toMatchObject({
        code: "23503",
      });
    }
  });

  it("round-trips every paid and unpaid expected method", async () => {
    const methods = ["pay_at_property", "bank_transfer", "manual_card", "cash", "other"];
    for (const status of ["unpaid", "paid"]) {
      for (const method of methods) {
        const result = await client.query(
          `UPDATE booking.guest_bookings
           SET payment_status = $1, expected_payment_method = $2
           WHERE id = $3::uuid
           RETURNING payment_status, expected_payment_method`,
          [status, method, SUMMARY_BOOKING],
        );
        expect(result.rows[0]).toEqual({ payment_status: status, expected_payment_method: method });
      }
    }
    await expect(
      client.query("UPDATE booking.guest_bookings SET expected_payment_method = 'card'"),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

type ExactOverride = Partial<{
  id: number;
  propertyId: string;
  guestBookingId: string;
  roomTypeId: string;
  ratePlanId: string | null;
  roomId: string | null;
  position: number;
  checkIn: string;
  checkOut: string | null;
  adults: number;
  children: number;
}>;

async function insertExact(client: pg.Client, override: ExactOverride = {}): Promise<void> {
  await client.query(
    `INSERT INTO pms.operational_booking_assignments
       (id, property_id, guest_booking_id, room_type_id, rate_plan_id, room_id,
        position, assignment_status, source, stay_evidence_kind,
        check_in, check_out, adults, children)
     VALUES (('80000000-0000-4000-8000-' || lpad($1::text, 12, '0'))::uuid,
       $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
       $7, 'assigned', 'manual', 'exact', $8::date, $9::date, $10, $11)`,
    [
      override.id ?? 1,
      override.propertyId ?? PROPERTY,
      override.guestBookingId ?? EXACT_BOOKING,
      override.roomTypeId ?? TYPE_A,
      override.ratePlanId === undefined ? PLAN_A : override.ratePlanId,
      override.roomId === undefined ? ROOM_A : override.roomId,
      override.position ?? 1,
      override.checkIn ?? "2026-09-01",
      override.checkOut === undefined ? "2026-09-04" : override.checkOut,
      override.adults ?? 2,
      override.children ?? 0,
    ],
  );
}

async function createPredecessorSchema(client: pg.Client): Promise<void> {
  await client.query(`
    DROP SCHEMA IF EXISTS pms CASCADE; DROP SCHEMA IF EXISTS booking CASCADE;
    DROP SCHEMA IF EXISTS hotel_catalog CASCADE;
    CREATE SCHEMA hotel_catalog; CREATE SCHEMA booking; CREATE SCHEMA pms;
    CREATE TABLE hotel_catalog.properties (id UUID PRIMARY KEY);
    CREATE TABLE booking.guest_bookings (
      id UUID PRIMARY KEY, property_id UUID NOT NULL REFERENCES hotel_catalog.properties(id),
      payment_status TEXT NOT NULL CHECK (payment_status IN ('unpaid', 'paid')),
      UNIQUE (id, property_id)
    );
    CREATE TABLE pms.room_types (
      id UUID PRIMARY KEY, property_id UUID NOT NULL, UNIQUE (id, property_id)
    );
    CREATE TABLE pms.rooms (
      id UUID PRIMARY KEY, property_id UUID NOT NULL, room_type_id UUID NOT NULL,
      UNIQUE (id, property_id, room_type_id)
    );
    CREATE TABLE pms.rate_plans (
      id UUID PRIMARY KEY, property_id UUID NOT NULL, room_type_id UUID NOT NULL,
      UNIQUE (id, property_id, room_type_id)
    );
    CREATE TABLE pms.operational_booking_assignments (
      id UUID PRIMARY KEY, property_id UUID NOT NULL, guest_booking_id UUID NOT NULL,
      room_type_id UUID NOT NULL, rate_plan_id UUID, room_id UUID,
      position INTEGER NOT NULL DEFAULT 1, assignment_status TEXT NOT NULL,
      source TEXT NOT NULL, CONSTRAINT chk_pms_operational_assignments_position CHECK (position >= 1),
      UNIQUE (guest_booking_id, position),
      FOREIGN KEY (guest_booking_id, property_id) REFERENCES booking.guest_bookings(id, property_id),
      FOREIGN KEY (room_type_id, property_id) REFERENCES pms.room_types(id, property_id),
      FOREIGN KEY (rate_plan_id, property_id, room_type_id) REFERENCES pms.rate_plans(id, property_id, room_type_id),
      FOREIGN KEY (room_id, property_id, room_type_id) REFERENCES pms.rooms(id, property_id, room_type_id)
    );
    INSERT INTO hotel_catalog.properties VALUES ('${PROPERTY}'), ('${OTHER_PROPERTY}');
    INSERT INTO booking.guest_bookings VALUES
      ('${SUMMARY_BOOKING}', '${PROPERTY}', 'unpaid'), ('${EXACT_BOOKING}', '${PROPERTY}', 'unpaid'),
      ('${GAP_BOOKING}', '${PROPERTY}', 'unpaid'), ('${OTHER_BOOKING}', '${OTHER_PROPERTY}', 'unpaid');
    INSERT INTO pms.room_types VALUES
      ('${TYPE_A}', '${PROPERTY}'), ('${TYPE_B}', '${PROPERTY}'), ('${OTHER_TYPE}', '${OTHER_PROPERTY}');
    INSERT INTO pms.rooms VALUES
      ('${ROOM_A}', '${PROPERTY}', '${TYPE_A}'), ('${ROOM_B}', '${PROPERTY}', '${TYPE_B}'),
      ('${OTHER_ROOM}', '${OTHER_PROPERTY}', '${OTHER_TYPE}');
    INSERT INTO pms.rate_plans VALUES
      ('${PLAN_A}', '${PROPERTY}', '${TYPE_A}'), ('${OTHER_PLAN}', '${OTHER_PROPERTY}', '${OTHER_TYPE}');
    INSERT INTO pms.operational_booking_assignments
      (id, property_id, guest_booking_id, room_type_id, room_id, position, assignment_status, source)
    VALUES (gen_random_uuid(), '${PROPERTY}', '${SUMMARY_BOOKING}', '${TYPE_A}', '${ROOM_A}', 1, 'assigned', 'manual');
  `);
}
