import { describe, expect, it } from "vitest";
import {
  collaborationToday,
  collaborationDateError,
  collaborationAvailabilityError,
} from "./collaborationDates.js";

describe("property-local collaboration dates", () => {
  it("uses the property day across midnight and DST, independent of the browser", () => {
    const now = new Date("2026-03-08T07:30:00Z");
    expect(collaborationToday("America/Los_Angeles", now)).toBe("2026-03-07");
    expect(collaborationToday("Asia/Taipei", now)).toBe("2026-03-08");
    expect(collaborationToday("America/New_York", now)).toBe("2026-03-08");
    expect(collaborationToday(null, now)).toBeNull();
    expect(collaborationToday("invalid", now)).toBeNull();
  });
  it("rejects either past date, reversed/malformed ranges, and missing dates", () => {
    const today = "2026-06-30";
    for (const [from, to] of [
      ["2026-02-01", "2026-07-02"],
      ["2026-07-02", "2026-02-01"],
    ]) {
      expect(collaborationDateError(from, to, today)).toBe(
        "Collaboration dates cannot be in the past.",
      );
    }
    for (const [from, to] of [
      ["2026-07-03", "2026-07-02"],
      ["2026-07-03", "2026-07-03"],
      ["2026-06-31", "2026-07-02"],
      ["", ""],
    ]) {
      expect(collaborationDateError(from, to, today)).not.toBeNull();
    }
    expect(collaborationDateError(today, "2026-07-01", today)).toBeNull();
    expect(collaborationDateError("2026-07-01", "2026-07-02", today)).toBeNull();
    expect(collaborationDateError(today, "2026-07-01", null)).toContain("timezone");
  });
  it("blocks options with only past months, allowing current and upcoming availability", () => {
    expect(collaborationAvailabilityError(["February", "Mar"], "2026-06-30")).toContain(
      "no remaining availability",
    );
    expect(collaborationAvailabilityError(["June"], "2026-06-30")).toBeNull();
    expect(collaborationAvailabilityError(["Jan", "Jul"], "2026-06-30")).toBeNull();
    expect(collaborationAvailabilityError([], "2026-06-30")).toBeNull();
  });
});
