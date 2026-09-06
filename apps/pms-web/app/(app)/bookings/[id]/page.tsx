"use client";

import { useState, useEffect, useCallback, use, useMemo, useRef } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  XCircleIcon,
  EllipsisHorizontalIcon,
  HomeModernIcon,
  PencilSquareIcon,
  ArrowsRightLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  TrashIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import {
  bookingsService,
  Booking,
  BookingAddon,
  BookingChangeRequest,
  BookingNote,
  BookingAdditionalGuest,
  BookingAdditionalGuestPayload,
  AssignmentSelector,
  CancellationPolicy,
} from "@/services/bookings";
import { individualRoomsService, Room } from "@/services/rooms";
import ConfirmDialog from "@/components/ConfirmDialog";
import Modal from "@/components/Modal";
import { NationalitySelect } from "@/components/NationalitySelect";
import { formatCurrency } from "@/lib/formatCurrency";
import { nationalityDisplayLabel, paymentMethodLabelKey } from "@vayada/locale-constants";
import {
  AddOnListPicker,
  SelectedAddOnSummary,
  calculateAddOnsTotal,
  clampAddOnQuantity,
} from "@/components/bookings/AddOnListPicker";
import BookingStaySummary, {
  expectedPaymentMethodLabel,
} from "@/components/bookings/BookingStaySummary";
import {
  BOOKING_STATUS_STYLES,
  PAYMENT_STATUS_STYLES,
  getPaymentStatusLabel,
  getChannelLabel,
  normalizeChannelKey,
} from "@/lib/constants/statusStyles";
import { messagingService } from "@/services/messaging";
import { resolveSelectedPmsPropertyId } from "@/services/api/pmsPropertyClient";
import { useTranslation } from "@/lib/i18n";

type Translate = ReturnType<typeof useTranslation>["t"];

// ─── Helpers ─────────────────────────────────────────────────────────

/** Deterministic colored dot per roomTypeId — palette per room category
 * (ticket §2 "Room type icon (color per room/category)"). Same input
 * always returns the same color so the calendar / list / detail page
 * stay visually aligned even without a server-side palette. */
const ROOM_TYPE_PALETTE = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-purple-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-orange-500",
];
function roomTypeColor(roomTypeId: string | null | undefined): string {
  if (!roomTypeId) return "bg-gray-400";
  let hash = 0;
  for (let i = 0; i < roomTypeId.length; i++) {
    hash = (hash * 31 + roomTypeId.charCodeAt(i)) >>> 0;
  }
  return ROOM_TYPE_PALETTE[hash % ROOM_TYPE_PALETTE.length];
}

function formatPaymentCurrency(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
}

