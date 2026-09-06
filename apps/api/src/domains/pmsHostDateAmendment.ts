import type { PoolClient } from "pg";
import type {
  DirectBookingInventoryReservationPort,
  InventoryReservationReceipt,
  InventoryReservationTransaction,
} from "../platform/inventoryReservation.js";
import { reconcilePmsOccupiedInventory } from "./pmsOccupiedInventory.js";

import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";
import { enqueueHostInventoryChanges } from "./pmsHostInventoryEffects.js";

type Stay = {
  receiptId: string;
  bookingId: string;
  roomTypeId: string;
  publicOfferKey: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
};
const unsupported = () =>
  Object.assign(new Error("The current PMS room assignments cannot be amended together."), {
    statusCode: 409,
    code: "unsupported_edit",
  });

async function handedOffStay(
  client: InventoryReservationTransaction,
  propertyId: string,
  receipt: InventoryReservationReceipt,
): Promise<Stay | null> {
  if (!("receiptId" in receipt)) return null;
  const result = await client.query<Stay>(
    `SELECT receipt.receipt_id::text AS "receiptId",booking.id::text AS "bookingId",receipt.room_type_id::text AS "roomTypeId",receipt.public_offer_key AS "publicOfferKey",
       receipt.check_in::text AS "checkIn",receipt.check_out::text AS "checkOut",receipt.room_count AS "roomCount"
     FROM pms.active_inventory_reservation_receipts receipt
     JOIN pms.inventory_reservation_statuses status USING(receipt_id)
     JOIN booking.guest_bookings booking ON booking.property_id=receipt.property_id
       AND booking.booking_metadata#>>'{inventoryReservation,receiptId}'=receipt.receipt_id::text
     WHERE receipt.receipt_id=$1::uuid AND receipt.property_id=$2::uuid AND status.lifecycle_state='handed_off'`,
    [receipt.receiptId, propertyId],
  );
  const stay = result.rows[0];
  if (!stay) return null;
  const assignments = await client.query<{ valid: boolean }>(
    `SELECT (source='direct_booking' AND stay_evidence_kind='exact' AND assignment_status IN ('pending','assigned')
       AND room_type_id=$3::uuid AND check_in=$4::date AND check_out=$5::date
       AND assignment_payload#>>'{inventoryReservation,receiptId}'=$6) AS valid
     FROM pms.operational_booking_assignments WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid FOR UPDATE`,
    [propertyId, stay.bookingId, stay.roomTypeId, stay.checkIn, stay.checkOut, receipt.receiptId],
  );
  if (
    assignments.rows.length !== stay.roomCount ||
    assignments.rows.some((row) => row.valid !== true)
  )
    throw unsupported();
  return stay;
}

export function withPmsHostDateCredit(
  inventory: DirectBookingInventoryReservationPort,
): DirectBookingInventoryReservationPort {
  return {
    ...inventory,
    async availabilityCredit(input) {
      const original = await inventory.availabilityCredit?.(input);
      if (original) return original;
      const stay = await handedOffStay(input.transaction, input.propertyId, input.reservation);
      if (
        !stay ||
        stay.roomTypeId !== input.roomTypeId ||
        stay.publicOfferKey !== input.publicOfferKey ||
        stay.checkIn !== input.checkIn ||
        stay.checkOut !== input.checkOut ||
        stay.roomCount !== input.roomCount
      )
        return null;
      return { checkIn: stay.checkIn, checkOut: stay.checkOut, roomCount: stay.roomCount };
    },
  };
}

export async function preparePmsHostDateAmendment(
  client: PoolClient,
  input: {
    propertyId: string;
    bookingId: string;
    previewId: string;
    receipt: InventoryReservationReceipt;
    occurredAt: Date;
  },
): Promise<Stay | null> {
  const stay = await handedOffStay(client, input.propertyId, input.receipt);
  if (!stay) return null;
  if (stay.bookingId !== input.bookingId) throw unsupported();
  await client.query(
    `UPDATE pms.operational_booking_assignments SET assignment_status='released',room_id=NULL,assigned_at=NULL,
       assignment_payload=assignment_payload || jsonb_build_object('hostEditPreviewId',$3::text),updated_at=$4::timestamptz
     WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid`,
    [input.propertyId, input.bookingId, input.previewId, input.occurredAt.toISOString()],
  );
  await reconcilePmsOccupiedInventory(
    client,
    input.propertyId,
    [stay],
    input.occurredAt.toISOString(),
  );
  await reconcileHostLinkedInventory(client, input, "release");
  await refreshOfferAvailability(client, input.propertyId, stay);
  return stay;
}

