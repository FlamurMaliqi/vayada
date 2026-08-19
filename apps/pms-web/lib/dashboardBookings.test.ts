import { describe, expect, it } from "vitest";

import type { Booking } from "@/services/bookings";
import {
  formatPropertyDate,
  getArrivalsToday,
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
  });
});
