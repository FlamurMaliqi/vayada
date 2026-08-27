import { createHash } from "node:crypto";

import type { QueryResult, QueryResultRow } from "pg";

export type FinanceManualBookingRefundTransaction = {
  readonly [callerTransaction]: string;
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
};
type RefundClient = Omit<FinanceManualBookingRefundTransaction, typeof callerTransaction>;
const callerTransaction: unique symbol = Symbol("financeManualBookingRefundTransaction");

type PaymentScope = {
  amount: string;
  refundedAmount: string;
  currency: string;
  paymentMethod: string;
  organizationId: string | null;
  status: string;
};
type RefundReplay = {
  guestBookingId: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
  metadata: unknown;
};
type Command = {
  propertyId: string;
  guestBookingId: string;
  paymentEvidenceId: string;
  commandId: string;
  idempotencyKey: string;
  amount: string;
  currency: string;
  accountingDate: string;
  acceptedAt: string;
  reason?: string;
  audit: {
    actor: { kind: string; userId?: string; organizationId?: string };
    requestId: string;
    correlationId?: string;
  };
};

export class FinanceManualBookingRefundError extends Error {}
export type FinanceManualBookingRefundPort = {
  record(input: {
    transaction: FinanceManualBookingRefundTransaction;
    command: Command;
  }): Promise<"partially_refunded" | "refunded">;
};

export function createFinanceManualBookingRefundPort(): FinanceManualBookingRefundPort {
  return { record: recordFinanceManualBookingRefund };
}

export async function financeManualBookingRefundTransaction(
  client: RefundClient,
): Promise<FinanceManualBookingRefundTransaction> {
  const result = await client.query<{ transactionId: string }>(
    `SELECT txid_current()::text AS "transactionId"`,
  );
  return {
    [callerTransaction]: result.rows[0]!.transactionId,
    query: client.query.bind(client),
  };
}

