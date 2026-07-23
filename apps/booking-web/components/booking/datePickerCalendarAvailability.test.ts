import { describe, expect, it } from "vitest";

import { calendarDatesInRange } from "./datePickerCalendarAvailability";

describe("calendarDatesInRange", () => {
  it("enumerates every visible date and excludes the range end", () => {
    expect(calendarDatesInRange("2028-02-28", "2028-03-02")).toEqual([
      "2028-02-28",
      "2028-02-29",
      "2028-03-01",
    ]);
  });

  it("returns no dates for an empty or reversed range", () => {
    expect(calendarDatesInRange("2028-03-02", "2028-03-02")).toEqual([]);
    expect(calendarDatesInRange("2028-03-03", "2028-03-02")).toEqual([]);
  });
});
