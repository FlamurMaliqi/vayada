import { addPmsBlocker, propertyForHotel, safePmsSourceId } from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type {
  PmsAssignmentBuild,
  PmsBuildContext,
  PmsRoomBuild,
  PmsTargetBooking,
  PmsTargetRecord,
} from "./productionPmsTypes.js";
import {
  date,
  deterministicUuid,
  integer,
  iso,
  optionalIso,
  optionalText,
  optionalUuid,
  requiredText,
  uuid,
} from "./productionBookingValues.js";
import { pmsRecord } from "./productionPmsValues.js";

export function buildPmsAssignmentRecords(
  context: PmsBuildContext,
  rooms: PmsRoomBuild,
): PmsAssignmentBuild {
  const records: PmsTargetRecord[] = [];
  const assignmentByBookingPosition = new Map<string, string>();
  const extrasByBooking = extraRooms(context);
  for (const source of context.rowsByTable.get("bookings") ?? []) {
    try {
      const built = assignments(context, source, rooms, extrasByBooking);
      records.push(...built.records);
      for (const [key, id] of built.assignmentByPosition)
        assignmentByBookingPosition.set(key, id);
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.bookings",
        safePmsSourceId(source),
        error instanceof Error ? error.message : "Invalid booking assignment",
      );
    }
  }
  for (const [bookingId, extras] of extrasByBooking)
    if (!context.bookingById.has(bookingId))
      for (const extra of extras.values())
        addPmsBlocker(
          context,
          "ORPHAN_BOOKING_ROOM",
          "pms.booking_rooms",
          safePmsSourceId(extra),
          "Physical room assignment references a missing booking",
        );
  for (const source of context.rowsByTable.get("room_blocks") ?? [])
    try {
      records.push(...roomBlock(context, source));
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.room_blocks",
        safePmsSourceId(source),
        error instanceof Error ? error.message : "Invalid room block",
      );
    }
  return { records, assignmentByBookingPosition };
}

export function targetBooking(
  context: PmsBuildContext,
  bookingIdValue: unknown,
): { source: IdentitySourceRow; target: PmsTargetBooking; propertyId: string } {
  const bookingId = uuid(bookingIdValue, "booking_id");
  const source = context.bookingById.get(bookingId);
  const target = context.targetBookingById.get(bookingId);
  if (!source || !target)
    throw new Error(`booking ${bookingId} has not passed the VAY-1355 migration gate`);
  const propertyId = propertyForHotel(context, source.data["hotel_id"]);
  if (target.propertyId !== propertyId)
    throw new Error(`booking ${bookingId} target property does not match its PMS hotel`);
  return { source, target, propertyId };
}

function assignments(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  roomBuild: PmsRoomBuild,
  extrasByBooking: Map<string, Map<number, IdentitySourceRow>>,
): { records: PmsTargetRecord[]; assignmentByPosition: Map<string, string> } {
  const data = source.data;
  const bookingId = uuid(data["id"], "id");
  const target = targetBooking(context, bookingId);
  const roomTypeId = uuid(data["room_type_id"], "room_type_id");
  const roomType = context.roomTypeById.get(roomTypeId);
  if (!roomType || propertyForHotel(context, roomType.data["hotel_id"]) !== target.propertyId)
    throw new Error("booking references a missing or cross-property room type");
  const numberOfRooms = integer(data["number_of_rooms"], "number_of_rooms", 1);
  if (numberOfRooms < 1 || numberOfRooms > 20)
    throw new Error("number_of_rooms must be between 1 and 20");
  const primaryRoomId = optionalUuid(data["room_id"], "room_id");
  if (primaryRoomId) assertRoom(context, primaryRoomId, roomTypeId, target.propertyId);
  const extras = extrasByBooking.get(bookingId) ?? new Map();
  for (const position of extras.keys())
    if (position < 1 || position >= numberOfRooms)
      throw new Error(`booking_rooms position ${position} is outside number_of_rooms`);
  const records: PmsTargetRecord[] = [];
  const assignmentByPosition = new Map<string, string>();
  for (let position = 1; position <= numberOfRooms; position += 1) {
    const extra = position === 1 ? undefined : extras.get(position - 1);
    const roomId = position === 1 ? primaryRoomId : optionalUuid(extra?.data["room_id"], "room_id");
    if (roomId) assertRoom(context, roomId, roomTypeId, target.propertyId);
    const assignmentId = extra
      ? uuid(extra.data["id"], "booking_rooms.id")
      : deterministicUuid("production-pms", "assignment", bookingId, String(position));
    const recordSource = extra ?? source;
    const sourceUpdatedAt = extra
      ? iso(extra.data["created_at"], "booking_rooms.created_at")
      : iso(data["updated_at"], "updated_at");
    records.push(
      pmsRecord(
        recordSource,
        "operational_booking_assignments",
        assignmentId,
        sourceUpdatedAt,
        true,
        {
          id: assignmentId,
          propertyId: target.propertyId,
          guestBookingId: bookingId,
          roomTypeId,
          ratePlanId: roomBuild.flexiblePlanByRoomType.get(roomTypeId) ?? null,
          roomId,
          position,
          assignmentStatus: assignmentStatus(data["status"], roomId),
          pmsReservationRef: optionalText(data["booking_reference"], "booking_reference"),
          externalReservationId: externalBookingId(context, bookingId),
          channel: normalizedChannel(data["channel"]),
          source: assignmentSource(data["channel"]),
          assignmentPayload: {
            migrationRunId: context.sourceRunId,
            legacyBookingRoomId: extra?.data["id"] ?? null,
            legacyPosition: extra?.data["position"] ?? 0,
          },
          assignedAt: roomId ? sourceUpdatedAt : null,
          createdAt: extra
            ? iso(extra.data["created_at"], "booking_rooms.created_at")
            : iso(data["created_at"], "created_at"),
          updatedAt: sourceUpdatedAt,
          stayEvidenceKind: "exact",
          checkIn: date(data["check_in"], "check_in"),
          checkOut: date(data["check_out"], "check_out"),
          adults: integer(data["adults"], "adults", 1),
          children: integer(data["children"], "children", 0),
        },
        { booking: data, bookingRoom: extra?.data ?? null },
      ),
    );
    assignmentByPosition.set(`${bookingId}:${position}`, assignmentId);
  }
  return { records, assignmentByPosition };
}