async function recordFinanceManualBookingRefund({
  transaction,
  command,
}: {
  transaction: FinanceManualBookingRefundTransaction;
  command: Command;
}): Promise<"partially_refunded" | "refunded"> {
  const current = await transaction.query<{ transactionId: string }>(
    `SELECT txid_current()::text AS "transactionId"`,
  );
  if (current.rows[0]?.transactionId !== transaction[callerTransaction])
    throw new FinanceManualBookingRefundError("Manual refund requires the caller transaction");
  const hash = createHash("sha256").update(command.idempotencyKey).digest("hex");
  const sourceId = `pms-manual-refund:${command.propertyId}:${hash}`;
  const idempotencyKey = `finance.manual-booking-refund:${command.propertyId}:${hash}:v1`;
  await transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [sourceId]);
  const replay = await transaction.query<RefundReplay>(
    `SELECT guest_booking_id::text AS "guestBookingId",amount::text,trim(currency) AS currency,
       idempotency_key AS "idempotencyKey",payment_metadata AS metadata
     FROM finance.payments WHERE property_id=$1::uuid AND source_system='pms'
       AND source_payment_id=$2 AND payment_kind='refund' FOR UPDATE`,
    [command.propertyId, sourceId],
  );
  const payment = await transaction.query<PaymentScope>(
    `SELECT amount::text,refunded_amount::text AS "refundedAmount",trim(currency) AS currency,
       payment_method AS "paymentMethod",organization_id::text AS "organizationId",status
     FROM finance.payments WHERE id=$1::uuid AND property_id=$2::uuid
       AND guest_booking_id=$3::uuid AND payment_kind='manual'
       AND status IN ('paid','partially_refunded','refunded')
       AND payment_metadata->>'contractVersion'='finance-manual-booking-settlement.v1'
     FOR UPDATE`,
    [command.paymentEvidenceId, command.propertyId, command.guestBookingId],
  );
  const paid = payment.rows[0];
  if (!paid) throw new FinanceManualBookingRefundError("Manual payment evidence is unavailable");
  if (paid.currency !== command.currency)
    throw new FinanceManualBookingRefundError("Manual refund currency does not match the booking");
  if (replay.rows[0]) {
    validateReplay(replay.rows[0], command, idempotencyKey);
    return paid.status === "refunded" ? "refunded" : "partially_refunded";
  }
  if (paid.status === "refunded")
    throw new FinanceManualBookingRefundError("Manual payment evidence is unavailable");
  const nextRefunded = units(paid.refundedAmount) + units(command.amount);
  if (units(command.amount) <= 0n || nextRefunded > units(paid.amount))
    throw new FinanceManualBookingRefundError("Manual refund exceeds the received payment");
  const status = nextRefunded === units(paid.amount) ? "refunded" : "partially_refunded";
  const updated = await transaction.query(
    `UPDATE finance.payments SET refunded_amount=$2::numeric,
       status=$3,updated_at=$4::timestamptz
     WHERE id=$1::uuid AND refunded_amount=$5::numeric`,
    [
      command.paymentEvidenceId,
      decimal(nextRefunded),
      status,
      command.acceptedAt,
      paid.refundedAmount,
    ],
  );
  if (updated.rowCount !== 1)
    throw new FinanceManualBookingRefundError(
      "Manual payment refund evidence changed concurrently",
    );
  await transaction.query(
    `INSERT INTO finance.payments
       (property_id,organization_id,guest_booking_id,source_system,source_payment_id,idempotency_key,
        payment_kind,payment_method,status,amount,net_amount,refunded_amount,currency,payment_metadata,
        visibility_class,paid_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,'pms',$4,$5,'refund',$6,'refunded',$7::numeric,
       -$7::numeric,$7::numeric,$8,$9::jsonb,'pms_finance',$10::timestamptz)`,
    [
      command.propertyId,
      paid.organizationId,
      command.guestBookingId,
      sourceId,
      idempotencyKey,
      paid.paymentMethod,
      command.amount,
      command.currency,
      JSON.stringify({
        contractVersion: "finance-manual-booking-refund.v1",
        correctsPaymentEvidenceId: command.paymentEvidenceId,
        commandId: command.commandId,
        accountingDate: command.accountingDate,
        resultStatus: status,
      }),
      command.acceptedAt,
    ],
  );
  await transaction.query(
    `INSERT INTO platform.product_audit_events
       (audit_key,product,action,occurred_at,tenant_scope,organization_id,property_id,
        actor_type,actor_user_id,target_resource_product,target_resource_type,target_resource_id,
        correlation_id,causation_id,redacted_payload,private_payload,audit_metadata,
        retention_class,privacy_scope)
     VALUES ($1,'finance','finance.manual_booking_refund',$2::timestamptz,'property',NULL,$3::uuid,
       $4,$5::uuid,'finance','payment',$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,
       'financial','confidential')`,
    [
      `finance.manual-refund.property.${command.propertyId}.key.${hash}.audit.v1`,
      command.acceptedAt,
      command.propertyId,
      command.audit.actor.kind,
      command.audit.actor.userId ?? null,
      command.paymentEvidenceId,
      command.audit.correlationId ?? command.audit.requestId,
      command.commandId,
      JSON.stringify({
        amount: command.amount,
        currency: command.currency,
        accountingDate: command.accountingDate,
      }),
      JSON.stringify({ reason: command.reason ?? null }),
      JSON.stringify({
        idempotencyKeyHash: hash,
        requestId: command.audit.requestId,
        actorOrganizationId: command.audit.actor.organizationId ?? null,
      }),
    ],
  );
  return status;
}

function validateReplay(replay: RefundReplay, command: Command, idempotencyKey: string): void {
  const metadata = replay.metadata;
  const status = isRecord(metadata) ? metadata.resultStatus : undefined;
  if (
    replay.guestBookingId !== command.guestBookingId ||
    replay.currency !== command.currency ||
    replay.idempotencyKey !== idempotencyKey ||
    units(replay.amount) !== units(command.amount) ||
    !isRecord(metadata) ||
    Object.keys(metadata).length !== 5 ||
    metadata.contractVersion !== "finance-manual-booking-refund.v1" ||
    metadata.correctsPaymentEvidenceId !== command.paymentEvidenceId ||
    metadata.commandId !== command.commandId ||
    metadata.accountingDate !== command.accountingDate ||
    (status !== "partially_refunded" && status !== "refunded")
  )
    throw new FinanceManualBookingRefundError("Manual refund idempotency key was already used");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function units(value: string): bigint {
  if (!/^(0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value))
    throw new FinanceManualBookingRefundError("Manual refund amount is invalid");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
}

function decimal(value: bigint): string {
  return `${value / 10_000n}.${String(value % 10_000n).padStart(4, "0")}`;
}
