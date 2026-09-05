"use client";

import { useMemo, useState } from "react";
import { CalendarBooking, CalendarRoom, CalendarRoomType } from "@/services/calendar";
import Modal from "@/components/Modal";
import { useTranslation } from "@/lib/i18n";

// Returns the YYYY-MM-DD string one day after the given YYYY-MM-DD string.
// Parsed as local date so DST / timezone doesn't shift the result.
function addOneDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return "";
  const next = new Date(y, m - 1, d + 1);
  const yyyy = next.getFullYear();
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nightsBetween(start: string, end: string): number {
  if (!start || !end || end <= start) return 0;
  const [ys, ms, ds] = start.split("-").map(Number);
  const [ye, me, de] = end.split("-").map(Number);
  if (!ys || !ms || !ds || !ye || !me || !de) return 0;
  const a = new Date(ys, ms - 1, ds).getTime();
  const b = new Date(ye, me - 1, de).getTime();
  return Math.round((b - a) / 86_400_000);
}

interface BlockModalProps {
  roomTypes: CalendarRoomType[];
  rooms: CalendarRoom[];
  bookings: CalendarBooking[];
  onSubmit: (data: {
    roomTypeId: string;
    roomIds: string[];
    startDate: string;
    endDate: string;
    reason: string;
  }) => Promise<void>;
  onClose: () => void;
  initialRoomTypeId?: string;
  initialRoomId?: string;
  initialStartDate?: string;
  initialEndDate?: string;
}

