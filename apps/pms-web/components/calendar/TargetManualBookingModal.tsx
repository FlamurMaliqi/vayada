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

// prettier-ignore
const SOURCES = [["call", "Call"], ["email", "Email"], ["whatsapp", "WhatsApp"], ["walk_in", "Walk-in"], ["social_media", "Social media"], ["other", "Other"]] as const;
// prettier-ignore
const METHODS = [["pay_at_property", "Pay at property"], ["bank_transfer", "Bank transfer"], ["manual_card", "Manual card"], ["cash", "Cash"], ["other", "Other"]] as const;

// prettier-ignore
type Props = { roomTypes: CalendarRoomType[]; rooms: CalendarRoom[]; onSubmit: (input: PmsManualBookingCreateInput) => Promise<PmsManualBookingCreateResult>; onClose: () => void; initialRoomId?: string; initialCheckIn?: string; initialCheckOut?: string; canRecordPaidPayment?: boolean; };

// prettier-ignore
const inputClass = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 disabled:bg-gray-50 disabled:text-gray-500", labelClass = "block space-y-1 text-xs font-medium text-gray-700", sectionClass = "mb-2 text-xs font-medium uppercase tracking-wide text-gray-500";

// prettier-ignore
function addDay(value: string): string { if (!value) return ""; const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); }

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
  const firstRoom = rooms.find((room) => room.id === initialRoomId) ?? rooms[0];
  const firstType = roomTypes.find((type) => type.id === firstRoom?.roomTypeId);
  // prettier-ignore
  const [roomId, setRoomId] = useState(firstRoom?.id ?? ""), [checkIn, setCheckIn] = useState(initialCheckIn), [checkOut, setCheckOut] = useState(initialCheckOut), [firstName, setFirstName] = useState(""), [lastName, setLastName] = useState(""), [email, setEmail] = useState(""), [phone, setPhone] = useState(""), [countryCode, setCountryCode] = useState(""), [adults, setAdults] = useState(1), [children, setChildren] = useState(0), [ratePlanId, setRatePlanId] = useState(firstType?.ratePlans[0]?.id ?? "custom"), [nightlyRate, setNightlyRate] = useState(""), [source, setSource] = useState<PmsManualBookingCreateInput["directSource"]>("call"), [method, setMethod] = useState<PmsManualBookingCreateInput["payment"]["expectedMethod"]>("pay_at_property"), [settlement, setSettlement] = useState<"paid" | "unpaid">("unpaid"), [specialRequests, setSpecialRequests] = useState(""), [privateNote, setPrivateNote] = useState(""), [preview, setPreview] = useState<PmsManualBookingPreviewResult | null>(null), [previewState, setPreviewState] = useState<"idle" | "loading" | "error">("idle"), [message, setMessage] = useState(""), [submitting, setSubmitting] = useState(false), [retryLocked, setRetryLocked] = useState(false), [canRecordPaidPayment, setCanRecordPaidPayment] = useState(suppliedPaidCapability ?? false);
  const attempt = useRef<PmsManualBookingCreateInput | null>(null);
  const attemptLocked = useRef(false);
  const room = rooms.find((item) => item.id === roomId);
  const roomType = roomTypes.find((item) => item.id === room?.roomTypeId);
  const occupancyExceeded = Boolean(roomType && adults + children > roomType.maxOccupancy);

  // prettier-ignore
  useEffect(() => { if (suppliedPaidCapability !== undefined) return setCanRecordPaidPayment(suppliedPaidCapability); void calendarService.getManualBookingCapabilities().then((capability) => setCanRecordPaidPayment(capability.canRecordPaidPayment)); }, [suppliedPaidCapability]);

  useEffect(() => {
    if (!roomType || ratePlanId === "custom" || roomType.ratePlans.some((p) => p.id === ratePlanId))
      return;
    setRatePlanId(roomType.ratePlans[0]?.id ?? "custom");
    setNightlyRate("");
  }, [ratePlanId, roomType]);

  const previewInput = useMemo<PmsManualBookingPreviewInput | null>(() => {
    const parsed = Number(nightlyRate),
      override =
        nightlyRate.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed.toFixed(2) : null;
    if (
      !roomType ||
      !roomId ||
      !checkIn ||
      checkOut <= checkIn ||
      adults < 1 ||
      children < 0 ||
      occupancyExceeded
    )
      return null;
    if (ratePlanId === "custom" && override === null) return null;
    const money = override ? { amountDecimal: override, currency: roomType.currency } : null;
    return {
      stays: [
        {
          position: 1,
          roomId,
          checkIn,
          checkOut,
          adults,
          children,
          ...(ratePlanId === "custom"
            ? { ratePlanId: null, pricing: { kind: "custom" as const, nightlyAmount: money! } }
            : { ratePlanId, pricing: { kind: "rate_plan" as const, manualOverride: money } }),
        },
      ],
      addOns: [],
    };
  }, [
    adults,
    checkIn,
    checkOut,
    children,
    nightlyRate,
    occupancyExceeded,
    ratePlanId,
    roomId,
    roomType,
  ]);

  useEffect(() => {
    if (!previewInput) {
      setPreview(null);
      setPreviewState("idle");
      return;
    }
    let active = true;
    setPreviewState("loading");
    calendarService.previewManualBooking(previewInput).then(
      (result) => {
        if (!active) return;
        setPreview(result);
        setPreviewState("idle");
        setMessage("");
      },
      (error: unknown) => {
        if (!active) return;
        setPreview(null);
        setPreviewState("error");
        setMessage(error instanceof Error ? error.message : "Could not calculate the price.");
      },
    );
    return () => {
      active = false;
    };
  }, [previewInput]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    const phoneE164 = phone.trim();
    const isoCountry = countryCode.trim().toUpperCase();
    if (phoneE164 && !/^\+[1-9]\d{7,14}$/.test(phoneE164))
      return setMessage("Phone must include a country calling code, for example +306900000000.");
    if (isoCountry && !/^[A-Z]{2}$/.test(isoCountry))
      return setMessage("Guest country must be a 2-letter code.");
    if (!previewInput || !preview || previewState === "loading")
      return setMessage("Wait for a valid server price preview before creating the booking.");
    if (settlement === "paid" && !canRecordPaidPayment)
      return setMessage("Finance write permission is required to record Paid.");
    // prettier-ignore
    attempt.current ??= { commandId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), ...previewInput, guest: { firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), phoneE164: phoneE164 || null, countryCode: isoCountry || null, specialRequests: specialRequests.trim() || null }, privateNote: privateNote.trim() || null, directSource: source, payment: { expectedMethod: method, settlement: settlement === "paid" ? { status: "paid", reference: null } : { status: "unpaid" } } };
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
      const detail = error instanceof Error ? error.message : "Failed to create booking.";
      setMessage(
        ambiguous ? `${detail} Retry will safely resend the same booking request.` : detail,
      );
    } finally {
      setSubmitting(false);
    }
  }

  const serverTotal = preview?.stays[0];
  return (
    <>
      {/* prettier-ignore */}
      <Modal ariaLabel="New booking" onClose={submitting || retryLocked ? () => undefined : onClose} maxWidth="lg" footer={ <div className="flex items-center justify-between gap-3"> <span className="text-sm font-semibold text-gray-900"> {preview ? `Total ${formatCurrency(Number(preview.grandTotal.amountDecimal), preview.currency)}` : "Server total pending"} </span> <div className="flex gap-2"> <button type="button" disabled={submitting || retryLocked} onClick={onClose} className="px-4 py-2 text-sm text-gray-700 disabled:opacity-50"> Cancel </button> <button form="target-manual-booking" disabled={(!preview && !retryLocked) || submitting || previewState === "loading"} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" > {submitting ? "Creating…" : retryLocked ? "Retry creation" : "Create booking"} </button> </div> </div> } > <h2 className="text-lg font-bold text-gray-900">New booking</h2> <p className="mt-0.5 text-sm text-gray-500"> Create a direct reservation from a guest enquiry. </p>
        <form id="target-manual-booking" aria-busy={submitting} onSubmit={submit} onChange={() => { if (!attemptLocked.current) attempt.current = null; }} className="mt-5 space-y-6" > <fieldset disabled={submitting || retryLocked} className="space-y-6">
          <section> <h3 className={sectionClass}>Stay</h3> <div className="space-y-3">
              <label className={labelClass}> Room * <select value={roomId} onChange={(e) => setRoomId(e.target.value)} className={inputClass} required > {roomTypes.map((type) => ( <optgroup key={type.id} label={type.name}> {rooms .filter((item) => item.roomTypeId === type.id) .map((item) => ( <option key={item.id} value={item.id}> #{item.roomNumber} — {type.name} </option> ))} </optgroup> ))} </select> </label>
            <div className="grid grid-cols-2 gap-3">
              <label className={labelClass}> Check-in * <input type="date" value={checkIn} onChange={(e) => { setCheckIn(e.target.value); if (!checkOut || checkOut <= e.target.value) setCheckOut(addDay(e.target.value)); }} className={inputClass} required /> </label>
              <label className={labelClass}> Check-out * <input type="date" min={checkIn ? addDay(checkIn) : undefined} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} className={inputClass} required /> </label> </div> </div> </section>

          <section> <h3 className={sectionClass}>Guest</h3> <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className={labelClass}> First name * <input value={firstName} onChange={(e) => setFirstName(e.target.value)} className={inputClass} required /> </label>
              <label className={labelClass}> Last name * <input value={lastName} onChange={(e) => setLastName(e.target.value)} className={inputClass} required /> </label> </div>
              <label className={labelClass}> Email * <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} required /> </label>
            <div className="grid grid-cols-3 gap-3">
              <label className={`${labelClass} col-span-2`}> Phone <input name="phoneE164" type="tel" pattern="\+[1-9][0-9]{7,14}" placeholder="+306900000000" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} /> <span className="font-normal text-gray-500">Include the country calling code.</span> </label>
              <label className={labelClass}> Guest country <input name="countryCode" pattern="[A-Za-z]{2}" placeholder="GR" value={countryCode} onChange={(e) => setCountryCode(e.target.value.slice(0, 2))} className={inputClass} /> </label> </div>
            <div className="grid grid-cols-2 gap-3">
              <label className={labelClass}> Adults <input type="number" min={1} max={Math.max(1, (roomType?.maxOccupancy ?? 1) - children)} value={adults} aria-invalid={occupancyExceeded} aria-describedby={occupancyExceeded ? "occupancy-error" : undefined} onChange={(e) => setAdults(Number(e.target.value))} className={inputClass} /> </label>
              <label className={labelClass}> Children <input type="number" min={0} max={Math.max(0, (roomType?.maxOccupancy ?? 1) - adults)} value={children} aria-invalid={occupancyExceeded} aria-describedby={occupancyExceeded ? "occupancy-error" : undefined} onChange={(e) => setChildren(Number(e.target.value))} className={inputClass} /> </label> </div> {occupancyExceeded && ( <p id="occupancy-error" role="alert" className="text-xs text-red-700"> This room allows at most {roomType?.maxOccupancy} guests. </p> )} </div> </section>

          <section> <h3 className={sectionClass}>Rate & source</h3> <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <label className={labelClass}> Rate plan * <select value={ratePlanId} onChange={(e) => { setRatePlanId(e.target.value); setNightlyRate(""); }} className={inputClass} > {roomType?.ratePlans.map((plan) => ( <option key={plan.id} value={plan.id}> {plan.name} </option> ))} <option value="custom">Custom rate</option> </select> </label>
              <label className={labelClass}> {ratePlanId === "custom" ? "Custom nightly rate *" : "Nightly override"} <input type="number" min={0} step="0.01" value={nightlyRate} onChange={(e) => setNightlyRate(e.target.value)} required={ratePlanId === "custom"} className={inputClass} /> </label> </div>
            <div className="grid grid-cols-2 gap-3">
              <label className={labelClass}> Channel <input value="Direct" disabled className={inputClass} /> </label>
              <label className={labelClass}> Manual source * <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} className={inputClass} > {SOURCES.map(([value, label]) => ( <option key={value} value={value}> {label} </option> ))} </select> </label> </div> <div aria-live="polite" className="flex justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs" > <span> Standard:{" "} {serverTotal?.standardTotal ? formatCurrency( Number(serverTotal.standardTotal.amountDecimal), preview!.currency, ) : "—"} </span> <strong> Applied:{" "} {serverTotal ? formatCurrency( Number(serverTotal.appliedTotal.amountDecimal), preview!.currency, ) : previewState === "loading" ? "Calculating…" : "—"} </strong> </div> </div> </section>

          <section> <h3 className={sectionClass}>Payment</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className={labelClass}> Expected method * <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} className={inputClass} > {METHODS.map(([value, label]) => ( <option key={value} value={value}> {label} </option> ))} </select> </label> <fieldset> <legend className={labelClass}>Settlement</legend> <div className="mt-2 flex gap-4 text-sm"> <label> <input type="radio" name="settlement" value="unpaid" checked={settlement === "unpaid"} onChange={() => setSettlement("unpaid")} />{" "} Unpaid </label> <label className={!canRecordPaidPayment ? "text-gray-400" : ""} > <input type="radio" name="settlement" value="paid" disabled={!canRecordPaidPayment} aria-describedby={!canRecordPaidPayment ? "paid-help" : undefined} checked={settlement === "paid"} onChange={() => setSettlement("paid")} />{" "} Paid </label> </div> {!canRecordPaidPayment && ( <p id="paid-help" className="mt-1 text-xs text-gray-500">Paid requires Finance write access.</p> )} </fieldset> </div> </section>

          <section> <h3 className={sectionClass}>Notes (optional)</h3> <div className="space-y-3">
              <label className={labelClass}> Special requests (visible to guest) <textarea name="specialRequests" rows={2} value={specialRequests} onChange={(e) => setSpecialRequests(e.target.value)} className={inputClass} /> </label>
              <label className={labelClass}> Private note (staff only) <textarea name="privateNote" rows={2} value={privateNote} onChange={(e) => setPrivateNote(e.target.value)} className={inputClass} /> </label> </div> </section> </fieldset>
 {message && ( <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" > {message} </p> )}
        </form> </Modal>
    </>
  );
}
