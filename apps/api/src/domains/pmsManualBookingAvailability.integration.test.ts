import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const PROPERTY = randomUUID(),
  TYPE = randomUUID(),
  ROOM_A = randomUUID(),
  ROOM_B = randomUUID(),
  ROOM_C = randomUUID();
const EXACT_BOOKING = randomUUID(),
  SUMMARY_BOOKING = randomUUID();

describe.skipIf(!TEST_DATABASE_URL)("manual-booking availability (PostgreSQL)", () => {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  const repository = createTargetPmsOperationsReadRepository({
    connectionString: "postgresql://manual-booking-availability",
    pool: client,
  });
  const stay = (roomId: string, checkIn: string, checkOut: string) => ({
    roomId,
    checkIn,
    checkOut,
  });

  beforeAll(async () => {
    if (!/test/i.test(new URL(TEST_DATABASE_URL!).pathname))
      throw new Error("Refusing non-test DB");
    await client.connect();
  });
  beforeEach(async () => {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1,$1::uuid::text,'Availability')
       RETURNING id`,
      [PROPERTY],
    );
    await client.query(
      "INSERT INTO pms.room_types (id,property_id,name,base_rate_amount,currency) VALUES ($1,$2,'Suite',0,'EUR')",
      [TYPE, PROPERTY],
    );
    await client.query(
      `INSERT INTO pms.rooms (id,property_id,room_type_id,room_number,operational_label_status)
       VALUES ($3,$2,$1,'A','verified'),($4,$2,$1,'B','verified'),($5,$2,$1,'C','verified')`,
      [TYPE, PROPERTY, ROOM_A, ROOM_B, ROOM_C],
    );
    await client.query("SET LOCAL session_replication_role=replica");
    await client.query(
      `INSERT INTO pms.inventory_days
         (property_id,room_type_id,stay_date,total_count,blocked_count,available_count,
          calendar_revision,inventory_revision,generated_sellable_limit_count,
          effective_sellable_limit_count,generated_source_revision,channel_source_revision,
          manual_source_revision,block_source_revision,booking_source_revision)
       SELECT $2,$1,day,3,CASE WHEN day='2027-07-05' THEN 2 ELSE 0 END,
         CASE WHEN day='2027-07-05' THEN 1 ELSE 3 END,1,1,3,3,1,0,0,1,0
       FROM generate_series('2027-07-01'::date,'2027-07-05','1 day') day`,
      [TYPE, PROPERTY],
    );
    await client.query("SET LOCAL session_replication_role=origin");
    await client.query(
      `INSERT INTO booking.guest_bookings
         (id,property_id,public_reference,lifecycle_status,check_in,check_out,currency)
       VALUES ($1,$3,$1::uuid::text,'confirmed','2027-07-01','2027-07-10','EUR'),
              ($2,$3,$2::uuid::text,'confirmed','2027-07-02','2027-07-04','EUR')`,
      [EXACT_BOOKING, SUMMARY_BOOKING, PROPERTY],
    );
    await client.query(
      `INSERT INTO pms.operational_booking_assignments
         (property_id,guest_booking_id,room_type_id,room_id,position,assignment_status,source,
          stay_evidence_kind,check_in,check_out,adults,children)
       VALUES ($3,$1,$4,$5,1,'assigned','direct_booking','exact','2027-07-02','2027-07-04',2,0),
              ($3,$2,$4,$6,1,'assigned','migration','summary_only',NULL,NULL,NULL,NULL)`,
      [EXACT_BOOKING, SUMMARY_BOOKING, PROPERTY, TYPE, ROOM_A, ROOM_B],
    );
    await client.query(
      `INSERT INTO pms.room_blocks (property_id,room_type_id,room_id,starts_on,ends_on)
       VALUES ($1,$2,$3,'2027-07-02','2027-07-02'),
              ($1,$2,NULL,'2027-07-05','2027-07-05')`,
      [PROPERTY, TYPE, ROOM_C],
    );
  });
  afterEach(() => client.query("ROLLBACK"));
  afterAll(() => client.end());

  it("fails closed for collisions and preserves half-open endpoints and ordering", async () => {
    await expect(
      repository.getPhysicalRoomAvailability(PROPERTY, [
        stay(ROOM_C, "2027-07-01", "2027-07-02"),
        stay(ROOM_C, "2027-07-01", "2027-07-02"),
      ]),
    ).resolves.toEqual([false, false]);
    await expect(
      repository.getPhysicalRoomAvailability(PROPERTY, [
        stay(ROOM_A, "2027-07-01", "2027-07-02"),
        stay(ROOM_A, "2027-07-04", "2027-07-05"),
        stay(ROOM_B, "2027-07-03", "2027-07-05"),
        stay(ROOM_C, "2027-07-02", "2027-07-03"),
      ]),
    ).resolves.toEqual([true, true, false, false]);
    await expect(
      repository.getPhysicalRoomAvailability(PROPERTY, [
        stay(ROOM_C, "2027-07-01", "2027-07-02"),
        stay(randomUUID(), "2027-07-01", "2027-07-02"),
        stay(ROOM_C, "2027-07-06", "2027-07-07"),
      ]),
    ).resolves.toEqual([true, null, false]);
    await expect(
      repository.getPhysicalRoomAvailability(PROPERTY, [
        stay(ROOM_B, "2027-07-05", "2027-07-06"),
        stay(ROOM_C, "2027-07-05", "2027-07-06"),
      ]),
    ).resolves.toEqual([false, false]);
    await expect(
      repository.getPhysicalRoomAvailability(PROPERTY, [
        stay(ROOM_C, "2027-07-02", "2027-07-02"),
        stay(ROOM_C, "2027-07-03", "2027-07-02"),
      ]),
    ).resolves.toEqual([false, false]);
  });
});
