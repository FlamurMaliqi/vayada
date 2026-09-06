import type pg from "pg";
import type { StripeBookingPaymentIntent } from "../domains/stripeBookingPayments.js";
import { stripeAmountMinor, stripeAmountDecimal } from "../domains/stripeMoney.js";
import type { PendingBookingEditAttempt as Attempt } from "./pendingBookingEditAttempts.js";
import {
  createHttpError,
  type TargetCheckoutPropertyRow,
  type TargetBookingRow,
  type TargetCheckoutQuoteSnapshot,
  type PgTargetBookingWebCheckoutAdapterConfig,
} from "./bookingWebPublic.js";
export async function verifyPendingEditPayment(
  client: pg.PoolClient,
  config: PgTargetBookingWebCheckoutAdapterConfig,
  property: TargetCheckoutPropertyRow,
  booking: TargetBookingRow,
  attempt: Attempt,
  quote: TargetCheckoutQuoteSnapshot,
) {
  let authorizedIntent:
    | Awaited<ReturnType<NonNullable<typeof config.stripePaymentProvider>["retrievePaymentIntent"]>>
    | undefined;
  if (attempt.payment_method === "card") {
    if (!config.stripePaymentProvider || !attempt.provider_payment_intent_id)
      throw createHttpError(409, "Authorize the replacement card before saving.");
    authorizedIntent = await config.stripePaymentProvider.retrievePaymentIntent(
      attempt.provider_payment_intent_id,
      String(attempt.provider_request["providerAccountRef"]),
    );
    if (
      authorizedIntent.status !== "requires_capture" ||
      authorizedIntent.propertyId !== property.propertyId ||
      authorizedIntent.bookingReference !== booking.publicReference ||
      authorizedIntent.amountMinor !==
        stripeAmountMinor(String(quote.totalAmount), quote.currency) ||
      authorizedIntent.currency !== quote.currency ||
      authorizedIntent.providerAccountRef !== attempt.provider_request["providerAccountRef"]
    )
      throw createHttpError(409, "The replacement card authorization is not ready.");
  }
  const oldCard = (
    await client.query<{ intent: string; account: string }>(
      `SELECT p.provider_payment_intent_id AS intent,
      a.provider_account_id AS account FROM finance.payments p JOIN finance.payment_provider_accounts a ON a.id=p.provider_account_id
      WHERE p.guest_booking_id=$1::uuid AND p.payment_method='card' AND p.status IN ('authorized','requires_action')`,
      [booking.guestBookingId],
    )
  ).rows;
  for (const card of oldCard) {
    if (!config.stripePaymentProvider)
      throw createHttpError(503, "Card payment verification is unavailable.");
    const old = await config.stripePaymentProvider.retrievePaymentIntent(card.intent, card.account);
    if (
      ![
        "requires_capture",
        "requires_payment_method",
        "requires_confirmation",
        "requires_action",
        "canceled",
      ].includes(old.status)
    )
      throw createHttpError(409, "This request's payment is already processing.");
  }
  return authorizedIntent;
}
export async function commitPendingEditPayment(
  client: pg.PoolClient,
  property: TargetCheckoutPropertyRow,
  booking: TargetBookingRow,
  attempt: Attempt,
  quote: TargetCheckoutQuoteSnapshot,
  authorizedIntent: StripeBookingPaymentIntent | undefined,
  now: Date,
) {
  await client.query(
    `INSERT INTO booking.edit_authorization_releases
      (provider_payment_intent_id,provider_account_ref,property_id)
      SELECT p.provider_payment_intent_id,a.provider_account_id,p.property_id FROM finance.payments p
      JOIN finance.payment_provider_accounts a ON a.id=p.provider_account_id
      WHERE p.guest_booking_id=$1::uuid AND p.payment_method='card' AND p.status IN ('requires_action','authorized')
        AND p.provider_payment_intent_id IS NOT NULL ON CONFLICT DO NOTHING`,
    [booking.guestBookingId],
  );
  await client.query(
    `UPDATE finance.payments SET status='canceled',updated_at=$2,
      payment_metadata=payment_metadata || '{"supersededByEdit":true}'::jsonb
      WHERE guest_booking_id=$1::uuid AND payment_method='card' AND status IN ('requires_action','authorized')`,
    [booking.guestBookingId, now],
  );
  let paymentId: string | null = null;
  if (authorizedIntent) {
    paymentId = (
      await client.query<{ id: string }>(
        `INSERT INTO finance.payments
        (property_id,guest_booking_id,provider_account_id,idempotency_key,payment_kind,payment_method,status,
         amount,currency,provider_payment_intent_id,payment_metadata,authorized_at,fee_amount,net_amount)
        VALUES ($1,$2,$3,$4,'full','card','authorized',$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING id`,
        [
          property.propertyId,
          booking.guestBookingId,
          attempt.provider_account_id,
          `booking-edit:${attempt.id}`,
          quote.totalAmount,
          quote.currency,
          authorizedIntent.paymentIntentId,
          JSON.stringify({
            chargeType: "direct",
            captureMethod: "manual",
            acceptanceMode: "request",
            applicationFeeAmount: stripeAmountDecimal(
              Number(attempt.provider_request["applicationFeeAmountMinor"]),
              quote.currency,
            ),
            applicationFeeCurrency: quote.currency,
            reconciliationStatus: "authorized",
          }),
          now,
          stripeAmountDecimal(
            Number(attempt.provider_request["applicationFeeAmountMinor"]),
            quote.currency,
          ),
          stripeAmountDecimal(
            authorizedIntent.amountMinor -
              Number(attempt.provider_request["applicationFeeAmountMinor"]),
            quote.currency,
          ),
        ],
      )
    ).rows[0]!.id;
  }
  return paymentId;
}
