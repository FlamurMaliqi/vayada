import { pmsOperationsClient, pmsOperationsRequestOptions } from "../api/pmsOperationsClient";
import { propertyEndpoint, resolveSelectedPmsPropertyId } from "../api/pmsPropertyClient";
import { pmsManualBookingClient } from "../api/pmsManualBookingClient";
import { unsupportedPmsNextStackFeature } from "../api/unsupported";
import { BookingAddon } from "../bookings";

export interface CalendarRoomType {
  id: string;
  name: string;
  category: string;
  totalRooms: number;
  baseRate: number;
  maxOccupancy: number;
  currency: string;
  ratePlans: Array<{
    id: string;
    name: string;
    rateType: "flexible" | "non_refundable" | "package" | "manual";
    baseRate: number;
  }>;
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
  version: string;
  roomTypeId: string;
  roomId: string | null;
  roomNumber: string | null;
  startDate: string;
  endDate: string;
  blockedCount: number;
  reason: string;
  createdAt: string;
}

export interface CalendarData {
  roomTypes: CalendarRoomType[];
  rooms: CalendarRoom[];
  bookings: CalendarBooking[];
  blocks: CalendarBlock[];
}

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

type PmsOperationsMoney = {
  amountDecimal: string;
  currency: string;
};

type PmsOperationsRoomType = {
  roomTypeId: string;
  name: string;
  category: string | null;
  occupancyLimits: Record<string, number>;
  baseRate: PmsOperationsMoney;
  roomCount: number;
  ratePlans: Array<{
    ratePlanId: string;
    name: string;
    rateType: "flexible" | "non_refundable" | "package" | "manual";
    baseRate: PmsOperationsMoney;
    active: boolean;
  }>;
};

type PmsOperationsRoom = {
  roomId: string;
  roomTypeId: string;
  roomNumber: string;
  floor: string | null;
  status: "available" | "maintenance" | "out_of_order" | "retired";
};

type PmsOperationsRoomBlock = {
  blockId: string;
  version: string;
  roomTypeId: string;
  roomId: string | null;
  startsOn: string;
  endsOn: string;
  blockedCount: number;
  reason: string;
  status: "active" | "released" | "expired";
};

type PmsRoomBlockCommandResponse = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  items: PmsOperationsRoomBlock[];
};

type PmsOperationalReservation = {
  guestBookingId: string;
  bookingReference: string;
  status: string;
  source: "direct_booking" | "channel" | "manual" | "migration";
  stay: { checkIn: string; checkOut: string };
  primaryGuest: { displayName: string };
  assignments: Array<{
    roomTypeId: string;
    roomId: string | null;
    roomNumber: string | null;
    position: number;
    channel: string;
  }>;
};

type PmsOperationsListResponse<T> = {
  contractVersion: "pms-operations.v1";
  propertyId: string;
  items: T[];
  sourceFreshness: Record<string, string | number | boolean | null>;
};

