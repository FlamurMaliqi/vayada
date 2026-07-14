"use client";

import { useEffect, useMemo, useState } from "react";
import { bookingsService, BookingStatus, SuperAdminBookingRow } from "@/services/api/bookings";

const STATUS_TABS: { value: "all" | BookingStatus; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "withdrawn", label: "Withdrawn" },
];

const STATUS_STYLES: Record<BookingStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  accepted: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
  withdrawn: "bg-gray-100 text-gray-600",
};

function formatAmount(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function BookingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bookings, setBookings] = useState<SuperAdminBookingRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | BookingStatus>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    setLoading(true);
    setError(null);
    bookingsService
      .list({ limit: 500 })
      .then((res) => setBookings(res.bookings))
      .catch(() => {
        setBookings([]);
        setError("Could not load bookings. Please refresh and try again.");
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let list = bookings;
    if (statusFilter !== "all") list = list.filter((b) => b.status === statusFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (b) =>
          b.bookingReference.toLowerCase().includes(q) ||
          b.guestName.toLowerCase().includes(q) ||
          b.guestEmail.toLowerCase().includes(q) ||
          b.hotelName.toLowerCase().includes(q),
      );
    }
    return list;
  }, [bookings, statusFilter, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      all: bookings.length,
      pending: 0,
      accepted: 0,
      rejected: 0,
      withdrawn: 0,
    };
    for (const b of bookings) c[b.status] = (c[b.status] || 0) + 1;
    return c;
  }, [bookings]);

  return (
    <div className="p-4 md:p-8 max-w-[1400px]">
      <div className="mb-5 md:mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Bookings</h1>
        <p className="text-[13px] text-gray-500 mt-1">
          Every booking request across all properties with request and response times
        </p>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="flex flex-wrap gap-2">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              className={`px-3 py-1.5 text-[12px] font-medium rounded-full border transition-colors ${
                statusFilter === tab.value
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"
              }`}
            >
              {tab.label}
              <span
                className={`ml-1.5 text-[11px] ${statusFilter === tab.value ? "text-gray-300" : "text-gray-400"}`}
              >
                {counts[tab.value] ?? 0}
              </span>
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search by reference, guest or property..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full sm:w-80 px-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200"
        />
      </div>

      {loading ? (
        <div className="animate-pulse h-64 bg-gray-100 rounded-xl" />
      ) : error ? (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-xl p-12 text-center text-[13px] text-red-700"
        >
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
          <p className="text-[13px] text-gray-500">No bookings found.</p>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50/80">
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                  Booking
                </th>
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                  Property
                </th>
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                  Stay
                </th>
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                  Requested
                </th>
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                  Responded
                </th>
                <th className="text-right px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                  Total
                </th>
                <th className="text-left  px-4 py-3 font-medium text-[11px] text-gray-500 uppercase tracking-wider">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((b) => (
                <tr key={b.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3">
                    <p className="font-mono text-[11px] text-gray-700">{b.bookingReference}</p>
                    <p className="text-[12px] text-gray-900 mt-0.5">{b.guestName}</p>
                    <p className="text-[11px] text-gray-500">{b.guestEmail}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{b.hotelName}</td>
                  <td className="px-4 py-3 text-gray-600 text-[12px]">
                    {formatDate(b.checkIn)} → {formatDate(b.checkOut)}
                    <span className="block text-[11px] text-gray-400">
                      {b.nights} night{b.nights === 1 ? "" : "s"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-[12px]">
                    {formatDateTime(b.requestedAt)}
                  </td>
                  <td className="px-4 py-3 text-gray-600 text-[12px]">
                    {b.respondedAt ? (
                      <>
                        {formatDateTime(b.respondedAt)}
                        <span className="block text-[11px] text-gray-400 capitalize">
                          {b.status}
                        </span>
                      </>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-900 font-medium">
                    {formatAmount(b.totalAmount, b.currency)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${STATUS_STYLES[b.status] ?? "bg-gray-100 text-gray-600"}`}
                    >
                      {b.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
