"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  format,
  addDays,
  startOfDay,
  differenceInDays,
  parseISO,
  startOfMonth,
  endOfMonth,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
} from "date-fns";
import {
  calendarService,
  CalendarData,
  CalendarRoom,
  CalendarBooking,
  CalendarBlock,
  CreateAdminBookingPayload,
} from "@/services/calendar";
import BlockModal from "@/components/calendar/BlockModal";
import BlockDetailModal from "@/components/calendar/BlockDetailModal";
import NewBookingModal from "@/components/calendar/NewBookingModal";
import BookingDetailModal from "@/components/calendar/BookingDetailModal";
import MiniDatePicker from "@/components/calendar/MiniDatePicker";
import MobileCalendar from "@/components/calendar/MobileCalendar";
import MonthView from "@/components/calendar/MonthView";
import { useTranslation } from "@/lib/i18n";
import { channexService } from "@/services/channex";
import { getChannelBarColor, normalizeChannelKey } from "@/lib/constants/statusStyles";

const VIEW_DAYS = 21;
const VIEW_MODE_STORAGE_KEY = "pms.calendar.viewMode";
const MOBILE_CALENDAR_QUERY = "(max-width: 767px)";
const CALENDAR_WRITES_AVAILABLE = false;
type ViewMode = "timeline" | "month";

const CHANNEL_LEGEND_KEYS: Array<{
  key: string;
  labelKey: string;
  color?: string;
  logo?: string;
}> = [
  { key: "direct", labelKey: "calendar.channelDirect", logo: "/vayada-logo.png" },
  { key: "airbnb", labelKey: "calendar.channelAirbnb", logo: "/logos/airbnb.svg" },
  { key: "booking.com", labelKey: "calendar.channelBookingCom", logo: "/logos/booking.svg" },
  { key: "expedia", labelKey: "calendar.channelExpedia", logo: "/logos/expedia.svg" },
  { key: "other", labelKey: "calendar.channelOther", color: "bg-gray-500" },
];

// Legend entries that are always shown regardless of channel manager state.
const ALWAYS_SHOWN_LEGEND_KEYS = new Set(["direct", "other"]);

// Resolve a booking's raw `channel` to the legend key it should light
// up. Bookings can carry historical aliases (``booking_com`` /
// ``BookingCom`` / ``booking``); ``normalizeChannelKey`` collapses those
// onto the canonical ``booking.com``. Anything not in the legend
// (Agoda, Vrbo, …) falls back to the generic ``other`` row so the bar's
// color still has a label users can decode.
const LEGEND_KEYS = new Set(CHANNEL_LEGEND_KEYS.map((c) => c.key));
const normalizeBookingChannel = (channel?: string | null): string => {
  const key = normalizeChannelKey(channel);
  return LEGEND_KEYS.has(key) ? key : "other";
};

