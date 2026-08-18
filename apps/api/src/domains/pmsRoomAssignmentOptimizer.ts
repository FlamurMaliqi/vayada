import {
  optimizePmsRoomAssignments,
  type PmsRoomAssignmentOptimizationMove,
  type PmsRoomAssignmentOptimizationOccupancy,
  type PmsRoomAssignmentOptimizationResult,
  type PmsRoomAssignmentOptimizationRoom,
} from "@vayada/domain-pms";
import type { QueryResult, QueryResultRow } from "pg";

import { lockPmsPhysicalRoomUnitMutationScope } from "./pmsPhysicalRoomUnitMutationLock.js";
import {
  completePmsRoomAssignmentOptimizationCommand,
  releasePmsRoomAssignmentOptimizationCommand,
  startPmsRoomAssignmentOptimizationCommand,
  type PmsRoomAssignmentOptimizationCommandIdentity,
  type PmsRoomAssignmentOptimizationCommandReservation,
  type PmsRoomAssignmentOptimizationStoredResult,
} from "./pmsRoomAssignmentOptimizationCommandStore.js";
import { appendPmsRoomAssignmentOptimizationEvidence } from "./pmsRoomAssignmentOptimizationEvidence.js";

export type PmsRoomAssignmentOptimizationReason = "create" | "cancel" | "modify";
export type PmsRoomAssignmentOptimizationCommand = PmsRoomAssignmentOptimizationCommandIdentity & {
  causationId?: string;
  actor: { kind: "system" } | { kind: "user"; userId: string };
};
export type PmsRoomAssignmentOptimizationCommandResult =
  | PmsRoomAssignmentOptimizationResult
  | { outcome: "disabled" | "single_room" | "invalid_snapshot" }
  | { outcome: "idempotency_conflict" | "command_in_progress" };

export type PmsRoomAssignmentOptimizationClient = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Pick<QueryResult<T>, "rows" | "rowCount">>;
};

type RoomRow = QueryResultRow & {
  roomId: string;
  sortOrder: number;
  status: string;
  operationalLabelStatus: string;
  roomNumber: string | null;
};
type AssignmentRow = QueryResultRow & {
  assignmentId: string;
  guestBookingId: string;
  roomId: string | null;
  assignmentStatus: string;
  stayEvidenceKind: string;
  checkIn: string | null;
  checkOut: string | null;
  lifecycleStatus?: string;
  pinned: boolean;
  version: string | null;
};
type BookingLifecycleRow = QueryResultRow & { guestBookingId: string; lifecycleStatus: string };
type BlockRow = QueryResultRow & {
  blockId: string;
  roomId: string | null;
  checkIn: string;
  checkOut: string;
  blockedCount: number;
};

export async function optimizePmsRoomAssignmentsInTransaction(
  client: PmsRoomAssignmentOptimizationClient,
  command: PmsRoomAssignmentOptimizationCommand,
): Promise<PmsRoomAssignmentOptimizationCommandResult> {
  const acceptedAt = new Date();
  const start = await startPmsRoomAssignmentOptimizationCommand(client, command, acceptedAt);
  if (start.kind === "replay") return start.result;
  if (start.kind === "conflict") return { outcome: start.outcome };
  const { reservation } = start;
  await lockPmsPhysicalRoomUnitMutationScope(client, command.propertyId, command.roomTypeId);
  const roomRows = await lockRooms(client, command);
  const enabled = await readEnabled(client, command.propertyId);
  if (enabled === null)
    return complete(client, reservation, { outcome: "invalid_snapshot" }, acceptedAt);
  if (!enabled) return complete(client, reservation, { outcome: "disabled" }, acceptedAt);

  const rooms = roomRows.filter(isEligibleRoom).map<PmsRoomAssignmentOptimizationRoom>((room) => ({
    roomId: room.roomId,
    sortOrder: room.sortOrder,
  }));
  if (rooms.length < 2)
    return complete(client, reservation, { outcome: "single_room" }, acceptedAt);

  const assignmentRows = await lockAssignments(client, command);
  const lifecycles = await lockBookingLifecycles(client, command, assignmentRows);
  const assignments = assignmentRows.map((assignment) => ({
    ...assignment,
    lifecycleStatus: lifecycles.get(assignment.guestBookingId) ?? "",
  }));
  if (
    lifecycles.size !== new Set(assignments.map(({ guestBookingId }) => guestBookingId)).size ||
    assignments.some(
      ({ stayEvidenceKind, checkIn, checkOut }) =>
        stayEvidenceKind !== "exact" || !checkIn || !checkOut,
    )
  ) {
    return complete(client, reservation, { outcome: "invalid_snapshot" }, acceptedAt);
  }
  const blocks = await lockBlocks(client, command);
  if (blocks.some(({ roomId, blockedCount }) => roomId === null && blockedCount > 0)) {
    return complete(client, reservation, { outcome: "invalid_snapshot" }, acceptedAt);
  }
  const occupancies: PmsRoomAssignmentOptimizationOccupancy[] = [
    ...assignments.map((assignment) => ({
      occupancyId: assignment.assignmentId,
      roomId: assignment.roomId,
      checkIn: assignment.checkIn!,
      checkOut: assignment.checkOut!,
      movable:
        assignment.lifecycleStatus === "confirmed" &&
        ["pending", "assigned"].includes(assignment.assignmentStatus) &&
        assignment.checkIn! >= command.currentDate &&
        !assignment.pinned,
    })),
    ...blocks.map((block) => ({
      occupancyId: `block:${block.blockId}`,
      roomId: block.roomId!,
      checkIn: block.checkIn,
      checkOut: block.checkOut,
      movable: false,
    })),
  ];
  const result = optimizePmsRoomAssignments(rooms, occupancies, {
    searchBudget: command.searchBudget,
  });
  if (result.outcome === "budget_exhausted") {
    await releasePmsRoomAssignmentOptimizationCommand(client, reservation);
    return result;
  }
  if (result.outcome !== "optimized" || result.moves.length === 0) {
    return complete(client, reservation, result, acceptedAt);
  }

  await applyMoves(client, command, result.moves, assignments);
  await appendPmsRoomAssignmentOptimizationEvidence(client, command, result, reservation);
  return complete(client, reservation, result, acceptedAt);
}

