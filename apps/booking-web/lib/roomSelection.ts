import type { RoomType } from "@/lib/types";

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
