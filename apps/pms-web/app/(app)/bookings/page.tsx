"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { bookingsService, Booking, BookingListResponse } from "@/services/bookings";
import { MagnifyingGlassIcon, EllipsisHorizontalIcon } from "@heroicons/react/24/outline";
import { useTranslation } from "@/lib/i18n";
import { formatCurrency } from "@/lib/formatCurrency";
import { normalizeChannelKey } from "@/lib/constants/statusStyles";

const STATUS_STYLES: Record<string, string> = {
  pending: "border-yellow-200 text-yellow-700 bg-yellow-50",
  confirmed: "border-emerald-200 text-emerald-700 bg-emerald-50",
  checked_in: "border-sky-200 text-sky-700 bg-sky-50",
  in_house: "border-violet-200 text-violet-700 bg-violet-50",
  cancelled: "border-rose-200 text-rose-600 bg-rose-50",
  // VAY-404 — host-rejected request, distinct from guest cancel.
  declined: "border-rose-300 text-rose-700 bg-rose-50",
  expired: "border-gray-200 text-gray-500 bg-gray-50",
  no_show: "border-orange-200 text-orange-700 bg-orange-50",
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending: "bookings.statusPending",
  confirmed: "bookings.statusConfirmed",
  checked_in: "bookings.statusCheckedIn",
  in_house: "bookings.statusInHouse",
  cancelled: "bookings.statusCancelled",
  declined: "bookings.statusDeclined",
  expired: "bookings.statusExpired",
  no_show: "bookings.statusNoShow",
};

const BALANCE_STYLES: Record<string, string> = {
  paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
  due: "bg-rose-50 text-rose-600 border-rose-200",
  refunded: "bg-violet-50 text-violet-700 border-violet-200",
};

const SOURCE_ICONS: Record<string, { bg: string; letter: string; titleKey: string }> = {
  direct: { bg: "bg-primary-600", letter: "V", titleKey: "calendar.channelDirect" },
  airbnb: { bg: "bg-rose-500", letter: "A", titleKey: "calendar.channelAirbnb" },
  "booking.com": {
    bg: "bg-[#003580]",
    letter: "B.",
    titleKey: "calendar.channelBookingCom",
  },
  expedia: { bg: "bg-amber-400", letter: "E", titleKey: "calendar.channelExpedia" },
  channex: { bg: "bg-violet-600", letter: "C", titleKey: "bookings.channelChannex" },
};

function getBalanceStatus(b: Booking): string {
  if (b.status === "cancelled" || b.status === "declined")
    return b.paymentStatus === "refunded" ? "refunded" : "due";
  if (b.depositRequired && b.depositAmount > 0) {
    if (b.balanceAmount <= 0) return "paid";
    return b.paymentStatus === "captured" ? "partial" : "due";
  }
  if (b.paymentStatus === "captured") return "paid";
  if (b.paymentStatus === "authorized") return "partial";
  if (b.paymentMethod === "pay_at_property") return "due";
  return "due";
}

function getNights(checkIn: string, checkOut: string): number {
  const d1 = new Date(checkIn);
  const d2 = new Date(checkOut);
  return Math.max(1, Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24)));
}