async function complete(
  client: PmsRoomAssignmentOptimizationClient,
  reservation: PmsRoomAssignmentOptimizationCommandReservation,
  result: PmsRoomAssignmentOptimizationStoredResult,
  at: Date,
): Promise<PmsRoomAssignmentOptimizationStoredResult> {
  await completePmsRoomAssignmentOptimizationCommand(client, reservation, result, at);
  return result;
}

async function lockRooms(
  client: PmsRoomAssignmentOptimizationClient,
  command: PmsRoomAssignmentOptimizationCommand,
): Promise<RoomRow[]> {
  const result = await client.query<RoomRow>(
    `SELECT id::text AS "roomId", sort_order AS "sortOrder", status,
            operational_label_status AS "operationalLabelStatus", room_number AS "roomNumber"
     FROM pms.rooms
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
     ORDER BY id
     FOR UPDATE`,
    [command.propertyId, command.roomTypeId],
  );
  return result.rows;
}

function isEligibleRoom(room: RoomRow): boolean {
  return (
    room.status === "available" &&
    room.operationalLabelStatus === "verified" &&
    room.roomNumber !== null
  );
}

async function readEnabled(
  client: PmsRoomAssignmentOptimizationClient,
  propertyId: string,
): Promise<boolean | null> {
  const result = await client.query<{ enabled: boolean } & QueryResultRow>(
    `SELECT auto_rearrange_enabled AS enabled
     FROM pms.effective_room_assignment_optimization_settings
     WHERE property_id = $1::uuid`,
    [propertyId],
  );
  return result.rows[0]?.enabled ?? null;
}

async function lockAssignments(
  client: PmsRoomAssignmentOptimizationClient,
  command: PmsRoomAssignmentOptimizationCommand,
): Promise<AssignmentRow[]> {
  const result = await client.query<AssignmentRow>(
    `SELECT assignment.id::text AS "assignmentId",
            assignment.guest_booking_id::text AS "guestBookingId",
            assignment.room_id::text AS "roomId",
            assignment.assignment_status AS "assignmentStatus",
            assignment.stay_evidence_kind AS "stayEvidenceKind",
            assignment.check_in::text AS "checkIn", assignment.check_out::text AS "checkOut",
            COALESCE(assignment.assignment_payload ->> 'pinnedToRoom' = 'true', FALSE) AS pinned,
            assignment.assignment_payload ->> 'version' AS version
     FROM pms.operational_booking_assignments assignment
     JOIN booking.guest_bookings booking
       ON booking.id = assignment.guest_booking_id
      AND booking.property_id = assignment.property_id
     WHERE assignment.property_id = $1::uuid AND assignment.room_type_id = $2::uuid
       AND assignment.assignment_status NOT IN ('canceled', 'released')
       AND COALESCE(assignment.check_out, booking.check_out) > $3::date
     ORDER BY assignment.id
     FOR UPDATE OF assignment`,
    [command.propertyId, command.roomTypeId, command.currentDate],
  );
  return result.rows;
}

