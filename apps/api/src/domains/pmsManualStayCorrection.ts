import {
  correctBookingPmsManualStays,
  type VerifiedManualStayCorrection,
} from "./bookingPmsManualStayCorrection.js";
import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import type { PmsOperationsCommandClient } from "./pmsOperationsCommandRepository.js";
import type { PmsManualStayCorrectionCommand } from "../routes/pmsOperations.js";

type Assignment = {
  assignmentId: string;
  position: number;
  roomTypeId: string;
  ratePlanId: string | null;
  assignmentStatus: string;
  source: string;
  stayEvidenceKind: string;
};
type Room = { roomId: string; roomTypeId: string };

export class ManualStayCorrectionAvailabilityError extends Error {}
export class ManualStayCorrectionScopeError extends Error {}

export async function correctPmsManualStays(
  transaction: PmsOperationsCommandClient,
  command: PmsManualStayCorrectionCommand,
  acceptedAt: string,
  nextVersion: string,
): Promise<void> {
  const assignments = await transaction.query<Assignment>(
    `SELECT id::text AS "assignmentId",position,room_type_id::text AS "roomTypeId",
       rate_plan_id::text AS "ratePlanId",assignment_status AS "assignmentStatus",source,
       stay_evidence_kind AS "stayEvidenceKind"
     FROM pms.operational_booking_assignments WHERE property_id=$1::uuid
       AND guest_booking_id=$2::uuid ORDER BY position,id FOR UPDATE`,
    [command.propertyId, command.guestBookingId],
  );
  const byPosition = new Map(assignments.rows.map((row) => [row.position, row]));
  if (
    assignments.rows.length !== command.stays.length ||
    assignments.rows.some(
      ({ source, stayEvidenceKind, assignmentStatus }) =>
        source !== "manual" ||
        stayEvidenceKind !== "exact" ||
        !["pending", "assigned"].includes(assignmentStatus),
    ) ||
    command.stays.some(
      ({ assignmentId, position }) => byPosition.get(position)?.assignmentId !== assignmentId,
    )
  )
    throw new ManualStayCorrectionScopeError("Manual stay correction scope is unavailable");

  const rooms = await verifiedRooms(transaction, command);
  const roomById = new Map(rooms.map((room) => [room.roomId, room]));
  const verified: VerifiedManualStayCorrection[] = command.stays.map((stay) => ({
    ...stay,
    roomTypeId: roomById.get(stay.roomId)!.roomTypeId,
  }));
  if (
    hasRequestedRoomOverlap(verified) ||
    !(await staysAreAvailable(transaction, command, verified))
  )
    throw new ManualStayCorrectionAvailabilityError(
      "A selected room is unavailable for the corrected stay",
    );

  const updates = verified.map((stay) => {
    const previous = byPosition.get(stay.position)!;
    return {
      ...stay,
      ratePlanId: previous.roomTypeId === stay.roomTypeId ? previous.ratePlanId : null,
    };
  });
  const updated = await transaction.query(
    `UPDATE pms.operational_booking_assignments assignment SET
       room_type_id=item."roomTypeId"::uuid,room_id=item."roomId"::uuid,
       rate_plan_id=item."ratePlanId"::uuid,check_in=item."checkIn"::date,
       check_out=item."checkOut"::date,
       assignment_payload=jsonb_set(COALESCE(assignment_payload,'{}'),'{version}',
         to_jsonb($4::text),true),updated_at=$5::timestamptz
     FROM jsonb_to_recordset($3::jsonb) item(
       "assignmentId" text,"roomTypeId" text,"roomId" text,"ratePlanId" text,
       "checkIn" text,"checkOut" text)
     WHERE assignment.id=item."assignmentId"::uuid AND assignment.property_id=$1::uuid
       AND assignment.guest_booking_id=$2::uuid`,
    [command.propertyId, command.guestBookingId, JSON.stringify(updates), nextVersion, acceptedAt],
  );
  if (updated.rowCount !== verified.length)
    throw new ManualStayCorrectionScopeError("Manual stay correction assignments changed");
  await correctBookingPmsManualStays(transaction, command, verified, acceptedAt);
}

