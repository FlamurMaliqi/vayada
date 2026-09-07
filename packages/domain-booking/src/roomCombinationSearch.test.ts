import { describe, expect, it } from "vitest";
import { searchRoomCombinations, type RoomCombinationCandidate } from "./roomCombinationSearch.js";
import { bookingRoomLineFits, bookingRoomSelectionParty } from "./roomSelection.js";

const offer = (
  id: string,
  overrides: Partial<RoomCombinationCandidate> = {},
): RoomCombinationCandidate => ({
  roomTypeId: id,
  publicOfferKey: `${id}:flexible`,
  maxAdults: 2,
  maxChildren: 0,
  maxOccupancy: 2,
  availableRooms: 1,
  priceMinor: 10001n,
  currency: "EUR",
  paymentMethods: ["card", "cash"],
  ...overrides,
});

describe("complete room combination feasibility", () => {
  it("allocates six guests to two doubles and one twin with exact money", () => {
    const result = searchRoomCombinations([offer("double", { availableRooms: 2 }), offer("twin")], {
      adults: 6,
      children: 0,
    });
    expect(result.complete).toBe(true);
    expect(
      result.options[0].selection.lines.map((line) => [line.roomTypeId, line.guests.length]),
    ).toEqual([
      ["double", 2],
      ["twin", 1],
    ]);
    expect(result.options[0].totalMinor).toBe(30003n);
    expect(bookingRoomSelectionParty(result.options[0].selection)).toEqual({
      adults: 6,
      children: 0,
      rooms: 3,
    });
  });
  it("finds three distinct types and reports genuinely insufficient stock", () => {
    const candidates = [offer("a"), offer("b"), offer("c")];
    expect(
      searchRoomCombinations(candidates, { adults: 6, children: 0 }).options[0].selection.lines,
    ).toHaveLength(3);
    expect(searchRoomCombinations(candidates, { adults: 7, children: 0 })).toEqual({
      complete: true,
      options: [],
    });
  });
  it("prefers sufficient single-type capacity even over a cheaper mix", () => {
    const result = searchRoomCombinations(
      [offer("a", { availableRooms: 2, priceMinor: 200n }), offer("b", { priceMinor: 1n })],
      { adults: 4, children: 0 },
    );
    expect(result.options[0].selection.lines).toHaveLength(1);
    expect(result.options[0].totalMinor).toBe(400n);
  });
  it("returns sufficient single-type options before exploring expensive mixed states", () => {
    const candidates = Array.from({ length: 5 }, (_, index) =>
      offer(String(index), {
        availableRooms: 10,
        maxAdults: 4,
        maxChildren: 4,
        maxOccupancy: 6,
      }),
    );
    const result = searchRoomCombinations(
      candidates,
      { adults: 20, children: 20 },
      { maxWork: 100 },
    );
    expect(result.complete).toBe(true);
    expect(result.options).toHaveLength(5);
    expect(result.options.every((option) => option.selection.lines.length === 1)).toBe(true);
  });
  it("does not double count alternative rate plans or linked room types", () => {
    expect(
      searchRoomCombinations([offer("a"), offer("a", { publicOfferKey: "other" })], {
        adults: 4,
        children: 0,
      }).options,
    ).toEqual([]);
    expect(
      searchRoomCombinations(
        [offer("a", { linkedGroupId: "shared" }), offer("b", { linkedGroupId: "shared" })],
        { adults: 4, children: 0 },
      ).options,
    ).toEqual([]);
  });
  it("keeps a costlier partial option with compatible payment extensions", () => {
    const result = searchRoomCombinations(
      [
        offer("a", { priceMinor: 1n, paymentMethods: ["cash"] }),
        offer("a", { publicOfferKey: "card-rate", priceMinor: 10n, paymentMethods: ["card"] }),
        offer("b", { paymentMethods: ["card"] }),
      ],
      { adults: 4, children: 0 },
    );
    expect(result.options[0].selection.lines[0].publicOfferKey).toBe("card-rate");
    expect(result.options[0].paymentMethods).toEqual(["card"]);
  });
  it("keeps a costlier partial option with independent linked inventory", () => {
    const result = searchRoomCombinations(
      [
        offer("a", { priceMinor: 1n, linkedGroupId: "shared" }),
        offer("b", { priceMinor: 10n }),
        offer("c", { linkedGroupId: "shared" }),
      ],
      { adults: 4, children: 0 },
    );
    expect(
      result.options.some(
        (option) => option.selection.lines.map((line) => line.roomTypeId).join() === "a,b",
      ),
    ).toBe(true);
    expect(
      result.options.every(
        (option) => option.selection.lines.map((line) => line.roomTypeId).join() !== "a,c",
      ),
    ).toBe(true);
  });
  it("does not combine incompatible currency/payment or infer missing occupancy", () => {
    for (const overrides of [
      { currency: "USD" },
      { paymentMethods: [] },
      { maxAdults: NaN },
      { maxOccupancy: 0 },
    ]) {
      expect(
        searchRoomCombinations([offer("a"), offer("b", overrides)], { adults: 4, children: 0 })
          .options,
      ).toEqual([]);
    }
  });
  it("distinguishes resource exhaustion from capacity and does not truncate candidate prefixes", () => {
    const candidates = Array.from({ length: 25 }, (_, index) =>
      offer(String(index), { availableRooms: 0 }),
    );
    candidates.push(offer("z", { availableRooms: 3 }));
    expect(searchRoomCombinations(candidates, { adults: 6, children: 0 }).options).toHaveLength(1);
    expect(searchRoomCombinations(candidates, { adults: 6, children: 0 }, { maxWork: 1 })).toEqual({
      complete: false,
      options: [],
    });
  });
  it("has deterministic rankings independent of input order", () => {
    const candidates = [offer("b"), offer("a"), offer("c")];
    expect(searchRoomCombinations(candidates, { adults: 4, children: 0 })).toEqual(
      searchRoomCombinations(candidates.reverse(), { adults: 4, children: 0 }),
    );
  });
  it("matches exhaustive physical-room allocation across adult, child, and total bounds", () => {
    for (let maxAdults = 1; maxAdults <= 3; maxAdults++) {
      for (let maxChildren = 0; maxChildren <= 3; maxChildren++) {
        for (let maxOccupancy = 1; maxOccupancy <= 4; maxOccupancy++) {
          const candidate = offer("family", {
            maxAdults,
            maxChildren,
            maxOccupancy,
            availableRooms: 3,
          });
          const feasible = new Set<string>();
          let totals = [[0, 0]];
          for (let quantity = 1; quantity <= 3; quantity++) {
            const next: number[][] = [];
            for (const [a, c] of totals)
              for (let adults = 1; adults <= maxAdults; adults++) {
                for (
                  let children = 0;
                  children <= maxChildren && adults + children <= maxOccupancy;
                  children++
                ) {
                  next.push([a + adults, c + children]);
                  feasible.add(`${a + adults}:${c + children}`);
                }
              }
            totals = next;
          }
          for (let adults = 1; adults <= 7; adults++)
            for (let children = 0; children <= 7; children++) {
              const result = searchRoomCombinations([candidate], { adults, children });
              expect(result.complete).toBe(true);
              expect(
                result.options.length > 0,
                JSON.stringify({ maxAdults, maxChildren, maxOccupancy, adults, children }),
              ).toBe(feasible.has(`${adults}:${children}`));
              for (const option of result.options) {
                expect(bookingRoomLineFits(option.selection.lines[0], candidate)).toBe(true);
                expect(bookingRoomSelectionParty(option.selection)).toMatchObject({
                  adults,
                  children,
                });
              }
            }
        }
      }
    }
  });
});
