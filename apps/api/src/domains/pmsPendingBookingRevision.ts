import type { InventoryReservationTransaction } from "../platform/inventoryReservation.js";

// Pre-handoff requests are read directly from canonical Booking data by the PMS
// read repository. Operational assignments are deliberately deferred: adopting
// a receipt here would make a second edit unable to release the pending hold.
export async function lockPendingPmsHandoff(
  client: InventoryReservationTransaction,
  propertyId: string,
  bookingId: string,
) {
  const jobs = await client.query<{ status: string; projection: string | null }>(
    `SELECT status,job_metadata->>'applicationMode' AS projection FROM platform.jobs
     WHERE property_id=$1::uuid AND resource_id=$2::text AND queue_name='pms-reservation-handoff'
     ORDER BY id FOR UPDATE`,
    [propertyId, bookingId],
  );
  if (jobs.rows.some((job) => job.projection !== "canonical_pending" && job.status !== "pending"))
    throw Object.assign(new Error("This request's PMS handoff has already started."), {
      statusCode: 409,
    });
}

export async function applyPendingPmsRevision(
  client: InventoryReservationTransaction,
  propertyId: string,
  bookingId: string,
  revision: number,
  now: Date,
) {
  // Caller holds the canonical booking lock and lockPendingPmsHandoff locks.
  // Preserve the initial command identity while refreshing all booking fields.
  await client.query(
    `WITH latest AS (
    SELECT j.payload || jsonb_build_object('specialRequests',g.special_requests,'arrivalTime',g.arrival_time) AS payload
    FROM platform.jobs j JOIN booking.booking_guests g ON g.guest_booking_id=$2::uuid AND g.guest_role='booker'
    WHERE j.property_id=$1::uuid AND j.resource_id=$2::text AND j.job_type='pms.reservation.update'
      AND (j.payload->>'bookingEditRevision')::integer=$3
  ) UPDATE platform.jobs original SET payload=original.payload ||
      (latest.payload - 'operation' - 'commandId' - 'idempotencyKey' - 'audit'),updated_at=$4
    FROM latest WHERE original.property_id=$1::uuid AND original.resource_id=$2::text
      AND original.job_type='pms.reservation.create' AND original.status='pending'`,
    [propertyId, bookingId, revision, now],
  );
  await client.query(
    `UPDATE platform.jobs SET status='succeeded',finished_at=$4,updated_at=$4,
      job_metadata=job_metadata || '{"applicationMode":"canonical_pending"}'::jsonb
    WHERE property_id=$1::uuid AND resource_id=$2::text AND job_type='pms.reservation.update'
      AND (payload->>'bookingEditRevision')::integer=$3 AND status='pending'`,
    [propertyId, bookingId, revision, now],
  );
}
