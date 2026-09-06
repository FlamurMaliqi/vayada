import type { PoolClient } from "pg";
import type { StripeBookingPaymentProvider } from "./stripeBookingPayments.js";
import { stripeAmountMinor } from "./stripeMoney.js";

export type HostPaymentDisposition = "no_payment_received" | "authorization_void";
export type FinanceHostBookingPayments = (
  client: PoolClient,
  input: {
    propertyId: string;
    bookingId: string;
    authorized?: boolean;
    action: string;
    apply: boolean;
    occurredAt: Date;
  },
) => Promise<HostPaymentDisposition>;
const conflict = () =>
  Object.assign(new Error("Payment reconciliation is required before this action."), {
    statusCode: 409,
    code: "payment_adjustment_required",
  });

export function createFinanceHostBookingPayments(
  provider?: StripeBookingPaymentProvider,
): FinanceHostBookingPayments {
  return async (client, input) => {
    const result = await client.query<{
      id: string;
      status: string;
      method: string;
      intentId: string | null;
      accountRef: string | null;
      chargeType: string | null;
      amount: string;
      currency: string;
      reference: string;
      activePaymentId: string | null;
      superseded: boolean;
    }>(
      `SELECT payment.id::text,payment.status,payment.payment_method AS method,
         payment.provider_payment_intent_id AS "intentId",account.provider_account_id AS "accountRef",
         payment.payment_metadata->>'chargeType' AS "chargeType",payment.amount::text,trim(payment.currency) AS currency,
         booking.public_reference AS reference,booking.active_card_payment_id::text AS "activePaymentId",
         payment.payment_metadata->>'supersededByEdit'='true' AS superseded
       FROM finance.payments payment
       JOIN booking.guest_bookings booking ON booking.id=payment.guest_booking_id AND booking.property_id=payment.property_id
       LEFT JOIN finance.payment_provider_accounts account ON account.id=payment.provider_account_id AND account.property_id=payment.property_id
       WHERE payment.property_id=$1::uuid AND payment.guest_booking_id=$2::uuid
         AND payment.status NOT IN ('failed','canceled') FOR UPDATE OF payment`,
      [input.propertyId, input.bookingId],
    );
    // Pending edits own durable release of explicitly superseded authorizations.
    // Keep unexpected active or captured financial evidence visible and fail closed.
    const payments = result.rows.filter(
      (payment) =>
        !(
          payment.method === "card" &&
          payment.superseded &&
          payment.activePaymentId !== payment.id &&
          ["pending", "authorized"].includes(payment.status)
        ),
    );
    if (!payments.length) {
      if (input.authorized) throw conflict();
      return "no_payment_received";
    }
    const payment = payments[0]!;
    if (
      payments.length !== 1 ||
      input.action !== "reject" ||
      payment.status !== "authorized" ||
      payment.method !== "card" ||
      !payment.intentId ||
      !payment.accountRef ||
      !provider
    )
      throw conflict();
    if (!input.apply) return "authorization_void";
    const account = payment.chargeType === "direct" ? payment.accountRef : null;
    const assertBinding = (intent: Awaited<ReturnType<typeof provider.retrievePaymentIntent>>) => {
      if (
        intent.paymentIntentId !== payment.intentId ||
        intent.propertyId !== input.propertyId ||
        intent.bookingReference !== payment.reference ||
        intent.providerAccountRef !== payment.accountRef ||
        intent.amountMinor !== stripeAmountMinor(payment.amount, payment.currency) ||
        intent.currency !== payment.currency
      )
        throw conflict();
    };
    let intent = await provider.retrievePaymentIntent(payment.intentId, account);
    assertBinding(intent);
    if (intent.status === "requires_capture") {
      try {
        intent = await provider.cancelPaymentIntent(
          payment.intentId,
          account,
          `booking-host-reject:${input.propertyId}:${input.bookingId}:${payment.id}:v1`,
        );
      } catch {
        intent = await provider.retrievePaymentIntent(payment.intentId, account);
      }
      assertBinding(intent);
    }
    if (intent.status !== "canceled") throw conflict();
    await client.query(
      `UPDATE finance.payments SET status='canceled',updated_at=$2::timestamptz,
         payment_metadata=payment_metadata || '{"providerStatus":"canceled","reconciliationStatus":"canceled"}'::jsonb
       WHERE id=$1::uuid AND status='authorized'`,
      [payment.id, input.occurredAt.toISOString()],
    );
    return "authorization_void";
  };
}
