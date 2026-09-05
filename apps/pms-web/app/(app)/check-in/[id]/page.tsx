"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NationalitySelect } from "@/components/NationalitySelect";
import { nationalityLabel } from "@vayada/locale-constants";
import { useParams, useSearchParams } from "next/navigation";
import {
  Booking,
  BookingAdditionalGuest,
  BookingAdditionalGuestPayload,
  BookingNote,
  CheckinStepResult,
  bookingsService,
} from "@/services/bookings";
import { CheckinChecklistStep, settingsService } from "@/services/settings";
import { formatCurrency } from "@/lib/formatCurrency";
import BookingStaySummary, {
  bookingSettlementLabel,
  expectedPaymentMethodLabel,
} from "@/components/bookings/BookingStaySummary";
import { useTranslation } from "@/lib/i18n";
import { localizeBuiltInCheckinStep } from "@/lib/settings/checklistCopy";

type GuestDraft = BookingAdditionalGuestPayload & { id?: string; position: number };

const primaryActionClass =
  "rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60";
const LEGACY_BOOKING_WRITES_AVAILABLE = false;

type GuestRegistrationDraft = Pick<
  BookingAdditionalGuestPayload,
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "gender"
  | "nationality"
  | "dateOfBirth"
  | "passportNumber"
>;

function guestName(b: Booking) {
  return `${b.guestFirstName} ${b.guestLastName}`.trim();
}

function totalGuests(b: Booking) {
  return Math.max(1, b.numberOfGuests ?? b.adults + b.children);
}

function expectedAdditionalGuests(b: Booking) {
  return Math.max(0, totalGuests(b) - 1);
}

function totalRoomCapacity(b: Booking) {
  return Math.max(
    1,
    b.totalRoomCapacity ?? (b.roomMaxOccupancy || 1) * Math.max(1, b.numberOfRooms || 1),
  );
}

function additionalGuestCapacity(b: Booking) {
  return Math.max(0, totalRoomCapacity(b) - 1);
}

function roomUnit(b: Booking): string | null {
  if (b.assignedRooms?.length) {
    const numbers = b.assignedRooms.map((r) => r.roomNumber).filter(Boolean);
    return numbers.length ? numbers.join(", ") : null;
  }
  return b.roomNumber || null;
}

function shortDateRange(checkIn: string, checkOut: string, locale: string) {
  const ci = new Date(`${checkIn}T12:00:00`);
  const co = new Date(`${checkOut}T12:00:00`);
  const mon = (d: Date) => d.toLocaleDateString(locale, { month: "short" });
  if (ci.getMonth() === co.getMonth() && ci.getFullYear() === co.getFullYear()) {
    return `${ci.getDate()}–${co.getDate()} ${mon(ci)}`;
  }
  return `${ci.getDate()} ${mon(ci)} – ${co.getDate()} ${mon(co)}`;
}

function guestsLabel(
  b: Booking,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  const parts: string[] = [];
  if (b.adults > 0)
    parts.push(t(b.adults === 1 ? "checkIn.adult" : "checkIn.adults", { count: b.adults }));
  if (b.children > 0)
    parts.push(t(b.children === 1 ? "checkIn.child" : "checkIn.children", { count: b.children }));
  const count = totalGuests(b);
  return parts.join(", ") || t(count === 1 ? "checkIn.guest" : "checkIn.guests", { count });
}

function isPaid(b: Booking) {
  if (b.depositRequired) return b.balanceAmount <= 0;
  return ["captured", "paid", "refunded", "partially_refunded"].includes(b.paymentStatus || "");
}

function normalizeGuests(booking: Booking, guests: BookingAdditionalGuest[]): GuestDraft[] {
  const rows: GuestDraft[] = guests.map((g) => ({ ...g }));
  const expectedRows = Math.min(
    expectedAdditionalGuests(booking),
    additionalGuestCapacity(booking),
  );
  for (let idx = rows.length; idx < expectedRows; idx += 1) {
    rows.push({ position: idx + 1, roomPosition: rows[0]?.roomPosition ?? 0 });
  }
  return rows;
}