function formatDate(dateStr: string, locale: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function getGuestCount(b: Booking): number {
  return (b.adults || 1) + (b.children || 0) - 1;
}

export default function ReservationsPage() {
  const { locale, t } = useTranslation();
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 20;

  const fetchBookings = () => {
    setLoading(true);
    bookingsService
      .list({ status: statusFilter || undefined, limit, offset })
      .then((res: BookingListResponse) => {
        setBookings(res.bookings);
        setTotal(res.total);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setOffset(0);
  }, [statusFilter]);

  useEffect(() => {
    fetchBookings();
  }, [statusFilter, offset]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    bookings.forEach((b) => {
      counts[b.status] = (counts[b.status] || 0) + 1;
    });
    return counts;
  }, [bookings]);

  const filteredBookings = useMemo(() => {
    if (!searchQuery.trim()) return bookings;
    const q = searchQuery.toLowerCase();
    return bookings.filter(
      (b) =>
        b.guestFirstName?.toLowerCase().includes(q) ||
        b.guestLastName?.toLowerCase().includes(q) ||
        b.bookingReference?.toLowerCase().includes(q) ||
        b.roomName?.toLowerCase().includes(q) ||
        b.guestEmail?.toLowerCase().includes(q),
    );
  }, [bookings, searchQuery]);

  const STATUS_TABS = [
    { label: t("bookings.statusAll"), value: "", count: total },
    {
      label: t("bookings.statusConfirmed"),
      value: "confirmed",
      count: statusCounts["confirmed"] || 0,
    },
    {
      label: t("bookings.statusCheckedIn"),
      value: "checked_in",
      count: statusCounts["checked_in"] || 0,
    },
    { label: t("bookings.statusInHouse"), value: "in_house", count: statusCounts["in_house"] || 0 },
    {
      label: t("bookings.statusCancelled"),
      value: "cancelled",
      count: statusCounts["cancelled"] || 0,
    },
    {
      label: t("bookings.statusDeclined"),
      value: "declined",
      count: statusCounts["declined"] || 0,
    },
    { label: t("bookings.statusPending"), value: "pending", count: statusCounts["pending"] || 0 },
    { label: t("bookings.statusExpired"), value: "expired", count: statusCounts["expired"] || 0 },
    { label: t("bookings.statusNoShow"), value: "no_show", count: statusCounts["no_show"] || 0 },
  ];

  return (
    <div className="p-4 md:p-6 pb-0">
      {/* Header */}
      <div className="mb-6 md:mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl md:text-xl font-bold text-gray-900">{t("bookings.title")}</h1>
          <p className="text-sm text-gray-500 mt-1">{t("bookings.subtitle")}</p>
        </div>
        <div className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-gray-200 bg-white">
          <span className="relative flex w-2 h-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
          </span>
          <span className="text-xs font-medium text-gray-700">{t("bookings.liveSync")}</span>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mb-4 md:mb-5">
        <div className="relative flex-1 sm:flex-initial sm:max-w-sm">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder={t("bookings.searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full sm:w-80 pl-9 pr-3 py-2 text-sm border border-gray-200 rounded-lg bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500"
          />
        </div>
        <button className="flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-500 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors shrink-0">
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4" />
            <path d="M8 2v4" />
            <path d="M3 10h18" />
          </svg>
          {t("bookings.filterByDateRange")}
          <svg
            className="w-3 h-3 text-gray-400"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      {/* Status Tabs */}
      <div className="relative border-b border-gray-200 mb-4 md:mb-6">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide -mx-4 px-4 md:mx-0 md:px-0">
          {STATUS_TABS.map((tab) => {
            const isActive = statusFilter === tab.value;
            return (
              <button
                key={tab.value}
                onClick={() => setStatusFilter(tab.value)}
                className={`relative shrink-0 whitespace-nowrap px-3 py-2.5 text-sm transition-colors ${
                  isActive ? "text-gray-900 font-semibold" : "text-gray-400 hover:text-gray-600"
                }`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={`ml-1 text-xs ${isActive ? "text-gray-500" : "text-gray-400"}`}>
                    ({tab.count})
                  </span>
                )}
                {isActive && (
                  <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-primary-600 rounded-full" />
                )}
              </button>
            );
          })}
        </div>
        <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-gray-50 to-transparent pointer-events-none lg:hidden" />
      </div>

      {/* Table */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-16 bg-gray-50 rounded" />
          ))}
        </div>
      ) : filteredBookings.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-gray-400 text-sm">{t("bookings.noReservations")}</p>
        </div>
      ) : (
        <>
          {/* Mobile card list */}
          <div className="md:hidden space-y-2.5 pb-6">
            {filteredBookings.map((b) => {
              const guestExtra = getGuestCount(b);
              const nights = getNights(b.checkIn, b.checkOut);
              const balance = getBalanceStatus(b);
              const source = SOURCE_ICONS[normalizeChannelKey(b.channel)] || SOURCE_ICONS["direct"];
              return (
                <Link
                  key={b.id}
                  href={`/bookings/${b.id}`}
                  className="block bg-white border border-gray-200 rounded-xl p-3.5 active:bg-gray-50 transition-colors"
                >
                  {/* Top row: name + status */}
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold text-gray-900 truncate">
                          {b.guestFirstName} {b.guestLastName}
                        </span>
                        {guestExtra > 0 && (
                          <span className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 rounded-md text-[10px] font-semibold text-primary-700 bg-primary-50 border border-primary-100 shrink-0">
                            +{guestExtra}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-400 mt-0.5 font-mono truncate">
                        {b.bookingReference}
                      </p>
                    </div>
                    <span
                      className={`shrink-0 inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border ${STATUS_STYLES[b.status] || STATUS_STYLES["pending"]}`}
                    >
                      {STATUS_LABEL_KEYS[b.status] ? t(STATUS_LABEL_KEYS[b.status]) : b.status}
                    </span>
                  </div>

                  {/* Room + stay period */}
                  <div className="space-y-1 text-[12px] text-gray-600 border-t border-gray-100 pt-2.5">
                    <div className="flex items-center gap-1.5 truncate">
                      <svg
                        className="w-3.5 h-3.5 text-gray-400 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                        <path d="M9 22V12h6v10" />
                      </svg>
                      {b.roomNumber ? (
                        <span className="truncate">
                          <span className="font-medium text-gray-800">#{b.roomNumber}</span> ·{" "}
                          {b.roomName}
                        </span>
                      ) : (
                        <span className="truncate">{b.roomName}</span>
                      )}
                      {b.numberOfRooms > 1 && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded bg-primary-50 text-primary-700 text-[10px] font-semibold">
                          ×{b.numberOfRooms} {t("common.rooms")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <svg
                        className="w-3.5 h-3.5 text-gray-400 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <path d="M16 2v4" />
                        <path d="M8 2v4" />
                        <path d="M3 10h18" />
                      </svg>
                      <span>{formatDate(b.checkIn, locale)}</span>
                      <span className="text-gray-300">→</span>
                      <span>{formatDate(b.checkOut, locale)}</span>
                      <span className="text-gray-400">
                        · {nights} {nights === 1 ? t("common.night") : t("common.nights")}
                      </span>
                    </div>
                  </div>

                  {/* Bottom row: source + total + balance */}
                  <div className="flex items-center justify-between gap-2 border-t border-gray-100 pt-2.5 mt-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-flex w-6 h-6 items-center justify-center rounded-md text-white text-[9px] font-bold shadow-sm shrink-0 ${source.bg}`}
                        title={t(source.titleKey)}
                      >
                        {source.letter}
                      </span>
                      <span className="text-sm font-semibold text-gray-900">
                        {formatCurrency(b.totalAmount, b.currency)}
                      </span>
                      {b.depositRequired && (
                        <span
                          className={`text-[10px] font-semibold rounded-full px-2 py-0.5 ${
                            b.paymentStatus === "captured"
                              ? "text-emerald-700 bg-emerald-50 border border-emerald-200"
                              : b.paymentStatus === "refunded"
                                ? "text-gray-600 bg-gray-100 border border-gray-200"
                                : "text-amber-700 bg-amber-50 border border-amber-200"
                          }`}
                        >
                          {b.paymentStatus === "captured"
                            ? t("bookings.detail.depositPaid")
                            : b.paymentStatus === "refunded"
                              ? t("bookings.detail.depositRefunded")
                              : t("bookings.detail.depositPending")}
                        </span>
                      )}
                    </div>
                    <span
                      className={`shrink-0 inline-flex px-2.5 py-0.5 rounded-full text-[10px] font-semibold border ${BALANCE_STYLES[balance] || BALANCE_STYLES["due"]}`}
                    >
                      {balance === "paid"
                        ? t("bookings.balancePaid")
                        : balance === "partial"
                          ? t("bookings.balancePartial")
                          : balance === "refunded"
                            ? t("bookings.balanceRefunded")
                            : t("bookings.balanceDue")}
                    </span>
                  </div>
                </Link>
              );
            })}

            {/* Mobile pagination */}
            {total > limit && (
              <div className="flex items-center justify-between px-1 pt-3">
                <p className="text-xs text-gray-400">
                  {t("common.showingOf", {
                    from: String(offset + 1),
                    to: String(Math.min(offset + limit, total)),
                    total: String(total),
                  })}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setOffset(Math.max(0, offset - limit))}
                    disabled={offset === 0}
                    className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg bg-white disabled:opacity-40 transition-colors"
                  >
                    {t("common.previous")}
                  </button>
                  <button
                    onClick={() => setOffset(offset + limit)}
                    disabled={offset + limit >= total}
                    className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg bg-white disabled:opacity-40 transition-colors"
                  >
                    {t("common.next")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Desktop table */}
          <div className="hidden md:block bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[200px]">
                    {t("bookings.tableGuest")}
                  </th>
                  <th className="text-left px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[110px]">
                    {t("bookings.tableStatus")}
                  </th>
                  <th className="text-left px-4 pb-3 pt-4 text-xs font-medium text-gray-400">
                    {t("bookings.tableRoom")}
                  </th>
                  <th className="text-left px-4 pb-3 pt-4 text-xs font-medium text-gray-400">
                    {t("bookings.tableStayPeriod")}
                  </th>
                  <th className="text-right px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[90px]">
                    {t("bookings.tableTotal")}
                  </th>
                  <th className="text-center px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[90px]">
                    {t("bookings.tableBalance")}
                  </th>
                  <th className="text-left px-4 pb-3 pt-4 text-xs font-medium text-gray-400 w-[70px]">
                    {t("bookings.tableSource")}
                  </th>
                  <th className="w-10 pt-4"></th>
                </tr>
              </thead>
              <tbody>
                {filteredBookings.map((b) => {
                  const guestExtra = getGuestCount(b);
                  const nights = getNights(b.checkIn, b.checkOut);
                  const balance = getBalanceStatus(b);
                  const source =
                    SOURCE_ICONS[normalizeChannelKey(b.channel)] || SOURCE_ICONS["direct"];
                  return (
                    <tr
                      key={b.id}
                      className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50/50 transition-colors group"
                    >
                      {/* Guest */}
                      <td className="px-4 py-4">
                        <Link href={`/bookings/${b.id}`} className="block">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[13px] font-medium text-gray-900 group-hover:text-primary-600 transition-colors">
                              {b.guestFirstName} {b.guestLastName}
                            </span>
                            {guestExtra > 0 && (
                              <span className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1 rounded-md text-[10px] font-semibold text-primary-700 bg-primary-50 border border-primary-100">
                                +{guestExtra}
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-400 mt-0.5 font-mono">
                            {b.bookingReference}
                          </p>
                        </Link>
                      </td>

                      {/* Status */}
                      <td className="px-4 py-4">
                        <span
                          className={`inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold border ${STATUS_STYLES[b.status] || STATUS_STYLES["pending"]}`}
                        >
                          {STATUS_LABEL_KEYS[b.status] ? t(STATUS_LABEL_KEYS[b.status]) : b.status}
                        </span>
                      </td>

                      {/* Room */}
                      <td className="px-4 py-4 text-[13px] text-gray-600">
                        {b.roomNumber ? (
                          <>
                            <span className="font-medium text-gray-800">#{b.roomNumber}</span>
                            <span className="text-gray-400"> - </span>
                            {b.roomName}
                          </>
                        ) : (
                          b.roomName
                        )}
                        {b.numberOfRooms > 1 && (
                          <span className="ml-1.5 px-1.5 py-0.5 rounded bg-primary-50 text-primary-700 text-[11px] font-semibold">
                            ×{b.numberOfRooms}
                          </span>
                        )}
                      </td>

                      {/* Stay Period */}
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-1.5 text-[13px] text-gray-600">
                          <span>{formatDate(b.checkIn, locale)}</span>
                          <span className="text-gray-300">&rarr;</span>
                          <span>{formatDate(b.checkOut, locale)}</span>
                          <span className="flex items-center gap-0.5 text-[12px] text-gray-400 ml-2">
                            <svg
                              className="w-3.5 h-3.5"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                            </svg>
                            {nights}
                          </span>
                        </div>
                      </td>

                      {/* Total */}
                      <td className="px-4 py-4 text-right text-[13px] font-semibold text-gray-900">
                        {formatCurrency(b.totalAmount, b.currency)}
                        {b.depositRequired && (
                          <div
                            className={`mt-1 text-[10px] font-medium ${
                              b.paymentStatus === "captured"
                                ? "text-emerald-700"
                                : b.paymentStatus === "refunded"
                                  ? "text-gray-500"
                                  : "text-amber-700"
                            }`}
                          >
                            {b.paymentStatus === "captured"
                              ? t("bookings.detail.depositPaid")
                              : b.paymentStatus === "refunded"
                                ? t("bookings.detail.depositRefunded")
                                : t("bookings.detail.depositPending")}
                          </div>
                        )}
                      </td>

                      {/* Balance */}
                      <td className="px-4 py-4 text-center">
                        <span
                          className={`inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold border ${BALANCE_STYLES[balance] || BALANCE_STYLES["due"]}`}
                        >
                          {balance === "paid"
                            ? t("bookings.balancePaid")
                            : balance === "partial"
                              ? t("bookings.balancePartial")
                              : balance === "refunded"
                                ? t("bookings.balanceRefunded")
                                : t("bookings.balanceDue")}
                        </span>
                      </td>

                      {/* Source */}
                      <td className="px-4 py-4">
                        <span
                          className={`inline-flex w-7 h-7 items-center justify-center rounded-lg text-white text-[10px] font-bold shadow-sm ${source.bg}`}
                          title={t(source.titleKey)}
                        >
                          {source.letter}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-4 py-4 text-right">
                        <Link
                          href={`/bookings/${b.id}`}
                          className="p-1 rounded-md hover:bg-gray-100 transition-colors inline-flex"
                        >
                          <EllipsisHorizontalIcon className="w-5 h-5 text-gray-400" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {total > limit && (
              <div className="flex items-center justify-between px-4 py-4 border-t border-gray-200">
                <p className="text-sm text-gray-400">
                  {t("common.showingOf", {
                    from: String(offset + 1),
                    to: String(Math.min(offset + limit, total)),
                    total: String(total),
                  })}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setOffset(Math.max(0, offset - limit))}
                    disabled={offset === 0}
                    className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
                  >
                    {t("common.previous")}
                  </button>
                  <button
                    onClick={() => setOffset(offset + limit)}
                    disabled={offset + limit >= total}
                    className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg disabled:opacity-40 hover:bg-gray-50 transition-colors"
                  >
                    {t("common.next")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
