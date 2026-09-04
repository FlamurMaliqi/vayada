"use client";

import { useState, useEffect } from "react";
import { bookingsService, Booking, type AssignmentSelector } from "@/services/bookings";
import { formatCurrency } from "@/lib/formatCurrency";
import { CHANNEL_COLORS, getChannelLabel, normalizeChannelKey } from "@/lib/constants/statusStyles";
import Modal from "@/components/Modal";
import BookingStaySummary, {
  bookingSettlementLabel,
  expectedPaymentMethodLabel,
} from "@/components/bookings/BookingStaySummary";
import { useTranslation } from "@/lib/i18n";

interface CalendarRoom {
  id: string;
  roomTypeId: string;
  roomTypeName: string;
  roomNumber: string;
  floor: string;
  status: string;
  baseRate: number;
  currency: string;
  maxOccupancy: number;
  size: number;
}

interface CalendarBookingLite {
  id: string;
  assignmentId?: string | null;
  roomId: string | null;
  roomTypeId?: string;
  roomPosition: number;
  checkIn: string;
  checkOut: string;
  status: string;
  guestFirstName?: string;
  guestLastName?: string;
}

interface BookingDetailModalProps {
  bookingId: string;
  onClose: () => void;
  onStatusChange: () => void;
  rooms?: CalendarRoom[];
  bookings?: CalendarBookingLite[];
  sourceAssignmentSelector?: AssignmentSelector;
}

type View = "detail" | "roomPicker" | "swapConfirm" | "unassignConfirm" | "moveSuccess";

interface SwapPlan {
  partnerBookingId: string;
  partnerBookingLabel: string;
  partnerCheckIn: string;
  partnerCheckOut: string;
  partnerCurrentRoomId: string;
  partnerDestinationRoomId: string;
  // Room the *source* booking ends up in (always partner's current room).
  sourceDestinationRoomId: string;
}

interface UnassignPlan {
  occupierBookingId: string;
  occupierAssignmentSelector?: AssignmentSelector;
  occupierLabel: string;
  occupierCheckIn: string;
  occupierCheckOut: string;
  occupierCurrentRoomId: string;
}

const datesOverlap = (aStart: string, aEnd: string, bStart: string, bEnd: string): boolean =>
  aStart < bEnd && aEnd > bStart;

const LEGACY_BOOKING_WRITES_AVAILABLE = false;

type Translate = (key: string, params?: Record<string, string | number>) => string;

function bookingStatusLabel(status: string, t: Translate): string {
  const keys: Record<string, string> = {
    pending: "bookings.statusPending",
    confirmed: "bookings.statusConfirmed",
    cancelled: "bookings.statusCancelled",
    checked_in: "bookings.statusCheckedIn",
    in_house: "bookings.statusInHouse",
    checked_out: "calendar.bookingDetail.statusCheckedOut",
    completed: "calendar.bookingDetail.statusCompleted",
    no_show: "bookings.statusNoShow",
    declined: "bookings.statusDeclined",
    expired: "bookings.statusExpired",
  };
  return keys[status] ? t(keys[status]) : status;
}

function channelLabel(channel: string | null | undefined, t: Translate): string {
  const keys: Record<string, string> = {
    direct: "calendar.channelDirect",
    manual: "calendar.channelDirect",
    airbnb: "calendar.channelAirbnb",
    "booking.com": "calendar.channelBookingCom",
    expedia: "calendar.channelExpedia",
    other: "calendar.channelOther",
  };
  const normalized = normalizeChannelKey(channel);
  return keys[normalized] ? t(keys[normalized]) : getChannelLabel(channel ?? "");
}