async function lockBookingLifecycles(
  client: PmsRoomAssignmentOptimizationClient,
  command: PmsRoomAssignmentOptimizationCommand,
  assignments: readonly AssignmentRow[],
): Promise<Map<string, string>> {
  const bookingIds = [...new Set(assignments.map(({ guestBookingId }) => guestBookingId))].sort();
  if (bookingIds.length === 0) return new Map();
  const result = await client.query<BookingLifecycleRow>(
    `SELECT id::text AS "guestBookingId", lifecycle_status AS "lifecycleStatus"
     FROM booking.guest_bookings
     WHERE property_id = $1::uuid AND id = ANY($2::uuid[])
     ORDER BY id FOR UPDATE`,
    [command.propertyId, bookingIds],
  );
  return new Map(
    result.rows.map(({ guestBookingId, lifecycleStatus }) => [guestBookingId, lifecycleStatus]),
  );
}

async function lockBlocks(
  client: PmsRoomAssignmentOptimizationClient,
  command: PmsRoomAssignmentOptimizationCommand,
): Promise<BlockRow[]> {
  const result = await client.query<BlockRow>(
    `SELECT id::text AS "blockId", room_id::text AS "roomId",
            starts_on::text AS "checkIn", (ends_on + 1)::text AS "checkOut",
            blocked_count AS "blockedCount"
     FROM pms.room_blocks
     WHERE property_id = $1::uuid AND room_type_id = $2::uuid
       AND status = 'active' AND ends_on >= $3::date
     ORDER BY id
     FOR UPDATE`,
    [command.propertyId, command.roomTypeId, command.currentDate],
  );
  return result.rows;
}

async function applyMoves(
  client: PmsRoomAssignmentOptimizationClient,
  command: PmsRoomAssignmentOptimizationCommand,
  moves: readonly PmsRoomAssignmentOptimizationMove[],
  assignments: readonly AssignmentRow[],
): Promise<void> {
  const result = await client.query(
    `UPDATE pms.operational_booking_assignments assignment
     SET room_id = move.to_room_id,
         assignment_status = 'assigned',
         assigned_at = COALESCE(assignment.assigned_at, now()),
         assignment_payload = jsonb_set(COALESCE(assignment.assignment_payload, '{}'::jsonb),
           '{version}', to_jsonb(CASE
             WHEN assignment.assignment_payload ->> 'version' ~ '^reservation-v[0-9]+$'
               THEN 'reservation-v' ||
                 ((substring(assignment.assignment_payload ->> 'version' from 14))::integer + 1)
             ELSE 'reservation-v1' END), TRUE),
         updated_at = now()
     FROM jsonb_to_recordset($3::jsonb) AS move(
       assignment_id uuid, from_room_id uuid, to_room_id uuid, assignment_status text,
       check_in date, check_out date, version text
     ), booking.guest_bookings booking
     WHERE assignment.id = move.assignment_id
       AND assignment.property_id = $1::uuid AND assignment.room_type_id = $2::uuid
       AND assignment.room_id IS NOT DISTINCT FROM move.from_room_id
       AND assignment.assignment_status = move.assignment_status
       AND assignment.stay_evidence_kind = 'exact'
       AND assignment.check_in = move.check_in AND assignment.check_out = move.check_out
       AND assignment.check_in >= $4::date
       AND assignment.assignment_payload ->> 'version' IS NOT DISTINCT FROM move.version
       AND COALESCE(assignment.assignment_payload ->> 'pinnedToRoom' = 'true', FALSE) = FALSE
       AND booking.id = assignment.guest_booking_id AND booking.property_id = assignment.property_id
       AND booking.lifecycle_status = 'confirmed'`,
    [
      command.propertyId,
      command.roomTypeId,
      JSON.stringify(guardedMovesToSql(moves, assignments)),
      command.currentDate,
    ],
  );
  if (result.rowCount !== moves.length) throw new Error("PMS room-assignment snapshot changed");
}

function guardedMovesToSql(
  moves: readonly PmsRoomAssignmentOptimizationMove[],
  assignments: readonly AssignmentRow[],
) {
  const byId = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]));
  return moves.map((move) => {
    const assignment = byId.get(move.occupancyId)!;
    return {
      assignment_id: move.occupancyId,
      from_room_id: move.fromRoomId,
      to_room_id: move.toRoomId,
      assignment_status: assignment.assignmentStatus,
      check_in: assignment.checkIn,
      check_out: assignment.checkOut,
      version: assignment.version,
    };
  });
}
