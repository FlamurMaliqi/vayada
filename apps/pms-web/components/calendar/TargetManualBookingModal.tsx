"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Modal from "@/components/Modal";
import { formatCurrency } from "@/lib/formatCurrency";
import {
  PmsManualBookingServiceError,
  type PmsManualBookingCreateInput,
  type PmsManualBookingCreateResult,
  type PmsManualBookingPreviewInput,
  type PmsManualBookingPreviewResult,
} from "@/services/api/pmsManualBookingClient";
import { CalendarRoom, CalendarRoomType, calendarService } from "@/services/calendar";
import type { BookingAddon } from "@/services/bookings";
import { useTranslation } from "@/lib/i18n";

// prettier-ignore
const SOURCES = [["call", "calendar.targetManualBooking.sourceCall"], ["email", "calendar.targetManualBooking.sourceEmail"], ["whatsapp", "calendar.targetManualBooking.sourceWhatsApp"], ["walk_in", "calendar.targetManualBooking.sourceWalkIn"], ["social_media", "calendar.targetManualBooking.sourceSocialMedia"], ["other", "calendar.targetManualBooking.sourceOther"]] as const;
// prettier-ignore
const METHODS = [["pay_at_property", "calendar.targetManualBooking.methodPayAtProperty"], ["bank_transfer", "calendar.targetManualBooking.methodBankTransfer"], ["manual_card", "calendar.targetManualBooking.methodManualCard"], ["cash", "calendar.targetManualBooking.methodCash"], ["other", "calendar.targetManualBooking.methodOther"]] as const;
const PREVIEW_DEBOUNCE_MS = 250;
const PREVIEW_LOADING_DELAY_MS = 1_000;

type Translate = (key: string, params?: Record<string, string | number>) => string;

// prettier-ignore
type Props = { roomTypes: CalendarRoomType[]; rooms: CalendarRoom[]; onSubmit: (input: PmsManualBookingCreateInput) => Promise<PmsManualBookingCreateResult>; onClose: () => void; initialRoomId?: string; initialCheckIn?: string; initialCheckOut?: string; canRecordPaidPayment?: boolean; };
type StayDraft = {
  key: number;
  roomId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  ratePlanId: string;
  nightlyRate: string;
};

// prettier-ignore
const inputClass = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500", labelClass = "block space-y-1 text-xs font-medium text-gray-700", sectionClass = "mb-2 text-xs font-medium uppercase tracking-wide text-gray-500";

// prettier-ignore
function addDay(value: string): string { if (!value) return ""; const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); }

function amount(value: string): string | null {
  const parsed = Number(value);
  return value.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed.toFixed(2) : null;
}

function stayDefaults(
  key: number,
  roomId: string,
  checkIn: string,
  checkOut: string,
  roomTypes: CalendarRoomType[],
  rooms: CalendarRoom[],
): StayDraft {
  const room = rooms.find((item) => item.id === roomId),
    type = roomTypes.find((item) => item.id === room?.roomTypeId);
  return {
    key,
    roomId,
    checkIn,
    checkOut,
    adults: 1,
    children: 0,
    ratePlanId: type?.ratePlans[0]?.id ?? "missing",
    nightlyRate: "",
  };
}

function overlaps(left: StayDraft, right: StayDraft) {
  return (
    left.roomId === right.roomId && left.checkIn < right.checkOut && right.checkIn < left.checkOut
  );
}

// prettier-ignore
function errorDetails(error: unknown, fallback: string, stays: StayDraft[]) { const message = error instanceof Error ? error.message : fallback; if (!(error instanceof PmsManualBookingServiceError) || !error.stayPosition) return { message }; const stay = stays[error.stayPosition - 1], field = error.code === "invalid_dates" ? "checkIn" : error.field === "stays" ? "adults" : error.field === "currency" ? "nightlyRate" : error.field; return { message, stay: stay ? { key: stay.key, field: field ?? "roomId", message } : undefined }; }

function previewErrorDetails(
  error: unknown,
  stays: StayDraft[],
  t: Translate,
): {
  message: string;
  retryable: boolean;
  stay?: { key: number; field: string; message: string };
} {
  if (
    error instanceof PmsManualBookingServiceError &&
    ["rate_not_found", "rate_plan_not_found", "inactive_rate_plan"].includes(error.code)
  ) {
    const stay = stays[error.stayPosition ? error.stayPosition - 1 : 0];
    const range = stay
      ? `${stay.checkIn} – ${stay.checkOut}`
      : t("calendar.targetManualBooking.selectedDates");
    return {
      message: t("calendar.targetManualBooking.noRateFound", { range }),
      retryable: false,
    };
  }
  const fallback = t("calendar.targetManualBooking.previewFailure");
  const detail = errorDetails(error, fallback, stays);
  return detail.stay ? { ...detail, retryable: false } : { message: fallback, retryable: true };
}