export async function completePmsHostDateAmendment(
  client: PoolClient,
  input: {
    propertyId: string;
    bookingId: string;
    previewId: string;
    previous: Stay | null;
    receipt: InventoryReservationReceipt;
    checkIn: string;
    checkOut: string;
    occurredAt: Date;
  },
) {
  if (!input.previous) return;
  if (!("receiptId" in input.receipt)) throw unsupported();
  await client.query(
    `INSERT INTO pms.inventory_reservation_successors
      (predecessor_receipt_id,successor_receipt_id,organization_id,property_id,guest_booking_id,created_at)
     SELECT receipt_id,$2::uuid,organization_id,property_id,$3::uuid,$4::timestamptz
     FROM pms.inventory_reservation_receipts WHERE receipt_id=$1::uuid`,
    [
      input.previous.receiptId,
      input.receipt.receiptId,
      input.bookingId,
      input.occurredAt.toISOString(),
    ],
  );
  const updated = await client.query(
    `UPDATE pms.operational_booking_assignments SET assignment_status='pending',check_in=$4::date,check_out=$5::date,
       assignment_payload=(assignment_payload-'hostEditPreviewId') || jsonb_build_object('inventoryReservation',$6::jsonb,'version',$3::text,'operationalStatus','pending'),updated_at=$7::timestamptz
     WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND assignment_payload->>'hostEditPreviewId'=$3`,
    [
      input.propertyId,
      input.bookingId,
      input.previewId,
      input.checkIn,
      input.checkOut,
      JSON.stringify(input.receipt),
      input.occurredAt.toISOString(),
    ],
  );
  if (updated.rowCount !== input.previous.roomCount) throw unsupported();
  // The existing deferred adoption trigger validates and hands off the new receipt.
  await reconcilePmsOccupiedInventory(
    client,
    input.propertyId,
    [input.previous, { ...input.previous, checkIn: input.checkIn, checkOut: input.checkOut }],
    input.occurredAt.toISOString(),
  );
  await reconcileHostLinkedInventory(client, input, "reserve");
  await enqueueHostInventoryChanges(client, { ...input, fingerprint: input.previewId }, [
    input.previous,
    { ...input.previous, checkIn: input.checkIn, checkOut: input.checkOut },
  ]);
}

async function reconcileHostLinkedInventory(
  client: PoolClient,
  input: { propertyId: string; previewId: string; occurredAt: Date },
  phase: string,
) {
  const changes = await reconcilePmsLinkedInventory(
    client,
    input.propertyId,
    input.occurredAt.toISOString(),
  );
  await enqueuePmsLinkedInventorySideEffects(
    client,
    {
      propertyId: input.propertyId,
      operation: `host_date_${phase}`,
      commandId: input.previewId,
      keyHash: input.previewId,
      acceptedAt: input.occurredAt.toISOString(),
      audit: { requestId: input.previewId },
    },
    changes,
  );
}

async function refreshOfferAvailability(client: PoolClient, propertyId: string, stay: Stay) {
  await client.query(
    `UPDATE distribution.public_room_offer_snapshots offer SET available_rooms=day.available_count,
       availability_status=CASE WHEN day.available_count=0 THEN 'sold_out' WHEN day.available_count<day.total_count THEN 'limited' ELSE 'available' END,
       sellable_publicly=day.available_count>0,unavailable_reasons=array_remove(offer.unavailable_reasons,'sold_out')
     FROM pms.inventory_days day WHERE day.property_id=$1::uuid AND day.room_type_id=$2::uuid
       AND day.stay_date >= $3::date AND day.stay_date < $4::date
       AND offer.property_id=day.property_id AND offer.room_type_id=day.room_type_id AND offer.stay_date=day.stay_date
       AND offer.availability_status IN ('available','limited','sold_out')`,
    [propertyId, stay.roomTypeId, stay.checkIn, stay.checkOut],
  );
}
