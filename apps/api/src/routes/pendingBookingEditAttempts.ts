import type pg from "pg";
import { randomUUID } from "node:crypto";
import { stripeAmountMinor, stripeApplicationFeeMinor } from "../domains/stripeMoney.js";
import {
  assertTargetCheckoutConfigMatchesQuote,
  createHttpError,
  loadTargetCheckoutConfig,
  loadTargetCheckoutQuoteSnapshot,
  objectValue,
  type BookingWebCheckoutRequest,
  type TargetBookingRow,
  type TargetCheckoutPropertyRow,
  type BookingWebCheckoutCommandContext,
  type PgTargetBookingWebCheckoutAdapterConfig,
} from "./bookingWebPublic.js";
export type PendingBookingEditAttempt = {
  id: string;
  status: string;
  expected_revision: number;
  request_fingerprint: string;
  request_snapshot: BookingWebCheckoutRequest;
  provider_request: Record<string, unknown>;
  provider_payment_intent_id: string | null;
  payment_method: string;
  expires_at: Date;
  provider_account_id: string | null;
};

export async function preparePendingEditAttempt(
  client: pg.PoolClient,
  config: PgTargetBookingWebCheckoutAdapterConfig,
  property: TargetCheckoutPropertyRow,
  booking: TargetBookingRow & { editRevision: number; deadline: string },
  input: BookingWebCheckoutRequest,
  context: BookingWebCheckoutCommandContext,
  now: Date,
) {
  const quote = await loadTargetCheckoutQuoteSnapshot(client, property.propertyId, input, now);
  if (
    quote.selectedOfferSnapshot["editBookingId"] !== booking.guestBookingId ||
    quote.selectedOfferSnapshot["editRevision"] !== booking.editRevision
  )
    throw createHttpError(409, "Refresh the edit quote before saving.");
  const settings = await loadTargetCheckoutConfig(client, property.propertyId);
  assertTargetCheckoutConfigMatchesQuote(settings, quote);
  const id = randomUUID();
  let providerRequest: Record<string, unknown> = {};
  if (quote.paymentMethod === "card") {
    if (
      !config.stripePaymentProvider ||
      !settings?.providerAccountRef ||
      !settings.providerAccountId
    )
      throw createHttpError(503, "Card authorization is unavailable.");
    const billing = await config
      .billingConfigReadPortFactory?.(client)
      .getBillingConfig(property.propertyId);
    if (!billing) throw createHttpError(503, "Payment configuration is unavailable.");
    const original = (
      await client.query(
        `SELECT billing_plan_snapshot,commission_terms_snapshot
          FROM booking.guest_bookings WHERE id=$1::uuid`,
        [booking.guestBookingId],
      )
    ).rows[0];
    const amountMinor = stripeAmountMinor(String(quote.totalAmount), quote.currency);
    providerRequest = {
      propertyId: property.propertyId,
      bookingReference: booking.publicReference,
      providerAccountRef: settings.providerAccountRef,
      amountMinor,
      currency: quote.currency,
      applicationFeeAmountMinor: stripeApplicationFeeMinor(
        amountMinor,
        original?.billing_plan_snapshot ?? billing.activePlan,
        Number(
          objectValue(original?.commission_terms_snapshot)["bookingEngineFeePercent"] ??
            billing.bookingEngineFeePercent,
        ),
      ),
      captureMethod: "manual",
      idempotencyKey: `booking-edit:${id}`,
    };
  }
  const attempt = (
    await client.query<PendingBookingEditAttempt>(
      `INSERT INTO booking.pending_booking_edit_attempts
        (id,property_id,guest_booking_id,expected_revision,idempotency_key,request_fingerprint,
         request_snapshot,provider_request,quote_session_id,provider_account_id,payment_method,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
        ON CONFLICT(property_id,idempotency_key) DO UPDATE
          SET idempotency_key=EXCLUDED.idempotency_key RETURNING *`,
      [
        id,
        property.propertyId,
        booking.guestBookingId,
        booking.editRevision,
        context.idempotencyKey,
        context.fingerprint,
        JSON.stringify(input),
        JSON.stringify(providerRequest),
        quote.quoteSessionId,
        quote.paymentMethod === "card" ? settings?.providerAccountId : null,
        quote.paymentMethod,
        new Date(Math.min(Date.parse(quote.expiresAt), Date.parse(booking.deadline))),
      ],
    )
  ).rows[0]!;
  if (
    attempt.request_fingerprint !== context.fingerprint ||
    attempt.status !== "prepared" ||
    attempt.expires_at.getTime() <= now.getTime()
  )
    throw createHttpError(409, "Reopen the request editor.");
  return { attempt };
}
export async function authorizePendingEditAttempt(
  pool: pg.Pool,
  config: PgTargetBookingWebCheckoutAdapterConfig,
  attempt: PendingBookingEditAttempt,
) {
  if (attempt.payment_method !== "card") return { attemptId: attempt.id, clientSecret: null };
  // The attempt is durable before contacting Stripe, including ambiguous provider failures.
  const intent = await config.stripePaymentProvider!.createPaymentIntent(
    attempt.provider_request as Parameters<
      NonNullable<typeof config.stripePaymentProvider>["createPaymentIntent"]
    >[0],
  );
  await pool.query(
    `UPDATE booking.pending_booking_edit_attempts SET provider_payment_intent_id=$2,updated_at=now()
    WHERE id=$1 AND status='prepared'`,
    [attempt.id, intent.paymentIntentId],
  );
  return {
    attemptId: attempt.id,
    clientSecret: intent.clientSecret,
    stripeAccountId: attempt.provider_request["providerAccountRef"],
  };
}
