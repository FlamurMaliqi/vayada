import { pmsClient } from "../api/pmsClient";
import { BookingAddon } from "../bookings";

export interface CalendarRoomType {
  id: string;
  name: string;
  category: string;
  totalRooms: number;
  baseRate: number;
  maxOccupancy: number;
  currency: string;
  seasons: {
    name?: string;
    tier?: string;
    from: string;
    to: string;
    rate?: string | number;
    minStay?: number;
    maxStay?: number | string | null;
  }[];
}

export interface CalendarRoom {
  id: string;
  roomTypeId: string;
  roomTypeName: string;
  roomNumber: string;
  floor: string;
  status: string;
}

export interface CalendarBooking {
  id: string;
  roomTypeId: string;
  roomName: string;
  guestFirstName: string;
  guestLastName: string;
  checkIn: string;
  checkOut: string;
  status: "pending" | "confirmed" | "checked_in" | "in_house";
  roomId: string | null;
  roomNumber: string | null;
  channel: string;
  bookingReference: string;
  // VAY-403: a multi-room booking returns one entry per assigned room,
  // all sharing id + bookingReference. numberOfRooms is the booked
  // quantity; roomPosition is 0 for the primary room, 1..N-1 for extras.
  numberOfRooms: number;
  roomPosition: number;
}

export interface CalendarBlock {
  id: string;
  roomTypeId: string;
  roomId: string | null;
  roomNumber: string | null;
  startDate: string;
  endDate: string;
  blockedCount: number;
  reason: string;
  createdAt: string;
  kind?: "manual" | "linked_booking" | "linked_manual_block";
  sourceRoomTypeId?: string | null;
  sourceRoomTypeName?: string | null;
  sourceSummary?: string | null;
  protected?: boolean;
}

export interface CalendarOccupancyDay {
  date: string;
  occupiedUnits: number;
  remainingSellableUnits: number;
  denominatorUnits: number;
  percentage: number | null;
}

export interface CalendarData {
  roomTypes: CalendarRoomType[];
  rooms: CalendarRoom[];
  bookings: CalendarBooking[];
  blocks: CalendarBlock[];
  occupancyDays?: CalendarOccupancyDay[];
}

type LinkedInventoryGroup = {
  groupId: string;
  name: string;
  memberRoomTypeIds: string[];
};

export interface CreateRoomBlockPayload {
  roomTypeId: string;
  roomIds: string[];
  startDate: string;
  endDate: string;
  reason: string;
}

export interface UpdateRoomBlockPayload {
  startDate?: string;
  endDate?: string;
  reason?: string;
}

export interface CreateAdminBookingPayload {
  roomId: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  specialRequests: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  nightlyRate: number | null;
  channel: string;
  addonIds?: string[];
  addonQuantities?: Record<string, number>;
}

export const calendarService = {
  getCalendarData: async (start: string, end: string) => {
    const [data, groups] = await Promise.all([
      pmsClient.get<CalendarData>(`/admin/calendar?start=${start}&end=${end}`),
      pmsClient.get<LinkedInventoryGroup[]>("/admin/linked-inventory-groups"),
    ]);
    return projectLinkedInventoryBlocks(data, groups);
  },

  createRoomBlock: (data: CreateRoomBlockPayload) =>
    pmsClient.post<CalendarBlock[]>("/admin/room-blocks", data),

  updateRoomBlock: (blockId: string, data: UpdateRoomBlockPayload) =>
    pmsClient.patch<CalendarBlock>(`/admin/room-blocks/${blockId}`, data),

  deleteRoomBlock: (blockId: string) => pmsClient.delete(`/admin/room-blocks/${blockId}`),

  createAdminBooking: (data: CreateAdminBookingPayload) => pmsClient.post("/admin/bookings", data),

  getUnavailableLinkedRoomTypeIds: (checkIn: string, checkOut: string) =>
    pmsClient.get<string[]>(
      `/admin/linked-inventory-groups/unavailable-room-type-ids?check_in=${checkIn}&check_out=${checkOut}`,
    ),

  listAvailableAddons: (roomId: string) =>
    pmsClient.get<BookingAddon[]>(`/admin/bookings/addons/available?room_id=${roomId}`),

  // Booking-engine-equivalent nightly rate for the given room type and check-in
  // date — used by the New Booking modal so the pre-filled rate matches what
  // the guest would have been quoted (seasons / daily overrides / weekend
  // surcharge), instead of just the raw base_rate which can be 0 when the
  // property prices entirely via seasons.
  getResolvedRate: (roomTypeId: string, checkIn: string) =>
    pmsClient.get<{ nightlyRate: number; currency: string }>(
      `/admin/room-types/${roomTypeId}/resolved-rate?check_in=${checkIn}`,
    ),

  reorderRooms: (orderedRoomIds: string[]) =>
    pmsClient.patch("/admin/rooms/reorder", { orderedRoomIds }),
};

