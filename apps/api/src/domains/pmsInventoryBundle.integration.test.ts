import { quoteTargetRoomSelection } from "../routes/bookingWebMixedQuote.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createTargetPmsInventoryReservationPort } from "./pmsInventoryReservation.js";
import type { PmsInventoryReservationBundle } from "@vayada/domain-pms";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("mixed room inventory transactions", () => {
  const pool = new pg.Pool({ connectionString: url });
  const propertyId = randomUUID();
  const rooms = [randomUUID(), randomUUID()].sort();
  const port = createTargetPmsInventoryReservationPort();
  const input = {
    propertyId,
    checkIn: "2027-02-01",
    checkOut: "2027-02-03",
    currency: "EUR",
    occurredAt: new Date("2027-01-01T10:00:00Z"),
    lines: rooms.map((roomTypeId) => ({ roomTypeId, publicOfferKey: roomTypeId, roomCount: 2 })),
  };
  async function transaction<T>(run: (client: pg.PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const reserve = () =>
    transaction((client) =>
      port.reserveBundle!({
        ...input,
        quoteSessionId: randomUUID(),
        transaction: client,
      }),
    );
  const release = (reservation: PmsInventoryReservationBundle) =>
    transaction((client) => port.release({ ...input, transaction: client, reservation }));
  async function inventory() {
    return (
      await pool.query(
        `SELECT available_count FROM pms.inventory_days
      WHERE property_id=$1 ORDER BY room_type_id,stay_date`,
        [propertyId],
      )
    ).rows.map((row) => row.available_count);
  }
  beforeAll(async () => {
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO hotel_catalog.properties (id,public_id,display_name)
        VALUES ($1::uuid,$1::text,'Mixed room test')`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO hotel_catalog.property_public_profile_read_model
        (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status)
        VALUES ($1::uuid,$1::text,'Mixed room test',$1::text,'en',ARRAY['en'],'complete')`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO distribution.public_hotel_bookability_profiles
        (property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,
         default_currency,supported_currencies,profile_status,freshness_status,public_setup_completeness)
        VALUES ($1::uuid,$1::text,$1::text,'https://example.test','https://example.test','Europe/Athens','EUR',ARRAY['EUR'],
          'public','fresh','{"status":"ready"}')`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO pms.room_types (id,property_id,name,occupancy_limits,base_rate_amount,currency)
        SELECT id,$1,id::text,'{"adults":2,"total":2}',100,'EUR' FROM unnest($2::uuid[]) id`,
        [propertyId, rooms],
      );
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query(
        `INSERT INTO pms.operating_calendar_revisions
        (organization_id,property_id,calendar_revision,contract_version,property_profile_revision,
         property_time_zone,schedule_mode,recurring_period_count,room_binding_count,default_minimum_stay_nights,
         idempotency_key_id,domain_event_id,outbox_event_id,created_by_user_id,created_at,updated_at)
        VALUES (gen_random_uuid(),$1,1,'pms-operating-calendar.v1',1,'Europe/Athens','year_round',0,2,1,
          gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),now(),now())`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO pms.operating_calendar_room_bindings
        (property_id,calendar_revision,room_type_id,source_room_facts_revision,source_room_units_revision,
         physical_capacity_count,starting_sellable_limit_count)
        SELECT $1,1,id,1,1,2,2 FROM unnest($2::uuid[]) id`,
        [propertyId, rooms],
      );
      await client.query("SET LOCAL session_replication_role=origin");
      await client.query(
        `INSERT INTO pms.inventory_days
        (property_id,room_type_id,stay_date,total_count,available_count,calendar_revision,inventory_revision,
         generated_sellable_limit_count,effective_sellable_limit_count,generated_source_revision,
         channel_source_revision,manual_source_revision,block_source_revision,booking_source_revision)
        SELECT $1,id,day,2,2,1,1,2,2,1,0,0,0,0 FROM unnest($2::uuid[]) id,
          unnest(ARRAY[DATE '2027-02-01',DATE '2027-02-02']) day`,
        [propertyId, rooms],
      );
      await client.query(
        `INSERT INTO distribution.public_room_offer_snapshots
        (property_id,room_type_id,stay_date,public_offer_key,available_rooms,base_price_amount,
         currency,payment_options,freshness_status,occupancy,rate_summary)
        SELECT property_id,room_type_id,stay_date,room_type_id::text,2,100,'EUR',ARRAY['pay_at_property'],'fresh','{"maxAdults":2,"maxChildren":1,"maxOccupancy":2}','{"minStayNights":1}'
        FROM pms.inventory_days WHERE property_id=$1`,
        [propertyId],
      );
    });
  });
  afterAll(async () => {
    await transaction(async (client) => {
      await client.query("SET LOCAL session_replication_role=replica");
      for (const table of [
        "pms.inventory_reservation_statuses",
        "pms.inventory_reservation_day_watermarks",
        "pms.inventory_reservation_receipts",
        "platform.outbox_events",
        "platform.domain_events",
        "platform.idempotency_keys",
        "distribution.public_room_offer_snapshots",
        "pms.inventory_days",
        "pms.operating_calendar_room_bindings",
        "pms.operating_calendar_revisions",
        "pms.room_types",
        "pms.rate_rules",
        "pms.linked_inventory_groups",
        "pms.room_blocks",
        "distribution.public_hotel_bookability_profiles",
        "hotel_catalog.property_public_profile_read_model",
      ])
        await client.query(`DELETE FROM ${table} WHERE property_id=$1`, [propertyId]);
      await client.query("DELETE FROM hotel_catalog.properties WHERE id=$1", [propertyId]);
    });
    await pool.end();
  });
  const selection = {
    contractVersion: "booking-room-selection.v1",
    lines: [
      {
        roomTypeId: rooms[0]!,
        publicOfferKey: rooms[0]!,
        guests: [
          { adults: 2, children: 0 },
          { adults: 1, children: 1 },
        ],
      },
      { roomTypeId: rooms[1]!, publicOfferKey: rooms[1]!, guests: [{ adults: 2, children: 0 }] },
    ],
  };
  const quote = () =>
    quoteTargetRoomSelection(pool, {
      ...input,
      selection,
      today: "2027-01-01",
      requestedAt: input.occurredAt,
    });
  it("quotes six guests using actual per-room caps and exact full-stay combined prices", async () => {
    await pool.query(
      "UPDATE distribution.public_room_offer_snapshots SET base_price_amount=100.01 WHERE property_id=$1",
      [propertyId],
    );
    try {
      const result = await quote();
      expect(result.party).toEqual({ adults: 5, children: 1, rooms: 3 });
      expect(result.totals.totalAmount).toBe("600.06");
      expect(result.lines.map((line) => line.totals.roomTotal)).toEqual(["400.04", "200.02"]);
      expect(result.paymentOptions).toEqual(["pay_at_property"]);
    } finally {
      await pool.query(
        "UPDATE distribution.public_room_offer_snapshots SET base_price_amount=100 WHERE property_id=$1",
        [propertyId],
      );
    }
  });
  it.each([
    [
      "occupancy='{}'::jsonb",
      'occupancy=\'{"maxAdults":2,"maxChildren":1,"maxOccupancy":2}\'::jsonb',
    ],
    ["available_rooms=0", "available_rooms=2"],
    ["freshness_status='stale'", "freshness_status='fresh'"],
    ["rate_summary='{\"minStayNights\":3}'::jsonb", "rate_summary='{\"minStayNights\":1}'::jsonb"],
    ["payment_options=ARRAY['card']", "payment_options=ARRAY['pay_at_property']"],
  ])("rejects invalid per-night evidence (%s)", async (change, restore) => {
    await pool.query(
      `UPDATE distribution.public_room_offer_snapshots SET ${change} WHERE property_id=$1 AND room_type_id=$2 AND stay_date='2027-02-01'`,
      [propertyId, rooms[0]],
    );
    try {
      await expect(quote()).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      await pool.query(
        `UPDATE distribution.public_room_offer_snapshots SET ${restore} WHERE property_id=$1 AND room_type_id=$2`,
        [propertyId, rooms[0]],
      );
    }
  });
  it.each(["closed_to_arrival", "closed_to_departure"])(
    "checks %s on the boundary date",
    async (column) => {
      const date = column === "closed_to_arrival" ? input.checkIn : input.checkOut;
      await pool.query(
        `INSERT INTO pms.rate_rules(property_id,room_type_id,rule_type,starts_on,ends_on,${column})
      VALUES($1,$2,'arrival_departure_restriction',$3,$3,true)`,
        [propertyId, rooms[0], date],
      );
      try {
        await expect(quote()).rejects.toMatchObject({ statusCode: 409 });
      } finally {
        await pool.query("DELETE FROM pms.rate_rules WHERE property_id=$1", [propertyId]);
      }
    },
  );
  it("rolls back earlier room holds when a later room fails", async () => {
    await expect(
      transaction((client) =>
        port.reserveBundle!({
          ...input,
          transaction: client,
          quoteSessionId: randomUUID(),
          lines: [input.lines[0]!, { ...input.lines[1]!, roomCount: 3 }],
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await inventory()).toEqual([2, 2, 2, 2]);
    expect(
      (
        await pool.query(
          "SELECT count(*) FROM pms.inventory_reservation_receipts WHERE property_id=$1",
          [propertyId],
        )
      ).rows[0].count,
    ).toBe("0");
  });
  it("has one winner for simultaneous last-combination buyers and releases every hold once", async () => {
    const outcomes = await Promise.allSettled([reserve(), reserve()]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("Missing winner");
    expect(await inventory()).toEqual([0, 0, 0, 0]);
    await expect(
      release({ ...winner.value, receipts: winner.value.receipts.slice(0, 1) }),
    ).rejects.toThrow("scope mismatch");
    expect(await inventory()).toEqual([0, 0, 0, 0]);
    await release(winner.value);
    await release(winner.value);
    expect(await inventory()).toEqual([2, 2, 2, 2]);
  });
  it("replays the complete selection and rejects quote reuse before consuming stock", async () => {
    const quoteSessionId = randomUUID();
    const reserveLines = (lines: typeof input.lines) =>
      transaction((client) =>
        port.reserveBundle!({ ...input, lines, quoteSessionId, transaction: client }),
      );
    const first = await reserveLines([input.lines[0]!]);
    expect(await reserveLines([input.lines[0]!])).toEqual(first);
    expect(await inventory()).toEqual([0, 0, 2, 2]);
    await expect(reserveLines([input.lines[1]!])).rejects.toMatchObject({ statusCode: 409 });
    expect(await inventory()).toEqual([0, 0, 2, 2]);
    await release(first);
    expect(await inventory()).toEqual([2, 2, 2, 2]);
  });
  it("cannot combine two room types selling the same linked space", async () => {
    const group = randomUUID();
    await pool.query(
      "INSERT INTO pms.linked_inventory_groups(id,property_id,name) VALUES($1,$2,'Shared space')",
      [group, propertyId],
    );
    await pool.query(
      "UPDATE pms.room_types SET linked_inventory_group_id=$2 WHERE property_id=$1",
      [propertyId, group],
    );
    await expect(quote()).rejects.toMatchObject({ statusCode: 409 });
    await expect(reserve()).rejects.toMatchObject({ statusCode: 409 });
    expect(await inventory()).toEqual([2, 2, 2, 2]);
  });
});
