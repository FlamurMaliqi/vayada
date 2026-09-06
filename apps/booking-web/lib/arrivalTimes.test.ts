import { describe, expect, it } from "vitest";
import { formatCheckInTime, formatCheckOutTime } from "./arrivalTimes";
describe("published arrival policy display", () => {
  it("preserves single times and renders both independent ranges", () => {
    const times = { checkInTime: "15:00", checkOutTime: "11:00" };
    expect(formatCheckInTime(times)).toBe("15:00");
    expect(formatCheckOutTime(times)).toBe("11:00");
    const ranges = { ...times, checkInUntil: "23:00", checkOutFrom: "07:00" };
    expect(formatCheckInTime(ranges)).toBe("15:00–23:00");
    expect(formatCheckOutTime(ranges)).toBe("07:00–11:00");
  });
});
