import { describe, expect, it } from "vitest";
import type { RoomType } from "./types";
import { resolveCheckoutRoom } from "./roomSelection";

const stay = { checkIn: "2027-02-01", checkOut: "2027-02-03", adults: 4, children: 0, rooms: 2 };
const room = {
  id: "selection-full",
  combination: {
    ...stay,
    expiresAt: "2027-01-01T10:15:00Z",
    roomSelection: {
      contractVersion: "booking-room-selection.v1",
      lines: [
        { roomTypeId: "a", publicOfferKey: "a:flex", guests: [{ adults: 2, children: 0 }] },
        { roomTypeId: "b", publicOfferKey: "b:flex", guests: [{ adults: 2, children: 0 }] },
      ],
    },
  },
} as unknown as RoomType;
const now = Date.parse("2027-01-01T10:00:00Z");
describe("checkout selection resolution", () => {
  it("resolves the complete identifier and never falls back from an unknown one", () => {
    expect(resolveCheckoutRoom([room], room.id, stay, now)).toBe(room);
    expect(resolveCheckoutRoom([room], "selection-missing", stay, now)).toBeUndefined();
    expect(resolveCheckoutRoom([room], "", stay, now)).toBeUndefined();
    expect(resolveCheckoutRoom([{ id: room.id } as RoomType], room.id, stay, now)).toBeUndefined();
  });
  it("rejects expired and changed stay, party or room counts", () => {
    for (const patch of [
      { checkIn: "2027-02-02" },
      { checkOut: "2027-02-04" },
      { adults: 5 },
      { children: 1 },
      { rooms: 3 },
    ])
      expect(resolveCheckoutRoom([room], room.id, { ...stay, ...patch }, now)).toBeUndefined();
    expect(
      resolveCheckoutRoom([room], room.id, stay, Date.parse(room.combination!.expiresAt)),
    ).toBeUndefined();
    const inconsistent = structuredClone(room);
    inconsistent.combination!.roomSelection.lines[1].guests[0].adults = 1;
    expect(resolveCheckoutRoom([inconsistent], room.id, stay, now)).toBeUndefined();
  });
});