function roomBlock(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const propertyId = propertyForHotel(context, data["hotel_id"]);
  const roomTypeId = uuid(data["room_type_id"], "room_type_id");
  const roomType = context.roomTypeById.get(roomTypeId);
  if (!roomType || propertyForHotel(context, roomType.data["hotel_id"]) !== propertyId)
    throw new Error("room block references a missing or cross-property room type");
  const roomId = optionalUuid(data["room_id"], "room_id");
  if (roomId) assertRoom(context, roomId, roomTypeId, propertyId);
  const startsOn = date(data["start_date"], "start_date");
  const legacyExclusiveEnd = date(data["end_date"], "end_date");
  const endsOn = previousDate(legacyExclusiveEnd);
  if (startsOn > endsOn) throw new Error("legacy room block has an empty date range");
  const createdAt = iso(data["created_at"], "created_at");
  return [
    pmsRecord(source, "room_blocks", id, createdAt, true, {
      id,
      propertyId,
      roomTypeId,
      roomId,
      startsOn,
      endsOn,
      blockedCount: integer(data["blocked_count"], "blocked_count", 1),
      reason: optionalText(data["reason"], "reason") ?? "",
      status: endsOn < context.completedAt.slice(0, 10) ? "expired" : "active",
      createdByUserId: null,
      createdAt,
      releasedAt: null,
      revision: 1,
      updatedAt: createdAt,
      blockKind: "manual",
      sourceRoomTypeId: null,
      sourceInventoryReservationReceiptId: null,
      sourceAssignmentId: null,
      sourceRoomBlockId: null,
    }),
  ];
}

function extraRooms(
  context: PmsBuildContext,
): Map<string, Map<number, IdentitySourceRow>> {
  const result = new Map<string, Map<number, IdentitySourceRow>>();
  for (const row of context.rowsByTable.get("booking_rooms") ?? []) {
    try {
      const bookingId = uuid(row.data["booking_id"], "booking_id");
      const position = integer(row.data["position"], "position");
      const positions = result.get(bookingId) ?? new Map<number, IdentitySourceRow>();
      if (positions.has(position))
        addPmsBlocker(
          context,
          "DUPLICATE_BOOKING_ROOM_POSITION",
          "pms.booking_rooms",
          bookingId,
          `Booking has duplicate physical room position ${position}`,
        );
      else positions.set(position, row);
      result.set(bookingId, positions);
    } catch (error) {
      addPmsBlocker(
        context,
        "INVALID_SOURCE_ROW",
        "pms.booking_rooms",
        safePmsSourceId(row),
        error instanceof Error ? error.message : "Invalid booking room",
      );
    }
  }
  return result;
}

function assertRoom(
  context: PmsBuildContext,
  roomId: string,
  roomTypeId: string,
  propertyId: string,
): void {
  const room = context.roomById.get(roomId);
  if (
    !room ||
    uuid(room.data["room_type_id"], "room.room_type_id") !== roomTypeId ||
    propertyForHotel(context, room.data["hotel_id"]) !== propertyId
  )
    throw new Error(`room ${roomId} is missing or outside the booking room type`);
}

function assignmentStatus(value: unknown, roomId: string | null): string {
  const status = requiredText(value, "status").toLowerCase();
  const mapped: Record<string, string> = {
    pending: "pending",
    confirmed: roomId ? "assigned" : "pending",
    checked_in: "checked_in",
    in_house: "in_house",
    checked_out: "checked_out",
    cancelled: "canceled",
    canceled: "canceled",
    declined: "released",
    withdrawn: "released",
    expired: "released",
    no_show: "released",
  };
  if (!mapped[status]) throw new Error(`booking assignment status ${status} is unsupported`);
  return mapped[status];
}

function normalizedChannel(value: unknown): string {
  const channel = optionalText(value, "channel")?.toLowerCase() ?? "direct";
  return channel === "website" || channel === "booking_engine" ? "direct" : channel;
}

function assignmentSource(value: unknown): string {
  const channel = normalizedChannel(value);
  if (channel === "direct") return "direct_booking";
  if (channel === "manual") return "manual";
  return "channel";
}

function externalBookingId(context: PmsBuildContext, bookingId: string): string | null {
  const mappings = (context.rowsByTable.get("channex_booking_mappings") ?? []).filter(
    (row) => String(row.data["booking_id"] ?? "").toLowerCase() === bookingId,
  );
  if (!mappings.length) return null;
  const ids = new Set(mappings.map((row) => requiredText(row.data["channex_booking_id"], "channex_booking_id")));
  if (ids.size !== 1) throw new Error("booking has conflicting external reservation IDs");
  return [...ids][0]!;
}

function previousDate(value: string): string {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return new Date(parsed - 86_400_000).toISOString().slice(0, 10);
}
