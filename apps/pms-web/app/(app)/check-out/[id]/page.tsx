"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Booking,
  BookingNote,
  CheckoutCharge,
  CheckoutInspectionResult,
  CheckoutInspectionStatus,
  bookingsService,
} from "@/services/bookings";
import { CheckoutInspectionStep, settingsService } from "@/services/settings";
import { formatCurrency } from "@/lib/formatCurrency";
import { useTranslation } from "@/lib/i18n";
import { localizeCheckoutInspectionStep } from "@/lib/settings/checklistCopy";

type InspectionDraft = {
  status: CheckoutInspectionStatus;
  note: string;
};

function NotCheckedInPage({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isConfirmed = booking.status === "confirmed";

  async function handleNoShow() {
    if (!isConfirmed) return;
    setLoading(true);
    setError(null);
    try {
      await bookingsService.markNoShow(booking.id);
      router.push("/dashboard");
    } catch {
      setError(t("checkOut.noShowError"));
      setLoading(false);
    }
  }

  return (
    <main className="p-4 md:p-6">
      <div className="mx-auto max-w-lg space-y-4">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {t("checkOut.notCheckedInDescription")}
        </div>
        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row">
          {isConfirmed && (
            <Link
              href={`/check-in/${booking.id}?next=checkout`}
              className="flex h-11 items-center justify-center rounded-lg bg-primary-600 px-5 text-sm font-semibold text-white hover:bg-primary-700"
            >
              {t("checkOut.checkInNow")}
            </Link>
          )}
          {isConfirmed && (
            <button
              type="button"
              onClick={handleNoShow}
              disabled={loading}
              className="flex h-11 items-center justify-center rounded-lg border border-red-200 px-5 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
            >
              {loading ? t("checkOut.markingNoShow") : t("checkOut.markNoShow")}
            </button>
          )}
          <Link
            href="/dashboard"
            className="flex h-11 items-center justify-center rounded-lg border border-gray-200 px-5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            {t("checkOut.backToDashboard")}
          </Link>
        </div>
      </div>
    </main>
  );
}

const primaryActionClass =
  "rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60";

function guestName(b: Booking) {
  return `${b.guestFirstName} ${b.guestLastName}`.trim();
}

function roomLabel(
  b: Booking,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  if (b.assignedRooms?.length) {
    return b.assignedRooms
      .map((room) =>
        room.roomNumber
          ? `${b.roomName}\n${t("checkOut.unit", { number: room.roomNumber })}`
          : b.roomName,
      )
      .join("\n");
  }
  return b.roomNumber
    ? `${b.roomName}\n${t("checkOut.unit", { number: b.roomNumber })}`
    : b.roomName;
}

function shortDateRange(checkIn: string, checkOut: string, locale: string) {
  const ci = new Date(`${checkIn}T12:00:00`);
  const co = new Date(`${checkOut}T12:00:00`);
  const mon = (d: Date) => d.toLocaleDateString(locale, { month: "short" });
  if (ci.getMonth() === co.getMonth() && ci.getFullYear() === co.getFullYear()) {
    return `${ci.getDate()}-${co.getDate()} ${mon(ci)}`;
  }
  return `${ci.getDate()} ${mon(ci)} - ${co.getDate()} ${mon(co)}`;
}

function guestsLabel(
  b: Booking,
  t: (key: string, params?: Record<string, string | number>) => string,
) {
  const parts: string[] = [];
  if (b.adults > 0)
    parts.push(t(b.adults === 1 ? "checkOut.adult" : "checkOut.adults", { count: b.adults }));
  if (b.children > 0)
    parts.push(t(b.children === 1 ? "checkOut.child" : "checkOut.children", { count: b.children }));
  const count = b.numberOfGuests || 1;
  return parts.join(", ") || t(count === 1 ? "checkOut.guest" : "checkOut.guests", { count });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CheckOutPage() {
  const { locale, t } = useTranslation();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [booking, setBooking] = useState<Booking | null>(null);
  const [steps, setSteps] = useState<CheckoutInspectionStep[]>([]);
  const [inspection, setInspection] = useState<Record<string, InspectionDraft>>({});
  const [charges, setCharges] = useState<CheckoutCharge[]>([]);
  const [notes, setNotes] = useState<BookingNote[]>([]);
  const [noteDraft, setNoteDraft] = useState("");
  const [chargeLabel, setChargeLabel] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingNote, setSavingNote] = useState(false);
  const [addingCharge, setAddingCharge] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [confirmationFlags, setConfirmationFlags] = useState<CheckoutInspectionResult[] | null>(
    null,
  );

  useEffect(() => {
    if (!id) return;
    Promise.all([
      bookingsService.get(id),
      settingsService.getCheckoutInspection().catch(() => ({ steps: [] })),
      bookingsService.listCheckoutCharges(id).catch(() => ({ charges: [] })),
      bookingsService.listNotes(id).catch(() => ({ notes: [] })),
    ])
      .then(([bookingRes, templateRes, chargeRes, noteRes]) => {
        setBooking(bookingRes);
        setSteps((templateRes.steps || []).map((step) => localizeCheckoutInspectionStep(step, t)));
        setCharges(chargeRes.charges || []);
        setNotes(noteRes.notes || []);
      })
      .catch((err) => setError(err.message || t("checkOut.loadError")))
      .finally(() => setLoading(false));
  }, [id, t]);

  const pendingTotal = useMemo(
    () =>
      charges
        .filter((charge) => charge.status === "pending")
        .reduce((sum, charge) => sum + charge.amount, 0),
    [charges],
  );

  const additionalCharges = useMemo(
    () => charges.reduce((sum, charge) => sum + charge.originalAmount, 0),
    [charges],
  );

  const flaggedResults = useMemo(
    () =>
      steps
        .filter((step) => inspection[step.id]?.status === "issue")
        .map((step) => toInspectionResult(step, inspection[step.id])),
    [inspection, steps],
  );

  const incompleteRequired = useMemo(
    () => steps.filter((step) => step.required && !inspection[step.id]?.status),
    [inspection, steps],
  );

  const checkInNotes = notes.filter((note) => note.source === "check-in");
  const checkoutNotes = notes.filter((note) => note.source === "check-out");

  const updateInspection = (step: CheckoutInspectionStep, status: CheckoutInspectionStatus) => {
    setWarning("");
    setInspection((prev) => ({
      ...prev,
      [step.id]: {
        status,
        note: status === "issue" ? prev[step.id]?.note || "" : "",
      },
    }));
  };

  const updateInspectionNote = (stepId: string, note: string) => {
    setInspection((prev) => ({
      ...prev,
      [stepId]: { status: prev[stepId]?.status || "issue", note },
    }));
  };

  const saveNote = async () => {
    if (!booking) return;
    const body = noteDraft.trim();
    if (!body) return;
    setSavingNote(true);
    setError("");
    try {
      const saved = await bookingsService.createNote(booking.id, body, "check-out");
      setNotes((prev) => [saved, ...prev]);
      setNoteDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkOut.saveNoteError"));
    } finally {
      setSavingNote(false);
    }
  };

  const addCharge = async () => {
    if (!booking) return;
    const amount = Number(chargeAmount);
    if (!chargeLabel.trim() || !Number.isFinite(amount) || amount <= 0) return;
    setAddingCharge(true);
    setError("");
    try {
      const saved = await bookingsService.addCheckoutCharge(booking.id, chargeLabel.trim(), amount);
      setCharges((prev) => [...prev, saved]);
      setChargeLabel("");
      setChargeAmount("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkOut.addChargeError"));
    } finally {
      setAddingCharge(false);
    }
  };

  const settleCharge = async (charge: CheckoutCharge, action: "paid" | "waived") => {
    if (!booking) return;
    setActionLoading(`${action}-${charge.id}`);
    setError("");
    try {
      const saved =
        action === "paid"
          ? await bookingsService.markCheckoutChargePaid(booking.id, charge.id)
          : await bookingsService.waiveCheckoutCharge(booking.id, charge.id);
      setCharges((prev) => prev.map((item) => (item.id === saved.id ? saved : item)));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkOut.updateChargeError"));
    } finally {
      setActionLoading(null);
    }
  };

  const completeCheckOut = async () => {
    if (!booking) return;
    if (pendingTotal > 0) return;
    const results = steps.map((step) => toInspectionResult(step, inspection[step.id]));
    if (incompleteRequired.length > 0 && !warning) {
      setWarning(
        t("checkOut.inspectionIncomplete", {
          items: incompleteRequired.map((step) => step.label).join(", "),
        }),
      );
      return;
    }

    setActionLoading("complete");
    setError("");
    try {
      const noteBody = noteDraft.trim();
      const checkedOut = await bookingsService.completeCheckOut(
        booking.id,
        results,
        flaggedResults,
        noteBody || undefined,
      );
      if (noteBody) {
        const saved = await bookingsService.createNote(booking.id, noteBody, "check-out");
        setNotes((prev) => [saved, ...prev]);
        setNoteDraft("");
      }
      setBooking(checkedOut);
      setConfirmationFlags(flaggedResults);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("checkOut.completeError"));
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <div className="p-4 md:p-6 text-sm text-gray-500">{t("checkOut.loading")}</div>;
  }

  if (!booking) {
    return (
      <div className="p-4 md:p-6">
        <p className="text-sm text-red-600">{error || t("checkOut.bookingNotFound")}</p>
      </div>
    );
  }

  if (!["checked_in", "in_house", "checked_out"].includes(booking.status)) {
    return <NotCheckedInPage booking={booking} />;
  }

  if (booking.status === "checked_out" && !confirmationFlags) {
    return (
      <main className="mx-auto max-w-3xl p-4 md:p-6">
        <div className="rounded-2xl border border-green-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-green-700">
            {t("checkOut.checkedOut")}
          </p>
          <h1 className="mt-2 text-2xl font-bold text-gray-950">{guestName(booking)}</h1>
          <p className="mt-1 text-sm text-gray-500">{t("checkOut.alreadyCheckedOut")}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/dashboard" className={primaryActionClass}>
              {t("checkOut.backToDashboard")}
            </Link>
            <Link
              href={`/bookings/${booking.id}`}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700"
            >
              {t("checkOut.openBooking")}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  if (confirmationFlags) {
    return (
      <main className="mx-auto max-w-3xl p-4 md:p-6">
        <div className="rounded-2xl border border-green-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-green-700">
            {t("checkOut.checkedOut")}
          </p>
          <h1 className="mt-2 text-2xl font-bold text-gray-950">{guestName(booking)}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t("checkOut.completedReference", { reference: booking.bookingReference })}
          </p>
          {confirmationFlags.length === 0 ? (
            <div className="mt-5 rounded-xl border border-green-200 bg-green-50 p-4 text-sm font-semibold text-green-800">
              {t("checkOut.allComplete")}
            </div>
          ) : (
            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-semibold text-amber-950">
                {t(
                  confirmationFlags.length === 1
                    ? "checkOut.flaggedInspectionItem"
                    : "checkOut.flaggedInspectionItems",
                  { count: confirmationFlags.length },
                )}
              </p>
              <ul className="mt-2 list-disc pl-5 text-sm text-amber-900">
                {confirmationFlags.map((flag) => (
                  <li key={flag.stepId}>
                    {flag.label}
                    {flag.note ? ` - ${flag.note}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/dashboard" className={primaryActionClass}>
              {t("checkOut.backToDashboard")}
            </Link>
            <Link
              href={`/bookings/${booking.id}`}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-700"
            >
              {t("checkOut.openBooking")}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[100dvh] bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500">
              <Link href="/dashboard" className="hover:text-gray-900">
                {t("layout.sidebar.dashboard")}
              </Link>{" "}
              / {t("checkOut.label")}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-gray-950">
                {t("checkOut.title", { guest: guestName(booking) })}
              </h1>
              <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-700">
                {t("checkOut.departingToday")}
              </span>
            </div>
          </div>
          <Link
            href="/dashboard"
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            {t("checkOut.backToDashboard")}
          </Link>
        </header>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
        {warning && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {warning}
          </p>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-5">
            <Section title={t("checkOut.staySummary")}>
              <div className="grid gap-3 md:grid-cols-3">
                <SummaryItem
                  label={t("bookings.tableRoom")}
                  value={roomLabel(booking, t)}
                  multiline
                />
                <SummaryItem
                  label={t("checkOut.stayed")}
                  value={`${t(booking.nights === 1 ? "checkOut.night" : "checkOut.nights", {
                    count: booking.nights,
                  })} - ${shortDateRange(booking.checkIn, booking.checkOut, locale)}`}
                />
                <SummaryItem label={t("bookings.detail.guests")} value={guestsLabel(booking, t)} />
              </div>
            </Section>

            <Section
              title={t("checkOut.roomInspection")}
              description={t("checkOut.roomInspectionDescription")}
            >
              <div className="space-y-3">
                {steps.map((step) => {
                  const draft = inspection[step.id];
                  return (
                    <div key={step.id} className="rounded-lg border border-gray-200 bg-white p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-950">{step.label}</p>
                          <p
                            className={`mt-1 text-xs ${
                              draft?.status === "issue"
                                ? "text-amber-700"
                                : draft?.status === "ok"
                                  ? "text-green-700"
                                  : "text-gray-500"
                            }`}
                          >
                            {draft?.status === "issue"
                              ? t("checkOut.inspectionSelected", { label: step.negativeLabel })
                              : draft?.status === "ok"
                                ? step.okLabel
                                : step.required
                                  ? t("common.required")
                                  : t("checkOut.optional")}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => updateInspection(step, "ok")}
                            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                              draft?.status === "ok"
                                ? "border-green-300 bg-green-100 text-green-800"
                                : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                            }`}
                          >
                            {t("checkOut.ok")}
                          </button>
                          <button
                            type="button"
                            onClick={() => updateInspection(step, "issue")}
                            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                              draft?.status === "issue"
                                ? "border-amber-300 bg-amber-100 text-amber-900"
                                : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                            }`}
                          >
                            {step.negativeLabel}
                          </button>
                        </div>
                      </div>
                      {draft?.status === "issue" && (
                        <input
                          value={draft.note}
                          onChange={(event) => updateInspectionNote(step.id, event.target.value)}
                          placeholder={step.notePrompt}
                          className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>

            <Section
              title={t("checkOut.outstandingCharges")}
              description={t("checkOut.outstandingChargesDescription")}
            >
              <div className="space-y-3">
                {charges.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
                    {t("checkOut.noOutstandingCharges")}
                  </p>
                ) : (
                  charges.map((charge) => (
                    <div
                      key={charge.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white p-3"
                    >
                      <div>
                        <p className="text-sm font-semibold text-gray-950">{charge.label}</p>
                        <p className="text-xs text-gray-500">
                          {t("checkOut.addedAt", { date: formatDateTime(charge.createdAt) })}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-gray-900">
                          {formatCurrency(charge.amount, booking.currency)}
                          {charge.status === "waived" && (
                            <span className="ml-1 text-xs text-gray-500">
                              {t("checkOut.waivedAmount", {
                                amount: formatCurrency(charge.originalAmount, booking.currency),
                              })}
                            </span>
                          )}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            charge.status === "pending"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-green-100 text-green-700"
                          }`}
                        >
                          {t(`checkOut.chargeStatus.${charge.status}`)}
                        </span>
                        {charge.status === "pending" && (
                          <>
                            <button
                              type="button"
                              onClick={() => settleCharge(charge, "paid")}
                              disabled={actionLoading === `paid-${charge.id}`}
                              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                            >
                              {t("checkOut.markAsPaid")}
                            </button>
                            <button
                              type="button"
                              onClick={() => settleCharge(charge, "waived")}
                              disabled={actionLoading === `waived-${charge.id}`}
                              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                            >
                              {t("checkOut.waive")}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))
                )}

                <div className="grid gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 md:grid-cols-[minmax(0,1fr)_130px_auto]">
                  <input
                    value={chargeLabel}
                    onChange={(event) => setChargeLabel(event.target.value)}
                    placeholder={t("checkOut.chargeLabel")}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                  />
                  <input
                    value={chargeAmount}
                    onChange={(event) => setChargeAmount(event.target.value)}
                    placeholder={t("checkOut.amount")}
                    inputMode="decimal"
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                  />
                  <button
                    type="button"
                    onClick={addCharge}
                    disabled={addingCharge}
                    className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-60"
                  >
                    {t("checkOut.addCharge")}
                  </button>
                </div>

                <div className="grid gap-2 rounded-lg border border-gray-200 bg-white p-4 text-sm">
                  <TotalRow
                    label={t("checkOut.baseBookingSettled")}
                    value={formatCurrency(
                      booking.totalAmount - additionalCharges,
                      booking.currency,
                    )}
                  />
                  <TotalRow
                    label={t("checkOut.additionalCharges")}
                    value={formatCurrency(additionalCharges, booking.currency)}
                  />
                  <TotalRow
                    label={t("bookings.statusPending")}
                    value={formatCurrency(pendingTotal, booking.currency)}
                    highlight={pendingTotal > 0}
                  />
                  <TotalRow
                    label={t("checkOut.grandTotal")}
                    value={formatCurrency(
                      booking.totalAmount + additionalCharges,
                      booking.currency,
                    )}
                    strong
                  />
                </div>
              </div>
            </Section>

            <Section title={t("checkOut.notes")}>
              <div className="space-y-5">
                {checkInNotes.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      {t("checkOut.fromCheckIn")}
                    </p>
                    <div className="mt-2 space-y-2">
                      {checkInNotes.map((note) => (
                        <NoteRow key={note.id} note={note} />
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    {t("checkOut.checkoutNotes")}
                  </p>
                  <textarea
                    value={noteDraft}
                    onChange={(event) => setNoteDraft(event.target.value)}
                    placeholder={t("checkOut.notePlaceholder")}
                    rows={4}
                    className="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
                  />
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={saveNote}
                      disabled={savingNote || !noteDraft.trim()}
                      className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                    >
                      {savingNote ? t("common.saving") : t("checkOut.saveNote")}
                    </button>
                  </div>
                  {checkoutNotes.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {checkoutNotes.map((note) => (
                        <NoteRow key={note.id} note={note} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Section>
          </div>

          <aside className="lg:sticky lg:top-4 lg:self-start">
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <p className="text-sm font-semibold text-gray-950">{t("checkOut.checklist")}</p>
              <div className="mt-4 space-y-2">
                <ChecklistItem label={t("checkOut.stayReviewed")} state="ok" />
                {steps.map((step) => {
                  const draft = inspection[step.id];
                  return (
                    <ChecklistItem
                      key={step.id}
                      label={
                        draft?.status === "issue"
                          ? `${step.label} - ${step.negativeLabel}`
                          : draft?.status === "ok"
                            ? `${step.label} - ${step.okLabel}`
                            : step.label
                      }
                      state={
                        draft?.status === "issue"
                          ? "issue"
                          : draft?.status === "ok"
                            ? "ok"
                            : "neutral"
                      }
                    />
                  );
                })}
                <ChecklistItem
                  label={t("checkOut.paymentSettled")}
                  state={pendingTotal > 0 ? "issue" : "ok"}
                  detail={
                    pendingTotal > 0 ? formatCurrency(pendingTotal, booking.currency) : undefined
                  }
                />
              </div>
              <button
                type="button"
                onClick={completeCheckOut}
                disabled={pendingTotal > 0 || actionLoading === "complete"}
                className="mt-5 w-full rounded-lg bg-primary-600 px-4 py-3 text-sm font-semibold text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {pendingTotal > 0
                  ? t("checkOut.settleChargesFirst")
                  : actionLoading === "complete"
                    ? t("checkOut.completing")
                    : t("checkOut.complete")}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function toInspectionResult(
  step: CheckoutInspectionStep,
  draft: InspectionDraft | undefined,
): CheckoutInspectionResult {
  const status = draft?.status || "neutral";
  return {
    stepId: step.id,
    label: step.label,
    status,
    note: status === "issue" ? draft?.note || null : null,
    completedAt: status === "neutral" ? null : new Date().toISOString(),
  };
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-gray-950">{title}</h2>
        {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function SummaryItem({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p
        className={`mt-1 text-sm font-semibold text-gray-950 ${multiline ? "whitespace-pre-line" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}

function TotalRow({
  label,
  value,
  highlight,
  strong,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  strong?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between ${strong ? "font-semibold" : ""}`}>
      <span className="text-gray-600">{label}</span>
      <span className={highlight ? "font-semibold text-amber-700" : "text-gray-950"}>{value}</span>
    </div>
  );
}

function NoteRow({ note }: { note: BookingNote }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
      <p className="text-sm text-gray-900">{note.body}</p>
      <p className="mt-1 text-xs text-gray-500">
        {note.authorName} - {formatDateTime(note.createdAt)}
      </p>
    </div>
  );
}

function ChecklistItem({
  label,
  state,
  detail,
}: {
  label: string;
  state: "ok" | "issue" | "neutral";
  detail?: string;
}) {
  const color =
    state === "ok" ? "bg-green-500" : state === "issue" ? "bg-amber-500" : "bg-gray-300";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-gray-100 p-2">
      <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-800">{label}</p>
        {detail && <p className="text-xs text-amber-700">{detail}</p>}
      </div>
    </div>
  );
}
