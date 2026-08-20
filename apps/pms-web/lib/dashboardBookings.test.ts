import { describe, expect, it } from "vitest";

import type { CalendarData } from "@/services/calendar";
import {
  addDaysToDate,
  formatPropertyDate,
  getDashboardOccupancy,
  getPropertyToday,
} from "./dashboardBookings";

function calendar(overrides: Partial<CalendarData> = {}): CalendarData {
  return {
    roomTypes: [],
    rooms: [],
    bookings: [],
    blocks: [],
    occupancyDays: [],
    ...overrides,
  };
}

describe("dashboard occupancy", () => {
  it("reads the backend projection used by both the card and graph", () => {
    const data = calendar({
      occupancyDays: [
        {
          date: "2026-06-25",
          occupiedUnits: 2,
          remainingSellableUnits: 1,
          denominatorUnits: 3,
          percentage: 67,
        },
      ],
    });

    expect(getDashboardOccupancy(data, "2026-06-25")).toEqual(data.occupancyDays?.[0]);
    expect(getDashboardOccupancy(data, "2026-06-26")).toEqual({
      occupiedUnits: 0,
      remainingSellableUnits: 0,
      denominatorUnits: 0,
      percentage: null,
    });
    expect(getDashboardOccupancy({ ...data, occupancyDays: undefined }, "2026-06-25")).toEqual({
      occupiedUnits: 0,
      remainingSellableUnits: 0,
      denominatorUnits: 0,
      percentage: null,
    });
  });
});

describe("dashboard property dates", () => {
  it("uses the property's day at a UTC boundary and advances date-only values", () => {
    const instant = new Date("2026-06-24T17:34:00Z");

    expect(getPropertyToday("Europe/Berlin", instant)).toBe("2026-06-24");
    expect(getPropertyToday("Asia/Makassar", instant)).toBe("2026-06-25");
    expect(addDaysToDate("2026-06-25", 13)).toBe("2026-07-08");
    expect(
      formatPropertyDate("2026-06-25", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    ).toBe("Thursday, June 25, 2026");
  });
});
