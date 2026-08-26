import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { reconcilePmsOccupiedInventory } from "./pmsOccupiedInventory.js";
import { createTargetPmsOperationsCommandRepository } from "./pmsOperationsCommandRepository.js";
import type { PmsOperationsReadRepository } from "./pmsOperationsReadModel.js";

const DATABASE_URL = process.env["TEST_DATABASE_URL"];
const id = (suffix: number) => `13390000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const I = {
  property: id(1),
  organization: id(2),
  user: id(3),
  group: id(4),
  sourceType: id(10),
  targetType: id(11),
  sourceRoom: id(12),
  targetRoom: id(13),
  ratePlan: id(14),
  spareTargetRoom: id(15),
  thirdType: id(16),
  spareSourceRoom: id(17),
  booking: id(20),
  assignment: id(21),
  otherBooking: id(22),
  otherAssignment: id(23),
  receipt: id(24),
  manualBlock: id(25),
};
const acceptedAt = "2026-09-01T12:00:00.000Z";

describe.skipIf(!DATABASE_URL)("PostgreSQL cross-room-type assignment moves", () => {
  const pool = new pg.Pool({ connectionString: DATABASE_URL ?? "postgresql://disabled" });
  const repository = createTargetPmsOperationsCommandRepository({
    connectionString: DATABASE_URL ?? "postgresql://disabled",
    pool,
    now: () => new Date(acceptedAt),
    readRepository: {
      async findReservationByGuestBookingId(_propertyId: string, guestBookingId: string) {
        return { guestBookingId } as never;
      },
    } as unknown as PmsOperationsReadRepository,
  });

  // prettier-ignore
  beforeAll(async () => { const database = new URL(DATABASE_URL!).pathname.replace(/^\//, ""); if (!/(^|[_-])(test|verify)([_-]|$)/i.test(database)) throw new Error("Unsafe test database"); });
  beforeEach(async () => {
    await cleanup();
    await seed(false);
  });
  // prettier-ignore
  afterAll(async () => { await cleanup(); await repository.close?.(); await pool.end(); });

  it("moves one checked-in assignment, clears its source rate plan, and reconciles linked counts", async () => {
    await expect(move("linked-success")).resolves.toMatchObject({ ok: true });

    await expect(
      pool.query(
        `SELECT room_type_id::text AS type,room_id::text AS room,rate_plan_id AS rate,
                assignment_status AS status,check_in::text AS "checkIn",check_out::text AS "checkOut"
         FROM pms.operational_booking_assignments WHERE id=$1`,
        [I.assignment],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          type: I.targetType,
          room: I.targetRoom,
          rate: null,
          status: "checked_in",
          checkIn: "2026-09-02",
          checkOut: "2026-09-04",
        },
      ],
    });
    expect(await inventory()).toEqual([
      { type: I.sourceType, date: "2026-09-02", assigned: 0, blocked: 1, stopped: true },
      { type: I.sourceType, date: "2026-09-03", assigned: 0, blocked: 1, stopped: true },
      { type: I.targetType, date: "2026-09-02", assigned: 1, blocked: 0, stopped: true },
      { type: I.targetType, date: "2026-09-03", assigned: 1, blocked: 0, stopped: true },
    ]);
    await expect(
      pool.query(
        `SELECT source_room_type_id::text AS source,blocked_count AS blocked FROM pms.room_blocks
         WHERE source_assignment_id=$1 AND room_type_id=$2 AND status='active'`,
        [I.assignment, I.thirdType],
      ),
    ).resolves.toMatchObject({ rows: [{ source: I.targetType, blocked: 1 }] });
    const ari = await pool.query<{ roomTypeId: string; from: string; to: string }>(
      `SELECT DISTINCT resource_id::text AS "roomTypeId",payload#>>'{dateRange,from}' AS "from",
              payload#>>'{dateRange,to}' AS "to" FROM platform.outbox_events
       WHERE property_id=$1 AND destination='pms.channel-manager'
         AND event_type='pms.inventory.ari_changed' ORDER BY 1`,
      [I.property],
    );
    expect(ari.rows).toEqual(
      [I.sourceType, I.targetType, I.thirdType]
        .sort()
        .map((roomTypeId) => ({ roomTypeId, from: "2026-09-02", to: "2026-09-03" })),
    );
    const moved = await state();
    await expect(move("linked-success")).resolves.toMatchObject({ ok: true, replayed: true });
    await expect(state()).resolves.toEqual(moved);
  });

  it.each(["closed", "sell_limit", "receipt_only"] as const)(
    "rejects a %s target night atomically",
    async (kind) => {
      if (kind === "receipt_only") {
        await fixture(`UPDATE pms.room_types SET linked_inventory_group_id=NULL
          WHERE property_id='${I.property}'; DELETE FROM pms.room_blocks
          WHERE property_id='${I.property}'; UPDATE pms.inventory_days SET linked_stop_sell=false,
          blocked_count=0,available_count=effective_sellable_limit_count-assigned_count
          WHERE property_id='${I.property}';
          ${receiptSql("reserved", I.targetType)}`);
        await transaction((client) =>
          reconcilePmsOccupiedInventory(
            client,
            I.property,
            [{ roomTypeId: I.targetType, checkIn: "2026-09-02", checkOut: "2026-09-04" }],
            acceptedAt,
          ),
        );
      } else {
        await fixture(
          kind === "closed"
            ? `UPDATE pms.inventory_days SET status='closed',available_count=0
             WHERE property_id='${I.property}' AND room_type_id='${I.targetType}'
               AND stay_date='2026-09-03'`
            : `UPDATE pms.inventory_days SET manual_sellable_limit_count=0,
               effective_sellable_limit_count=0,available_count=0
             WHERE property_id='${I.property}' AND room_type_id='${I.targetType}'
               AND stay_date='2026-09-03'`,
        );
      }
      const before = await state();
      await expect(move(`unavailable-${kind}`)).resolves.toMatchObject({
        ok: false,
        code: "room_unavailable",
      });
      await expect(state()).resolves.toEqual(before);
    },
  );

  it.each([
    ["assignment", I.sourceType],
    ["assignment", I.targetType],
    ["receipt", I.sourceType],
    ["receipt", I.targetType],
    ["manual", I.sourceType],
    ["manual", I.targetType],
  ] as const)("rejects an independent %s cause from member %s", async (kind, roomTypeId) => {
    await addIndependentCause(kind, roomTypeId);
    const before = await state();
    await expect(move(`cause-${kind}-${roomTypeId}`)).resolves.toMatchObject({
      ok: false,
      code: "room_unavailable",
    });
    await expect(state()).resolves.toEqual(before);
  });

  it("uses another assignment's exact stay instead of its overlapping booking summary", async () => {
    await fixture(`INSERT INTO booking.guest_bookings
      (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,
       check_in,check_out,room_count,currency,booking_metadata)
      VALUES ('${I.otherBooking}','${I.property}','OTHER','pms','other','confirmed',
       '2026-09-02','2026-09-04',1,'EUR','{}');
      INSERT INTO pms.operational_booking_assignments
      (id,property_id,guest_booking_id,room_type_id,room_id,position,assignment_status,source,
       stay_evidence_kind,check_in,check_out,adults,children)
      VALUES ('${I.otherAssignment}','${I.property}','${I.otherBooking}','${I.targetType}',
       '${I.targetRoom}',2,'assigned','manual','exact','2026-09-10','2026-09-12',1,0);`);
    await expect(move("exact-non-overlap")).resolves.toMatchObject({ ok: true });
  });

  it("allows a same-type move at its effective sell limit", async () => {
    await fixture(`INSERT INTO pms.rooms
      (id,property_id,room_type_id,room_number,operational_label_status)
      VALUES ('${I.spareSourceRoom}','${I.property}','${I.sourceType}','102','verified')`);
    await expect(move("same-type-sell-limit", I.spareSourceRoom)).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      pool.query(`SELECT room_id::text AS room FROM pms.operational_booking_assignments
      WHERE id='${I.assignment}'`),
    ).resolves.toMatchObject({ rows: [{ room: I.spareSourceRoom }] });
  });

  it("keeps a handed-off receipt adopted after the assignment changes room type", async () => {
    await cleanup();
    await seed(true);
    await expect(move("durable-receipt")).resolves.toMatchObject({ ok: true });
    const moved = (await inventory()).map(({ type, assigned }) => ({ type, assigned }));
    expect(moved).toEqual([
      { type: I.sourceType, assigned: 0 },
      { type: I.sourceType, assigned: 0 },
      { type: I.targetType, assigned: 1 },
      { type: I.targetType, assigned: 1 },
    ]);
    await reconcileOccupied();
    expect((await inventory()).map(({ type, assigned }) => ({ type, assigned }))).toEqual(moved);
  });

  // prettier-ignore
  async function move(suffix: string, roomId = I.targetRoom) { return repository.executeAssignmentCommand({ propertyId: I.property, guestBookingId: I.booking, commandId: `move-${suffix}`, idempotencyKey: `move-${suffix}`, action: "move", assignmentId: I.assignment, roomId }); }

  async function seed(durableReceipt: boolean) {
    await fixture(`
      INSERT INTO hotel_catalog.properties (id,public_id,display_name)
        VALUES ('${I.property}','vay-1339-move','VAY-1339 move');
      INSERT INTO pms.linked_inventory_groups (id,property_id,name)
        VALUES ('${I.group}','${I.property}','Convertible');
      INSERT INTO pms.room_types
        (id,property_id,name,occupancy_limits,base_rate_amount,currency,linked_inventory_group_id)
        VALUES ('${I.sourceType}','${I.property}','Double','{"total":2}',100,'EUR','${I.group}'),
               ('${I.targetType}','${I.property}','Twin','{"total":2}',120,'EUR','${I.group}'),
               ('${I.thirdType}','${I.property}','Family','{"total":4}',160,'EUR','${I.group}');
      INSERT INTO pms.rate_plans
        (id,property_id,room_type_id,code,name,rate_type,cancellation_policy_snapshot,
         meal_plan,payment_policy,deposit_policy,base_rate_amount,currency,active,
         pricing_contract_version,flexible_rate_plan_revision,source_room_facts_revision,
         source_pricing_currency_revision)
        VALUES ('${I.ratePlan}','${I.property}','${I.sourceType}','FLEX','Flexible','flexible',
          '{"type":"free_until_days_before_arrival","freeCancellationDeadlineDays":7,
            "afterDeadlinePenalty":"full_booking_amount","noShowPenalty":"full_booking_amount"}',
          NULL,'{}','{}',100,'EUR',true,'pms-pricing.v1',1,1,1);
      INSERT INTO pms.rooms (id,property_id,room_type_id,room_number,operational_label_status)
        VALUES ('${I.sourceRoom}','${I.property}','${I.sourceType}','101','verified'),
               ('${I.targetRoom}','${I.property}','${I.targetType}','201','verified');
      INSERT INTO pms.operating_calendar_revisions
        (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,
         property_time_zone,schedule_mode,recurring_period_count,room_binding_count,
         default_minimum_stay_nights,idempotency_key_id,domain_event_id,outbox_event_id,
         created_by_user_id,created_at,updated_at)
        VALUES ('${I.organization}','${I.property}',1,'pms-operating-calendar.v1',1,'Europe/Berlin',
          'year_round',0,3,1,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),
          '${I.user}','${acceptedAt}','${acceptedAt}');
      INSERT INTO pms.operating_calendar_room_bindings
        (property_id,calendar_revision,room_type_id,source_room_facts_revision,
         source_room_units_revision,physical_capacity_count,starting_sellable_limit_count)
        VALUES ('${I.property}',1,'${I.sourceType}',1,1,1,1),
               ('${I.property}',1,'${I.targetType}',1,1,1,1),
               ('${I.property}',1,'${I.thirdType}',1,1,1,1);
      INSERT INTO pms.inventory_days
        (property_id,room_type_id,stay_date,total_count,assigned_count,blocked_count,
         available_count,status,calendar_revision,inventory_revision,
         generated_sellable_limit_count,effective_sellable_limit_count,
         generated_source_revision,channel_source_revision,manual_source_revision,
         block_source_revision,booking_source_revision,linked_source_revision,linked_stop_sell)
      SELECT '${I.property}',type,day,1,
        CASE WHEN type='${I.sourceType}' AND day BETWEEN '2026-09-02' AND '2026-09-03' THEN 1 ELSE 0 END,
        0,CASE WHEN type='${I.sourceType}' AND day BETWEEN '2026-09-02' AND '2026-09-03' THEN 0 ELSE 1 END,
        'open',1,1,1,1,1,0,0,0,1,0,false
      FROM unnest(ARRAY['${I.sourceType}','${I.targetType}','${I.thirdType}']::uuid[]) type
      CROSS JOIN generate_series('2026-09-01'::date,'2026-09-04','1 day') day;
      INSERT INTO booking.guest_bookings
        (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,
         check_in,check_out,room_count,currency,booking_metadata)
        VALUES ('${I.booking}','${I.property}','MOVE-1',
          '${durableReceipt ? "booking" : "pms"}','move-source','confirmed',
          '2026-09-01','2026-09-05',1,'EUR',
          '${JSON.stringify(durableReceipt ? marker() : {})}'::jsonb);
      INSERT INTO pms.operational_booking_assignments
        (id,property_id,guest_booking_id,room_type_id,room_id,rate_plan_id,position,
         assignment_status,source,stay_evidence_kind,check_in,check_out,adults,children,
         assignment_payload)
        VALUES ('${I.assignment}','${I.property}','${I.booking}','${I.sourceType}',
          '${I.sourceRoom}','${I.ratePlan}',1,'checked_in',
          '${durableReceipt ? "direct_booking" : "manual"}','exact','2026-09-02','2026-09-04',1,0,
          '${JSON.stringify(durableReceipt ? marker() : {})}'::jsonb);
      ${durableReceipt ? receiptSql("handed_off") : ""}
    `);
    await reconcileLinked();
  }

  async function addIndependentCause(kind: string, roomTypeId: string) {
    await fixture(`INSERT INTO pms.rooms
      (id,property_id,room_type_id,room_number,operational_label_status)
      VALUES ('${I.spareTargetRoom}','${I.property}','${I.targetType}','202','verified');
      UPDATE pms.inventory_days SET total_count=2,generated_sellable_limit_count=2,
        effective_sellable_limit_count=2,available_count=CASE WHEN linked_stop_sell THEN 0
          ELSE 2-assigned_count-blocked_count END WHERE property_id='${I.property}'
        AND room_type_id='${I.targetType}';`);
    await fixture(
      kind === "assignment"
        ? `INSERT INTO booking.guest_bookings
             (id,property_id,public_reference,source_system,source_booking_id,lifecycle_status,
              check_in,check_out,room_count,currency,booking_metadata)
           VALUES ('${I.otherBooking}','${I.property}','OTHER','pms','other','confirmed',
             '2026-09-10','2026-09-12',1,'EUR','{}');
           INSERT INTO pms.operational_booking_assignments
             (id,property_id,guest_booking_id,room_type_id,position,assignment_status,source,
              stay_evidence_kind,check_in,check_out,adults,children)
           VALUES ('${I.otherAssignment}','${I.property}','${I.otherBooking}','${roomTypeId}',2,
             'assigned','manual','exact','2026-09-02','2026-09-04',1,0);`
        : kind === "receipt"
          ? receiptSql("reserved", roomTypeId)
          : `INSERT INTO pms.room_blocks
               (id,property_id,room_type_id,starts_on,ends_on,reason)
             VALUES ('${I.manualBlock}','${I.property}','${roomTypeId}',
               '2026-09-02','2026-09-03','Independent maintenance');`,
    );
    await reconcileLinked();
  }

  function receiptSql(state: "reserved" | "handed_off", roomTypeId = I.sourceType) {
    return `INSERT INTO pms.inventory_reservation_receipts
      (receipt_id,contract_version,receipt_owner,organization_id,property_id,room_type_id,
       check_in,check_out,room_count,quote_session_id,public_offer_key,calendar_revision,
       materialized_revision,reserve_fingerprint_hash,reserve_idempotency_key_id,
       reserve_domain_event_id,reserve_outbox_event_id,reserved_at)
      VALUES ('${I.receipt}','pms-inventory-reservation-lifecycle.v1','pms','${I.organization}',
       '${I.property}','${roomTypeId}','2026-09-02','2026-09-04',1,'move-quote','offer',1,1,
       'sha256:${"a".repeat(64)}',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'${acceptedAt}');
      INSERT INTO pms.inventory_reservation_statuses
        (receipt_id,organization_id,property_id,lifecycle_state,lifecycle_revision,handed_off_at)
      VALUES ('${I.receipt}','${I.organization}','${I.property}','${state}',
        ${state === "handed_off" ? 2 : 1},${state === "handed_off" ? `'${acceptedAt}'` : "NULL"});`;
  }

  // prettier-ignore
  function marker() { return { inventoryReservation: { contractVersion: "pms-inventory-reservation-lifecycle.v1", owner: "pms", source: "booking_engine", propertyId: I.property, roomTypeId: I.sourceType, quoteSessionId: "move-quote", receiptId: I.receipt } }; }

  // prettier-ignore
  async function reconcileLinked() { await transaction(async (client) => { await reconcilePmsLinkedInventory(client, I.property, acceptedAt); }); }

  // prettier-ignore
  async function reconcileOccupied() { await transaction((client) => reconcilePmsOccupiedInventory(client, I.property, [{ roomTypeId: I.sourceType, checkIn: "2026-09-02", checkOut: "2026-09-04" }, { roomTypeId: I.targetType, checkIn: "2026-09-02", checkOut: "2026-09-04" }], acceptedAt)); }

  async function inventory() {
    const result = await pool.query(
      `SELECT room_type_id::text AS type,stay_date::text AS date,assigned_count AS assigned,
              blocked_count AS blocked,linked_stop_sell AS stopped
       FROM pms.inventory_days WHERE property_id=$1 AND stay_date BETWEEN '2026-09-02' AND '2026-09-03'
         AND room_type_id=ANY($2::uuid[])
       ORDER BY room_type_id,stay_date`,
      [I.property, [I.sourceType, I.targetType]],
    );
    return result.rows;
  }

  async function state() {
    const result = await pool.query(
      `SELECT jsonb_build_object(
        'assignment',(SELECT to_jsonb(a) FROM (SELECT room_type_id,room_id,rate_plan_id,
          assignment_status FROM pms.operational_booking_assignments WHERE id=$1) a),
        'inventory',(SELECT jsonb_agg(to_jsonb(i) ORDER BY room_type_id,stay_date) FROM
          (SELECT room_type_id,stay_date,assigned_count,blocked_count,available_count,status,
            inventory_revision,booking_source_revision,linked_source_revision,linked_stop_sell
           FROM pms.inventory_days WHERE property_id=$2) i),
        'blocks',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM (SELECT id,room_type_id,status,
          starts_on,ends_on FROM pms.room_blocks WHERE property_id=$2) b),
        'keys',(SELECT count(*) FROM platform.idempotency_keys WHERE property_id=$2),
        'events',(SELECT count(*) FROM platform.domain_events WHERE property_id=$2),
        'outbox',(SELECT count(*) FROM platform.outbox_events WHERE property_id=$2)) AS state`,
      [I.assignment, I.property],
    );
    return result.rows[0]!.state;
  }

  // prettier-ignore
  async function fixture(sql: string) { await transaction(async (client) => { await client.query("SET LOCAL session_replication_role=replica"); await client.query(sql); }); }

  async function transaction(work: (client: pg.PoolClient) => Promise<void>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await work(client);
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
      DELETE FROM platform.outbox_events WHERE property_id='${I.property}';
      DELETE FROM platform.domain_events WHERE property_id='${I.property}';
      DELETE FROM platform.idempotency_keys WHERE property_id='${I.property}';
      DELETE FROM pms.room_blocks WHERE property_id='${I.property}';
      DELETE FROM pms.operational_booking_assignments WHERE property_id='${I.property}';
      DELETE FROM booking.guest_bookings WHERE property_id='${I.property}';
      DELETE FROM pms.inventory_reservation_statuses WHERE property_id='${I.property}';
      DELETE FROM pms.inventory_reservation_receipts WHERE property_id='${I.property}';
      DELETE FROM pms.inventory_days WHERE property_id='${I.property}';
      DELETE FROM pms.operating_calendar_room_bindings WHERE property_id='${I.property}';
      DELETE FROM pms.operating_calendar_revisions WHERE property_id='${I.property}';
      DELETE FROM pms.rooms WHERE property_id='${I.property}';
      DELETE FROM pms.rate_plans WHERE property_id='${I.property}';
      DELETE FROM pms.room_types WHERE property_id='${I.property}';
      DELETE FROM pms.linked_inventory_groups WHERE property_id='${I.property}';
      DELETE FROM hotel_catalog.properties WHERE id='${I.property}';
    `);
  }
});
