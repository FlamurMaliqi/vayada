import { getTimezone } from "countries-and-timezones";

import {
  appendExternalNightlyRevenueEvidence,
  type ExternalRevenueEvidenceClient,
} from "./bookingExternalNightlyRevenueEvidence.js";
import {
  FinanceManualBookingRefundError,
  type FinanceManualBookingRefundPort,
  type FinanceManualBookingRefundTransaction,
} from "./financeManualBookingRefund.js";

type RefundAllocation = {
  evidenceId: string;
  amount: { amountDecimal: string; currency: string };
};
type BookingScope = {
  sourceBookingReference: string;
  currency: string;
  timezone: string | null;
  paymentStatus: string;
};
type RevenueTarget = {
  id: string;
  roomTypeId: string;
  stayDate: string;
  recognizedOn: string;
  availableAmount: string;
  linePosition: number;
};

export class ManualRefundEvidenceError extends Error {}
export class ManualRefundStateError extends Error {
  constructor(
    message: string,
    readonly currentStatus: string,
  ) {
    super(message);
  }
}

export async function refundPmsManualBooking(
  transaction: ExternalRevenueEvidenceClient,
  command: {
    propertyId: string;
    guestBookingId: string;
    idempotencyKey: string;
    paymentEvidenceId: string;
    accountingDate: string;
    allocations: readonly RefundAllocation[];
    commandId: string;
    reason?: string;
    audit: {
      actor: { kind: string; userId?: string; organizationId?: string };
      requestId: string;
      correlationId?: string;
    };
  },
  acceptedAt: string,
  finance: FinanceManualBookingRefundPort,
  financeTransaction: FinanceManualBookingRefundTransaction,
): Promise<void> {
  const booking = await transaction.query<BookingScope>(
    `SELECT source_booking_id AS "sourceBookingReference",trim(currency) AS currency,
       payment_status AS "paymentStatus",
       (SELECT timezone FROM hotel_catalog.property_locations
        WHERE property_id=booking.property_id) AS timezone
     FROM booking.guest_bookings booking WHERE id=$1::uuid AND property_id=$2::uuid
       AND source_system='pms' AND booking_metadata->>'contractVersion'='pms-manual-booking.v1'
     FOR UPDATE`,
    [command.guestBookingId, command.propertyId],
  );
  const scope = booking.rows[0];
  if (!scope || scope.paymentStatus !== "paid")
    throw new ManualRefundStateError(
      "Manual booking cannot be refunded",
      scope?.paymentStatus ?? "missing",
    );
  const zone = scope.timezone && getTimezone(scope.timezone);
  if (!zone || zone.name !== scope.timezone || zone.aliasOf !== null)
    throw new ManualRefundEvidenceError("Manual refund requires a canonical property timezone");
  if (command.accountingDate < propertyDate(acceptedAt, scope.timezone!))
    throw new ManualRefundEvidenceError("Manual refund accounting date is invalid");

  const ids = command.allocations.map(({ evidenceId }) => evidenceId);
  const targets = await transaction.query<RevenueTarget>(
    `WITH tips AS (
       SELECT id,SUM(gross_room_amount) OVER (PARTITION BY stay_date,line_position) AS available,
         row_number() OVER (PARTITION BY stay_date,line_position
           ORDER BY source_revision DESC,created_at DESC,id DESC) AS position
       FROM booking.nightly_revenue_evidence WHERE property_id=$2::uuid
         AND guest_booking_id=$3::uuid AND currency=$4
     ) SELECT target.id::text,target.room_type_id::text AS "roomTypeId",
       target.stay_date::text AS "stayDate",target.recognized_on::text AS "recognizedOn",
       tip.available::text AS "availableAmount",target.line_position AS "linePosition"
     FROM booking.nightly_revenue_evidence target JOIN tips tip ON tip.id=target.id AND tip.position=1
     WHERE target.id=ANY($1::uuid[]) AND target.property_id=$2::uuid
       AND target.guest_booking_id=$3::uuid AND target.currency=$4
       AND target.source_kind='manual' AND target.evidence_quality='exact'
       AND tip.available>0`,
    [ids, command.propertyId, command.guestBookingId, scope.currency],
  );
  if (targets.rows.length !== command.allocations.length)
    throw new ManualRefundEvidenceError("Manual refund allocation is missing or ambiguous");
  const byId = new Map(targets.rows.map((target) => [target.id, target]));
  let total = 0n;
  const lines = command.allocations.map((allocation) => {
    const target = byId.get(allocation.evidenceId);
    const amount = units(allocation.amount.amountDecimal, true);
    if (
      !target ||
      allocation.amount.currency !== scope.currency ||
      command.accountingDate < target.recognizedOn ||
      amount <= 0n ||
      amount > units(target.availableAmount)
    )
      throw new ManualRefundEvidenceError(
        "Manual refund allocation does not match revenue evidence",
      );
    total += amount;
    return {
      roomTypeId: target.roomTypeId,
      stayDate: target.stayDate,
      recognizedOn: command.accountingDate,
      grossRoomAmount: `-${decimal(amount)}`,
      occupiedRoomNights: 0 as const,
      economicEvent: "refund" as const,
      lifecycleState: "refunded" as const,
      evidenceQuality: "exact" as const,
      linePosition: target.linePosition,
      correctsEvidenceId: target.id,
    };
  });
  let paymentStatus: "partially_refunded" | "refunded";
  try {
    paymentStatus = await finance.record({
      transaction: financeTransaction,
      command: {
        ...command,
        amount: decimal(total),
        currency: scope.currency,
        acceptedAt,
      },
    });
  } catch (error) {
    if (error instanceof FinanceManualBookingRefundError)
      throw new ManualRefundEvidenceError(error.message);
    throw error;
  }
  await transaction.query(
    `UPDATE booking.guest_bookings SET payment_status=CASE WHEN $3='refunded'
       THEN 'refunded' ELSE 'paid' END,updated_at=$4::timestamptz
     WHERE id=$1::uuid AND property_id=$2::uuid`,
    [command.guestBookingId, command.propertyId, paymentStatus, acceptedAt],
  );
  await appendExternalNightlyRevenueEvidence(transaction, {
    propertyId: command.propertyId,
    guestBookingId: command.guestBookingId,
    sourceKind: "manual",
    sourceBookingReference: scope.sourceBookingReference,
    idempotencyKey: `pms-refund:${command.idempotencyKey}:v1`,
    lines,
  });
}

function units(value: string, input = false): bigint {
  if (
    !/^(0|[1-9]\d{0,14})(?:\.\d{1,4})?$/.test(value) ||
    (input && !/^(0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(value))
  )
    throw new ManualRefundEvidenceError("Manual refund amount is invalid");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, "0"));
}

function decimal(value: bigint): string {
  return `${value / 10_000n}.${String(value % 10_000n).padStart(4, "0")}`;
}

function propertyDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value["year"]}-${value["month"]}-${value["day"]}`;
}
