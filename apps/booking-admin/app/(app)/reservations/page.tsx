"use client";
import { useTranslation } from "@/lib/i18n";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  CalendarDaysIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import {
  BookingReservationListClientError,
  getBookingReservations,
  toBookingReservationListClientError,
  type BookingReservation,
  type BookingReservationList,
} from "@/services/api/bookingReservationsClient";

const PAGE_SIZE = 20;

const STATUS_OPTIONS = [
  { value: "", label: "admin.allStatuses" },
  { value: "confirmed", label: "admin.confirmed" },
  { value: "pending", label: "admin.pending" },
  { value: "cancelled", label: "admin.cancelled" },
  { value: "checked_in", label: "admin.checkedIn" },
  { value: "checked_out", label: "admin.checkedOut" },
];

const STATUS_STYLES: Record<string, string> = {
  confirmed: "bg-emerald-50 text-emerald-700 border-emerald-100",
  pending: "bg-amber-50 text-amber-700 border-amber-100",
  cancelled: "bg-red-50 text-red-700 border-red-100",
  canceled: "bg-red-50 text-red-700 border-red-100",
  checked_in: "bg-blue-50 text-blue-700 border-blue-100",
  checked_out: "bg-gray-100 text-gray-700 border-gray-200",
};

export default function ReservationsPage() {
  const { t, locale } = useTranslation();
  const hasLoadedRef = useRef(false);
  const lastSuccessfulQueryRef = useRef("");
  const [hotelId, setHotelId] = useState<string | null>(null);
  const [bookings, setBookings] = useState<BookingReservationList | null>(null);
  const [status, setStatus] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<BookingReservationListClientError | null>(null);

  useEffect(() => {
    let interval: number | null = null;

    const syncHotelId = () => {
      const nextHotelId = window.localStorage.getItem("selectedHotelId");
      setHotelId((currentHotelId) =>
        currentHotelId === nextHotelId ? currentHotelId : nextHotelId,
      );
      if (nextHotelId && interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };

    syncHotelId();
    interval = window.setInterval(syncHotelId, 500);
    window.addEventListener("focus", syncHotelId);
    window.addEventListener("storage", syncHotelId);

    return () => {
      if (interval !== null) window.clearInterval(interval);
      window.removeEventListener("focus", syncHotelId);
      window.removeEventListener("storage", syncHotelId);
    };
  }, []);

  useEffect(() => {
    if (!hotelId) {
      hasLoadedRef.current = false;
      lastSuccessfulQueryRef.current = "";
      setBookings(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    let active = true;
    const queryKey = JSON.stringify({ hotelId, status, search, offset });
    const showStaleData = hasLoadedRef.current && lastSuccessfulQueryRef.current === queryKey;
    setLoading(!showStaleData);
    setRefreshing(showStaleData);
    setError(null);
    if (!showStaleData) setBookings(null);

    getBookingReservations({
      hotelId,
      status,
      search,
      limit: PAGE_SIZE,
      offset,
    })
      .then((nextBookings) => {
        if (!active) return;
        hasLoadedRef.current = true;
        lastSuccessfulQueryRef.current = queryKey;
        setBookings(nextBookings);
      })
      .catch((nextError: unknown) => {
        if (!active) return;
        setError(toBookingReservationListClientError(nextError));
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      active = false;
    };
  }, [hotelId, status, search, offset, reloadKey]);

  const pageRange = useMemo(() => {
    if (!bookings || bookings.total === 0) return "0";
    const start = bookings.offset + 1;
    const end = bookings.offset + bookings.bookings.length;
    return `${start}-${end}`;
  }, [bookings]);

  const canGoBack = Boolean(bookings && bookings.offset > 0 && !refreshing);
  const canGoNext = Boolean(
    bookings && bookings.offset + bookings.bookings.length < bookings.total && !refreshing,
  );
  const hasRows = Boolean(bookings?.bookings.length);
  const showInitialError = Boolean(error && !bookings);

  const handleSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(searchDraft.trim());
    setOffset(0);
  };

  const handleStatusChange = (nextStatus: string) => {
    setStatus(nextStatus);
    setOffset(0);
  };

  const handleRefresh = () => {
    setReloadKey((current) => current + 1);
  };

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-gray-900">{t("admin.reservations")}</h1>
          <p className="text-[13px] text-gray-500 mt-1">
            {bookings
              ? t("admin.matchingBookingsCount", { count: bookings.total.toLocaleString(locale) })
              : t("admin.bookingList")}
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={!hotelId || loading || refreshing}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowPathIcon className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          {t("settings.booking.refresh")}
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-3 md:p-4">
        <form onSubmit={handleSearch} className="grid gap-3 md:grid-cols-[1fr_180px_auto]">
          <label className="relative block">
            <span className="sr-only">{t("admin.searchReservations")}</span>
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={t("admin.searchGuestEmailOrReference")}
              className="h-9 w-full rounded-md border border-gray-200 bg-white pl-9 pr-3 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-100"
            />
          </label>
          <label>
            <span className="sr-only">{t("affiliates.allAffiliates.status")}</span>
            <select
              value={status}
              onChange={(event) => handleStatusChange(event.target.value)}
              className="h-9 w-full rounded-md border border-gray-200 bg-white px-3 text-[13px] text-gray-700 focus:border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-100"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="h-9 rounded-md bg-gray-900 px-4 text-[13px] font-medium text-white transition-colors hover:bg-gray-800"
          >
            {t("admin.search")}
          </button>
        </form>
      </div>

      {error && bookings && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {t("admin.reservationsUnavailable")}{" "}
            {t("admin.showingTheLastSuccessfulReservationListUntilRefreshSucceeds")}
          </p>
        </div>
      )}

      {refreshing && bookings && (
        <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[13px] font-medium text-blue-700">
          {t("admin.updatingReservations")}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {loading && !bookings && <ReservationSkeleton />}
        {!hotelId && !loading && <NoHotelState />}
        {showInitialError && <ErrorState onRetry={handleRefresh} />}
        {!loading && hotelId && bookings && !hasRows && <EmptyState />}
        {bookings && hasRows && (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <TableHead label={t("admin.reservation")} />
                    <TableHead label={t("affiliates.typeFilter.guest")} />
                    <TableHead label={t("admin.stay")} />
                    <TableHead label={t("admin.rooms")} />
                    <TableHead label={t("admin.payment")} />
                    <TableHead label={t("affiliates.allAffiliates.status")} />
                  </tr>
                </thead>
                <tbody className={`divide-y divide-gray-100 ${refreshing ? "opacity-70" : ""}`}>
                  {bookings.bookings.map((booking) => (
                    <ReservationRow key={booking.id} booking={booking} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-3 border-t border-gray-200 px-3 py-3 text-[13px] text-gray-500 sm:flex-row sm:items-center sm:justify-between">
              <span>
                {t("admin.showing")}
                {pageRange} {t("admin.of")}
                {bookings.total.toLocaleString()}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!canGoBack}
                  onClick={() => setOffset((current) => Math.max(current - PAGE_SIZE, 0))}
                  className="h-8 rounded-md border border-gray-200 bg-white px-3 font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("admin.previous")}
                </button>
                <button
                  type="button"
                  disabled={!canGoNext}
                  onClick={() => setOffset((current) => current + PAGE_SIZE)}
                  className="h-8 rounded-md border border-gray-200 bg-white px-3 font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("admin.next")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ReservationRow({ booking }: { booking: BookingReservation }) {
  const { t, locale } = useTranslation();
  const guestName = `${booking.guestFirstName} ${booking.guestLastName}`.trim();
  const roomSummary = booking.roomLines?.length
    ? booking.roomLines.map((line) => `${line.roomCount} × ${line.roomName}`).join(" + ")
    : booking.numberOfRooms === 1
      ? booking.roomName
      : `${booking.numberOfRooms} x ${booking.roomName}`;

  return (
    <tr className="hover:bg-gray-50/80">
      <TableCell>
        <div className="font-semibold text-gray-900">{booking.bookingReference || booking.id}</div>
        <div className="mt-1 text-[12px] text-gray-500">
          {formatTimestamp(booking.createdAt, locale)}
        </div>
      </TableCell>
      <TableCell>
        <div className="font-medium text-gray-900">
          {guestName || t("affiliates.typeFilter.guest")}
        </div>
        <div className="mt-1 max-w-[220px] truncate text-[12px] text-gray-500">
          {booking.guestEmail || booking.guestPhone || t("admin.noContactDetails")}
        </div>
      </TableCell>
      <TableCell>
        <div className="font-medium text-gray-900">
          {formatDate(booking.checkIn, locale)} - {formatDate(booking.checkOut, locale)}
        </div>
        <div className="mt-1 text-[12px] text-gray-500">
          {t("admin.nightsNightsAdultsAdults", { nights: booking.nights, adults: booking.adults })}
          {booking.children > 0 ? t("admin.childrenCount", { count: booking.children }) : ""}
        </div>
      </TableCell>
      <TableCell>
        <div className="font-medium text-gray-900">{roomSummary}</div>
        <div className="mt-1 text-[12px] text-gray-500">
          {booking.assignedRooms.length > 0
            ? t("admin.assignedCount", { count: booking.assignedRooms.length })
            : booking.roomNumber
              ? t("admin.roomNumber", { number: booking.roomNumber })
              : t("admin.unassigned")}
        </div>
      </TableCell>
      <TableCell>
        <div className="font-semibold text-gray-900">
          {formatCurrency(booking.totalAmount, booking.currency, locale)}
        </div>
        <div className="mt-1 text-[12px] text-gray-500">
          {t(`reservations.paymentStatus.${booking.paymentStatus ?? "pending"}`)}
        </div>
      </TableCell>
      <TableCell>
        <span
          className={`inline-flex rounded-full border px-2 py-1 text-[12px] font-semibold ${statusClassName(
            booking.status,
          )}`}
        >
          {t(`reservations.status.${booking.status}`)}
        </span>
        <div className="mt-1 text-[12px] text-gray-500">
          {!booking.channel || booking.channel === "direct" ? t("admin.direct") : booking.channel}
        </div>
      </TableCell>
    </tr>
  );
}

function TableHead({ label }: { label: string }) {
  return (
    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">
      {label}
    </th>
  );
}

function TableCell({ children }: { children: React.ReactNode }) {
  return <td className="whitespace-nowrap px-4 py-3 text-[13px] align-top">{children}</td>;
}

function ReservationSkeleton() {
  return (
    <div className="divide-y divide-gray-100">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-6">
          {Array.from({ length: 6 }).map((__, cellIndex) => (
            <div key={cellIndex} className="space-y-2">
              <div className="h-3 w-24 animate-pulse rounded bg-gray-200" />
              <div className="h-2 w-16 animate-pulse rounded bg-gray-100" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="px-4 py-14 text-center">
      <CalendarDaysIcon className="mx-auto h-9 w-9 text-gray-300" />
      <h2 className="mt-3 text-sm font-semibold text-gray-900">{t("admin.noReservationsFound")}</h2>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-gray-500">
        {t("admin.adjustTheFiltersOrSearchQueryToSeeMatchingBookings")}
      </p>
    </div>
  );
}

function NoHotelState() {
  const { t } = useTranslation();
  return (
    <div className="px-4 py-14 text-center">
      <CalendarDaysIcon className="mx-auto h-9 w-9 text-gray-300" />
      <h2 className="mt-3 text-sm font-semibold text-gray-900">{t("admin.selectAProperty")}</h2>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-gray-500">
        {t("admin.chooseAPropertyFromTheHeaderBeforeViewingReservations")}
      </p>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="px-4 py-14 text-center">
      <ExclamationTriangleIcon className="mx-auto h-9 w-9 text-red-400" />
      <h2 className="mt-3 text-sm font-semibold text-gray-900">
        {t("admin.reservationsUnavailable")}
      </h2>
      <p className="mx-auto mt-1 max-w-sm text-[13px] text-gray-500">
        {t("admin.reservationsUnavailable")}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 h-9 rounded-md bg-gray-900 px-4 text-[13px] font-medium text-white transition-colors hover:bg-gray-800"
      >
        {t("auth.chooseProperty.retry")}
      </button>
    </div>
  );
}

function formatDate(value: string, locale: string): string {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
}

function formatTimestamp(value: string, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatCurrency(amount: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency || "EUR",
    maximumFractionDigits: 2,
  }).format(amount);
}

function statusClassName(status: string): string {
  return STATUS_STYLES[status.toLowerCase()] ?? "bg-gray-50 text-gray-700 border-gray-200";
}
