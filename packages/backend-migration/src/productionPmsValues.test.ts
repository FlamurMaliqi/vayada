import { describe, expect, it } from "vitest";

import {
  dates,
  horizon,
  jsonArray,
  jsonMap,
  recurringDateRanges,
} from "./productionPmsValues.js";

describe("production PMS values", () => {
  it("builds the exact 366-day migration horizon", () => {
    const bounded = horizon("2026-08-30T01:00:00Z");
    expect(bounded).toEqual({ from: "2026-08-30", through: "2027-08-30" });
    expect(dates(bounded.from, bounded.through)).toHaveLength(366);
  });

  it("parses legacy JSON without accepting the wrong shape", () => {
    expect(jsonArray('["wifi"]', "amenities")).toEqual(["wifi"]);
    expect(jsonMap('{"2026-09-01":120}', "daily_rates")).toEqual({
      "2026-09-01": 120,
    });
    expect(() => jsonArray("{}", "amenities")).toThrow("JSON array");
  });

  it("expands recurring cross-year ranges only inside the migration horizon", () => {
    expect(
      recurringDateRanges("11-01", "02-28", {
        from: "2026-08-30",
        through: "2027-08-30",
      }),
    ).toEqual([{ startsOn: "2026-11-01", endsOn: "2027-02-28" }]);
  });
});
