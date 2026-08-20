import { Booking } from "@/services/bookings";
import type { CalendarData } from "@/services/calendar";

const DASHBOARD_BOOKING_STATUSES = new Set<Booking["status"]>([
  "confirmed",
  "checked_in",
  "in_house",
  "checked_out",
]);

const NOT_CHECKED_IN_DEPARTURE_STATUSES = new Set<Booking["status"]>(["confirmed"]);

const CHECKED_IN_STATUSES = new Set<Booking["status"]>(["checked_in", "in_house"]);
const CHECKED_OUT_STATUSES = new Set<Booking["status"]>(["checked_out"]);

export function getPropertyToday(timezone?: string | null, date = new Date()) {
  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return year && month && day ? `${year}-${month}-${day}` : date.toISOString().slice(0, 10);
}

export function addDaysToDate(date: string, days: number) {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

export function formatPropertyDate(
  date: string,
  options: Intl.DateTimeFormatOptions,
  locale = "en-US",
) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(locale, {
    ...options,
    timeZone: "UTC",
  });
}

export function isDashboardBooking(booking: Booking) {
  return DASHBOARD_BOOKING_STATUSES.has(booking.status);
}

export function isCheckedInArrival(booking: Booking) {
  return CHECKED_IN_STATUSES.has(booking.status);
}

export function isCheckedOutDeparture(booking: Booking) {
  return CHECKED_OUT_STATUSES.has(booking.status);
}

export function isNotCheckedInDeparture(booking: Booking) {
  return NOT_CHECKED_IN_DEPARTURE_STATUSES.has(booking.status);
}

export function getDashboardBookings(bookings: Booking[]) {
  return bookings.filter(isDashboardBooking);
}

export function getArrivalsToday(bookings: Booking[], today: string) {
  return getDashboardBookings(bookings)
    .filter((booking) => booking.checkIn === today)
    .sort((a, b) => {
      const aCheckedIn = isCheckedInArrival(a);
      const bCheckedIn = isCheckedInArrival(b);
      if (aCheckedIn === bCheckedIn) return 0;
      return aCheckedIn ? 1 : -1;
    });
}

export function getDeparturesToday(bookings: Booking[], today: string) {
  return getDashboardBookings(bookings)
    .filter((booking) => booking.checkOut === today)
    .sort((a, b) => {
      // Not-checked-in (most urgent) first, then checked-in, then checked-out last.
      const aNotIn = isNotCheckedInDeparture(a);
      const bNotIn = isNotCheckedInDeparture(b);
      if (aNotIn !== bNotIn) return aNotIn ? -1 : 1;
      const aCheckedOut = isCheckedOutDeparture(a);
      const bCheckedOut = isCheckedOutDeparture(b);
      if (aCheckedOut === bCheckedOut) return 0;
      return aCheckedOut ? 1 : -1;
    });
}

export function getRemainingArrivals(arrivals: Booking[]) {
  return arrivals.filter((booking) => !isCheckedInArrival(booking)).length;
}

export function getRemainingDepartures(departures: Booking[]) {
  return departures.filter((booking) => !isCheckedOutDeparture(booking)).length;
}

export function isResolvedDeparture(booking: Booking) {
  return isCheckedOutDeparture(booking);
}

export type DashboardOccupancy = {
  occupiedUnits: number;
  remainingSellableUnits: number;
  denominatorUnits: number;
  percentage: number | null;
};

export function getDashboardOccupancy(calendar: CalendarData, date: string): DashboardOccupancy {
  return (
    calendar.occupancyDays?.find((day) => day.date === date) ?? {
      occupiedUnits: 0,
      remainingSellableUnits: 0,
      denominatorUnits: 0,
      percentage: null,
    }
  );
}
