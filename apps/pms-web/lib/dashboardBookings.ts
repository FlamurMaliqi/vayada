import { Booking } from "@/services/bookings";

const DASHBOARD_BOOKING_STATUSES = new Set<Booking["status"]>([
  "confirmed",
  "checked_in",
  "in_house",
  "checked_out",
]);

const NOT_CHECKED_IN_DEPARTURE_STATUSES = new Set<Booking["status"]>(["confirmed"]);

const CHECKED_IN_STATUSES = new Set<Booking["status"]>(["checked_in", "in_house", "checked_out"]);
const CHECKED_OUT_STATUSES = new Set<Booking["status"]>(["checked_out"]);

export type DashboardInventoryDay = {
  stayDate: string;
  availableCount: number;
  occupiedCount: number;
};

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

export function formatPropertyDate(date: string, options: Intl.DateTimeFormatOptions) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    ...options,
    timeZone: "UTC",
  });
}

export function addPropertyDays(date: string, days: number) {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return date;
  return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

export function isDashboardBooking(booking: Booking) {
  return DASHBOARD_BOOKING_STATUSES.has(booking.status);
}

export function isCheckedInArrival(booking: Booking) {
  return Boolean(booking.checkedInAt) || CHECKED_IN_STATUSES.has(booking.status);
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
  return getDashboardBookings(bookings).filter(
    (booking) => booking.checkIn === today && !isCheckedInArrival(booking),
  );
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

export function getDashboardOccupancy(days: DashboardInventoryDay[], date: string) {
  const matchingDays = days.filter((day) => day.stayDate === date);
  const occupiedUnits = matchingDays.reduce((sum, day) => sum + day.occupiedCount, 0);
  const sellableUnits = matchingDays.reduce((sum, day) => sum + day.availableCount, occupiedUnits);

  return {
    occupiedUnits,
    sellableUnits,
    percentage: sellableUnits > 0 ? Math.round((occupiedUnits / sellableUnits) * 100) : null,
  };
}
