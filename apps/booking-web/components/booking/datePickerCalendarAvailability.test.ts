import { describe, expect, it } from "vitest";

import {
  calendarDatesInRange,
  replaceRestrictionsForDates,
} from "./datePickerCalendarAvailability";

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

describe("replaceRestrictionsForDates", () => {
  it("removes stale restrictions in the refreshed range before merging new values", () => {
    expect(
      replaceRestrictionsForDates(
        {
          "2028-03-01": 3,
          "2028-03-02": 4,
          "2028-04-10": 5,
        },
        ["2028-03-01", "2028-03-02"],
        { "2028-03-02": 2 },
      ),
    ).toEqual({
      "2028-03-02": 2,
      "2028-04-10": 5,
    });
  });

  it("preserves the restriction for a selected arrival outside the refreshed range", () => {
    expect(
      replaceRestrictionsForDates({ "2028-02-28": 3, "2028-03-01": 4 }, ["2028-03-01"], {}),
    ).toEqual({ "2028-02-28": 3 });
  });
});
