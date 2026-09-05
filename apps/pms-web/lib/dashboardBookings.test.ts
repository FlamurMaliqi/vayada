import { describe, expect, it } from "vitest";

import type { Booking } from "@/services/bookings";
import {
  addPropertyDays,
  formatPropertyDate,
  getArrivalsToday,
  getDashboardOccupancy,
  getDeparturesToday,
  getPropertyToday,
} from "./dashboardBookings";

function booking(overrides: Partial<Booking> = {}): Booking {
  return {
    id: "booking-1",
    checkIn: "2026-06-24",
    checkOut: "2026-06-25",
    status: "confirmed",
    checkedInAt: null,
    ...overrides,
  } as Booking;
}

describe("dashboard booking dates", () => {
  const today = "2026-06-24";

  it("classifies arrivals and departures by their matching stay date", () => {
    const arrival = booking();
    const departure = booking({
      id: "booking-2",
      checkIn: "2026-06-23",
      checkOut: today,
    });

    expect(getArrivalsToday([arrival, departure], today)).toEqual([arrival]);
    expect(getDeparturesToday([arrival, departure], today)).toEqual([departure]);
  });

  it("includes a supported same-day stay in both lists", () => {
    const sameDay = booking({ checkOut: today });

    expect(getArrivalsToday([sameDay], today)).toEqual([sameDay]);
    expect(getDeparturesToday([sameDay], today)).toEqual([sameDay]);
  });

  it.each(["cancelled", "declined", "expired"] as const)(
    "excludes %s bookings from both lists",
    (status) => {
      const excluded = booking({ checkOut: today, status });

      expect(getArrivalsToday([excluded], today)).toEqual([]);
      expect(getDeparturesToday([excluded], today)).toEqual([]);
    },
  );

  it("keeps a confirmed arrival visible until check-in", () => {
    const confirmed = booking();
    const completed = booking({ id: "booking-2", checkedInAt: "2026-06-24T14:00:00Z" });

    expect(getArrivalsToday([confirmed, completed], today)).toEqual([confirmed]);
  });

  it.each(["checked_in", "in_house", "checked_out"] as const)(
    "removes a %s booking from arrivals after check-in completion",
    (status) => {
      expect(getArrivalsToday([booking({ status })], today)).toEqual([]);
    },
  );

  it("uses the property date at a UTC day boundary", () => {
    const instant = new Date("2026-06-24T17:34:00Z");

    expect(getPropertyToday("Europe/Berlin", instant)).toBe("2026-06-24");
    expect(getPropertyToday("Asia/Makassar", instant)).toBe("2026-06-25");
    expect(
      formatPropertyDate("2026-06-25", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
    ).toBe("Thursday, June 25, 2026");
    expect(
      formatPropertyDate(
        "2026-06-25",
        { weekday: "long", month: "long", day: "numeric", year: "numeric" },
        "de",
      ),
    ).toBe("Donnerstag, 25. Juni 2026");
  });

  it("builds date-only forecast windows without the viewer timezone", () => {
    expect(addPropertyDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addPropertyDays("2026-03-29", 13)).toBe("2026-04-11");
  });
});

describe("dashboard occupancy", () => {
  const date = "2026-08-21";
  const inventoryDay = (occupiedCount: number, availableCount: number) => ({
    stayDate: date,
    occupiedCount,
    availableCount,
  });

  it("uses occupied assignments plus available units as the sellable denominator", () => {
    expect(getDashboardOccupancy([inventoryDay(1, 0), inventoryDay(1, 1)], date)).toEqual({
      occupiedUnits: 2,
      sellableUnits: 3,
      percentage: 67,
    });
  });

  it("does not treat an inventory hold without an eligible assignment as occupied", () => {
    expect(getDashboardOccupancy([inventoryDay(0, 1)], date)).toEqual({
      occupiedUnits: 0,
      sellableUnits: 1,
      percentage: 0,
    });
  });

  it("keeps occupied units in a closed or reduced-inventory night", () => {
    expect(getDashboardOccupancy([inventoryDay(2, 0)], date)).toEqual({
      occupiedUnits: 2,
      sellableUnits: 2,
      percentage: 100,
    });
  });

  it("renders a night without occupied or sellable units as unavailable", () => {
    expect(getDashboardOccupancy([inventoryDay(0, 0)], date)).toEqual({
      occupiedUnits: 0,
      sellableUnits: 0,
      percentage: null,
    });
  });
});
