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

async function handedOffStays(
  client: InventoryReservationTransaction,
  propertyId: string,
  receipt: InventoryReservationReceipt,
): Promise<Stay[] | null> {
  const tokens = "receipts" in receipt ? receipt.receipts : "receiptId" in receipt ? [receipt] : [];
  if (!tokens.length) return null;
  const result = await client.query<Stay & { quoteSessionId: string; bookingRoomCount: number }>(
    `SELECT receipt.receipt_id::text AS "receiptId",booking.id::text AS "bookingId",receipt.room_type_id::text AS "roomTypeId",
       receipt.public_offer_key AS "publicOfferKey",receipt.quote_session_id AS "quoteSessionId",booking.room_count AS "bookingRoomCount",
       receipt.check_in::text AS "checkIn",receipt.check_out::text AS "checkOut",receipt.room_count AS "roomCount"
     FROM pms.active_inventory_reservation_receipts receipt
     JOIN pms.inventory_reservation_statuses status USING(receipt_id)
     JOIN booking.guest_bookings booking ON booking.property_id=receipt.property_id
       AND booking.booking_metadata->'inventoryReservation'=$3::jsonb
     WHERE receipt.receipt_id=ANY($1::uuid[]) AND receipt.property_id=$2::uuid AND status.lifecycle_state='handed_off'
       AND receipt.check_in=booking.check_in AND receipt.check_out=booking.check_out
       AND (SELECT count(*) FROM pms.inventory_reservation_receipts complete
         WHERE complete.property_id=receipt.property_id AND complete.quote_session_id=receipt.quote_session_id)=cardinality($1::uuid[])`,
    [tokens.map((token) => token.receiptId), propertyId, JSON.stringify(receipt)],
  );
  if (!result.rows.length) return null;
  const stays = result.rows;
  if (
    stays.length !== tokens.length ||
    new Set(stays.map((stay) => stay.roomTypeId)).size !== stays.length ||
    new Set(stays.map((stay) => stay.bookingId)).size !== 1 ||
    new Set(stays.map((stay) => stay.quoteSessionId)).size !== 1 ||
    stays.reduce((sum, stay) => sum + stay.roomCount, 0) !== stays[0]!.bookingRoomCount
  )
    throw unsupported();
  const assignments = await client.query<{
    roomTypeId: string;
    receiptId: string;
    checkIn: string;
    checkOut: string;
    valid: boolean;
  }>(
    `SELECT room_type_id::text AS "roomTypeId",assignment_payload#>>'{inventoryReservation,receiptId}' AS "receiptId",
       check_in::text AS "checkIn",check_out::text AS "checkOut",
       (source='direct_booking' AND stay_evidence_kind='exact' AND assignment_status IN ('pending','assigned')) AS valid
     FROM pms.operational_booking_assignments WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid FOR UPDATE`,
    [propertyId, stays[0]!.bookingId],
  );
  if (
    assignments.rows.length !== stays[0]!.bookingRoomCount ||
    stays.some(
      (stay) =>
        assignments.rows.filter(
          (assignment) =>
            assignment.valid &&
            assignment.receiptId === stay.receiptId &&
            assignment.roomTypeId === stay.roomTypeId &&
            assignment.checkIn === stay.checkIn &&
            assignment.checkOut === stay.checkOut,
        ).length !== stay.roomCount,
    )
  )
    throw unsupported();
  return stays;
}

