"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarRoomType,
  CalendarRoom,
  CreateAdminBookingPayload,
  calendarService,
} from "@/services/calendar";
import { formatCurrency } from "@/lib/formatCurrency";
import Modal from "@/components/Modal";
import { BookingAddon } from "@/services/bookings";
import {
  AddOnListPicker,
  SelectedAddOnSummary,
  calculateAddOnsTotal,
  clampAddOnQuantity,
} from "@/components/bookings/AddOnListPicker";

interface NewBookingModalProps {
  roomTypes: CalendarRoomType[];
  rooms: CalendarRoom[];
  onSubmit: (data: CreateAdminBookingPayload) => Promise<void>;
  onClose: () => void;
  initialRoomId?: string;
  initialCheckIn?: string;
  initialCheckOut?: string;
  connectedChannelKeys?: Set<string> | null;
}

const CHANNELS = [
  { value: "direct", label: "Direct" },
  { value: "airbnb", label: "Airbnb" },
  { value: "booking.com", label: "Booking.com" },
  { value: "expedia", label: "Expedia" },
  { value: "other", label: "Other" },
];

// Direct and Other are always offered regardless of channel-manager state.
const ALWAYS_SHOWN_CHANNELS = new Set(["direct", "other"]);

// Returns a YYYY-MM-DD string offset by the given day count.
// Parsed as local date so DST / timezone doesn't shift the result.
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return "";
  const next = new Date(y, m - 1, d + days);
  const yyyy = next.getFullYear();
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addOneDay(date: string): string {
  return addDays(date, 1);
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

function seasonContainsDate(
  season: CalendarRoomType["seasons"][number],
  dateString: string,
): boolean {
  const from = season.from?.length > 5 ? season.from.slice(5) : season.from;
  const to = season.to?.length > 5 ? season.to.slice(5) : season.to;
  if (!from || !to) return false;
  const mmdd = dateString.slice(5);
  return from > to ? mmdd >= from || mmdd <= to : mmdd >= from && mmdd <= to;
}

function parseMaxStay(value: number | string | null | undefined): number | null {
  const parsed = Number(value || 0);
  return parsed > 0 ? parsed : null;
}

function maxStayForRange(
  seasons: CalendarRoomType["seasons"],
  checkIn: string,
  checkOut: string,
): number | null {
  const limits: number[] = [];
  let current = checkIn;
  while (current < checkOut) {
    const season = seasons.find((s) => seasonContainsDate(s, current));
    const limit = parseMaxStay(season?.maxStay);
    if (limit) limits.push(limit);
    current = addOneDay(current);
  }
  return limits.length > 0 ? Math.min(...limits) : null;
}

function latestCheckoutForArrival(
  seasons: CalendarRoomType["seasons"],
  checkIn: string,
  horizonDays = 366,
): string | null {
  const limits: number[] = [];
  for (let nights = 1; nights <= horizonDays; nights += 1) {
    const stayDate = addDays(checkIn, nights - 1);
    const season = seasons.find((s) => seasonContainsDate(s, stayDate));
    const limit = parseMaxStay(season?.maxStay);
    if (limit) limits.push(limit);
    const effectiveMax = limits.length > 0 ? Math.min(...limits) : null;
    if (effectiveMax && nights > effectiveMax) {
      return addDays(checkIn, nights - 1);
    }
  }
  return limits.length > 0 ? addDays(checkIn, Math.min(...limits)) : null;
}

export default function NewBookingModal({
  roomTypes,
  rooms,
  onSubmit,
  onClose,
  initialRoomId,
  initialCheckIn,
  initialCheckOut,
  connectedChannelKeys,
}: NewBookingModalProps) {
  const visibleChannels = connectedChannelKeys
    ? CHANNELS.filter(
        (ch) => ALWAYS_SHOWN_CHANNELS.has(ch.value) || connectedChannelKeys.has(ch.value),
      )
    : CHANNELS;
  const initialRoom = (initialRoomId && rooms.find((r) => r.id === initialRoomId)) || rooms[0];
  const [roomId, setRoomId] = useState(initialRoom?.id || "");
  const [checkIn, setCheckIn] = useState(initialCheckIn || "");
  const [checkOut, setCheckOut] = useState(initialCheckOut || "");
  const [guestFirstName, setGuestFirstName] = useState("");
  const [guestLastName, setGuestLastName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [nightlyRate, setNightlyRate] = useState<string>("");
  // Booking-engine-resolved rate for the current room + check-in. Drives the
  // pre-fill and the placeholder so the user sees the same price the guest
  // would have been quoted (seasons / daily overrides / weekend surcharge).
  const [resolvedRate, setResolvedRate] = useState<number | null>(null);
  // Once the user types in the rate field we stop overwriting it from the
  // backend so date/room changes don't clobber a deliberate edit.
  const userEditedRate = useRef(false);
  const [channel, setChannel] = useState("direct");
  const [specialRequests, setSpecialRequests] = useState("");
  const [availableAddons, setAvailableAddons] = useState<BookingAddon[]>([]);
  const [addonsLoading, setAddonsLoading] = useState(false);
  const [addonsOpen, setAddonsOpen] = useState(false);
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>([]);
  const [addonQuantities, setAddonQuantities] = useState<Record<string, number>>({});
  const [addonNotice, setAddonNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [unavailableLinkedRoomTypeIds, setUnavailableLinkedRoomTypeIds] = useState<Set<string>>(
    new Set(),
  );
  const [linkedAvailabilityLoading, setLinkedAvailabilityLoading] = useState(false);

  const selectedRoom = rooms.find((r) => r.id === roomId);
  const selectedRoomType = roomTypes.find((rt) => rt.id === selectedRoom?.roomTypeId);
  const selectableRooms = rooms.filter(
    (room) => !unavailableLinkedRoomTypeIds.has(room.roomTypeId),
  );

  useEffect(() => {
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      setUnavailableLinkedRoomTypeIds(new Set());
      setLinkedAvailabilityLoading(false);
      return;
    }

    let cancelled = false;
    setLinkedAvailabilityLoading(true);
    calendarService
      .getUnavailableLinkedRoomTypeIds(checkIn, checkOut)
      .then((ids) => {
        if (cancelled) return;
        const unavailable = new Set(ids);
        setUnavailableLinkedRoomTypeIds(unavailable);
        setRoomId((current) => {
          const currentRoom = rooms.find((room) => room.id === current);
          if (currentRoom && !unavailable.has(currentRoom.roomTypeId)) return current;
          return rooms.find((room) => !unavailable.has(room.roomTypeId))?.id || "";
        });
      })
      .catch(() => {
        if (!cancelled) setUnavailableLinkedRoomTypeIds(new Set());
      })
      .finally(() => {
        if (!cancelled) setLinkedAvailabilityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [checkIn, checkOut, rooms]);

  // Fetch the booking-engine resolved rate whenever the room type or check-in
  // date changes. Falls back silently to the room type's baseRate on failure.
  useEffect(() => {
    if (!selectedRoomType?.id || !checkIn) return;
    let cancelled = false;
    calendarService
      .getResolvedRate(selectedRoomType.id, checkIn)
      .then((res) => {
        if (cancelled) return;
        setResolvedRate(res.nightlyRate);
        if (!userEditedRate.current) {
          setNightlyRate(String(res.nightlyRate));
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Fall back to baseRate so the field is still useful if the API fails.
        const fallback = selectedRoomType.baseRate;
        setResolvedRate(fallback);
        if (!userEditedRate.current) {
          setNightlyRate(String(fallback));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRoomType?.id, checkIn]);

  useEffect(() => {
    if (!roomId) {
      setAvailableAddons([]);
      setSelectedAddonIds([]);
      setAddonQuantities({});
      return;
    }
    let cancelled = false;
    setAddonsLoading(true);
    calendarService
      .listAvailableAddons(roomId)
      .then((addons) => {
        if (cancelled) return;
        setAvailableAddons(addons);
        const availableIds = new Set(addons.map((addon) => addon.id));
        setSelectedAddonIds((prev) => {
          const next = prev.filter((id) => availableIds.has(id));
          if (next.length !== prev.length) {
            setAddonNotice("Unavailable add-ons were removed for the selected room.");
          }
          return next;
        });
        setAddonQuantities((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([id]) => availableIds.has(id))),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setAvailableAddons([]);
        setSelectedAddonIds([]);
        setAddonQuantities({});
        setAddonNotice("Unavailable add-ons were removed for the selected room.");
      })
      .finally(() => {
        if (!cancelled) setAddonsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, checkIn, checkOut]);

  const handleRoomChange = (newRoomId: string) => {
    setRoomId(newRoomId);
  };

  const handleCheckInChange = (newCheckIn: string) => {
    setCheckIn(newCheckIn);
    if (newCheckIn && (!checkOut || checkOut <= newCheckIn)) {
      setCheckOut(addOneDay(newCheckIn));
    }
  };

  // Group rooms by room type for the dropdown
  const roomsByType: Record<string, CalendarRoom[]> = {};
  for (const r of selectableRooms) {
    if (!roomsByType[r.roomTypeId]) roomsByType[r.roomTypeId] = [];
    roomsByType[r.roomTypeId].push(r);
  }

  const nights = nightsBetween(checkIn, checkOut);
  const maxStayLimit =
    selectedRoomType && checkIn && checkOut
      ? maxStayForRange(selectedRoomType.seasons || [], checkIn, checkOut)
      : null;
  const exceedsMaxStay = maxStayLimit !== null && nights > maxStayLimit;
  const checkoutMaxDate =
    selectedRoomType && checkIn
      ? latestCheckoutForArrival(selectedRoomType.seasons || [], checkIn)
      : null;
  const totalGuests = adults + children;
  const overOccupancy = selectedRoomType != null && totalGuests > selectedRoomType.maxOccupancy;
  const rateNum = nightlyRate ? parseFloat(nightlyRate) : null;
  const total = useMemo(() => {
    if (rateNum === null || Number.isNaN(rateNum) || nights === 0) return null;
    return (
      rateNum * nights +
      calculateAddOnsTotal(availableAddons, selectedAddonIds, addonQuantities, nights, adults)
    );
  }, [rateNum, nights, availableAddons, selectedAddonIds, addonQuantities, adults]);
  const rateMatchesResolved =
    resolvedRate !== null && rateNum !== null && Math.abs(rateNum - resolvedRate) < 0.005;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!checkIn || !checkOut) {
      setError("Please select both check-in and check-out dates");
      return;
    }
    if (checkOut <= checkIn) {
      setError("Check-out must be after check-in");
      return;
    }
    if (exceedsMaxStay && maxStayLimit) {
      setError(
        `This room has a maximum stay of ${maxStayLimit} nights for the selected dates. Please shorten your stay.`,
      );
      return;
    }
    if (!guestFirstName.trim() || !guestLastName.trim()) {
      setError("Guest first and last name are required");
      return;
    }
    if (!guestEmail.trim()) {
      setError("Guest email is required");
      return;
    }
    if (!roomId) {
      setError("Please select a room");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        roomId,
        guestFirstName: guestFirstName.trim(),
        guestLastName: guestLastName.trim(),
        guestEmail: guestEmail.trim(),
        guestPhone: guestPhone.trim(),
        specialRequests: specialRequests.trim(),
        checkIn,
        checkOut,
        adults,
        children,
        nightlyRate: nightlyRate ? parseFloat(nightlyRate) : null,
        channel,
        addonIds: selectedAddonIds,
        addonQuantities: selectedAddonIds.reduce<Record<string, number>>((acc, addonId) => {
          const addon = availableAddons.find((item) => item.id === addonId);
          if (addon) {
            acc[addonId] = clampAddOnQuantity(
              addon,
              addonQuantities[addonId] || 1,
              nights || 1,
              adults,
            );
          }
          return acc;
        }, {}),
      });
    } catch (err: any) {
      setError(err?.message || "Failed to create booking");
    } finally {
      setSubmitting(false);
    }
  };

  const inputCls =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent";
  const fieldLabelCls = "block text-xs font-medium text-gray-700 mb-1";
  const sectionLabelCls = "block text-xs font-medium text-gray-500 uppercase tracking-wide mb-2";
  const required = <span className="text-red-500 font-normal">*</span>;

  return (
    <Modal
      onClose={onClose}
      maxWidth="lg"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-gray-500 min-w-0">
            {total !== null && selectedRoomType ? (
              <>
                <span className="text-gray-500">Total</span>{" "}
                <span className="font-semibold text-gray-900 text-sm">
                  {formatCurrency(total, selectedRoomType.currency)}
                </span>
                <span className="text-gray-400">
                  {" · "}
                  {nights} night{nights !== 1 ? "s" : ""}
                </span>
              </>
            ) : (
              <span className="text-gray-400">Pick dates and rate to see total</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="new-booking-form"
              disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Creating…" : "Create Booking"}
            </button>
          </div>
        </div>
      }
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-gray-900">New Booking</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Manually create a reservation for walk-ins, phone bookings, or owner stays.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
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

      <form id="new-booking-form" onSubmit={handleSubmit} className="space-y-6">
        {/* Stay */}
        <section>
          <h3 className={sectionLabelCls}>Stay</h3>
          <div className="space-y-3">
            <div>
              <label className={fieldLabelCls}>Room {required}</label>
              <select
                value={roomId}
                onChange={(e) => handleRoomChange(e.target.value)}
                className={inputCls}
                disabled={linkedAvailabilityLoading || selectableRooms.length === 0}
                required
              >
                {selectableRooms.length === 0 && <option value="">No rooms available</option>}
                {roomTypes.map((rt) => {
                  const typeRooms = roomsByType[rt.id] || [];
                  if (typeRooms.length === 0) return null;
                  return (
                    <optgroup key={rt.id} label={rt.name}>
                      {typeRooms.map((r) => (
                        <option key={r.id} value={r.id}>
                          #{r.roomNumber} — {rt.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
              {selectedRoomType && (
                <p className="mt-1.5 text-xs text-gray-500">
                  Sleeps {selectedRoomType.maxOccupancy} ·{" "}
                  {formatCurrency(selectedRoomType.baseRate, selectedRoomType.currency)}/night base
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={fieldLabelCls}>Check-in {required}</label>
                <input
                  type="date"
                  value={checkIn}
                  onChange={(e) => handleCheckInChange(e.target.value)}
                  className={inputCls}
                  required
                />
              </div>
              <div>
                <label className={fieldLabelCls}>Check-out {required}</label>
                <input
                  type="date"
                  value={checkOut}
                  onChange={(e) => setCheckOut(e.target.value)}
                  min={checkIn ? addOneDay(checkIn) : undefined}
                  max={checkoutMaxDate ?? undefined}
                  className={inputCls}
                  required
                />
              </div>
            </div>
            {nights > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-gray-500">
                  {nights} night{nights !== 1 ? "s" : ""}
                </p>
                {exceedsMaxStay && maxStayLimit && (
                  <p className="text-xs font-medium text-amber-700">
                    This room has a maximum stay of {maxStayLimit} nights for the selected dates.
                  </p>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Guest */}
        <section>
          <h3 className={sectionLabelCls}>Guest</h3>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={fieldLabelCls}>First name {required}</label>
                <input
                  type="text"
                  value={guestFirstName}
                  onChange={(e) => setGuestFirstName(e.target.value)}
                  className={inputCls}
                  required
                />
              </div>
              <div>
                <label className={fieldLabelCls}>Last name {required}</label>
                <input
                  type="text"
                  value={guestLastName}
                  onChange={(e) => setGuestLastName(e.target.value)}
                  className={inputCls}
                  required
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className={fieldLabelCls}>Email {required}</label>
                <input
                  type="email"
                  value={guestEmail}
                  onChange={(e) => setGuestEmail(e.target.value)}
                  placeholder="guest@example.com"
                  className={inputCls}
                  required
                />
              </div>
              <div>
                <label className={fieldLabelCls}>Phone</label>
                <input
                  type="tel"
                  value={guestPhone}
                  onChange={(e) => setGuestPhone(e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={fieldLabelCls}>Adults</label>
                <input
                  type="number"
                  min={1}
                  max={selectedRoomType?.maxOccupancy || 10}
                  value={adults}
                  onChange={(e) => setAdults(Math.max(1, Number(e.target.value)))}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={fieldLabelCls}>Children</label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={children}
                  onChange={(e) => setChildren(Math.max(0, Number(e.target.value)))}
                  className={inputCls}
                />
              </div>
            </div>
            {overOccupancy && selectedRoomType && (
              <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                <svg
                  className="w-4 h-4 text-amber-500 shrink-0 mt-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                    clipRule="evenodd"
                  />
                </svg>
                <p className="text-xs text-amber-700">
                  Max occupancy is {selectedRoomType.maxOccupancy} for this room type — you have{" "}
                  {totalGuests} guests selected.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Rate & channel */}
        <section>
          <h3 className={sectionLabelCls}>Rate & channel</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={fieldLabelCls}>
                Nightly rate
                {selectedRoomType ? (
                  <span className="text-gray-400 font-normal"> ({selectedRoomType.currency})</span>
                ) : null}
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={nightlyRate}
                onChange={(e) => {
                  userEditedRate.current = true;
                  setNightlyRate(e.target.value);
                }}
                placeholder={
                  resolvedRate !== null
                    ? String(resolvedRate)
                    : selectedRoomType
                      ? String(selectedRoomType.baseRate)
                      : ""
                }
                className={inputCls}
              />
              {resolvedRate !== null && selectedRoomType ? (
                <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
                  <span className="text-gray-500">
                    Engine quote{" "}
                    <span className="font-medium text-gray-700">
                      {formatCurrency(resolvedRate, selectedRoomType.currency)}
                    </span>
                  </span>
                  {!rateMatchesResolved && rateNum !== null && (
                    <button
                      type="button"
                      onClick={() => {
                        userEditedRate.current = false;
                        setNightlyRate(String(resolvedRate));
                      }}
                      className="text-xs font-medium text-primary-600 hover:text-primary-700 transition-colors"
                    >
                      Reset
                    </button>
                  )}
                </div>
              ) : (
                <p className="mt-1.5 text-xs text-gray-500">Leave blank for room type default</p>
              )}
            </div>
            <div>
              <label className={fieldLabelCls}>Channel</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className={inputCls}
              >
                {visibleChannels.map((ch) => (
                  <option key={ch.value} value={ch.value}>
                    {ch.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* Add-ons */}
        {availableAddons.length > 0 && (
          <section>
            <h3 className={sectionLabelCls}>Add-ons</h3>
            <button
              type="button"
              onClick={() => setAddonsOpen((open) => !open)}
              disabled={addonsLoading}
              className="inline-flex items-center px-3 py-2 text-sm font-medium text-primary-700 border border-primary-200 rounded-lg hover:bg-primary-50 disabled:opacity-50"
            >
              + Add add-ons
            </button>
            {addonNotice && (
              <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {addonNotice}
              </p>
            )}
            {addonsOpen && (
              <div className="mt-3">
                <AddOnListPicker
                  addons={availableAddons}
                  selectedIds={selectedAddonIds}
                  quantities={addonQuantities}
                  currency={selectedRoomType?.currency || "EUR"}
                  nights={nights || 1}
                  adults={adults}
                  onChange={(ids, quantities) => {
                    setSelectedAddonIds(ids);
                    setAddonQuantities(quantities);
                  }}
                  onDone={() => setAddonsOpen(false)}
                />
              </div>
            )}
            <SelectedAddOnSummary
              addons={availableAddons}
              selectedIds={selectedAddonIds}
              quantities={addonQuantities}
              currency={selectedRoomType?.currency || "EUR"}
              nights={nights || 1}
              adults={adults}
              onRemove={(addonId) => {
                setSelectedAddonIds((prev) => prev.filter((id) => id !== addonId));
                setAddonQuantities((prev) => {
                  const next = { ...prev };
                  delete next[addonId];
                  return next;
                });
              }}
            />
          </section>
        )}

        {/* Notes */}
        <section>
          <h3 className={sectionLabelCls}>
            Notes{" "}
            <span className="text-gray-400 normal-case tracking-normal font-normal">
              (optional)
            </span>
          </h3>
          <textarea
            value={specialRequests}
            onChange={(e) => setSpecialRequests(e.target.value)}
            rows={2}
            placeholder="Late check-in, extra crib, allergies…"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-none"
          />
        </section>

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
      </form>
    </Modal>
  );
}
