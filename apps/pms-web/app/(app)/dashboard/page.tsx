"use client";

import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { roomsService, RoomType } from "@/services/rooms";
import { bookingsService, Booking, BookingAdditionalGuest, BookingNote } from "@/services/bookings";
import { pmsSettingsService } from "@/services/settings";
import { formatCurrency } from "@/lib/formatCurrency";
import {
  formatPropertyDate,
  getArrivalsToday,
  getDeparturesToday,
  getOccupiedTonight,
  getPropertyToday,
  getRemainingArrivals,
  getRemainingDepartures,
  isCheckedOutDeparture,
  isNotCheckedInDeparture,
} from "@/lib/dashboardBookings";
import { useTranslation } from "@/lib/i18n";
import { pmsSetupExitPropertyId } from "@vayada/product-onboarding";

const AVATAR_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-orange-500",
  "bg-pink-500",
  "bg-teal-500",
  "bg-rose-500",
  "bg-amber-500",
];

function getAvatarColor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(first: string, last: string) {
  return `${first[0] || ""}${last[0] || ""}`.toUpperCase();
}

function guestName(b: Booking) {
  return `${b.guestFirstName} ${b.guestLastName}`.trim();
}

function roomLabel(b: Booking) {
  const assigned = b.assignedRooms?.length
    ? b.assignedRooms
        .map((r) => (r.roomNumber ? `${b.roomName} ${r.roomNumber}` : b.roomName))
        .join(", ")
    : b.roomNumber
      ? `${b.roomName} ${b.roomNumber}`
      : b.roomName;
  return assigned || "Unassigned";
}

function arrivalTime(b: Booking) {
  return b.estimatedArrivalTime || "3:00 PM";
}

function checkoutTime() {
  return "12:00";
}

function isPaid(b: Booking) {
  return ["captured", "paid", "refunded", "partially_refunded"].includes(b.paymentStatus || "");
}

function expectedAdditionalGuests(b: Booking) {
  const explicit = b.numberOfGuests ?? b.adults + b.children;
  return Math.max(0, explicit - 1);
}

function incompleteGuestCount(b: Booking, guests: BookingAdditionalGuest[]) {
  const placeholders = Math.max(0, expectedAdditionalGuests(b) - guests.length);
  return (
    guests.filter(
      (g) =>
        !g.firstName ||
        !g.lastName ||
        !g.gender ||
        !g.nationality ||
        !g.dateOfBirth ||
        !g.passportNumber,
    ).length + placeholders
  );
}

const FORECAST_WINDOW_DAYS = 14;
const FORECAST_MAX_WEEK_OFFSET = 24;