type PmsOperationsReservationListResponse = PmsOperationsListResponse<PmsOperationalReservation> & {
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
};

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
  getCalendarData: (start: string, end: string) =>
    pmsOperationsCalendarReadService.getCalendarData(start, end),

  getManualBookingCapabilities: pmsManualBookingClient.capabilities,

  previewManualBooking: pmsManualBookingClient.preview,

  createManualBooking: pmsManualBookingClient.create,

  createRoomBlock: async (data: CreateRoomBlockPayload): Promise<CalendarBlock[]> => {
    const propertyId = await resolveSelectedPmsPropertyId("creating room block");
    const command = roomBlockCommandEnvelope();
    const response = await pmsOperationsClient.post<PmsRoomBlockCommandResponse>(
      propertyEndpoint(propertyId, "room-blocks"),
      {
        ...command,
        roomTypeId: data.roomTypeId,
        roomIds: data.roomIds,
        startsOn: data.startDate,
        endsOn: addDaysDateOnly(data.endDate, -1),
        reason: data.reason,
      },
      pmsOperationsRequestOptions,
    );
    return response.items.map((item) => toCalendarBlock(item, null));
  },

  updateRoomBlock: async (
    blockId: string,
    expectedVersion: string,
    data: UpdateRoomBlockPayload,
  ): Promise<CalendarBlock> => {
    const propertyId = await resolveSelectedPmsPropertyId("updating room block");
    const response = await pmsOperationsClient.patch<PmsRoomBlockCommandResponse>(
      propertyEndpoint(propertyId, `room-blocks/${blockId}`),
      {
        ...roomBlockCommandEnvelope(),
        expectedVersion,
        ...(data.startDate ? { startsOn: data.startDate } : {}),
        ...(data.endDate ? { endsOn: addDaysDateOnly(data.endDate, -1) } : {}),
        ...(data.reason !== undefined ? { reason: data.reason } : {}),
      },
      pmsOperationsRequestOptions,
    );
    return toCalendarBlock(response.items[0]!, null);
  },

  deleteRoomBlock: async (blockId: string, expectedVersion: string): Promise<void> => {
    const propertyId = await resolveSelectedPmsPropertyId("deleting room block");
    await pmsOperationsClient.delete<PmsRoomBlockCommandResponse>(
      propertyEndpoint(propertyId, `room-blocks/${blockId}`),
      {
        ...pmsOperationsRequestOptions,
        body: JSON.stringify({ ...roomBlockCommandEnvelope(), expectedVersion }),
      },
    );
  },

  createAdminBooking: (_data: CreateAdminBookingPayload) =>
    unsupportedPmsNextStackFeature("Manual booking creation"),

  listAvailableAddons: (_roomId: string) =>
    unsupportedPmsNextStackFeature<BookingAddon[]>("Booking add-ons"),

  // Booking-engine-equivalent nightly rate for the given room type and check-in
  // date — used by the New Booking modal so the pre-filled rate matches what
  // the guest would have been quoted (seasons / daily overrides / weekend
  // surcharge), instead of just the raw base_rate which can be 0 when the
  // property prices entirely via seasons.
  getResolvedRate: (_roomTypeId: string, _checkIn: string) =>
    unsupportedPmsNextStackFeature<{ nightlyRate: number; currency: string }>(
      "Resolved room rates",
    ),

  reorderRooms: (_orderedRoomIds: string[]) => unsupportedPmsNextStackFeature("Room reordering"),
};