export default function BlockModal({
  roomTypes,
  rooms,
  bookings,
  onSubmit,
  onClose,
  initialRoomTypeId,
  initialRoomId,
  initialStartDate,
  initialEndDate,
}: BlockModalProps) {
  const { t } = useTranslation();
  const [roomTypeId, setRoomTypeId] = useState(initialRoomTypeId || roomTypes[0]?.id || "");
  const [startDate, setStartDate] = useState(initialStartDate || "");
  const [endDate, setEndDate] = useState(initialEndDate || "");
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>(
    initialRoomId ? [initialRoomId] : [],
  );
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const roomsForType = useMemo(
    () => rooms.filter((r) => r.roomTypeId === roomTypeId),
    [rooms, roomTypeId],
  );

  // Bookings assigned to a selected room whose stay overlaps the block range.
  // Both ranges are half-open [start, end): they overlap iff start < otherEnd
  // && otherStart < end. ISO YYYY-MM-DD strings compare correctly as strings.
  const overlappingBookings = useMemo(() => {
    if (!startDate || !endDate || selectedRoomIds.length === 0) return [];
    return bookings.filter(
      (b) =>
        b.roomId != null &&
        selectedRoomIds.includes(b.roomId) &&
        b.checkIn < endDate &&
        b.checkOut > startDate,
    );
  }, [bookings, startDate, endDate, selectedRoomIds]);

  const allSelected = roomsForType.length > 0 && selectedRoomIds.length === roomsForType.length;
  const nights = nightsBetween(startDate, endDate);
  const roomNights = nights * selectedRoomIds.length;

  const toggleRoom = (id: string) => {
    setSelectedRoomIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleAll = () => {
    setSelectedRoomIds(allSelected ? [] : roomsForType.map((r) => r.id));
  };

  const handleRoomTypeChange = (newId: string) => {
    setRoomTypeId(newId);
    setSelectedRoomIds([]);
  };

  const handleStartDateChange = (newStart: string) => {
    setStartDate(newStart);
    if (newStart && (!endDate || endDate <= newStart)) {
      setEndDate(addOneDay(newStart));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!startDate || !endDate) {
      setError(t("calendar.blockModal.errorBothDates"));
      return;
    }
    if (endDate <= startDate) {
      setError(t("calendar.blockModal.errorEndAfterStart"));
      return;
    }
    if (selectedRoomIds.length === 0) {
      setError(t("calendar.blockModal.selectRoomError"));
      return;
    }
    if (overlappingBookings.length > 0) {
      setError(t("calendar.blockModal.overlapError"));
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({ roomTypeId, roomIds: selectedRoomIds, startDate, endDate, reason });
    } catch (err: any) {
      setError(err?.message || t("calendar.blockModal.createError"));
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent";
  const sectionLabelCls = "block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2";

  return (
    <Modal
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500 min-w-0">
            {roomNights > 0 ? (
              <>
                <span className="font-semibold text-gray-900">{roomNights}</span>{" "}
                {t(
                  roomNights === 1
                    ? "calendar.blockModal.roomNight"
                    : "calendar.blockModal.roomNights",
                )}
                <span className="text-gray-400">
                  {" · "}
                  {nights} {t(nights === 1 ? "common.night" : "common.nights")} ×{" "}
                  {selectedRoomIds.length}{" "}
                  {t(selectedRoomIds.length === 1 ? "common.room" : "common.rooms")}
                </span>
              </>
            ) : (
              <span className="text-gray-400">{t("calendar.blockModal.pickDatesRooms")}</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {t("calendar.cancel")}
            </button>
            <button
              type="submit"
              form="block-rooms-form"
              disabled={
                submitting || selectedRoomIds.length === 0 || overlappingBookings.length > 0
              }
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-primary-600 hover:bg-primary-700"
            >
              {submitting
                ? t("calendar.blockModal.blocking")
                : t(
                    selectedRoomIds.length === 1
                      ? "calendar.blockModal.blockRoom"
                      : "calendar.blockModal.blockRoomCount",
                    { count: selectedRoomIds.length },
                  )}
            </button>
          </div>
        </div>
      }
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-gray-900">{t("calendar.blockModal.title")}</h2>
          <p className="text-sm text-gray-500 mt-0.5">{t("calendar.blockModal.description")}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="shrink-0 -mt-1 -mr-1 w-8 h-8 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 flex items-center justify-center transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <form id="block-rooms-form" onSubmit={handleSubmit} className="space-y-5">
        {/* Dates */}
        <div>
          <label className={sectionLabelCls}>{t("calendar.blockModal.dates")}</label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t("calendar.blockModal.start")}
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => handleStartDateChange(e.target.value)}
                className={inputCls}
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t("calendar.blockModal.end")}
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className={inputCls}
                required
              />
            </div>
          </div>
          {nights > 0 && (
            <p className="text-xs text-gray-500 mt-2">
              {nights} {t(nights === 1 ? "common.night" : "common.nights")}
            </p>
          )}
        </div>

        {/* Room type */}
        <div>
          <label className={sectionLabelCls}>{t("calendar.blockModal.roomTypeLabel")}</label>
          <select
            value={roomTypeId}
            onChange={(e) => handleRoomTypeChange(e.target.value)}
            className={inputCls}
          >
            {roomTypes.map((rt) => (
              <option key={rt.id} value={rt.id}>
                {rt.name} · {rt.totalRooms}{" "}
                {t(rt.totalRooms === 1 ? "common.room" : "common.rooms")}
              </option>
            ))}
          </select>
        </div>

        {/* Rooms */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              {t("calendar.blockModal.rooms")}
              {roomsForType.length > 0 && (
                <span className="ml-2 text-gray-400 normal-case tracking-normal font-normal">
                  {t("calendar.blockModal.selectedRooms", {
                    selected: selectedRoomIds.length,
                    total: roomsForType.length,
                  })}
                </span>
              )}
            </label>
            {roomsForType.length > 1 && (
              <button
                type="button"
                onClick={toggleAll}
                className="text-xs font-medium text-primary-600 hover:text-primary-700 transition-colors"
              >
                {allSelected ? t("common.clearAll") : t("common.selectAll")}
              </button>
            )}
          </div>
          {roomsForType.length === 0 ? (
            <p className="text-sm text-gray-500 px-3 py-3 bg-gray-50 border border-dashed border-gray-200 rounded-lg text-center">
              {t("calendar.blockModal.noRooms")}
            </p>
          ) : (
            <div className="max-h-56 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
              {roomsForType.map((r) => {
                const checked = selectedRoomIds.includes(r.id);
                return (
                  <label
                    key={r.id}
                    className={`flex items-center gap-3 px-3 py-2.5 text-sm cursor-pointer transition-colors ${
                      checked ? "bg-primary-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRoom(r.id)}
                      className="w-4 h-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500 shrink-0"
                    />
                    <span
                      className={`font-medium truncate ${
                        checked ? "text-primary-900" : "text-gray-900"
                      }`}
                    >
                      #{r.roomNumber}
                    </span>
                    {r.floor && (
                      <span
                        className={`text-xs shrink-0 ml-auto ${
                          checked ? "text-primary-700" : "text-gray-500"
                        }`}
                      >
                        {t("rooms.floorNumber", { floor: r.floor })}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Reason */}
        <div>
          <label className={sectionLabelCls}>
            {t("calendar.blockModal.reasonLabel")}{" "}
            <span className="text-gray-400 normal-case tracking-normal font-normal">
              {t("common.optionalParenthetical")}
            </span>
          </label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("calendar.blockModal.reasonExample")}
            className={inputCls}
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200 rounded-lg">
            <svg
              className="w-4 h-4 text-red-500 shrink-0 mt-0.5"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {overlappingBookings.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-amber-200">
              <svg
                className="w-4 h-4 text-amber-600 shrink-0"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                  clipRule="evenodd"
                />
              </svg>
              <p className="text-sm font-semibold text-amber-900">
                {t("calendar.blockModal.overlapCount", {
                  count: overlappingBookings.length,
                })}
              </p>
            </div>
            <ul className="divide-y divide-amber-200">
              {overlappingBookings.slice(0, 5).map((b) => (
                <li
                  key={`${b.id}-${b.roomId}`}
                  className="px-3 py-2 text-xs flex items-center justify-between gap-3"
                >
                  <span className="truncate font-medium text-amber-900">
                    {b.guestFirstName} {b.guestLastName}
                    {b.roomNumber ? ` · #${b.roomNumber}` : ""}
                  </span>
                  <span className="shrink-0 text-amber-700 tabular-nums">
                    {b.checkIn} → {b.checkOut}
                  </span>
                </li>
              ))}
              {overlappingBookings.length > 5 && (
                <li className="px-3 py-1.5 text-xs text-amber-700 italic">
                  {t("calendar.blockModal.moreOverlaps", {
                    count: overlappingBookings.length - 5,
                  })}
                </li>
              )}
            </ul>
            <p className="px-3 py-2 text-xs text-amber-800 border-t border-amber-200">
              {t("calendar.blockModal.chooseDifferent")}
            </p>
          </div>
        )}
      </form>
    </Modal>
  );
}