function projectLinkedInventoryBlocks(
  data: CalendarData,
  groups: LinkedInventoryGroup[],
): CalendarData {
  const groupByRoomType = new Map(
    groups.flatMap((group) =>
      group.memberRoomTypeIds.map((roomTypeId) => [roomTypeId, group] as const),
    ),
  );
  const roomTypeById = new Map(data.roomTypes.map((roomType) => [roomType.id, roomType]));
  const blocks = data.blocks.map((block) => {
    const protectedBlock = block.protected ?? block.kind?.startsWith("linked_") ?? false;
    return {
      ...block,
      protected: protectedBlock,
      blockedCount:
        protectedBlock && !block.roomId
          ? Math.max(block.blockedCount, roomTypeById.get(block.roomTypeId)?.totalRooms ?? 0)
          : block.blockedCount,
    };
  });
  if (groupByRoomType.size === 0) return { ...data, blocks };
  const projected = new Set(
    blocks
      .filter((block) => block.protected)
      .map((block) =>
        linkedBlockKey(
          block.kind,
          block.roomTypeId,
          block.sourceRoomTypeId,
          block.startDate,
          block.endDate,
        ),
      ),
  );

  const add = (
    sourceId: string,
    sourceRoomTypeId: string,
    startDate: string,
    endDate: string,
    kind: "linked_booking" | "linked_manual_block",
    sourceSummary: string,
    createdAt: string,
  ) => {
    const group = groupByRoomType.get(sourceRoomTypeId);
    if (!group) return;
    const sourceRoomTypeName = roomTypeById.get(sourceRoomTypeId)?.name ?? null;
    for (const targetRoomTypeId of group.memberRoomTypeIds) {
      if (targetRoomTypeId === sourceRoomTypeId) continue;
      const key = linkedBlockKey(kind, targetRoomTypeId, sourceRoomTypeId, startDate, endDate);
      if (projected.has(key)) continue;
      projected.add(key);
      blocks.push({
        id: `linked-${kind}-${sourceId}-${targetRoomTypeId}`,
        roomTypeId: targetRoomTypeId,
        roomId: null,
        roomNumber: null,
        startDate,
        endDate,
        blockedCount: Math.max(roomTypeById.get(targetRoomTypeId)?.totalRooms ?? 0, 1),
        reason: "Linked inventory",
        createdAt,
        kind,
        sourceRoomTypeId,
        sourceRoomTypeName,
        sourceSummary,
        protected: true,
      });
    }
  };

  for (const booking of data.bookings) {
    const sourceRoomTypeName = roomTypeById.get(booking.roomTypeId)?.name ?? booking.roomName;
    add(
      `${booking.id}-${booking.roomPosition}-${booking.checkIn}-${booking.checkOut}`,
      booking.roomTypeId,
      booking.checkIn,
      booking.checkOut,
      "linked_booking",
      [`Booking ${booking.bookingReference}`, sourceRoomTypeName].filter(Boolean).join(" · "),
      `${booking.checkIn}T00:00:00.000Z`,
    );
  }
  for (const block of blocks) {
    if (block.protected) continue;
    const sourceRoomTypeName = roomTypeById.get(block.roomTypeId)?.name ?? "";
    add(
      block.id,
      block.roomTypeId,
      block.startDate,
      block.endDate,
      "linked_manual_block",
      [`Block: ${block.reason}`, sourceRoomTypeName].filter(Boolean).join(" · "),
      block.createdAt,
    );
  }

  return { ...data, blocks };
}

function linkedBlockKey(
  kind: CalendarBlock["kind"],
  roomTypeId: string,
  sourceRoomTypeId: string | null | undefined,
  startDate: string,
  endDate: string,
): string {
  return [kind, roomTypeId, sourceRoomTypeId, startDate, endDate].join(":");
}
