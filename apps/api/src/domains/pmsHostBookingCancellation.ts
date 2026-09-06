import type { PoolClient } from "pg";
import { enqueueHostInventoryChanges } from "./pmsHostInventoryEffects.js";
import { reconcilePmsOccupiedInventory } from "./pmsOccupiedInventory.js";
import { reconcilePmsLinkedInventory } from "./pmsLinkedInventoryReconciler.js";
import { enqueuePmsLinkedInventorySideEffects } from "./pmsLinkedInventorySideEffects.js";

/** Booking has locked the property inventory scope and made its terminal transition. */
export async function cancelHostBookingAssignments(
  client: PoolClient,
  input: {
    propertyId: string;
    bookingId: string;
    previewId: string;
    fingerprint: string;
    occurredAt: Date;
  },
) {
  const spans = await client.query<{ roomTypeId: string; checkIn: string; checkOut: string }>(
    `SELECT assignment.room_type_id::text AS "roomTypeId",
       COALESCE(assignment.check_in,booking.check_in)::text AS "checkIn",
       COALESCE(assignment.check_out,booking.check_out)::text AS "checkOut"
     FROM pms.operational_booking_assignments assignment
     JOIN booking.guest_bookings booking ON booking.id=assignment.guest_booking_id AND booking.property_id=assignment.property_id
     WHERE assignment.property_id=$1::uuid AND assignment.guest_booking_id=$2::uuid
       AND assignment.assignment_status IN ('pending','assigned') FOR UPDATE OF assignment`,
    [input.propertyId, input.bookingId],
  );
  if (!spans.rows.length) return;
  await client.query(
    `UPDATE pms.operational_booking_assignments SET assignment_status='canceled',room_id=NULL,assigned_at=NULL,
       assignment_payload=assignment_payload || jsonb_build_object('version',$3::text,'operationalStatus','canceled'),updated_at=$4::timestamptz
     WHERE property_id=$1::uuid AND guest_booking_id=$2::uuid AND assignment_status IN ('pending','assigned')`,
    [input.propertyId, input.bookingId, input.previewId, input.occurredAt.toISOString()],
  );
  await reconcilePmsOccupiedInventory(
    client,
    input.propertyId,
    spans.rows,
    input.occurredAt.toISOString(),
  );
  const linked = await reconcilePmsLinkedInventory(
    client,
    input.propertyId,
    input.occurredAt.toISOString(),
  );
  await enqueuePmsLinkedInventorySideEffects(
    client,
    {
      propertyId: input.propertyId,
      operation: "host_cancellation",
      commandId: input.previewId,
      keyHash: input.fingerprint,
      acceptedAt: input.occurredAt.toISOString(),
      audit: { requestId: input.previewId },
    },
    linked,
  );
  await enqueueHostInventoryChanges(client, input, spans.rows);
}
