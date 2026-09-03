import { describe, expect, it } from "vitest";

import {
  PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
  calculatePmsCalendarAutoOpenHorizon,
  type PmsCalendarAutoOpenSetting,
} from "./calendarAutoOpen.js";

describe("PMS calendar auto-open horizon", () => {
  it("uses the property-local month and returns its rolling far edge", () => {
    expect(
      calculatePmsCalendarAutoOpenHorizon(
        setting({ rollingMonths: 18 }),
        "Asia/Taipei",
        new Date("2026-08-31T16:30:00.000Z"),
      ),
    ).toEqual({
      propertyTimeZone: "Asia/Taipei",
      propertyLocalDate: "2026-09-01",
      targetOpenThrough: "2028-03-31",
    });
  });

  it("honors leap years and keeps disabled targets null", () => {
    expect(
      calculatePmsCalendarAutoOpenHorizon(
        setting({ rollingMonths: 12 }),
        "UTC",
        new Date("2027-02-10T12:00:00.000Z"),
      ).targetOpenThrough,
    ).toBe("2028-02-29");
    expect(
      calculatePmsCalendarAutoOpenHorizon(
        setting({ enabled: false }),
        "UTC",
        new Date("2027-02-10T12:00:00.000Z"),
      ).targetOpenThrough,
    ).toBeNull();
  });
});

function setting(overrides: Partial<PmsCalendarAutoOpenSetting>): PmsCalendarAutoOpenSetting {
  return {
    contractVersion: PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
    propertyId: "14340000-0000-4000-8000-000000000001",
    revision: 1,
    enabled: true,
    mode: "rolling",
    rollingMonths: 18,
    fixedEndMonth: null,
    updatedAt: "2026-09-03T08:00:00.000Z",
    ...overrides,
  };
}