export default function CalendarPage() {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>("timeline");
  const [startDate, setStartDate] = useState(() => startOfDay(new Date()));
  const [mobileMonth, setMobileMonth] = useState(() => startOfMonth(new Date()));
  const [isMobileViewport, setIsMobileViewport] = useState<boolean | null>(null);
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showBlockModal, setShowBlockModal] = useState(false);
  const [showNewBookingModal, setShowNewBookingModal] = useState(false);
  const [selectedBookingId, setSelectedBookingId] = useState<string | null>(null);
  const [selectedBlock, setSelectedBlock] = useState<CalendarBlock | null>(null);
  // Mobile-only: the date range selected in MobileCalendar before opening
  // either modal. `startDate` and `endDate` follow the desktop convention
  // (endDate is exclusive checkout). Desktop uses `prefill` instead, which
  // also carries a `roomId`.
  const [mobilePrefill, setMobilePrefill] = useState<{
    startDate: string;
    endDate: string;
  } | null>(null);
  const [connectedChannelKeys, setConnectedChannelKeys] = useState<Set<string> | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);

  // Reorder mode state. When `reorderMode` is true, the Calendar header is
  // replaced with Cancel / Save order, the grid is rendered but not
  // interactive, and `localRooms` holds the in-progress order. `localRooms`
  // is null when not reordering — the grid then reads order from `data.rooms`.
  const [showRoomViewMenu, setShowRoomViewMenu] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  const [localRooms, setLocalRooms] = useState<CalendarRoom[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const roomViewMenuRef = useRef<HTMLDivElement | null>(null);
  const latestFetchRef = useRef(0);

  // Drag-to-select state for creating bookings/blocks by dragging across day cells
  const [drag, setDrag] = useState<{
    roomId: string;
    rectLeft: number;
    rectWidth: number;
    startIdx: number;
    endIdx: number;
  } | null>(null);
  const [prefill, setPrefill] = useState<{
    roomId: string;
    startDate: string;
    endDate: string;
    x: number;
    y: number;
  } | null>(null);
  const dragActive = drag !== null;

  const endDate = useMemo(() => addDays(startDate, VIEW_DAYS), [startDate]);
  const dates = useMemo(
    () => Array.from({ length: VIEW_DAYS }, (_, i) => addDays(startDate, i)),
    [startDate],
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_CALENDAR_QUERY);
    const updateViewport = () => setIsMobileViewport(mediaQuery.matches);
    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  // Mobile shows a complete month grid, including the adjacent days that fill
  // its first and last weeks. Desktop keeps its existing timeline/month ranges.
  const fetchRange = useMemo(() => {
    if (isMobileViewport) {
      return {
        start: startOfWeek(startOfMonth(mobileMonth), { weekStartsOn: 1 }),
        end: addDays(endOfWeek(endOfMonth(mobileMonth), { weekStartsOn: 1 }), 1),
      };
    }
    if (viewMode === "month") {
      const mStart = startOfMonth(startDate);
      const mEnd = addDays(endOfMonth(startDate), 1);
      return { start: mStart, end: mEnd };
    }
    return { start: startDate, end: endDate };
  }, [isMobileViewport, mobileMonth, viewMode, startDate, endDate]);

  const fetchData = useCallback(async () => {
    if (isMobileViewport === null) return;
    const fetchId = ++latestFetchRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const nextData = await calendarService.getCalendarData(
        format(fetchRange.start, "yyyy-MM-dd"),
        format(fetchRange.end, "yyyy-MM-dd"),
      );
      if (latestFetchRef.current === fetchId) setData(nextData);
    } catch (error) {
      console.error(error);
      if (latestFetchRef.current === fetchId) setLoadError(true);
    } finally {
      if (latestFetchRef.current === fetchId) setLoading(false);
    }
  }, [fetchRange, isMobileViewport]);

  // Restore view mode from session on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const saved = window.sessionStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (saved === "month" || saved === "timeline") {
        setViewMode(saved);
        if (saved === "month") {
          setStartDate((d) => startOfMonth(d));
        }
      }
    } catch {
      // sessionStorage may be unavailable (private mode, SSR) — ignore
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  useEffect(() => {
    channexService
      .listChannels()
      .then(({ channels }) => {
        setConnectedChannelKeys(new Set(channels.map((c) => c.key)));
      })
      .catch(() => setConnectedChannelKeys(new Set()));
  }, []);

  const visibleLegendKeys = useMemo(() => {
    const fromBookings = new Set<string>();
    if (data) {
      for (const b of data.bookings) fromBookings.add(normalizeBookingChannel(b.channel));
    }
    return CHANNEL_LEGEND_KEYS.filter(
      (ch) =>
        ALWAYS_SHOWN_LEGEND_KEYS.has(ch.key) ||
        fromBookings.has(ch.key) ||
        (connectedChannelKeys?.has(ch.key) ?? false),
    );
  }, [connectedChannelKeys, data]);

  const handleCellPointerDown = (e: React.PointerEvent<HTMLTableCellElement>, roomId: string) => {
    if ((e.target as HTMLElement).closest("[data-bar]")) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const idx = Math.max(
      0,
      Math.min(VIEW_DAYS - 1, Math.floor(((e.clientX - rect.left) / rect.width) * VIEW_DAYS)),
    );
    setPrefill(null);
    setDrag({ roomId, rectLeft: rect.left, rectWidth: rect.width, startIdx: idx, endIdx: idx });
  };

  useEffect(() => {
    if (!dragActive) return;
    const handleMove = (ev: PointerEvent) => {
      setDrag((d) => {
        if (!d) return d;
        const idx = Math.max(
          0,
          Math.min(
            VIEW_DAYS - 1,
            Math.floor(((ev.clientX - d.rectLeft) / d.rectWidth) * VIEW_DAYS),
          ),
        );
        return idx === d.endIdx ? d : { ...d, endIdx: idx };
      });
    };
    const handleUp = (ev: PointerEvent) => {
      setDrag((d) => {
        if (!d) return null;
        const startIdx = Math.min(d.startIdx, d.endIdx);
        const endIdx = Math.max(d.startIdx, d.endIdx);
        const sDate = format(addDays(startDate, startIdx), "yyyy-MM-dd");
        const eDate = format(addDays(startDate, endIdx + 1), "yyyy-MM-dd");
        setPrefill({
          roomId: d.roomId,
          startDate: sDate,
          endDate: eDate,
          x: ev.clientX,
          y: ev.clientY,
        });
        return null;
      });
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragActive, startDate]);

  useEffect(() => {
    if (!prefill) return;
    const handleClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-prefill-popover]")) {
        setPrefill(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [prefill]);

  const goToday = () =>
    setStartDate(viewMode === "month" ? startOfMonth(new Date()) : startOfDay(new Date()));
  const goPrev = () =>
    setStartDate((d) => (viewMode === "month" ? subMonths(d, 1) : addDays(d, -7)));
  const goNext = () =>
    setStartDate((d) => (viewMode === "month" ? addMonths(d, 1) : addDays(d, 7)));

  const switchView = (next: ViewMode) => {
    if (next === viewMode) {
      setShowRoomViewMenu(false);
      return;
    }
    // Snap startDate to the 1st of its month when entering month mode, so prev/
    // next month nav lines up. Leaving month mode keeps that same date — per
    // spec, Timeline starts on the first day of the month the user was viewing.
    if (next === "month") {
      setStartDate((d) => startOfMonth(d));
    }
    setViewMode(next);
    setShowRoomViewMenu(false);
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem(VIEW_MODE_STORAGE_KEY, next);
      } catch {
        // ignore
      }
    }
  };

  const handleCreateBlock = async (blockData: {
    roomTypeId: string;
    roomIds: string[];
    startDate: string;
    endDate: string;
    reason: string;
  }) => {
    await calendarService.createRoomBlock(blockData);
    setShowBlockModal(false);
    setPrefill(null);
    setMobilePrefill(null);
    fetchData();
  };

  // Mobile: tapping "Block" opens the shared BlockModal with the selected
  // date range pre-filled (no room pre-selected — the user picks rooms in
  // the modal, matching desktop's room/multi-room selector).
  const handleMobileBlockRoom = (startDate: string, endDate: string) => {
    setPrefill(null);
    setMobilePrefill({ startDate, endDate });
    setShowBlockModal(true);
  };

  // Mobile: tapping "+ New" opens NewBookingModal. If a date range is
  // selected on the mobile calendar, use it as check-in/check-out defaults.
  const handleMobileNewBooking = (startDate?: string, endDate?: string) => {
    setPrefill(null);
    if (startDate && endDate) {
      setMobilePrefill({ startDate, endDate });
    } else {
      setMobilePrefill(null);
    }
    setShowNewBookingModal(true);
  };

  const handleUpdateBlock = async (updates: {
    startDate: string;
    endDate: string;
    reason: string;
  }) => {
    if (!selectedBlock) return;
    await calendarService.updateRoomBlock(selectedBlock.id, updates);
    setSelectedBlock(null);
    fetchData();
  };

  const handleDeleteBlock = async () => {
    if (!selectedBlock) return;
    await calendarService.deleteRoomBlock(selectedBlock.id);
    setSelectedBlock(null);
    fetchData();
  };

  const handleCreateBooking = async (bookingData: CreateAdminBookingPayload) => {
    await calendarService.createAdminBooking(bookingData);
    setShowNewBookingModal(false);
    setPrefill(null);
    setMobilePrefill(null);
    fetchData();
  };

  // Reorder helpers (VAY-307).
  const enterReorderMode = () => {
    if (!data || data.rooms.length <= 1) return;
    setShowRoomViewMenu(false);
    setLocalRooms(data.rooms.slice());
    setReorderMode(true);
  };

  const cancelReorder = () => {
    setLocalRooms(null);
    setReorderMode(false);
  };

  const moveRoom = (idx: number, dir: -1 | 1) => {
    setLocalRooms((rooms) => {
      if (!rooms) return rooms;
      const next = idx + dir;
      if (next < 0 || next >= rooms.length) return rooms;
      const copy = rooms.slice();
      [copy[idx], copy[next]] = [copy[next], copy[idx]];
      return copy;
    });
  };

  const saveReorder = async () => {
    if (!localRooms) return;
    setSavingOrder(true);
    try {
      await calendarService.reorderRooms(localRooms.map((r) => r.id));
      setReorderMode(false);
      setLocalRooms(null);
      fetchData();
    } finally {
      setSavingOrder(false);
    }
  };

  // Whether the user has unsaved changes during reorder mode.
  const hasUnsavedOrder = useMemo(() => {
    if (!reorderMode || !localRooms || !data) return false;
    if (localRooms.length !== data.rooms.length) return true;
    return localRooms.some((r, i) => r.id !== data.rooms[i].id);
  }, [reorderMode, localRooms, data]);

  // Warn on tab close / refresh when there are unsaved order changes.
  useEffect(() => {
    if (!hasUnsavedOrder) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedOrder]);

  // Close the Room View dropdown when clicking outside.
  useEffect(() => {
    if (!showRoomViewMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!roomViewMenuRef.current?.contains(e.target as Node)) {
        setShowRoomViewMenu(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showRoomViewMenu]);

  // Calculate bar position and width relative to the visible date range
  // Bars start at the midpoint of the check-in column and end at the midpoint
  // of the check-out column, matching the standard hotel calendar convention.
  const HALF_COL = 0.5 / VIEW_DAYS; // half a day-column in fraction
  const getBarStyle = (itemStart: string, itemEnd: string) => {
    const s = parseISO(itemStart);
    const e = parseISO(itemEnd);
    const offsetDays = Math.max(0, differenceInDays(s, startDate));
    const endOffset = Math.min(VIEW_DAYS, differenceInDays(e, startDate));
    const spanDays = endOffset - offsetDays;
    if (spanDays <= 0) return null;
    const startsInView = differenceInDays(s, startDate) >= 0;
    const endsInView = differenceInDays(e, startDate) <= VIEW_DAYS;
    const leftShift = startsInView ? HALF_COL : 0;
    const rightShift = endsInView ? HALF_COL : 0;
    return {
      left: `${(offsetDays / VIEW_DAYS + leftShift) * 100}%`,
      width: `${(spanDays / VIEW_DAYS - leftShift + rightShift) * 100}%`,
    };
  };

  // Build a lookup from room type ID to room type (for category, name)
  const roomTypeMap = useMemo(() => {
    if (!data) return {};
    const map: Record<string, { name: string; category: string }> = {};
    for (const rt of data.roomTypes) {
      map[rt.id] = { name: rt.name, category: rt.category };
    }
    return map;
  }, [data]);

  // Group bookings by room ID (for assigned bookings) and room type (for unassigned)
  const bookingsByRoom = useMemo(() => {
    if (!data) return {};
    const map: Record<string, CalendarBooking[]> = {};
    for (const b of data.bookings) {
      if (b.roomId) {
        if (!map[b.roomId]) map[b.roomId] = [];
        map[b.roomId].push(b);
      }
    }
    return map;
  }, [data]);

  const unassignedBookings = useMemo(() => {
    if (!data) return [];
    return data.bookings.filter((b) => !b.roomId);
  }, [data]);

  const getInitials = (first: string, last: string) => {
    return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
  };

  // Group blocks by the room they target. Legacy blocks (roomId === null) fall
  // back to the old "first N rooms of the type" rendering for backwards compat.
  const { blocksByRoom, legacyBlocksByRoomType, roomIndexInType } = useMemo(() => {
    const byRoom: Record<string, CalendarBlock[]> = {};
    const byType: Record<string, CalendarBlock[]> = {};
    const idxMap: Record<string, number> = {};
    if (!data)
      return {
        blocksByRoom: byRoom,
        legacyBlocksByRoomType: byType,
        roomIndexInType: idxMap,
      };
    const counts: Record<string, number> = {};
    for (const room of data.rooms) {
      const idx = counts[room.roomTypeId] || 0;
      idxMap[room.id] = idx;
      counts[room.roomTypeId] = idx + 1;
    }
    for (const bl of data.blocks) {
      if (bl.roomId) {
        if (!byRoom[bl.roomId]) byRoom[bl.roomId] = [];
        byRoom[bl.roomId].push(bl);
      } else {
        if (!byType[bl.roomTypeId]) byType[bl.roomTypeId] = [];
        byType[bl.roomTypeId].push(bl);
      }
    }
    return { blocksByRoom: byRoom, legacyBlocksByRoomType: byType, roomIndexInType: idxMap };
  }, [data]);

  const allBookings = useMemo(() => data?.bookings || [], [data]);

  return (
    <div className="h-full flex flex-col">
      {/* Mobile Calendar */}
      <div className="md:hidden flex-1 flex flex-col">
        {loading && !data ? (
          <div className="p-6 animate-pulse">
            <div className="h-64 bg-gray-200 rounded" />
          </div>
        ) : (
          <MobileCalendar
            currentMonth={mobileMonth}
            bookings={allBookings}
            blocks={data?.blocks || []}
            roomTypes={data?.roomTypes || []}
            loading={loading}
            loadError={loadError}
            onMonthChange={setMobileMonth}
            onSelectBooking={(id) => setSelectedBookingId(id)}
            onNewBooking={handleMobileNewBooking}
            onBlockRoom={handleMobileBlockRoom}
            onSelectBlock={(bl) => setSelectedBlock(bl)}
            writeActionsAvailable={CALENDAR_WRITES_AVAILABLE}
          />
        )}
      </div>

      {/* Desktop Calendar */}
      <div className="hidden md:flex flex-col flex-1 p-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">{t("calendar.title")}</h1>
            <div className="relative inline-block">
              <button
                type="button"
                onClick={() => setShowDatePicker((v) => !v)}
                aria-label={t("calendar.openDatePicker")}
                aria-expanded={showDatePicker}
                className="inline-flex items-center gap-1 text-sm text-primary-600 hover:text-primary-700 underline decoration-dotted underline-offset-4"
              >
                <span>
                  {viewMode === "month" ? (
                    format(startDate, "MMMM yyyy")
                  ) : (
                    <>
                      {format(startDate, "MMM d")} &ndash;{" "}
                      {format(addDays(endDate, -1), "MMM d, yyyy")}
                    </>
                  )}
                </span>
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
              {showDatePicker && (
                <MiniDatePicker
                  value={startDate}
                  onChange={(d) => setStartDate(startOfDay(d))}
                  onClose={() => setShowDatePicker(false)}
                />
              )}
            </div>
          </div>
          {reorderMode ? (
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-700">
                {t("calendar.reorderingRooms")}
              </span>
              <button
                onClick={cancelReorder}
                disabled={savingOrder}
                className="px-4 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
              >
                {t("calendar.cancel")}
              </button>
              <button
                onClick={saveReorder}
                disabled={savingOrder || !hasUnsavedOrder}
                className="px-4 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("calendar.saveOrder")}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={goToday}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                {t("calendar.today")}
              </button>
              <button
                onClick={goPrev}
                className="px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                &larr;
              </button>
              <button
                onClick={goNext}
                className="px-2.5 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                &rarr;
              </button>
              <button
                type="button"
                disabled={!CALENDAR_WRITES_AVAILABLE}
                title={
                  !CALENDAR_WRITES_AVAILABLE ? "Room blocking is not available yet" : undefined
                }
                onClick={() => {
                  setPrefill(null);
                  setShowBlockModal(true);
                }}
                className="px-4 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400"
              >
                {t("calendar.blockRoom")}
              </button>
              <button
                type="button"
                disabled={!CALENDAR_WRITES_AVAILABLE}
                title={
                  !CALENDAR_WRITES_AVAILABLE
                    ? "Manual booking creation is not available yet"
                    : undefined
                }
                onClick={() => {
                  setPrefill(null);
                  setShowNewBookingModal(true);
                }}
                className="px-4 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {t("calendar.newBooking")}
              </button>
              {data && (
                <div className="relative" ref={roomViewMenuRef}>
                  <button
                    onClick={() => setShowRoomViewMenu((v) => !v)}
                    aria-label={t("calendar.roomViewMenu")}
                    className="p-2 text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6h16M4 12h16M4 18h16"
                      />
                    </svg>
                  </button>
                  {showRoomViewMenu && (
                    <div className="absolute right-0 mt-1 w-56 bg-white border border-gray-200 shadow-xl rounded-lg z-50 overflow-hidden">
                      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-b border-gray-200">
                        {t("calendar.view")}
                      </div>
                      <button
                        onClick={() => switchView("timeline")}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                          viewMode === "timeline"
                            ? "bg-primary-50 text-primary-700 font-medium"
                            : "text-gray-700 hover:bg-gray-50"
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
                            d="M4 6h16M4 12h10M4 18h16"
                          />
                        </svg>
                        {t("calendar.viewTimeline")}
                      </button>
                      <button
                        onClick={() => switchView("month")}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                          viewMode === "month"
                            ? "bg-primary-50 text-primary-700 font-medium"
                            : "text-gray-700 hover:bg-gray-50"
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
                            d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                        {t("calendar.viewMonth")}
                      </button>
                      {viewMode === "timeline" && data.rooms.length > 1 && (
                        <>
                          <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 bg-gray-50 border-y border-gray-200">
                            {t("calendar.roomView")}
                          </div>
                          <button
                            disabled={!CALENDAR_WRITES_AVAILABLE}
                            title={
                              !CALENDAR_WRITES_AVAILABLE
                                ? "Room reordering is not available yet"
                                : undefined
                            }
                            onClick={enterReorderMode}
                            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors flex items-center gap-2 disabled:cursor-not-allowed disabled:text-gray-400"
                          >
                            <svg
                              className="w-4 h-4 text-gray-500"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M8 9l4-4 4 4m0 6l-4 4-4-4"
                              />
                            </svg>
                            {t("calendar.reorderRooms")}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {!CALENDAR_WRITES_AVAILABLE && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
            <span>
              Calendar viewing is active. Creating bookings, blocking, and reordering rooms are not
              available yet.
            </span>
            <span className="shrink-0 rounded bg-gray-100 px-2 py-1 font-medium text-gray-500">
              View only
            </span>
          </div>
        )}

        {reorderMode && (
          <div className="mb-4 px-4 py-2.5 bg-primary-50 border border-primary-200 rounded-lg text-xs text-primary-800">
            {t("calendar.reorderHint")}
          </div>
        )}

        {/* Channel Legend */}
        <div className="flex items-center gap-4 mb-4">
          {visibleLegendKeys.map((ch) => (
            <div key={ch.key} className="flex items-center gap-1.5">
              {ch.logo ? (
                <img src={ch.logo} alt="" className="w-4 h-4" />
              ) : (
                <div className={`w-3 h-3 rounded-sm ${ch.color}`} />
              )}
              <span className="text-xs text-gray-600">{t(ch.labelKey)}</span>
            </div>
          ))}
        </div>

        {loading && !data ? (
          <div className="animate-pulse">
            <div className="h-64 bg-gray-200 rounded" />
          </div>
        ) : !data || data.rooms.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-12 text-center">
            <p className="text-gray-500">{t("calendar.noRooms")}</p>
          </div>
        ) : viewMode === "month" ? (
          <MonthView
            monthStart={startDate}
            rooms={data.rooms}
            roomTypeMap={roomTypeMap}
            bookingsByRoom={bookingsByRoom}
            blocksByRoom={blocksByRoom}
            legacyBlocksByRoomType={legacyBlocksByRoomType}
            roomIndexInType={roomIndexInType}
            onSelectBooking={(id) => setSelectedBookingId(id)}
            onSelectBlock={(bl) => setSelectedBlock(bl)}
            blockEditingAvailable={CALENDAR_WRITES_AVAILABLE}
          />
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex-1 overflow-x-auto">
            <table className="w-full min-w-[600px] md:min-w-[960px] table-fixed">
              {/* Date header */}
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="w-20 md:w-56 px-1.5 md:px-3 py-2 text-left text-[10px] md:text-xs font-medium text-gray-600 sticky left-0 bg-gray-50 z-10 border-r border-gray-200">
                    {t("calendar.roomColumn")}
                  </th>
                  {dates.map((d) => {
                    const isToday = format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
                    const dow = d.getDay();
                    const isWeekend = dow === 0 || dow === 6;
                    const headerStyle = isToday
                      ? { backgroundColor: "#eff6ff", color: "#2563eb" }
                      : isWeekend
                        ? { backgroundColor: "#fafafa" }
                        : undefined;
                    return (
                      <th
                        key={d.toISOString()}
                        style={headerStyle}
                        className={`px-0.5 py-2 text-center text-[10px] border-r border-gray-100 ${
                          isToday ? "font-bold" : "font-medium text-gray-500"
                        }`}
                      >
                        <div>{format(d, "EEE")}</div>
                        <div className={`text-xs ${isToday ? "font-bold" : "font-semibold"}`}>
                          {format(d, "d")}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {(reorderMode && localRooms ? localRooms : data.rooms).map(
                  (room, roomIdx, roomsArr) => {
                    const roomBookings = bookingsByRoom[room.id] || [];
                    const rt = roomTypeMap[room.roomTypeId];
                    const isFirst = roomIdx === 0;
                    const isLast = roomIdx === roomsArr.length - 1;
                    return (
                      <tr
                        key={room.id}
                        className={`border-b border-gray-100 ${reorderMode ? "" : "hover:bg-gray-50/50"}`}
                      >
                        <td className="px-1.5 md:px-3 py-1.5 md:py-2 sticky left-0 bg-white z-10 border-r border-gray-200">
                          <div className="flex items-center gap-2">
                            {reorderMode && (
                              <div className="flex flex-col gap-0.5">
                                <button
                                  onClick={() => moveRoom(roomIdx, -1)}
                                  disabled={isFirst}
                                  aria-label={t("calendar.moveUp")}
                                  title={t("calendar.moveUp")}
                                  className="w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                                >
                                  <svg
                                    className="w-3 h-3"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2.5}
                                      d="M5 15l7-7 7 7"
                                    />
                                  </svg>
                                </button>
                                <button
                                  onClick={() => moveRoom(roomIdx, 1)}
                                  disabled={isLast}
                                  aria-label={t("calendar.moveDown")}
                                  title={t("calendar.moveDown")}
                                  className="w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed"
                                >
                                  <svg
                                    className="w-3 h-3"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2.5}
                                      d="M19 9l-7 7-7-7"
                                    />
                                  </svg>
                                </button>
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div
                                className="text-[11px] md:text-sm font-semibold text-gray-900 break-words line-clamp-2 leading-tight"
                                title={room.roomNumber}
                              >
                                #{room.roomNumber}
                              </div>
                              <div
                                className="hidden md:block text-[10px] text-gray-500 leading-tight truncate"
                                title={
                                  rt?.category
                                    ? `${room.roomTypeName} · ${rt.category}`
                                    : room.roomTypeName
                                }
                              >
                                {room.roomTypeName}
                                {rt?.category && (
                                  <span className="text-gray-400"> &middot; {rt.category}</span>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td
                          colSpan={VIEW_DAYS}
                          className={`relative h-12 p-0 select-none touch-none ${
                            reorderMode
                              ? "pointer-events-none opacity-60"
                              : CALENDAR_WRITES_AVAILABLE
                                ? "cursor-cell"
                                : "cursor-default"
                          }`}
                          onPointerDown={(e) =>
                            CALENDAR_WRITES_AVAILABLE &&
                            !reorderMode &&
                            handleCellPointerDown(e, room.id)
                          }
                        >
                          {/* Day grid lines */}
                          <div className="absolute inset-0 flex">
                            {dates.map((d) => {
                              const isToday =
                                format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
                              const dow = d.getDay();
                              const isWeekend = dow === 0 || dow === 6;
                              const cellStyle = isToday
                                ? { backgroundColor: "#f8fbff" }
                                : isWeekend
                                  ? { backgroundColor: "#fafafa" }
                                  : undefined;
                              return (
                                <div
                                  key={d.toISOString()}
                                  style={cellStyle}
                                  className="flex-1 border-r border-gray-100"
                                />
                              );
                            })}
                          </div>
                          {/* Drag-selection overlay — persists while popover is open */}
                          {(() => {
                            let s: number | null = null;
                            let e: number | null = null;
                            if (drag && drag.roomId === room.id) {
                              s = Math.min(drag.startIdx, drag.endIdx);
                              e = Math.max(drag.startIdx, drag.endIdx);
                            } else if (prefill && prefill.roomId === room.id) {
                              const ps = differenceInDays(parseISO(prefill.startDate), startDate);
                              const pe = differenceInDays(parseISO(prefill.endDate), startDate) - 1;
                              if (pe >= 0 && ps < VIEW_DAYS) {
                                s = Math.max(0, ps);
                                e = Math.min(VIEW_DAYS - 1, pe);
                              }
                            }
                            if (s === null || e === null) return null;
                            return (
                              <div
                                className="absolute top-1 bottom-1 bg-primary-500/20 border-2 border-primary-500 rounded-md pointer-events-none z-[2]"
                                style={{
                                  left: `${(s / VIEW_DAYS) * 100}%`,
                                  width: `${((e - s + 1) / VIEW_DAYS) * 100}%`,
                                }}
                              />
                            );
                          })()}
                          {/* Block bars — per-room blocks render on their own row.
                          Legacy count-based blocks still fill the first N rooms of the type. */}
                          {[
                            ...(blocksByRoom[room.id] || []),
                            ...(legacyBlocksByRoomType[room.roomTypeId] || []).filter(
                              (bl) => (roomIndexInType[room.id] ?? 0) < bl.blockedCount,
                            ),
                          ].map((bl) => {
                            const style = getBarStyle(bl.startDate, bl.endDate);
                            if (!style) return null;
                            return (
                              <div
                                key={`block-${bl.id}`}
                                data-bar="block"
                                className="absolute top-1.5 h-8 rounded-md px-2 text-[11px] font-medium leading-8 truncate z-[1] bg-red-100 border border-red-300 border-dashed text-red-600 flex items-center gap-1 cursor-default"
                                style={style}
                                title={`Blocked: ${bl.reason || "No reason"}\n${bl.startDate} → ${bl.endDate}${
                                  bl.roomId
                                    ? `\nRoom #${bl.roomNumber ?? ""}`
                                    : `\n${bl.blockedCount} room${bl.blockedCount !== 1 ? "s" : ""}`
                                }\nBlock editing is not available yet`}
                              >
                                <svg
                                  className="w-3.5 h-3.5 flex-shrink-0"
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
                                <span className="truncate">{bl.reason || "Blocked"}</span>
                              </div>
                            );
                          })}
                          {/* Booking bars */}
                          {roomBookings.map((b) => {
                            const style = getBarStyle(b.checkIn, b.checkOut);
                            if (!style) return null;
                            const channelColor = getChannelBarColor(b.channel);
                            // VAY-403: multi-room reservation spans several rows.
                            const isMultiRoom = b.numberOfRooms > 1;
                            const multiRoomTitle = isMultiRoom
                              ? `\n${b.bookingReference} · room ${b.roomPosition + 1} of ${b.numberOfRooms}`
                              : "";
                            return (
                              <div
                                key={`${b.id}-${b.roomId ?? "na"}`}
                                data-bar="booking"
                                className={`absolute top-1.5 h-8 rounded-md px-2 text-[11px] font-medium leading-8 truncate cursor-pointer z-[1] text-white ${channelColor} hover:brightness-110 transition-all flex items-center gap-1.5 ${
                                  isMultiRoom ? "ring-1 ring-inset ring-white/50" : ""
                                }`}
                                style={style}
                                title={`${b.guestFirstName} ${b.guestLastName} (${b.status})\n${b.checkIn} → ${b.checkOut}\nChannel: ${b.channel}${multiRoomTitle}`}
                                onClick={() => setSelectedBookingId(b.id)}
                              >
                                <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[9px] font-bold flex-shrink-0">
                                  {getInitials(b.guestFirstName, b.guestLastName)}
                                </span>
                                <span className="truncate">
                                  {`${b.guestFirstName} ${b.guestLastName}`.trim()}
                                </span>
                                {isMultiRoom && (
                                  <span className="ml-auto pl-1 text-[9px] font-bold opacity-90 flex-shrink-0">
                                    ×{b.numberOfRooms}
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </td>
                      </tr>
                    );
                  },
                )}

                {/* Unassigned bookings row */}
                {unassignedBookings.length > 0 && (
                  <tr className="border-b border-gray-100 bg-amber-50/30">
                    <td className="px-1.5 md:px-3 py-1.5 md:py-2 sticky left-0 bg-amber-50/30 z-10 border-r border-gray-200">
                      <div className="text-[11px] md:text-sm font-medium text-amber-700 truncate">
                        {t("calendar.unassigned")}
                      </div>
                      <div className="hidden md:block text-[10px] text-amber-500">
                        {unassignedBookings.length} booking
                        {unassignedBookings.length !== 1 ? "s" : ""}
                      </div>
                    </td>
                    <td colSpan={VIEW_DAYS} className="relative h-12 p-0">
                      <div className="absolute inset-0 flex">
                        {dates.map((d) => {
                          const isToday =
                            format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
                          const dow = d.getDay();
                          const isWeekend = dow === 0 || dow === 6;
                          const cellStyle = isToday
                            ? { backgroundColor: "#f8fbff" }
                            : isWeekend
                              ? { backgroundColor: "#fafafa" }
                              : undefined;
                          return (
                            <div
                              key={d.toISOString()}
                              style={cellStyle}
                              className="flex-1 border-r border-gray-100"
                            />
                          );
                        })}
                      </div>
                      {unassignedBookings.map((b) => {
                        const style = getBarStyle(b.checkIn, b.checkOut);
                        if (!style) return null;
                        const channelColor = getChannelBarColor(b.channel);
                        return (
                          <div
                            key={b.id}
                            data-bar="booking"
                            className={`absolute top-1.5 h-8 rounded-md px-2 text-[11px] font-medium leading-8 truncate cursor-pointer z-[1] text-white ${channelColor} hover:brightness-110 transition-all flex items-center gap-1.5 opacity-75`}
                            style={style}
                            title={`${b.guestFirstName} ${b.guestLastName} (${b.status}) - Unassigned\n${b.checkIn} → ${b.checkOut}`}
                            onClick={() => setSelectedBookingId(b.id)}
                          >
                            <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-[9px] font-bold flex-shrink-0">
                              {getInitials(b.guestFirstName, b.guestLastName)}
                            </span>
                            <span className="truncate">
                              {`${b.guestFirstName} ${b.guestLastName}`.trim()}
                            </span>
                          </div>
                        );
                      })}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drag-selection action popover */}
      {prefill &&
        CALENDAR_WRITES_AVAILABLE &&
        !showBlockModal &&
        !showNewBookingModal &&
        data &&
        (() => {
          const room = data.rooms.find((r) => r.id === prefill.roomId);
          const nights = differenceInDays(parseISO(prefill.endDate), parseISO(prefill.startDate));
          const newBookingLabel = t("calendar.newBooking").replace(/^\+\s*/, "");
          const blockRoomLabel = t("calendar.blockRoom");
          const POPOVER_WIDTH = 240;
          const POPOVER_HEIGHT = 150;
          const vw = typeof window !== "undefined" ? window.innerWidth : 9999;
          const vh = typeof window !== "undefined" ? window.innerHeight : 9999;
          const left = Math.min(Math.max(8, prefill.x + 8), vw - POPOVER_WIDTH - 8);
          const top = Math.min(prefill.y + 8, vh - POPOVER_HEIGHT - 8);
          return (
            <div
              data-prefill-popover
              className="fixed z-50 bg-white border border-gray-200 shadow-xl rounded-xl overflow-hidden"
              style={{ left, top, width: POPOVER_WIDTH }}
            >
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200">
                <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">
                  {room ? `#${room.roomNumber}` : t("calendar.roomColumn")}
                </div>
                <div className="text-xs text-gray-900 font-medium mt-0.5">
                  {format(parseISO(prefill.startDate), "MMM d")}
                  <span className="text-gray-400 mx-1">→</span>
                  {format(parseISO(prefill.endDate), "MMM d")}
                  <span className="text-gray-400">
                    {" "}
                    · {nights} night{nights !== 1 ? "s" : ""}
                  </span>
                </div>
              </div>
              <div className="p-1">
                <button
                  onClick={() => setShowNewBookingModal(true)}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 text-sm text-left text-gray-700 hover:bg-primary-50 hover:text-primary-700 rounded-md transition-colors"
                >
                  <span className="w-7 h-7 flex items-center justify-center rounded-md bg-primary-50 text-primary-600">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                  </span>
                  <span className="font-medium">{newBookingLabel}</span>
                </button>
                <button
                  onClick={() => setShowBlockModal(true)}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 text-sm text-left text-gray-700 hover:bg-red-50 hover:text-red-700 rounded-md transition-colors"
                >
                  <span className="w-7 h-7 flex items-center justify-center rounded-md bg-red-50 text-red-500">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
                      />
                    </svg>
                  </span>
                  <span className="font-medium">{blockRoomLabel}</span>
                </button>
              </div>
            </div>
          );
        })()}

      {/* Block Modal */}
      {CALENDAR_WRITES_AVAILABLE && showBlockModal && data && (
        <BlockModal
          roomTypes={data.roomTypes}
          rooms={data.rooms}
          bookings={data.bookings}
          onSubmit={handleCreateBlock}
          onClose={() => {
            setShowBlockModal(false);
            setPrefill(null);
            setMobilePrefill(null);
          }}
          initialStartDate={prefill?.startDate ?? mobilePrefill?.startDate ?? undefined}
          initialEndDate={prefill?.endDate ?? mobilePrefill?.endDate ?? undefined}
          initialRoomTypeId={
            prefill ? data.rooms.find((r) => r.id === prefill.roomId)?.roomTypeId : undefined
          }
          initialRoomId={prefill?.roomId}
        />
      )}

      {/* New Booking Modal */}
      {CALENDAR_WRITES_AVAILABLE && showNewBookingModal && data && (
        <NewBookingModal
          roomTypes={data.roomTypes}
          rooms={data.rooms}
          onSubmit={handleCreateBooking}
          onClose={() => {
            setShowNewBookingModal(false);
            setPrefill(null);
            setMobilePrefill(null);
          }}
          initialRoomId={prefill?.roomId}
          initialCheckIn={prefill?.startDate ?? mobilePrefill?.startDate}
          initialCheckOut={prefill?.endDate ?? mobilePrefill?.endDate}
          connectedChannelKeys={connectedChannelKeys}
        />
      )}

      {/* Block Detail Modal */}
      {CALENDAR_WRITES_AVAILABLE && selectedBlock && data && (
        <BlockDetailModal
          block={selectedBlock}
          roomTypes={data.roomTypes}
          onSave={handleUpdateBlock}
          onDelete={handleDeleteBlock}
          onClose={() => setSelectedBlock(null)}
        />
      )}

      {/* Booking Detail Modal */}
      {selectedBookingId && (
        <BookingDetailModal
          bookingId={selectedBookingId}
          onClose={() => setSelectedBookingId(null)}
          onStatusChange={fetchData}
          rooms={data?.rooms}
          bookings={data?.bookings}
        />
      )}
    </div>
  );
}
