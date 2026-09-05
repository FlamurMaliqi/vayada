"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { hotelService } from "@/services/api/hotel";
import { useSlug } from "@/contexts/HotelContext";

import {
  calendarDatesInRange,
  replaceRestrictionsForDates,
} from "./datePickerCalendarAvailability";

interface DatePickerCalendarProps {
  open: boolean;
  onClose: () => void;
  checkIn: string | null;
  checkOut: string | null;
  onSelect: (checkIn: string, checkOut: string) => void;
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function formatMonthYear(year: number, month: number): string {
  return new Date(year, month).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function toDateString(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isSameDay(a: string, b: string): boolean {
  return a === b;
}

function isBeforeDate(a: string, b: string): boolean {
  return new Date(a) < new Date(b);
}

function isAfterDate(a: string, b: string): boolean {
  return new Date(a) > new Date(b);
}

function isBetween(date: string, start: string, end: string): boolean {
  const d = new Date(date);
  return d > new Date(start) && d < new Date(end);
}

function isBeforeToday(dateStr: string): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dateStr) < today;
}

function getTodayString(): string {
  const t = new Date();
  return toDateString(t.getFullYear(), t.getMonth(), t.getDate());
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hasUnavailableStayNight(
  checkIn: string,
  checkOut: string,
  unavailableDates: Set<string>,
): boolean {
  let current = checkIn;
  while (isBeforeDate(current, checkOut)) {
    if (unavailableDates.has(current)) return true;
    current = addDays(current, 1);
  }
  return false;
}

const DAY_LABELS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

type AvailabilityStatus = "loading" | "ready" | "failed";

function MonthGrid({
  year,
  month,
  checkIn,
  checkOut,
  hoverDate,
  onDayClick,
  onDayHover,
  unavailableDates,
  minCheckOut,
  minStayNights,
  maxCheckOut,
  maxStayNights,
  selectionState,
  availabilityStatus,
  validCheckOutsByArrival,
  minStayByArrival,
  onExplain,
}: {
  year: number;
  month: number;
  checkIn: string | null;
  checkOut: string | null;
  hoverDate: string | null;
  onDayClick: (date: string) => void;
  onDayHover: (date: string | null) => void;
  unavailableDates: Set<string>;
  minCheckOut: string | null;
  minStayNights: number;
  maxCheckOut: string | null;
  maxStayNights: number | null;
  selectionState: "selectCheckIn" | "selectCheckOut";
  availabilityStatus: AvailabilityStatus;
  validCheckOutsByArrival?: Record<string, string[]>;
  minStayByArrival: Record<string, number>;
  onExplain: (message: string) => void;
}) {
  const t = useTranslations("home");
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const today = getTodayString();

  const cells: { day: number; dateStr: string; isCurrentMonth: boolean }[] = [];

  // Empty cells for days before the 1st
  for (let i = 0; i < firstDay; i++) {
    cells.push({ day: 0, dateStr: "", isCurrentMonth: false });
  }

  // Current month days
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({
      day: d,
      dateStr: toDateString(year, month, d),
      isCurrentMonth: true,
    });
  }

  // Empty cells to complete last row
  const remaining = 7 - (cells.length % 7);
  if (remaining < 7) {
    for (let i = 0; i < remaining; i++) {
      cells.push({ day: 0, dateStr: "", isCurrentMonth: false });
    }
  }

  // Determine the effective end for range highlight (hover preview or checkOut)
  const rangeEnd = checkIn && !checkOut && hoverDate ? hoverDate : checkOut;

  return (
    <div className="w-full max-w-[252px] mx-auto">
      {/* Month title */}
      <h3 className="text-sm font-semibold text-gray-900 text-center mb-3">
        {formatMonthYear(year, month)}
      </h3>

      {/* Day labels */}
      <div className="grid grid-cols-7 mb-1">
        {DAY_LABELS.map((label) => (
          <div key={label} className="text-center text-xs font-medium text-gray-400 py-1">
            {label}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {cells.map((cell, idx) => {
          // Empty placeholder cell
          if (!cell.isCurrentMonth) {
            return <div key={idx} className="w-9 h-9" />;
          }

          const isPast = isBeforeToday(cell.dateStr) && !isSameDay(cell.dateStr, today);
          const isToday = isSameDay(cell.dateStr, today);
          const isCheckIn = checkIn ? isSameDay(cell.dateStr, checkIn) : false;
          const isCheckOut = checkOut ? isSameDay(cell.dateStr, checkOut) : false;
          const isSelected = isCheckIn || isCheckOut;
          const isInRange =
            checkIn && rangeEnd && !isBeforeDate(rangeEnd, checkIn)
              ? isBetween(cell.dateStr, checkIn, rangeEnd)
              : false;
          const isSelectingCheckout =
            selectionState === "selectCheckOut" &&
            !!checkIn &&
            !checkOut &&
            isBeforeDate(checkIn, cell.dateStr);
          const isUnavailable =
            availabilityStatus !== "ready" ||
            (isSelectingCheckout
              ? hasUnavailableStayNight(checkIn, cell.dateStr, unavailableDates)
              : unavailableDates.has(cell.dateStr));
          const isBelowMinStay = !!(
            minCheckOut &&
            checkIn &&
            isBeforeDate(checkIn, cell.dateStr) &&
            isBeforeDate(cell.dateStr, minCheckOut)
          );
          const isAboveMaxStay = !!(
            maxCheckOut &&
            checkIn &&
            isBeforeDate(checkIn, cell.dateStr) &&
            isAfterDate(cell.dateStr, maxCheckOut)
          );
          const invalidCombination =
            validCheckOutsByArrival !== undefined &&
            (isSelectingCheckout
              ? !validCheckOutsByArrival[checkIn]?.includes(cell.dateStr)
              : !validCheckOutsByArrival[cell.dateStr]?.length);
          const isDisabled =
            isPast || isUnavailable || isBelowMinStay || isAboveMaxStay || invalidCombination;
          const minimum = isSelectingCheckout
            ? minStayNights
            : (minStayByArrival[cell.dateStr] ?? 1);
          const explanation =
            availabilityStatus === "loading"
              ? t("calendar.checkingAvailability")
              : availabilityStatus === "failed"
                ? t("calendar.availabilityUnavailableTooltip")
                : isBelowMinStay
                  ? `Minimum stay of ${minimum} nights required.`
                  : invalidCombination && !isSelectingCheckout && !isUnavailable
                    ? `No valid stay from this date in the loaded calendar. ${minimum > 1 ? `Minimum stay of ${minimum} nights required. ` : ""}Try another arrival or browse later months.`
                    : invalidCombination || isUnavailable
                      ? "No available room and rate for this stay. Try different dates."
                      : isAboveMaxStay
                        ? `Maximum stay is ${maxStayNights} nights.`
                        : "";

          return (
            <div
              key={idx}
              className={`relative flex items-center justify-center ${
                isInRange && !isUnavailable ? "bg-primary-50" : ""
              } ${isCheckIn ? "rounded-l-full bg-primary-50" : ""} ${
                isCheckOut ||
                (checkIn && !checkOut && hoverDate && isSameDay(cell.dateStr, hoverDate))
                  ? "rounded-r-full bg-primary-50"
                  : ""
              }`}
            >
              <button
                type="button"
                disabled={isPast || availabilityStatus !== "ready"}
                aria-disabled={isDisabled}
                aria-label={`${cell.dateStr}${explanation ? `. ${explanation}` : ""}`}
                onClick={() => (isDisabled ? onExplain(explanation) : onDayClick(cell.dateStr))}
                onFocus={() => onExplain(explanation)}
                onMouseEnter={() => {
                  if (!isDisabled) onDayHover(cell.dateStr);
                }}
                onMouseLeave={() => onDayHover(null)}
                title={explanation || undefined}
                className={`w-full max-w-9 aspect-square flex items-center justify-center text-sm rounded-full transition-colors relative z-10 ${
                  isDisabled
                    ? isUnavailable
                      ? "text-gray-300 cursor-default bg-gray-100 line-through decoration-red-300"
                      : "text-gray-300 cursor-default line-through decoration-gray-400"
                    : isSelected
                      ? "bg-primary-600 text-white font-bold"
                      : isToday
                        ? "border-2 border-primary-400 text-primary-700 font-semibold"
                        : "text-gray-800 hover:bg-primary-100 cursor-pointer font-medium"
                }`}
              >
                {cell.day}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function DatePickerCalendar({
  open,
  onClose,
  checkIn,
  checkOut,
  onSelect,
}: DatePickerCalendarProps) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useTranslations("home");
  const { slug } = useSlug();
  const [explanation, setExplanation] = useState("");
  const [validCheckOutsByArrival, setValidCheckOutsByArrival] = useState<
    Record<string, string[]> | undefined
  >();
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [selectionState, setSelectionState] = useState<"selectCheckIn" | "selectCheckOut">(
    checkIn ? "selectCheckOut" : "selectCheckIn",
  );
  const [tempCheckIn, setTempCheckIn] = useState<string | null>(checkIn);
  const [tempCheckOut, setTempCheckOut] = useState<string | null>(checkOut);
  const [unavailableDates, setUnavailableDates] = useState<Set<string>>(new Set());
  const [minStayByArrival, setMinStayByArrival] = useState<Record<string, number>>({});
  const [maxStayByArrival, setMaxStayByArrival] = useState<Record<string, number>>({});
  const [availabilityStatus, setAvailabilityStatus] = useState<AvailabilityStatus>("loading");

  // Calendar months
  const now = new Date();
  const [baseMonth, setBaseMonth] = useState(now.getMonth());
  const [baseYear, setBaseYear] = useState(now.getFullYear());

  const secondMonth = baseMonth === 11 ? 0 : baseMonth + 1;
  const secondYear = baseMonth === 11 ? baseYear + 1 : baseYear;

  // Reset temp state and navigate to correct month when opening
  useEffect(() => {
    if (open) {
      setAvailabilityStatus("loading");
      setExplanation("");
      setTempCheckIn(checkIn);
      setTempCheckOut(checkOut);
      setSelectionState(
        checkIn && checkOut ? "selectCheckIn" : checkIn ? "selectCheckOut" : "selectCheckIn",
      );
      // Navigate calendar to the check-in month (or current month if no check-in)
      if (checkIn) {
        const d = new Date(checkIn);
        setBaseMonth(d.getMonth());
        setBaseYear(d.getFullYear());
      } else {
        const now = new Date();
        setBaseMonth(now.getMonth());
        setBaseYear(now.getFullYear());
      }
    }
  }, [open, checkIn, checkOut]);

  // Fetch unavailable dates for the visible months
  useEffect(() => {
    if (!open) return;
    const visibleStart = toDateString(baseYear, baseMonth, 1);
    const start = tempCheckIn && tempCheckIn < visibleStart ? tempCheckIn : visibleStart;
    const endMonth = baseMonth === 11 ? 0 : baseMonth + 1;
    const endYear = baseMonth === 11 ? baseYear + 1 : baseYear;
    const lastDay = getDaysInMonth(endYear, endMonth);
    const end = addDays(toDateString(endYear, endMonth, lastDay), 32);
    const requestedDates = calendarDatesInRange(start, end);
    let cancelled = false;

    setAvailabilityStatus("loading");
    setUnavailableDates(new Set(requestedDates));
    if (!slug) {
      setAvailabilityStatus("failed");
      return;
    }

    hotelService
      .getUnavailableDates(slug, start, end)
      .then(
        ({
          dates,
          minStayByArrival,
          maxStayByArrival,
          validCheckOutsByArrival,
          availabilityUnavailable,
        }) => {
          if (cancelled) return;
          setUnavailableDates(new Set(dates));
          setValidCheckOutsByArrival(validCheckOutsByArrival);
          setMinStayByArrival((prev) =>
            replaceRestrictionsForDates(prev, requestedDates, minStayByArrival),
          );
          setMaxStayByArrival((prev) =>
            replaceRestrictionsForDates(prev, requestedDates, maxStayByArrival),
          );
          setAvailabilityStatus(availabilityUnavailable ? "failed" : "ready");
        },
      )
      .catch(() => {
        if (cancelled) return;
        setUnavailableDates(new Set(requestedDates));
        setAvailabilityStatus("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [open, slug, baseMonth, baseYear, tempCheckIn]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleDayClick = (date: string) => {
    setExplanation("");
    if (selectionState === "selectCheckIn") {
      setTempCheckIn(date);
      setTempCheckOut(null);
      setSelectionState("selectCheckOut");
    } else {
      // If clicked date is before or equal to check-in, restart selection.
      // Same-day check-in/check-out (0 nights) is not allowed.
      if (tempCheckIn && (date === tempCheckIn || isBeforeDate(date, tempCheckIn))) {
        setTempCheckIn(date);
        setTempCheckOut(null);
        setSelectionState("selectCheckOut");
      } else {
        setTempCheckOut(date);
        if (tempCheckIn) {
          onSelect(tempCheckIn, date);
          onClose();
        }
      }
    }
  };

  const handlePrev = () => {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    // Don't navigate before current month
    if (baseYear === currentYear && baseMonth === currentMonth) return;
    setAvailabilityStatus("loading");
    if (baseMonth === 0) {
      setBaseMonth(11);
      setBaseYear(baseYear - 1);
    } else {
      setBaseMonth(baseMonth - 1);
    }
  };

  const handleNext = () => {
    setAvailabilityStatus("loading");
    if (baseMonth === 11) {
      setBaseMonth(0);
      setBaseYear(baseYear + 1);
    } else {
      setBaseMonth(baseMonth + 1);
    }
  };

  // Calculate nights for summary
  const nights =
    tempCheckIn && tempCheckOut
      ? Math.ceil(
          (new Date(tempCheckOut).getTime() - new Date(tempCheckIn).getTime()) /
            (1000 * 60 * 60 * 24),
        )
      : 0;

  // Disable check-out cells that would violate min-stay for the chosen arrival.
  const requiredMinStay =
    selectionState === "selectCheckOut" && tempCheckIn ? minStayByArrival[tempCheckIn] || 1 : 1;
  const minCheckOut =
    selectionState === "selectCheckOut" && tempCheckIn && requiredMinStay > 1
      ? addDays(tempCheckIn, requiredMinStay)
      : null;
  const requiredMaxStay =
    selectionState === "selectCheckOut" && tempCheckIn
      ? maxStayByArrival[tempCheckIn] || null
      : null;
  const maxCheckOut =
    selectionState === "selectCheckOut" && tempCheckIn && requiredMaxStay
      ? addDays(tempCheckIn, requiredMaxStay)
      : null;

  const visibleMinimums = Object.entries(minStayByArrival)
    .filter(
      ([date]) =>
        date >= getTodayString() &&
        date >= toDateString(baseYear, baseMonth, 1) &&
        date <= toDateString(secondYear, secondMonth, getDaysInMonth(secondYear, secondMonth)),
    )
    .map(([, minimum]) => minimum);
  const minimums = Array.from(new Set(visibleMinimums)).sort((a, b) => a - b);
  const minimumMessage =
    selectionState === "selectCheckOut" && tempCheckIn
      ? requiredMinStay > 1
        ? `Minimum stay: ${requiredMinStay} nights. Choose an available check-out date on or after ${addDays(tempCheckIn, requiredMinStay)}.`
        : ""
      : minimums.some((minimum) => minimum > 1)
        ? minimums.length === 1
          ? `Minimum stay: ${minimums[0]} nights.`
          : `Minimum stays vary by arrival date and rate: ${minimums[0]}–${minimums.at(-1)} nights. Select an arrival to see the shortest available stay.`
        : "";
  const noValidStay =
    validCheckOutsByArrival &&
    visibleMinimums.length > 0 &&
    !Object.entries(validCheckOutsByArrival).some(
      ([date, dates]) =>
        date >= getTodayString() &&
        date >= toDateString(baseYear, baseMonth, 1) &&
        date <= toDateString(secondYear, secondMonth, getDaysInMonth(secondYear, secondMonth)) &&
        dates.length,
    );

  const formatSummaryDate = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };

  return (
    <div
      ref={ref}
      className="absolute -left-4 md:left-0 top-full mt-3 bg-white rounded-2xl shadow-2xl border border-gray-100 p-4 md:p-6 z-50 w-[calc(100vw-2rem)] md:w-[640px]"
    >
      {/* Header */}
      <div className="mb-4">
        <h3 className="text-base font-bold text-gray-900">Select your dates</h3>
        <p className="text-sm text-gray-500">Prices shown are starting rates per night</p>
      </div>

      {availabilityStatus === "failed" && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800"
        >
          {t("calendar.availabilityUnavailable")}
        </p>
      )}

      {availabilityStatus === "ready" && (
        <div role="status" aria-live="polite" className="mb-4 text-sm text-gray-700 space-y-1">
          {minimumMessage && <p>{minimumMessage}</p>}
          {noValidStay && (
            <p>
              No available stay satisfies the stay requirements in these dates. Try later months.
            </p>
          )}
        </div>
      )}

      {/* Mobile nav bar */}
      <div className="flex md:hidden items-center justify-between mb-3">
        <button
          onClick={handlePrev}
          className="p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 transition-colors flex-shrink-0"
        >
          <svg
            className="w-4 h-4 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
        <button
          onClick={handleNext}
          className="p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 transition-colors flex-shrink-0"
        >
          <svg
            className="w-4 h-4 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Navigation + Calendars */}
      <div className="flex items-start md:gap-6">
        {/* Prev button - desktop only */}
        <button
          onClick={handlePrev}
          className="hidden md:block mt-1 p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 transition-colors flex-shrink-0"
        >
          <svg
            className="w-4 h-4 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>

        {/* Two month grids */}
        <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
          <MonthGrid
            year={baseYear}
            month={baseMonth}
            checkIn={tempCheckIn}
            checkOut={tempCheckOut}
            hoverDate={selectionState === "selectCheckOut" ? hoverDate : null}
            onDayClick={handleDayClick}
            onDayHover={setHoverDate}
            unavailableDates={unavailableDates}
            minCheckOut={minCheckOut}
            minStayNights={requiredMinStay}
            maxCheckOut={maxCheckOut}
            maxStayNights={requiredMaxStay}
            selectionState={selectionState}
            availabilityStatus={availabilityStatus}
            validCheckOutsByArrival={validCheckOutsByArrival}
            minStayByArrival={minStayByArrival}
            onExplain={setExplanation}
          />
          <MonthGrid
            year={secondYear}
            month={secondMonth}
            checkIn={tempCheckIn}
            checkOut={tempCheckOut}
            hoverDate={selectionState === "selectCheckOut" ? hoverDate : null}
            onDayClick={handleDayClick}
            onDayHover={setHoverDate}
            unavailableDates={unavailableDates}
            minCheckOut={minCheckOut}
            minStayNights={requiredMinStay}
            maxCheckOut={maxCheckOut}
            maxStayNights={requiredMaxStay}
            selectionState={selectionState}
            availabilityStatus={availabilityStatus}
            validCheckOutsByArrival={validCheckOutsByArrival}
            minStayByArrival={minStayByArrival}
            onExplain={setExplanation}
          />
        </div>

        {/* Next button - desktop only */}
        <button
          onClick={handleNext}
          className="hidden md:block mt-1 p-1.5 rounded-full border border-gray-200 hover:bg-gray-50 transition-colors flex-shrink-0"
        >
          <svg
            className="w-4 h-4 text-gray-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={
          explanation
            ? "fixed bottom-4 left-4 right-4 z-50 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 md:static md:mt-3"
            : ""
        }
      >
        {availabilityStatus === "ready" ? explanation : ""}
      </p>

      {/* Summary bar */}
      {tempCheckIn && (
        <div className="mt-5 pt-4 border-t border-gray-100 flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
            <svg
              className="w-5 h-5 text-primary-600"
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
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Your Stay</p>
            <p className="text-sm font-semibold text-gray-900">
              {formatSummaryDate(tempCheckIn)}
              {tempCheckOut && ` — ${formatSummaryDate(tempCheckOut)}`}
            </p>
            {nights > 0 && (
              <p className="text-xs text-gray-500">
                {nights} night{nights !== 1 ? "s" : ""}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
