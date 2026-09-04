"use client";

import { useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import type { CollaborationResponse } from "@/services/api/collaborations";
import type { TripResponse, ExternalCollaborationResponse } from "@/services/api/trips";
import { CalendarEventModal } from "./CalendarEventModal";
import { AddCollaborationModal } from "./AddCollaborationModal";
import { AddTripModal } from "./AddTripModal";
import { MONTHS_ABBR, DAYS_IN_MONTH, WEEKDAYS } from "@/lib/constants";

interface YearlyCalendarProps {
  collaborations?: CollaborationResponse[];
  trips?: TripResponse[];
  externalCollaborations?: ExternalCollaborationResponse[];
  onViewDetails: (id: string) => void;
  onDataChanged?: () => void;
  userType?: "hotel" | "creator";
}

export function YearlyCalendar({
  collaborations = [],
  trips = [],
  externalCollaborations = [],
  onViewDetails,
  onDataChanged,
  userType = "hotel",
}: YearlyCalendarProps) {
  const [year, setYear] = useState(2026);
  const [month, setMonth] = useState(0); // 0-11
  const [view, setView] = useState<"month" | "year">("year");
  const [selectedCollaboration, setSelectedCollaboration] = useState<CollaborationResponse | null>(
    null,
  );
  const [selectedTrip, setSelectedTrip] = useState<TripResponse | null>(null);
  const [selectedExternalCollaboration, setSelectedExternalCollaboration] =
    useState<ExternalCollaborationResponse | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isTripModalOpen, setIsTripModalOpen] = useState(false);

  const getDaysInMonth = (monthIndex: number, year: number) => {
    return new Date(year, monthIndex + 1, 0).getDate();
  };

  const handlePrev = () => {
    if (view === "year") {
      setYear(year - 1);
    } else {
      if (month === 0) {
        setMonth(11);
        setYear(year - 1);
      } else {
        setMonth(month - 1);
      }
    }
  };

  const handleNext = () => {
    if (view === "year") {
      setYear(year + 1);
    } else {
      if (month === 11) {
        setMonth(0);
        setYear(year + 1);
      } else {
        setMonth(month + 1);
      }
    }
  };

  const renderMonthlyGrid = () => {
    const daysInCurrentMonth = getDaysInMonth(month, year);
    const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0 = Sun

    // Create grid slots
    const slots = [];

    // Empty slots for previous month
    for (let i = 0; i < firstDayOfWeek; i++) {
      slots.push(
        <div
          key={`empty-start-${i}`}
          className="min-h-[120px] bg-gray-50/20 border border-gray-100 rounded-lg"
        ></div>,
      );
    }

    // Days for current month
    for (let d = 1; d <= daysInCurrentMonth; d++) {
      const currentDateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dayCollaborations = collaborations.filter((collaboration) => {
        const startDate = (
          collaboration.travel_date_from || collaboration.preferred_date_from
        )?.split("T")[0];
        const endDate = (collaboration.travel_date_to || collaboration.preferred_date_to)?.split(
          "T",
        )[0];
        return !!startDate && !!endDate && currentDateStr >= startDate && currentDateStr <= endDate;
      });
      const dayTrips = trips.filter(
        (trip) =>
          currentDateStr >= trip.start_date.split("T")[0] &&
          currentDateStr <= trip.end_date.split("T")[0],
      );
      const dayExternalCollaborations = externalCollaborations.filter(
        (collaboration) =>
          currentDateStr >= collaboration.start_date.split("T")[0] &&
          currentDateStr <= collaboration.end_date.split("T")[0],
      );

      slots.push(
        <div
          key={d}
          className="relative min-h-[120px] rounded-lg border border-gray-100 bg-white p-2 transition-colors hover:border-gray-200"
        >
          <span className="text-sm font-medium text-gray-700 block mb-2">{d}</span>
          <div className="space-y-1">
            {dayCollaborations.map((collaboration) => (
              <button
                key={`collaboration-${collaboration.id}`}
                type="button"
                className={`block w-full truncate rounded px-2 py-1 text-left text-xs font-medium text-white ${
                  collaboration.status === "pending"
                    ? "bg-[#64748b]"
                    : collaboration.status === "accepted"
                      ? "bg-blue-500"
                      : collaboration.status === "completed"
                        ? "bg-[#0fb981]"
                        : "bg-gray-400"
                }`}
                title={
                  userType === "creator" ? collaboration.hotel_name : collaboration.creator_name
                }
                onClick={() => setSelectedCollaboration(collaboration)}
              >
                {userType === "creator" ? collaboration.hotel_name : collaboration.creator_name}
              </button>
            ))}
            {userType === "creator" &&
              dayTrips.map((trip) => (
                <button
                  key={`trip-${trip.id}`}
                  type="button"
                  className="block w-full truncate rounded bg-amber-500 px-2 py-1 text-left text-xs font-medium text-white"
                  title={trip.name}
                  onClick={() => {
                    setSelectedTrip(trip);
                    setIsTripModalOpen(true);
                  }}
                >
                  {trip.name}
                </button>
              ))}
            {userType === "creator" &&
              dayExternalCollaborations.map((collaboration) => (
                <button
                  key={`external-${collaboration.id}`}
                  type="button"
                  className="block w-full truncate rounded bg-purple-500 px-2 py-1 text-left text-xs font-medium text-white"
                  title={collaboration.hotel_name || collaboration.title}
                  onClick={() => {
                    setSelectedExternalCollaboration(collaboration);
                    setIsAddModalOpen(true);
                  }}
                >
                  {collaboration.hotel_name || collaboration.title}
                </button>
              ))}
          </div>
        </div>,
      );
    }

    // Fill remaining slots to force grid structure if needed (optional)
    return slots;
  };

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white p-4 shadow-sm md:p-5">
      {/* Header */}
      <div className="mb-4 flex flex-col items-start justify-between gap-4 md:flex-row md:items-end">
        <div>
          <h2 className="text-base font-semibold text-gray-950">
            {userType === "creator" ? "My Calendar" : "Collaboration Calendar"}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {userType === "creator"
              ? "Manage your trips and collaborations"
              : "View all creator collaborations for the year"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* View Toggle */}
          <div className="flex items-center rounded-lg bg-gray-100 p-1 text-sm font-medium">
            <button
              onClick={() => setView("month")}
              className={`rounded-md px-3 py-1.5 transition-colors ${view === "month" ? "bg-white text-gray-950 shadow-sm" : "text-gray-500 hover:text-gray-900"}`}
            >
              Month
            </button>
            <button
              onClick={() => setView("year")}
              className={`rounded-md px-3 py-1.5 transition-colors ${view === "year" ? "bg-white text-gray-950 shadow-sm" : "text-gray-500 hover:text-gray-900"}`}
            >
              Year
            </button>
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-1">
            <button
              onClick={handlePrev}
              className="rounded-md p-1 text-gray-500 transition-colors hover:bg-white hover:text-gray-900"
            >
              <ChevronLeftIcon className="w-5 h-5" />
            </button>
            <span className="min-w-[3rem] whitespace-nowrap px-2 text-center text-sm font-semibold text-gray-950">
              {view === "year" ? year : `${MONTHS_ABBR[month]} ${year}`}
            </span>
            <button
              onClick={handleNext}
              className="rounded-md p-1 text-gray-500 transition-colors hover:bg-white hover:text-gray-900"
            >
              <ChevronRightIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </div>

      {/* Legend & Actions Row */}
      <div className="mb-5 flex flex-col items-center justify-between gap-4 border-y border-gray-100 py-3 md:flex-row">
        <div className="flex flex-wrap items-center gap-4 text-xs font-medium text-gray-600">
          <span className="text-gray-400">Status:</span>
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-[#64748b]"></span>
            <span>Negotiating</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500"></span>
            <span>Staying</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-[#0fb981]"></span>
            <span>Campaign Active</span>
          </div>
          {userType === "creator" && (
            <>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
                <span>Trip</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-purple-500"></span>
                <span>External</span>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {userType === "creator" && (
            <button
              onClick={() => {
                setSelectedTrip(null);
                setIsTripModalOpen(true);
              }}
              className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="lucide lucide-plane h-4 w-4"
              >
                <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"></path>
              </svg>
              Add Trip
            </button>
          )}
          {userType === "creator" ? (
            <button
              onClick={() => {
                setSelectedExternalCollaboration(null);
                setIsAddModalOpen(true);
              }}
              className="flex items-center gap-2 rounded-md bg-primary-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-700"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="lucide lucide-plus h-4 w-4"
              >
                <path d="M5 12h14"></path>
                <path d="M12 5v14"></path>
              </svg>
              Add Collaboration
            </button>
          ) : (
            <button
              type="button"
              disabled
              title="Adding creators outside vayada isn’t available yet."
              className="flex cursor-not-allowed items-center gap-2 rounded-md border border-gray-200 bg-gray-100 px-3 py-2 text-sm font-medium text-gray-500"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="lucide lucide-user-plus h-4 w-4"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <line x1="19" x2="19" y1="8" y2="14"></line>
                <line x1="22" x2="16" y1="11" y2="11"></line>
              </svg>
              External creators coming soon
            </button>
          )}
        </div>
      </div>

      {/* VIEW: YEARLY */}
      {view === "year" && (
        <div className="overflow-x-auto pb-4">
          <div className="min-w-[1000px]">
            {/* Days Header */}
            <div className="grid grid-cols-[80px_1fr] border-b border-gray-100">
              <div className="p-3"></div>
              <div className="grid" style={{ gridTemplateColumns: "repeat(31, minmax(0, 1fr))" }}>
                {DAYS_IN_MONTH.map((day) => (
                  <div key={day} className="text-[10px] text-gray-400 text-center py-2 font-medium">
                    {day}
                  </div>
                ))}
              </div>
            </div>

            {/* Months Rows */}
            <div className="divide-y divide-gray-50">
              {MONTHS_ABBR.map((monthName, monthIndex) => {
                const daysInMonth = getDaysInMonth(monthIndex, year);
                return (
                  <div
                    key={monthName}
                    className="grid grid-cols-[80px_1fr] group hover:bg-gray-50/50 transition-colors"
                  >
                    <div className="p-3 text-xs font-semibold text-gray-600 flex items-center border-r border-gray-50 group-hover:border-gray-100 transition-colors">
                      {monthName}
                    </div>
                    <div
                      className="grid divide-x divide-gray-50 border-r border-gray-50"
                      style={{ gridTemplateColumns: "repeat(31, minmax(0, 1fr))" }}
                    >
                      {DAYS_IN_MONTH.map((day) => {
                        const isValidDate = day <= daysInMonth;
                        const cellDate = new Date(year, monthIndex, day);
                        const yearStr = cellDate.getFullYear();
                        const monthStr = String(cellDate.getMonth() + 1).padStart(2, "0");
                        const dayStr = String(cellDate.getDate()).padStart(2, "0");
                        const currentDateStr = `${yearStr}-${monthStr}-${dayStr}`;

                        const dayEvents = isValidDate
                          ? [
                              ...collaborations.flatMap((collaboration) => {
                                const startDate = (
                                  collaboration.travel_date_from ||
                                  collaboration.preferred_date_from
                                )?.split("T")[0];
                                const endDate = (
                                  collaboration.travel_date_to || collaboration.preferred_date_to
                                )?.split("T")[0];
                                if (
                                  !startDate ||
                                  !endDate ||
                                  currentDateStr < startDate ||
                                  currentDateStr > endDate
                                ) {
                                  return [];
                                }

                                return [
                                  {
                                    key: `collaboration-${collaboration.id}`,
                                    kind: "collaboration",
                                    label:
                                      (userType === "creator"
                                        ? collaboration.hotel_name
                                        : collaboration.creator_name) || "Collaboration",
                                    startDate,
                                    endDate,
                                    colorClass:
                                      collaboration.status === "pending"
                                        ? "bg-[#64748b]"
                                        : collaboration.status === "accepted"
                                          ? "bg-blue-500"
                                          : collaboration.status === "completed"
                                            ? "bg-[#0fb981]"
                                            : "bg-gray-400",
                                    open: () => setSelectedCollaboration(collaboration),
                                  },
                                ];
                              }),
                              ...(userType === "creator"
                                ? trips.flatMap((trip) => {
                                    const startDate = trip.start_date.split("T")[0];
                                    const endDate = trip.end_date.split("T")[0];
                                    if (currentDateStr < startDate || currentDateStr > endDate) {
                                      return [];
                                    }
                                    return [
                                      {
                                        key: `trip-${trip.id}`,
                                        kind: "trip",
                                        label: trip.name,
                                        startDate,
                                        endDate,
                                        colorClass: "bg-amber-500",
                                        open: () => {
                                          setSelectedTrip(trip);
                                          setIsTripModalOpen(true);
                                        },
                                      },
                                    ];
                                  })
                                : []),
                              ...(userType === "creator"
                                ? externalCollaborations.flatMap((collaboration) => {
                                    const startDate = collaboration.start_date.split("T")[0];
                                    const endDate = collaboration.end_date.split("T")[0];
                                    if (currentDateStr < startDate || currentDateStr > endDate) {
                                      return [];
                                    }
                                    return [
                                      {
                                        key: `external-${collaboration.id}`,
                                        kind: "external collaboration",
                                        label: collaboration.hotel_name || collaboration.title,
                                        startDate,
                                        endDate,
                                        colorClass: "bg-purple-500",
                                        open: () => {
                                          setSelectedExternalCollaboration(collaboration);
                                          setIsAddModalOpen(true);
                                        },
                                      },
                                    ];
                                  })
                                : []),
                            ]
                          : [];

                        return (
                          <div
                            key={day}
                            className={`relative min-h-12 transition-colors
                              ${!isValidDate ? "bg-gray-50/30 pattern-diagonal-lines" : ""}
                              ${isValidDate && dayEvents.length === 0 ? "hover:bg-gray-100/50" : ""}
                            `}
                          >
                            {!isValidDate && (
                              <div className="w-full h-full bg-gray-50 opacity-50" />
                            )}
                            {isValidDate && (
                              <div className="flex min-h-12 flex-col gap-0.5 py-1">
                                {dayEvents.map((event) => {
                                  const isStart = currentDateStr === event.startDate;
                                  const isEnd = currentDateStr === event.endDate;
                                  return (
                                    <button
                                      key={event.key}
                                      type="button"
                                      aria-label={`Open ${event.kind}: ${event.label}`}
                                      title={event.label}
                                      onClick={event.open}
                                      className={`relative h-4 w-full text-white shadow-sm transition hover:brightness-95 focus:z-30 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1 ${event.colorClass}
                                        ${isStart ? "ml-0.5 rounded-l" : "-ml-px"}
                                        ${isEnd ? "mr-0.5 rounded-r" : ""}
                                      `}
                                    >
                                      {isStart && (
                                        <span className="pointer-events-none absolute left-1 top-1/2 z-20 min-w-max -translate-y-1/2 text-[9px] font-semibold leading-none drop-shadow-sm">
                                          {event.label}
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* VIEW: MONTHLY */}
      {view === "month" && (
        <div className="w-full">
          {/* Weekday Headers */}
          <div className="grid grid-cols-7 mb-2">
            {WEEKDAYS.map((day) => (
              <div key={day} className="text-center text-sm font-semibold text-gray-500 py-2">
                {day}
              </div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div className="grid grid-cols-7 gap-2">{renderMonthlyGrid()}</div>
        </div>
      )}

      {!collaborations.length && !trips.length && !externalCollaborations.length && (
        <div className="text-center py-8 text-xs text-gray-300 border-t border-gray-100 mt-4">
          No collaborations found for {view === "year" ? year : `${MONTHS_ABBR[month]} ${year}`}
        </div>
      )}

      <CalendarEventModal
        isOpen={!!selectedCollaboration}
        onClose={() => setSelectedCollaboration(null)}
        collaboration={selectedCollaboration}
        onViewDetails={onViewDetails}
        userType={userType}
      />

      <AddCollaborationModal
        isOpen={isAddModalOpen}
        collaboration={selectedExternalCollaboration}
        onClose={() => {
          setIsAddModalOpen(false);
          setSelectedExternalCollaboration(null);
        }}
        onCollaborationSaved={() => onDataChanged?.()}
        onCollaborationDeleted={() => onDataChanged?.()}
      />

      <AddTripModal
        isOpen={isTripModalOpen}
        trip={selectedTrip}
        onClose={() => {
          setIsTripModalOpen(false);
          setSelectedTrip(null);
        }}
        onTripSaved={() => onDataChanged?.()}
        onTripDeleted={() => onDataChanged?.()}
      />
    </div>
  );
}
