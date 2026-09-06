import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createBookingHostActions, type HostActionScope } from "./bookingHostActions.js";
import { targetBookingHostActionGuards } from "./bookingHostActionGuards.js";
import { captureDirectNightlyRevenueEvidence } from "./stripeBookingSettlement.js";

const url = process.env["TEST_DATABASE_URL"];
describe.skipIf(!url)("host actions PostgreSQL consistency", () => {
  const pool = new pg.Pool({ connectionString: url });
  let scope: HostActionScope;
  let clock = new Date("2026-09-06T10:00:00Z");
  let failRelease = false;
  let failReserve = false;
  let financeVoided = false;
  const actions = createBookingHostActions({
    pool,
    now: () => clock,
    guards: {
      ...targetBookingHostActionGuards,
      payment: async (client, input) =>
        financeVoided ? "authorization_void" : targetBookingHostActionGuards.payment(client, input),
    },
    inventory: {
      reserve: async (input) =>
        failReserve
          ? null
          : {
              contractVersion: "pms.inventory-reservation.v1",
              owner: "pms",
              source: "booking_engine",
              quoteSessionId: input.quoteSessionId,
              propertyId: input.propertyId,
              roomTypeId: input.roomTypeId,
              publicOfferKey: input.publicOfferKey,
              checkIn: input.checkIn,
              checkOut: input.checkOut,
              roomCount: input.roomCount,
            },
      async release({ transaction }) {
        await transaction.query(
          `INSERT INTO booking.booking_notes_public (guest_booking_id,author_type,body) VALUES ($1,'system','inventory-port-test')`,
          [scope.bookingId],
        );
        if (failRelease) throw new Error("inventory owner failed");
      },
    },
  });
  beforeEach(async () => {
    if (!/(^|[_-])test([_-]|$)/i.test(new URL(url!).pathname.slice(1)))
      throw new Error("Unsafe test database");
    failRelease = false;
    failReserve = false;
    financeVoided = false;
    clock = new Date("2026-09-06T10:00:00Z");
    scope = { propertyId: randomUUID(), bookingId: randomUUID(), actorUserId: randomUUID() };
    const roomTypeId = randomUUID();
    await pool.query(`INSERT INTO identity.users (id,email,status) VALUES ($1,$2,'active')`, [
      scope.actorUserId,
      `${scope.actorUserId}@example.test`,
    ]);
    await pool.query(
      `INSERT INTO hotel_catalog.properties (id,public_id,display_name) VALUES ($1,$2,'Host action test')`,
      [scope.propertyId, scope.propertyId],
    );
    const metadata = {
      policySnapshot: {
        type: "free_until_days_before_arrival",
        freeCancellationDeadlineDays: 7,
        afterDeadlinePenalty: "full_booking_amount",
        noShowPenalty: "full_booking_amount",
      },
      paymentMethod: "pay_at_property",
      acceptanceMode: "request",
      selectedOffer: {
        roomTypeId,
        publicOfferKey: "standard",
        publicPolicy: { refundable: true },
        nightlyRoomAmounts: [{ stayDate: "2026-09-12", grossRoomAmount: "100.00" }],
      },
      inventoryReservation: {
        contractVersion: "pms.inventory-reservation.v1",
        owner: "pms",
        source: "booking_engine",
        quoteSessionId: randomUUID(),
        propertyId: scope.propertyId,
        roomTypeId,
        publicOfferKey: "standard",
        checkIn: "2026-09-12",
        checkOut: "2026-09-13",
        roomCount: 1,
      },
    };
    await pool.query(
      `INSERT INTO booking.guest_bookings
      (id,property_id,public_reference,lifecycle_status,check_in,check_out,currency,total_amount,balance_amount,booking_metadata)
      VALUES ($1,$2,$3,'confirmed','2026-09-12','2026-09-13','EUR',100,100,$4::jsonb)`,
      [scope.bookingId, scope.propertyId, scope.bookingId, JSON.stringify(metadata)],
    );
    await pool.query(
      `INSERT INTO booking.booking_guests (guest_booking_id,guest_role,first_name,last_name,email) VALUES ($1,'booker','Guest','Test','guest@example.test')`,
      [scope.bookingId],
    );
    await captureDirectNightlyRevenueEvidence(
      pool,
      {
        guestBookingId: scope.bookingId,
        propertyId: scope.propertyId,
        bookingMetadata: metadata,
        checkIn: "2026-09-12",
        checkOut: "2026-09-13",
      },
      { fingerprint: scope.bookingId, required: true },
    );
  });
  afterAll(() => actions.close());
  const preview = () =>
    actions.preview(scope, {
      action: "cancel",
      reason: "private fraud concern",
      guestMessage: "Paragraph one.\n\nParagraph two.",
    });
  const status = async () =>
    (
      await pool.query(
        `SELECT lifecycle_status AS status FROM booking.guest_bookings WHERE id=$1`,
        [scope.bookingId],
      )
    ).rows[0].status;
  const count = async (table: string, column: string, value: string) =>
    Number(
      (await pool.query(`SELECT count(*) FROM ${table} WHERE ${column}=$1`, [value])).rows[0].count,
    );

  async function datePreview() {
    const roomTypeId = (
      await pool.query(
        `SELECT booking_metadata->'selectedOffer'->>'roomTypeId' AS id FROM booking.guest_bookings WHERE id=$1`,
        [scope.bookingId],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO hotel_catalog.property_public_profile_read_model (property_id,public_id,display_name,canonical_slug,default_locale,supported_locales,profile_status) VALUES ($1,$2,'Test',$2,'en',ARRAY['en'],'complete')`,
      [scope.propertyId, scope.propertyId],
    );
    await pool.query(
      `INSERT INTO distribution.public_hotel_bookability_profiles (property_id,public_id,canonical_slug,canonical_url,booking_base_url,timezone,default_currency,supported_currencies,profile_status,freshness_status,public_setup_completeness) VALUES ($1,$2,$2,'https://example.test','https://example.test','Etc/UTC','EUR',ARRAY['EUR'],'public','fresh','{"status":"ready"}')`,
      [scope.propertyId, scope.propertyId],
    );
    await pool.query(
      `INSERT INTO pms.room_types (id,property_id,name,currency,base_rate_amount) VALUES ($1,$2,'Standard','EUR',120)`,
      [roomTypeId, scope.propertyId],
    );
    await pool.query(
      `INSERT INTO pms.inventory_days (property_id,room_type_id,stay_date,total_count,available_count) VALUES ($1,$2,'2026-09-14',2,2)`,
      [scope.propertyId, roomTypeId],
    );
    await pool.query(
      `INSERT INTO distribution.public_room_offer_snapshots (property_id,room_type_id,stay_date,public_offer_key,available_rooms,base_price_amount,currency,freshness_status,payment_options) VALUES ($1,$2,'2026-09-14','standard',2,120,'EUR','fresh',ARRAY['pay_at_property'])`,
      [scope.propertyId, roomTypeId],
    );
    return actions.preview(scope, {
      action: "edit_dates",
      checkIn: "2026-09-14",
      checkOut: "2026-09-15",
      reason: "Guest called",
    });
  }
  it("applies the previewed dates and price with replacement inventory, revenue evidence, and email", async () => {
    const p = await datePreview();
    expect(p.impact).toMatchObject({
      totalAmount: "100.00",
      newTotalAmount: "120.00",
      inventory: "replace",
    });
    await actions.apply(scope, p.previewId, "edit");
    const evidence = await pool.query(
      `SELECT stay_date::text,sum(occupied_room_nights)::int AS occupied,sum(gross_room_amount)::text AS amount
       FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1 GROUP BY stay_date ORDER BY stay_date`,
      [scope.bookingId],
    );
    expect(evidence.rows).toEqual([
      { stay_date: "2026-09-12", occupied: 0, amount: "0.0000" },
      { stay_date: "2026-09-14", occupied: 1, amount: "120.0000" },
    ]);
    const row = (
      await pool.query(
        `SELECT check_in::text,check_out::text,total_amount::text,booking_metadata FROM booking.guest_bookings WHERE id=$1`,
        [scope.bookingId],
      )
    ).rows[0];
    expect(row).toMatchObject({
      check_in: "2026-09-14",
      check_out: "2026-09-15",
      total_amount: "120.00",
      booking_metadata: { selectedOffer: { publicPolicy: { refundable: true } } },
    });
    expect(
      (
        await pool.query(
          `SELECT job_type FROM platform.jobs WHERE resource_id=$1 ORDER BY job_type`,
          [scope.bookingId],
        )
      ).rows,
    ).toEqual([{ job_type: "email.booking-updated" }, { job_type: "pms.reservation.update" }]);
  });
  it("requires a new preview after repricing and rolls replacement-inventory failure back", async () => {
    const p = await datePreview();
    await pool.query(
      `UPDATE distribution.public_room_offer_snapshots SET base_price_amount=130 WHERE property_id=$1`,
      [scope.propertyId],
    );
    await expect(actions.apply(scope, p.previewId, "price")).rejects.toMatchObject({
      code: "stale_preview",
    });
    await pool.query(
      `UPDATE distribution.public_room_offer_snapshots SET base_price_amount=120 WHERE property_id=$1`,
      [scope.propertyId],
    );
    failReserve = true;
    await expect(actions.apply(scope, p.previewId, "sold-out")).rejects.toMatchObject({
      code: "inventory_unavailable",
    });
    expect(await count("booking.booking_notes_public", "guest_booking_id", scope.bookingId)).toBe(
      0,
    );
    expect(
      (
        await pool.query(`SELECT check_in::text FROM booking.guest_bookings WHERE id=$1`, [
          scope.bookingId,
        ])
      ).rows[0].check_in,
    ).toBe("2026-09-12");
  });

  it("commits cancellation, evidence, private audit, and jobs once and replays after expiry", async () => {
    const p = await preview();
    const results = await Promise.all([
      actions.apply(scope, p.previewId, "cancel"),
      actions.apply(scope, p.previewId, "cancel"),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await status()).toBe("canceled");
    expect(await count("booking.booking_status_events", "guest_booking_id", scope.bookingId)).toBe(
      1,
    );
    expect(await count("booking.booking_notes_public", "guest_booking_id", scope.bookingId)).toBe(
      1,
    );
    const jobs = (
      await pool.query(`SELECT job_type,payload FROM platform.jobs WHERE resource_id=$1`, [
        scope.bookingId,
      ])
    ).rows;
    expect(jobs.map((j) => j.job_type).sort()).toEqual([
      "email.booking-canceled",
      "pms.reservation.cancel",
    ]);
    expect(JSON.stringify(jobs)).not.toContain("private fraud concern");
    expect(jobs.find((j) => j.job_type === "email.booking-canceled").payload.text).toContain(
      "Paragraph one.\n\nParagraph two.",
    );
    const audit = (
      await pool.query(
        `SELECT actor_user_id,private_payload FROM platform.product_audit_events WHERE action='checkout.booking.host-action' AND target_resource_id=$1`,
        [scope.bookingId],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      actor_user_id: scope.actorUserId,
      private_payload: { reason: "private fraud concern" },
    });
    expect(
      Number(
        (
          await pool.query(
            `SELECT sum(occupied_room_nights) AS nights FROM booking.nightly_revenue_evidence WHERE guest_booking_id=$1`,
            [scope.bookingId],
          )
        ).rows[0].nights,
      ),
    ).toBe(0);
    clock = new Date("2026-09-07T10:00:00Z");
    expect(await actions.apply(scope, p.previewId, "cancel")).toEqual(results[0]);
  });
  it("rolls inventory and command reservation back on failure, then permits retry", async () => {
    const p = await preview();
    failRelease = true;
    await expect(actions.apply(scope, p.previewId, "retry")).rejects.toThrow(
      "inventory owner failed",
    );
    expect(await status()).toBe("confirmed");
    expect(await count("booking.booking_notes_public", "guest_booking_id", scope.bookingId)).toBe(
      0,
    );
    expect(await count("platform.jobs", "resource_id", scope.bookingId)).toBe(0);
    failRelease = false;
    await expect(actions.apply(scope, p.previewId, "retry")).resolves.toMatchObject({
      lifecycleStatus: "canceled",
    });
  });
  it("rejects changed booking state, expired previews, and another actor without writes", async () => {
    const p = await preview();
    await expect(
      actions.apply({ ...scope, actorUserId: randomUUID() }, p.previewId, "other"),
    ).rejects.toMatchObject({ code: "stale_preview" });
    clock = new Date("2026-09-06T10:10:00Z");
    await expect(actions.apply(scope, p.previewId, "expired")).rejects.toMatchObject({
      code: "stale_preview",
    });
    clock = new Date("2026-09-06T10:00:00Z");
    await pool.query(`UPDATE booking.guest_bookings SET total_amount=120 WHERE id=$1`, [
      scope.bookingId,
    ]);
    await expect(actions.apply(scope, p.previewId, "changed")).rejects.toMatchObject({
      code: "stale_preview",
    });
    expect(await status()).toBe("confirmed");
    expect(await count("platform.jobs", "resource_id", scope.bookingId)).toBe(0);
  });
  it("does not apply a second preview or reuse a key for a different preview", async () => {
    const a = await preview(),
      b = await preview();
    await actions.apply(scope, a.previewId, "same-key");
    await expect(actions.apply(scope, b.previewId, "same-key")).rejects.toThrow(
      "different request",
    );
    await expect(actions.apply(scope, b.previewId, "another-key")).rejects.toMatchObject({
      code: "invalid_lifecycle",
    });
    expect(await count("booking.booking_status_events", "guest_booking_id", scope.bookingId)).toBe(
      1,
    );
  });
  it("projects an authorized rejection after the Finance port confirms a void", async () => {
    financeVoided = true;
    await pool.query(
      `UPDATE booking.guest_bookings SET lifecycle_status='pending_payment',payment_status='authorized',booking_metadata=jsonb_set(booking_metadata,'{paymentMethod}','"card"') WHERE id=$1`,
      [scope.bookingId],
    );
    await pool.query(
      `INSERT INTO booking.direct_booking_summary_read_model (guest_booking_id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out) SELECT id,property_id,public_reference,lifecycle_status,payment_status,check_in,check_out FROM booking.guest_bookings WHERE id=$1`,
      [scope.bookingId],
    );
    const p = await actions.preview(scope, { action: "reject", reason: "Unavailable" });
    await actions.apply(scope, p.previewId, "reject-authorized");
    expect(
      (
        await pool.query(
          `SELECT lifecycle_status,payment_status FROM booking.direct_booking_summary_read_model WHERE guest_booking_id=$1`,
          [scope.bookingId],
        )
      ).rows[0],
    ).toEqual({ lifecycle_status: "declined", payment_status: "failed" });
  });
  it("declines a pending request and persists its rejection notification", async () => {
    await pool.query(
      `UPDATE booking.guest_bookings SET lifecycle_status='pending_payment' WHERE id=$1`,
      [scope.bookingId],
    );
    const p = await actions.preview(scope, { action: "reject", reason: "internal" });
    await actions.apply(scope, p.previewId, "reject");
    expect(await status()).toBe("declined");
    expect(
      (
        await pool.query(
          `SELECT job_type FROM platform.jobs WHERE resource_id=$1 AND queue_name='platform.email'`,
          [scope.bookingId],
        )
      ).rows,
    ).toEqual([{ job_type: "email.booking-rejected" }]);
  });
});
