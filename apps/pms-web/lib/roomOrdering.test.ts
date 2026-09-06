import { expect, it } from "vitest";
import { orderRoomsByRoomType } from "./roomOrdering";

it("uses the Rooms & Rates type sequence and preserves saved order within each type", () => {
  const rooms = [
    { roomTypeId: "twin", roomNumber: "2" },
    { roomTypeId: "double", roomNumber: "10" },
    { roomTypeId: "missing", roomNumber: "101" },
    { roomTypeId: "double", roomNumber: "2" },
    { roomTypeId: "twin", roomNumber: "1" },
  ];
  const original = [...rooms];
  expect(orderRoomsByRoomType(rooms, ["double", "empty", "twin"])).toEqual([
    rooms[1],
    rooms[3],
    rooms[0],
    rooms[4],
    rooms[2],
  ]);
  expect(rooms).toEqual(original);
  expect(orderRoomsByRoomType(rooms, [])).toEqual(rooms);
  expect(orderRoomsByRoomType([], ["double"])).toEqual([]);
});
