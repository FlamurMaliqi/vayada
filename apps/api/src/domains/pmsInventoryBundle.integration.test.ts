import { createTargetPmsOperationsReadRepository } from "./pmsOperationsReadModel.js";
import { findTargetRoomCombinationOffers } from "../routes/bookingRoomCombinationOffers.js";
import { pendingBookingEdit } from "../routes/pendingBookingEdits.js";
import { createTargetMixedCheckoutQuote } from "../routes/bookingWebMixedSnapshot.js";
import {
  targetBookingHostActionPrimitives as bookingOwner,
  redeemTargetPromo,
  enqueuePmsReservationHandoff,
  issueTargetBookingConfirmationToken,
  loadTargetBooking,
  sha256Hex,
  serializeTargetBooking,
  serializeTargetCheckoutQuote,
  resolveTargetCancellationPreview,
  createTargetGuestBooking,
  loadTargetCheckoutQuoteSnapshot,
} from "../routes/bookingWebPublic.js";
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
  const addonId = randomUUID();
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
        "INSERT INTO hotel_catalog.property_slugs(property_id,slug,purpose,status) VALUES($1::uuid,$1::text,'canonical','active')",
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
      await client.query(
        `INSERT INTO booking.booking_settings(property_id,acceptance_mode,default_currency,phone_required)
        VALUES ($1,'request','EUR',false)`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO finance.payment_settings(property_id,payments_enabled,accepted_methods,default_currency)
        VALUES ($1,true,ARRAY['pay_at_property','cash'],'EUR')`,
        [propertyId],
      );
      await client.query(
        `UPDATE distribution.public_hotel_bookability_profiles SET capabilities='{"paymentMethods":["pay_at_property"]}' WHERE property_id=$1`,
        [propertyId],
      );
      await client.query(
        `INSERT INTO booking.addon_definitions(id,property_id,source_addon_id,name,pricing_model,price_amount,currency,ownership_kind,partner_commission_rate)
        VALUES($1::uuid,$2::uuid,$1::text,'One booking add-on','per_stay',10.25,'EUR','partner',18.75)`,
        [addonId, propertyId],
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
      for (const table of ["booking.booking_guests", "booking.booking_status_events"])
        await client.query(
          `DELETE FROM ${table} WHERE guest_booking_id IN (SELECT id FROM booking.guest_bookings WHERE property_id=$1)`,
          [propertyId],
        );
      for (const table of [
        "platform.jobs",
        "platform.product_audit_events",
        "booking.pending_booking_edit_attempts",
        "booking.booking_addon_selections",
        "booking.direct_booking_summary_read_model",
        "booking.guest_bookings",
        "booking.checkout_contexts",
        "booking.promo_applications",
        "booking.promo_definitions",
        "booking.quote_sessions",
        "booking.addon_definitions",
        "booking.booking_settings",
        "finance.payment_settings",
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
        "hotel_catalog.property_slugs",
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
  const search = (adults = 5, children = 1, maxCandidates?: number) =>
    findTargetRoomCombinationOffers(pool, {
      ...input, adults, children, today: "2027-01-01", requestedAt: input.occurredAt,
      paymentMethods: ["pay_at_property"], maxCandidates,
    });
  it("discovers and reprices complete selections from canonical full-stay evidence", async () => {
    const result = await search();
    expect(result.complete).toBe(true);
    expect(result.eligibleOfferCount).toBe(2);
    expect(result.options[0]?.party).toEqual({ adults: 5, children: 1, rooms: 3 });
    expect(result.options[0]?.lines).toHaveLength(2);
    expect(result.options[0]?.totals.totalAmount).toBe("600.00");
    expect(result.options[0]?.paymentOptions).toEqual(["pay_at_property"]);
    expect(result.options[0]?.expiresAt).toBe("2027-01-01T10:15:00.000Z");
    expect((await search(4, 0)).options.every((option) => option.lines.length === 1)).toBe(true);
    expect(await search(9, 0)).toMatchObject({ complete: true, eligibleOfferCount: 2, options: [] });
    expect(await search(5, 1, 1)).toEqual({ complete: false, eligibleOfferCount: 0, options: [] });
  });
  it("uses the minimum occupancy over every night and requires every explicit bound", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE distribution.public_room_offer_snapshots SET occupancy=jsonb_set(occupancy,'{maxAdults}','1') WHERE property_id=$1 AND stay_date='2027-02-02'", [propertyId]);
      const run = () => findTargetRoomCombinationOffers(client, { ...input, adults: 5, children: 0,
        today: "2027-01-01", requestedAt: input.occurredAt, paymentMethods: ["pay_at_property"] });
      expect(await run()).toMatchObject({ complete: true, eligibleOfferCount: 2, options: [] });
      await client.query("UPDATE distribution.public_room_offer_snapshots SET occupancy=occupancy-'maxChildren' WHERE property_id=$1", [propertyId]);
      expect(await run()).toMatchObject({ complete: false, eligibleOfferCount: 0, options: [] });
      for (const bound of ['"unknown"', '99999999999999999999999999999']) {
        await client.query("UPDATE distribution.public_room_offer_snapshots SET occupancy=jsonb_set(occupancy,'{maxChildren}',$2::jsonb) WHERE property_id=$1", [propertyId, bound]);
        expect(await run()).toMatchObject({ complete: false, eligibleOfferCount: 0, options: [] });
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("credits complete reserved bundles without assuming receipt order or an original quote UUID", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reservation = await port.reserveBundle!({ ...input, transaction: client, quoteSessionId: `change-request:${randomUUID()}` });
      const base = { ...input, transaction: client, reservation: { ...reservation, receipts: [...reservation.receipts].reverse() } };
      expect(await port.bundleAvailabilityCredits!(base)).toEqual(new Map(rooms.map((id) => [id, { checkIn: input.checkIn, checkOut: input.checkOut, roomCount: 2 }])));
      expect(await port.bundleAvailabilityCredits!({ ...base, propertyId: randomUUID() })).toBeNull();
      expect(await port.bundleAvailabilityCredits!({ ...base, checkOut: "2027-02-04" })).toBeNull();
      expect(await port.bundleAvailabilityCredits!({ ...base, lines: input.lines.map((line) => ({ ...line, roomCount: 1 })) })).toBeNull();
      expect(await port.bundleAvailabilityCredits!({ ...base, lines: [input.lines[0]!], reservation: { ...reservation, receipts: [reservation.receipts[0]!] } })).toBeNull();
      await client.query("SAVEPOINT duplicate_type");
      // Corrupt only this transaction's synthetic receipt to exercise a shape the normal bundle writer forbids.
      await client.query("SET LOCAL session_replication_role=replica");
      await client.query("UPDATE pms.inventory_reservation_receipts SET room_type_id=$2::text::uuid,public_offer_key=$2::text WHERE receipt_id=$1", [reservation.receipts[1]!.receiptId, rooms[0]]);
      expect(await port.bundleAvailabilityCredits!(base)).toBeNull();
      await client.query("ROLLBACK TO SAVEPOINT duplicate_type");
      await port.release({ ...input, transaction: client, reservation });
      expect(await port.bundleAvailabilityCredits!(base)).toBeNull();
    } finally { await client.query("ROLLBACK"); client.release(); }
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
      expect(await search()).toMatchObject({ complete: false, options: [] });
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
      expect(await search()).toMatchObject({ complete: false, options: [] });
      } finally {
        await pool.query("DELETE FROM pms.rate_rules WHERE property_id=$1", [propertyId]);
      }
    },
  );
  it("retains every room line when confirmed dates are repriced and replaced", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const property = { propertyId, displayName: "Mixed room test", defaultLocale: "en", timezone: "Europe/Athens" };
      const request = { checkIn: input.checkIn, checkOut: input.checkOut, roomSelection: selection,
        adults: 5, children: 1, numberOfRooms: 3, paymentMethod: "pay_at_property", email: "mixed@example.test" };
      const context = { operation: "change", requestId: randomUUID(), correlationId: randomUUID(),
        idempotencyKey: randomUUID(), fingerprint: randomUUID(), occurredAt: input.occurredAt, actorUserId: randomUUID() };
      await client.query("INSERT INTO identity.users(id,email,status) VALUES($1,$2,'active')", [context.actorUserId, `${context.actorUserId}@example.test`]);
      const quote = await createTargetMixedCheckoutQuote(client, property, request, input.occurredAt);
      const created = await createTargetGuestBooking(client, port, property, { ...request, expectedTotalAmount: quote.totalAmount }, context, quote, null, null, null);
      await client.query("UPDATE booking.guest_bookings SET lifecycle_status='confirmed' WHERE id=$1", [created.guestBookingId]);
      const booking = await bookingOwner.loadBooking(client, propertyId, created.guestBookingId, true);
      const preview = await bookingOwner.previewDates(client, port, property, booking, { checkIn: "2027-02-02", checkOut: input.checkOut }, input.occurredAt);
      expect(preview).toMatchObject({ blocked: false, newTotal: 300 });
      const selectedOffer = preview.pricingSnapshot!["selectedOffer"] as Record<string, unknown>;
      expect(selectedOffer["roomSelection"]).toEqual(selection);
      expect(selectedOffer["roomLines"]).toHaveLength(2);
      await client.query("SAVEPOINT changed_policy");
      await client.query("UPDATE distribution.public_room_offer_snapshots SET public_policy='{\"type\":\"non_refundable\"}' WHERE property_id=$1 AND room_type_id=$2", [propertyId, rooms[1]]);
      const changed = await bookingOwner.previewDates(client, port, property, booking, { checkIn: "2027-02-02", checkOut: input.checkOut }, input.occurredAt);
      expect(changed.newTotal).toBe(preview.newTotal);
      expect(() => bookingOwner.assertDatesUnchanged(preview, changed)).toThrow("submit a new request");
      await client.query("ROLLBACK TO SAVEPOINT changed_policy");
      expect(() => bookingOwner.assertDatesUnchanged(preview, preview)).not.toThrow();
      const oldReceipt = booking.bookingMetadata as { inventoryReservation: PmsInventoryReservationBundle };
      await port.release({ transaction: client, propertyId, reservation: oldReceipt.inventoryReservation, occurredAt: input.occurredAt });
      const revision = randomUUID();
      const receipt = await bookingOwner.reserveDates(port, selectedOffer, { transaction: client, propertyId,
        quoteSessionId: `host-edit:${revision}`, roomTypeId: rooms[0]!, publicOfferKey: rooms[0]!,
        checkIn: preview.requestedCheckIn, checkOut: preview.requestedCheckOut, roomCount: 3, currency: "EUR", occurredAt: input.occurredAt });
      expect(receipt && "receipts" in receipt && receipt.receipts.length).toBe(2);
      const updated = await bookingOwner.applyDates(client, { booking, changeRequest: { id: revision, hostEdit: true },
        preview, selectedOffer, inventoryReservation: { ...receipt! }, context });
      expect(updated.publicReference).toBe(created.publicReference);
      expect(updated.roomCount).toBe(3);
      expect(updated.totalAmount).toBe("300.00");
      expect(serializeTargetBooking(updated)["roomLines"]).toHaveLength(2);
      const pms = await createTargetPmsOperationsReadRepository({ connectionString: url!, pool: client })
        .findReservationByGuestBookingId(propertyId, updated.guestBookingId);
      expect(pms?.roomLines?.map((line) => line.totals["totalAmount"])).toEqual(["200.00", "100.00"]);
      // A subsequent change must credit the latest bundle, not the original checkout quote.
      expect(await bookingOwner.previewDates(client, port, property, updated, { checkIn: input.checkIn, checkOut: input.checkOut }, input.occurredAt))
        .toMatchObject({ blocked: false, newTotal: 600 });
      expect(await bookingOwner.previewDates(client, port, property, { ...updated, paymentStatus: "paid" }, { checkIn: input.checkIn, checkOut: input.checkOut }, input.occurredAt))
        .toMatchObject({ blocked: true });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("persists the full selection, prices add-ons once, and rejects quote selection tampering", async () => {
    const property = {
      propertyId,
      displayName: "Mixed room test",
      defaultLocale: "en",
      timezone: "Europe/Athens",
    };
    const request = {
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      roomSelection: selection,
      adults: 5,
      children: 1,
      numberOfRooms: 3,
      addonIds: [addonId],
      paymentMethod: "pay_at_property",
    };
    const saved = await transaction((client) =>
      createTargetMixedCheckoutQuote(client, property, request, input.occurredAt),
    );
    await expect(
      transaction((client) =>
        createTargetMixedCheckoutQuote(
          client,
          property,
          { ...request, currency: "USD" },
          input.occurredAt,
        ),
      ),
    ).rejects.toThrow("Property currency changed");
    await pool.query(
      `INSERT INTO booking.promo_definitions(property_id,code,discount_type,discount_value)
      VALUES($1,'MIXED50','fixed',50)`,
      [propertyId],
    );
    await pool.query(
      `UPDATE booking.booking_settings SET last_minute_discount=
      '{"enabled":true,"tiers":[{"daysBeforeMin":0,"daysBeforeMax":null,"discountPercent":5}]}' WHERE property_id=$1`,
      [propertyId],
    );
    const discounted = await transaction((client) =>
      createTargetMixedCheckoutQuote(
        client,
        property,
        { ...request, promoCode: "MIXED50" },
        new Date(input.occurredAt.getTime() + 1000),
      ),
    );
    expect(discounted.totalAmount).toBe("560.25");
    expect(discounted.totals["promoDiscount"]).toBe(50);
    expect(discounted.totals["promoAddonDiscount"]).toBe("0.83");
    expect(
      (discounted.selectedOfferSnapshot["roomLines"] as Array<{ totals: unknown }>).map(
        (line) => line.totals,
      ),
    ).toEqual([
      expect.objectContaining({ promoDiscount: "32.78", totalAmount: "367.22" }),
      expect.objectContaining({ promoDiscount: "16.39", totalAmount: "183.61" }),
    ]);
    expect(
      (discounted.selectedOfferSnapshot["roomLines"] as Array<{ promotion: unknown }>).every(
        (line) => line.promotion === null,
      ),
    ).toBe(true);
    expect(discounted.totals["promotionDiscount"]).toBeUndefined();

    await pool.query(
      "UPDATE booking.promo_definitions SET applicable_room_ids=$2::uuid[] WHERE property_id=$1",
      [propertyId, [rooms[0]]],
    );
    await expect(
      transaction((client) =>
        createTargetMixedCheckoutQuote(
          client,
          property,
          { ...request, promoCode: "MIXED50" },
          new Date(input.occurredAt.getTime() + 2000),
        ),
      ),
    ).rejects.toThrow("does not apply to every selected room");
    expect(saved.totalAmount).toBe("610.25");
    expect(saved.totals["addonTotal"]).toBe(10.25);
    expect(saved.selectedOfferSnapshot["roomSelection"]).toEqual(selection);
    expect(saved.policySnapshot["type"]).toBe("mixed_room");
    const bound = { ...request, roomTypeId: rooms[0], quoteId: saved.publicQuoteReference };
    expect(
      (await loadTargetCheckoutQuoteSnapshot(pool, propertyId, bound, input.occurredAt))
        .totalAmount,
    ).toBe("610.25");
    await expect(
      loadTargetCheckoutQuoteSnapshot(
        pool,
        propertyId,
        { ...bound, roomSelection: { ...selection, lines: selection.lines.slice(0, 1) } },
        input.occurredAt,
      ),
    ).rejects.toThrow("Room selection changed");
  });
  it("revalidates every line and creates one booking with all receipts atomically", async () => {
    const property = {
      propertyId,
      displayName: "Mixed room test",
      defaultLocale: "en",
      timezone: "Europe/Athens",
    };
    const request = {
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      roomSelection: selection,
      adults: 5,
      children: 1,
      numberOfRooms: 3,
      paymentMethod: "pay_at_property",
      email: "mixed@example.test",
    };
    const context = {
      operation: "create",
      requestId: randomUUID(),
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      fingerprint: randomUUID(),
      occurredAt: input.occurredAt,
    };
    await pool.query(
      "UPDATE booking.booking_settings SET last_minute_discount='{}' WHERE property_id=$1",
      [propertyId],
    );
    const quote = await transaction((client) =>
      createTargetMixedCheckoutQuote(client, property, request, input.occurredAt),
    );
    const createRequest = { ...request, expectedTotalAmount: quote.totalAmount };
    for (const mutation of [
      "base_price_amount = 110",
      'public_policy = \'{"type":"non_refundable"}\'',
      'occupancy = \'{"maxAdults":1,"maxChildren":0,"maxGuests":1}\'',
      "available_rooms = 0",
    ]) {
      await expect(
        transaction(async (client) => {
          await client.query(
            `UPDATE distribution.public_room_offer_snapshots SET ${mutation} WHERE property_id=$1 AND room_type_id=$2`,
            [propertyId, rooms[1]],
          );
          await createTargetGuestBooking(
            client,
            port,
            property,
            createRequest,
            context,
            quote,
            null,
            null,
            null,
          );
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await inventory()).toEqual([2, 2, 2, 2]);
    }
    await expect(
      transaction(async (client) => {
        await client.query(
          `UPDATE booking.booking_settings SET last_minute_discount=
        '{"enabled":true,"tiers":[{"daysBeforeMin":0,"daysBeforeMax":null,"discountPercent":10}]}' WHERE property_id=$1`,
          [propertyId],
        );
        await createTargetGuestBooking(
          client,
          port,
          property,
          createRequest,
          context,
          quote,
          null,
          null,
          null,
        );
      }),
    ).rejects.toThrow("Room selection changed");
    await expect(
      transaction(async (client) => {
        await client.query(
          "UPDATE booking.promo_definitions SET applicable_room_ids=NULL WHERE property_id=$1",
          [propertyId],
        );
        const couponQuote = await createTargetMixedCheckoutQuote(
          client,
          property,
          { ...request, promoCode: "MIXED50" },
          new Date(input.occurredAt.getTime() + 3000),
        );
        const booking = await createTargetGuestBooking(
          client,
          port,
          property,
          { ...request, expectedTotalAmount: couponQuote.totalAmount },
          context,
          couponQuote,
          null,
          null,
          null,
        );
        await client.query(
          "UPDATE booking.promo_definitions SET discount_value=5 WHERE property_id=$1",
          [propertyId],
        );
        await redeemTargetPromo(client, property, booking, couponQuote, input.occurredAt);
      }),
    ).rejects.toThrow("Promo discount changed");
    expect(await inventory()).toEqual([2, 2, 2, 2]);
    const rollback = new Error("roll back synthetic booking");
    await expect(
      transaction(async (client) => {
        const booking = await createTargetGuestBooking(
          client,
          port,
          property,
          createRequest,
          context,
          quote,
          null,
          null,
          null,
        );
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(booking.roomCount).toBe(3);
        const metadata = booking.bookingMetadata as Record<string, unknown>;
        const bundle = metadata["inventoryReservation"] as PmsInventoryReservationBundle;
        expect(bundle.receipts).toHaveLength(2);
        const credits = await port.selectionAvailabilityCredits!({
          transaction: client,
          propertyId,
          guestBookingId: booking.guestBookingId,
        });
        expect([...credits.values()].map((value) => value.roomCount).sort()).toEqual([1, 2]);
        expect(
          await port.selectionAvailabilityCredits!({
            transaction: client,
            propertyId: randomUUID(),
            guestBookingId: booking.guestBookingId,
          }),
        ).toEqual(new Map());
        const replacement = await createTargetMixedCheckoutQuote(
          client,
          property,
          request,
          new Date(input.occurredAt.getTime() + 6000),
          { bookingId: booking.guestBookingId, revision: 0 },
          credits,
        );
        expect(replacement.totalAmount).toBe(quote.totalAmount);
        await client.query("SAVEPOINT incomplete_bundle");
        await client.query(
          `UPDATE booking.guest_bookings SET booking_metadata=jsonb_set(booking_metadata,
          '{inventoryReservation,receipts}',(booking_metadata#>'{inventoryReservation,receipts}')-0) WHERE id=$1`,
          [booking.guestBookingId],
        );
        expect(
          await port.selectionAvailabilityCredits!({
            transaction: client,
            propertyId,
            guestBookingId: booking.guestBookingId,
          }),
        ).toEqual(new Map());
        await client.query("ROLLBACK TO SAVEPOINT incomplete_bundle");
        const projected = serializeTargetBooking(booking);
        expect(projected["roomSelection"]).toEqual(selection);
        expect(projected["roomLines"]).toHaveLength(2);
        expect(serializeTargetCheckoutQuote(quote)["roomLines"]).toEqual(projected["roomLines"]);
        expect(JSON.stringify(projected["roomLines"])).not.toContain("sourceFreshness");
        await enqueuePmsReservationHandoff(client, propertyId, booking, context, "create");
        const job = (
          await client.query(
            "SELECT payload FROM platform.jobs WHERE property_id=$1 AND resource_id=$2",
            [propertyId, booking.guestBookingId],
          )
        ).rows[0].payload;
        expect(job.inventoryReservation).toEqual(bundle);
        expect(job.bookedOffer.roomSelection).toEqual(selection);
        const cancellationBooking = structuredClone(booking);
        const cancellationOffer = (
          cancellationBooking.bookingMetadata as {
            selectedOffer: {
              roomLines: Array<{ offer: { publicPolicy: unknown; rateSummary: unknown } }>;
            };
          }
        ).selectedOffer;
        cancellationOffer.roomLines.forEach((line, index) => {
          line.offer.publicPolicy = {
            type: "free_until_days_before_arrival",
            freeCancellationDeadlineDays: index ? 7 : 3,
            afterDeadlinePenalty: "full_booking_amount",
            noShowPenalty: "full_booking_amount",
          };
        });
        expect(
          resolveTargetCancellationPreview(
            cancellationBooking,
            property.timezone,
            input.occurredAt,
          ),
        ).toMatchObject({
          freeCancellationDays: 7,
          refundAmount: 0,
          lines: [
            expect.objectContaining({ freeCancellationDays: 3 }),
            expect.objectContaining({ freeCancellationDays: 7 }),
          ],
        });
        cancellationOffer.roomLines[1]!.offer.rateSummary = { refundable: false };
        expect(() =>
          resolveTargetCancellationPreview(
            cancellationBooking,
            property.timezone,
            input.occurredAt,
          ),
        ).toThrow("non-refundable");

        expect(
          (
            await client.query(
              "SELECT room_count FROM pms.inventory_reservation_receipts WHERE property_id=$1 ORDER BY room_type_id",
              [propertyId],
            )
          ).rows.map((row) => row.room_count),
        ).toEqual([2, 1]);
        expect(
          (
            await client.query("SELECT count(*) FROM booking.guest_bookings WHERE property_id=$1", [
              propertyId,
            ])
          ).rows[0].count,
        ).toBe("1");
        await port.release({
          transaction: client,
          propertyId,
          reservation: bundle,
          occurredAt: input.occurredAt,
        });
        expect(
          await port.selectionAvailabilityCredits!({
            transaction: client,
            propertyId,
            guestBookingId: booking.guestBookingId,
          }),
        ).toEqual(new Map());
        expect(
          (
            await client.query(
              "SELECT available_count FROM pms.inventory_days WHERE property_id=$1 ORDER BY room_type_id,stay_date",
              [propertyId],
            )
          ).rows.map((row) => row.available_count),
        ).toEqual([2, 2, 2, 2]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await inventory()).toEqual([2, 2, 2, 2]);
    expect(
      (
        await pool.query("SELECT status FROM booking.quote_sessions WHERE id=$1", [
          quote.quoteSessionId,
        ])
      ).rows[0].status,
    ).toBe("active");
  });
  it("adopts only the complete bundle and rejects partial or mismatched assignments", async () => {
    const property = {
      propertyId,
      displayName: "Mixed room test",
      defaultLocale: "en",
      timezone: "Europe/Athens",
    };
    const now = new Date(input.occurredAt.getTime() + 5000);
    const request = {
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      roomSelection: selection,
      adults: 5,
      children: 1,
      numberOfRooms: 3,
      paymentMethod: "pay_at_property",
      email: "mixed@example.test",
    };
    const quote = await transaction((client) =>
      createTargetMixedCheckoutQuote(client, property, request, now),
    );
    const context = {
      operation: "create",
      requestId: randomUUID(),
      correlationId: randomUUID(),
      idempotencyKey: randomUUID(),
      fingerprint: randomUUID(),
      occurredAt: now,
    };
    const rollback = new Error("rollback adoption fixture");
    for (const shape of ["partial", "wrong_receipt", "complete"]) {
      const operation = transaction(async (client) => {
        const booking = await createTargetGuestBooking(
          client,
          port,
          property,
          { ...request, expectedTotalAmount: quote.totalAmount },
          context,
          quote,
          null,
          null,
          null,
        );
        const receipts = (
          await client.query(
            `SELECT receipt_id::text,room_type_id::text FROM pms.inventory_reservation_receipts
          WHERE property_id=$1 AND quote_session_id=$2`,
            [propertyId, quote.quoteSessionId],
          )
        ).rows;
        let position = 0;
        for (const [index, line] of selection.lines.entries()) {
          if (shape === "partial" && index === 1) continue;
          const receipt = receipts.find(
            (row) => row.room_type_id === (shape === "wrong_receipt" ? rooms[0] : line.roomTypeId),
          )!;
          for (const guest of line.guests) {
            const physicalRoomId = randomUUID();
            await client.query(
              "INSERT INTO pms.rooms(id,property_id,room_type_id,room_number) VALUES($1::uuid,$2::uuid,$3::uuid,$1::text)",
              [physicalRoomId, propertyId, line.roomTypeId],
            );
            await client.query(
              `INSERT INTO pms.operational_booking_assignments
              (property_id,guest_booking_id,room_type_id,position,assignment_status,source,stay_evidence_kind,
                check_in,check_out,adults,children,assignment_payload,assigned_at,room_id)
              VALUES ($1,$2,$3,$4,'pending','direct_booking','exact',$5,$6,$7,$8,$9::jsonb,$10,$11)`,
              [
                propertyId,
                booking.guestBookingId,
                line.roomTypeId,
                ++position,
                input.checkIn,
                input.checkOut,
                guest.adults,
                guest.children,
                JSON.stringify({
                  inventoryReservation: {
                    contractVersion: "pms-inventory-reservation-lifecycle.v1",
                    owner: "pms",
                    receiptId: receipt.receipt_id,
                  },
                }),
                now,
                physicalRoomId,
              ],
            );
          }
        }
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        expect(
          (
            await client.query(
              "SELECT lifecycle_state FROM pms.inventory_reservation_statuses WHERE property_id=$1 AND receipt_id=ANY($2::uuid[])",
              [propertyId, receipts.map((row) => row.receipt_id)],
            )
          ).rows.map((row) => row.lifecycle_state),
        ).toEqual(["handed_off", "handed_off"]);
        expect(
          (
            await client.query(
              "SELECT available_count FROM pms.inventory_days WHERE property_id=$1 ORDER BY room_type_id,stay_date",
              [propertyId],
            )
          ).rows.map((row) => row.available_count),
        ).toEqual([0, 0, 1, 1]);
        throw rollback;
      });
      if (shape === "complete") await expect(operation).rejects.toBe(rollback);
      else
        await expect(operation).rejects.toMatchObject({
          constraint: "chk_pms_direct_booking_receipt_handoff_scope",
        });
      expect(await inventory()).toEqual([2, 2, 2, 2]);
    }
  });
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
  it("edits mixed to single and back through prepare/save with atomic failure recovery", async () => {
    await pool.query(
      `UPDATE distribution.public_room_offer_snapshots SET rate_summary=rate_summary || '{"rateType":"flexible","refundable":true}'::jsonb WHERE property_id=$1`,
      [propertyId],
    );
    let now = new Date(input.occurredAt.getTime() + 10000);
    const context = () => {
      now = new Date(now.getTime() + 1000);
      const key = randomUUID();
      return {
        operation: "edit",
        requestId: key,
        correlationId: key,
        idempotencyKey: key,
        fingerprint: key,
        occurredAt: now,
      };
    };
    const property = {
      propertyId,
      displayName: "Mixed room test",
      defaultLocale: "en",
      timezone: "Europe/Athens",
    };
    const request = {
      roomTypeId: rooms[0],
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      roomSelection: selection,
      adults: 5,
      children: 1,
      numberOfRooms: 3,
      paymentMethod: "pay_at_property",
      email: "mixed@example.test",
    };
    const original = await transaction(async (client) => {
      const command = context();
      const quote = await createTargetMixedCheckoutQuote(client, property, request, now);
      const booking = await createTargetGuestBooking(
        client,
        port,
        property,
        { ...request, expectedTotalAmount: quote.totalAmount },
        command,
        quote,
        null,
        null,
        null,
      );
      await enqueuePmsReservationHandoff(client, propertyId, booking, command, "create");
      return {
        booking,
        token: (await issueTargetBookingConfirmationToken(client, booking, now)).token,
      };
    });
    const config = {
      connectionString: url!,
      inventoryReservationPort: port,
      now: () => now,
      mixedRoomSelectionsEnabled: true,
    };
    const edit = (action: string, body: Record<string, unknown>, command = context()) =>
      pendingBookingEdit(
        pool,
        config,
        propertyId,
        original.booking.guestBookingId,
        action,
        { ...body, confirmationToken: original.token },
        command,
      ) as Promise<any>;
    const details = await edit("details", {});
    expect(details.input.roomSelection).toEqual(selection);
    const single = {
      ...details.input,
      roomSelection: undefined,
      rateType: "",
      revision: 0,
      roomTypeId: rooms[1],
      adults: 2,
      children: 0,
      numberOfRooms: 1,
    };
    const singleQuote = await edit("quote", single);
    const singleAttempt = await edit("prepare", {
      ...single,
      quoteId: singleQuote.quoteId,
      expectedTotalAmount: singleQuote.totalAmount,
    });
    const first = await edit("save", { revision: 0, attemptId: singleAttempt.attemptId });
    expect(first.booking.bookingReference).toBe(original.booking.publicReference);
    expect(await inventory()).toEqual([2, 2, 1, 1]);
    const nextDetails = await edit("details", {});
    const mixed = { ...nextDetails.input, ...request, revision: 1 };
    config.mixedRoomSelectionsEnabled = false;
    await expect(edit("quote", mixed)).rejects.toThrow(
      "Mixed room booking edits are not available",
    );
    config.mixedRoomSelectionsEnabled = true;
    const mixedQuote = await edit("quote", mixed);
    const mixedAttempt = await edit("prepare", {
      ...mixed,
      quoteId: mixedQuote.quoteId,
      expectedTotalAmount: mixedQuote.totalAmount,
    });
    await pool.query(
      "UPDATE distribution.public_room_offer_snapshots SET base_price_amount=101 WHERE property_id=$1 AND room_type_id=$2",
      [propertyId, rooms[1]],
    );
    await expect(
      edit("save", { revision: 1, attemptId: mixedAttempt.attemptId }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await inventory()).toEqual([2, 2, 1, 1]);
    expect((await edit("details", {})).revision).toBe(1);
    await pool.query(
      "UPDATE distribution.public_room_offer_snapshots SET base_price_amount=100 WHERE property_id=$1 AND room_type_id=$2",
      [propertyId, rooms[1]],
    );
    config.mixedRoomSelectionsEnabled = false;
    await expect(edit("save", { revision: 1, attemptId: mixedAttempt.attemptId })).rejects.toThrow(
      "Mixed room booking edits are not available",
    );
    config.mixedRoomSelectionsEnabled = true;
    const command = context();
    const second = await edit("save", { revision: 1, attemptId: mixedAttempt.attemptId }, command);
    expect(await edit("save", { revision: 1, attemptId: mixedAttempt.attemptId }, command)).toEqual(
      second,
    );
    expect(second.booking.bookingReference).toBe(original.booking.publicReference);
    expect(second.booking.roomSelection).toEqual(selection);
    expect(second.booking.hostResponseDeadline).toBe(first.booking.hostResponseDeadline);
    expect(await inventory()).toEqual([0, 0, 1, 1]);
    const final = await loadTargetBooking(
      pool,
      propertyId,
      original.booking.guestBookingId,
      null,
      sha256Hex(original.token),
    );
    const reservation = (final.bookingMetadata as Record<string, unknown>)[
      "inventoryReservation"
    ] as PmsInventoryReservationBundle;
    await transaction((client) =>
      port.release({ transaction: client, propertyId, reservation, occurredAt: now }),
    );
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
