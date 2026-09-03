import { describe, expect, it } from "vitest";

import {
  PMS_CALENDAR_AUTO_OPEN_CONTRACT_VERSION,
  calculatePmsCalendarAutoOpenHorizon,
  createPmsCalendarAutoOpenSource,
  fingerprintPmsCalendarAutoOpenSource,
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

describe("PMS calendar auto-open source", () => {
  it("uses the canonical key order and VAY-1432 fingerprint", () => {
    const source = createPmsCalendarAutoOpenSource({
      settingRevision: 6,
      propertyProfileRevision: 4,
      propertyTimeZone: "Europe/Berlin",
      operatingCalendarRevision: 9,
      rooms: [{ roomTypeId: "rt_deluxe", roomFactsRevision: 2, roomUnitsRevision: 3 }],
      pricing: {
        pricingCurrencyRevision: 2,
        flexibleRatePlans: [{ roomTypeId: "rt_deluxe", flexibleRatePlanRevision: 5 }],
        optionalPricingAggregateRevision: 7,
      },
    });

    expect(JSON.stringify(source)).toBe(
      '{"contractVersion":"pms-calendar-auto-open-source.v1","settingRevision":6,"propertyProfileRevision":4,"propertyTimeZone":"Europe/Berlin","operatingCalendarRevision":9,"rooms":[{"roomTypeId":"rt_deluxe","roomFactsRevision":2,"roomUnitsRevision":3}],"pricing":{"pricingCurrencyRevision":2,"flexibleRatePlans":[{"roomTypeId":"rt_deluxe","flexibleRatePlanRevision":5}],"optionalPricingAggregateRevision":7}}',
    );
    expect(fingerprintPmsCalendarAutoOpenSource(source)).toBe(
      "613b3cff719ad4b744ecf0a049884f1115612a4b74de4ea44da07921b1e57ce5",
    );
  });

  it("sorts room-owned sources without mutating the caller", () => {
    const rooms = [
      { roomTypeId: "room-z", roomFactsRevision: 1, roomUnitsRevision: 2 },
      { roomTypeId: "room-a", roomFactsRevision: 3, roomUnitsRevision: 4 },
    ];
    const source = createPmsCalendarAutoOpenSource({
      settingRevision: 1,
      propertyProfileRevision: 1,
      propertyTimeZone: "Etc/UTC",
      operatingCalendarRevision: 1,
      rooms,
      pricing: {
        pricingCurrencyRevision: 1,
        flexibleRatePlans: [
          { roomTypeId: "room-z", flexibleRatePlanRevision: 2 },
          { roomTypeId: "room-a", flexibleRatePlanRevision: 1 },
        ],
        optionalPricingAggregateRevision: 0,
      },
    });

    expect(source.rooms.map(({ roomTypeId }) => roomTypeId)).toEqual(["room-a", "room-z"]);
    expect(source.pricing.flexibleRatePlans.map(({ roomTypeId }) => roomTypeId)).toEqual([
      "room-a",
      "room-z",
    ]);
    expect(rooms[0]?.roomTypeId).toBe("room-z");
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
