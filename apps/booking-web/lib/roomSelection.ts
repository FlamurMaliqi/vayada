import type { RoomType, RoomSelection } from "@/lib/types";

export type CheckoutStay = {
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  rooms: number;
};

/** A stale or mismatched selection cannot silently become the first available room. */
export function resolveCheckoutRoom(
  rooms: RoomType[],
  id: string,
  stay: CheckoutStay,
  now = Date.now(),
): RoomType | undefined {
  const room = id ? rooms.find((candidate) => candidate.id === id) : rooms[0];
  if (!room) return undefined;
  const combination = room.combination;
  if (!id && combination) return undefined;
  if (!combination) return room.id.startsWith("selection-") ? undefined : room;
  const allocated = combination.roomSelection.lines.flatMap((line) => line.guests);
  if (
    combination.checkIn !== stay.checkIn ||
    combination.checkOut !== stay.checkOut ||
    combination.adults !== stay.adults ||
    combination.children !== stay.children ||
    allocated.length !== stay.rooms ||
    allocated.reduce((sum, guest) => sum + guest.adults, 0) !== stay.adults ||
    allocated.reduce((sum, guest) => sum + guest.children, 0) !== stay.children ||
    !(Date.parse(combination.expiresAt) > now)
  )
    return undefined;
  return room;
}

export function selectionCheckoutFields(room: RoomType): {
  roomTypeId: string;
  roomSelection?: RoomSelection;
  currency?: string;
} {
  return {
    roomTypeId: room.combination?.roomSelection.lines[0].roomTypeId ?? room.id,
    roomSelection: room.combination?.roomSelection,
    currency: room.combination ? room.currency : undefined,
  };
}

/** Compare all rate keys and allocations, never just the first room type. */
export function sameRoomSelection(left?: RoomSelection, right?: RoomSelection): boolean {
  return Boolean(
    left &&
    right &&
    left.contractVersion === right.contractVersion &&
    Array.isArray(left.lines) &&
    Array.isArray(right.lines) &&
    left.lines.length === right.lines.length &&
    left.lines.every((line, index) => {
      const other = right.lines[index];
      return (
        other &&
        line.roomTypeId === other.roomTypeId &&
        line.publicOfferKey === other.publicOfferKey &&
        Array.isArray(line.guests) &&
        Array.isArray(other.guests) &&
        line.guests.length === other.guests.length &&
        line.guests.every(
          (guest, position) =>
            guest.adults === other.guests[position]?.adults &&
            guest.children === other.guests[position]?.children,
        )
      );
    }),
  );
}
export function roomSelectionPartyMatches(
  selection: RoomSelection,
  adults: number,
  children: number,
): boolean {
  const guests = selection.lines.flatMap((line) => line.guests);
  return (
    guests.reduce((sum, guest) => sum + guest.adults, 0) === adults &&
    guests.reduce((sum, guest) => sum + guest.children, 0) === children
  );
}
