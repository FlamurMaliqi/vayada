import type { QueryResult, QueryResultRow } from "pg";

import { lockPmsInventoryMutationScope } from "./pmsInventoryMutationLock.js";

export type PmsOccupiedInventorySpan = Readonly<{
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
}>;

export type PmsOccupiedInventoryClient = {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<Row>, "rows" | "rowCount">>;
};

type InventoryDay = {
  roomTypeId: string;
  stayDate: string;
  totalCount: unknown;
  blockedCount: unknown;
  assignedCount: unknown;
  effectiveSellableLimitCount: unknown;
  status: string;
  expectedAssignedCount: unknown;
  linkedStopSell: boolean;
};

export class PmsOccupiedInventoryInvariantError extends Error {}

export async function reconcilePmsOccupiedInventory(
  client: PmsOccupiedInventoryClient,
  propertyId: string,
  spans: readonly PmsOccupiedInventorySpan[],
  acceptedAt: string,
): Promise<void> {
  const targetDays = occupiedDays(spans);
  if (targetDays.length === 0) return;
  await lockPmsInventoryMutationScope(client, propertyId);
  const result = await client.query<InventoryDay>(
    `WITH target_days AS (
       SELECT DISTINCT item."roomTypeId"::uuid AS room_type_id,item."stayDate"::date AS stay_date
       FROM jsonb_to_recordset($2::jsonb) item("roomTypeId" text,"stayDate" text)
     )
     SELECT day.room_type_id::text AS "roomTypeId",day.stay_date::text AS "stayDate",
       day.total_count AS "totalCount",day.blocked_count AS "blockedCount",
       day.assigned_count AS "assignedCount",day.status,
       day.linked_stop_sell AS "linkedStopSell",
       day.effective_sellable_limit_count AS "effectiveSellableLimitCount",
       (
         COALESCE((
           SELECT SUM(GREATEST(0,receipt.room_count-COALESCE((
             SELECT COUNT(DISTINCT adopted.id)::int
             FROM booking.guest_bookings booking
             JOIN pms.operational_booking_assignments adopted
               ON adopted.guest_booking_id=booking.id AND adopted.property_id=booking.property_id
               AND adopted.source='direct_booking'
               AND (reservation_status.lifecycle_state='handed_off'
                 OR adopted.room_type_id=receipt.room_type_id)
               AND COALESCE(adopted.check_in,booking.check_in)=receipt.check_in AND COALESCE(adopted.check_out,booking.check_out)=receipt.check_out
             WHERE booking.property_id=receipt.property_id
               AND (CASE WHEN booking.booking_metadata#>>'{inventoryReservation,contractVersion}'='pms-inventory-reservation-bundle.v1'
                 THEN booking.booking_metadata#>'{inventoryReservation,receipts}' @>
                   jsonb_build_array(jsonb_build_object('receiptId',receipt.receipt_id::text))
                   AND adopted.assignment_payload#>>'{inventoryReservation,receiptId}'=receipt.receipt_id::text
                 ELSE booking.booking_metadata#>>'{inventoryReservation,receiptId}'=receipt.receipt_id::text
                   OR booking.quote_session_id::text=receipt.quote_session_id
                   OR booking.booking_metadata#>>'{inventoryReservation,quoteSessionId}'=receipt.quote_session_id END)
           ),0)))::int
           FROM pms.active_inventory_reservation_receipts receipt
           JOIN pms.inventory_reservation_statuses reservation_status
             ON reservation_status.receipt_id=receipt.receipt_id AND reservation_status.organization_id=receipt.organization_id
            AND reservation_status.property_id=receipt.property_id
           WHERE receipt.property_id=day.property_id
             AND receipt.room_type_id=day.room_type_id
             AND receipt.check_in<=day.stay_date AND receipt.check_out>day.stay_date
             AND reservation_status.lifecycle_state IN ('reserved','handed_off')
         ),0)+COALESCE((
           SELECT SUM(GREATEST(0,booking.room_count-COALESCE((
             SELECT COUNT(DISTINCT adopted.id)::int
             FROM pms.operational_booking_assignments adopted
             WHERE adopted.property_id=booking.property_id
               AND adopted.guest_booking_id=booking.id AND adopted.source='direct_booking'
               AND COALESCE(adopted.check_in,booking.check_in)=booking.check_in
               AND COALESCE(adopted.check_out,booking.check_out)=booking.check_out
           ),0)))::int
           FROM booking.guest_bookings booking
           WHERE booking.property_id=day.property_id
             AND booking.source_system='booking'
             AND booking.lifecycle_status IN ('draft','pending_payment','confirmed')
             AND booking.booking_metadata#>>'{inventoryReservation,contractVersion}'=
               'pms.inventory-reservation.v1'
             AND booking.booking_metadata#>>'{inventoryReservation,owner}'='pms'
             AND booking.booking_metadata#>>'{inventoryReservation,source}'='booking_engine'
             AND booking.booking_metadata#>>'{inventoryReservation,propertyId}'=day.property_id::text
             AND booking.booking_metadata#>>'{inventoryReservation,roomTypeId}'=day.room_type_id::text
             AND booking.check_in<=day.stay_date AND booking.check_out>day.stay_date
             AND NOT EXISTS (
               SELECT 1 FROM pms.inventory_reservation_receipts receipt
               WHERE receipt.property_id=booking.property_id AND receipt.quote_session_id=
                 booking.booking_metadata#>>'{inventoryReservation,quoteSessionId}'
             )
         ),0)+COALESCE((
           SELECT COUNT(DISTINCT assignment.id)::int
           FROM pms.operational_booking_assignments assignment
           JOIN booking.guest_bookings booking
             ON booking.id=assignment.guest_booking_id
            AND booking.property_id=assignment.property_id
           WHERE assignment.property_id=day.property_id
             AND assignment.room_type_id=day.room_type_id
             AND assignment.assignment_status NOT IN ('canceled','released')
             AND booking.lifecycle_status IN ('confirmed','completed')
             AND COALESCE(assignment.check_in,booking.check_in)<=day.stay_date
             AND COALESCE(assignment.check_out,booking.check_out)>day.stay_date
             AND (assignment.source<>'direct_booking' OR EXISTS (
               SELECT 1 FROM pms.inventory_reservation_receipts receipt WHERE receipt.property_id=booking.property_id
                 AND (booking.booking_metadata#>>'{inventoryReservation,receiptId}'=
                   receipt.receipt_id::text OR booking.quote_session_id::text=receipt.quote_session_id
                   OR booking.booking_metadata#>>'{inventoryReservation,quoteSessionId}'=receipt.quote_session_id)
             ) OR (
               COALESCE(assignment.check_in,booking.check_in)=booking.check_in
               AND COALESCE(assignment.check_out,booking.check_out)=booking.check_out
             ))
         ),0)
       )::int AS "expectedAssignedCount"
     FROM pms.inventory_days day JOIN target_days target
       ON target.room_type_id=day.room_type_id AND target.stay_date=day.stay_date
     WHERE day.property_id=$1::uuid AND day.calendar_revision IS NOT NULL
     ORDER BY day.room_type_id,day.stay_date FOR UPDATE OF day`,
    [propertyId, JSON.stringify(targetDays)],
  );
  if (result.rows.length !== targetDays.length) {
    throw new PmsOccupiedInventoryInvariantError("Canonical inventory coverage is incomplete");
  }
  for (const day of result.rows) {
    const total = integer(day.totalCount);
    const blocked = integer(day.blockedCount);
    const assigned = integer(day.assignedCount);
    const expected = integer(day.expectedAssignedCount);
    const effective = integer(day.effectiveSellableLimitCount);
    if (
      [total, blocked, assigned, expected, effective].some((value) => value === null) ||
      expected! + blocked! > total!
    ) {
      throw new PmsOccupiedInventoryInvariantError(
        "Occupied inventory exceeds physical room capacity",
      );
    }
    if (assigned === expected) continue;
    const available =
      day.status === "closed" || day.linkedStopSell
        ? 0
        : Math.max(0, effective! - expected! - blocked!);
    const updated = await client.query(
      `UPDATE pms.inventory_days SET assigned_count=$4,available_count=$5,
         inventory_revision=inventory_revision+1,
         booking_source_revision=booking_source_revision+1,updated_at=$6::timestamptz
       WHERE property_id=$1::uuid AND room_type_id=$2::uuid AND stay_date=$3::date`,
      [propertyId, day.roomTypeId, day.stayDate, expected, available, acceptedAt],
    );
    if (updated.rowCount !== 1) {
      throw new PmsOccupiedInventoryInvariantError("Canonical inventory changed under lock");
    }
  }
}

function occupiedDays(spans: readonly PmsOccupiedInventorySpan[]) {
  const days = new Map<string, { roomTypeId: string; stayDate: string }>();
  for (const span of spans) {
    const cursor = new Date(`${span.checkIn}T00:00:00.000Z`);
    const end = new Date(`${span.checkOut}T00:00:00.000Z`);
    if (!Number.isFinite(cursor.valueOf()) || !Number.isFinite(end.valueOf()) || cursor >= end) {
      throw new PmsOccupiedInventoryInvariantError("Occupied inventory span is invalid");
    }
    for (; cursor < end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const stayDate = cursor.toISOString().slice(0, 10);
      days.set(`${span.roomTypeId}:${stayDate}`, { roomTypeId: span.roomTypeId, stayDate });
    }
  }
  return [...days.values()];
}

function integer(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
