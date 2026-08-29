"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  addMonths,
  isSameMonth,
  isSameDay,
  parseISO,
  isWithinInterval,
} from "date-fns";
import { CalendarBooking, CalendarBlock, CalendarRoomType } from "@/services/calendar";
import { getChannelBarColor } from "@/lib/constants/statusStyles";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
export const calendarLaneTop = (index: number) => index * 36 + 6;

interface MobileCalendarProps {
  currentMonth: Date;
  bookings: CalendarBooking[];
  blocks: CalendarBlock[];
  roomTypes: CalendarRoomType[];
  loading?: boolean;
  loadError?: boolean;
  onMonthChange: (month: Date) => void;
  onSelectBooking: (booking: CalendarBooking) => void;
  // Both dates are yyyy-MM-dd. endDate is the exclusive checkout (last selected
  // day + 1), matching desktop drag-select semantics.
  onNewBooking: (startDate?: string, endDate?: string) => void;
  onBlockRoom: (startDate: string, endDate: string) => void;
  onSelectBlock: (block: CalendarBlock) => void;
  writeActionsAvailable?: boolean;
  manualBookingAvailable?: boolean;
}

export default function MobileCalendar({
  currentMonth,
  bookings,
  blocks,
  roomTypes,
  loading = false,
  loadError = false,
  onMonthChange,
  onSelectBooking,
  onNewBooking,
  onBlockRoom,
  onSelectBlock,
  writeActionsAvailable = true,
  manualBookingAvailable = writeActionsAvailable,
}: MobileCalendarProps) {
  // Selection model: tap a day to single-select it (so the user can browse
  // that day's bookings/blocks); drag from one day onto another to form a
  // range. The drag mirrors desktop's pointer drag-to-select. While the
  // user is mid-drag, `drag` holds the live anchor + current day so we can
  // paint the in-progress range without committing to selection state yet.
  const [selectionStart, setSelectionStart] = useState<Date | null>(new Date());
  const [selectionEnd, setSelectionEnd] = useState<Date | null>(new Date());
  const [drag, setDrag] = useState<{ start: Date; current: Date; moved: boolean } | null>(null);
  const dragRef = useRef<typeof drag>(null);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);
  // Tracks the (clientX, clientY) where the pointer first went down. Used to
  // distinguish a tap from a drag — only past a small movement threshold do
  // we start treating the gesture as a range select.
  const downPosRef = useRef<{ x: number; y: number } | null>(null);

  const clearRange = () => {
    if (selectionStart) setSelectionEnd(selectionStart);
  };

  // Pointer-drag handlers wired to each day button. Single tap (no movement
  // past threshold) commits the tapped day; a drag onto another day commits
  // the range (auto-sorted).
  const DRAG_THRESHOLD = 8;
  const handleDayPointerDown = (e: React.PointerEvent<HTMLButtonElement>, day: Date) => {
    if (e.button !== undefined && e.button !== 0) return;
    downPosRef.current = { x: e.clientX, y: e.clientY };
    setDrag({ start: day, current: day, moved: false });
    // Capture so subsequent move events keep coming to us even when the
    // finger / pointer leaves this exact button.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore — capture is best-effort, some environments don't support it
    }
  };

  useEffect(() => {
    if (!drag) return;
    const findDayUnderPointer = (clientX: number, clientY: number): Date | null => {
      const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      if (!el) return null;
      const cell = el.closest("[data-day]") as HTMLElement | null;
      if (!cell) return null;
      const iso = cell.getAttribute("data-day");
      if (!iso) return null;
      return parseISO(iso);
    };
    const onMove = (ev: PointerEvent) => {
      const down = downPosRef.current;
      const d = dragRef.current;
      if (!d) return;
      const dist = down
        ? Math.hypot(ev.clientX - down.x, ev.clientY - down.y)
        : Number.POSITIVE_INFINITY;
      const moved = d.moved || dist > DRAG_THRESHOLD;
      const dayAt = findDayUnderPointer(ev.clientX, ev.clientY);
      const nextCurrent = dayAt ?? d.current;
      if (moved && ev.cancelable) ev.preventDefault();
      if (moved === d.moved && nextCurrent.getTime() === d.current.getTime()) {
        return;
      }
      setDrag({ start: d.start, current: nextCurrent, moved });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      downPosRef.current = null;
      if (!d) return;
      if (!d.moved) {
        setSelectionStart(d.start);
        setSelectionEnd(d.start);
        return;
      }
      const a = d.start;
      const b = d.current;
      if (a <= b) {
        setSelectionStart(a);
        setSelectionEnd(b);
      } else {
        setSelectionStart(b);
        setSelectionEnd(a);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build array of calendar days
  const days = useMemo(() => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);
    const calStart = startOfWeek(monthStart, { weekStartsOn: 1 });
    const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });
    const result: Date[] = [];
    let day = calStart;
    while (day <= calEnd) {
      result.push(day);
      day = addDays(day, 1);
    }
    return result;
  }, [currentMonth]);

  // Map each day to its bookings
  const bookingsByDay = useMemo(() => {
    const map: Record<string, CalendarBooking[]> = {};
    for (const b of bookings) {
      const start = parseISO(b.checkIn);
      const end = addDays(parseISO(b.checkOut), -1); // checkOut is departure day
      for (const day of days) {
        if (isWithinInterval(day, { start, end })) {
          const key = format(day, "yyyy-MM-dd");
          if (!map[key]) map[key] = [];
          if (!map[key].find((x) => x.id === b.id && x.roomPosition === b.roomPosition)) {
            map[key].push(b);
          }
        }
      }
    }
    return map;
  }, [bookings, days]);

  // Map each day to its blocks. A block's endDate is exclusive (checkout-style,
  // same convention as bookings) so the last occupied day is endDate - 1.
  const blocksByDay = useMemo(() => {
    const map: Record<string, CalendarBlock[]> = {};
    for (const bl of blocks) {
      const start = parseISO(bl.startDate);
      const end = addDays(parseISO(bl.endDate), -1);
      if (end < start) continue;
      for (const day of days) {
        if (isWithinInterval(day, { start, end })) {
          const key = format(day, "yyyy-MM-dd");
          if (!map[key]) map[key] = [];
          if (!map[key].find((x) => x.id === bl.id)) {
            map[key].push(bl);
          }
        }
      }
    }
    return map;
  }, [blocks, days]);

  // While dragging past the threshold, derive everything below from the live
  // preview range so the header, nights count, and bookings/blocks list all
  // update in real time. After release `dragPreview` is null and these fall
  // back to the committed selection.
  const headerStart = drag?.moved
    ? drag.start <= drag.current
      ? drag.start
      : drag.current
    : selectionStart;
  const headerEnd = drag?.moved
    ? drag.start <= drag.current
      ? drag.current
      : drag.start
    : selectionEnd;

  // Aggregate bookings/blocks across the (preview or committed) range so the
  // user still sees what's occupied while picking dates for a booking/block.
  const rangeDays = useMemo(() => {
    if (!headerStart || !headerEnd) return [] as Date[];
    const result: Date[] = [];
    let d = headerStart;
    while (d <= headerEnd) {
      result.push(d);
      d = addDays(d, 1);
    }
    return result;
  }, [headerStart, headerEnd]);

  const selectedBookings = useMemo(() => {
    const seen = new Set<string>();
    const out: CalendarBooking[] = [];
    for (const d of rangeDays) {
      for (const b of bookingsByDay[format(d, "yyyy-MM-dd")] || []) {
        const key = `${b.id}:${b.roomPosition}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(b);
        }
      }
    }
    return out;
  }, [rangeDays, bookingsByDay]);

  const selectedBlocks = useMemo(() => {
    const seen = new Set<string>();
    const out: CalendarBlock[] = [];
    for (const d of rangeDays) {
      for (const bl of blocksByDay[format(d, "yyyy-MM-dd")] || []) {
        if (!seen.has(bl.id)) {
          seen.add(bl.id);
          out.push(bl);
        }
      }
    }
    return out;
  }, [rangeDays, blocksByDay]);

  const isRangeSelection = !!headerStart && !!headerEnd && !isSameDay(headerStart, headerEnd);
  const nights = rangeDays.length; // 1 for single-day selection, N for an N-day range

  // Calendar grid uses the same preview-or-committed bounds so the painted
  // range, the header, and the bookings/blocks list never disagree.
  const previewStart = headerStart;
  const previewEnd = headerEnd;

  // Both dates yyyy-MM-dd. endDate is exclusive checkout (last selected day +
  // 1) to match desktop drag-select semantics.
  const rangeStartStr = selectionStart ? format(selectionStart, "yyyy-MM-dd") : null;
  const rangeEndStr = selectionEnd ? format(addDays(selectionEnd, 1), "yyyy-MM-dd") : null;

  const today = new Date();

  return (
    <div className="flex flex-col h-full">
      {/* Month header */}
      <div className="bg-white border-b border-gray-200 px-4 pt-3 pb-2">
        <div className="text-center text-[11px] text-gray-400 mb-1">
          {format(currentMonth, "yyyy")}
        </div>
        <div className="flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => onMonthChange(addMonths(currentMonth, -1))}
            className="p-1.5 text-gray-500 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <h2 className="text-[15px] font-bold text-gray-900">{format(currentMonth, "MMMM")}</h2>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => onMonthChange(addMonths(currentMonth, 1))}
            className="p-1.5 text-gray-500 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="bg-white px-3 py-2">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 mb-1">
          {WEEKDAYS.map((d, i) => {
            const isWeekendCol = i >= 5;
            return (
              <div
                key={d}
                style={isWeekendCol ? { backgroundColor: "#fafafa" } : undefined}
                className="text-center text-[10px] font-medium text-gray-400 py-1 rounded"
              >
                {d}
              </div>
            );
          })}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {days.map((day) => {
            const key = format(day, "yyyy-MM-dd");
            const dayBookings = bookingsByDay[key] || [];
            const isCurrentMonth = isSameMonth(day, currentMonth);
            const isToday = isSameDay(day, today);
            const isRangeStart = !!previewStart && isSameDay(day, previewStart);
            const isRangeEnd = !!previewEnd && isSameDay(day, previewEnd);
            const isWithinRange =
              !!previewStart && !!previewEnd && day >= previewStart && day <= previewEnd;
            const isMiddle = isWithinRange && !isRangeStart && !isRangeEnd;
            const isEndpoint = isRangeStart || isRangeEnd;
            const dow = day.getDay();
            const isWeekend = dow === 0 || dow === 6;
            const hasBookings = dayBookings.length > 0;
            const hasBlocks = (blocksByDay[key] || []).length > 0;

            // Get unique channel colors for dots
            const channels = Array.from(new Set(dayBookings.map((b) => b.channel)));

            const cellBgStyle =
              !isWithinRange && !isToday && isWeekend ? { backgroundColor: "#fafafa" } : undefined;

            // Range visual: rounded pill ends + flat middle, with the same
            // primary fill on endpoints and a lighter tint inside the range.
            // Single-day selection keeps the original rounded pill look.
            let rangeClass = "";
            if (isRangeStart && isRangeEnd) {
              rangeClass = "bg-primary-500 text-white rounded-xl";
            } else if (isRangeStart) {
              rangeClass = "bg-primary-500 text-white rounded-l-xl";
            } else if (isRangeEnd) {
              rangeClass = "bg-primary-500 text-white rounded-r-xl";
            } else if (isMiddle) {
              rangeClass = "bg-primary-100 text-primary-700";
            } else if (isCurrentMonth) {
              rangeClass = "text-gray-900 rounded-xl";
            } else {
              rangeClass = "text-gray-300 rounded-xl";
            }

            return (
              <button
                key={key}
                data-day={key}
                onPointerDown={(e) => handleDayPointerDown(e, day)}
                style={{ ...cellBgStyle, touchAction: "none" }}
                className={`relative flex flex-col items-center py-1.5 transition-colors select-none ${rangeClass}`}
              >
                {isToday && !isWithinRange ? (
                  <span
                    style={{ backgroundColor: "#2563eb" }}
                    className="w-6 h-6 rounded-full flex items-center justify-center text-[13px] font-bold text-white"
                  >
                    {format(day, "d")}
                  </span>
                ) : (
                  <span className={`text-[13px] font-medium ${isEndpoint ? "font-bold" : ""}`}>
                    {format(day, "d")}
                  </span>
                )}
                {/* Booking dots (channel-colored) + a red dot when the day is blocked */}
                {(hasBookings || hasBlocks) && (
                  <div className="flex gap-0.5 mt-0.5">
                    {channels.slice(0, 3).map((ch) => (
                      <div
                        key={ch}
                        className={`w-1 h-1 rounded-full ${isEndpoint ? "bg-white/60" : getChannelBarColor(ch)}`}
                      />
                    ))}
                    {hasBlocks && (
                      <div
                        className={`w-1 h-1 rounded-full ${isEndpoint ? "bg-white/60" : "bg-red-500"}`}
                      />
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-center text-[10px] text-gray-400">
          {drag?.moved
            ? "Release to confirm range"
            : isRangeSelection
              ? "Drag again or tap a day to change"
              : "Tap a day, or drag across days for a range"}
        </p>
      </div>

      {/* Selected day / range bookings */}
      <div className="flex-1 bg-gray-50 overflow-auto">
        <div className="px-3 py-2">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="min-w-0 flex-1">
              <h3 className="text-[12px] font-semibold text-gray-700 truncate">
                {!headerStart || !headerEnd
                  ? "Select a day"
                  : isRangeSelection
                    ? `${format(headerStart, "MMM d")} – ${format(headerEnd, "MMM d")} · ${nights} nights`
                    : format(headerStart, "EEEE, MMM d")}
              </h3>
              {isRangeSelection && (
                <button
                  onClick={clearRange}
                  className="text-[10px] text-gray-400 hover:text-gray-600 underline"
                >
                  Clear range
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {rangeStartStr && rangeEndStr && (
                <button
                  type="button"
                  onClick={() => onBlockRoom(rangeStartStr, rangeEndStr)}
                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-red-600 border border-red-200 bg-white rounded-lg hover:bg-red-50 transition-colors disabled:cursor-not-allowed disabled:text-gray-400 disabled:border-gray-200"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                    />
                  </svg>
                  Block
                </button>
              )}
              <button
                type="button"
                disabled={!manualBookingAvailable}
                title={
                  !manualBookingAvailable
                    ? "Manual booking creation is not available yet"
                    : undefined
                }
                onClick={() => onNewBooking(rangeStartStr ?? undefined, rangeEndStr ?? undefined)}
                className="px-2.5 py-1 text-[11px] font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                + New
              </button>
            </div>
          </div>

          {loading ? (
            <div
              className="bg-white rounded-lg border border-gray-200 p-6 text-center"
              aria-live="polite"
            >
              <p className="text-[12px] text-gray-400">Loading bookings and blocks...</p>
            </div>
          ) : loadError ? (
            <div className="bg-white rounded-lg border border-red-200 p-6 text-center" role="alert">
              <p className="text-[12px] text-red-600">Calendar data could not be loaded.</p>
            </div>
          ) : selectedBookings.length === 0 && selectedBlocks.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
              <p className="text-[12px] text-gray-400">
                {isRangeSelection
                  ? "No bookings or blocks in this range"
                  : "No bookings or blocks on this day"}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {selectedBlocks.map((bl) => {
                const rt = roomTypes.find((r) => r.id === bl.roomTypeId);
                return (
                  <button
                    key={`block-${bl.id}`}
                    type="button"
                    onClick={() => onSelectBlock(bl)}
                    className={`w-full rounded-lg border border-dashed p-3 text-left transition-colors ${
                      bl.protected
                        ? "bg-amber-50 border-amber-200 hover:bg-amber-100"
                        : "bg-red-50 border-red-200 hover:bg-red-100"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                          bl.protected ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-600"
                        }`}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                          />
                        </svg>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div
                          className={`text-[13px] font-semibold truncate ${bl.protected ? "text-amber-700" : "text-red-700"}`}
                        >
                          {bl.protected ? "Linked inventory" : bl.reason || "Blocked"}
                        </div>
                        <div className="text-[11px] text-red-500">
                          {bl.startDate} → {bl.endDate}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span
                          className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-medium ${
                            bl.protected ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"
                          }`}
                        >
                          {bl.protected ? "Linked" : "Blocked"}
                        </span>
                        <div className="text-[10px] text-red-400 mt-0.5 truncate max-w-[90px]">
                          {bl.sourceSummary ||
                            (bl.roomId ? `#${bl.roomNumber ?? ""}` : rt?.name || "")}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
              {selectedBookings.map((b) => {
                const channelColor = getChannelBarColor(b.channel);
                return (
                  <button
                    key={`${b.id}:${b.roomPosition}`}
                    onClick={() => onSelectBooking(b)}
                    className="w-full bg-white rounded-lg border border-gray-200 p-3 text-left hover:border-gray-300 transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-8 h-8 rounded-full ${channelColor} flex items-center justify-center text-white text-[10px] font-bold shrink-0`}
                      >
                        {b.guestFirstName.charAt(0)}
                        {b.guestLastName.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold text-gray-900 truncate">
                          {b.guestFirstName} {b.guestLastName}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          {b.numberOfRooms > 1 &&
                            `Room ${b.roomPosition + 1} of ${b.numberOfRooms} · `}
                          {b.checkIn} → {b.checkOut}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <span
                          className={`inline-flex px-1.5 py-0.5 rounded text-[9px] font-medium ${
                            b.status === "confirmed"
                              ? "bg-green-100 text-green-700"
                              : b.status === "pending"
                                ? "bg-yellow-100 text-yellow-700"
                                : "bg-gray-100 text-gray-600"
                          }`}
                        >
                          {b.status}
                        </span>
                        <div className="text-[10px] text-gray-400 mt-0.5 capitalize">
                          {b.channel}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
