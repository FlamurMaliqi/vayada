import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";

const TEST_DATABASE_URL = process.env["TEST_DATABASE_URL"];
const id = (suffix: number) => `90700000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const propertyId = id(1);
const organizationId = id(2);
const roomTypeId = id(3);
const turnoverRoomId = id(4);
const receiptId = id(5);
const linkedRoomTypeId = id(9);

describe.skipIf(!TEST_DATABASE_URL)("PMS calendar occupancy projection", () => {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL ?? "postgresql://disabled" });
  const repository = createTargetPmsOperationsReadRepository({
    connectionString: TEST_DATABASE_URL ?? "postgresql://disabled",
    pool,
  });

  beforeAll(async () => {
    const databaseName = new URL(TEST_DATABASE_URL!).pathname.replace(/^\//, "");
    if (!/(^|[_-])test([_-]|$)/i.test(databaseName)) throw new Error("Unsafe test database");
  });

  beforeEach(async () => {
    await cleanup();
    await fixture(`
      INSERT INTO pms.room_types
        (id,property_id,name,occupancy_limits,base_rate_amount,currency)
      VALUES
        ('${roomTypeId}','${propertyId}','Occupancy fixture',
          '{"adults":8,"children":8,"total":8}',100,'EUR'),
        ('${linkedRoomTypeId}','${propertyId}','Linked target',
          '{"adults":8,"children":8,"total":8}',100,'EUR');
      INSERT INTO pms.inventory_days
        (property_id,room_type_id,stay_date,total_count,assigned_count,blocked_count,
         available_count,status)
      VALUES
        ('${propertyId}','${roomTypeId}','2026-08-20',8,6,1,1,'open'),
        ('${propertyId}','${roomTypeId}','2026-08-21',8,6,1,1,'open');
      INSERT INTO pms.inventory_reservation_receipts
        (receipt_id,contract_version,receipt_owner,organization_id,property_id,room_type_id,
         check_in,check_out,room_count,quote_session_id,public_offer_key,calendar_revision,
         materialized_revision,reserve_fingerprint_hash,reserve_idempotency_key_id,
         reserve_domain_event_id,reserve_outbox_event_id,reserved_at)
      VALUES ('${receiptId}','pms-inventory-reservation-lifecycle.v1','pms',
        '${organizationId}','${propertyId}','${roomTypeId}','2026-08-20','2026-08-22',1,
        'orphan-quote','fixture-offer',1,1,'sha256:${"a".repeat(64)}','${id(6)}','${id(7)}',
        '${id(8)}','2026-08-19T12:00:00Z');
      INSERT INTO pms.inventory_reservation_statuses
        (receipt_id,organization_id,property_id,lifecycle_state,lifecycle_revision)
      VALUES ('${receiptId}','${organizationId}','${propertyId}','reserved',1);
      INSERT INTO booking.guest_bookings
        (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,
         check_in,check_out,room_count,currency,booking_metadata)
      VALUES
        ('${id(10)}','${propertyId}','VAY-CONFIRMED','booking',NULL,'confirmed',
          '2026-08-20','2026-08-22',2,'EUR',${marker("confirmed-quote")}),
        ('${id(11)}','${propertyId}','VAY-PENDING','booking',NULL,'pending_payment',
          '2026-08-20','2026-08-22',1,'EUR',${marker("pending-quote")}),
        ('${id(12)}','${propertyId}','VAY-MANUAL','pms','manual','confirmed',
          '2026-08-20','2026-08-22',2,'EUR','{}'),
        ('${id(13)}','${propertyId}','VAY-TURNOVER','pms','turnover','confirmed',
          '2026-08-21','2026-08-22',1,'EUR','{}'),
        ('${id(14)}','${propertyId}','VAY-CANCELED','pms','canceled','canceled',
          '2026-08-20','2026-08-22',1,'EUR','{}'),
        ('${id(15)}','${propertyId}','VAY-RECEIPT','booking',NULL,'canceled',
          '2026-08-20','2026-08-22',1,'EUR',${receiptMarker()});
      INSERT INTO pms.operational_booking_assignments
        (id,property_id,guest_booking_id,room_type_id,room_id,position,assignment_status,
         source,stay_evidence_kind,check_in,check_out,adults,children)
      VALUES
        ('${id(20)}','${propertyId}','${id(10)}','${roomTypeId}',NULL,1,'assigned',
          'direct_booking','exact','2026-08-20','2026-08-22',2,0),
        ('${id(21)}','${propertyId}','${id(12)}','${roomTypeId}','${turnoverRoomId}',1,
          'assigned','manual','exact','2026-08-20','2026-08-21',1,0),
        ('${id(22)}','${propertyId}','${id(12)}','${roomTypeId}',NULL,2,'assigned',
          'manual','exact','2026-08-20','2026-08-22',1,0),
        ('${id(23)}','${propertyId}','${id(13)}','${roomTypeId}','${turnoverRoomId}',1,
          'assigned','manual','exact','2026-08-21','2026-08-22',1,0),
        ('${id(24)}','${propertyId}','${id(14)}','${roomTypeId}',NULL,1,'assigned',
          'manual','exact','2026-08-20','2026-08-22',1,0);
      INSERT INTO pms.room_blocks
        (id,property_id,room_type_id,starts_on,ends_on,blocked_count,reason,status,
         block_kind,source_room_type_id,source_inventory_reservation_receipt_id)
      VALUES ('${id(30)}','${propertyId}','${linkedRoomTypeId}','2026-08-20','2026-08-21',1,
        'Linked inventory','active','linked_booking','${roomTypeId}','${receiptId}');
    `);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("subtracts holds and projects eligible occupied units once per night", async () => {
    const result = await repository.listCalendarDaysByPropertyId(propertyId, {
      from: "2026-08-20",
      to: "2026-08-21",
    });

    expect(
      result.items.map(
        ({ stayDate, assignedCount, occupiedCount, blockedCount, assignmentRefs }) => ({
          stayDate,
          assignedCount,
          occupiedCount,
          blockedCount,
          assignmentRefs,
        }),
      ),
    ).toEqual([
      {
        stayDate: "2026-08-20",
        assignedCount: 6,
        occupiedCount: 4,
        blockedCount: 1,
        assignmentRefs: [id(20), id(21), id(22)],
      },
      {
        stayDate: "2026-08-21",
        assignedCount: 6,
        occupiedCount: 4,
        blockedCount: 1,
        assignmentRefs: [id(20), id(23), id(22)],
      },
    ]);
  });

  it("labels a receipt-derived linked block with its source booking reference", async () => {
    const result = await repository.listRoomBlocksByPropertyId(propertyId, {
      from: "2026-08-20",
      to: "2026-08-21",
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        blockId: id(30),
        sourceSummary: "Booking VAY-RECEIPT · Occupancy fixture",
      }),
    ]);
  });

  async function fixture(sql: string) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function cleanup() {
    await fixture(`
      DELETE FROM pms.operational_booking_assignments WHERE property_id='${propertyId}';
      DELETE FROM pms.room_blocks WHERE property_id='${propertyId}';
      DELETE FROM booking.guest_bookings WHERE property_id='${propertyId}';
      DELETE FROM pms.inventory_reservation_statuses WHERE property_id='${propertyId}';
      DELETE FROM pms.inventory_reservation_receipts WHERE property_id='${propertyId}';
      DELETE FROM pms.inventory_days WHERE property_id='${propertyId}';
      DELETE FROM pms.room_types WHERE property_id='${propertyId}';
    `);
  }
});

function marker(quoteSessionId: string) {
  return `'${JSON.stringify({
    inventoryReservation: {
      contractVersion: "pms.inventory-reservation.v1",
      owner: "pms",
      source: "booking_engine",
      quoteSessionId,
      propertyId,
      roomTypeId,
    },
  })}'::jsonb`;
}

function receiptMarker() {
  return `'${JSON.stringify({
    inventoryReservation: {
      contractVersion: "pms-inventory-reservation-lifecycle.v1",
      owner: "pms",
      receiptId,
    },
  })}'::jsonb`;
}