function bookerDraftFromBooking(booking: Booking): GuestRegistrationDraft {
  return {
    firstName: booking.guestFirstName || "",
    lastName: booking.guestLastName || "",
    email: booking.guestEmail || "",
    phone: booking.guestPhone || "",
    gender: booking.guestGender || "",
    nationality: booking.guestCountry || "",
    dateOfBirth: booking.guestDateOfBirth || null,
    passportNumber: booking.guestPassportNumber || "",
  };
}

function guestComplete(g: GuestRegistrationDraft) {
  return Boolean(g.firstName && g.lastName);
}

function guestHasData(g: GuestRegistrationDraft) {
  return Boolean(g.firstName || g.lastName || g.email || g.phone || g.nationality);
}

function formatDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function channelIsOta(channel: string | null | undefined) {
  return Boolean(channel && channel.toLowerCase() !== "direct");
}

function customStepDone(step: CheckinChecklistStep, value: string | boolean | undefined) {
  if (step.type === "checkbox") return value === true;
  if (step.type === "amount") return Number(value || 0) > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function customStepValueForRecord(step: CheckinChecklistStep, value: string | boolean | undefined) {
  if (step.type === "checkbox") return value === true;
  if (step.type === "amount") return value ? Number(value) : 0;
  return typeof value === "string" ? value : "";
}

export default function CheckInPage() {
  const { locale, t } = useTranslation();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const searchParams = useSearchParams();
  const nextAfterCheckin = searchParams.get("next");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [booker, setBooker] = useState<GuestRegistrationDraft | null>(null);
  const [guests, setGuests] = useState<GuestDraft[]>([]);
  const [notes, setNotes] = useState<BookingNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingGuest, setSavingGuest] = useState<string | null>(null);
  const [removingGuest, setRemovingGuest] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const [error, setError] = useState("");
  const [confirmationFlags, setConfirmationFlags] = useState<string[] | null>(null);
  const [actionLoading, setActionLoading] = useState<null | "markPaid" | "completeCheckIn">(null);
  const [checklistSteps, setChecklistSteps] = useState<CheckinChecklistStep[]>([]);
  const [checklistValues, setChecklistValues] = useState<Record<string, string | boolean>>({});
  const [requiredWarning, setRequiredWarning] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      bookingsService.get(id),
      bookingsService.listAdditionalGuests(id),
      settingsService.getCheckinChecklist().catch(() => ({ steps: [] })),
      bookingsService.listNotes(id).catch(() => ({ notes: [] })),
    ])
      .then(([bookingRes, guestRes, checklistRes, noteRes]) => {
        setBooking(bookingRes);
        setBooker(bookerDraftFromBooking(bookingRes));
        setGuests(normalizeGuests(bookingRes, guestRes.guests));
        setChecklistSteps(checklistRes.steps || []);
        setNotes(noteRes.notes || []);
      })
      .catch((err) => setError(err.message || t("checkIn.loadError")))
      .finally(() => setLoading(false));
  }, [id, t]);

  const pendingChecklistSteps = useMemo(
    () =>
      checklistSteps
        .filter((step) => step.required && !customStepDone(step, checklistValues[step.id]))
        .map((step) => ({
          stepId: step.id,
          label: localizeBuiltInCheckinStep(step, t).label,
        })),
    [checklistSteps, checklistValues, t],
  );
  const flags = useMemo(
    () => pendingChecklistSteps.map((flag) => flag.label),
    [pendingChecklistSteps],
  );
  const completedGuests =
    guests.filter(guestComplete).length + (booker && guestComplete(booker) ? 1 : 0);
  const ota = channelIsOta(booking?.channel);
  const maxGuests = booking ? totalRoomCapacity(booking) : 1;
  const remainingGuestSlots = booking ? Math.max(0, maxGuests - (guests.length + 1)) : 0;
  const overCapacityBy = booking ? Math.max(0, guests.length + 1 - maxGuests) : 0;
  const capacityReached = remainingGuestSlots === 0;

  const updateBooker = (patch: Partial<GuestRegistrationDraft>) => {
    setBooker((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateGuest = (index: number, patch: Partial<GuestDraft>) => {
    setGuests((prev) => prev.map((g, idx) => (idx === index ? { ...g, ...patch } : g)));
  };

  const updateCustomValue = (stepId: string, value: string | boolean) => {
    setRequiredWarning(false);
    setChecklistValues((prev) => ({ ...prev, [stepId]: value }));
  };

  const addGuest = () => {
    if (capacityReached) return;
    setGuests((prev) => [
      ...prev,
      { position: prev.length + 1, roomPosition: prev[0]?.roomPosition ?? 0 },
    ]);
  };

  const removeGuest = async (index: number) => {
    if (!booking) return;
    const draft = guests[index];
    if (!draft) return;
    if (guestHasData(draft)) {
      const confirmed = window.confirm(t("checkIn.removeGuestConfirm", { number: index + 2 }));
      if (!confirmed) return;
    }
    setRemovingGuest(`guest-${index}`);
    setError("");
    try {
      if (draft.id) {
        await bookingsService.deleteAdditionalGuest(booking.id, draft.id);
      }
      setGuests((prev) =>
        prev
          .filter((_, idx) => idx !== index)
          .map((guest, idx) => ({ ...guest, position: guest.id ? guest.position : idx + 1 })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkIn.removeGuestError"));
    } finally {
      setRemovingGuest(null);
    }
  };

  const saveNote = async () => {
    if (!booking) return;
    const body = noteDraft.trim();
    if (!body) return;
    setSavingNote(true);
    setError("");
    try {
      const saved = await bookingsService.createNote(booking.id, body, "check-in");
      setNotes((prev) => [saved, ...prev]);
      setNoteDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkIn.saveNoteError"));
    } finally {
      setSavingNote(false);
    }
  };

  const saveGuest = async (index: number) => {
    if (!booking) return;
    setSavingGuest(`guest-${index}`);
    setError("");
    try {
      const draft = guests[index];
      const payload: BookingAdditionalGuestPayload = {
        firstName: draft.firstName || "",
        lastName: draft.lastName || "",
        email: draft.email || "",
        phone: draft.phone || "",
        nationality: draft.nationality || "",
      };
      const saved = draft.id
        ? await bookingsService.updateAdditionalGuest(booking.id, draft.id, payload)
        : await bookingsService.createAdditionalGuest(booking.id, payload);
      setGuests((prev) => prev.map((g, idx) => (idx === index ? { ...saved } : g)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkIn.saveGuestError"));
    } finally {
      setSavingGuest(null);
    }
  };

  const saveBooker = async () => {
    if (!booking || !booker) return;
    setSavingGuest("booker");
    setError("");
    try {
      const updated = await bookingsService.update(booking.id, {
        guestFirstName: booker.firstName || "",
        guestLastName: booker.lastName || "",
        guestEmail: booker.email || "",
        guestPhone: booker.phone || "",
        guestCountry: booker.nationality || "",
        guestGender: booker.gender || "",
        guestDateOfBirth: booker.dateOfBirth || null,
        guestPassportNumber: booker.passportNumber || "",
      });
      setBooking(updated);
      setBooker(bookerDraftFromBooking(updated));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkIn.saveBookerError"));
    } finally {
      setSavingGuest(null);
    }
  };

  const markPaid = async () => {
    if (!booking || actionLoading) return;
    setActionLoading("markPaid");
    setError("");
    try {
      setBooking(await bookingsService.markPaid(booking.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkIn.markPaidError"));
    } finally {
      setActionLoading(null);
    }
  };

  const completeCheckIn = async () => {
    if (!booking || !booker || actionLoading) return;
    const carriedFlags = [...flags];
    if (pendingChecklistSteps.length > 0 && !requiredWarning) {
      setRequiredWarning(true);
      return;
    }
    setActionLoading("completeCheckIn");
    setError("");
    try {
      // Flush any unsaved guest drafts that have data
      const flushResults = await Promise.allSettled(
        guests.map(async (draft, index) => {
          if (index >= additionalGuestCapacity(booking)) return draft;
          if (!guestHasData(draft)) return draft;
          const payload: BookingAdditionalGuestPayload = {
            firstName: draft.firstName || "",
            lastName: draft.lastName || "",
            email: draft.email || "",
            phone: draft.phone || "",
            nationality: draft.nationality || "",
          };
          const saved = draft.id
            ? await bookingsService.updateAdditionalGuest(booking.id, draft.id, payload)
            : await bookingsService.createAdditionalGuest(booking.id, payload);
          return { ...draft, ...saved };
        }),
      );
      const flushedGuests = guests.map((draft, index) => {
        const result = flushResults[index];
        return result.status === "fulfilled" ? result.value : draft;
      });
      setGuests(flushedGuests);

      if (flushResults.some((result) => result.status === "rejected")) {
        throw new Error(t("checkIn.guestDraftsSaveError"));
      }

      const completedAt = new Date().toISOString();
      const checklistResults: CheckinStepResult[] = checklistSteps.map((step) => {
        const value = checklistValues[step.id];
        const done = customStepDone(step, value);
        return {
          stepId: step.id,
          label: step.label,
          type: step.type,
          value: customStepValueForRecord(step, value),
          completedAt: done ? completedAt : null,
        };
      });
      const checkedIn = await bookingsService.completeCheckIn(
        booking.id,
        carriedFlags,
        checklistResults,
        pendingChecklistSteps,
      );
      setBooking(checkedIn);
      setConfirmationFlags(carriedFlags);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkIn.completeError"));
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <div className="p-4 md:p-6 text-sm text-gray-500">{t("checkIn.loading")}</div>;
  }

  if (!booking || !booker) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-sm text-red-600">{error || t("checkIn.bookingNotFound")}</p>
      </div>
    );
  }

  if (confirmationFlags) {
    return (
      <main className="mx-auto max-w-3xl p-4 md:p-6">
        <div className="rounded-2xl border border-green-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-green-700">
            {t("dashboard.checkedIn")}
          </p>
          <h1 className="mt-2 text-2xl font-bold text-gray-950">{guestName(booking)}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t("checkIn.completedReference", { reference: booking.bookingReference })}
          </p>
          {confirmationFlags.length > 0 && (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-semibold text-amber-950">
                {t(
                  confirmationFlags.length === 1 ? "checkIn.flaggedItem" : "checkIn.flaggedItems",
                  { count: confirmationFlags.length },
                )}
              </p>
              <ul className="mt-2 list-disc pl-5 text-sm text-amber-900">
                {confirmationFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            {nextAfterCheckin === "checkout" ? (
              <Link href={`/check-out/${booking.id}`} className={primaryActionClass}>
                {t("checkIn.continueToCheckout")}
              </Link>
            ) : (
              <Link href="/dashboard" className={primaryActionClass}>
                {t("checkIn.backToDashboard")}
              </Link>
            )}
            <Link
              href={`/bookings/${booking.id}`}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700"
            >
              {t("checkIn.openBooking")}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] overflow-x-hidden bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Link
              href="/dashboard"
              className="mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
              aria-label={t("checkIn.backToDashboard")}
            >
              ←
            </Link>
            <div className="min-w-0">
              <p className="text-sm text-gray-500">{t("checkIn.breadcrumb")}</p>
              <h1 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xl font-bold text-gray-950 md:text-3xl">
                {t("checkIn.title", { guest: guestName(booking) })}
                <span className="rounded-full bg-green-100 px-2.5 py-1 text-xs font-semibold text-green-700">
                  {t("checkIn.arrivingToday")}
                </span>
              </h1>
              {ota && (
                <div className="mt-1">
                  <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold text-blue-700">
                    {t("checkIn.otaFieldsLocked")}
                  </span>
                </div>
              )}
            </div>
          </div>
        </header>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}

        {completedGuests < totalGuests(booking) && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            {t("checkIn.missingRegistration", {
              missing: totalGuests(booking) - completedGuests,
              total: totalGuests(booking),
            })}
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <Card title={t("checkIn.stay")}>
              {booking.numberOfRooms > 1 && (
                <BookingStaySummary stays={booking.stays} expectedCount={booking.numberOfRooms} />
              )}
              <div hidden={booking.numberOfRooms > 1} className="grid gap-3 text-sm md:grid-cols-3">
                <Info
                  label={t("bookings.tableRoom")}
                  value={booking.roomName}
                  secondary={roomUnit(booking) ?? undefined}
                />
                <Info
                  label={t("bookings.detail.nightsLabel")}
                  value={t(booking.nights === 1 ? "checkIn.night" : "checkIn.nights", {
                    count: booking.nights,
                  })}
                  secondary={shortDateRange(booking.checkIn, booking.checkOut, locale)}
                />
                <Info label={t("bookings.detail.guests")} value={guestsLabel(booking, t)} />
              </div>
            </Card>

            <Card
              title={t("checkIn.guestRegister")}
              action={t("checkIn.registrationProgress", {
                completed: completedGuests,
                total: guests.length + 1,
              })}
            >
              <div className="space-y-3">
                <div
                  className={`rounded-xl border p-3 text-sm ${
                    overCapacityBy > 0
                      ? "border-red-200 bg-red-50 text-red-800"
                      : capacityReached
                        ? "border-amber-200 bg-amber-50 text-amber-900"
                        : "border-blue-200 bg-blue-50 text-blue-900"
                  }`}
                >
                  {overCapacityBy > 0
                    ? t("checkIn.overCapacity", { count: overCapacityBy, max: maxGuests })
                    : capacityReached
                      ? t("checkIn.capacityReached", { max: maxGuests })
                      : t("checkIn.additionalGuestsAllowed", { count: remainingGuestSlots })}
                </div>
                <GuestRegistrationCard
                  title={guestName(booking) || t("checkIn.booker")}
                  badge={t("checkIn.bookerBadge")}
                  guest={booker}
                  complete={guestComplete(booker)}
                  ota={ota}
                  onChange={updateBooker}
                  onSave={saveBooker}
                  saving={savingGuest === "booker"}
                  saveLabel={t("checkIn.saveBooker")}
                  readOnly
                />

                {guests.map((guest, index) => {
                  const complete = guestComplete(guest);
                  return (
                    <GuestRegistrationCard
                      key={guest.id || `new-${index}`}
                      title={t("checkIn.guestNumber", { number: index + 2 })}
                      guest={guest}
                      complete={complete}
                      ota={ota}
                      onChange={(patch) => updateGuest(index, patch)}
                      onSave={() => saveGuest(index)}
                      saving={savingGuest === `guest-${index}`}
                      onRemove={() => removeGuest(index)}
                      removing={removingGuest === `guest-${index}`}
                    />
                  );
                })}

                <button
                  type="button"
                  onClick={addGuest}
                  disabled={capacityReached}
                  className="w-full rounded-xl border border-dashed border-gray-300 py-3 text-sm font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                >
                  {capacityReached
                    ? t("checkIn.capacityReached", { max: maxGuests })
                    : t("checkIn.addGuest")}
                </button>
              </div>
            </Card>

            <Card title={t("bookings.detail.payment")}>
              {/* prettier-ignore */}
              <div className="mb-3 text-sm"><Info label={t("checkIn.expectedMethod")} value={expectedPaymentMethodLabel(booking.expectedPaymentMethod, t)} /></div>
              {booking.depositRequired && (
                <div className="mb-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm">
                  <p className="font-semibold text-gray-900">
                    {t("checkIn.deposit", {
                      amount: formatCurrency(booking.depositAmount, booking.currency),
                    })}
                  </p>
                  <p className="text-xs text-gray-500">
                    {booking.paymentStatus === "captured"
                      ? t("bookings.balancePaid")
                      : t("bookings.statusPending")}{" "}
                    {t("checkIn.beforeArrival")}
                  </p>
                </div>
              )}
              <div
                className={`rounded-xl border p-4 ${isPaid(booking) ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}
              >
                <p
                  className={`font-semibold ${isPaid(booking) ? "text-green-800" : "text-amber-950"}`}
                >
                  {bookingSettlementLabel(booking, t)}
                </p>
                {(!booking.depositRequired || booking.balanceAmount > 0) && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={markPaid}
                      disabled={!LEGACY_BOOKING_WRITES_AVAILABLE || actionLoading !== null}
                      title={t("checkIn.paymentChangesUnavailable")}
                      className="cursor-not-allowed rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-semibold text-gray-400"
                    >
                      {t("checkIn.markPaidUnavailable")}
                    </button>
                  </div>
                )}
              </div>
            </Card>

            <Card title={t("checkIn.notes")}>
              <div className="space-y-4">
                {notes.length > 0 && (
                  <div className="space-y-3">
                    {notes.map((note) => (
                      <div key={note.id} className="rounded-lg border border-gray-200 p-3">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                          <span className="font-medium text-gray-700">
                            {note.authorName || t("checkIn.unknown")}
                          </span>
                          <span>{formatDateTime(note.createdAt, locale)}</span>
                          {note.source === "check-in" && (
                            <span className="rounded-full bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                              {t("bookings.detail.checkIn")}
                            </span>
                          )}
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm text-gray-900">
                          {note.body}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  placeholder={t("checkIn.notePlaceholder")}
                  rows={3}
                  className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-950 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
                <button
                  type="button"
                  onClick={saveNote}
                  disabled={savingNote || !noteDraft.trim()}
                  className={primaryActionClass}
                >
                  {savingNote ? t("common.saving") : t("checkIn.saveNote")}
                </button>
              </div>
            </Card>
          </div>

          <aside className="lg:sticky lg:top-6 lg:self-start">
            <Card title={t("checkIn.checklist")}>
              <div className="space-y-3">
                {checklistSteps.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-300 p-3 text-sm text-gray-500">
                    {t("checkIn.noSteps")}
                  </div>
                )}
                {checklistSteps.map((step) => (
                  <CustomChecklistItem
                    key={step.id}
                    step={step}
                    value={checklistValues[step.id]}
                    currency={booking.currency}
                    onChange={(value) => updateCustomValue(step.id, value)}
                  />
                ))}
              </div>
              {requiredWarning && pendingChecklistSteps.length > 0 && (
                <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  {t(
                    pendingChecklistSteps.length === 1
                      ? "checkIn.requiredStepIncomplete"
                      : "checkIn.requiredStepsIncomplete",
                    { count: pendingChecklistSteps.length },
                  )}
                </div>
              )}
              <button
                type="button"
                onClick={completeCheckIn}
                disabled={actionLoading !== null}
                className={`${primaryActionClass} mt-5 w-full py-3`}
              >
                {actionLoading === "completeCheckIn"
                  ? t("checkIn.completing")
                  : t("checkIn.complete")}
              </button>
              <p className="mt-3 text-center text-sm text-gray-500">
                {flags.length === 0
                  ? t("checkIn.ready")
                  : t(flags.length === 1 ? "checkIn.pendingItem" : "checkIn.pendingItems", {
                      count: flags.length,
                    })}
              </p>
            </Card>
          </aside>
        </section>
      </div>
    </main>
  );
}

function GuestRegistrationCard({
  title,
  badge,
  guest,
  complete,
  ota,
  onChange,
  onSave,
  saving,
  onRemove,
  removing,
  saveLabel,
  readOnly = false,
}: {
  title: string;
  badge?: string;
  guest: GuestRegistrationDraft;
  complete: boolean;
  ota: boolean;
  onChange: (patch: Partial<GuestRegistrationDraft>) => void;
  onSave: () => void;
  saving: boolean;
  onRemove?: () => void;
  removing?: boolean;
  saveLabel?: string;
  readOnly?: boolean;
}) {
  const { t } = useTranslation();
  const contactLocked = (value: string | null | undefined) => readOnly || (ota && Boolean(value));

  return (
    <div
      className={`rounded-xl border p-4 ${
        complete ? "border-green-200 bg-green-50" : "border-amber-200 bg-white"
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="font-semibold text-gray-950">
            {complete ? "✓" : "!"} {title}{" "}
            {badge && (
              <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs text-green-700">
                {badge}
              </span>
            )}
          </p>
          <p className={`text-sm ${complete ? "text-green-700" : "text-amber-700"}`}>
            {complete ? t("checkIn.registrationComplete") : t("checkIn.nameRequired")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {ota && (
            <span className="text-right text-xs font-medium text-gray-500">
              {t("checkIn.importedFieldsLocked")}
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              disabled={removing}
              className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
            >
              {removing ? t("checkIn.removing") : t("checkIn.remove")}
            </button>
          )}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field
          label={t("calendar.newBookingModal.firstNameLabel")}
          value={guest.firstName || ""}
          disabled={contactLocked(guest.firstName)}
          onChange={(v) => onChange({ firstName: v })}
        />
        <Field
          label={t("calendar.newBookingModal.lastNameLabel")}
          value={guest.lastName || ""}
          disabled={contactLocked(guest.lastName)}
          onChange={(v) => onChange({ lastName: v })}
        />
        <Field
          label={t("bookings.detail.email")}
          type="email"
          value={guest.email || ""}
          disabled={contactLocked(guest.email)}
          onChange={(v) => onChange({ email: v })}
        />
        <Field
          label={t("bookings.detail.phone")}
          type="tel"
          value={guest.phone || ""}
          disabled={contactLocked(guest.phone)}
          onChange={(v) => onChange({ phone: v })}
        />
        <NationalitySelect
          value={guest.nationality || ""}
          disabled={
            readOnly ||
            (ota && Boolean(guest.nationality) && Boolean(nationalityLabel(guest.nationality)))
          }
          onChange={(v) => onChange({ nationality: v })}
        />
      </div>
      <p className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
        {t("checkIn.unsupportedGuestFields")}
      </p>
      {readOnly ? (
        <p className="mt-3 text-xs text-gray-500">{t("checkIn.bookerEditingUnavailable")}</p>
      ) : (
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className={`${primaryActionClass} mt-3`}
        >
          {saving ? t("common.saving") : (saveLabel ?? t("checkIn.saveGuest"))}
        </button>
      )}
    </div>
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-950">{title}</h2>
        {action && (
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
            {action}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Info({ label, value, secondary }: { label: string; value: string; secondary?: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 font-semibold text-gray-950">{value}</p>
      {secondary && <p className="mt-0.5 text-xs text-gray-400">{secondary}</p>}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm text-gray-950 disabled:bg-gray-100 disabled:text-gray-500"
      />
    </label>
  );
}

function CustomChecklistItem({
  step,
  value,
  currency,
  onChange,
}: {
  step: CheckinChecklistStep;
  value: string | boolean | undefined;
  currency: string;
  onChange: (value: string | boolean) => void;
}) {
  const { t } = useTranslation();
  const displayStep = localizeBuiltInCheckinStep(step, t);
  const done = customStepDone(step, value);
  const controlId = `checklist-${step.id}`;
  const labelId = `checklist-label-${step.id}`;
  const indicatorClass = done
    ? "bg-green-100 text-green-700"
    : step.required
      ? "bg-red-100 text-red-700"
      : "bg-gray-100 text-gray-500";

  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${indicatorClass}`}
        >
          {done ? "✓" : step.required ? "!" : "•"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span id={labelId} className="break-words text-sm font-medium text-gray-900">
              {displayStep.label}
            </span>
            {step.required && (
              <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                {t("common.required")}
              </span>
            )}
          </div>
          {displayStep.prompt && <p className="mt-1 text-xs text-gray-500">{displayStep.prompt}</p>}

          {step.type === "checkbox" && (
            <label className="mt-2 flex items-center gap-2 text-sm text-gray-600">
              <input
                id={controlId}
                type="checkbox"
                checked={value === true}
                onChange={(event) => onChange(event.target.checked)}
                aria-labelledby={`${labelId} ${controlId}-suffix`}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span id={`${controlId}-suffix`}>{t("checkIn.done")}</span>
            </label>
          )}

          {step.type === "text" && (
            <input
              id={controlId}
              value={typeof value === "string" ? value : ""}
              onChange={(event) => onChange(event.target.value)}
              placeholder={step.prompt || t("checkIn.addNote")}
              aria-labelledby={labelId}
              className="mt-2 h-10 w-full rounded-lg border border-gray-200 px-3 text-sm"
            />
          )}

          {step.type === "amount" && (
            <div className="mt-2 flex h-10 rounded-lg border border-gray-200 bg-white">
              <span className="flex items-center border-r border-gray-200 px-3 text-xs font-semibold text-gray-500">
                {currency}
              </span>
              <input
                id={controlId}
                type="number"
                min="0"
                step="0.01"
                value={typeof value === "string" ? value : ""}
                onChange={(event) => onChange(event.target.value)}
                placeholder="0.00"
                aria-labelledby={labelId}
                className="min-w-0 flex-1 rounded-r-lg px-3 text-sm outline-none"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
