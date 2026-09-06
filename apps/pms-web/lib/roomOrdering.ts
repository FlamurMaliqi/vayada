// Rooms & Rates renders the API's room types in order, then filters the API's
// rooms for each type. Preserve both canonical sequences in flat calendar views.
export function orderRoomsByRoomType<T extends { roomTypeId: string }>(
  rooms: readonly T[],
  roomTypeIds: readonly string[],
): T[] {
  const positions = new Map(roomTypeIds.map((id, index) => [id, index]));
  return [...rooms].sort(
    (a, b) =>
      (positions.get(a.roomTypeId) ?? roomTypeIds.length) -
      (positions.get(b.roomTypeId) ?? roomTypeIds.length),
  );
}