export default function BookingDetailModal({
  bookingId,
  onClose,
  onStatusChange,
  rooms = [],
  bookings = [],
  sourceAssignmentSelector,
}: BookingDetailModalProps) {
  const { t } = useTranslation();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [assigningRoom, setAssigningRoom] = useState(false);
  const [selectedRoomId, setSelectedRoomId] = useState<string>("");
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<View>("detail");
  const [pickerSelectedRoomId, setPickerSelectedRoomId] = useState<string>("");
  const [pendingSwap, setPendingSwap] = useState<SwapPlan | null>(null);
  const [pendingUnassign, setPendingUnassign] = useState<UnassignPlan | null>(null);
  const [movingRoom, setMovingRoom] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [movedToRoomNumber, setMovedToRoomNumber] = useState<string>("");
  const [movedToRoomTypeName, setMovedToRoomTypeName] = useState<string>("");
  const [ratePolicy, setRatePolicy] = useState<"preserve" | "target_base">("preserve");
  const [editForm, setEditForm] = useState({
    checkIn: "",
    checkOut: "",
    guestFirstName: "",
    guestLastName: "",
    guestEmail: "",
    guestPhone: "",
    adults: 1,
    children: 0,
    nightlyRate: 0,
    specialRequests: "",
  });

  useEffect(() => {
    bookingsService
      .get(bookingId)
      .then((b) => {
        setBooking(b);
        setEditForm({
          checkIn: b.checkIn,
          checkOut: b.checkOut,
          guestFirstName: b.guestFirstName,
          guestLastName: b.guestLastName,
          guestEmail: b.guestEmail,
          guestPhone: b.guestPhone || "",
          adults: b.adults,
          children: b.children,
          nightlyRate: b.nightlyRate,
          specialRequests: b.specialRequests || "",
        });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [bookingId]);

  const handleStatusUpdate = async (status: "confirmed" | "cancelled") => {
    setActionLoading(true);
    try {
      await bookingsService.updateStatus(bookingId, status);
      onStatusChange();
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleAssignRoom = async () => {
    if (!selectedRoomId) return;
    setAssigningRoom(true);
    try {
      await bookingsService.assignRoom(bookingId, selectedRoomId);
      onStatusChange();
      onClose();
    } catch (err) {
      console.error(err);
    } finally {
      setAssigningRoom(false);
    }
  };

  const handleSaveEdit = async () => {
    setSaving(true);
    try {
      const updated = await bookingsService.update(bookingId, editForm);
      setBooking(updated);
      setEditing(false);
      onStatusChange();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const availableRooms = booking
    ? rooms.filter((r) => r.roomTypeId === booking.roomTypeId && r.status === "available")
    : [];

  const movingAssignment = booking
    ? sourceAssignmentSelector
      ? booking.assignedRooms.find((assignment) =>
          "assignmentId" in sourceAssignmentSelector
            ? assignment.assignmentId === sourceAssignmentSelector.assignmentId
            : assignment.position === sourceAssignmentSelector.position,
        )
      : booking.assignedRooms[0]
    : null;
  const staleAssignment = Boolean(booking && sourceAssignmentSelector && !movingAssignment);
  const activeRoomId =
    movingAssignment?.roomId ?? (sourceAssignmentSelector ? null : (booking?.roomId ?? null));
  const activeRoomTypeId =
    movingAssignment?.roomTypeId ?? (sourceAssignmentSelector ? "" : (booking?.roomTypeId ?? ""));
  const movingStay = booking?.stays.find((stay) => stay.position === movingAssignment?.position);
  const moveCheckIn = movingStay?.checkIn ?? booking?.checkIn ?? "";
  const moveCheckOut = movingStay?.checkOut ?? booking?.checkOut ?? "";

  // Candidate rooms for the "Move to another room" / "Assign room" picker:
  // every operational room except the current room. Two states per room:
  //   - available  → fully free for the booking's dates → one-click move.
  //   - occupied   → one or more existing bookings overlap. The user resolves
  //                 each via per-occupier actions (Swap or Move to Unassigned).
  // Swap is offered only when the room has exactly one overlapping occupier
  // *and* the swap can be completed in one atomic step — multi-overlap or a
  // missing partner-destination forces the user to free the room one booking
  // at a time via Move-to-Unassigned. All availability/swap math runs locally;
  // the backend re-validates on submit.
  interface OccupierEntry {
    booking: CalendarBookingLite;
    swap: { partnerDestinationRoomId: string } | null;
  }
  type Candidate =
    | { room: (typeof rooms)[number]; kind: "available" }
    | {
        room: (typeof rooms)[number];
        kind: "occupied";
        occupiers: OccupierEntry[];
      };

  const candidates: Candidate[] =
    booking && !staleAssignment
      ? rooms
          .filter((r) => r.status === "available" && r.id !== activeRoomId)
          .sort(
            (left, right) =>
              Number(right.roomTypeId === activeRoomTypeId) -
                Number(left.roomTypeId === activeRoomTypeId) ||
              left.roomTypeName.localeCompare(right.roomTypeName) ||
              left.roomNumber.localeCompare(right.roomNumber),
          )
          .map((r): Candidate => {
            const occupiers = bookings.filter(
              (b) =>
                b.roomId === r.id &&
                b.status !== "cancelled" &&
                datesOverlap(moveCheckIn, moveCheckOut, b.checkIn, b.checkOut),
            );
            if (occupiers.length === 0) return { room: r, kind: "available" };
            // Swap eligibility (only when room has exactly one occupier in the
            // source's date window — otherwise displacing one still leaves the
            // others overlapping).
            //  • Source assigned: occupier moves into source's room. Verify
            //    occupier's dates fit there (no other conflict).
            //  • Source unassigned: occupier needs a different free same-type
            //    room. Find one that is free for occupier's dates.
            const entries: OccupierEntry[] = occupiers.map((occupier) => {
              if (occupiers.length !== 1 || r.roomTypeId !== activeRoomTypeId)
                return { booking: occupier, swap: null };
              if (activeRoomId) {
                const sourceRoomId = activeRoomId;
                const conflictInSourceRoom = bookings.some(
                  (b) =>
                    !(b.id === bookingId && b.roomPosition === movingAssignment?.position) &&
                    !(b.id === occupier.id && b.roomPosition === occupier.roomPosition) &&
                    b.roomId === sourceRoomId &&
                    b.status !== "cancelled" &&
                    datesOverlap(occupier.checkIn, occupier.checkOut, b.checkIn, b.checkOut),
                );
                if (conflictInSourceRoom) return { booking: occupier, swap: null };
                return {
                  booking: occupier,
                  swap: { partnerDestinationRoomId: sourceRoomId },
                };
              } else {
                const freeForOccupier = rooms.find(
                  (rr) =>
                    rr.roomTypeId === activeRoomTypeId &&
                    rr.id !== r.id &&
                    !bookings.some(
                      (b) =>
                        !(b.id === bookingId && b.roomPosition === movingAssignment?.position) &&
                        !(b.id === occupier.id && b.roomPosition === occupier.roomPosition) &&
                        b.roomId === rr.id &&
                        b.status !== "cancelled" &&
                        datesOverlap(occupier.checkIn, occupier.checkOut, b.checkIn, b.checkOut),
                    ),
                );
                if (!freeForOccupier) return { booking: occupier, swap: null };
                return {
                  booking: occupier,
                  swap: { partnerDestinationRoomId: freeForOccupier.id },
                };
              }
            });
            return { room: r, kind: "occupied", occupiers: entries };
          })
      : [];

  const currentRoom = activeRoomId ? rooms.find((r) => r.id === activeRoomId) || null : null;

  const partnerLabel = (p: CalendarBookingLite): string => {
    const name = `${p.guestFirstName ?? ""} ${p.guestLastName ?? ""}`.trim();
    return name || t("calendar.bookingDetail.occupied");
  };

  const roomFacts = (room: CalendarRoom) =>
    [
      room.maxOccupancy > 0
        ? t("calendar.bookingDetail.upToGuests", { count: room.maxOccupancy })
        : "",
      room.size > 0 ? `${room.size} m²` : "",
      room.baseRate > 0
        ? t("calendar.bookingDetail.perNight", {
            amount: formatCurrency(room.baseRate, room.currency),
          })
        : "",
    ]
      .filter(Boolean)
      .join(" · ");

  const enterRoomPicker = () => {
    setMoveError(null);
    setPickerSelectedRoomId("");
    setPendingSwap(null);
    setPendingUnassign(null);
    setRatePolicy("preserve");
    setView("roomPicker");
  };

  const selectedCandidate = pickerSelectedRoomId
    ? (candidates.find((c) => c.room.id === pickerSelectedRoomId) ?? null)
    : null;
  const isCrossType = Boolean(
    selectedCandidate && selectedCandidate.room.roomTypeId !== activeRoomTypeId,
  );
  const moveNights =
    movingStay?.checkIn && movingStay.checkOut
      ? Math.round(
          (Date.parse(`${movingStay.checkOut}T00:00:00Z`) -
            Date.parse(`${movingStay.checkIn}T00:00:00Z`)) /
            86_400_000,
        )
      : null;
  const hasCompleteRateEvidence = Boolean(
    booking &&
    movingStay &&
    moveNights !== null &&
    moveNights > 0 &&
    movingStay.nightly.length === moveNights &&
    movingStay.nightly.every(
      (night) =>
        night.evidenceQuality !== "missing" &&
        night.appliedAmount !== null &&
        night.currency === booking.currency,
    ),
  );
  const originalNightlyRate =
    hasCompleteRateEvidence && movingStay && moveNights
      ? movingStay.nightly.reduce((sum, night) => sum + (night.appliedAmount ?? 0), 0) / moveNights
      : null;
  const channelKey = normalizeChannelKey(booking?.channel);
  const isOtaMove = !["direct", "manual"].includes(channelKey);
  const targetRateCompatible = Boolean(
    channelKey === "manual" &&
    hasCompleteRateEvidence &&
    booking &&
    selectedCandidate &&
    booking.currency === selectedCandidate.room.currency &&
    selectedCandidate.room.baseRate > 0,
  );

  const handlePickerContinue = () => {
    if (!booking || !selectedCandidate) return;
    // Only the simple "available" path uses this Continue button. Swap and
    // Move-to-Unassigned are triggered from per-occupier action buttons that
    // jump straight into their respective confirm views.
    if (selectedCandidate.kind === "available") {
      void handleConfirmMove();
    }
  };

  const beginSwap = (
    room: CalendarRoom,
    occupier: CalendarBookingLite,
    partnerDestinationRoomId: string,
  ) => {
    if (!booking) return;
    setPendingSwap({
      partnerBookingId: occupier.id,
      partnerBookingLabel: partnerLabel(occupier),
      partnerCheckIn: occupier.checkIn,
      partnerCheckOut: occupier.checkOut,
      partnerCurrentRoomId: room.id,
      partnerDestinationRoomId,
      sourceDestinationRoomId: room.id,
    });
    setMoveError(null);
    setView("swapConfirm");
  };

  const beginUnassign = (room: CalendarRoom, occupier: CalendarBookingLite) => {
    if (!booking) return;
    setPendingUnassign({
      occupierBookingId: occupier.id,
      occupierAssignmentSelector: occupier.assignmentId
        ? { assignmentId: occupier.assignmentId }
        : { position: occupier.roomPosition },
      occupierLabel: partnerLabel(occupier),
      occupierCheckIn: occupier.checkIn,
      occupierCheckOut: occupier.checkOut,
      occupierCurrentRoomId: room.id,
    });
    setMoveError(null);
    setView("unassignConfirm");
  };

  const handleConfirmMove = async () => {
    if (!booking || !pickerSelectedRoomId) return;
    setMoveError(null);
    setMovingRoom(true);
    try {
      const updated = await bookingsService.moveRoom(
        bookingId,
        pickerSelectedRoomId,
        sourceAssignmentSelector,
        isCrossType && targetRateCompatible ? ratePolicy : "preserve",
      );
      const target = rooms.find((r) => r.id === pickerSelectedRoomId);
      setMovedToRoomNumber(target?.roomNumber || updated.roomNumber || "");
      setMovedToRoomTypeName(target?.roomTypeName || updated.roomName || "");
      setBooking(updated);
      setView("moveSuccess");
      onStatusChange();
      window.setTimeout(() => {
        // Use the functional setter so we don't bounce out if the user
        // already navigated away.
        setView((v) => (v === "moveSuccess" ? "detail" : v));
      }, 1000);
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail ||
        err?.data?.detail ||
        err?.message ||
        t("calendar.bookingDetail.moveError");
      setMoveError(typeof detail === "string" ? detail : t("calendar.bookingDetail.moveError"));
    } finally {
      setMovingRoom(false);
    }
  };

  const handleConfirmUnassign = async () => {
    if (!booking || !pendingUnassign) return;
    setMoveError(null);
    setMovingRoom(true);
    try {
      await bookingsService.unassignRoom(
        pendingUnassign.occupierBookingId,
        pendingUnassign.occupierAssignmentSelector,
      );
      // The displaced booking is now in the Unassigned row; the parent calendar
      // refetches via onStatusChange so the candidate list refreshes and the
      // newly-freed room appears as Available next time the user reopens or
      // rechecks the picker. Keep the modal open on the source booking so the
      // user can chain another action immediately.
      onStatusChange();
      setPendingUnassign(null);
      setPickerSelectedRoomId("");
      setView("roomPicker");
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail ||
        err?.data?.detail ||
        err?.message ||
        t("calendar.bookingDetail.unassignError");
      setMoveError(typeof detail === "string" ? detail : t("calendar.bookingDetail.unassignError"));
    } finally {
      setMovingRoom(false);
    }
  };

  const handleConfirmSwap = async () => {
    if (!booking || !pendingSwap) return;
    setMoveError(null);
    setMovingRoom(true);
    try {
      // partnerDestinationRoomId is only meaningful when source is unassigned.
      // For the standard 2-way swap (source has a room) the backend infers it.
      const partnerDest = activeRoomId ? undefined : pendingSwap.partnerDestinationRoomId;
      const updated = await bookingsService.swapRoom(
        bookingId,
        pendingSwap.partnerBookingId,
        partnerDest,
      );
      const target = rooms.find((r) => r.id === pendingSwap.sourceDestinationRoomId);
      setMovedToRoomNumber(target?.roomNumber || updated.roomNumber || "");
      setBooking(updated);
      setView("moveSuccess");
      onStatusChange();
      window.setTimeout(() => {
        setView((v) => (v === "moveSuccess" ? "detail" : v));
      }, 1200);
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail ||
        err?.data?.detail ||
        err?.message ||
        t("calendar.bookingDetail.swapError");
      setMoveError(typeof detail === "string" ? detail : t("calendar.bookingDetail.swapError"));
      setView("swapConfirm");
    } finally {
      setMovingRoom(false);
    }
  };

  const channelStyle =
    CHANNEL_COLORS[normalizeChannelKey(booking?.channel)] || CHANNEL_COLORS.other;

  return (
    <Modal onClose={onClose} maxWidth="lg">
      <button
        onClick={onClose}
        aria-label={t("common.close")}
        className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 z-10"
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

      {loading ? (
        <div className="p-8">
          <div className="animate-pulse space-y-4">
            <div className="h-6 bg-gray-200 rounded w-2/3" />
            <div className="h-4 bg-gray-200 rounded w-1/2" />
            <div className="h-20 bg-gray-200 rounded" />
          </div>
        </div>
      ) : !booking ? (
        <div className="p-8 text-center text-gray-500">{t("bookings.modal.notFound")}</div>
      ) : staleAssignment ? (
        <div className="p-8 text-center text-amber-700">
          {t("calendar.bookingDetail.assignmentChanged")}
        </div>
      ) : view === "roomPicker" ? (
        /* ── ROOM PICKER ── */
        <div className="p-6">
          <div className="flex items-center gap-3 mb-1">
            <button
              onClick={() => setView("detail")}
              aria-label={t("calendar.bookingDetail.back")}
              className="text-gray-500 hover:text-gray-800 -ml-1 p-1 rounded hover:bg-gray-100 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <h2 className="text-lg font-bold text-gray-900">
              {activeRoomId
                ? t("calendar.bookingDetail.moveToAnotherRoom")
                : t("calendar.bookingDetail.assignRoom")}
            </h2>
          </div>
          <p className="text-sm text-gray-500 mb-4 ml-8">
            {booking.guestFirstName} {booking.guestLastName} &middot; {moveCheckIn} &rarr;{" "}
            {moveCheckOut}
          </p>

          {currentRoom && (
            <div className="mb-3">
              <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                {t("calendar.bookingDetail.currentRoom")}
              </p>
              <div className="flex items-center justify-between px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg opacity-70">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-gray-300" />
                  <span className="text-sm font-medium text-gray-700">
                    #{currentRoom.roomNumber}
                    {currentRoom.floor
                      ? ` (${t("calendar.bookingDetail.floor", { floor: currentRoom.floor })})`
                      : ""}
                  </span>
                  <span className="text-xs text-gray-400">&middot; {currentRoom.roomTypeName}</span>
                </div>
              </div>
            </div>
          )}

          {candidates.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-500 border border-dashed border-gray-200 rounded-lg">
              {t("calendar.bookingDetail.noRoomsAvailable")}
            </div>
          ) : (
            <div className="space-y-1.5 max-h-96 overflow-y-auto">
              {candidates.map((cand, index) => {
                const { room, kind } = cand;
                const startsGroup =
                  index === 0 || candidates[index - 1]?.room.roomTypeId !== room.roomTypeId;
                const groupHeading = startsGroup ? (
                  <p className="pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                    {room.roomTypeName}
                    {room.roomTypeId === activeRoomTypeId
                      ? ` · ${t("calendar.bookingDetail.sameType")}`
                      : ""}
                  </p>
                ) : null;
                if (kind === "available") {
                  const isSelected = pickerSelectedRoomId === room.id;
                  return (
                    <div key={room.id}>
                      {groupHeading}
                      <button
                        type="button"
                        onClick={() => {
                          setPickerSelectedRoomId(room.id);
                          setRatePolicy("preserve");
                        }}
                        className={`w-full flex items-center justify-between px-3 py-2.5 border rounded-lg transition-colors text-left ${
                          isSelected
                            ? "bg-primary-50 border-primary-400"
                            : "bg-white border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-green-500" />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium truncate text-gray-900">
                              #{room.roomNumber}
                              {room.floor
                                ? ` (${t("calendar.bookingDetail.floor", { floor: room.floor })})`
                                : ""}
                            </span>
                            <span className="block text-xs text-gray-500 truncate">
                              {roomFacts(room)}
                            </span>
                          </span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs text-green-700">
                            {t("calendar.bookingDetail.noBookingOverlap")}
                          </span>
                          {isSelected && (
                            <svg
                              className="w-4 h-4 text-primary-600"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2.5}
                                d="M5 13l4 4L19 7"
                              />
                            </svg>
                          )}
                        </div>
                      </button>
                    </div>
                  );
                }
                // Occupied: list every overlapping booking with per-occupier
                // action buttons. Resolving a single one frees the room when
                // it's the only overlap; with multi-overlap the user steps
                // through the occupiers one at a time.
                return (
                  <div key={room.id}>
                    {groupHeading}
                    <div className="border border-gray-200 rounded-lg bg-gray-50/40">
                      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-amber-500" />
                          <span className="text-sm font-medium truncate text-gray-900">
                            #{room.roomNumber}
                            {room.floor
                              ? ` (${t("calendar.bookingDetail.floor", { floor: room.floor })})`
                              : ""}
                          </span>
                          <span className="text-xs text-gray-400 truncate">
                            &middot; {room.roomTypeName}
                          </span>
                        </div>
                        <span className="text-[10px] font-medium uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                          {t("calendar.bookingDetail.occupied")}
                        </span>
                      </div>
                      <p className="px-3 py-1 text-xs text-gray-500 border-b border-gray-200">
                        {roomFacts(room)}
                      </p>
                      <ul className="divide-y divide-gray-200">
                        {cand.occupiers.map((entry) => (
                          <li
                            key={`${entry.booking.id}-${entry.booking.roomPosition}`}
                            className="px-3 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate">
                                {partnerLabel(entry.booking)}
                              </p>
                              <p className="text-xs text-gray-500">
                                {entry.booking.checkIn} &rarr; {entry.booking.checkOut}
                              </p>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {entry.swap && (
                                <button
                                  type="button"
                                  disabled={!LEGACY_BOOKING_WRITES_AVAILABLE}
                                  title={t("calendar.bookingDetail.swapsUnavailable")}
                                  onClick={() =>
                                    beginSwap(
                                      room,
                                      entry.booking,
                                      entry.swap!.partnerDestinationRoomId,
                                    )
                                  }
                                  className="cursor-not-allowed rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-400"
                                >
                                  {t("calendar.bookingDetail.swapUnavailable")}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => beginUnassign(room, entry.booking)}
                                className="px-2.5 py-1 text-xs font-medium text-gray-700 border border-gray-300 hover:bg-white rounded-md transition-colors"
                              >
                                {t("calendar.bookingDetail.moveToUnassigned")}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {isCrossType && selectedCandidate && (
            <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
              <p className="font-medium text-gray-900">
                {t("calendar.bookingDetail.rateComparison")}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-600">
                <p>
                  {t("calendar.bookingDetail.original")}{" "}
                  {originalNightlyRate === null || moveNights === null
                    ? t("calendar.bookingDetail.unavailable")
                    : t("calendar.bookingDetail.rateTotal", {
                        rate: formatCurrency(originalNightlyRate, booking.currency),
                        total: formatCurrency(originalNightlyRate * moveNights, booking.currency),
                      })}
                </p>
                <p>
                  {t("calendar.bookingDetail.new")}{" "}
                  {moveNights !== null && moveNights > 0
                    ? t("calendar.bookingDetail.rateTotal", {
                        rate: formatCurrency(
                          selectedCandidate.room.baseRate,
                          selectedCandidate.room.currency,
                        ),
                        total: formatCurrency(
                          selectedCandidate.room.baseRate * moveNights,
                          selectedCandidate.room.currency,
                        ),
                      })
                    : t("calendar.bookingDetail.totalUnavailable")}
                </p>
              </div>
              <p className="mt-1 text-xs text-gray-600">
                {originalNightlyRate === null || moveNights === null
                  ? t("calendar.bookingDetail.differenceIncompleteRates")
                  : booking.currency !== selectedCandidate.room.currency
                    ? t("calendar.bookingDetail.differenceCurrencies")
                    : t("calendar.bookingDetail.difference", {
                        amount: `${selectedCandidate.room.baseRate - originalNightlyRate >= 0 ? "+" : ""}${formatCurrency((selectedCandidate.room.baseRate - originalNightlyRate) * moveNights, booking.currency)}`,
                      })}
              </p>
              <div className="mt-3 space-y-2">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    checked={ratePolicy === "preserve"}
                    onChange={() => setRatePolicy("preserve")}
                  />
                  <span>
                    <span className="block font-medium text-gray-800">
                      {t("calendar.bookingDetail.keepOriginalRate")}
                    </span>
                    <span className="text-xs text-gray-500">
                      {t("calendar.bookingDetail.guestPaysSame")}
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    checked={ratePolicy === "target_base"}
                    disabled={!targetRateCompatible}
                    onChange={() => setRatePolicy("target_base")}
                  />
                  <span>
                    <span className="block font-medium text-gray-800">
                      {t("calendar.bookingDetail.updateToNewRate")}
                    </span>
                    <span className="text-xs text-gray-500">
                      {channelKey !== "manual"
                        ? isOtaMove
                          ? t("calendar.bookingDetail.otaRateUnchanged")
                          : t("calendar.bookingDetail.manualBookingsOnly")
                        : !hasCompleteRateEvidence
                          ? t("calendar.bookingDetail.incompleteRates")
                          : booking.currency !== selectedCandidate.room.currency
                            ? t("calendar.bookingDetail.differentCurrencies")
                            : selectedCandidate.room.baseRate <= 0
                              ? t("calendar.bookingDetail.noTargetBaseRate")
                              : t("calendar.bookingDetail.recalculateTargetRate")}
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}

          {isOtaMove && selectedCandidate && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {t("calendar.bookingDetail.otaInternalMove")}
            </div>
          )}

          {moveError && (
            <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {moveError}
            </div>
          )}

          <div className="mt-5 pt-4 border-t border-gray-200">
            <button
              onClick={handlePickerContinue}
              disabled={!selectedCandidate || selectedCandidate.kind !== "available" || movingRoom}
              className="w-full px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {movingRoom
                ? t("calendar.bookingDetail.moving")
                : !selectedCandidate
                  ? t("calendar.bookingDetail.selectAvailableRoom")
                  : selectedCandidate.kind === "available"
                    ? t("calendar.bookingDetail.moveToRoom", {
                        room: selectedCandidate.room.roomNumber || "",
                      })
                    : t("calendar.bookingDetail.moveOccupantAbove")}
            </button>
            <p className="mt-2 text-xs text-gray-500 text-center">
              {t("calendar.bookingDetail.movePreservesBooking")}
            </p>
          </div>
        </div>
      ) : view === "swapConfirm" && pendingSwap ? (
        /* ── SWAP CONFIRM ── */
        <div className="p-6">
          <div className="flex items-center gap-3 mb-1">
            <button
              onClick={() => setView("roomPicker")}
              aria-label={t("calendar.bookingDetail.back")}
              className="text-gray-500 hover:text-gray-800 -ml-1 p-1 rounded hover:bg-gray-100 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <h2 className="text-lg font-bold text-gray-900">
              {t("calendar.bookingDetail.confirmSwap")}
            </h2>
          </div>
          <p className="text-sm text-gray-500 mb-4 ml-8">
            {t("calendar.bookingDetail.swapPreservesBookings")}
          </p>

          {(() => {
            const sourceFromRoom = currentRoom;
            const sourceToRoom =
              rooms.find((r) => r.id === pendingSwap.sourceDestinationRoomId) || null;
            const partnerFromRoom =
              rooms.find((r) => r.id === pendingSwap.partnerCurrentRoomId) || null;
            const partnerToRoom =
              rooms.find((r) => r.id === pendingSwap.partnerDestinationRoomId) || null;
            const Card = ({
              title,
              dates,
              fromRoom,
              toRoom,
            }: {
              title: string;
              dates: string;
              fromRoom: (typeof rooms)[number] | null;
              toRoom: (typeof rooms)[number] | null;
            }) => (
              <div className="border border-gray-200 rounded-lg p-3">
                <p className="text-sm font-semibold text-gray-900 truncate">{title}</p>
                <p className="text-xs text-gray-500 mb-2">{dates}</p>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-600">
                    {fromRoom ? `#${fromRoom.roomNumber}` : t("calendar.unassigned")}
                  </span>
                  <svg
                    className="w-4 h-4 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M14 5l7 7m0 0l-7 7m7-7H3"
                    />
                  </svg>
                  <span className="font-semibold text-gray-900">
                    {toRoom ? `#${toRoom.roomNumber}` : "—"}
                  </span>
                </div>
              </div>
            );
            return (
              <div className="grid grid-cols-2 gap-3 mb-4">
                <Card
                  title={`${booking.guestFirstName} ${booking.guestLastName}`}
                  dates={`${booking.checkIn} → ${booking.checkOut}`}
                  fromRoom={sourceFromRoom}
                  toRoom={sourceToRoom}
                />
                <Card
                  title={pendingSwap.partnerBookingLabel}
                  dates={`${pendingSwap.partnerCheckIn} → ${pendingSwap.partnerCheckOut}`}
                  fromRoom={partnerFromRoom}
                  toRoom={partnerToRoom}
                />
              </div>
            );
          })()}

          {moveError && (
            <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {moveError}
            </div>
          )}

          <div className="flex gap-2 mt-5 pt-4 border-t border-gray-200">
            <button
              onClick={() => setView("roomPicker")}
              disabled={movingRoom}
              className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
            >
              {t("calendar.bookingDetail.back")}
            </button>
            <button
              onClick={handleConfirmSwap}
              disabled={!LEGACY_BOOKING_WRITES_AVAILABLE || movingRoom}
              title={t("calendar.bookingDetail.swapsUnavailable")}
              className="flex-1 cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-400"
            >
              {t("calendar.bookingDetail.swapUnavailable")}
            </button>
          </div>
        </div>
      ) : view === "unassignConfirm" && pendingUnassign ? (
        /* ── UNASSIGN CONFIRM ── */
        <div className="p-6">
          <div className="flex items-center gap-3 mb-1">
            <button
              onClick={() => setView("roomPicker")}
              aria-label={t("calendar.bookingDetail.back")}
              className="text-gray-500 hover:text-gray-800 -ml-1 p-1 rounded hover:bg-gray-100 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <h2 className="text-lg font-bold text-gray-900">
              {t("calendar.bookingDetail.moveBookingToUnassigned")}
            </h2>
          </div>
          <p className="text-sm text-gray-500 mb-4 ml-8">
            {t("calendar.bookingDetail.unassignDescription", {
              room:
                rooms.find((r) => r.id === pendingUnassign.occupierCurrentRoomId)?.roomNumber || "",
              guest: `${booking.guestFirstName} ${booking.guestLastName}`,
            })}
          </p>

          {(() => {
            const occupierFromRoom =
              rooms.find((r) => r.id === pendingUnassign.occupierCurrentRoomId) || null;
            return (
              <div className="border border-gray-200 rounded-lg p-3 mb-4">
                <p className="text-sm font-semibold text-gray-900 truncate">
                  {pendingUnassign.occupierLabel}
                </p>
                <p className="text-xs text-gray-500 mb-2">
                  {pendingUnassign.occupierCheckIn} → {pendingUnassign.occupierCheckOut}
                </p>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-600">
                    {occupierFromRoom ? `#${occupierFromRoom.roomNumber}` : "—"}
                  </span>
                  <svg
                    className="w-4 h-4 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M14 5l7 7m0 0l-7 7m7-7H3"
                    />
                  </svg>
                  <span className="font-semibold text-amber-700">{t("calendar.unassigned")}</span>
                </div>
              </div>
            );
          })()}

          {moveError && (
            <div className="mt-3 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {moveError}
            </div>
          )}

          <div className="flex gap-2 mt-5 pt-4 border-t border-gray-200">
            <button
              onClick={() => setView("roomPicker")}
              disabled={movingRoom}
              className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
            >
              {t("calendar.bookingDetail.back")}
            </button>
            <button
              onClick={handleConfirmUnassign}
              disabled={movingRoom}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {movingRoom
                ? t("calendar.bookingDetail.moving")
                : t("calendar.bookingDetail.moveToUnassigned")}
            </button>
          </div>
        </div>
      ) : view === "moveSuccess" ? (
        /* ── MOVE SUCCESS ── */
        <div className="p-8 text-center">
          <div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-3">
            <svg
              className="w-6 h-6 text-green-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <p className="text-sm font-medium text-gray-900">
            {t("calendar.bookingDetail.reservationMoved", {
              guest: `${booking.guestFirstName} ${booking.guestLastName}`,
              room: movedToRoomNumber,
              roomType: movedToRoomTypeName,
            })}
          </p>
          <p className="mt-2 text-xs text-gray-500">
            {t("calendar.bookingDetail.availabilitySyncQueued")}
          </p>
          {isOtaMove && (
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {t("calendar.bookingDetail.otaMoveVerification")}
            </p>
          )}
        </div>
      ) : editing ? (
        /* ── EDIT MODE ── */
        <div className="p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-lg font-bold text-gray-900">{t("bookings.modal.editBooking")}</h2>
            <span className="text-sm text-gray-500">{booking.bookingReference}</span>
          </div>

          <div className="space-y-4">
            {/* Dates */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t("calendar.newBookingModal.checkInLabel")}
                </label>
                <input
                  type="date"
                  value={editForm.checkIn}
                  onChange={(e) => setEditForm({ ...editForm, checkIn: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t("calendar.newBookingModal.checkOutLabel")}
                </label>
                <input
                  type="date"
                  value={editForm.checkOut}
                  onChange={(e) => setEditForm({ ...editForm, checkOut: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            {/* Guest Name */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t("calendar.newBookingModal.firstNameLabel")}
                </label>
                <input
                  type="text"
                  value={editForm.guestFirstName}
                  onChange={(e) => setEditForm({ ...editForm, guestFirstName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t("calendar.newBookingModal.lastNameLabel")}
                </label>
                <input
                  type="text"
                  value={editForm.guestLastName}
                  onChange={(e) => setEditForm({ ...editForm, guestLastName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            {/* Contact */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t("calendar.newBookingModal.emailLabel")}
                </label>
                <input
                  type="email"
                  value={editForm.guestEmail}
                  onChange={(e) => setEditForm({ ...editForm, guestEmail: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t("calendar.newBookingModal.phoneLabel")}
                </label>
                <input
                  type="tel"
                  value={editForm.guestPhone}
                  onChange={(e) => setEditForm({ ...editForm, guestPhone: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            {/* Occupancy */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t("calendar.newBookingModal.adultsLabel")}
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={editForm.adults}
                  onChange={(e) => setEditForm({ ...editForm, adults: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  {t("calendar.newBookingModal.childrenLabel")}
                </label>
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={editForm.children}
                  onChange={(e) => setEditForm({ ...editForm, children: Number(e.target.value) })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            </div>

            {/* Rate */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t("bookings.modal.nightlyRateLabel", { currency: booking.currency })}
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={editForm.nightlyRate}
                onChange={(e) => setEditForm({ ...editForm, nightlyRate: Number(e.target.value) })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>

            {/* Special Requests */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                {t("calendar.newBookingModal.specialRequestsLabel")}
              </label>
              <textarea
                value={editForm.specialRequests}
                onChange={(e) => setEditForm({ ...editForm, specialRequests: e.target.value })}
                rows={2}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          {/* Edit Actions */}
          <div className="flex gap-2 mt-5 pt-4 border-t border-gray-200">
            <button
              onClick={() => setEditing(false)}
              className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors"
            >
              {t("calendar.cancel")}
            </button>
            <button
              onClick={handleSaveEdit}
              disabled={!LEGACY_BOOKING_WRITES_AVAILABLE || saving}
              title={t("calendar.bookingDetail.editsUnavailable")}
              className="flex-1 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? t("common.saving") : t("bookings.modal.saveChanges")}
            </button>
          </div>
        </div>
      ) : (
        /* ── VIEW MODE ── */
        <div className="p-6">
          {/* Header */}
          <div className="mb-6">
            <h2 className="text-xl font-bold text-gray-900">
              {booking.guestFirstName} {booking.guestLastName}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-sm text-gray-500">{booking.bookingReference}</span>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${channelStyle.bg} ${channelStyle.text}`}
              >
                {channelLabel(booking.channel, t)}
              </span>
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  booking.status === "confirmed"
                    ? "bg-green-100 text-green-700"
                    : booking.status === "cancelled"
                      ? "bg-red-100 text-red-700"
                      : "bg-amber-100 text-amber-700"
                }`}
              >
                {bookingStatusLabel(booking.status, t)}
              </span>
            </div>
          </div>

          {booking.numberOfRooms > 1 && (
            <div className="mb-6">
              <BookingStaySummary stays={booking.stays} expectedCount={booking.numberOfRooms} />
            </div>
          )}

          {/* Booked / Check-in / Check-out */}
          <div hidden={booking.numberOfRooms > 1} className="grid grid-cols-3 gap-4 mb-6">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t("calendar.bookingDetail.booked")}
              </p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">
                {booking.createdAt ? new Date(booking.createdAt).toLocaleDateString() : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t("calendar.newBookingModal.checkInLabel")}
              </p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{booking.checkIn}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                {t("calendar.newBookingModal.checkOutLabel")}
              </p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{booking.checkOut}</p>
            </div>
          </div>

          {/* Room info */}
          <div hidden={booking.numberOfRooms > 1} className="bg-gray-50 rounded-lg p-4 mb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  {booking.numberOfRooms > 1 && `${booking.numberOfRooms}× `}
                  {booking.roomName}
                </p>
                {/* VAY-403: list every assigned room, not just the first.
                      A multi-room booking with fewer assigned rooms than its
                      quantity flags the unassigned remainder for staff. */}
                <div className="flex flex-wrap gap-1 mt-1">
                  {booking.assignedRooms.length > 0 ? (
                    booking.assignedRooms
                      .slice()
                      .sort((a, b) => a.position - b.position)
                      .map((r) => (
                        <span
                          key={`${r.position}-${r.roomId}`}
                          className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-200 text-gray-700"
                        >
                          #{r.roomNumber}
                        </span>
                      ))
                  ) : (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                      {t("calendar.unassigned")}
                    </span>
                  )}
                  {booking.assignedRooms.length > 0 &&
                    booking.assignedRooms.length < booking.numberOfRooms && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                        {t("calendar.bookingDetail.unassignedCount", {
                          count: booking.numberOfRooms - booking.assignedRooms.length,
                        })}
                      </span>
                    )}
                </div>
              </div>
              <div className="text-right text-sm text-gray-600">
                <p>
                  {t(
                    booking.nights === 1
                      ? "calendar.bookingDetail.nightCount"
                      : "calendar.bookingDetail.nightsCount",
                    { count: booking.nights },
                  )}
                </p>
                <p>
                  {t(
                    booking.adults === 1
                      ? "calendar.bookingDetail.adultCount"
                      : "calendar.bookingDetail.adultsCount",
                    { count: booking.adults },
                  )}
                  {booking.children > 0 &&
                    `, ${t(
                      booking.children === 1
                        ? "calendar.bookingDetail.childCount"
                        : "calendar.bookingDetail.childrenCount",
                      { count: booking.children },
                    )}`}
                </p>
              </div>
            </div>

            {!booking.roomId && availableRooms.length > 0 && (
              <div className="mt-3 pt-3 border-t border-gray-200">
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1.5">
                  {t("bookings.modal.assignToRoom")}
                </label>
                <div className="flex gap-2">
                  <select
                    value={selectedRoomId}
                    onChange={(e) => setSelectedRoomId(e.target.value)}
                    className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  >
                    <option value="">{t("bookings.modal.selectRoom")}</option>
                    {availableRooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        #{r.roomNumber}
                        {r.floor
                          ? ` (${t("calendar.bookingDetail.floor", { floor: r.floor })})`
                          : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleAssignRoom}
                    disabled={!selectedRoomId || assigningRoom}
                    className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {assigningRoom ? t("bookings.modal.assigning") : t("bookings.modal.assign")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Guest Information */}
          <div className="mb-6">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              {t("bookings.detail.guestInformation")}
            </h3>
            <div className="space-y-1.5">
              {booking.guestEmail ? (
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                  <span className="text-gray-700">{booking.guestEmail}</span>
                </div>
              ) : null}
              {booking.guestPhone ? (
                <div className="flex items-center gap-2 text-sm">
                  <svg
                    className="w-4 h-4 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                    />
                  </svg>
                  <span className="text-gray-700">{booking.guestPhone}</span>
                </div>
              ) : null}
              {!booking.guestEmail && !booking.guestPhone && (
                <p className="text-sm text-gray-400 italic">
                  {t("calendar.bookingDetail.noContactDetails")}
                </p>
              )}
            </div>
          </div>

          {/* Payment Details */}
          <div className="mb-6">
            <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
              {t("bookings.modal.paymentDetails")}
            </h3>
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              {booking.numberOfRooms <= 1 && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-600">
                    {formatCurrency(booking.nightlyRate, booking.currency)} x{" "}
                    {t(
                      booking.nights === 1
                        ? "calendar.bookingDetail.nightCount"
                        : "calendar.bookingDetail.nightsCount",
                      { count: booking.nights },
                    )}
                    {booking.numberOfRooms > 1 &&
                      ` x ${t("calendar.bookingDetail.roomsCount", {
                        count: booking.numberOfRooms,
                      })}`}
                  </span>
                  <span className="font-medium text-gray-900">
                    {formatCurrency(booking.totalAmount, booking.currency)}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">
                  {t("calendar.bookingDetail.expectedPaymentMethod")}
                </span>
                <span className="font-medium text-gray-900">
                  {expectedPaymentMethodLabel(booking.expectedPaymentMethod, t)}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">{t("calendar.bookingDetail.settlement")}</span>
                <span className="font-medium text-gray-900">
                  {bookingSettlementLabel(booking, t)}
                </span>
              </div>
              <div className="flex justify-between text-sm pt-2 border-t border-gray-200">
                <span className="font-medium text-gray-900">{t("bookings.modal.totalAmount")}</span>
                <span className="font-bold text-gray-900">
                  {formatCurrency(booking.totalAmount, booking.currency)}
                </span>
              </div>
            </div>
          </div>

          {/* Special Requests */}
          {booking.specialRequests && (
            <div className="mb-6">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                {t("calendar.newBookingModal.specialRequestsLabel")}
              </h3>
              <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">
                {booking.specialRequests}
              </p>
            </div>
          )}

          {booking.estimatedArrivalTime && (
            <div className="mb-6">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                {t("bookings.detail.estimatedArrivalTime")}
              </h3>
              <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">
                {booking.estimatedArrivalTime}
              </p>
            </div>
          )}

          {booking.numberOfGuests != null && (
            <div className="mb-6">
              <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                {t("bookings.detail.numberOfGuests")}
              </h3>
              <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">
                {booking.numberOfGuests}
              </p>
            </div>
          )}

          {/* Actions */}
          {showCancelConfirm ? (
            <div className="pt-2 border-t border-gray-200">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-3">
                <p className="text-sm font-medium text-red-800">
                  {t("bookings.modal.cancelConfirm")}
                </p>
                <p className="text-xs text-red-600 mt-1">
                  {booking.guestFirstName} {booking.guestLastName} &middot; {booking.checkIn} &rarr;{" "}
                  {booking.checkOut} &middot;{" "}
                  {formatCurrency(booking.totalAmount, booking.currency)}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  disabled={actionLoading}
                  className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
                >
                  {t("bookings.modal.goBack")}
                </button>
                <button
                  onClick={() => handleStatusUpdate("cancelled")}
                  disabled={actionLoading}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  {actionLoading ? t("bookings.modal.cancelling") : t("bookings.modal.yesCancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="pt-2 border-t border-gray-200 space-y-2">
              {/* Move-to-another-room — assigned bookings get the standard
                    flow; unassigned bookings open the picker too so they can
                    pick a free room or trigger a swap when none is free. */}
              {booking.status !== "cancelled" && (
                <button
                  onClick={enterRoomPicker}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary-300 px-4 py-2 text-sm font-medium text-primary-700 transition-colors hover:bg-primary-50"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 7h12m0 0l-4-4m4 4l-4 4M16 17H4m0 0l4 4m-4-4l4-4"
                    />
                  </svg>
                  {activeRoomId
                    ? t("calendar.bookingDetail.moveToAnotherRoom")
                    : t("calendar.bookingDetail.assignRoom")}
                </button>
              )}
              {/* Edit button — always shown for non-cancelled bookings */}
              {booking.status !== "cancelled" && (
                <button
                  onClick={() => setEditing(true)}
                  disabled={!LEGACY_BOOKING_WRITES_AVAILABLE}
                  title={t("calendar.bookingDetail.editsUnavailable")}
                  className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-400"
                >
                  {t("calendar.bookingDetail.editUnavailable")}
                </button>
              )}
              {booking.status === "pending" && (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleStatusUpdate("confirmed")}
                    disabled={!LEGACY_BOOKING_WRITES_AVAILABLE || actionLoading}
                    title={t("calendar.bookingDetail.confirmationUnavailable")}
                    className="flex-1 cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-400"
                  >
                    {t("common.confirm")}
                  </button>
                  <button
                    onClick={() => setShowCancelConfirm(true)}
                    disabled={!LEGACY_BOOKING_WRITES_AVAILABLE || actionLoading}
                    title={t("calendar.bookingDetail.cancellationUnavailable")}
                    className="flex-1 cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-400"
                  >
                    {t("calendar.cancel")}
                  </button>
                </div>
              )}
              {booking.status === "confirmed" && (
                <button
                  onClick={() => setShowCancelConfirm(true)}
                  disabled={!LEGACY_BOOKING_WRITES_AVAILABLE || actionLoading}
                  title={t("calendar.bookingDetail.cancellationUnavailable")}
                  className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-400"
                >
                  {t("calendar.bookingDetail.cancellationUnavailable")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
