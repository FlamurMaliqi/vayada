export const BOOKING_ROOM_SELECTION_VERSION = "booking-room-selection.v1";

export type BookingRoomGuests = Readonly<{ adults: number; children: number }>;
export type BookingRoomLine = Readonly<{
  roomTypeId: string;
  publicOfferKey: string;
  /** One allocation per physical room; its length is the reserved quantity. */
  guests: readonly BookingRoomGuests[];
}>;
export type BookingRoomSelection = Readonly<{
  contractVersion: typeof BOOKING_ROOM_SELECTION_VERSION;
  lines: readonly BookingRoomLine[];
}>;

/** Parse identifiers/allocation only. Current prices, limits and policies belong to the server. */
export function parseBookingRoomSelection(value: unknown): BookingRoomSelection | null {
  if (
    !record(value) ||
    value.contractVersion !== BOOKING_ROOM_SELECTION_VERSION ||
    !Array.isArray(value.lines) ||
    value.lines.length < 1 ||
    value.lines.length > 99
  )
    return null;
  const lines: BookingRoomLine[] = [];
  const types = new Set<string>();
  let roomCount = 0;
  for (const line of value.lines) {
    if (
      !record(line) ||
      typeof line.roomTypeId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line.roomTypeId) ||
      typeof line.publicOfferKey !== "string" ||
      !line.publicOfferKey.trim() ||
      line.publicOfferKey.length > 512 ||
      !Array.isArray(line.guests) ||
      line.guests.length < 1 ||
      (roomCount += line.guests.length) > 99
    )
      return null;
    const roomTypeId = line.roomTypeId.toLowerCase();
    if (types.has(roomTypeId)) return null;
    types.add(roomTypeId);
    const guests: BookingRoomGuests[] = [];
    for (const guest of line.guests) {
      if (!record(guest) || !count(guest.adults, 1) || !count(guest.children, 0)) return null;
      guests.push({ adults: guest.adults, children: guest.children });
    }
    lines.push({ roomTypeId, publicOfferKey: line.publicOfferKey, guests });
  }
  return { contractVersion: BOOKING_ROOM_SELECTION_VERSION, lines };
}

export function bookingRoomSelectionParty(selection: BookingRoomSelection) {
  return selection.lines
    .flatMap((line) => line.guests)
    .reduce<{ adults: number; children: number; rooms: number }>(
      (total, room) => ({
        adults: total.adults + room.adults,
        children: total.children + room.children,
        rooms: total.rooms + 1,
      }),
      { adults: 0, children: 0, rooms: 0 },
    );
}

export function bookingRoomLineFits(
  line: BookingRoomLine,
  limits: { maxAdults: number; maxChildren: number; maxOccupancy: number; availableRooms: number },
): boolean {
  return (
    [limits.maxAdults, limits.maxChildren, limits.maxOccupancy, limits.availableRooms].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    line.guests.length <= limits.availableRooms &&
    line.guests.every(
      (guest) =>
        guest.adults <= limits.maxAdults &&
        guest.children <= limits.maxChildren &&
        guest.adults + guest.children <= limits.maxOccupancy,
    )
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function count(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= 99;
}
