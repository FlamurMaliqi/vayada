import { describe, expect, it } from "vitest";

import { evaluateSameDayBooking } from "./sameDayBookingPolicy.js";

const policy = { enabled: true, cutoffLocalTime: "18:00" } as const;

describe("same-day booking policy", () => {
  it.each([
    ["2026-08-01T09:59:59Z", true, "before_cutoff"],
    ["2026-08-01T10:00:00Z", false, "cutoff_passed"],
    ["2026-08-01T10:30:00Z", false, "cutoff_passed"],
  ] as const)("evaluates the exact cutoff in the property timezone", (now, eligible, reason) => {
    const result = evaluateSameDayBooking({
      checkIn: "2026-08-01",
      policy,
      propertyTimeZone: "Asia/Makassar",
      now: new Date(now),
    });
    expect(result).toMatchObject({ eligible, reason });
    if (eligible) expect(result.currentLocalTime).toBe("17:59");
  });

  it("uses the property's DST offset", () => {
    const winter = evaluateSameDayBooking({
      checkIn: "2026-01-15",
      policy,
      propertyTimeZone: "Europe/Vienna",
      now: new Date("2026-01-15T17:00:00Z"),
    });
    const summer = evaluateSameDayBooking({
      checkIn: "2026-07-15",
      policy,
      propertyTimeZone: "Europe/Vienna",
      now: new Date("2026-07-15T16:00:00Z"),
    });
    expect(winter).toMatchObject({ eligible: false, currentLocalTime: "18:00" });
    expect(summer).toMatchObject({ eligible: false, currentLocalTime: "18:00" });
  });

  it("closes disabled same-day stays and allows null-cutoff or future stays", () => {
    const base = {
      propertyTimeZone: "UTC",
      now: new Date("2026-08-01T23:00:00Z"),
    };
    expect(
      evaluateSameDayBooking({
        ...base,
        checkIn: "2026-08-01",
        policy: { enabled: false, cutoffLocalTime: "18:00" },
      }).reason,
    ).toBe("same_day_disabled");
    expect(
      evaluateSameDayBooking({
        ...base,
        checkIn: "2026-08-01",
        policy: { enabled: true, cutoffLocalTime: null },
      }).eligible,
    ).toBe(true);
    expect(evaluateSameDayBooking({ ...base, checkIn: "2026-08-02", policy }).reason).toBe(
      "not_same_day",
    );
  });

  it("rejects invalid policy inputs instead of guessing a timezone", () => {
    expect(() =>
      evaluateSameDayBooking({
        checkIn: "2026-08-01",
        policy,
        propertyTimeZone: "not/a-zone",
        now: new Date("2026-08-01T00:00:00Z"),
      }),
    ).toThrow("valid IANA timezone");
    expect(() =>
      evaluateSameDayBooking({
        checkIn: "2026-08-01",
        policy: { enabled: true, cutoffLocalTime: "18:15" },
        propertyTimeZone: "UTC",
        now: new Date("2026-08-01T00:00:00Z"),
      }),
    ).toThrow("30-minute boundary");
  });
});