export default function DashboardPage() {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<RoomType[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [hotelCurrency, setHotelCurrency] = useState("EUR");
  const [hotelTimezone, setHotelTimezone] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [incompleteSetupPropertyId, setIncompleteSetupPropertyId] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [quickView, setQuickView] = useState<{
    booking: Booking;
    guests: BookingAdditionalGuest[];
    notes: BookingNote[];
    loading: boolean;
    mode: "arrival" | "departure";
  } | null>(null);

  const today = getPropertyToday(hotelTimezone);

  useEffect(() => {
    setIncompleteSetupPropertyId(
      pmsSetupExitPropertyId(`${window.location.pathname}${window.location.search}`),
    );
  }, []);

  useEffect(() => {
    Promise.all([
      roomsService.list(),
      bookingsService.listAll(),
      bookingsService.getPaymentSettings(),
      pmsSettingsService.getHotelDetails().catch(() => null),
    ])
      .then(([roomsList, bookingsList, settingsRes, hotelRes]) => {
        setRooms(roomsList);
        setBookings(bookingsList);
        setHotelCurrency(settingsRes.paymentSettings.defaultCurrency || "EUR");
        setHotelTimezone(hotelRes?.timezone || null);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const totalRooms = useMemo(() => rooms.reduce((sum, r) => sum + r.totalRooms, 0), [rooms]);

  const arrivalsToday = useMemo(() => getArrivalsToday(bookings, today), [bookings, today]);

  const departuresToday = useMemo(() => getDeparturesToday(bookings, today), [bookings, today]);

  const remainingArrivals = useMemo(() => getRemainingArrivals(arrivalsToday), [arrivalsToday]);
  const remainingDepartures = useMemo(
    () => getRemainingDepartures(departuresToday),
    [departuresToday],
  );

  const occupiedTonight = useMemo(() => getOccupiedTonight(bookings, today), [bookings, today]);

  const occupancyPct = totalRooms > 0 ? Math.round((occupiedTonight / totalRooms) * 100) : 0;

  const openQuickView = (booking: Booking, mode: "arrival" | "departure") => {
    setQuickView({ booking, guests: [], notes: [], loading: true, mode });
    Promise.all([
      bookingsService.listAdditionalGuests(booking.id).catch(() => ({ guests: [] })),
      bookingsService.listNotes(booking.id).catch(() => ({ notes: [] })),
    ])
      .then(([guestRes, noteRes]) =>
        setQuickView((current) =>
          current?.booking.id === booking.id
            ? { booking, guests: guestRes.guests, notes: noteRes.notes, loading: false, mode }
            : current,
        ),
      )
      .catch(() =>
        setQuickView((current) =>
          current?.booking.id === booking.id
            ? { booking, guests: [], notes: [], loading: false, mode }
            : current,
        ),
      );
  };

  const handleNoShow = async (bookingId: string) => {
    await bookingsService.markNoShow(bookingId);
    setBookings((prev) => prev.filter((b) => b.id !== bookingId));
    setQuickView(null);
  };

  const monthStartStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  }, []);

  const revenueThisMonth = useMemo(
    () =>
      bookings.filter((b) => b.checkIn >= monthStartStr).reduce((sum, b) => sum + b.totalAmount, 0),
    [bookings, monthStartStr],
  );

  const forecastDays = useMemo(() => {
    const days = [];
    const startOffset = weekOffset * 7;
    for (let i = 0; i < FORECAST_WINDOW_DAYS; i++) {
      const date = new Date();
      date.setDate(date.getDate() + startOffset + i);
      const dateStr = date.toISOString().split("T")[0];
      const occupying = bookings.filter((b) => b.checkIn <= dateStr && b.checkOut > dateStr);
      const occupied = occupying.length;
      const pct = totalRooms > 0 ? Math.round((occupied / totalRooms) * 100) : 0;
      const adr =
        occupying.length > 0
          ? occupying.reduce((sum, b) => sum + (b.nightlyRate || 0), 0) / occupying.length
          : null;
      days.push({
        date,
        dateStr,
        pct,
        adr,
        label:
          dateStr === today
            ? t("common.today")
            : date.toLocaleDateString("en-US", { weekday: "short" }),
        dayNum: date.getDate(),
      });
    }
    return days;
  }, [bookings, totalRooms, weekOffset, today, t]);

  if (loading) {
    return (
      <div className="p-4 md:p-6">
        <div className="animate-pulse space-y-4 md:space-y-5">
          <div className="h-8 bg-gray-200 rounded w-40" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-24 md:h-28 bg-gray-200 rounded-xl" />
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
            <div className="h-56 bg-gray-200 rounded-xl" />
            <div className="h-56 bg-gray-200 rounded-xl" />
          </div>
          <div className="h-52 bg-gray-200 rounded-xl" />
        </div>
      </div>
    );
  }

  const dateLabel = formatPropertyDate(today, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5 overflow-x-hidden">
      {incompleteSetupPropertyId && (
        <div
          className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <p>Your property setup isn&apos;t complete. Your progress is saved.</p>
          <Link
            href={`/setup?entryProduct=pms&returnTo=%2Fdashboard&propertyId=${encodeURIComponent(incompleteSetupPropertyId)}`}
            className="shrink-0 font-semibold text-amber-950 underline decoration-amber-400 underline-offset-4 hover:decoration-amber-700"
          >
            Resume setup
          </Link>
        </div>
      )}
      {/* Title */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-xl font-bold text-gray-900">{t("dashboard.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{dateLabel}</p>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={t("dashboard.occupancyTonight")}
          value={`${occupancyPct}%`}
          sub={t("dashboard.occupancySub", {
            occupied: String(occupiedTonight),
            total: String(totalRooms),
          })}
          icon={<OccupancyIcon />}
        />
        <StatCard
          label={t("dashboard.arrivalsToday")}
          value={String(arrivalsToday.length)}
          sub={
            arrivalsToday.length > 0
              ? t("dashboard.arrivalsRemaining", {
                  total: String(arrivalsToday.length),
                  remaining: String(remainingArrivals),
                })
              : t("dashboard.noArrivals")
          }
          icon={<ArrowDownIcon />}
        />
        <StatCard
          label={t("dashboard.departuresToday")}
          value={String(departuresToday.length)}
          sub={
            departuresToday.length > 0
              ? `${departuresToday.length} departures · ${remainingDepartures} remaining`
              : t("dashboard.noDepartures")
          }
          icon={<ArrowUpIcon />}
        />
        <StatCard
          label={t("dashboard.revenueThisMonth")}
          value={formatCurrency(revenueThisMonth, hotelCurrency)}
          sub={t("dashboard.monthToDate")}
          icon={<DollarIcon />}
        />
      </div>

      {/* Arrivals & Departures */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Arrivals */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">
                {t("dashboard.arrivalsToday")}
              </span>
              <span className="inline-flex items-center justify-center w-5 h-5 text-[11px] font-semibold bg-blue-100 text-blue-700 rounded-full">
                {arrivalsToday.length}
              </span>
            </div>
            <Link
              href="/bookings"
              className="shrink-0 text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
            >
              {t("dashboard.viewAll")} ↗
            </Link>
          </div>
          {arrivalsToday.length > 0 && (
            <p className="mb-2 text-xs text-gray-500">
              {t("dashboard.arrivalsRemaining", {
                total: String(arrivalsToday.length),
                remaining: String(remainingArrivals),
              })}
            </p>
          )}
          {arrivalsToday.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">{t("dashboard.noArrivals")}</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {arrivalsToday.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => openQuickView(b, "arrival")}
                  className="w-full flex items-center gap-3 py-2.5 text-left rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <Avatar first={b.guestFirstName} last={b.guestLastName} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{guestName(b)}</p>
                    <p className="text-xs text-gray-400 truncate">
                      <span className="text-gray-500">{arrivalTime(b)}</span> ·{" "}
                      <span className="text-gray-500">{roomLabel(b)}</span>
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
                    {t("dashboard.confirmed")}
                  </span>
                </button>
              ))}
              <p className="pt-3 text-xs font-medium text-gray-500">
                {t("dashboard.clickGuestToStartCheckIn")}
              </p>
            </div>
          )}
        </div>

        {/* Departures */}
        <div className="bg-white border border-gray-200 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">
                {t("dashboard.departuresToday")}
              </span>
              <span className="inline-flex items-center justify-center w-5 h-5 text-[11px] font-semibold bg-blue-100 text-blue-700 rounded-full">
                {departuresToday.length}
              </span>
            </div>
            <Link
              href="/bookings"
              className="shrink-0 text-xs text-blue-600 hover:text-blue-700 font-medium whitespace-nowrap"
            >
              {t("dashboard.viewAll")} ↗
            </Link>
          </div>
          {departuresToday.length === 0 ? (
            <p className="text-sm text-gray-400 py-6 text-center">{t("dashboard.noDepartures")}</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {departuresToday.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => openQuickView(b, "departure")}
                  className="w-full flex items-center gap-3 py-2.5 text-left rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <Avatar first={b.guestFirstName} last={b.guestLastName} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {b.guestFirstName} {b.guestLastName}
                    </p>
                    <p className="text-xs text-gray-400 truncate">
                      <span className="text-gray-500">Check-out by {checkoutTime()}</span> ·{" "}
                      <span className="text-gray-500">{roomLabel(b)}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!isPaid(b) && (
                      <span className="hidden rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 sm:inline-flex">
                        {formatCurrency(b.balanceAmount || b.totalAmount, b.currency)} pending
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        isCheckedOutDeparture(b)
                          ? "bg-slate-100 text-slate-700"
                          : isNotCheckedInDeparture(b)
                            ? "bg-amber-100 text-amber-800"
                            : "bg-sky-100 text-sky-700"
                      }`}
                    >
                      {isCheckedOutDeparture(b)
                        ? "Checked out"
                        : isNotCheckedInDeparture(b)
                          ? "Not checked in"
                          : "Checked in"}
                    </span>
                    <span className="text-gray-300">›</span>
                  </div>
                </button>
              ))}
              <p className="pt-3 text-xs font-medium text-gray-500">
                Click a guest to start check-out.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Occupancy Forecast */}
      <div className="bg-white border border-gray-200 rounded-xl p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900">
              {t("dashboard.occupancyForecast")}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {weekOffset === 0
                ? t("dashboard.next14Days")
                : t("dashboard.forecastWeeksAhead", { weeks: String(weekOffset) })}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {forecastDays.length >= 14 && (
              <p className="text-xs text-gray-400 hidden sm:block">
                {forecastDays[0].date.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}{" "}
                –{" "}
                {forecastDays[13].date.toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </p>
            )}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setWeekOffset((o) => Math.max(0, o - 1))}
                disabled={weekOffset === 0}
                aria-label={t("dashboard.forecastPrevWeek")}
                className="w-7 h-7 flex items-center justify-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <ChevronLeftIcon />
              </button>
              {weekOffset > 0 && (
                <button
                  type="button"
                  onClick={() => setWeekOffset(0)}
                  className="px-2 h-7 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {t("dashboard.forecastJumpToday")}
                </button>
              )}
              <button
                type="button"
                onClick={() => setWeekOffset((o) => Math.min(FORECAST_MAX_WEEK_OFFSET, o + 1))}
                disabled={weekOffset >= FORECAST_MAX_WEEK_OFFSET}
                aria-label={t("dashboard.forecastNextWeek")}
                className="w-7 h-7 flex items-center justify-center rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <ChevronRightIcon />
              </button>
            </div>
          </div>
        </div>
        <ForecastChart days={forecastDays} today={today} currency={hotelCurrency} t={t} />
      </div>

      {quickView && (
        <ArrivalQuickView
          booking={quickView.booking}
          guests={quickView.guests}
          notes={quickView.notes}
          loading={quickView.loading}
          mode={quickView.mode}
          onClose={() => setQuickView(null)}
          onNoShow={handleNoShow}
        />
      )}
    </div>
  );
}

/* ── Sub-components ── */

function ArrivalQuickView({
  booking,
  guests,
  notes,
  loading,
  mode,
  onClose,
  onNoShow,
}: {
  booking: Booking;
  guests: BookingAdditionalGuest[];
  notes: BookingNote[];
  loading: boolean;
  mode: "arrival" | "departure";
  onClose: () => void;
  onNoShow?: (bookingId: string) => Promise<void>;
}) {
  const [noShowLoading, setNoShowLoading] = useState(false);
  const [noShowError, setNoShowError] = useState<string | null>(null);
  const missingIds = loading ? 0 : incompleteGuestCount(booking, guests);
  const due = isPaid(booking) ? 0 : booking.totalAmount;
  const internalNotes = notes.filter((note) => note.body.trim().length > 0);
  const isDeparture = mode === "departure";
  const isNotCheckedIn = isDeparture && isNotCheckedInDeparture(booking);
  const isCheckedOut = booking.status === "checked_out";

  async function handleNoShow() {
    if (!onNoShow) return;
    setNoShowLoading(true);
    setNoShowError(null);
    try {
      await onNoShow(booking.id);
    } catch {
      setNoShowError("Failed to mark as no-show. Please try again.");
    } finally {
      setNoShowLoading(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-gray-950/30 md:items-center"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <aside
        className="w-full max-h-[92dvh] overflow-y-auto rounded-t-2xl bg-white shadow-2xl md:w-[420px] md:max-h-[90dvh] md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-start justify-between gap-4 border-b border-gray-100 bg-white p-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">
              {isDeparture ? "Departure quick view" : "Arrival quick view"}
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold text-gray-950">
              {guestName(booking)}
            </h2>
            <p className="text-sm text-gray-500">{booking.bookingReference}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 p-5">
          {isNotCheckedIn && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              This guest hasn&apos;t been checked in yet. Check them in to proceed with check-out,
              or mark as a no-show if the guest didn&apos;t arrive.
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                isNotCheckedIn
                  ? "bg-amber-100 text-amber-800"
                  : isCheckedOut
                    ? "bg-gray-100 text-gray-600"
                    : isDeparture
                      ? "bg-green-100 text-green-700"
                      : "bg-blue-100 text-blue-700"
              }`}
            >
              {isNotCheckedIn
                ? "Not checked in"
                : isCheckedOut
                  ? "Checked out"
                  : isDeparture
                    ? "Checked in"
                    : "Arriving today"}
            </span>
            {due > 0 && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                {formatCurrency(due, booking.currency)} due
              </span>
            )}
            {missingIds > 0 && (
              <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-800">
                {missingIds} guest{missingIds === 1 ? "" : "s"} ID missing
              </span>
            )}
          </div>

          <dl className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm">
            <div>
              <dt className="text-xs font-medium text-gray-500">Room</dt>
              <dd className="mt-0.5 font-semibold text-gray-900">{roomLabel(booking)}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500">
                {isDeparture ? "Check-out" : "Arrival"}
              </dt>
              <dd className="mt-0.5 font-semibold text-gray-900">
                Today · {isDeparture ? `by ${checkoutTime()}` : arrivalTime(booking)} ·{" "}
                {booking.nights} night
                {booking.nights === 1 ? "" : "s"} ·{" "}
                {(booking.numberOfGuests ?? booking.adults + booking.children) || 1} guest
                {(booking.numberOfGuests ?? booking.adults + booking.children) === 1 ? "" : "s"}
              </dd>
            </div>
          </dl>

          {isDeparture && internalNotes.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Internal note
              </p>
              <p className="mt-1 text-sm text-gray-800">{internalNotes[0].body}</p>
            </div>
          )}

          {!isDeparture && booking.specialRequests && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                Special request
              </p>
              <p className="mt-1 text-sm text-amber-950">{booking.specialRequests}</p>
            </div>
          )}

          <div className="grid gap-2">
            {isNotCheckedIn ? (
              <>
                {noShowError && (
                  <p className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                    {noShowError}
                  </p>
                )}
                <Link
                  href={`/check-in/${booking.id}?next=checkout`}
                  className="flex h-11 items-center justify-center rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700"
                >
                  Check in now
                </Link>
                <button
                  type="button"
                  onClick={handleNoShow}
                  disabled={noShowLoading}
                  className="flex h-11 items-center justify-center rounded-lg border border-red-200 px-4 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
                >
                  {noShowLoading ? "Marking…" : "Mark as no-show"}
                </button>
              </>
            ) : (
              <Link
                href={isDeparture ? `/check-out/${booking.id}` : `/check-in/${booking.id}`}
                className="flex h-11 items-center justify-center rounded-lg bg-primary-600 px-4 text-sm font-semibold text-white hover:bg-primary-700"
              >
                {isDeparture ? "Start check-out" : "Start check-in"}
              </Link>
            )}
            <Link
              href={`/bookings/${booking.id}`}
              className="flex h-11 items-center justify-center rounded-lg border border-gray-200 px-4 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              View full booking
            </Link>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3 md:p-4">
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-[11px] md:text-xs text-gray-500 leading-tight">{label}</p>
        <div className="w-7 h-7 bg-blue-50 rounded-lg flex items-center justify-center text-blue-500 shrink-0">
          {icon}
        </div>
      </div>
      <p className="text-xl md:text-2xl font-bold text-gray-900 leading-none mb-1.5 truncate">
        {value}
      </p>
      <p className="text-[11px] md:text-xs text-gray-400 leading-tight line-clamp-2">{sub}</p>
    </div>
  );
}

