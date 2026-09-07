import { describe, expect, it } from "vitest";
import {
  BOOKING_ROOM_SELECTION_VERSION,
  bookingRoomLineFits,
  bookingRoomSelectionParty,
  parseBookingRoomSelection,
} from "./roomSelection.js";

const line = {
  roomTypeId: "91000000-0000-4000-8000-000000000001",
  publicOfferKey: "double:flex",
  guests: [
    { adults: 2, children: 0 },
    { adults: 1, children: 1 },
  ],
};
const input = {
  contractVersion: BOOKING_ROOM_SELECTION_VERSION,
  lines: [
    line,
    {
      ...line,
      roomTypeId: "91000000-0000-4000-8000-000000000002",
      publicOfferKey: "twin:flex",
      guests: [{ adults: 2, children: 0 }],
    },
  ],
};

describe("booking room selection", () => {
  it("preserves each room allocation and counts the complete party", () => {
    const selection = parseBookingRoomSelection(input)!;
    expect(bookingRoomSelectionParty(selection)).toEqual({ adults: 5, children: 1, rooms: 3 });
    expect(selection).toEqual(input);
    expect(selection.lines[0]).not.toBe(line);
  });
  it.each([
    null,
    {},
    { ...input, contractVersion: "future" },
    { ...input, lines: [] },
    { ...input, lines: [line, line] },
    { ...input, lines: [{ ...line, roomTypeId: "wrong" }] },
    ...[
      [],
      [{ adults: 0, children: 1 }],
      [{ adults: 1.5, children: 0 }],
      [{ adults: 1, children: -1 }],
      Array(100).fill({ adults: 1, children: 0 }),
    ].map((guests) => ({ ...input, lines: [{ ...line, guests }] })),
  ])("rejects malformed or duplicate selections", (value) => {
    expect(parseBookingRoomSelection(value)).toBeNull();
  });
  it("checks every room and all three occupancy limits, not just the group total", () => {
    const limits = { maxAdults: 2, maxChildren: 1, maxOccupancy: 2, availableRooms: 2 };
    expect(bookingRoomLineFits(line, limits)).toBe(true);
    expect(bookingRoomLineFits(line, { ...limits, availableRooms: 1 })).toBe(false);
    expect(bookingRoomLineFits(line, { ...limits, maxChildren: 0 })).toBe(false);
    expect(bookingRoomLineFits(line, { ...limits, maxAdults: 1 })).toBe(false);
    expect(bookingRoomLineFits(line, { ...limits, maxOccupancy: 1 })).toBe(false);
    expect(bookingRoomLineFits(line, { ...limits, maxOccupancy: NaN })).toBe(false);
  });
});