const pmsOperationsCalendarReadService = {
  getCalendarData: async (start: string, end: string): Promise<CalendarData> => {
    const propertyId = await resolveSelectedPmsPropertyId("loading calendar");
    const query = `?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
    const [roomTypes, rooms, blocks, reservations] = await Promise.all([
      pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoomType>>(
        propertyEndpoint(propertyId, "room-types"),
        pmsOperationsRequestOptions,
      ),
      pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoom>>(
        propertyEndpoint(propertyId, "rooms"),
        pmsOperationsRequestOptions,
      ),
      pmsOperationsClient.get<PmsOperationsListResponse<PmsOperationsRoomBlock>>(
        `${propertyEndpoint(propertyId, "room-blocks")}${query}`,
        pmsOperationsRequestOptions,
      ),
      listCalendarReservations(propertyId, start, end),
    ]);
    return toCalendarData(roomTypes.items, rooms.items, blocks.items, reservations, {
      start,
      end,
    });
  },
};

async function listCalendarReservations(
  propertyId: string,
  start: string,
  end: string,
): Promise<PmsOperationalReservation[]> {
  const limit = 500;
  let offset = 0;
  const reservations: PmsOperationalReservation[] = [];

  while (true) {
    const response = await pmsOperationsClient.get<PmsOperationsReservationListResponse>(
      `${propertyEndpoint(propertyId, "reservations")}?stayFrom=${encodeURIComponent(
        start,
      )}&stayTo=${encodeURIComponent(end)}&limit=${limit}&offset=${offset}`,
      pmsOperationsRequestOptions,
    );
    reservations.push(...response.items);
    if (reservations.length >= response.pagination.total || response.items.length < limit) {
      return reservations;
    }
    offset += response.items.length;
  }
}

function toCalendarData(
  roomTypes: PmsOperationsRoomType[],
  rooms: PmsOperationsRoom[],
  blocks: PmsOperationsRoomBlock[],
  reservations: PmsOperationalReservation[],
  range: { start: string; end: string },
): CalendarData {
  const roomTypesById = new Map(roomTypes.map((roomType) => [roomType.roomTypeId, roomType]));
  const roomsById = new Map(rooms.map((room) => [room.roomId, room]));

  return {
    roomTypes: roomTypes.map((roomType) => ({
      id: roomType.roomTypeId,
      name: roomType.name,
      category: roomType.category ?? "",
      totalRooms: roomType.roomCount,
      baseRate: moneyAmount(roomType.baseRate),
      maxOccupancy: maxOccupancy(roomType),
      currency: roomType.baseRate.currency,
      ratePlans: (roomType.ratePlans ?? [])
        .filter((plan) => plan.active)
        .map((plan) => ({
          id: plan.ratePlanId,
          name: plan.name,
          rateType: plan.rateType,
          baseRate: moneyAmount(plan.baseRate),
        })),
      seasons: [],
    })),
    rooms: rooms
      .filter((room) => room.status !== "retired")
      .map((room) => ({
        id: room.roomId,
        roomTypeId: room.roomTypeId,
        roomTypeName: roomTypesById.get(room.roomTypeId)?.name ?? "",
        roomNumber: room.roomNumber,
        floor: room.floor ?? "",
        status: room.status,
      })),
    bookings: reservations
      .filter(
        (reservation) =>
          reservation.stay.checkIn < range.end && reservation.stay.checkOut > range.start,
      )
      .flatMap((reservation) => calendarBookingsForReservation(reservation, roomTypesById)),
    blocks: blocks
      .filter((block) => block.status === "active")
      .map((block) =>
        toCalendarBlock(
          block,
          block.roomId ? (roomsById.get(block.roomId)?.roomNumber ?? null) : null,
        ),
      ),
  };
}

function calendarBookingsForReservation(
  reservation: PmsOperationalReservation,
  roomTypesById: Map<string, PmsOperationsRoomType>,
): CalendarBooking[] {
  const status = toCalendarStatus(reservation.status);
  if (!status) return [];

  const assignments = reservation.assignments.length > 0 ? reservation.assignments : [null];
  const [guestFirstName, guestLastName] = splitGuestName(reservation.primaryGuest.displayName);
  return assignments.map((assignment, index) => {
    const roomType = assignment ? roomTypesById.get(assignment.roomTypeId) : undefined;
    return {
      id: reservation.guestBookingId,
      roomTypeId: assignment?.roomTypeId ?? "",
      roomName: roomType?.name ?? "",
      guestFirstName,
      guestLastName,
      checkIn: reservation.stay.checkIn,
      checkOut: reservation.stay.checkOut,
      status,
      roomId: assignment?.roomId ?? null,
      roomNumber: assignment?.roomNumber ?? null,
      channel: assignment?.channel ?? reservationSource(reservation.source),
      bookingReference: reservation.bookingReference,
      numberOfRooms: assignments.length,
      roomPosition: assignment?.position ?? index,
    };
  });
}

function splitGuestName(displayName: string): [string, string] {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ["", ""];
  const [firstName, ...rest] = parts;
  return [firstName, rest.join(" ")];
}

function moneyAmount(money: PmsOperationsMoney | undefined): number {
  const amount = Number.parseFloat(money?.amountDecimal ?? "0");
  return Number.isFinite(amount) ? amount : 0;
}

function maxOccupancy(roomType: PmsOperationsRoomType | undefined): number {
  if (!roomType) return 0;
  const total = roomType.occupancyLimits.total;
  if (typeof total === "number") return total;
  return Object.values(roomType.occupancyLimits).reduce((sum, value) => sum + value, 0);
}

function reservationSource(source: PmsOperationalReservation["source"]): string {
  return source === "direct_booking" ? "direct" : source;
}

function toCalendarStatus(status: string): CalendarBooking["status"] | null {
  switch (status) {
    case "pending":
    case "confirmed":
    case "checked_in":
    case "in_house":
      return status;
    default:
      return null;
  }
}

function addDaysDateOnly(date: string, days: number): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return date;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function roomBlockCommandEnvelope(): { commandId: string; idempotencyKey: string } {
  const commandId = globalThis.crypto.randomUUID();
  return { commandId, idempotencyKey: `pms-room-block:${commandId}` };
}

function toCalendarBlock(block: PmsOperationsRoomBlock, roomNumber: string | null): CalendarBlock {
  return {
    id: block.blockId,
    version: block.version,
    roomTypeId: block.roomTypeId,
    roomId: block.roomId,
    roomNumber,
    startDate: block.startsOn,
    endDate: addDaysDateOnly(block.endsOn, 1),
    blockedCount: block.blockedCount,
    reason: block.reason,
    createdAt: `${block.startsOn}T00:00:00.000Z`,
  };
}