export function withPmsHostDateCredit(
  inventory: DirectBookingInventoryReservationPort,
): DirectBookingInventoryReservationPort {
  return {
    ...inventory,
    async bundleAvailabilityCredits(input) {
      const original = await inventory.bundleAvailabilityCredits?.(input);
      if (original) return original;
      const stays = await handedOffStays(input.transaction, input.propertyId, input.reservation);
      if (
        !stays ||
        stays.length !== input.lines.length ||
        new Set(input.lines.map((line) => line.roomTypeId)).size !== stays.length ||
        stays.some(
          (stay) =>
            stay.checkIn !== input.checkIn ||
            stay.checkOut !== input.checkOut ||
            !input.lines.some(
              (line) =>
                line.roomTypeId === stay.roomTypeId &&
                line.publicOfferKey === stay.publicOfferKey &&
                line.roomCount === stay.roomCount,
            ),
        )
      )
        return null;
      return new Map(
        stays.map((stay) => [
          stay.roomTypeId,
          { checkIn: stay.checkIn, checkOut: stay.checkOut, roomCount: stay.roomCount },
        ]),
      );
    },
    async availabilityCredit(input) {
      const original = await inventory.availabilityCredit?.(input);
      if (original) return original;
      const stays = await handedOffStays(input.transaction, input.propertyId, input.reservation);
      const stay = stays?.length === 1 ? stays[0] : null;
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
): Promise<Stay[] | null> {
  const stays = await handedOffStays(client, input.propertyId, input.receipt);
  if (!stays) return null;
  if (stays[0]!.bookingId !== input.bookingId) throw unsupported();
  await client.query(
    `UPDATE pms.operational_booking_assignments SET assignment_status='released',room_id=NULL,assigned_at=NULL,
       assignment_payload=assignment_payload || jsonb_build_object('hostEditPreviewId',$3::text),updated_at=$4::timestamptz
     WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid`,
    [input.propertyId, input.bookingId, input.previewId, input.occurredAt.toISOString()],
  );
  await reconcilePmsOccupiedInventory(
    client,
    input.propertyId,
    stays,
    input.occurredAt.toISOString(),
  );
  await reconcileHostLinkedInventory(client, input, "release");
  for (const stay of stays) await refreshOfferAvailability(client, input.propertyId, stay);
  return stays;
}

export async function completePmsHostDateAmendment(
  client: PoolClient,
  input: {
    propertyId: string;
    bookingId: string;
    previewId: string;
    previous: Stay[] | null;
    receipt: InventoryReservationReceipt;
    checkIn: string;
    checkOut: string;
    occurredAt: Date;
  },
) {
  if (!input.previous) return;
  const tokens =
    "receipts" in input.receipt
      ? input.receipt.receipts
      : "receiptId" in input.receipt
        ? [input.receipt]
        : [];
  const result = await client.query<{ receiptId: string; roomTypeId: string; roomCount: number }>(
    `SELECT receipt.receipt_id::text AS "receiptId",receipt.room_type_id::text AS "roomTypeId",receipt.room_count AS "roomCount"
     FROM pms.inventory_reservation_receipts receipt JOIN pms.inventory_reservation_statuses status USING(receipt_id)
     WHERE receipt.receipt_id=ANY($1::uuid[]) AND receipt.property_id=$2::uuid
       AND receipt.check_in=$3::date AND receipt.check_out=$4::date AND status.lifecycle_state='reserved'`,
    [tokens.map((token) => token.receiptId), input.propertyId, input.checkIn, input.checkOut],
  );
  if (
    result.rows.length !== input.previous.length ||
    tokens.length !== input.previous.length ||
    new Set(result.rows.map((row) => row.roomTypeId)).size !== input.previous.length
  )
    throw unsupported();
  for (const previous of input.previous) {
    const next = result.rows.find(
      (row) => row.roomTypeId === previous.roomTypeId && row.roomCount === previous.roomCount,
    );
    if (!next) throw unsupported();
    await client.query(
      `INSERT INTO pms.inventory_reservation_successors
      (predecessor_receipt_id,successor_receipt_id,organization_id,property_id,guest_booking_id,created_at)
     SELECT receipt_id,$2::uuid,organization_id,property_id,$3::uuid,$4::timestamptz
     FROM pms.inventory_reservation_receipts WHERE receipt_id=$1::uuid`,
      [previous.receiptId, next.receiptId, input.bookingId, input.occurredAt.toISOString()],
    );
    const updated = await client.query(
      `UPDATE pms.operational_booking_assignments SET assignment_status='pending',check_in=$4::date,check_out=$5::date,
       assignment_payload=(assignment_payload-'hostEditPreviewId') || jsonb_build_object('inventoryReservation',$6::jsonb,'version',$3::text,'operationalStatus','pending'),updated_at=$7::timestamptz
     WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND assignment_payload->>'hostEditPreviewId'=$3 AND assignment_payload#>>'{inventoryReservation,receiptId}'=$8`,
      [
        input.propertyId,
        input.bookingId,
        input.previewId,
        input.checkIn,
        input.checkOut,
        JSON.stringify({
          contractVersion: "pms-inventory-reservation-lifecycle.v1",
          owner: "pms",
          receiptId: next.receiptId,
        }),
        input.occurredAt.toISOString(),
        previous.receiptId,
      ],
    );
    if (updated.rowCount !== previous.roomCount) throw unsupported();
  }
  // The existing deferred adoption trigger validates and hands off the new receipt.
  await reconcilePmsOccupiedInventory(
    client,
    input.propertyId,
    input.previous.flatMap((stay) => [
      stay,
      { ...stay, checkIn: input.checkIn, checkOut: input.checkOut },
    ]),
    input.occurredAt.toISOString(),
  );
  await reconcileHostLinkedInventory(client, input, "reserve");
  await enqueueHostInventoryChanges(
    client,
    { ...input, fingerprint: input.previewId },
    input.previous.flatMap((stay) => [
      stay,
      { ...stay, checkIn: input.checkIn, checkOut: input.checkOut },
    ]),
  );
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