function Avatar({ first, last }: { first: string; last: string }) {
  const color = getAvatarColor(first + last);
  const initials = getInitials(first, last);
  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0 ${color}`}
    >
      {initials}
    </div>
  );
}

type ForecastDay = {
  date: Date;
  dateStr: string;
  pct: number;
  adr: number | null;
  label: string;
  dayNum: number;
};

const HIGH_OCCUPANCY_THRESHOLD = 70;

function occupancyBarClass(pct: number): string {
  return pct >= HIGH_OCCUPANCY_THRESHOLD ? "bg-blue-600" : "bg-blue-300";
}

function formatAdrTick(amount: number, currency: string): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) {
    const prefix = formatCurrency(0, currency).slice(0, -1);
    const v = amount / 1_000_000;
    return `${prefix}${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  if (abs >= 10_000) {
    const prefix = formatCurrency(0, currency).slice(0, -1);
    const v = amount / 1_000;
    return `${prefix}${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}K`;
  }
  return formatCurrency(Math.round(amount), currency);
}

function niceAdrMax(rawMax: number): number {
  if (rawMax <= 0) return 100;
  const exponent = Math.floor(Math.log10(rawMax));
  const base = Math.pow(10, exponent);
  const normalized = rawMax / base;
  let niceNorm: number;
  if (normalized <= 1) niceNorm = 1;
  else if (normalized <= 2) niceNorm = 2;
  else if (normalized <= 4) niceNorm = 4;
  else if (normalized <= 5) niceNorm = 5;
  else niceNorm = 10;
  return niceNorm * base;
}

function ForecastChart({
  days,
  today,
  currency,
  t,
}: {
  days: ForecastDay[];
  today: string;
  currency: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const chartHeight = 140;
  const occupancyTicks = [100, 75, 50, 25, 0];

  const rawAdrMax = days.reduce((max, d) => (d.adr != null && d.adr > max ? d.adr : max), 0);
  const adrMax = niceAdrMax(rawAdrMax);
  const hasAdr = days.some((d) => d.adr != null);
  const adrTicks = [adrMax, adrMax * 0.75, adrMax * 0.5, adrMax * 0.25, 0];

  // Build line segments — break the polyline where adr is null so the line gaps over empty days.
  const linePoints = days.map((day, idx) => {
    if (day.adr == null) return null;
    const xPct = ((idx + 0.5) / days.length) * 100;
    const yPct = adrMax > 0 ? (1 - day.adr / adrMax) * 100 : 100;
    return { xPct, yPct, idx };
  });
  const segments: { xPct: number; yPct: number }[][] = [];
  let current: { xPct: number; yPct: number }[] = [];
  for (const p of linePoints) {
    if (p) {
      current.push({ xPct: p.xPct, yPct: p.yPct });
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);

  return (
    <div className="min-w-0">
      <div className="flex">
        {/* Left axis (occupancy %) */}
        <div
          className="flex flex-col justify-between pr-2 text-[9px] text-gray-400 select-none shrink-0"
          style={{ height: chartHeight }}
        >
          {occupancyTicks.map((tick) => (
            <span key={tick} className="leading-none">
              {tick}%
            </span>
          ))}
        </div>

        {/* Plot area */}
        <div className="relative flex-1 min-w-0" style={{ height: chartHeight }}>
          {/* Gridlines */}
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
            {occupancyTicks.map((tick, idx) => (
              <div
                key={tick}
                className={`border-t ${idx === occupancyTicks.length - 1 ? "border-gray-300" : "border-gray-100"}`}
              />
            ))}
          </div>

          {/* Bars */}
          <div className="absolute inset-0 flex items-end gap-1">
            {days.map((day) => {
              const isToday = day.dateStr === today;
              const heightPx = Math.max(Math.round((day.pct / 100) * chartHeight), 2);
              return (
                <div
                  key={day.dateStr}
                  className="flex-1 flex justify-center group relative"
                  style={{ height: chartHeight }}
                >
                  <div className="w-full flex items-end">
                    <div
                      className={`w-full rounded-t-sm transition-opacity ${occupancyBarClass(day.pct)} ${
                        isToday ? "ring-2 ring-blue-900 ring-offset-0" : ""
                      }`}
                      style={{ height: heightPx }}
                    />
                  </div>
                  {/* Tooltip */}
                  <div className="pointer-events-none absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block bg-gray-900 text-white text-[10px] rounded px-2 py-1 whitespace-nowrap z-10 shadow">
                    <div className="font-semibold">
                      {day.date.toLocaleDateString("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </div>
                    <div>
                      {t("dashboard.occupancyAxis")}: {day.pct}%
                    </div>
                    {day.adr != null && (
                      <div>
                        {t("dashboard.avgPriceAxis")}:{" "}
                        {formatCurrency(Math.round(day.adr), currency)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ADR line overlay */}
          {hasAdr && (
            <>
              <svg
                className="absolute inset-0 pointer-events-none"
                width="100%"
                height="100%"
                preserveAspectRatio="none"
                viewBox="0 0 100 100"
              >
                {segments.map((seg, sIdx) => (
                  <polyline
                    key={sIdx}
                    points={seg.map((p) => `${p.xPct},${p.yPct}`).join(" ")}
                    fill="none"
                    stroke="#60a5fa"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
              </svg>
              <div className="absolute inset-0 pointer-events-none">
                {linePoints.map((p, idx) =>
                  p ? (
                    <span
                      key={idx}
                      className="absolute w-2 h-2 rounded-full bg-white border-[1.5px] border-blue-400"
                      style={{
                        left: `${p.xPct}%`,
                        top: `${p.yPct}%`,
                        transform: "translate(-50%, -50%)",
                      }}
                    />
                  ) : null,
                )}
              </div>
            </>
          )}
        </div>

        {/* Right axis (ADR currency) */}
        <div
          className="flex flex-col justify-between pl-2 text-[9px] text-blue-400 select-none shrink-0"
          style={{ height: chartHeight }}
        >
          {adrTicks.map((tick, idx) => (
            <span key={idx} className="leading-none">
              {formatAdrTick(tick, currency)}
            </span>
          ))}
        </div>
      </div>

      {/* Day labels (mirror axis layout to stay aligned with bars) */}
      <div className="flex mt-2">
        <div className="invisible pr-2 text-[9px] select-none shrink-0">
          <span>100%</span>
        </div>
        <div className="flex-1 flex gap-1 min-w-0">
          {days.map((day) => {
            const isToday = day.dateStr === today;
            return (
              <div key={day.dateStr} className="flex-1 min-w-0 text-center overflow-hidden">
                <p
                  className={`text-[10px] font-medium truncate ${isToday ? "text-blue-700" : "text-gray-500"}`}
                >
                  {day.label}
                </p>
                <p className="text-[9px] text-gray-400">{day.dayNum}</p>
              </div>
            );
          })}
        </div>
        <div className="invisible pl-2 text-[9px] select-none shrink-0">
          <span>{formatAdrTick(adrMax, currency)}</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[10px] text-gray-500">
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-blue-600" />
          <span>{t("dashboard.legendHigh")}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm bg-blue-300" />
          <span>{t("dashboard.legendLow")}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <svg width="18" height="8" viewBox="0 0 18 8" className="shrink-0">
            <line x1="0" y1="4" x2="18" y2="4" stroke="#60a5fa" strokeWidth="1.5" />
            <circle cx="9" cy="4" r="2" fill="#ffffff" stroke="#60a5fa" strokeWidth="1.2" />
          </svg>
          <span>{t("dashboard.legendAdr", { currency })}</span>
        </div>
      </div>
    </div>
  );
}

/* ── Icons ── */

function OccupancyIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
      <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
      <path d="M3 7h18" />
      <path d="M8 11h8" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14" />
      <path d="M19 12l-7 7-7-7" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function DollarIcon() {
  return (
    <svg
      className="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}
