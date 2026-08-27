import type { FinanceCommandAudit, FinanceRoutePaymentMethod } from "@vayada/domain-finance";
import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";

export type FinanceManualPaymentSettlementClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
};

export type FinanceManualPaymentSettlementResult =
  | {
      ok: true;
      status: "created" | "idempotent_replay";
      paymentId: string;
      feeAmount: string;
      netAmount: string;
    }
  | {
      ok: false;
      code: "invalid_command" | "invoice_not_found";
      message: string;
    };

export type FinanceBookingManualPaymentSettlementCommand = {
  commandId: string;
  idempotencyKey: string;
  propertyId: string;
  audit: FinanceCommandAudit;
  payload: {
    invoiceId: string;
    amount: string;
    currency: string;
    paymentMethod: FinanceRoutePaymentMethod;
    reference?: string;
  };
};

type BookingSettlementRow = {
  guestBookingId: string;
  currency: string;
  balanceDue: string;
  lifecycleStatus: string;
  paymentStatus: string;
  billingPlanSnapshot: string | null;
  commissionTermsSnapshot: unknown;
};

type PaymentWriteRow = {
  paymentId: string;
  replay: boolean;
};

export async function recordBookingManualPaymentInClient(
  client: FinanceManualPaymentSettlementClient,
  command: FinanceBookingManualPaymentSettlementCommand,
): Promise<FinanceManualPaymentSettlementResult> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('finance-manual-payment:' || $1 || ':' || $2, 0)
     )`,
    [command.propertyId, command.payload.invoiceId],
  );

  const booking = await loadBookingSettlement(client, command);
  if (!booking) {
    return {
      ok: false,
      code: "invoice_not_found",
      message: "Finance booking settlement was not found.",
    };
  }

  const validationError = validateSettlement(command, booking);
  if (validationError) return validationError;

  const amountCents = decimalCents(command.payload.amount)!;
  const feeCents = commissionFeeCents(amountCents, booking);
  if (feeCents === null) {
    return {
      ok: false,
      code: "invalid_command",
      message: "Booking commission terms are unavailable.",
    };
  }
  const feeAmount = decimalFromCents(feeCents);
  const netAmount = decimalFromCents(amountCents - feeCents);
  const keyHash = createHash("sha256").update(command.idempotencyKey).digest("hex");
  const scopedIdempotencyKey = `finance.manual-payment.payment.property.${command.propertyId}.key.${keyHash}.v1`;

  const result = await client.query<PaymentWriteRow>(
    `WITH inserted AS (
       INSERT INTO finance.payments (
         property_id,
         organization_id,
         guest_booking_id,
         source_system,
         idempotency_key,
         payment_kind,
         payment_method,
         status,
         amount,
         fee_amount,
         net_amount,
         refunded_amount,
         currency,
         payment_metadata,
         visibility_class,
         paid_at,
         created_at,
         updated_at
       )
       VALUES (
         $1::uuid,
         $2::uuid,
         $3::uuid,
         'finance',
         $4,
         'manual',
         $5,
         'paid',
         $6::numeric,
         $7::numeric,
         $8::numeric,
         0,
         $9,
         $10::jsonb,
         'pms_finance',
         $11::timestamptz,
         $11::timestamptz,
         $11::timestamptz
       )
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id::text AS "paymentId", false AS replay
     )
     SELECT "paymentId", replay FROM inserted
     UNION ALL
     SELECT id::text AS "paymentId", true AS replay
     FROM finance.payments
     WHERE property_id = $1::uuid
       AND idempotency_key = $4
     LIMIT 1`,
    [
      command.propertyId,
      command.audit.actor.kind === "user" ? command.audit.actor.organizationId : null,
      booking.guestBookingId,
      scopedIdempotencyKey,
      command.payload.paymentMethod,
      command.payload.amount,
      feeAmount,
      netAmount,
      command.payload.currency,
      JSON.stringify({
        invoiceId: command.payload.invoiceId,
        reference: command.payload.reference ?? null,
        commandId: command.commandId,
        reconciliationStatus: "matched",
        providerStatus: "paid",
        billingPlan: booking.billingPlanSnapshot,
        commissionTerms: jsonObject(booking.commissionTermsSnapshot),
      }),
      command.audit.requestedAt,
    ],
  );
  const payment = result.rows[0];
  if (!payment) {
    throw new Error("Finance payment insert did not return a canonical payment row.");
  }

  return {
    ok: true,
    status: payment.replay ? "idempotent_replay" : "created",
    paymentId: payment.paymentId,
    feeAmount,
    netAmount,
  };
}

async function loadBookingSettlement(
  client: FinanceManualPaymentSettlementClient,
  command: FinanceBookingManualPaymentSettlementCommand,
): Promise<BookingSettlementRow | null> {
  const result = await client.query<BookingSettlementRow>(
    `SELECT
       booking.id::text AS "guestBookingId",
       booking.currency,
       GREATEST(
         booking.balance_amount - COALESCE(payment_totals.amount_paid, 0),
         0
       )::text AS "balanceDue",
       booking.lifecycle_status AS "lifecycleStatus",
       booking.payment_status AS "paymentStatus",
       booking.billing_plan_snapshot AS "billingPlanSnapshot",
       booking.commission_terms_snapshot AS "commissionTermsSnapshot"
     FROM booking.guest_bookings booking
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(payment.amount - payment.refunded_amount), 0) AS amount_paid
       FROM finance.payments payment
       WHERE payment.property_id = booking.property_id
         AND payment.guest_booking_id = booking.id
         AND payment.status IN ('authorized', 'pending', 'paid', 'partially_refunded')
         AND payment.visibility_class IN ('pms_finance', 'migration')
     ) payment_totals ON TRUE
     WHERE booking.property_id = $1::uuid
       AND COALESCE(booking.booking_metadata ->> 'invoiceId', booking.id::text) = $2
     LIMIT 1
     FOR UPDATE OF booking`,
    [command.propertyId, command.payload.invoiceId],
  );
  return result.rows[0] ?? null;
}

function validateSettlement(
  command: FinanceBookingManualPaymentSettlementCommand,
  booking: BookingSettlementRow,
): Extract<FinanceManualPaymentSettlementResult, { ok: false }> | null {
  if (booking.paymentStatus === "paid") {
    return invalidCommand("Paid bookings cannot accept manual payments.");
  }
  if (["declined", "canceled", "expired"].includes(booking.lifecycleStatus)) {
    return invalidCommand("Canceled bookings cannot accept manual payments.");
  }
  if (command.payload.currency !== booking.currency.toUpperCase()) {
    return invalidCommand("Manual payment currency must match the booking currency.");
  }

  const amountCents = decimalCents(command.payload.amount);
  const balanceCents = decimalCents(booking.balanceDue, true);
  if (amountCents === null)
    return invalidCommand("Manual payment amount is outside the supported range.");
  if (balanceCents === null) return invalidCommand("Finance booking balance is unavailable.");
  if (balanceCents <= 0n) return invalidCommand("Finance booking has no outstanding balance.");
  if (amountCents > balanceCents) {
    return invalidCommand("Manual payment amount exceeds the booking balance.");
  }
  return null;
}

function commissionFeeCents(amountCents: bigint, booking: BookingSettlementRow): bigint | null {
  if (booking.billingPlanSnapshot === "fixed") return 0n;
  const percentUnits = decimalPercentUnits(
    jsonObject(booking.commissionTermsSnapshot)["bookingEngineFeePercent"],
  );
  if (percentUnits === null) return null;
  return (amountCents * percentUnits + 500_000n) / 1_000_000n;
}

function decimalCents(value: string, allowZero = false): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const integerDigits = (match[1] ?? "").replace(/^0+/, "") || "0";
  if (integerDigits.length > 13) return null;
  const cents = BigInt(integerDigits) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  if ((!allowZero && cents <= 0n) || cents > 999_999_999_999_999n) return null;
  return cents;
}

function decimalPercentUnits(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(\d{1,3})(?:\.(\d{1,4}))?$/.exec(String(value).trim());
  if (!match) return null;
  const units = BigInt(match[1] ?? "0") * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0"));
  return units <= 1_000_000n ? units : null;
}

function decimalFromCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function invalidCommand(
  message: string,
): Extract<FinanceManualPaymentSettlementResult, { ok: false }> {
  return { ok: false, code: "invalid_command", message };
}
