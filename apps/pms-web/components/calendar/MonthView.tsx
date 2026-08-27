"use client";

import { useMemo } from "react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  parseISO,
} from "date-fns";
import { CalendarRoom, CalendarBooking, CalendarBlock } from "@/services/calendar";
import { getChannelBarColor } from "@/lib/constants/statusStyles";

const WEEKDAY_HEADERS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface MonthViewProps {
  monthStart: Date;
  rooms: CalendarRoom[];
  roomTypeMap: Record<string, { name: string; category: string }>;
  bookingsByRoom: Record<string, CalendarBooking[]>;
  unassignedBookings: CalendarBooking[];
  blocksByRoom: Record<string, CalendarBlock[]>;
  legacyBlocksByRoomType: Record<string, CalendarBlock[]>;
  roomIndexInType: Record<string, number>;
  onSelectBooking: (booking: CalendarBooking) => void;
  onSelectBlock: (block: CalendarBlock) => void;
  blockEditingAvailable?: boolean;
}

const getInitials = (first: string, last: string) =>
  `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();

// A day belongs to a booking iff checkIn <= day < checkOut.
// Checkout day itself is not occupied (standard hotel convention).
const dayInRange = (day: Date, startISO: string, endISO: string) => {
  const s = parseISO(startISO);
  const e = parseISO(endISO);
  return day >= s && day < e;
};

export default function MonthView({
  monthStart,
  rooms,
  roomTypeMap,
  bookingsByRoom,
  unassignedBookings,
  blocksByRoom,
  legacyBlocksByRoomType,
  roomIndexInType,
  onSelectBooking,
  onSelectBlock,
  blockEditingAvailable = true,
}: MonthViewProps) {
  const days = useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(monthStart), { weekStartsOn: 0 });
    const gridEnd = endOfWeek(endOfMonth(monthStart), { weekStartsOn: 0 });
    return eachDayOfInterval({ start: gridStart, end: gridEnd });
  }, [monthStart]);

  const today = new Date();
  // prettier-ignore
  const displayedRooms = unassignedBookings.length ? [...rooms, { id: "", roomTypeId: "", roomTypeName: "Unassigned", roomNumber: "—", floor: "", status: "unassigned", baseRate: 0, currency: "EUR", maxOccupancy: 0, size: 0 }] : rooms;

  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden flex-1 overflow-y-auto">
      {/* Weekday headers — sticky at top of scroll area */}
      <div className="sticky top-0 z-20 grid grid-cols-7 bg-gray-50 border-b border-gray-200">
        {WEEKDAY_HEADERS.map((wd) => (
          <div key={wd} className="px-2 py-2 text-center text-[11px] font-medium text-gray-600">
            {wd}
          </div>
        ))}
      </div>

      {displayedRooms.map((room) => {
        const rt = roomTypeMap[room.roomTypeId];
        const roomBookings = room.id ? bookingsByRoom[room.id] || [] : unassignedBookings;
        const roomBlocks = [
          ...(blocksByRoom[room.id] || []),
          ...(legacyBlocksByRoomType[room.roomTypeId] || []).filter(
            (bl) => (roomIndexInType[room.id] ?? 0) < bl.blockedCount,
          ),
        ];

        return (
          <section key={room.id} className="border-b border-gray-200 last:border-b-0">
            {/* Room header row */}
            <div className="px-3 py-2 bg-gray-100 border-b border-gray-200">
              <div className="text-sm font-semibold text-gray-900">
                #{room.roomNumber}
                <span className="text-gray-500 font-normal"> &middot; {room.roomTypeName}</span>
                {rt?.category && (
                  <span className="text-gray-400 font-normal"> &middot; {rt.category}</span>
                )}
              </div>
            </div>

            {/* Month grid */}
            <div className="grid grid-cols-7">
              {days.map((day) => {
                const inMonth = isSameMonth(day, monthStart);
                const isToday = isSameDay(day, today);
                const dow = day.getDay();
                const isWeekend = dow === 0 || dow === 6;

                const dayBookings = inMonth
                  ? roomBookings.filter((b) => dayInRange(day, b.checkIn, b.checkOut))
                  : [];
                const dayBlocks = inMonth
                  ? roomBlocks.filter((bl) => dayInRange(day, bl.startDate, bl.endDate))
                  : [];

                return (
                  <div
                    key={day.toISOString()}
                    className={`relative min-h-[88px] p-1 border-r border-b border-gray-100 last:border-r-0 ${
                      !inMonth ? "bg-white" : isWeekend ? "bg-gray-50" : "bg-white"
                    }`}
                  >
                    {inMonth && (
                      <>
                        <div className="flex items-start">
                          {isToday ? (
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-primary-600 text-white text-[11px] font-semibold">
                              {format(day, "d")}
                            </span>
                          ) : (
                            <span className="text-[11px] font-medium text-gray-700 px-1">
                              {format(day, "d")}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 space-y-0.5">
                          {dayBlocks.map((bl) => (
                            <button
                              key={`block-${bl.id}-${day.toISOString()}`}
                              type="button"
                              disabled={!blockEditingAvailable && !bl.protected}
                              onClick={() => onSelectBlock(bl)}
                              title={
                                blockEditingAvailable || bl.protected
                                  ? `${bl.protected ? "Linked" : "Blocked"}: ${bl.sourceSummary || bl.reason || "No reason"}\n${bl.startDate} → ${bl.endDate}`
                                  : "Block editing is not available yet"
                              }
                              className={`w-full flex items-center gap-1 px-1 py-0.5 rounded text-[10px] font-medium border border-dashed transition-colors truncate disabled:cursor-default ${
                                bl.protected
                                  ? "bg-amber-100 border-amber-300 text-amber-700 hover:bg-amber-200"
                                  : "bg-red-100 border-red-300 text-red-700 hover:bg-red-200 disabled:hover:bg-red-100"
                              }`}
                            >
                              <svg
                                className="w-2.5 h-2.5 flex-shrink-0"
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
                              <span className="truncate">
                                {bl.protected ? "Linked" : bl.reason || "Blocked"}
                              </span>
                            </button>
                          ))}
                          {dayBookings.map((b) => {
                            const channelColor = getChannelBarColor(b.channel);
                            // VAY-403: a multi-room booking spans several room
                            // rows. Tag every bar with its reference + a ×N
                            // count so staff read them as ONE reservation
                            // (which room of N is shown via roomPosition).
                            const isMultiRoom = b.numberOfRooms > 1;
                            const multiRoomTitle = isMultiRoom
                              ? `\n${b.bookingReference} · room ${b.roomPosition + 1} of ${b.numberOfRooms}`
                              : "";
                            return (
                              <button
                                key={`booking-${b.id}-${b.roomPosition}-${day.toISOString()}`}
                                type="button"
                                onClick={() => onSelectBooking(b)}
                                title={`${b.guestFirstName} ${b.guestLastName} (${b.status})\n${b.checkIn} → ${b.checkOut}\nChannel: ${b.channel}${multiRoomTitle}`}
                                className={`w-full flex items-center gap-1 px-1 py-0.5 rounded text-[10px] font-medium text-white ${channelColor} hover:brightness-110 transition-all truncate ${
                                  isMultiRoom ? "ring-1 ring-inset ring-white/50" : ""
                                }`}
                              >
                                <span className="w-3.5 h-3.5 rounded-full bg-white/25 flex items-center justify-center text-[8px] font-bold flex-shrink-0">
                                  {getInitials(b.guestFirstName, b.guestLastName)}
                                </span>
                                <span className="truncate">
                                  {b.guestFirstName} {b.guestLastName}
                                </span>
                                {isMultiRoom && (
                                  <span className="ml-auto pl-1 text-[8px] font-bold opacity-90 flex-shrink-0">
                                    ×{b.numberOfRooms}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
