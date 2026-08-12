import { createHash } from "node:crypto";

import {
  FinanceManualBookingSettlementError,
  normalizeFinanceManualBookingSettlement,
  type FinanceManualBookingSettlementCommand,
  type FinanceManualBookingSettlementReceipt,
  type NormalizedFinanceManualBookingSettlement,
} from "@vayada/domain-finance";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

declare const callerTransaction: unique symbol;

export type FinanceManualBookingSettlementTransaction = {
  readonly [callerTransaction]: true;
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows">>;
};

export function financeManualBookingSettlementTransaction(
  client: Pick<PoolClient, "query" | "release">,
): FinanceManualBookingSettlementTransaction {
  return client as unknown as FinanceManualBookingSettlementTransaction;
}

export type FinanceManualBookingSettlementPort = {
  settleFull(input: {
    transaction: FinanceManualBookingSettlementTransaction;
    command: FinanceManualBookingSettlementCommand;
  }): Promise<FinanceManualBookingSettlementReceipt>;
};

type PaymentRow = {
  paymentEvidenceId: string;
  requestFingerprint: string;
};

type BookingRow = {
  propertyId: string;
  sourceSystem: string;
  lifecycleStatus: string;
  paymentStatus: string;
  totalAmount: string;
  balanceAmount: string;
  currency: string;
};

export function createFinanceManualBookingSettlementPort(): FinanceManualBookingSettlementPort {
  return {
    async settleFull({ transaction, command }) {
      const normalized = normalizeFinanceManualBookingSettlement(command);
      const fingerprint = requestFingerprint(normalized);
      const idempotencyKey = storedIdempotencyKey(normalized);
      const booking = await lockBooking(transaction, normalized.guestBookingId);
      if (booking.propertyId !== normalized.propertyId) {
        throw new FinanceManualBookingSettlementError("cross_property");
      }

      const bookingPayment = await findBookingPayment(transaction, normalized.guestBookingId);
      if (bookingPayment.length > 0) {
        if (bookingPayment.length === 1 && bookingPayment[0]?.requestFingerprint === fingerprint) {
          return receipt(bookingPayment[0]);
        }
        throw new FinanceManualBookingSettlementError("idempotency_conflict");
      }
      assertBookingCreationState(booking, normalized);
      if (booking.paymentStatus !== "unpaid" || booking.balanceAmount !== booking.totalAmount) {
        throw new FinanceManualBookingSettlementError("non_full_settlement");
      }

      const values = [
        normalized.propertyId,
        normalized.audit.actor.organizationId,
        normalized.guestBookingId,
        normalized.sourceReference,
        idempotencyKey,
        normalized.paymentMethod,
        normalized.amount,
        normalized.currency,
        normalized.acceptedAt,
        paymentMetadata(normalized, fingerprint),
      ] as const;

      const inserted = await transaction.query<PaymentRow>(
        `INSERT INTO finance.payments (
           property_id, organization_id, guest_booking_id,
           source_system, source_payment_id, idempotency_key,
           payment_kind, payment_method, status, amount, fee_amount,
           net_amount, refunded_amount, currency, payment_metadata,
           visibility_class, paid_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid,
           'pms', $4, $5,
           'manual', $6, 'paid', $7::numeric, 0,
           $7::numeric, 0, $8, $10::jsonb,
           'pms_finance', $9::timestamptz
         )
         ON CONFLICT DO NOTHING
         RETURNING id::text AS "paymentEvidenceId",
                   payment_metadata->>'requestFingerprint' AS "requestFingerprint"`,
        values,
      );
      if (inserted.rows[0]) return receipt(inserted.rows[0]);

      const existing = await transaction.query<PaymentRow>(
        `SELECT id::text AS "paymentEvidenceId",
                payment_metadata->>'requestFingerprint' AS "requestFingerprint"
         FROM finance.payments
         WHERE idempotency_key = $1
            OR (source_system = 'pms' AND source_payment_id = $2)
         FOR UPDATE`,
        [idempotencyKey, normalized.sourceReference],
      );
      if (existing.rows.length !== 1 || existing.rows[0]?.requestFingerprint !== fingerprint) {
        throw new FinanceManualBookingSettlementError("idempotency_conflict");
      }
      return receipt(existing.rows[0]);
    },
  };
}

async function lockBooking(
  transaction: FinanceManualBookingSettlementTransaction,
  guestBookingId: string,
): Promise<BookingRow> {
  const result = await transaction.query<BookingRow>(
    `SELECT property_id::text AS "propertyId", source_system AS "sourceSystem",
            lifecycle_status AS "lifecycleStatus",
            payment_status AS "paymentStatus", total_amount::text AS "totalAmount",
            balance_amount::text AS "balanceAmount", trim(currency) AS currency
     FROM booking.guest_bookings WHERE id = $1::uuid FOR UPDATE`,
    [guestBookingId],
  );
  if (!result.rows[0]) throw new FinanceManualBookingSettlementError("invalid_command");
  return result.rows[0];
}

function assertBookingCreationState(
  booking: BookingRow,
  command: NormalizedFinanceManualBookingSettlement,
): void {
  if (booking.currency !== command.currency) {
    throw new FinanceManualBookingSettlementError("cross_currency");
  }
  if (booking.totalAmount !== command.amount) {
    throw new FinanceManualBookingSettlementError("non_full_settlement");
  }
  if (booking.sourceSystem !== "pms" || booking.lifecycleStatus !== "confirmed") {
    throw new FinanceManualBookingSettlementError("invalid_command");
  }
}

async function findBookingPayment(
  transaction: FinanceManualBookingSettlementTransaction,
  guestBookingId: string,
): Promise<PaymentRow[]> {
  const result = await transaction.query<PaymentRow>(
    `SELECT id::text AS "paymentEvidenceId",
            payment_metadata->>'requestFingerprint' AS "requestFingerprint"
     FROM finance.payments
     WHERE guest_booking_id = $1::uuid
       AND payment_kind = 'manual'
       AND payment_metadata->>'contractVersion' = 'finance-manual-booking-settlement.v1'
     FOR UPDATE`,
    [guestBookingId],
  );
  return result.rows;
}

function receipt(row: PaymentRow): FinanceManualBookingSettlementReceipt {
  return { paymentEvidenceId: row.paymentEvidenceId, status: "paid" };
}

function storedIdempotencyKey(command: NormalizedFinanceManualBookingSettlement): string {
  const hash = createHash("sha256").update(command.idempotencyKey).digest("hex");
  return `finance.manual-booking-settlement:${command.propertyId}:${hash}:v1`;
}

function requestFingerprint(command: NormalizedFinanceManualBookingSettlement): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        propertyId: command.propertyId,
        guestBookingId: command.guestBookingId,
        amount: command.amount,
        currency: command.currency,
        paymentMethod: command.paymentMethod,
        sourceReference: command.sourceReference,
        operatorReference: command.operatorReference,
        acceptedAt: command.acceptedAt,
        actor: command.audit.actor,
      }),
    )
    .digest("hex");
}

function paymentMetadata(
  command: NormalizedFinanceManualBookingSettlement,
  fingerprint: string,
): string {
  return JSON.stringify({
    contractVersion: "finance-manual-booking-settlement.v1",
    requestFingerprint: fingerprint,
    commandId: command.commandId,
    operatorReference: command.operatorReference,
    actor: command.audit.actor,
    audit: {
      requestId: command.audit.requestId,
      correlationId: command.audit.correlationId,
      reason: command.audit.reason,
      requestedAt: command.audit.requestedAt,
    },
  });
}