async function verifiedRooms(
  transaction: PmsOperationsCommandClient,
  command: PmsManualStayCorrectionCommand,
): Promise<Room[]> {
  const roomIds = [...new Set(command.stays.map(({ roomId }) => roomId))].sort();
  const preliminary = await transaction.query<Room>(
    `SELECT id::text AS "roomId",room_type_id::text AS "roomTypeId" FROM pms.rooms
     WHERE property_id=$1::uuid AND id=ANY($2::uuid[])`,
    [command.propertyId, roomIds],
  );
  if (preliminary.rows.length !== roomIds.length)
    throw new ManualStayCorrectionScopeError("A corrected room was not found");
  const roomTypeIds = [...new Set(preliminary.rows.map(({ roomTypeId }) => roomTypeId))].sort();
  for (const roomTypeId of roomTypeIds)
    await lockPmsPhysicalRoomUnitMutationScope(transaction, command.propertyId, roomTypeId);
  await transaction.query(
    `SELECT id FROM pms.rooms WHERE property_id=$1::uuid
       AND room_type_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
    [command.propertyId, roomTypeIds],
  );
  const verified = await transaction.query<Room>(
    `SELECT id::text AS "roomId",room_type_id::text AS "roomTypeId" FROM pms.rooms
     WHERE property_id=$1::uuid AND id=ANY($2::uuid[]) AND status='available'
       AND operational_label_status='verified' AND room_number IS NOT NULL ORDER BY id`,
    [command.propertyId, roomIds],
  );
  if (
    verified.rows.length !== roomIds.length ||
    verified.rows.some(({ roomTypeId }) => !roomTypeIds.includes(roomTypeId))
  )
    throw new ManualStayCorrectionScopeError("A corrected room is not operationally available");
  return verified.rows;
}

async function staysAreAvailable(
  transaction: PmsOperationsCommandClient,
  command: PmsManualStayCorrectionCommand,
  stays: readonly VerifiedManualStayCorrection[],
): Promise<boolean> {
  const unavailable = await transaction.query(
    `WITH requested AS (
       SELECT * FROM jsonb_to_recordset($3::jsonb) item(
         "roomId" uuid,"roomTypeId" uuid,"checkIn" date,"checkOut" date)
     ), requested_dates AS (
       SELECT requested.*,day::date AS stay_date FROM requested
       CROSS JOIN LATERAL generate_series("checkIn","checkOut"-1,interval '1 day') day
     ), demand AS (
       SELECT "roomTypeId",stay_date,count(*)::int requested FROM requested_dates
       GROUP BY "roomTypeId",stay_date
     ), current_booking AS (
       SELECT demand."roomTypeId",demand.stay_date,count(assignment.id)::int credit
       FROM demand LEFT JOIN pms.operational_booking_assignments assignment
         ON assignment.property_id=$1::uuid AND assignment.guest_booking_id=$2::uuid
        AND assignment.room_type_id=demand."roomTypeId"
        AND assignment.assignment_status NOT IN ('canceled','released')
        AND assignment.check_in<=demand.stay_date AND assignment.check_out>demand.stay_date
       GROUP BY demand."roomTypeId",demand.stay_date
     )
     SELECT 1 FROM requested WHERE EXISTS (
       SELECT 1 FROM pms.operational_booking_assignments assignment
       JOIN booking.guest_bookings booking ON booking.id=assignment.guest_booking_id
        AND booking.property_id=assignment.property_id
       WHERE assignment.property_id=$1::uuid AND assignment.guest_booking_id<>$2::uuid
        AND assignment.room_id=requested."roomId"
        AND assignment.assignment_status NOT IN ('canceled','released')
        AND COALESCE(assignment.check_in,booking.check_in)<requested."checkOut"
        AND COALESCE(assignment.check_out,booking.check_out)>requested."checkIn") OR EXISTS (
       SELECT 1 FROM pms.room_blocks block WHERE block.property_id=$1::uuid
        AND block.room_id=requested."roomId" AND block.status='active'
        AND block.starts_on<requested."checkOut" AND block.ends_on>=requested."checkIn")
     UNION ALL SELECT 1 FROM demand LEFT JOIN current_booking USING("roomTypeId",stay_date)
       LEFT JOIN pms.inventory_days inventory ON inventory.property_id=$1::uuid
        AND inventory.room_type_id=demand."roomTypeId" AND inventory.stay_date=demand.stay_date
       WHERE inventory.status='closed' OR inventory.effective_sellable_limit_count IS NULL
        OR inventory.available_count+COALESCE(current_booking.credit,0)<demand.requested
        OR inventory.property_id IS NULL LIMIT 1`,
    [command.propertyId, command.guestBookingId, JSON.stringify(stays)],
  );
  return unavailable.rowCount === 0;
}

function hasRequestedRoomOverlap(stays: readonly VerifiedManualStayCorrection[]): boolean {
  return stays.some((stay, index) =>
    stays
      .slice(index + 1)
      .some(
        (other) =>
          stay.roomId === other.roomId &&
          stay.checkIn < other.checkOut &&
          stay.checkOut > other.checkIn,
      ),
  );
}