// prettier-ignore
function addonSelection(addon: BookingAddon, packageCount: number, stays: StayDraft[]) { const dates = new Set<string>(); for (const stay of stays) for (let date = stay.checkIn; date < stay.checkOut; date = addDay(date)) dates.add(date); const serviceDates = Array.from(dates).sort(), occupancy = (date: string) => stays.filter((stay) => stay.checkIn <= date && date < stay.checkOut).reduce((sum, stay) => sum + stay.adults + stay.children, 0), serviceUnits = addon.perNight ? serviceDates.map((serviceDate) => ({ serviceDate, guestCount: addon.perPerson ? occupancy(serviceDate) : null })) : [{ serviceDate: null, guestCount: addon.perPerson ? stays.reduce((sum, stay) => sum + stay.adults + stay.children, 0) : null }]; return { addonId: addon.id, packageCount, serviceUnits }; }

export default function TargetManualBookingModal({
  roomTypes,
  rooms,
  onSubmit,
  onClose,
  initialRoomId,
  initialCheckIn = "",
  initialCheckOut = "",
  canRecordPaidPayment: suppliedPaidCapability,
}: Props) {
  const { t } = useTranslation();
  const firstRoom = rooms.find((room) => room.id === initialRoomId) ?? rooms[0];
  // prettier-ignore
  const [stays, setStays] = useState(() => [stayDefaults(1, firstRoom?.id ?? "", initialCheckIn, initialCheckOut, roomTypes, rooms)]), [addons, setAddons] = useState<BookingAddon[]>([]), [addonPackages, setAddonPackages] = useState<Record<string, number>>({}), [addonState, setAddonState] = useState<"loading" | "ready" | "error">("loading"), [firstName, setFirstName] = useState(""), [lastName, setLastName] = useState(""), [email, setEmail] = useState(""), [phone, setPhone] = useState(""), [countryCode, setCountryCode] = useState(""), [source, setSource] = useState<PmsManualBookingCreateInput["directSource"]>("call"), [method, setMethod] = useState<PmsManualBookingCreateInput["payment"]["expectedMethod"]>("pay_at_property"), [settlement, setSettlement] = useState<"paid" | "unpaid">("unpaid"), [specialRequests, setSpecialRequests] = useState(""), [privateNote, setPrivateNote] = useState(""), [previewEvidence, setPreviewEvidence] = useState<{ key: string; result: PmsManualBookingPreviewResult } | null>(null), [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle"), [message, setMessage] = useState(""), [stayError, setStayError] = useState<{ key: number; field: string; message: string } | null>(null), [submitting, setSubmitting] = useState(false), [retryLocked, setRetryLocked] = useState(false), [focusTarget, setFocusTarget] = useState<string | null>(null), [canRecordPaidPayment, setCanRecordPaidPayment] = useState(suppliedPaidCapability ?? false);
  const [showPreviewSpinner, setShowPreviewSpinner] = useState(false);
  const [previewMessage, setPreviewMessage] = useState("");
  const [previewCanRetry, setPreviewCanRetry] = useState(false);
  const [previewRetry, setPreviewRetry] = useState(0);
  const attempt = useRef<PmsManualBookingCreateInput | null>(null);
  const attemptLocked = useRef(false);
  const nextKey = useRef(2),
    controls = useRef(new Map<string, HTMLElement>());

  // prettier-ignore
  useEffect(() => { if (suppliedPaidCapability !== undefined) return setCanRecordPaidPayment(suppliedPaidCapability); void calendarService.getManualBookingCapabilities().then((capability) => setCanRecordPaidPayment(capability.canRecordPaidPayment)); }, [suppliedPaidCapability]);

  useEffect(() => {
    if (!focusTarget) return;
    controls.current.get(focusTarget)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  // prettier-ignore
  useEffect(() => { let active = true; calendarService.listAvailableAddons(firstRoom?.id ?? "").then((items) => { if (active) { setAddons(items); setAddonState("ready"); } }, () => { if (active) setAddonState("error"); }); return () => { active = false; }; }, [firstRoom?.id]);

  const conflicts = useMemo(() => {
    const positions = new Set<number>();
    stays.forEach((stay, index) =>
      stays.slice(index + 1).forEach((other, offset) => {
        if (overlaps(stay, other)) {
          positions.add(index);
          positions.add(index + offset + 1);
        }
      }),
    );
    return positions;
  }, [stays]);

  const previewInput = useMemo<PmsManualBookingPreviewInput | null>(() => {
    const mapped = stays.map((stay, index) => {
      const room = rooms.find((item) => item.id === stay.roomId),
        roomType = roomTypes.find((item) => item.id === room?.roomTypeId),
        override = amount(stay.nightlyRate);
      if (
        !roomType ||
        !stay.roomId ||
        !stay.checkIn ||
        stay.checkOut <= stay.checkIn ||
        stay.adults < 1 ||
        stay.children < 0 ||
        stay.adults + stay.children > roomType.maxOccupancy ||
        conflicts.has(index) ||
        stay.ratePlanId === "missing" ||
        (stay.ratePlanId === "custom" && override === null)
      )
        return null;
      const money = override ? { amountDecimal: override, currency: roomType.currency } : null;
      return {
        position: index + 1,
        roomId: stay.roomId,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        adults: stay.adults,
        children: stay.children,
        ratePlanId: stay.ratePlanId === "custom" ? null : stay.ratePlanId,
        pricing:
          stay.ratePlanId === "custom"
            ? { kind: "custom" as const, nightlyAmount: money! }
            : { kind: "rate_plan" as const, manualOverride: money },
      };
    });
    // prettier-ignore
    return mapped.some((stay) => !stay) ? null : { stays: mapped as PmsManualBookingPreviewInput["stays"], addOns: addons.filter((addon) => addonPackages[addon.id]).map((addon) => addonSelection(addon, addonPackages[addon.id]!, stays)) };
  }, [addonPackages, addons, conflicts, roomTypes, rooms, stays]);
  const previewKey = previewInput ? JSON.stringify(previewInput) : null;
  const preview = previewEvidence?.key === previewKey ? previewEvidence.result : null;
  const missingRateStay = stays.find(
    (stay) => stay.ratePlanId === "missing" && stay.checkIn && stay.checkOut > stay.checkIn,
  );
  const missingRateMessage = missingRateStay
    ? t("calendar.targetManualBooking.noRateFound", {
        range: `${missingRateStay.checkIn} – ${missingRateStay.checkOut}`,
      })
    : "";

  useEffect(() => {
    if (!previewInput) {
      setPreviewEvidence(null);
      setPreviewState("idle");
      setShowPreviewSpinner(false);
      setPreviewMessage("");
      setPreviewCanRetry(false);
      return;
    }
    let active = true;
    setPreviewEvidence(null);
    setStayError(null);
    setPreviewState("loading");
    setShowPreviewSpinner(false);
    setPreviewMessage("");
    setPreviewCanRetry(false);
    const loadingTimeout = globalThis.setTimeout(
      () => active && setShowPreviewSpinner(true),
      PREVIEW_LOADING_DELAY_MS,
    );
    const timeout = globalThis.setTimeout(() => {
      void calendarService.previewManualBooking(previewInput).then(
        (result) => {
          if (!active) return;
          globalThis.clearTimeout(loadingTimeout);
          setPreviewEvidence({ key: previewKey!, result });
          setPreviewState("idle");
          setShowPreviewSpinner(false);
          setMessage("");
        },
        (error: unknown) => {
          if (!active) return;
          globalThis.clearTimeout(loadingTimeout);
          const detail = previewErrorDetails(error, stays, t);
          setPreviewEvidence(null);
          setPreviewState("error");
          setShowPreviewSpinner(false);
          setStayError(detail.stay ?? null);
          setPreviewMessage(detail.stay ? "" : detail.message);
          setPreviewCanRetry(detail.retryable);
          if (detail.stay) setFocusTarget(`${detail.stay.key}:${detail.stay.field}`);
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      active = false;
      globalThis.clearTimeout(timeout);
      globalThis.clearTimeout(loadingTimeout);
    };
  }, [previewInput, previewKey, previewRetry, stays, t]);

  function updateStay(index: number, patch: Partial<StayDraft>) {
    setPreviewEvidence(null);
    setStays((current) =>
      current.map((stay, position) => (position === index ? { ...stay, ...patch } : stay)),
    );
  }
  function changeRoom(index: number, roomId: string) {
    const room = rooms.find((item) => item.id === roomId),
      roomType = roomTypes.find((item) => item.id === room?.roomTypeId);
    updateStay(index, {
      roomId,
      ratePlanId: roomType?.ratePlans[0]?.id ?? "missing",
      nightlyRate: "",
    });
  }
  function addStay() {
    if (stays.length >= 20) return;
    const reference = stays[0]!,
      room = rooms.find((item) => !stays.some((stay) => stay.roomId === item.id)) ?? rooms[0],
      key = nextKey.current++;
    setStays((current) => [
      ...current,
      stayDefaults(key, room?.id ?? "", reference.checkIn, reference.checkOut, roomTypes, rooms),
    ]);
    setPreviewEvidence(null);
    setFocusTarget(`${key}:roomId`);
  }
  function removeStay(index: number) {
    if (stays.length === 1) return;
    const focus = stays[index === 0 ? 1 : index - 1]!.key;
    setStays((current) => current.filter((_, position) => position !== index));
    setPreviewEvidence(null);
    setFocusTarget(`${focus}:roomId`);
  }
  // prettier-ignore
  function updateAddon(addonId: string, packageCount: number) { setPreviewEvidence(null); setAddonPackages((current) => { const next = { ...current }; if (packageCount > 0) next[addonId] = packageCount; else delete next[addonId]; return next; }); }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    setStayError(null);
    const retry = retryLocked && attempt.current;
    const phoneE164 = phone.trim();
    const isoCountry = countryCode.trim().toUpperCase();
    if (!retry && phoneE164 && !/^\+[1-9]\d{7,14}$/.test(phoneE164))
      return setMessage(t("calendar.targetManualBooking.phoneValidation"));
    if (!retry && isoCountry && !/^[A-Z]{2}$/.test(isoCountry))
      return setMessage(t("calendar.targetManualBooking.countryValidation"));
    if (!retry && (!previewInput || !preview || previewState !== "idle"))
      return setMessage(t("calendar.targetManualBooking.waitForPreview"));
    if (!retry && settlement === "paid" && !canRecordPaidPayment)
      return setMessage(t("calendar.targetManualBooking.paidPermissionRequired"));
    // prettier-ignore
    attempt.current ??= { commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), ...previewInput!, guest: { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), phoneE164: phoneE164 || null, countryCode: isoCountry || null, specialRequests: specialRequests.trim() || null }, privateNote: privateNote.trim() || null, directSource: source, payment: { expectedMethod: method, settlement: settlement === "paid" ? { status: "paid", reference: null } : { status: "unpaid" } } };
    attemptLocked.current = true;
    setRetryLocked(true);
    setSubmitting(true);
    try {
      await onSubmit(attempt.current);
    } catch (error) {
      const ambiguous =
        !(error instanceof PmsManualBookingServiceError) || error.category === "unavailable";
      if (!ambiguous) {
        attempt.current = null;
        attemptLocked.current = false;
        setRetryLocked(false);
      }
      const detail = errorDetails(error, t("calendar.targetManualBooking.createFailure"), stays);
      setStayError(detail.stay ?? null);
      if (detail.stay) setFocusTarget(`${detail.stay.key}:${detail.stay.field}`);
      else
        setMessage(
          ambiguous
            ? t("calendar.targetManualBooking.safeRetry", { message: detail.message })
            : detail.message,
        );
    } finally {
      setSubmitting(false);
    }
  }

  const previewTotal = preview ? (
    t("calendar.targetManualBooking.total", {
      amount: formatCurrency(Number(preview.grandTotal.amountDecimal), preview.currency),
    })
  ) : previewState === "loading" ? (
    <span className="inline-flex items-center gap-2" role="status">
      {showPreviewSpinner ? (
        <span
          aria-hidden="true"
          data-pricing-spinner
          className="size-4 animate-spin rounded-full border-2 border-gray-300 border-t-primary-600"
        />
      ) : null}
      {t("calendar.targetManualBooking.calculatingTotal")}
    </span>
  ) : missingRateMessage ? (
    t("calendar.targetManualBooking.totalUnavailable")
  ) : (
    t("calendar.targetManualBooking.selectStayForTotal")
  );

  return (
    <>
      <Modal
        ariaLabel={t("calendar.targetManualBooking.ariaLabel")}
        onClose={submitting || retryLocked ? () => undefined : onClose}
        maxWidth="xl"
        footer={
          <div className="flex items-center justify-between gap-3">
            {" "}
            <span className="text-sm font-semibold text-gray-900"> {previewTotal} </span>{" "}
            <div className="flex gap-2">
              {" "}
              <button
                type="button"
                disabled={submitting || retryLocked}
                onClick={onClose}
                className="px-4 py-2 text-sm text-gray-700 disabled:opacity-50"
              >
                {t("calendar.cancel")}
              </button>{" "}
              <button
                form="target-manual-booking"
                disabled={
                  (!preview && !retryLocked) ||
                  submitting ||
                  (!retryLocked && previewState === "loading")
                }
                className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {" "}
                {submitting
                  ? t("calendar.newBookingModal.creating")
                  : retryLocked
                    ? t("calendar.targetManualBooking.retryCreation")
                    : t("calendar.newBookingModal.createBooking")}{" "}
              </button>{" "}
            </div>{" "}
          </div>
        }
      >
        {" "}
        <h2 className="text-lg font-bold text-gray-900">
          {t("calendar.newBookingModal.title")}
        </h2>{" "}
        <p className="mt-0.5 text-sm text-gray-500">
          {" "}
          {t("calendar.targetManualBooking.description")}{" "}
        </p>
        <form
          id="target-manual-booking"
          aria-busy={submitting}
          onSubmit={submit}
          onChange={() => {
            if (!attemptLocked.current) attempt.current = null;
          }}
          className="mt-5 space-y-6"
        >
          {" "}
          <fieldset disabled={submitting || retryLocked} className="space-y-6">
            <section>
              {" "}
              <h3 className={sectionClass}>{t("calendar.targetManualBooking.stays")}</h3>{" "}
              <div className="space-y-3">
                {" "}
                {stays.map((stay, index) => {
                  const room = rooms.find((item) => item.id === stay.roomId),
                    roomType = roomTypes.find((item) => item.id === room?.roomTypeId),
                    occupancyExceeded = Boolean(
                      roomType && stay.adults + stay.children > roomType.maxOccupancy,
                    ),
                    conflict = conflicts.has(index),
                    serverError = stayError?.key === stay.key ? stayError : null,
                    serverStay = preview?.stays.find((item) => item.position === index + 1);
                  return (
                    <section
                      key={stay.key}
                      data-stay
                      aria-labelledby={`stay-title-${stay.key}`}
                      className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 sm:p-4"
                    >
                      {" "}
                      <div className="mb-3 flex items-center justify-between">
                        {" "}
                        <h4
                          id={`stay-title-${stay.key}`}
                          className="text-sm font-semibold text-gray-900"
                        >
                          {t("calendar.roomColumn")}
                          {index + 1}
                        </h4>{" "}
                        {stays.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeStay(index)}
                            aria-label={t("calendar.targetManualBooking.removeRoom", {
                              number: index + 1,
                            })}
                            className="text-xs font-medium text-red-600 hover:text-red-700"
                          >
                            {t("calendar.targetManualBooking.remove")}
                          </button>
                        )}{" "}
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {" "}
                        <label className={`${labelClass} sm:col-span-2`}>
                          {" "}
                          {t("calendar.newBookingModal.roomLabel")} *{" "}
                          <select
                            ref={(node) => {
                              if (node) controls.current.set(`${stay.key}:roomId`, node);
                            }}
                            aria-label={t("calendar.targetManualBooking.roomField", {
                              number: index + 1,
                            })}
                            aria-invalid={conflict || serverError?.field === "roomId"}
                            aria-describedby={
                              conflict
                                ? `stay-conflict-${stay.key}`
                                : serverError?.field === "roomId"
                                  ? `stay-server-${stay.key}`
                                  : undefined
                            }
                            value={stay.roomId}
                            onChange={(event) => changeRoom(index, event.target.value)}
                            className={inputClass}
                            required
                          >
                            {" "}
                            {roomTypes.map((type) => (
                              <optgroup key={type.id} label={type.name}>
                                {" "}
                                {rooms
                                  .filter((item) => item.roomTypeId === type.id)
                                  .map((item) => (
                                    <option key={item.id} value={item.id}>
                                      #{item.roomNumber} — {type.name}
                                    </option>
                                  ))}{" "}
                              </optgroup>
                            ))}{" "}
                          </select>{" "}
                        </label>
                        <label className={labelClass}>
                          {" "}
                          {t("calendar.newBookingModal.checkInLabel")} *{" "}
                          <input
                            ref={(node) => {
                              if (node) controls.current.set(`${stay.key}:checkIn`, node);
                            }}
                            aria-label={t("calendar.targetManualBooking.checkInField", {
                              number: index + 1,
                            })}
                            aria-invalid={serverError?.field === "checkIn"}
                            aria-describedby={
                              serverError?.field === "checkIn"
                                ? `stay-server-${stay.key}`
                                : undefined
                            }
                            type="date"
                            value={stay.checkIn}
                            onChange={(event) => {
                              const checkIn = event.target.value;
                              updateStay(index, {
                                checkIn,
                                ...(!stay.checkOut || stay.checkOut <= checkIn
                                  ? { checkOut: addDay(checkIn) }
                                  : {}),
                              });
                            }}
                            className={inputClass}
                            required
                          />{" "}
                        </label>{" "}
                        <label className={labelClass}>
                          {" "}
                          {t("calendar.newBookingModal.checkOutLabel")} *{" "}
                          <input
                            aria-label={t("calendar.targetManualBooking.checkOutField", {
                              number: index + 1,
                            })}
                            type="date"
                            min={addDay(stay.checkIn) || undefined}
                            value={stay.checkOut}
                            onChange={(event) =>
                              updateStay(index, { checkOut: event.target.value })
                            }
                            className={inputClass}
                            required
                          />{" "}
                        </label>
                        <label className={labelClass}>
                          {t("calendar.newBookingModal.adultsLabel")}
                          <input
                            ref={(node) => {
                              if (node) controls.current.set(`${stay.key}:adults`, node);
                            }}
                            aria-label={t("calendar.targetManualBooking.adultsField", {
                              number: index + 1,
                            })}
                            type="number"
                            min={1}
                            max={Math.max(1, (roomType?.maxOccupancy ?? 1) - stay.children)}
                            value={stay.adults}
                            aria-invalid={occupancyExceeded || serverError?.field === "adults"}
                            aria-describedby={
                              occupancyExceeded
                                ? `stay-occupancy-${stay.key}`
                                : serverError?.field === "adults"
                                  ? `stay-server-${stay.key}`
                                  : undefined
                            }
                            onChange={(event) =>
                              updateStay(index, { adults: Number(event.target.value) })
                            }
                            className={inputClass}
                          />{" "}
                        </label>{" "}
                        <label className={labelClass}>
                          {t("calendar.newBookingModal.childrenLabel")}
                          <input
                            aria-label={t("calendar.targetManualBooking.childrenField", {
                              number: index + 1,
                            })}
                            type="number"
                            min={0}
                            max={Math.max(0, (roomType?.maxOccupancy ?? 1) - stay.adults)}
                            value={stay.children}
                            aria-invalid={occupancyExceeded}
                            aria-describedby={
                              occupancyExceeded ? `stay-occupancy-${stay.key}` : undefined
                            }
                            onChange={(event) =>
                              updateStay(index, { children: Number(event.target.value) })
                            }
                            className={inputClass}
                          />{" "}
                        </label>
                        <label className={labelClass}>
                          {" "}
                          {t("calendar.targetManualBooking.ratePlan")} *{" "}
                          <select
                            ref={(node) => {
                              if (node) controls.current.set(`${stay.key}:ratePlanId`, node);
                            }}
                            aria-label={t("calendar.targetManualBooking.ratePlanField", {
                              number: index + 1,
                            })}
                            aria-invalid={serverError?.field === "ratePlanId"}
                            aria-describedby={
                              serverError?.field === "ratePlanId"
                                ? `stay-server-${stay.key}`
                                : undefined
                            }
                            value={stay.ratePlanId}
                            onChange={(event) =>
                              updateStay(index, { ratePlanId: event.target.value, nightlyRate: "" })
                            }
                            className={inputClass}
                          >
                            {" "}
                            {stay.ratePlanId === "missing" && (
                              <option value="missing" disabled>
                                {t("calendar.targetManualBooking.noRateAvailable")}
                              </option>
                            )}{" "}
                            {roomType?.ratePlans.map((plan) => (
                              <option key={plan.id} value={plan.id}>
                                {plan.name}
                              </option>
                            ))}{" "}
                            <option value="custom">
                              {t("calendar.targetManualBooking.customRate")}
                            </option>{" "}
                          </select>{" "}
                        </label>{" "}
                        <label className={labelClass}>
                          {" "}
                          {stay.ratePlanId === "custom"
                            ? t("calendar.targetManualBooking.customNightlyRate")
                            : t("calendar.targetManualBooking.nightlyOverride")}{" "}
                          <input
                            ref={(node) => {
                              if (node) controls.current.set(`${stay.key}:nightlyRate`, node);
                            }}
                            aria-label={t("calendar.targetManualBooking.nightlyRateField", {
                              number: index + 1,
                            })}
                            aria-invalid={serverError?.field === "nightlyRate"}
                            aria-describedby={
                              serverError?.field === "nightlyRate"
                                ? `stay-server-${stay.key}`
                                : undefined
                            }
                            type="number"
                            min={0}
                            step="0.01"
                            value={stay.nightlyRate}
                            onChange={(event) =>
                              updateStay(index, { nightlyRate: event.target.value })
                            }
                            required={stay.ratePlanId === "custom"}
                            className={inputClass}
                          />{" "}
                        </label>{" "}
                      </div>
                      {occupancyExceeded && (
                        <p
                          id={`stay-occupancy-${stay.key}`}
                          role="alert"
                          className="mt-2 text-xs text-red-700"
                        >
                          {t("calendar.targetManualBooking.occupancyExceeded", {
                            count: roomType?.maxOccupancy ?? 0,
                          })}
                        </p>
                      )}{" "}
                      {conflict && (
                        <p
                          id={`stay-conflict-${stay.key}`}
                          role="alert"
                          className="mt-2 text-xs text-red-700"
                        >
                          {t("calendar.targetManualBooking.roomOverlap")}
                        </p>
                      )}{" "}
                      {serverError && (
                        <p
                          id={`stay-server-${stay.key}`}
                          role="alert"
                          className="mt-2 text-xs text-red-700"
                        >
                          {serverError.message}
                        </p>
                      )}
                      <div
                        aria-live="polite"
                        className="mt-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs"
                      >
                        {" "}
                        <div className="flex justify-between">
                          <span>
                            {t("calendar.targetManualBooking.standard")}{" "}
                            {serverStay?.standardTotal
                              ? formatCurrency(
                                  Number(serverStay.standardTotal.amountDecimal),
                                  preview!.currency,
                                )
                              : "—"}
                          </span>
                          <strong>
                            {t("calendar.targetManualBooking.applied")}{" "}
                            {serverStay
                              ? formatCurrency(
                                  Number(serverStay.appliedTotal.amountDecimal),
                                  preview!.currency,
                                )
                              : previewState === "loading"
                                ? t("calendar.targetManualBooking.calculating")
                                : "—"}
                          </strong>
                        </div>{" "}
                        {serverStay?.nightly.length ? (
                          <ul className="mt-2 space-y-1 border-t border-gray-100 pt-2 text-gray-600">
                            {" "}
                            {serverStay.nightly.map((night) => (
                              <li key={night.serviceDate} className="flex justify-between">
                                <span>{night.serviceDate}</span>
                                <span>
                                  {night.standard
                                    ? `${formatCurrency(Number(night.standard.amountDecimal), preview!.currency)} → `
                                    : ""}
                                  {formatCurrency(
                                    Number(night.applied.amountDecimal),
                                    preview!.currency,
                                  )}
                                </span>
                              </li>
                            ))}{" "}
                          </ul>
                        ) : null}{" "}
                      </div>
                    </section>
                  );
                })}{" "}
                <button
                  type="button"
                  onClick={addStay}
                  disabled={stays.length >= 20}
                  className="w-full rounded-lg border border-dashed border-primary-300 px-3 py-2 text-sm font-medium text-primary-700 hover:bg-primary-50 disabled:border-gray-200 disabled:text-gray-400"
                >
                  {t("calendar.targetManualBooking.addRoom")}
                </button>{" "}
                {stays.length >= 20 && (
                  <p className="text-xs text-gray-500">
                    {t("calendar.targetManualBooking.roomLimitReached")}
                  </p>
                )}{" "}
              </div>{" "}
            </section>
            <section>
              {" "}
              <h3 className={sectionClass}>{t("bookings.tableGuest")}</h3>{" "}
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className={labelClass}>
                    {" "}
                    {t("calendar.newBookingModal.firstNameLabel")} *{" "}
                    <input
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      className={inputClass}
                      required
                    />{" "}
                  </label>
                  <label className={labelClass}>
                    {" "}
                    {t("calendar.newBookingModal.lastNameLabel")} *{" "}
                    <input
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      className={inputClass}
                      required
                    />{" "}
                  </label>{" "}
                </div>
                <label className={labelClass}>
                  {" "}
                  {t("calendar.newBookingModal.emailLabel")} *{" "}
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={inputClass}
                    required
                  />{" "}
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <label className={`${labelClass} col-span-2`}>
                    {t("calendar.newBookingModal.phoneLabel")}
                    <input
                      name="phoneE164"
                      type="tel"
                      pattern="\+[1-9][0-9]{7,14}"
                      placeholder="+306900000000"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className={inputClass}
                    />{" "}
                    <span className="font-normal text-gray-500">
                      {t("calendar.targetManualBooking.includeCountryCode")}
                    </span>{" "}
                  </label>
                  <label className={labelClass}>
                    {" "}
                    {t("calendar.targetManualBooking.guestCountry")}{" "}
                    <input
                      name="countryCode"
                      pattern="[A-Za-z]{2}"
                      placeholder="GR"
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value.slice(0, 2))}
                      className={inputClass}
                    />{" "}
                  </label>{" "}
                </div>
              </div>{" "}
            </section>
            <section>
              {" "}
              <h3 className={sectionClass}>
                {t("calendar.targetManualBooking.addonsOptional")}
              </h3>{" "}
              <div className="space-y-2">
                {" "}
                {addonState === "loading" && (
                  <p className="text-sm text-gray-500">
                    {t("calendar.targetManualBooking.loadingAddons")}
                  </p>
                )}{" "}
                {addonState === "error" && (
                  <p role="alert" className="text-sm text-red-700">
                    {t("calendar.targetManualBooking.addonsLoadError")}
                  </p>
                )}{" "}
                {addonState === "ready" && addons.length === 0 && (
                  <p className="text-sm text-gray-500">
                    {t("calendar.targetManualBooking.noActiveAddons")}
                  </p>
                )}{" "}
                {addons.map((addon) => {
                  const selected = Boolean(addonPackages[addon.id]),
                    serverAddon = preview?.addOns.find((item) => item.addonId === addon.id);
                  return (
                    <div
                      key={addon.id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm"
                    >
                      {" "}
                      <label className="flex min-w-0 flex-1 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) => updateAddon(addon.id, event.target.checked ? 1 : 0)}
                        />
                        <span className="truncate">{addon.name}</span>
                      </label>{" "}
                      {selected && (
                        <label className="flex items-center gap-2 text-xs">
                          {t("calendar.targetManualBooking.packages")}{" "}
                          <input
                            aria-label={t("calendar.targetManualBooking.addonPackages", {
                              addon: addon.name,
                            })}
                            type="number"
                            min={1}
                            max={99}
                            value={addonPackages[addon.id]}
                            onChange={(event) =>
                              updateAddon(addon.id, Math.max(1, Number(event.target.value) || 1))
                            }
                            className="w-16 rounded border border-gray-300 px-2 py-1"
                          />
                        </label>
                      )}{" "}
                      <strong className="w-20 text-right">
                        {serverAddon
                          ? formatCurrency(
                              Number(serverAddon.total.amountDecimal),
                              preview!.currency,
                            )
                          : "—"}
                      </strong>{" "}
                    </div>
                  );
                })}{" "}
              </div>{" "}
            </section>
            <section>
              {" "}
              <h3 className={sectionClass}>{t("bookings.tableSource")}</h3>{" "}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className={labelClass}>
                  {t("calendar.newBookingModal.channelLabel")}
                  <input
                    value={t("calendar.newBookingModal.channelDirect")}
                    disabled
                    className={inputClass}
                  />{" "}
                </label>
                <label className={labelClass}>
                  {" "}
                  {t("calendar.targetManualBooking.manualSource")} *{" "}
                  <select
                    value={source}
                    onChange={(e) => setSource(e.target.value as typeof source)}
                    className={inputClass}
                  >
                    {" "}
                    {SOURCES.map(([value, label]) => (
                      <option key={value} value={value}>
                        {" "}
                        {t(label)}{" "}
                      </option>
                    ))}{" "}
                  </select>{" "}
                </label>{" "}
              </div>{" "}
            </section>
            <section>
              {" "}
              <h3 className={sectionClass}>{t("bookings.detail.payment")}</h3>
              <div className="grid grid-cols-2 gap-3">
                <label className={labelClass}>
                  {" "}
                  {t("calendar.targetManualBooking.expectedMethod")} *{" "}
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value as typeof method)}
                    className={inputClass}
                  >
                    {" "}
                    {METHODS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {" "}
                        {t(label)}{" "}
                      </option>
                    ))}{" "}
                  </select>{" "}
                </label>{" "}
                <fieldset>
                  {" "}
                  <legend className={labelClass}>
                    {t("calendar.targetManualBooking.settlement")}
                  </legend>{" "}
                  <div className="mt-2 flex gap-4 text-sm">
                    {" "}
                    <label>
                      {" "}
                      <input
                        type="radio"
                        name="settlement"
                        value="unpaid"
                        checked={settlement === "unpaid"}
                        onChange={() => setSettlement("unpaid")}
                      />{" "}
                      {t("calendar.targetManualBooking.unpaid")}{" "}
                    </label>{" "}
                    <label className={!canRecordPaidPayment ? "text-gray-400" : ""}>
                      {" "}
                      <input
                        type="radio"
                        name="settlement"
                        value="paid"
                        disabled={!canRecordPaidPayment}
                        aria-describedby={!canRecordPaidPayment ? "paid-help" : undefined}
                        checked={settlement === "paid"}
                        onChange={() => setSettlement("paid")}
                      />{" "}
                      {t("bookings.balancePaid")}
                    </label>{" "}
                  </div>{" "}
                  {!canRecordPaidPayment && (
                    <p id="paid-help" className="mt-1 text-xs text-gray-500">
                      {t("calendar.targetManualBooking.paidHelp")}
                    </p>
                  )}{" "}
                </fieldset>{" "}
              </div>{" "}
            </section>
            <section>
              {" "}
              <h3 className={sectionClass}>
                {t("calendar.targetManualBooking.notesOptional")}
              </h3>{" "}
              <div className="space-y-3">
                <label className={labelClass}>
                  {" "}
                  {t("calendar.targetManualBooking.specialRequests")}{" "}
                  <textarea
                    name="specialRequests"
                    rows={2}
                    value={specialRequests}
                    onChange={(e) => setSpecialRequests(e.target.value)}
                    className={inputClass}
                  />{" "}
                </label>
                <label className={labelClass}>
                  {" "}
                  {t("calendar.targetManualBooking.privateNote")}{" "}
                  <textarea
                    name="privateNote"
                    rows={2}
                    value={privateNote}
                    onChange={(e) => setPrivateNote(e.target.value)}
                    className={inputClass}
                  />{" "}
                </label>{" "}
              </div>{" "}
            </section>{" "}
          </fieldset>
          {(missingRateMessage || previewMessage) && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {" "}
              <span>{missingRateMessage || previewMessage}</span>{" "}
              {!missingRateMessage && previewCanRetry && (
                <button
                  type="button"
                  onClick={() => {
                    setPreviewMessage("");
                    setPreviewRetry((value) => value + 1);
                  }}
                  className="shrink-0 font-semibold underline underline-offset-2"
                >
                  {t("calendar.targetManualBooking.retryPricing")}
                </button>
              )}{" "}
            </div>
          )}
          {message && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {" "}
              {message}{" "}
            </p>
          )}
        </form>{" "}
      </Modal>
    </>
  );
}
