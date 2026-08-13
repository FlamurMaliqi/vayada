import { createHash } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";

import { stripeAmountMinor } from "./stripeMoney.js";

type SettlementExecutor = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

type StripePaymentBookingRow = QueryResultRow & {
  paymentId: string;
  paymentStatus: string;
  propertyId: string;
  guestBookingId: string;
  amount: string;
  currency: string;
  lifecycleStatus: string;
  bookingPaymentStatus: string;
  publicReference: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  roomCount: number;
  totalAmount: string;
  bookingMetadata: unknown;
};

type DirectRevenueBooking = Pick<
  StripePaymentBookingRow,
  "guestBookingId" | "propertyId" | "checkIn" | "checkOut" | "bookingMetadata"
>;

export async function settleStripeBookingPayment(
  client: SettlementExecutor,
  input: {
    paymentIntentId: string;
    amountMinor: number;
    currency?: string | null;
    occurredAt: Date;
    correlationId: string;
    sourceDomainEventId?: string | null;
  },
): Promise<"settled" | "already_settled" | "not_found"> {
  const selected = await client.query<StripePaymentBookingRow>(
    `SELECT
       payment.id::text AS "paymentId",
       payment.status AS "paymentStatus",
       payment.property_id::text AS "propertyId",
       payment.guest_booking_id::text AS "guestBookingId",
       payment.amount::text AS amount,
       payment.currency,
       booking.lifecycle_status AS "lifecycleStatus",
       booking.payment_status AS "bookingPaymentStatus",
       booking.public_reference AS "publicReference",
       booking.check_in::text AS "checkIn",
       booking.check_out::text AS "checkOut",
       booking.adults,
       booking.children,
       booking.room_count AS "roomCount",
       booking.total_amount::text AS "totalAmount",
       booking.booking_metadata AS "bookingMetadata"
     FROM finance.payments payment
     JOIN booking.guest_bookings booking
       ON booking.id = payment.guest_booking_id
      AND booking.property_id = payment.property_id
     WHERE payment.provider_payment_intent_id = $1
       AND payment.payment_method = 'card'
     LIMIT 1
     FOR UPDATE OF payment, booking`,
    [input.paymentIntentId],
  );
  const row = selected.rows[0];
  if (!row) return "not_found";
  if (
    stripeAmountMinor(row.amount, row.currency) !== input.amountMinor ||
    (input.currency && row.currency !== input.currency.toUpperCase())
  ) {
    throw new Error("Stripe PaymentIntent amount or currency did not match the canonical payment.");
  }

  const alreadySettled = row.paymentStatus === "paid" && row.bookingPaymentStatus === "paid";
  if (!alreadySettled) {
    await client.query(
      `UPDATE finance.payments
       SET status = 'paid', paid_at = $2::timestamptz, updated_at = $2::timestamptz,
           payment_metadata = payment_metadata ||
             '{"providerStatus":"succeeded","reconciliationStatus":"matched"}'::jsonb
       WHERE id = $1::uuid`,
      [row.paymentId, input.occurredAt.toISOString()],
    );
    const updated = await client.query(
      `UPDATE booking.guest_bookings
       SET lifecycle_status = 'confirmed', payment_status = 'paid', balance_amount = 0,
           updated_at = $3::timestamptz
       WHERE id = $1::uuid AND property_id = $2::uuid
         AND lifecycle_status IN ('draft', 'pending_payment')
         AND payment_status <> 'paid'
       RETURNING id`,
      [row.guestBookingId, row.propertyId, input.occurredAt.toISOString()],
    );
    if (updated.rows.length === 0)
      throw new Error("Stripe payment cannot confirm the booking in its current state.");
    await client.query(
      `INSERT INTO booking.booking_status_events (
           guest_booking_id, event_type, from_status, to_status, actor_type,
           public_visible, public_message, event_payload, occurred_at
         ) VALUES (
           $1::uuid, 'guest_booking.payment_received', $2, 'confirmed', 'system', TRUE,
           'Card payment received. Booking confirmed.', $3::jsonb, $4::timestamptz
         )`,
      [
        row.guestBookingId,
        row.lifecycleStatus,
        JSON.stringify({ provider: "stripe", paymentIntentId: input.paymentIntentId }),
        input.occurredAt.toISOString(),
      ],
    );
    await client.query(
      `UPDATE booking.direct_booking_summary_read_model
         SET lifecycle_status = 'confirmed', payment_status = 'paid',
             amount_summary = jsonb_set(amount_summary, '{balanceAmount}', '0'::jsonb),
             projected_at = $2::timestamptz
         WHERE guest_booking_id = $1::uuid`,
      [row.guestBookingId, input.occurredAt.toISOString()],
    );
    await captureDirectNightlyRevenueEvidence(client, row, { required: true });
  }

  const handoffKey = pmsCreateHandoffKey(row.propertyId, row.guestBookingId);
  const handoffHash = sha256(handoffKey);
  await client.query(
    `INSERT INTO platform.jobs (
       job_key, queue_name, job_type, source_domain_event_id, tenant_scope,
       property_id, resource_product, resource_type, resource_id, correlation_id,
       idempotency_key_hash, payload, job_metadata
     ) VALUES (
       $1, 'pms-reservation-handoff', 'pms.reservation.create', $2::uuid, 'property',
       $3::uuid, 'booking', 'guest_booking', $4, $5, $6, $7::jsonb, $8::jsonb
     )
     ON CONFLICT (queue_name, job_key) DO NOTHING`,
    [
      pmsCreateJobKey(row.guestBookingId),
      input.sourceDomainEventId ?? null,
      row.propertyId,
      row.guestBookingId,
      input.correlationId,
      handoffHash,
      JSON.stringify({
        operation: "create",
        contractVersion: "pms-reservation.v1",
        commandId: `cmd_pms_create_${handoffHash.slice(0, 24)}`,
        idempotencyKey: handoffKey,
        audit: {
          requestId: input.correlationId,
          correlationId: input.correlationId,
          propertyId: row.propertyId,
          actorType: "guest",
          source: "booking_engine",
          occurredAt: input.occurredAt.toISOString(),
        },
        propertyId: row.propertyId,
        guestBookingId: row.guestBookingId,
        bookingReference: row.publicReference,
        stay: {
          checkInDate: row.checkIn,
          checkOutDate: row.checkOut,
          adults: row.adults,
          children: row.children,
          numberOfRooms: row.roomCount,
        },
        payment: {
          paymentStatus: "paid",
          balanceAmount: { amountDecimal: "0.00", currency: row.currency },
        },
        pricing: {
          grandTotal: { amountDecimal: row.totalAmount, currency: row.currency },
        },
      }),
      JSON.stringify({
        source: "apps/api-stripe-booking-settlement",
        paymentIntentId: input.paymentIntentId,
      }),
    ],
  );
  return alreadySettled ? "already_settled" : "settled";
}

