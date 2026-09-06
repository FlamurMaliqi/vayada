"use client";

import { useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  bookingsService,
  type Booking,
  type HostBookingActionPreview,
  type HostBookingActionRequest,
} from "@/services/bookings";

export function HostBookingActions({
  booking,
  onApplied,
}: {
  booking: Booking;
  onApplied: (status: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState<HostBookingActionRequest["action"] | null>(null);
  const [checkIn, setCheckIn] = useState(booking.checkIn);
  const [checkOut, setCheckOut] = useState(booking.checkOut);
  const [reason, setReason] = useState("");
  const [guestMessage, setGuestMessage] = useState("");
  const [preview, setPreview] = useState<HostBookingActionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const key = useRef("");
  const label = (value: HostBookingActionRequest["action"]) => t(`hostActions.${value}`);
  const begin = (value: HostBookingActionRequest["action"]) => {
    setAction(value);
    setPreview(null);
    setError("");
    setNotice("");
    setReason("");
    setGuestMessage("");
    setCheckIn(booking.checkIn);
    setCheckOut(booking.checkOut);
  };
  const submit = async () => {
    if (!action || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!preview) {
        const result = await bookingsService.previewHostAction(booking.id, {
          action,
          reason,
          guestMessage,
          ...(action === "edit_dates" ? { checkIn, checkOut } : {}),
        });
        key.current = crypto.randomUUID();
        setPreview(result);
      } else {
        const result = await bookingsService.applyHostAction(
          booking.id,
          preview.previewId,
          key.current,
        );
        setAction(null);
        setPreview(null);
        setNotice(t("hostActions.applied"));
        try {
          await onApplied(result.lifecycleStatus);
        } catch {
          setNotice(t("hostActions.appliedReloadFailed"));
        }
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("hostActions.failed"));
      // Preserve the preview and key after an uncertain request so retry can replay.
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (booking.channel === "manual" || !["pending", "confirmed"].includes(booking.status))
    return notice ? <p role="status">{notice}</p> : null;
  const button = "rounded-lg border px-4 py-2 text-sm disabled:opacity-50";
  return (
    <section
      aria-label={t("hostActions.title")}
      className="rounded-xl border border-gray-200 bg-white p-5 space-y-4"
    >
      <h2 className="text-sm font-semibold">{t("hostActions.title")}</h2>
      {notice && (
        <p role="status" className="text-sm text-green-700">
          {notice}
        </p>
      )}
      {!action ? (
        <div className="flex gap-3">
          {(booking.status === "pending"
            ? (["reject"] as const)
            : (["edit_dates", "cancel"] as const)
          ).map((value) => (
            <button key={value} className={button} disabled={busy} onClick={() => begin(value)}>
              {label(value)}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h3 className="font-medium">{label(action)}</h3>
          {!preview ? (
            <>
              {action === "edit_dates" && (
                <div className="flex flex-wrap gap-4">
                  <label className="text-sm">
                    {t("hostActions.checkIn")}
                    <input
                      className="block rounded border p-2"
                      type="date"
                      required
                      value={checkIn}
                      disabled={busy}
                      onChange={(e) => setCheckIn(e.target.value)}
                    />
                  </label>
                  <label className="text-sm">
                    {t("hostActions.checkOut")}
                    <input
                      className="block rounded border p-2"
                      type="date"
                      required
                      value={checkOut}
                      disabled={busy}
                      onChange={(e) => setCheckOut(e.target.value)}
                    />
                  </label>
                </div>
              )}
              <label className="block text-sm">
                {t("hostActions.reason")}
                <textarea
                  className="mt-1 block w-full rounded border p-2"
                  required
                  maxLength={1000}
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label className="block text-sm">
                {t("hostActions.guestMessage")}
                <textarea
                  className="mt-1 block w-full rounded border p-2"
                  maxLength={5000}
                  value={guestMessage}
                  disabled={busy}
                  onChange={(e) => setGuestMessage(e.target.value)}
                />
              </label>
            </>
          ) : (
            <div className="space-y-2 rounded-lg bg-gray-50 p-4 text-sm">
              <p>
                {preview.impact.checkIn} → {preview.impact.checkOut}
              </p>
              <p>
                {t("hostActions.price")}: {preview.impact.totalAmount} →{" "}
                {preview.impact.newTotalAmount} {preview.impact.currency}
              </p>
              <p>
                {t(
                  preview.impact.payment === "authorization_void"
                    ? "hostActions.voidImpact"
                    : action === "edit_dates"
                      ? "hostActions.editImpact"
                      : "hostActions.cancelImpact",
                )}
              </p>
              {preview.impact.cancellationPolicy && (
                <div>
                  <p>
                    {t(
                      preview.impact.cancellationPolicy.type === "non_refundable"
                        ? "hostActions.nonRefundable"
                        : "hostActions.freeCancellationUntil",
                    )}
                    {preview.impact.cancellationPolicy.type === "flexible" && (
                      <>
                        : {preview.impact.cancellationPolicy.previousDeadline} →{" "}
                        {preview.impact.cancellationPolicy.newDeadline} (
                        {preview.impact.cancellationPolicy.timezone})
                      </>
                    )}
                  </p>
                  <p>{t("hostActions.policyPenalty")}</p>
                </div>
              )}
              <p>
                {t("hostActions.messagePreview")}: {guestMessage || t("hostActions.noMessage")}
              </p>
              <p>
                {t("hostActions.expires")}: {new Date(preview.expiresAt).toLocaleTimeString()}
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              className={`${button} bg-primary-600 text-white`}
              disabled={busy || !reason.trim()}
            >
              {t(
                busy
                  ? "hostActions.working"
                  : preview
                    ? "hostActions.apply"
                    : "hostActions.preview",
              )}
            </button>
            {preview && (
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setError("");
                }}
              >
                {t("hostActions.newPreview")}
              </button>
            )}
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => setAction(null)}
            >
              {t("hostActions.close")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
