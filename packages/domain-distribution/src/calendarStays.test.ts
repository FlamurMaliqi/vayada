import { describe, expect, it } from "vitest";
import { calendarStays, type CalendarStayDay } from "./calendarStays.js";

const offer = (key: string, min = 1, max: number | null = null) => ({ key, min, max });
const day = (date: number, offers: CalendarStayDay["offers"], hasAvailability = true) => ({
  stayDate: `2028-03-${String(date).padStart(2, "0")}`,
  offers,
  hasAvailability,
});

describe("calendar stay guidance", () => {
  it("keeps gaps when short and long rates have different coverage", () => {
    const result = calendarStays(
      [
        day(1, [offer("short", 1), offer("long", 3)]),
        day(2, [offer("long", 3)]),
        day(3, [offer("long", 3)]),
      ],
      "2028-03-04",
    );
    expect(result.validCheckOutsByArrival["2028-03-01"]).toEqual(["2028-03-02", "2028-03-04"]);
    expect(result.minStayByArrival["2028-03-01"]).toBe(1);
    expect(result.validCheckOutsByArrival["2028-03-02"]).toEqual([]);
    expect(result.minStayByArrival["2028-03-02"]).toBe(3);
  });

  it("ignores a shorter arrival rule when that rate cannot cover its minimum stay", () => {
    const result = calendarStays(
      [
        day(1, [offer("short", 2), offer("long", 3)]),
        day(2, [offer("long", 3)]),
        day(3, [offer("long", 3)]),
      ],
      "2028-03-04",
    );
    expect(result.minStayByArrival["2028-03-01"]).toBe(3);
    expect(result.validCheckOutsByArrival["2028-03-01"]).toEqual(["2028-03-04"]);
  });

  it("does not stitch different offers together across nights", () => {
    const result = calendarStays([day(1, [offer("A", 2)]), day(2, [offer("B")])], "2028-03-03");
    expect(result.validCheckOutsByArrival["2028-03-01"]).toEqual([]);
  });

  it("applies seasonal restrictions at arrival, including maximum stays", () => {
    const result = calendarStays(
      [
        day(1, [offer("A", 2, 2)]),
        day(2, [offer("A", 3)]),
        day(3, [offer("A")]),
        day(4, [offer("A")]),
      ],
      "2028-03-05",
    );
    expect(result.validCheckOutsByArrival["2028-03-01"]).toEqual(["2028-03-03"]);
    expect(result.validCheckOutsByArrival["2028-03-02"]).toEqual(["2028-03-05"]);
  });

  it("allows checkout on a sold-out night but never crosses unavailable or missing nights", () => {
    const result = calendarStays(
      [day(1, [offer("A", 2)]), day(2, [offer("A")]), day(3, [], false), day(5, [offer("A", 2)])],
      "2028-03-07",
    );
    expect(result.validCheckOutsByArrival["2028-03-01"]).toEqual(["2028-03-03"]);
    expect(result.validCheckOutsByArrival["2028-03-03"]).toEqual([]);
    expect(result.validCheckOutsByArrival["2028-03-05"]).toEqual([]);
  });
});