export async function captureDirectNightlyRevenueEvidence(
  client: SettlementExecutor,
  booking: DirectRevenueBooking,
  options: CaptureRevenueOptions = {},
): Promise<void> {
  const metadata = record(booking.bookingMetadata);
  const offer = record(options.selectedOffer ?? metadata["selectedOffer"]);
  const roomTypeId = text(offer["roomTypeId"]);
  const fingerprint = options.fingerprint ?? text(metadata["requestFingerprint"]);
  let nights: Array<{ stayDate: string; grossRoomAmount: string }> = [];
  try {
    if (!options.clear)
      nights = targetNightlyRoomAmounts(
        offer["nightlyRoomAmounts"],
        booking.checkIn,
        booking.checkOut,
      );
  } catch (error) {
    if (options.required) throw error;
    return;
  }
  if (!roomTypeId || !fingerprint) {
    if (options.required) throw new Error("Booked room evidence is unavailable.");
    return;
  }
  await client.query(
    `WITH booking_scope AS (
       SELECT id,property_id,currency,room_count,lifecycle_status FROM booking.guest_bookings
       WHERE id=$1::uuid AND property_id=$2::uuid AND source_system='booking' AND lifecycle_status IN ('confirmed','canceled','no_show') FOR UPDATE
     ), room_scope AS (
       INSERT INTO booking.nightly_revenue_room_scopes (property_id,room_type_id) SELECT property_id,$3::uuid FROM booking_scope ON CONFLICT DO NOTHING
     ), desired AS (
       SELECT (night->>'stayDate')::date stay_date,(night->>'grossRoomAmount')::numeric amount,room.line_position FROM booking_scope scope
       CROSS JOIN LATERAL jsonb_array_elements($4::jsonb) night
       CROSS JOIN LATERAL generate_series(1,scope.room_count) room(line_position)
     ), current_state AS (
       SELECT e.stay_date,e.line_position,SUM(e.gross_room_amount) amount,SUM(e.occupied_room_nights)::int occupied,
         (array_agg(e.id ORDER BY e.source_revision DESC,e.created_at DESC,e.id DESC))[1] target_id
       FROM booking_scope scope JOIN booking.nightly_revenue_evidence e ON e.guest_booking_id=scope.id
       WHERE e.economic_event<>'retained_charge' GROUP BY e.stay_date,e.line_position
     ), revision AS (
       SELECT COALESCE(MAX(e.source_revision),0)+1 value FROM booking_scope scope LEFT JOIN booking.nightly_revenue_evidence e ON e.guest_booking_id=scope.id
     ), changes AS (
       SELECT COALESCE(d.stay_date,c.stay_date) stay_date,COALESCE(d.line_position,c.line_position) line_position,
         d.amount desired_amount,c.amount current_amount,c.occupied,c.target_id
       FROM desired d FULL JOIN current_state c USING (stay_date,line_position)
       WHERE (d.stay_date IS NULL AND c.occupied=1) OR (d.stay_date IS NOT NULL AND c.stay_date IS NULL) OR
         (d.stay_date IS NOT NULL AND c.occupied=0) OR (d.stay_date IS NOT NULL AND c.occupied=1 AND d.amount<>c.amount)
     ) INSERT INTO booking.nightly_revenue_evidence
       (property_id,guest_booking_id,room_type_id,stay_date,recognized_on,currency,gross_room_amount,occupied_room_nights,
        economic_event,lifecycle_state,source_kind,evidence_quality,source_revision,line_position,corrects_evidence_id,command_key)
     SELECT scope.property_id,scope.id,$3::uuid,c.stay_date,
       CASE WHEN c.target_id IS NULL THEN c.stay_date ELSE GREATEST(COALESCE($6::date,c.stay_date),c.stay_date) END,
       scope.currency,CASE WHEN c.target_id IS NULL THEN c.desired_amount WHEN c.desired_amount IS NULL THEN -c.current_amount ELSE c.desired_amount-c.current_amount END,
       CASE WHEN c.target_id IS NULL THEN 1 WHEN c.desired_amount IS NULL THEN -1 WHEN c.occupied=0 THEN 1 ELSE 0 END,
       CASE WHEN c.target_id IS NULL THEN 'room_night' WHEN c.desired_amount IS NULL OR c.occupied=0 THEN 'occupancy_adjustment' ELSE 'correction' END,
       CASE WHEN c.target_id IS NULL THEN 'confirmed' WHEN scope.lifecycle_status IN ('canceled','no_show') THEN scope.lifecycle_status ELSE 'corrected' END,
       'direct','exact',revision.value,c.line_position,c.target_id,
       'direct:'||$5||':'||c.stay_date::text||':'||c.line_position::text
     FROM changes c CROSS JOIN booking_scope scope CROSS JOIN revision`,
    [
      booking.guestBookingId,
      booking.propertyId,
      roomTypeId,
      JSON.stringify(nights),
      sha256(fingerprint),
      options.recognizedOn ?? null,
    ],
  );
}