function formatDateLong(iso: string, locale?: string): string {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatDateTime(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function totalGuestsLabel(adults: number, children: number, t: Translate): string {
  const parts: string[] = [];
  parts.push(`${adults} ${t(adults === 1 ? "common.adult" : "common.adults")}`);
  if (children > 0) {
    parts.push(`${children} ${t(children === 1 ? "common.child" : "common.children")}`);
  }
  return parts.join(", ");
}

function paymentMethodDisplayLabel(method: string | null | undefined, t: Translate): string {
  return t(`bookings.detail.paymentMethod.${paymentMethodLabelKey(method)}`);
}

function bookingStatusLabel(status: string, t: Translate): string {
  const key = {
    pending: "bookings.statusPending",
    confirmed: "bookings.statusConfirmed",
    checked_in: "bookings.statusCheckedIn",
    in_house: "bookings.statusInHouse",
    checked_out: "bookings.statusCheckedOut",
    cancelled: "bookings.statusCancelled",
    declined: "bookings.statusDeclined",
    expired: "bookings.statusExpired",
    completed: "bookings.statusCompleted",
    no_show: "bookings.statusNoShow",
  }[status];
  return key ? t(key) : status;
}

function paymentStatusDisplayLabel(status: string, t: Translate): string {
  const knownStatuses = new Set([
    "unpaid",
    "authorized",
    "captured",
    "cancelled",
    "refunded",
    "partially_refunded",
    "failed",
    "pay_at_property",
    "awaiting_paypal",
  ]);
  return knownStatuses.has(status)
    ? t(`bookings.detail.paymentStatus.${status}`)
    : getPaymentStatusLabel(status);
}

const LEGACY_BOOKING_WRITES_AVAILABLE = false;
const DRAFT_GUEST_ID_PREFIX = "draft-guest-";

function CountdownTimer({ deadline }: { deadline: string }) {
  const { t } = useTranslation();
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    const update = () => {
      const diff = new Date(deadline).getTime() - Date.now();
      if (diff <= 0) {
        setTimeLeft(t("bookings.detail.expired"));
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setTimeLeft(t("bookings.detail.remaining", { hours, minutes }));
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [deadline, t]);

  const isUrgent = new Date(deadline).getTime() - Date.now() < 4 * 60 * 60 * 1000;
  return (
    <span className={`text-sm font-medium ${isUrgent ? "text-red-600" : "text-amber-600"}`}>
      {timeLeft}
    </span>
  );
}

// ─── Header bar with overflow menu ───────────────────────────────────

function OverflowMenu({
  onPrint,
  onExport,
  onResend,
  resending,
}: {
  onPrint: () => void;
  onExport: () => void;
  onResend: () => void;
  resending: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="p-2 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        aria-label={t("bookings.detail.moreActions")}
      >
        <EllipsisHorizontalIcon className="w-5 h-5" />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-10 py-1">
          <button
            onClick={() => {
              setOpen(false);
              onPrint();
            }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            {t("bookings.detail.print")}
          </button>
          <button
            type="button"
            disabled={resending}
            onClick={() => {
              setOpen(false);
              onResend();
            }}
            className="flex w-full items-center justify-between px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-50"
          >
            <span>
              {resending ? "Sending confirmation…" : t("bookings.detail.resendConfirmation")}
            </span>
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onExport();
            }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            {t("bookings.detail.exportJson")}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Cancellation policy panel ───────────────────────────────────────

interface CancellationPanelProps {
  checkIn: string;
  rateType: string;
  numberOfRooms: number;
  nightlyRate: number;
  currency: string;
  policy: CancellationPolicy | null;
}

function CancellationPolicyPanel({
  checkIn,
  rateType,
  numberOfRooms,
  nightlyRate,
  currency,
  policy,
}: CancellationPanelProps) {
  const { locale, t } = useTranslation();
  // Free window cutoff = check-in - freeCancellationDays.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const checkInDate = new Date(checkIn + "T00:00:00");
  const freeDays = policy?.freeCancellationDays ?? 0;
  const cutoff = new Date(checkInDate);
  cutoff.setDate(cutoff.getDate() - freeDays);

  const inFreeWindow = freeDays > 0 && today.getTime() < cutoff.getTime();
  // Non-refundable plan: no free window at all.
  const nonRefundable = freeDays <= 0;

  // Per-room charge after window. Default: first night of each room.
  const partialPct = policy?.partialRefundPct ?? 0;
  const perRoomCharge = nightlyRate;
  const totalCharge = perRoomCharge * numberOfRooms;
  // Effective refund percent inside the post-window region.
  const refundPctLabel =
    partialPct > 0
      ? t("bookings.detail.partialRefund", { percent: partialPct })
      : t("bookings.detail.oneNightPerRoom", {
          amount: formatCurrency(totalCharge, currency),
        });

  const todayLabel = today.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const cutoffLabel = cutoff.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
        {t("bookings.detail.cancellationPolicyTitle", { rateType })}
      </div>
      <div className="divide-y divide-gray-100">
        {!nonRefundable && (
          <div className="px-4 py-3 flex items-start justify-between gap-3">
            <div className="text-sm">
              <p className="font-medium text-gray-900">{t("bookings.detail.freeCancellation")}</p>
              <p className="text-gray-500 text-xs">
                {t("bookings.detail.freeCancellationDetails", {
                  cutoff: cutoffLabel,
                  days: freeDays,
                  dayLabel: t(freeDays === 1 ? "common.day" : "common.days"),
                })}
              </p>
            </div>
            <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
              {t("bookings.detail.noCharge")}
            </span>
          </div>
        )}
        <div className="px-4 py-3 flex items-start justify-between gap-3">
          <div className="text-sm">
            <p className="font-medium text-gray-900">
              {nonRefundable ? t("rooms.nonRefundableShort") : t("bookings.detail.afterFreeWindow")}
            </p>
            <p className="text-gray-500 text-xs">
              {nonRefundable
                ? t("bookings.detail.fullStayCancellationCharge")
                : t("bookings.detail.afterFreeWindowDetails", {
                    cutoff: cutoffLabel,
                    days: freeDays,
                    dayLabel: t(freeDays === 1 ? "common.day" : "common.days"),
                  })}
            </p>
          </div>
          <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700">
            {refundPctLabel}
          </span>
        </div>
      </div>
      <div
        className={`px-4 py-2.5 text-xs font-medium ${
          inFreeWindow ? "bg-green-50 text-green-800" : "bg-amber-50 text-amber-800"
        }`}
      >
        {t("bookings.detail.todayIs", { date: todayLabel })} —{" "}
        {inFreeWindow
          ? t("bookings.detail.withinFreeWindow")
          : nonRefundable
            ? t("bookings.detail.fullChargeApplies")
            : t("bookings.detail.refundApplies", { refund: refundPctLabel })}
      </div>
    </div>
  );
}

// ─── Additional guest expandable row ─────────────────────────────────

interface RoomOption {
  position: number;
  label: string;
}

interface GuestRowProps {
  guest: BookingAdditionalGuest;
  position: number;
  total: number;
  roomOptions: RoomOption[];
  onSave: (patch: BookingAdditionalGuestPayload) => Promise<void>;
  onDelete: () => Promise<void>;
}

function AdditionalGuestRow({
  guest,
  position,
  total,
  roomOptions,
  onSave,
  onDelete,
}: GuestRowProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(!guest.firstName && !guest.lastName);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    firstName: guest.firstName,
    lastName: guest.lastName,
    nationality: guest.nationality,
    email: guest.email,
    phone: guest.phone,
  });

  const initials =
    guest.firstName || guest.lastName
      ? `${(guest.firstName[0] || "").toUpperCase()}${(guest.lastName[0] || "").toUpperCase()}`
      : "?";
  const displayName =
    [guest.firstName, guest.lastName].filter(Boolean).join(" ") ||
    t("bookings.detail.unnamedGuest");

  const roomBadge =
    guest.roomPosition == null
      ? null
      : roomOptions.find((r) => r.position === guest.roomPosition)?.label ||
        t("bookings.detail.roomNumber", { number: guest.roomPosition + 1 });

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        firstName: form.firstName,
        lastName: form.lastName,
        nationality: form.nationality,
        ...(guest.guestContactHidden ? {} : { email: form.email, phone: form.phone }),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-xs font-semibold text-gray-600">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{displayName}</p>
          <p className="text-xs text-gray-500">
            {t("bookings.detail.guestPosition", { position, total })}
            {roomBadge && (
              <>
                {" · "}
                <span className="text-gray-700">{roomBadge}</span>
              </>
            )}
          </p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100"
          aria-label={open ? t("layout.sidebar.collapse") : t("bookings.detail.expand")}
        >
          {open ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
          aria-label={t("bookings.detail.deleteGuest")}
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>
      {open && (
        <div className="px-4 py-4 border-t border-gray-100 bg-gray-50">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field
              label={t("bookings.modal.firstNameLabel")}
              value={form.firstName}
              onChange={(v) => setForm({ ...form, firstName: v })}
            />
            <Field
              label={t("bookings.modal.lastNameLabel")}
              value={form.lastName}
              onChange={(v) => setForm({ ...form, lastName: v })}
            />
            <NationalitySelect
              value={form.nationality}
              onChange={(v) => setForm({ ...form, nationality: v })}
            />
            <Field
              label={t("bookings.detail.emailOptional")}
              type="email"
              value={form.email}
              onChange={(v) => setForm({ ...form, email: v })}
              disabled={guest.guestContactHidden}
            />
            <Field
              label={t("bookings.detail.phoneOptional")}
              type="tel"
              value={form.phone}
              onChange={(v) => setForm({ ...form, phone: v })}
              disabled={guest.guestContactHidden}
            />
          </div>
          {guest.guestContactHidden && (
            <p className="mt-3 text-xs text-amber-700">
              {t("bookings.detail.contactAvailableAfterAcceptance")}
            </p>
          )}
          {roomOptions.length > 1 && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {t("bookings.detail.guestAssignmentUnavailable")}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => {
                setForm({
                  firstName: guest.firstName,
                  lastName: guest.lastName,
                  nationality: guest.nationality,
                  email: guest.email,
                  phone: guest.phone,
                });
                setOpen(false);
              }}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              {t("bookings.modal.cancelButton")}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        // 16px text size prevents iOS Safari from auto-zooming on focus.
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-gray-600 mb-1">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent bg-white"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ─── Move-room modal ─────────────────────────────────────────────────

interface MoveRoomModalProps {
  fromRoomNumber: string | null;
  candidates: Room[];
  onClose: () => void;
  onMove: (toRoomId: string) => Promise<void>;
}

function MoveRoomModal({ fromRoomNumber, candidates, onClose, onMove }: MoveRoomModalProps) {
  const { t } = useTranslation();
  const [toRoomId, setToRoomId] = useState(candidates[0]?.id || "");
  const [moving, setMoving] = useState(false);
  const [err, setErr] = useState("");

  const handleMove = async () => {
    if (!toRoomId) return;
    setMoving(true);
    setErr("");
    try {
      await onMove(toRoomId);
      onClose();
    } catch (e) {
      setErr(errMessage(e, t("bookings.detail.failedToMoveRoom")));
      setMoving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">
        {t("bookings.detail.moveRoomTitle", {
          room: fromRoomNumber
            ? t("bookings.detail.roomNumber", { number: fromRoomNumber })
            : t("bookings.detail.thisRoom"),
        })}
      </h3>
      <p className="text-sm text-gray-600 mb-4">{t("bookings.detail.moveRoomDescription")}</p>
      {candidates.length === 0 ? (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4">
          {t("bookings.detail.noOtherRoomsInInventory")}
        </p>
      ) : (
        <SelectField
          label={t("bookings.detail.destinationRoom")}
          value={toRoomId}
          onChange={setToRoomId}
          options={candidates.map((r) => ({
            value: r.id,
            label: t("bookings.detail.roomOption", {
              number: r.roomNumber,
              floor: r.floor ? ` · ${t("bookings.modal.floor", { floor: r.floor })}` : "",
            }),
          }))}
        />
      )}
      {err && (
        <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {err}
        </p>
      )}
      <div className="flex justify-end gap-3 mt-4">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
        >
          {t("bookings.modal.cancelButton")}
        </button>
        <button
          onClick={handleMove}
          disabled={!toRoomId || moving || candidates.length === 0}
          className="px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-black rounded-lg disabled:opacity-50"
        >
          {moving ? t("bookings.detail.moving") : t("bookings.detail.moveRoom")}
        </button>
      </div>
    </Modal>
  );
}

// ─── Per-room "assign guests" modal (per-room Modify) ────────────────

interface AssignGuestsModalProps {
  roomLabel: string;
  roomPosition: number;
  guests: BookingAdditionalGuest[];
  onClose: () => void;
  onSave: (assignments: Record<string, number | null>) => Promise<void>;
}

function AssignGuestsModal({
  roomLabel,
  roomPosition,
  guests,
  onClose,
  onSave,
}: AssignGuestsModalProps) {
  const { t } = useTranslation();
  // Track which guest IDs the user has toggled into this room. Seed from
  // current state so editing then cancelling is a true no-op.
  const [assigned, setAssigned] = useState<Set<string>>(
    () => new Set(guests.filter((g) => g.roomPosition === roomPosition).map((g) => g.id)),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const toggle = (guestId: string) =>
    setAssigned((prev) => {
      const next = new Set(prev);
      if (next.has(guestId)) next.delete(guestId);
      else next.add(guestId);
      return next;
    });

  const handleSave = async () => {
    setSaving(true);
    setErr("");
    try {
      // Build a minimal diff: only patch guests whose membership in
      // `assigned` actually changed from their current state.
      const changes: Record<string, number | null> = {};
      for (const g of guests) {
        const wantsIn = assigned.has(g.id);
        const isIn = g.roomPosition === roomPosition;
        if (wantsIn && !isIn) changes[g.id] = roomPosition;
        else if (!wantsIn && isIn) changes[g.id] = null;
      }
      await onSave(changes);
      onClose();
    } catch (e) {
      setErr(errMessage(e, t("bookings.detail.failedToUpdateAssignments")));
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">
        {t("bookings.detail.guestsInRoom", { room: roomLabel })}
      </h3>
      <p className="text-sm text-gray-600 mb-4">{t("bookings.detail.assignGuestsDescription")}</p>
      {guests.length === 0 ? (
        <p className="text-sm text-gray-500 mb-4">{t("bookings.detail.assignGuestsEmpty")}</p>
      ) : (
        <div className="space-y-2 mb-4 max-h-72 overflow-y-auto">
          {guests.map((g) => {
            const name =
              [g.firstName, g.lastName].filter(Boolean).join(" ") ||
              t("bookings.detail.guestNumber", { number: g.position });
            const elsewhere =
              g.roomPosition != null && g.roomPosition !== roomPosition
                ? ` · ${t("bookings.detail.currentlyRoom", { number: g.roomPosition + 1 })}`
                : "";
            return (
              <label
                key={g.id}
                className="flex items-center gap-3 px-3 py-2 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={assigned.has(g.id)}
                  onChange={() => toggle(g.id)}
                  className="h-4 w-4 accent-gray-900"
                />
                <span className="flex-1 text-sm text-gray-900">{name}</span>
                <span className="text-xs text-gray-500">{elsewhere}</span>
              </label>
            );
          })}
        </div>
      )}
      {err && (
        <p className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {err}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
        >
          {t("bookings.modal.cancelButton")}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || guests.length === 0}
          className="px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-black rounded-lg disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("bookings.detail.saveAssignments")}
        </button>
      </div>
    </Modal>
  );
}

// ─── Modify-booking modal ─────────────────────────────────────────────

interface ModifyBookingModalProps {
  booking: Booking;
  onClose: () => void;
  onSave: (payload: {
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
    nightlyRate: number;
    addonIds: string[];
    addonQuantities: Record<string, number>;
    addonDates: Record<string, string[]>;
  }) => Promise<void>;
}

function ModifyBookingModal({ booking, onClose, onSave }: ModifyBookingModalProps) {
  const { t } = useTranslation();
  const [checkIn, setCheckIn] = useState(booking.checkIn);
  const [checkOut, setCheckOut] = useState(booking.checkOut);
  const [adults, setAdults] = useState(String(booking.adults));
  const [children, setChildren] = useState(String(booking.children));
  const [nightlyRate, setNightlyRate] = useState(String(booking.nightlyRate));
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>(booking.addonIds);
  const [addonQuantities, setAddonQuantities] = useState<Record<string, number>>(
    booking.addonQuantities || {},
  );
  const [availableAddons, setAvailableAddons] = useState<BookingAddon[]>([]);
  const [addonsLoading, setAddonsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let active = true;
    bookingsService
      .listAvailableAddons(booking.id)
      .then((addons) => {
        if (active) setAvailableAddons(addons);
      })
      .catch((e) => {
        if (active) setErr(errMessage(e, t("bookings.detail.failedToLoadAddons")));
      })
      .finally(() => {
        if (active) setAddonsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [booking.id, t]);

  const toggleAddon = (addon: BookingAddon, checked: boolean) => {
    setSelectedAddonIds((prev) =>
      checked
        ? prev.includes(addon.id)
          ? prev
          : [...prev, addon.id]
        : prev.filter((id) => id !== addon.id),
    );
    setAddonQuantities((prev) => {
      const next = { ...prev };
      if (checked) {
        next[addon.id] = next[addon.id] || 1;
      } else {
        delete next[addon.id];
      }
      return next;
    });
  };

  const handleSave = async () => {
    setErr("");
    if (checkOut <= checkIn) {
      setErr(t("bookings.detail.errorCheckoutAfterCheckin"));
      return;
    }
    const newAdults = parseInt(adults, 10);
    const newChildren = parseInt(children, 10);
    const newNightlyRate = Number(nightlyRate);
    if (!Number.isFinite(newAdults) || newAdults < 1) {
      setErr(t("bookings.detail.errorAdultsMinimum"));
      return;
    }
    if (!Number.isFinite(newChildren) || newChildren < 0) {
      setErr(t("bookings.detail.errorChildrenNegative"));
      return;
    }
    if (!Number.isFinite(newNightlyRate) || newNightlyRate < 0) {
      setErr(t("bookings.detail.errorNightlyRate"));
      return;
    }
    const nextQuantities = selectedAddonIds.reduce<Record<string, number>>((acc, addonId) => {
      acc[addonId] = Math.max(1, Number(addonQuantities[addonId]) || 1);
      return acc;
    }, {});
    const nextAddonDates = selectedAddonIds.reduce<Record<string, string[]>>((acc, addonId) => {
      if (booking.addonDates?.[addonId]) acc[addonId] = booking.addonDates[addonId];
      return acc;
    }, {});
    setSaving(true);
    try {
      await onSave({
        checkIn,
        checkOut,
        adults: newAdults,
        children: newChildren,
        nightlyRate: newNightlyRate,
        addonIds: selectedAddonIds,
        addonQuantities: nextQuantities,
        addonDates: nextAddonDates,
      });
      onClose();
    } catch (e) {
      setErr(errMessage(e, t("bookings.detail.failedToModify")));
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-semibold text-gray-900 mb-1">
        {t("bookings.detail.modifyBooking")}
      </h3>
      <p className="text-sm text-gray-500 mb-5">{t("bookings.detail.modifyBookingDescription")}</p>
      <div className="space-y-4 mb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label={t("bookings.detail.checkIn")}
            value={checkIn}
            onChange={setCheckIn}
            type="date"
          />
          <Field
            label={t("bookings.detail.checkOut")}
            value={checkOut}
            onChange={setCheckOut}
            type="date"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field
            label={t("bookings.modal.adultsLabel")}
            value={adults}
            onChange={setAdults}
            type="number"
          />
          <Field
            label={t("bookings.modal.childrenLabel")}
            value={children}
            onChange={setChildren}
            type="number"
          />
          <Field
            label={t("bookings.modal.nightlyRateLabel", { currency: booking.currency })}
            value={nightlyRate}
            onChange={setNightlyRate}
            type="number"
          />
        </div>
        <div>
          <p className="block text-xs font-medium text-gray-600 mb-2">
            {t("bookings.detail.addons")}
          </p>
          {addonsLoading ? (
            <p className="text-sm text-gray-500">{t("bookings.detail.loadingAddons")}</p>
          ) : availableAddons.length === 0 ? (
            <p className="text-sm text-gray-500 border border-gray-200 rounded-lg px-3 py-2">
              {t("bookings.detail.noAddonsConfigured")}
            </p>
          ) : (
            <div className="space-y-2 max-h-56 overflow-auto pr-1">
              {availableAddons.map((addon) => {
                const selected = selectedAddonIds.includes(addon.id);
                return (
                  <label
                    key={addon.id}
                    className="flex items-center gap-3 border border-gray-200 rounded-lg px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => toggleAddon(addon, e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-gray-900 focus:ring-gray-900"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-gray-900 truncate">
                        {addon.name}
                      </span>
                      <span className="block text-xs text-gray-500">
                        {formatCurrency(addon.price, addon.currency)}
                        {addon.perPerson ? ` · ${t("bookings.detail.perPerson")}` : ""}
                        {addon.perNight ? ` · ${t("bookings.detail.perNight")}` : ""}
                      </span>
                    </span>
                    {selected && (
                      <input
                        type="number"
                        min={1}
                        value={addonQuantities[addon.id] || 1}
                        onChange={(e) =>
                          setAddonQuantities((prev) => ({
                            ...prev,
                            [addon.id]: Math.max(1, Number(e.target.value) || 1),
                          }))
                        }
                        aria-label={t("bookings.detail.addonQuantity", { name: addon.name })}
                        className="w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                      />
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-4">
        {t("bookings.detail.pricingMayChange")}
      </p>
      {err && (
        <p className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {err}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
        >
          {t("bookings.modal.cancelButton")}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-black rounded-lg disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("bookings.modal.saveChanges")}
        </button>
      </div>
    </Modal>
  );
}

function EditAddOnsModal({
  booking,
  onClose,
  onSave,
}: {
  booking: Booking;
  onClose: () => void;
  onSave: (payload: {
    addonIds: string[];
    addonQuantities: Record<string, number>;
    addonDates: Record<string, string[]>;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [availableAddons, setAvailableAddons] = useState<BookingAddon[]>([]);
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>(booking.addonIds || []);
  const [addonQuantities, setAddonQuantities] = useState<Record<string, number>>(
    booking.addonQuantities || {},
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let active = true;
    bookingsService
      .listAvailableAddons(booking.id)
      .then((addons) => {
        if (!active) return;
        setAvailableAddons(addons);
        const availableIds = new Set(addons.map((addon) => addon.id));
        setSelectedAddonIds((prev) => prev.filter((id) => availableIds.has(id)));
        setAddonQuantities((prev) =>
          Object.fromEntries(Object.entries(prev).filter(([id]) => availableIds.has(id))),
        );
      })
      .catch((e) => {
        if (active) setErr(errMessage(e, t("bookings.detail.failedToLoadAddons")));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [booking.id, t]);

  const nextAddonTotal = calculateAddOnsTotal(
    availableAddons,
    selectedAddonIds,
    addonQuantities,
    booking.nights,
    booking.adults,
  );
  const nextTotal = booking.nightlyRate * booking.nights * booking.numberOfRooms + nextAddonTotal;

  const handleSave = async () => {
    setErr("");
    setSaving(true);
    const addonMap = new Map(availableAddons.map((addon) => [addon.id, addon]));
    const nextQuantities = selectedAddonIds.reduce<Record<string, number>>((acc, addonId) => {
      const addon = addonMap.get(addonId);
      if (addon) {
        acc[addonId] = clampAddOnQuantity(
          addon,
          addonQuantities[addonId] || 1,
          booking.nights || 1,
          booking.adults,
        );
      }
      return acc;
    }, {});
    const nextAddonDates = selectedAddonIds.reduce<Record<string, string[]>>((acc, addonId) => {
      if (booking.addonDates?.[addonId]) acc[addonId] = booking.addonDates[addonId];
      return acc;
    }, {});
    try {
      await onSave({
        addonIds: selectedAddonIds,
        addonQuantities: nextQuantities,
        addonDates: nextAddonDates,
      });
      onClose();
    } catch (e) {
      setErr(errMessage(e, t("bookings.detail.failedToSaveAddons")));
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <h3 className="text-lg font-semibold text-gray-900 mb-1">
        {t("bookings.detail.editAddons")}
      </h3>
      <p className="text-sm text-gray-500 mb-5">{t("bookings.detail.editAddonsDescription")}</p>
      {loading ? (
        <p className="text-sm text-gray-500 border border-gray-200 rounded-lg px-3 py-2">
          {t("bookings.detail.loadingAddons")}
        </p>
      ) : availableAddons.length === 0 ? (
        <p className="text-sm text-gray-500 border border-gray-200 rounded-lg px-3 py-2">
          {t("bookings.detail.noAddonsConfigured")}
        </p>
      ) : (
        <div className="space-y-4">
          <AddOnListPicker
            addons={availableAddons}
            selectedIds={selectedAddonIds}
            quantities={addonQuantities}
            currency={booking.currency}
            nights={booking.nights || 1}
            adults={booking.adults}
            onChange={(ids, quantities) => {
              setSelectedAddonIds(ids);
              setAddonQuantities(quantities);
            }}
          />
          <SelectedAddOnSummary
            addons={availableAddons}
            selectedIds={selectedAddonIds}
            quantities={addonQuantities}
            currency={booking.currency}
            nights={booking.nights || 1}
            adults={booking.adults}
            onRemove={(addonId) => {
              setSelectedAddonIds((prev) => prev.filter((id) => id !== addonId));
              setAddonQuantities((prev) => {
                const next = { ...prev };
                delete next[addonId];
                return next;
              });
            }}
          />
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-sm">
            <div className="flex justify-between text-gray-600">
              <span>{t("bookings.detail.addons")}</span>
              <span>{formatCurrency(nextAddonTotal, booking.currency)}</span>
            </div>
            <div className="flex justify-between font-semibold text-gray-900 pt-1 mt-1 border-t border-gray-200">
              <span>{t("bookings.detail.projectedTotal")}</span>
              <span>{formatCurrency(nextTotal, booking.currency)}</span>
            </div>
          </div>
        </div>
      )}
      {err && (
        <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {err}
        </p>
      )}
      <div className="flex justify-end gap-3 mt-5">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
        >
          {t("bookings.modal.cancelButton")}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || loading}
          className="px-4 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-black rounded-lg disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("bookings.detail.saveAddons")}
        </button>
      </div>
    </Modal>
  );
}

// ─── Page ────────────────────────────────────────────────────────────

export default function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { locale, t } = useTranslation();
  const { id } = use(params);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [directInboxEligibleBookingId, setDirectInboxEligibleBookingId] = useState<string | null>(
    null,
  );
  const [policy, setPolicy] = useState<CancellationPolicy | null>(null);
  const [notes, setNotes] = useState<BookingNote[]>([]);
  const [guests, setGuests] = useState<BookingAdditionalGuest[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [resending, setResending] = useState(false);
  const resendKey = useRef<string | null>(null);
  const resendPending = useRef(false);
  const [resendNotice, setResendNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  const [paymentDeadlineExpired, setPaymentDeadlineExpired] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    variant?: "danger" | "default";
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);
  const [changeRequest, setChangeRequest] = useState<BookingChangeRequest | null>(null);
  const [decideOpen, setDecideOpen] = useState<"approve" | "decline" | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  const [decidingChange, setDecidingChange] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [noteDraftOpen, setNoteDraftOpen] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const noteSavePending = useRef(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState("");
  const [noteEditSaving, setNoteEditSaving] = useState(false);
  const noteEditPending = useRef(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [guestMessage, setGuestMessage] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [allRooms, setAllRooms] = useState<Room[]>([]);
  const [moveTarget, setMoveTarget] = useState<{
    assignmentId: string | null;
    position: number;
    fromRoomNumber: string | null;
  } | null>(null);
  const [assignTarget, setAssignTarget] = useState<{
    position: number;
    label: string;
  } | null>(null);
  const [bookerEditing, setBookerEditing] = useState(false);
  const [bookerSaving, setBookerSaving] = useState(false);
  const [nationalityEditing, setNationalityEditing] = useState(false);
  const [nationalityDraft, setNationalityDraft] = useState("");
  const [nationalitySaving, setNationalitySaving] = useState(false);
  const [nationalityError, setNationalityError] = useState("");
  const nationalitySavePending = useRef(false);
  const [bookerForm, setBookerForm] = useState({
    guestFirstName: "",
    guestLastName: "",
    guestGender: "",
    guestCountry: "",
    guestDateOfBirth: "",
    guestEmail: "",
    guestPhone: "",
    guestPassportNumber: "",
    specialRequests: "",
  });

  useEffect(() => {
    const deadline = booking?.hostResponseDeadline;
    if (!deadline) {
      setPaymentDeadlineExpired(false);
      return;
    }
    const update = () => setPaymentDeadlineExpired(Date.now() >= new Date(deadline).getTime());
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [booking?.hostResponseDeadline]);
  const [modifyOpen, setModifyOpen] = useState(false);
  const [addonEditOpen, setAddonEditOpen] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const b = await bookingsService.get(id);
      setBooking(b);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
    Promise.all([
      bookingsService.getChangeRequest(id).then(setChangeRequest).catch(console.error),
      bookingsService
        .listNotes(id)
        .then((r) => setNotes(r.notes))
        .catch(console.error),
      bookingsService
        .listAdditionalGuests(id)
        .then((r) => setGuests(r.guests))
        .catch(console.error),
      bookingsService
        .getPaymentSettings()
        .then((r) => setPolicy(r.cancellationPolicy))
        .catch(console.error),
      individualRoomsService.list().then(setAllRooms).catch(console.error),
    ]);
  }, [id]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    let cancelled = false;
    if (!booking || normalizeChannelKey(booking.channel) !== "direct") return;

    void resolveSelectedPmsPropertyId(t("bookings.detail.checkingInboxAccess"))
      .then((propertyId) => messagingService.listDirectBookings(propertyId))
      .then((candidates) => {
        if (!cancelled) {
          setDirectInboxEligibleBookingId(
            candidates.some((candidate) => candidate.guestBookingId === booking.id)
              ? booking.id
              : null,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setDirectInboxEligibleBookingId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [booking, t]);

  const doAction = useCallback(async (action: () => Promise<Booking>, errorMsg: string) => {
    setUpdating(true);
    setError("");
    try {
      const updated = await action();
      setBooking(updated);
    } catch (err) {
      setError(errMessage(err, errorMsg));
    } finally {
      setUpdating(false);
    }
  }, []);

  const handleAccept = () => {
    if (paymentDeadlineExpired) return;
    const message =
      booking?.paymentMethod === "card"
        ? t("bookings.detail.confirmAcceptCard")
        : booking?.paymentMethod === "pay_at_property"
          ? t("bookings.detail.confirmAcceptAtProperty")
          : t("bookings.detail.confirmAcceptBankTransfer");
    setConfirmDialog({
      message,
      confirmLabel: t("bookings.detail.accept"),
      onConfirm: () => {
        setConfirmDialog(null);
        doAction(() => bookingsService.acceptBooking(id), t("bookings.detail.failedToAccept"));
      },
    });
  };

  const handleReject = () => {
    setRejectReason("");
    setRejectOpen(true);
  };

  const confirmReject = () => {
    setRejectOpen(false);
    doAction(
      () => bookingsService.rejectBooking(id, rejectReason.trim() || undefined),
      t("bookings.detail.failedToReject"),
    );
  };

  const handleApproveChange = async () => {
    setDecidingChange(true);
    setError("");
    try {
      if (!changeRequest) return;
      const cr = await bookingsService.approveChangeRequest(id, changeRequest.id);
      setChangeRequest(cr);
      const refreshed = await bookingsService.get(id);
      setBooking(refreshed);
      setDecideOpen(null);
    } catch (err) {
      setError(errMessage(err, t("bookings.detail.failedToApproveChange")));
    } finally {
      setDecidingChange(false);
    }
  };

  const handleDeclineChange = async () => {
    setDecidingChange(true);
    setError("");
    try {
      if (!changeRequest) return;
      const cr = await bookingsService.declineChangeRequest(
        id,
        changeRequest.id,
        declineReason.trim() || undefined,
      );
      setChangeRequest(cr);
      setDecideOpen(null);
    } catch (err) {
      setError(errMessage(err, t("bookings.detail.failedToDeclineChange")));
    } finally {
      setDecidingChange(false);
    }
  };

  const handleMarkPaid = () => {
    if (paymentDeadlineExpired) return;
    const methodLabel =
      booking?.paymentMethod === "bank_transfer"
        ? t("bookings.detail.bankTransferLower")
        : booking?.paymentMethod === "pay_at_property"
          ? t("bookings.detail.payAtHotelPaymentLower")
          : t("bookings.detail.paypalPayment");
    setConfirmDialog({
      message: t("bookings.detail.confirmPaymentReceived", { method: methodLabel }),
      confirmLabel: t("bookings.detail.markAsPaid"),
      onConfirm: () => {
        setConfirmDialog(null);
        doAction(() => bookingsService.markPaid(id), t("bookings.detail.failedToMarkPaid"));
      },
    });
  };

  const handleSaveNote = async () => {
    const body = noteDraft.trim();
    if (!body || noteSavePending.current) return;
    noteSavePending.current = true;
    setError("");
    setNoteSaving(true);
    try {
      const note = await bookingsService.createNote(id, body);
      setNotes((prev) => [note, ...prev]);
      setNoteDraft("");
      setNoteDraftOpen(false);
    } catch (err) {
      setError(errMessage(err, t("bookings.detail.failedToSaveNote")));
    } finally {
      noteSavePending.current = false;
      setNoteSaving(false);
    }
  };

  const handleSaveNoteEdit = async () => {
    const body = editingNoteDraft.trim();
    if (!editingNoteId || !body || noteEditPending.current) return;
    noteEditPending.current = true;
    setError("");
    setNoteEditSaving(true);
    try {
      const note = await bookingsService.updateNote(id, editingNoteId, body);
      setNotes((prev) => prev.map((candidate) => (candidate.id === note.id ? note : candidate)));
      setEditingNoteId(null);
      setEditingNoteDraft("");
    } catch (err) {
      setError(errMessage(err, t("bookings.detail.failedToUpdateNote")));
    } finally {
      noteEditPending.current = false;
      setNoteEditSaving(false);
    }
  };

  const handleDeleteNote = (noteId: string) => {
    setConfirmDialog({
      message: t("bookings.detail.deleteNoteConfirm"),
      variant: "danger",
      confirmLabel: t("common.delete"),
      onConfirm: async () => {
        setConfirmDialog(null);
        setError("");
        try {
          await bookingsService.deleteNote(id, noteId);
          setNotes((prev) => prev.filter((n) => n.id !== noteId));
        } catch (err) {
          setError(errMessage(err, t("bookings.detail.failedToDeleteNote")));
        }
      },
    });
  };

  const handleAddGuest = async () => {
    const now = new Date().toISOString();
    setGuests((prev) => [
      ...prev,
      {
        id: `${DRAFT_GUEST_ID_PREFIX}${crypto.randomUUID()}`,
        bookingId: id,
        position: prev.length + 1,
        firstName: "",
        lastName: "",
        gender: "",
        nationality: "",
        dateOfBirth: null,
        email: "",
        phone: "",
        guestContactHidden: false,
        passportNumber: "",
        roomPosition: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  };

  const handleSaveGuest = async (guestId: string, patch: BookingAdditionalGuestPayload) => {
    try {
      const updated = guestId.startsWith(DRAFT_GUEST_ID_PREFIX)
        ? await bookingsService.createAdditionalGuest(id, patch)
        : await bookingsService.updateAdditionalGuest(id, guestId, patch);
      setGuests((prev) => prev.map((g) => (g.id === guestId ? updated : g)));
    } catch (err) {
      setError(errMessage(err, t("bookings.detail.failedToSaveGuest")));
    }
  };

  const handleDeleteGuest = async (guestId: string) => {
    setConfirmDialog({
      message: t("bookings.detail.deleteGuestConfirm"),
      variant: "danger",
      confirmLabel: t("common.delete"),
      onConfirm: async () => {
        setConfirmDialog(null);
        if (guestId.startsWith(DRAFT_GUEST_ID_PREFIX)) {
          setGuests((prev) => prev.filter((g) => g.id !== guestId));
          return;
        }
        try {
          await bookingsService.deleteAdditionalGuest(id, guestId);
          setGuests((prev) => prev.filter((g) => g.id !== guestId));
        } catch (err) {
          setError(errMessage(err, t("bookings.detail.failedToDeleteGuest")));
        }
      },
    });
  };

  const handleEditBooker = () => {
    if (!booking) return;
    setBookerForm({
      guestFirstName: booking.guestFirstName,
      guestLastName: booking.guestLastName,
      guestGender: booking.guestGender,
      guestCountry: booking.guestCountry,
      guestDateOfBirth: booking.guestDateOfBirth ?? "",
      guestEmail: booking.guestEmail,
      guestPhone: booking.guestPhone,
      guestPassportNumber: booking.guestPassportNumber,
      specialRequests: booking.specialRequests,
    });
    setBookerEditing(true);
  };

  const handleSaveBooker = async () => {
    setBookerSaving(true);
    try {
      const updated = await bookingsService.update(id, {
        guestFirstName: bookerForm.guestFirstName,
        guestLastName: bookerForm.guestLastName,
        guestGender: bookerForm.guestGender,
        guestCountry: bookerForm.guestCountry,
        guestDateOfBirth: bookerForm.guestDateOfBirth || null,
        guestEmail: bookerForm.guestEmail,
        guestPhone: bookerForm.guestPhone,
        guestPassportNumber: bookerForm.guestPassportNumber,
        specialRequests: bookerForm.specialRequests,
      });
      setBooking(updated);
      setBookerEditing(false);
    } catch (err) {
      setError(errMessage(err, t("bookings.detail.failedToSaveBooker")));
    } finally {
      setBookerSaving(false);
    }
  };

  const handleEditNationality = () => {
    if (!booking) return;
    setNationalityError("");
    setNationalityDraft(booking.guestCountry);
    setNationalityEditing(true);
  };

  const handleSaveNationality = async () => {
    if (!nationalityDraft || nationalitySavePending.current) return;
    nationalitySavePending.current = true;
    setNationalitySaving(true);
    setNationalityError("");
    try {
      const correction = await bookingsService.correctPrimaryGuestNationality(id, nationalityDraft);
      setBooking((current) => (current ? { ...current, ...correction } : current));
      setNationalityError("");
      setNationalityEditing(false);
    } catch (err) {
      setNationalityError(errMessage(err, t("bookings.detail.failedToSaveNationality")));
    } finally {
      nationalitySavePending.current = false;
      setNationalitySaving(false);
    }
  };

  const handleMoveRoom = async (
    assignmentId: string | null,
    position: number,
    toRoomId: string,
  ) => {
    const selector: AssignmentSelector = assignmentId ? { assignmentId } : { position };
    const updated = await bookingsService.moveRoom(id, toRoomId, selector);
    setBooking(updated);
  };

  const handleModifyBooking = async (payload: {
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
    nightlyRate: number;
    addonIds: string[];
    addonQuantities: Record<string, number>;
    addonDates: Record<string, string[]>;
  }) => {
    const updated = await bookingsService.update(id, payload);
    setBooking(updated);
  };

  const handleSaveAddOns = async (payload: {
    addonIds: string[];
    addonQuantities: Record<string, number>;
    addonDates: Record<string, string[]>;
  }) => {
    const updated = await bookingsService.update(id, payload);
    setBooking(updated);
  };

  const handleAssignGuests = async () => {
    throw new Error(t("bookings.detail.guestAssignmentUnavailable"));
  };

  const handleCancelBooking = async () => {
    if (!booking || booking.status !== "confirmed") {
      setCancelOpen(false);
      return;
    }
    const reason = cancelReason.trim();
    if (!reason || cancelling) return;
    setCancelling(true);
    setError("");
    try {
      await bookingsService.cancelWithReason(id, reason, guestMessage.trim() || undefined);
      setBooking({ ...booking, status: "cancelled" });
      setCancelOpen(false);
      setCancelReason("");
      setGuestMessage("");
      try {
        setBooking(await bookingsService.get(id));
      } catch {
        setError(t("bookings.detail.canceledRefreshFailed"));
      }
    } catch (err) {
      setError(errMessage(err, t("bookings.detail.failedToCancel")));
    } finally {
      setCancelling(false);
    }
  };

  // ── Pricing math (ticket §2: must reconcile) ───────────────────────
  const pricingBreakdown = useMemo(() => {
    if (!booking) return null;
    const roomsCost = booking.nightlyRate * booking.nights * booking.numberOfRooms;
    const addonsCost = booking.addonTotal || 0;
    const computed = roomsCost + addonsCost;
    const mismatch = Math.abs(computed - booking.totalAmount) > 0.01;
    return { roomsCost, addonsCost, computed, mismatch };
  }, [booking]);

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!booking) {
    return (
      <div className="p-6">
        <p className="text-gray-500">{t("bookings.detail.notFound")}</p>
      </div>
    );
  }

  const isPending = booking.status === "pending";
  const canCancelBooking = booking.status === "confirmed";
  const canCancelManualBooking = canCancelBooking && booking.channel === "manual";
  const canCheckIn = booking.status === "confirmed";
  // VAY-404: treat 'declined' (host rejected) the same as cancelled/expired
  // for read-only/disabled UI affordances — the booking is terminal.
  const isCancelled =
    booking.status === "cancelled" ||
    booking.status === "declined" ||
    booking.status === "expired" ||
    booking.status === "no_show";
  const hasDeadline = isPending && booking.hostResponseDeadline;
  const hasAcceptedBankDeadline =
    booking.status === "confirmed" &&
    booking.paymentMethod === "bank_transfer" &&
    booking.paymentStatus === "unpaid" &&
    booking.hostResponseDeadline;
  const totalParty = booking.adults + booking.children;
  const additionalCapacity = Math.max(0, totalParty - 1);

  // Build the per-room rows: bookings have numberOfRooms physical slots; the
  // assignedRooms list says which physical rooms map to which slot. If we
  // don't have an assignedRoom for every slot (e.g. an unassigned multi-room
  // booking), pad with an "unassigned" placeholder so the count matches.
  const roomRows = Array.from({ length: Math.max(1, booking.numberOfRooms) }, (_, idx) => {
    const assigned = booking.assignedRooms.find((a) => a.position === idx);
    return {
      position: idx,
      assignmentId: assigned?.assignmentId ?? null,
      roomId: assigned?.roomId ?? null,
      roomNumber: assigned?.roomNumber ?? null,
    };
  });
  const hasHeterogeneousStays = booking.numberOfRooms > 1;

  // Per-room guest count: explicit additional-guest assignments only, plus
  // the booker who lives implicitly in the primary room (position 0).
  // Unassigned additional guests don't count anywhere yet and are surfaced
  // on the Additional guests card header instead.
  const perRoomAssigned = roomRows.map(
    (_, idx) => guests.filter((g) => g.roomPosition === idx).length + (idx === 0 ? 1 : 0),
  );
  const unassignedGuests = guests.filter((g) => g.roomPosition == null).length;

  // Room-picker options for the per-guest dropdown + AssignGuestsModal label.
  const roomOptions: RoomOption[] = roomRows.map((row, idx) => ({
    position: idx,
    label: row.roomNumber
      ? t("bookings.detail.roomNumber", { number: row.roomNumber })
      : t("bookings.detail.roomSlot", { number: idx + 1 }),
  }));

  // Candidates for Move: same room type, exclude rooms already on this booking.
  const ownRoomIds = new Set(
    booking.assignedRooms.map((r) => r.roomId).filter((rid): rid is string => !!rid),
  );
  const moveCandidates = allRooms.filter(
    (r) => r.roomTypeId === booking.roomTypeId && !ownRoomIds.has(r.id),
  );

  const channelKey = normalizeChannelKey(booking.channel);
  const channelLabel =
    channelKey === "direct"
      ? t("calendar.channelDirect")
      : channelKey === "airbnb"
        ? t("calendar.channelAirbnb")
        : channelKey === "booking.com"
          ? t("calendar.channelBookingCom")
          : channelKey === "expedia"
            ? t("calendar.channelExpedia")
            : getChannelLabel(booking.channel);
  const canMessageGuest = channelKey === "direct" && directInboxEligibleBookingId === booking.id;
  const rateType = t("bookings.detail.flexible"); // current bookings always use the hotel's default rate plan.

  // Add-ons rendered with quantity-suffix from addonQuantities.
  const addonRows = booking.addonIds.map((addonId, idx) => {
    const qty = booking.addonQuantities[addonId];
    const name = booking.addonNames?.[idx] || addonId;
    return { addonId, name, qty };
  });

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      {/* 1. Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/bookings" className="text-gray-400 hover:text-gray-600 -ml-1 p-1">
          <ArrowLeftIcon className="w-5 h-5" />
        </Link>
        <h1 className="text-xl font-bold text-gray-900">
          {t("bookings.detail.title", { reference: booking.bookingReference })}
        </h1>
        <span
          className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-medium ${BOOKING_STATUS_STYLES[booking.status] || "bg-gray-100 text-gray-600"}`}
        >
          {bookingStatusLabel(booking.status, t)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {canMessageGuest && (
            <Link
              href={`/inbox?booking=${encodeURIComponent(booking.id)}`}
              className="inline-flex min-h-9 items-center rounded-md border border-gray-200 px-3 text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              {t("bookings.detail.messageGuest")}
            </Link>
          )}
          <OverflowMenu
            resending={resending}
            onResend={() =>
              setConfirmDialog({
                message: "Resend the booking confirmation email to the guest?",
                confirmLabel: "Resend",
                onConfirm: async () => {
                  if (resendPending.current) return;
                  resendPending.current = true;
                  resendKey.current ??= crypto.randomUUID();
                  setConfirmDialog(null);
                  setResending(true);
                  setResendNotice(null);
                  try {
                    const sent = await bookingsService.resendConfirmation(
                      booking.id,
                      resendKey.current,
                    );
                    resendKey.current = null;
                    if (!sent)
                      throw new Error("Confirmation email could not be sent. Please try again.");
                    setResendNotice({
                      error: false,
                      text: "Confirmation email sent successfully.",
                    });
                  } catch (error) {
                    setResendNotice({
                      error: true,
                      text: errMessage(
                        error,
                        "Could not confirm email delivery. Please retry to check the request.",
                      ),
                    });
                  } finally {
                    resendPending.current = false;
                    setResending(false);
                  }
                },
              })
            }
            onPrint={() => window.print()}
            onExport={() => {
              const blob = new Blob([JSON.stringify(booking, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `${booking.bookingReference}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          />
        </div>
      </div>

      {/* Pending-deadline + change-request banners (carried over) */}
      {hasDeadline && (
        <div className="mb-4 p-4 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-800">
              {t("bookings.detail.actionRequired")}
            </p>
            <p className="text-xs text-amber-600">{t("bookings.detail.autoExpireWarning")}</p>
          </div>
          <CountdownTimer deadline={booking.hostResponseDeadline!} />
        </div>
      )}

      {booking.guestWithdrawn && (
        <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
          {t("bookings.detail.guestWithdrawn")}
        </div>
      )}

      {booking.status === "checked_in" && booking.checkInPendingFlags.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-950">
            {t("bookings.detail.checkInCompletedWithOutstanding", {
              count: booking.checkInPendingFlags.length,
              item: t(
                booking.checkInPendingFlags.length === 1
                  ? "bookings.detail.outstandingItem"
                  : "bookings.detail.outstandingItems",
              ),
            })}
          </p>
          <p className="mt-1 text-xs text-amber-800">{booking.checkInPendingFlags.join(", ")}</p>
        </div>
      )}

      {changeRequest && changeRequest.status === "pending" && (
        <div className="mb-4 p-5 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="mb-3">
            <p className="text-sm font-semibold text-blue-900">
              {t("bookings.detail.changeRequestPending")}
            </p>
            <p className="text-xs text-blue-700">{t("bookings.detail.changeRequestDescription")}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm mb-4">
            <div>
              <p className="text-blue-900 font-medium">{t("bookings.detail.current")}</p>
              <p className="text-blue-800">
                {changeRequest.oldCheckIn} → {changeRequest.oldCheckOut}
              </p>
              <p className="text-blue-800">
                {t("bookings.detail.totalWithAmount", {
                  amount: formatCurrency(changeRequest.oldTotal, changeRequest.currency),
                })}
              </p>
            </div>
            <div>
              <p className="text-blue-900 font-medium">{t("bookings.detail.requested")}</p>
              <p className="text-blue-800">
                {changeRequest.requestedCheckIn} → {changeRequest.requestedCheckOut}
              </p>
              <p className="text-blue-800">
                {t("bookings.detail.totalWithAmount", {
                  amount: formatCurrency(changeRequest.newTotal, changeRequest.currency),
                })}
              </p>
              {changeRequest.requestedAddonNames.length > 0 && (
                <p className="text-blue-800 mt-1">
                  {t("bookings.detail.addonsWithNames", {
                    names: changeRequest.requestedAddonNames.join(", "),
                  })}
                </p>
              )}
            </div>
          </div>
          <div className="text-sm text-blue-900 font-medium mb-4">
            {t("bookings.detail.priceDifference", {
              difference:
                changeRequest.priceDifference === 0
                  ? t("bookings.detail.noChange")
                  : changeRequest.priceDifference > 0
                    ? t("bookings.detail.balanceIncrease", {
                        amount: `+${formatCurrency(changeRequest.priceDifference, changeRequest.currency)}`,
                      })
                    : t("bookings.detail.balanceDecrease", {
                        amount: formatCurrency(
                          changeRequest.priceDifference,
                          changeRequest.currency,
                        ),
                      }),
            })}
          </div>
          <div className="flex gap-3 flex-wrap">
            <button
              onClick={() => setDecideOpen("approve")}
              disabled={decidingChange}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              <CheckCircleIcon className="w-4 h-4" />
              {t("bookings.detail.approveChange")}
            </button>
            <button
              onClick={() => {
                setDeclineReason("");
                setDecideOpen("decline");
              }}
              disabled={decidingChange}
              className="inline-flex items-center gap-1.5 px-4 py-2 border border-red-200 text-red-600 text-sm font-medium rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              <XCircleIcon className="w-4 h-4" />
              {t("bookings.detail.declineChange")}
            </button>
          </div>
        </div>
      )}

      {changeRequest && changeRequest.status !== "pending" && (
        <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-600">
          {t("bookings.detail.lastChangeRequestWas")}{" "}
          <span className="font-medium text-gray-800">
            {t(`bookings.detail.changeRequestStatus.${changeRequest.status}`)}
          </span>
          {changeRequest.decidedAt && (
            <>
              {" "}
              {t("bookings.detail.onDate", {
                date: formatDateTime(changeRequest.decidedAt, locale),
              })}
            </>
          )}
          {changeRequest.declineReason && (
            <span className="block mt-1 text-xs text-gray-500">
              {t("bookings.detail.reasonWithText", { reason: changeRequest.declineReason })}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="space-y-6">
        {/* 2. Stay details */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3 mb-5">
            <h2 className="text-sm font-semibold text-gray-900">
              {t("bookings.detail.stayDetails")}
            </h2>
            {/* Booking-level Modify (dates / guest count for whole booking) */}
            <button
              disabled={!LEGACY_BOOKING_WRITES_AVAILABLE}
              onClick={() => setModifyOpen(true)}
              title={t("bookings.detail.modificationsUnavailable")}
              aria-label={t("bookings.detail.modifyUnavailableLabel")}
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs font-medium text-gray-400"
            >
              <PencilSquareIcon className="w-4 h-4" />
              {t("bookings.detail.modify")}
              <span className="rounded bg-gray-100 px-1 py-0.5 text-[9px] font-medium text-gray-500">
                {t("bookings.detail.soon")}
              </span>
            </button>
          </div>

          {hasHeterogeneousStays && (
            <div className="mb-6">
              <BookingStaySummary stays={booking.stays} expectedCount={booking.numberOfRooms} />
            </div>
          )}

          {/* Summary row */}
          <div
            hidden={hasHeterogeneousStays}
            className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-6"
          >
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">
                {t("bookings.detail.checkIn")}
              </p>
              <p className="font-semibold text-gray-900">
                {formatDateLong(booking.checkIn, locale)}
              </p>
              <p className="text-xs text-gray-500">
                {t("bookings.detail.fromTime", { time: "15:00" })}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">
                {t("bookings.detail.checkOut")}
              </p>
              <p className="font-semibold text-gray-900">
                {formatDateLong(booking.checkOut, locale)}
              </p>
              <p className="text-xs text-gray-500">
                {t("bookings.detail.byTime", { time: "12:00" })}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">
                {t("bookings.detail.duration")}
              </p>
              <p className="font-semibold text-gray-900">
                {booking.nights} {t(booking.nights === 1 ? "common.night" : "common.nights")}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">
                {t("bookings.detail.totalGuests")}
              </p>
              <p className="font-semibold text-gray-900">
                {totalGuestsLabel(booking.adults, booking.children, t)}
              </p>
            </div>
          </div>

          {/* ROOMS sub-section */}
          <div hidden={hasHeterogeneousStays} className="mb-6">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {t("bookings.detail.roomsCount", { count: roomRows.length })}
            </p>
            <div className="space-y-2">
              {roomRows.map((row, idx) => (
                <div
                  key={row.position}
                  className="flex items-center gap-3 p-3 border border-gray-200 rounded-lg"
                >
                  <div
                    className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-white ${roomTypeColor(booking.roomTypeId)}`}
                    aria-hidden
                  >
                    <HomeModernIcon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{booking.roomName}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {row.roomNumber
                        ? t("bookings.detail.roomNumber", { number: row.roomNumber })
                        : t("bookings.modal.unassigned")}{" "}
                      {" · "}
                      {perRoomAssigned[idx]}{" "}
                      {t(perRoomAssigned[idx] === 1 ? "common.guest" : "common.guests")}
                      {idx === 0 && ` ${t("bookings.detail.includingBooker")}`}
                    </p>
                  </div>
                  <button
                    onClick={() =>
                      setAssignTarget({
                        position: idx,
                        label: row.roomNumber
                          ? t("bookings.detail.roomNumber", { number: row.roomNumber })
                          : t("bookings.detail.roomSlot", { number: idx + 1 }),
                      })
                    }
                    disabled
                    title={t("bookings.detail.guestAssignmentUnavailable")}
                    className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <PencilSquareIcon className="w-3.5 h-3.5" />
                    {t("bookings.detail.modify")}
                  </button>
                  <button
                    onClick={() =>
                      setMoveTarget({
                        assignmentId: row.assignmentId,
                        position: row.position,
                        fromRoomNumber: row.roomNumber,
                      })
                    }
                    disabled={
                      isCancelled ||
                      moveCandidates.length === 0 ||
                      (roomRows.length > 1 && !row.assignmentId && !row.roomId)
                    }
                    title={
                      roomRows.length > 1 && !row.assignmentId && !row.roomId
                        ? t("bookings.detail.unassignedRoomMoveUnavailable")
                        : moveCandidates.length === 0
                          ? t("bookings.detail.noOtherRoomsAvailable")
                          : t("bookings.detail.reassignRoom")
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <ArrowsRightLeftIcon className="w-3.5 h-3.5" />
                    {t("bookings.detail.move")}
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Add-ons sub-section (only if configured or already selected) */}
          {addonRows.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between gap-3 mb-3">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  {t("bookings.detail.addons")}
                </p>
                <span className="text-xs text-gray-500">
                  {t("settings.localization.editingUnavailable")}
                </span>
              </div>
              <div className="space-y-1.5 text-sm">
                {addonRows.map((row) => (
                  <div key={row.addonId} className="flex justify-between text-gray-700">
                    <span>{row.name}</span>
                    {row.qty && (
                      <span className="text-gray-500">
                        {t("bookings.detail.quantity", { quantity: row.qty })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pricing sub-section */}
          <div className="mb-6">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {t("bookings.detail.pricing")}
            </p>
            <div className="space-y-1.5 text-sm">
              {!hasHeterogeneousStays && (
                <div className="flex justify-between text-gray-700">
                  <span>
                    {roomRows.length} {t(roomRows.length === 1 ? "common.room" : "common.rooms")} ×{" "}
                    {booking.nights} {t(booking.nights === 1 ? "common.night" : "common.nights")} ×{" "}
                    {formatCurrency(booking.nightlyRate, booking.currency)}
                  </span>
                  <span className="font-medium text-gray-900">
                    {formatCurrency(pricingBreakdown?.roomsCost ?? 0, booking.currency)}
                  </span>
                </div>
              )}
              {(pricingBreakdown?.addonsCost ?? 0) > 0 && (
                <div className="flex justify-between text-gray-700">
                  <span>{t("bookings.detail.addons")}</span>
                  <span className="font-medium text-gray-900">
                    {formatCurrency(pricingBreakdown!.addonsCost, booking.currency)}
                  </span>
                </div>
              )}
              <div className="flex justify-between pt-2 mt-1 border-t border-gray-100">
                <span className="font-semibold text-gray-900">{t("bookings.tableTotal")}</span>
                <span className="font-bold text-gray-900">
                  {formatCurrency(booking.totalAmount, booking.currency)}
                </span>
              </div>
              {!hasHeterogeneousStays && pricingBreakdown?.mismatch && (
                <p className="mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                  {t("bookings.detail.pricingMismatch", {
                    charged: formatCurrency(booking.totalAmount, booking.currency),
                    computed: formatCurrency(pricingBreakdown.computed, booking.currency),
                  })}
                </p>
              )}
              {booking.platformFeeAmount != null && booking.platformFeeAmount > 0 && (
                <div className="flex justify-between text-xs text-gray-500 pt-1">
                  <span>{t("bookings.detail.platformFee")}</span>
                  <span>-{formatCurrency(booking.platformFeeAmount, booking.currency)}</span>
                </div>
              )}
              {booking.propertyPayoutAmount != null &&
                booking.propertyPayoutAmount !== booking.totalAmount && (
                  <div className="flex justify-between text-sm pt-2 border-t border-gray-100">
                    <span className="font-medium text-gray-700">
                      {t("bookings.detail.propertyPayout")}
                    </span>
                    <span className="font-bold text-green-700">
                      {formatCurrency(booking.propertyPayoutAmount, booking.currency)}
                    </span>
                  </div>
                )}
            </div>
          </div>

          {/* Payment sub-section */}
          <div className="mb-6">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              {t("bookings.detail.payment")}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-xs text-gray-500">{t("bookings.detail.expectedMethod")}</p>
                <p className="font-medium text-gray-900">
                  {expectedPaymentMethodLabel(booking.expectedPaymentMethod, t)}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">{t("bookings.detail.method")}</p>
                <p className="font-medium text-gray-900">
                  {booking.paymentMethod
                    ? paymentMethodDisplayLabel(booking.paymentMethod, t)
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">{t("bookings.tableStatus")}</p>
                {booking.paymentStatus ? (
                  <span
                    className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${PAYMENT_STATUS_STYLES[booking.paymentStatus] || "bg-gray-100 text-gray-600"}`}
                  >
                    {paymentStatusDisplayLabel(booking.paymentStatus, t)}
                  </span>
                ) : (
                  <p className="text-gray-400">—</p>
                )}
              </div>
              {!hasHeterogeneousStays && (
                <div>
                  <p className="text-xs text-gray-500">{t("bookings.detail.ratePlan")}</p>
                  <p className="font-medium text-gray-900">{rateType}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-gray-500">{t("bookings.tableSource")}</p>
                <p className="font-medium text-gray-900">{channelLabel}</p>
                {channelKey !== "direct" && (
                  <p className="text-xs text-gray-500">{t("bookings.detail.channelManaged")}</p>
                )}
              </div>
            </div>
            {booking.paymentBreakdown && (
              <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm">
                <div className="flex justify-between gap-4 py-1">
                  <span className="text-gray-600">{t("bookings.detail.grossAmount")}</span>
                  <span className="font-medium text-gray-900">
                    {formatPaymentCurrency(
                      booking.paymentBreakdown.grossAmount,
                      booking.paymentBreakdown.currency,
                    )}
                  </span>
                </div>
                <div className="flex justify-between gap-4 py-1">
                  <span className="text-gray-600">{t("bookings.detail.stripeFee")}</span>
                  <span className="font-medium text-gray-900">
                    -
                    {formatPaymentCurrency(
                      booking.paymentBreakdown.stripeFee,
                      booking.paymentBreakdown.currency,
                    )}
                  </span>
                </div>
                {booking.paymentBreakdown.vayadaCommission > 0 && (
                  <div className="flex justify-between gap-4 py-1">
                    <span className="text-gray-600">{t("bookings.detail.vayadaCommission")}</span>
                    <span className="font-medium text-gray-900">
                      -
                      {formatPaymentCurrency(
                        booking.paymentBreakdown.vayadaCommission,
                        booking.paymentBreakdown.currency,
                      )}
                    </span>
                  </div>
                )}
                <div className="mt-2 flex justify-between gap-4 border-t border-gray-200 pt-3">
                  <span className="font-semibold text-gray-900">
                    {t("bookings.detail.netPayout")}
                  </span>
                  <span className="font-bold text-green-700">
                    {formatPaymentCurrency(
                      booking.paymentBreakdown.netPayout,
                      booking.paymentBreakdown.currency,
                    )}
                  </span>
                </div>
                <p className="mt-3 border-t border-gray-200 pt-3 text-xs text-gray-500">
                  {t("bookings.detail.stripeFeeNotice")}
                </p>
              </div>
            )}
            {booking.depositRequired && (
              <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-semibold text-gray-900">
                      {t("bookings.detail.depositWithAmount", {
                        amount: formatCurrency(booking.depositAmount, booking.currency),
                      })}
                    </p>
                    <p className="text-xs text-gray-500">
                      {t("bookings.detail.depositPercentage", {
                        percentage: booking.depositPercentage ?? 0,
                      })}{" "}
                      {" · "}
                      {booking.paymentStatus === "captured"
                        ? t("bookings.detail.paidVia", {
                            method:
                              booking.paymentMethod === "card"
                                ? "Stripe"
                                : booking.paymentMethod
                                  ? paymentMethodDisplayLabel(booking.paymentMethod, t)
                                  : t("bookings.detail.manualMethod"),
                          })
                        : booking.paymentStatus === "refunded"
                          ? t("bookings.detail.depositWasRefunded")
                          : t("bookings.detail.pendingMethod", {
                              method: booking.paymentMethod
                                ? paymentMethodDisplayLabel(booking.paymentMethod, t)
                                : t("bookings.detail.manualMethod"),
                            })}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      booking.paymentStatus === "captured"
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : booking.paymentStatus === "refunded"
                          ? "bg-gray-100 text-gray-600 border border-gray-200"
                          : "bg-amber-50 text-amber-700 border border-amber-200"
                    }`}
                  >
                    {booking.paymentStatus === "captured"
                      ? t("bookings.detail.depositPaid")
                      : booking.paymentStatus === "refunded"
                        ? t("bookings.detail.depositRefunded")
                        : t("bookings.detail.depositPending")}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-gray-200 pt-3">
                  <p className="font-semibold text-gray-900">
                    {t("bookings.detail.balanceWithAmount", {
                      amount: formatCurrency(booking.balanceAmount, booking.currency),
                    })}
                  </p>
                  <p className="text-xs text-gray-500">{t("bookings.detail.dueAtProperty")}</p>
                </div>
                {booking.depositAmount > booking.totalAmount && (
                  <p className="text-xs text-amber-700">
                    {t("bookings.detail.depositExceedsTotal", {
                      amount: formatCurrency(
                        booking.depositAmount - booking.totalAmount,
                        booking.currency,
                      ),
                    })}
                  </p>
                )}
              </div>
            )}
            {booking.status === "confirmed" &&
              (booking.paymentMethod === "bank_transfer" ||
                booking.paymentMethod === "pay_at_property") &&
              booking.paymentStatus === "unpaid" && (
                <div className="mt-4 space-y-3">
                  {hasAcceptedBankDeadline ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <p className="text-xs text-amber-800">
                        {t("bookings.detail.paymentBeforeRelease")}
                      </p>
                      <CountdownTimer deadline={booking.hostResponseDeadline!} />
                    </div>
                  ) : null}
                  <button
                    onClick={handleMarkPaid}
                    disabled={updating || paymentDeadlineExpired}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    <CheckCircleIcon className="h-4 w-4" />
                    {booking.paymentMethod === "bank_transfer"
                      ? t("bookings.detail.markBankTransferReceived")
                      : t("bookings.detail.markPayAtHotelReceived")}
                  </button>
                </div>
              )}
          </div>
        </div>

        {/* 3. Guest information · booker */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-900">
              {t("bookings.detail.guestInformationBooker")}
            </h2>
            {!bookerEditing && (
              <button
                onClick={handleEditBooker}
                disabled={!LEGACY_BOOKING_WRITES_AVAILABLE}
                title={t("bookings.detail.bookerEditingUnavailable")}
                className="inline-flex cursor-not-allowed items-center gap-1 rounded bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-400"
                aria-label={t("bookings.detail.editBookerUnavailableLabel")}
              >
                <PencilSquareIcon className="w-4 h-4" />
                {t("bookings.detail.soon")}
              </button>
            )}
          </div>
          {bookerEditing ? (
            <div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field
                  label={t("bookings.modal.firstNameLabel")}
                  value={bookerForm.guestFirstName}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestFirstName: v })}
                />
                <Field
                  label={t("bookings.modal.lastNameLabel")}
                  value={bookerForm.guestLastName}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestLastName: v })}
                />
                <SelectField
                  label={t("bookings.detail.gender")}
                  value={bookerForm.guestGender}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestGender: v })}
                  options={[
                    { value: "", label: "—" },
                    { value: "female", label: t("bookings.detail.genderFemale") },
                    { value: "male", label: t("bookings.detail.genderMale") },
                    { value: "other", label: t("bookings.detail.genderOther") },
                    {
                      value: "prefer_not_to_say",
                      label: t("bookings.detail.genderPreferNotToSay"),
                    },
                  ]}
                />
                <NationalitySelect
                  value={bookerForm.guestCountry}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestCountry: v })}
                />
                <Field
                  label={t("bookings.detail.dateOfBirth")}
                  type="date"
                  value={bookerForm.guestDateOfBirth}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestDateOfBirth: v })}
                />
                <Field
                  label={t("bookings.detail.email")}
                  type="email"
                  value={bookerForm.guestEmail}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestEmail: v })}
                />
                <Field
                  label={t("bookings.detail.phoneOptional")}
                  type="tel"
                  value={bookerForm.guestPhone}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestPhone: v })}
                />
                <Field
                  label={t("bookings.detail.passportOptional")}
                  value={bookerForm.guestPassportNumber}
                  onChange={(v) => setBookerForm({ ...bookerForm, guestPassportNumber: v })}
                />
                <div className="md:col-span-2">
                  <label className="block">
                    <span className="block text-xs font-medium text-gray-600 mb-1">
                      {t("bookings.detail.specialRequests")}
                    </span>
                    <textarea
                      value={bookerForm.specialRequests}
                      onChange={(e) =>
                        setBookerForm({ ...bookerForm, specialRequests: e.target.value })
                      }
                      rows={3}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent resize-none"
                    />
                  </label>
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={() => setBookerEditing(false)}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 rounded-lg hover:bg-gray-100"
                >
                  {t("bookings.modal.cancelButton")}
                </button>
                <button
                  onClick={handleSaveBooker}
                  disabled={bookerSaving}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {bookerSaving ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-gray-500">{t("bookings.detail.name")}</p>
                  <p className="font-medium text-gray-900">
                    {booking.guestFirstName} {booking.guestLastName}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">{t("bookings.detail.email")}</p>
                  <p className="font-medium text-gray-900 break-words">{booking.guestEmail}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-500">{t("bookings.detail.phone")}</p>
                  <p className="font-medium text-gray-900">{booking.guestPhone || "—"}</p>
                </div>
                <div className="space-y-2">
                  {nationalityEditing ? (
                    <>
                      <NationalitySelect
                        value={nationalityDraft}
                        onChange={setNationalityDraft}
                        disabled={nationalitySaving}
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setNationalityError("");
                            setNationalityEditing(false);
                          }}
                          disabled={nationalitySaving}
                          className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                        >
                          {t("bookings.modal.cancelButton")}
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveNationality}
                          disabled={!nationalityDraft || nationalitySaving}
                          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {nationalitySaving
                            ? t("common.saving")
                            : t("bookings.detail.saveNationality")}
                        </button>
                      </div>
                      {nationalityError && (
                        <p role="alert" className="text-xs font-medium text-red-700">
                          {nationalityError}
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs text-gray-500">
                            {t("bookings.detail.nationality")}
                          </p>
                          <p className="font-medium text-gray-900">
                            {nationalityDisplayLabel(booking.guestCountry) || "—"}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={handleEditNationality}
                          aria-label={
                            booking.guestCountryReviewRequired
                              ? t("bookings.detail.correctNationality")
                              : t("bookings.detail.editNationality")
                          }
                          className="inline-flex items-center gap-1 rounded bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-100"
                        >
                          <PencilSquareIcon className="h-3.5 w-3.5" />
                          {booking.guestCountryReviewRequired
                            ? t("bookings.detail.correct")
                            : t("common.edit")}
                        </button>
                      </div>
                      {booking.guestCountryReviewRequired && (
                        <p role="status" className="text-xs font-medium text-amber-700">
                          {t("bookings.detail.needsReview")}
                          {booking.guestCountryRaw
                            ? ` · ${t("bookings.detail.importedValue", {
                                value: booking.guestCountryRaw,
                              })}`
                            : ""}
                        </p>
                      )}
                    </>
                  )}
                </div>
                {booking.guestGender && (
                  <div>
                    <p className="text-xs text-gray-500">{t("bookings.detail.gender")}</p>
                    <p className="font-medium text-gray-900 capitalize">
                      {booking.guestGender === "prefer_not_to_say"
                        ? t("bookings.detail.genderPreferNotToSay")
                        : booking.guestGender === "female"
                          ? t("bookings.detail.genderFemale")
                          : booking.guestGender === "male"
                            ? t("bookings.detail.genderMale")
                            : booking.guestGender === "other"
                              ? t("bookings.detail.genderOther")
                              : booking.guestGender}
                    </p>
                  </div>
                )}
                {booking.guestDateOfBirth && (
                  <div>
                    <p className="text-xs text-gray-500">{t("bookings.detail.dateOfBirth")}</p>
                    <p className="font-medium text-gray-900">
                      {formatDateLong(booking.guestDateOfBirth, locale)}
                    </p>
                  </div>
                )}
                {booking.guestPassportNumber && (
                  <div>
                    <p className="text-xs text-gray-500">{t("bookings.detail.passport")}</p>
                    <p className="font-medium text-gray-900">{booking.guestPassportNumber}</p>
                  </div>
                )}
              </div>
              {(booking.specialRequests || booking.estimatedArrivalTime) && (
                <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                  {booking.specialRequests && (
                    <div>
                      <p className="text-xs text-gray-500">
                        {t("bookings.detail.specialRequests")}
                      </p>
                      <p className="text-gray-900 whitespace-pre-wrap">{booking.specialRequests}</p>
                    </div>
                  )}
                  {booking.estimatedArrivalTime && (
                    <div>
                      <p className="text-xs text-gray-500">
                        {t("bookings.detail.estimatedArrivalTime")}
                      </p>
                      <p className="font-medium text-gray-900">{booking.estimatedArrivalTime}</p>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 4. Additional guests */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">
                {t("bookings.detail.additionalGuests")}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {t("bookings.detail.additionalGuestProgress", {
                  party: totalParty,
                  guestLabel: t(totalParty === 1 ? "common.guest" : "common.guests"),
                  added: guests.length,
                  capacity: additionalCapacity,
                })}
                {roomRows.length > 1 && unassignedGuests > 0 && (
                  <>
                    {" · "}
                    {t("bookings.detail.unassignedGuestCount", { count: unassignedGuests })}
                  </>
                )}
              </p>
            </div>
            <button
              onClick={handleAddGuest}
              disabled={guests.length >= additionalCapacity || channelKey !== "direct"}
              title={
                channelKey !== "direct"
                  ? t("bookings.detail.channelGuestPiiLimited")
                  : guests.length >= additionalCapacity
                    ? t("bookings.detail.allGuestsAdded")
                    : ""
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-900 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <PlusIcon className="w-4 h-4" />
              {t("bookings.detail.addGuest")}
            </button>
          </div>
          {guests.length === 0 ? (
            <p className="text-sm text-gray-500">{t("bookings.detail.noAdditionalGuests")}</p>
          ) : (
            <div className="space-y-2">
              {guests.map((g, idx) => (
                <AdditionalGuestRow
                  key={g.id}
                  guest={g}
                  position={idx + 1}
                  total={additionalCapacity}
                  roomOptions={roomOptions}
                  onSave={(patch) => handleSaveGuest(g.id, patch)}
                  onDelete={() => handleDeleteGuest(g.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* 5. Internal notes */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <h2 className="text-sm font-semibold text-gray-900">
              {t("bookings.detail.internalNotes")}
            </h2>
            <button
              onClick={() => setNoteDraftOpen((v) => !v)}
              disabled={noteEditSaving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-900 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <PlusIcon className="w-4 h-4" />
              {t("bookings.detail.addNote")}
            </button>
          </div>
          {noteDraftOpen && (
            <div className="mb-4">
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                disabled={noteSaving}
                placeholder={t("bookings.detail.notePlaceholder")}
                rows={3}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent resize-none"
              />
              <div className="flex justify-end gap-2 mt-2">
                <button
                  onClick={() => {
                    setNoteDraft("");
                    setNoteDraftOpen(false);
                  }}
                  disabled={noteSaving}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
                >
                  {t("bookings.modal.cancelButton")}
                </button>
                <button
                  onClick={handleSaveNote}
                  disabled={!noteDraft.trim() || noteSaving}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {noteSaving ? t("common.saving") : t("bookings.detail.saveNote")}
                </button>
              </div>
            </div>
          )}
          {notes.length === 0 ? (
            <p className="text-sm text-gray-500">{t("bookings.detail.noNotes")}</p>
          ) : (
            <div className="space-y-3">
              {notes.map((n) => (
                <div key={n.id} className="border border-gray-200 rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-xs text-gray-500">
                      <span className="font-medium text-gray-700">
                        {n.authorName || t("bookings.detail.unknown")}
                      </span>{" "}
                      · {formatDateTime(n.createdAt, locale)}
                      {n.source === "check-in" && (
                        <span className="ml-2 rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                          {t("bookings.detail.checkIn")}
                        </span>
                      )}
                      {n.source === "check-out" && (
                        <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                          {t("bookings.detail.checkOut")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => {
                          setEditingNoteId(n.id);
                          setEditingNoteDraft(n.body);
                        }}
                        disabled={noteEditSaving}
                        className="rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={t("bookings.detail.editNote")}
                      >
                        <PencilSquareIcon className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => handleDeleteNote(n.id)}
                        disabled={noteEditSaving}
                        className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                        aria-label={t("bookings.detail.deleteNote")}
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {editingNoteId === n.id ? (
                    <div className="mt-2">
                      <textarea
                        aria-label={t("bookings.detail.editNoteText")}
                        value={editingNoteDraft}
                        onChange={(event) => setEditingNoteDraft(event.target.value)}
                        disabled={noteEditSaving}
                        rows={3}
                        className="w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-base text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-gray-900"
                      />
                      <div className="mt-2 flex justify-end gap-2">
                        <button
                          onClick={() => setEditingNoteId(null)}
                          disabled={noteEditSaving}
                          className="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
                        >
                          {t("bookings.detail.cancelEdit")}
                        </button>
                        <button
                          onClick={handleSaveNoteEdit}
                          disabled={!editingNoteDraft.trim() || noteEditSaving}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {noteEditSaving ? t("common.saving") : t("bookings.detail.saveEdit")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1.5 text-sm text-gray-900 whitespace-pre-wrap">{n.body}</p>
                  )}
                  {n.editedAt && (
                    <p className="mt-1.5 text-xs text-gray-500">
                      {t("bookings.detail.editedBy", {
                        name: n.editedByName || t("bookings.detail.unknown"),
                        date: formatDateTime(n.editedAt, locale),
                      })}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* VAY-560: Check in from booking detail — visible for any confirmed booking regardless of date. */}
        {canCheckIn && (
          <div className="flex gap-3 flex-wrap">
            <Link
              href={`/check-in/${booking.id}`}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700"
            >
              {t("bookings.detail.checkInGuest")}
            </Link>
          </div>
        )}

        {/* Pending-booking accept/reject — kept above the cancel card so the
            most urgent action stays visible without scrolling further. */}
        {isPending && booking.hostResponseDeadline && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="mb-2 text-xs text-gray-500">{t("bookings.detail.reviewManualPayment")}</p>
            <div className="flex flex-wrap gap-3">
              {booking.paymentMethod === "paypal" ? (
                <button
                  onClick={handleMarkPaid}
                  disabled={updating || paymentDeadlineExpired}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <CheckCircleIcon className="w-4 h-4" />
                  {t("bookings.detail.markAsPaid")}
                </button>
              ) : (
                <button
                  onClick={handleAccept}
                  disabled={updating || paymentDeadlineExpired}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
                >
                  <CheckCircleIcon className="w-4 h-4" />
                  {t("bookings.detail.acceptBooking")}
                </button>
              )}
              <button
                onClick={handleReject}
                disabled={!LEGACY_BOOKING_WRITES_AVAILABLE || updating}
                title={t("bookings.detail.rejectionUnavailable")}
                className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-5 py-2.5 text-sm font-medium text-gray-400"
              >
                <XCircleIcon className="w-4 h-4" />
                {booking.paymentMethod === "paypal"
                  ? t("bookings.detail.cancelNotReceived")
                  : t("bookings.detail.rejectBooking")}
              </button>
            </div>
          </div>
        )}
        {isPending && !booking.hostResponseDeadline && (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <p className="mb-2 text-xs text-gray-500">
              {booking.paymentMethod === "paypal"
                ? t("bookings.detail.confirmPaypalAfterReceipt")
                : booking.paymentMethod === "card"
                  ? t("bookings.detail.acceptCardRequest")
                  : booking.paymentMethod === "pay_at_property"
                    ? t("bookings.detail.acceptAtPropertyRequest")
                    : t("bookings.detail.acceptBankTransferRequest")}
            </p>
            <button
              onClick={booking.paymentMethod === "paypal" ? handleMarkPaid : handleAccept}
              disabled={updating}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              <CheckCircleIcon className="w-4 h-4" />
              {booking.paymentMethod === "paypal"
                ? t("bookings.detail.markAsPaid")
                : t("bookings.detail.acceptBooking")}
            </button>
          </div>
        )}

        {/* 6. Cancel booking (confirmed bookings only) */}
        {canCancelBooking && (
          <div className="bg-white border border-gray-200 rounded-xl p-5 sm:p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-1">
              {t("bookings.detail.cancelBooking")}
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              <span className="font-semibold">
                {t("bookings.detail.cancelsAllRooms", {
                  count: roomRows.length,
                  roomLabel: t(roomRows.length === 1 ? "common.room" : "common.rooms"),
                })}
              </span>{" "}
              {t("bookings.detail.reasonRequired")}
            </p>

            <div className="mb-4">
              <CancellationPolicyPanel
                checkIn={booking.checkIn}
                rateType={rateType}
                numberOfRooms={roomRows.length}
                nightlyRate={booking.nightlyRate}
                currency={booking.currency}
                policy={policy}
              />
            </div>

            <button
              onClick={() => {
                setCancelReason("");
                setGuestMessage("");
                setCancelOpen(true);
              }}
              disabled={!canCancelManualBooking || updating}
              title={
                !canCancelManualBooking
                  ? t("bookings.detail.cancellationUnavailableTitle")
                  : undefined
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-red-600 disabled:cursor-not-allowed disabled:text-gray-400"
            >
              <XCircleIcon className="w-4 h-4" />
              {t(
                canCancelManualBooking
                  ? "bookings.detail.cancelBooking"
                  : "bookings.detail.cancellationUnavailable",
              )}
            </button>
          </div>
        )}
      </div>

      {resendNotice && (
        <div
          role={resendNotice.error ? "alert" : "status"}
          className={`fixed bottom-6 right-6 z-50 flex max-w-md items-center gap-4 rounded-lg border bg-white p-4 shadow-lg ${resendNotice.error ? "text-red-700" : "text-green-700"}`}
        >
          {resendNotice.text}
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setResendNotice(null)}
          >
            ×
          </button>
        </div>
      )}
      {resending && (
        <div role="status" className="fixed bottom-6 right-6 rounded-lg bg-white p-4 shadow-lg">
          Sending confirmation…
        </div>
      )}
      {/* Modals */}
      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          variant={confirmDialog.variant}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {decideOpen === "approve" && changeRequest && (
        <Modal onClose={() => setDecideOpen(null)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {t("bookings.detail.approveChangeRequestTitle")}
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            {t("bookings.detail.approveChangeDescription")}
            {changeRequest.priceDifference > 0 && (
              <>
                {" "}
                {t("bookings.detail.payAtPropertyIncrease", {
                  amount: formatCurrency(changeRequest.priceDifference, changeRequest.currency),
                })}
              </>
            )}
            {changeRequest.priceDifference < 0 && (
              <>
                {" "}
                {t("bookings.detail.payAtPropertyDecrease", {
                  amount: formatCurrency(
                    Math.abs(changeRequest.priceDifference),
                    changeRequest.currency,
                  ),
                })}
              </>
            )}
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDecideOpen(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              {t("bookings.modal.cancelButton")}
            </button>
            <button
              onClick={handleApproveChange}
              disabled={decidingChange}
              className="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-lg disabled:opacity-50"
            >
              {decidingChange ? t("bookings.detail.approving") : t("bookings.detail.approve")}
            </button>
          </div>
        </Modal>
      )}

      {decideOpen === "decline" && (
        <Modal onClose={() => setDecideOpen(null)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {t("bookings.detail.declineChangeRequestTitle")}
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            {t("bookings.detail.declineChangeDescription")}
          </p>
          <textarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder={t("bookings.detail.declineReasonPlaceholder")}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent mb-4 resize-none"
          />
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDecideOpen(null)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              {t("bookings.modal.cancelButton")}
            </button>
            <button
              onClick={handleDeclineChange}
              disabled={decidingChange}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
            >
              {decidingChange ? t("bookings.detail.declining") : t("bookings.detail.decline")}
            </button>
          </div>
        </Modal>
      )}

      {LEGACY_BOOKING_WRITES_AVAILABLE && rejectOpen && (
        <Modal onClose={() => setRejectOpen(false)}>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {booking?.paymentMethod === "paypal"
              ? t("bookings.detail.cancelPaymentNotReceived")
              : t("bookings.detail.rejectBooking")}
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            {booking?.paymentMethod === "paypal"
              ? t("bookings.detail.confirmCancelPaypal")
              : t("bookings.detail.confirmRejectBooking")}
          </p>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder={t("bookings.detail.rejectReasonPlaceholder")}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent mb-4 resize-none"
          />
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setRejectOpen(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              {t("bookings.modal.cancelButton")}
            </button>
            <button
              onClick={confirmReject}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg"
            >
              {booking?.paymentMethod === "paypal"
                ? t("bookings.detail.cancelBooking")
                : t("bookings.detail.reject")}
            </button>
          </div>
        </Modal>
      )}

      {cancelOpen && canCancelManualBooking && (
        <Modal
          onClose={() => {
            if (!cancelling) setCancelOpen(false);
          }}
        >
          <h3 className="text-lg font-semibold text-gray-900 mb-2">
            {t("bookings.detail.cancelThisBookingTitle")}
          </h3>
          <p className="text-sm text-gray-600 mb-4">
            {t("bookings.detail.cancelAllRoomsDescription", {
              count: roomRows.length,
              roomLabel: t(roomRows.length === 1 ? "common.room" : "common.rooms"),
            })}
          </p>
          <label htmlFor="cancellation-reason" className="block text-sm font-medium mb-1">
            {t("bookings.detail.internalCancellationReason")}
          </label>
          <textarea
            id="cancellation-reason"
            maxLength={1000}
            disabled={cancelling}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder={t("bookings.detail.cancellationReasonPlaceholder")}
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent mb-4 resize-none"
          />
          <label htmlFor="guest-cancellation-message" className="block text-sm font-medium mb-1">
            {t("bookings.detail.guestCancellationMessage")}
          </label>
          <textarea
            id="guest-cancellation-message"
            value={guestMessage}
            onChange={(event) => setGuestMessage(event.target.value)}
            rows={5}
            maxLength={5000}
            disabled={cancelling}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-4 text-base"
          />
          <div className="flex justify-end gap-3">
            <button
              disabled={cancelling}
              onClick={() => setCancelOpen(false)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg"
            >
              {t("bookings.detail.keepBooking")}
            </button>
            <button
              onClick={handleCancelBooking}
              disabled={!cancelReason.trim() || cancelling}
              className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50"
            >
              {cancelling ? t("bookings.modal.cancelling") : t("bookings.detail.cancelBooking")}
            </button>
          </div>
        </Modal>
      )}

      {moveTarget && (
        <MoveRoomModal
          fromRoomNumber={moveTarget.fromRoomNumber}
          candidates={moveCandidates}
          onClose={() => setMoveTarget(null)}
          onMove={(toRoomId) =>
            handleMoveRoom(moveTarget.assignmentId, moveTarget.position, toRoomId)
          }
        />
      )}

      {assignTarget && (
        <AssignGuestsModal
          roomLabel={assignTarget.label}
          roomPosition={assignTarget.position}
          guests={guests}
          onClose={() => setAssignTarget(null)}
          onSave={handleAssignGuests}
        />
      )}

      {LEGACY_BOOKING_WRITES_AVAILABLE && modifyOpen && (
        <ModifyBookingModal
          booking={booking}
          onClose={() => setModifyOpen(false)}
          onSave={handleModifyBooking}
        />
      )}

      {LEGACY_BOOKING_WRITES_AVAILABLE && addonEditOpen && (
        <EditAddOnsModal
          booking={booking}
          onClose={() => setAddonEditOpen(false)}
          onSave={handleSaveAddOns}
        />
      )}
    </div>
  );
}
