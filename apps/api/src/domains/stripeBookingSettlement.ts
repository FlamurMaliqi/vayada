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
};

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
       booking.total_amount::text AS "totalAmount"
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
    if (updated.rows.length > 0) {
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
    }
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

export function pmsCreateHandoffKey(propertyId: string, guestBookingId: string): string {
  return `pms.reservation.create:property:${propertyId}:booking:${guestBookingId}:v1`;
}

export function pmsCreateJobKey(guestBookingId: string): string {
  return `booking-checkout:create:${guestBookingId}:v1`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