type CaptureRevenueOptions = {
  clear?: boolean;
  fingerprint?: string;
  recognizedOn?: string;
  required?: boolean;
  selectedOffer?: unknown;
};

export function targetNightlyRoomAmounts(
  value: unknown,
  checkIn: string,
  checkOut: string,
): Array<{ stayDate: string; grossRoomAmount: string }> {
  const expected = dates(checkIn, checkOut);
  if (!Array.isArray(value) || value.length !== expected.length)
    throw new Error("Nightly room price evidence is unavailable.");
  return value.map((entry, index) => {
    const night = record(entry);
    const stayDate = text(night["stayDate"]);
    const amount = night["grossRoomAmount"];
    const grossRoomAmount = typeof amount === "number" ? String(amount) : text(amount);
    if (
      stayDate !== expected[index] ||
      !grossRoomAmount ||
      !/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(grossRoomAmount)
    )
      throw new Error("Nightly room price evidence is unavailable.");
    return { stayDate, grossRoomAmount };
  });
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
function dates(from: string, to: string): string[] {
  const result: string[] = [];
  for (let date = new Date(`${from}T00:00:00Z`); date < new Date(`${to}T00:00:00Z`); ) {
    result.push(date.toISOString().slice(0, 10));
    date = new Date(date.getTime() + 86_400_000);
  }
  return result;
}

export function pmsCreateHandoffKey(propertyId: string, guestBookingId: string): string {
  return `pms.reservation.create:property:${propertyId}:booking:${guestBookingId}:v1`;
}

export function pmsCreateJobKey(guestBookingId: string): string {
  return `booking-checkout:create:${guestBookingId}:v1`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
