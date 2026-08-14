"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";

import { useSlug } from "@/contexts/HotelContext";
import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/services/api/client";
import { bookingService } from "@/services/api/booking";

export default function FindBookingModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("myBooking");
  const tc = useTranslations("common");
  const router = useRouter();
  const { slug } = useSlug();
  const dialog = useRef<HTMLDialogElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  const requestVersion = useRef(0);
  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) {
      element.showModal();
      referenceInput.current?.focus();
    }
    if (!open && element?.open) element.close();
    return () => {
      requestVersion.current += 1;
      if (element?.open) element.close();
    };
  }, [open]);

  const close = () => {
    requestVersion.current += 1;
    setLoading(false);
    dialog.current?.close();
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const booking = await bookingService.lookup(slug, reference.trim(), email.trim());
      if (version !== requestVersion.current) return;
      const params = new URLSearchParams({
        booking: booking.bookingReference,
        token: booking.confirmationToken,
      });
      dialog.current?.close();
      onClose();
      router.push(`/confirmation?${params}`);
    } catch (lookupError) {
      if (version !== requestVersion.current) return;
      setError(
        lookupError instanceof ApiError && lookupError.status === 404
          ? t("notFound")
          : lookupError instanceof ApiError && lookupError.status === 429
            ? t("tooManyAttempts")
            : t("lookupUnavailable"),
      );
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="find-booking-title"
      aria-describedby="find-booking-description"
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl backdrop:bg-black/55 backdrop:backdrop-blur-sm sm:p-7"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onMouseDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          close();
        }
      }}
    >
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="find-booking-title" className="text-xl font-bold text-gray-900">
              {t("lookUp")}
            </h2>
            <p id="find-booking-description" className="mt-2 text-sm leading-6 text-gray-600">
              {t("lookUpDesc")}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            className="-mr-2 -mt-2 rounded-full p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800"
            aria-label={tc("close") || "Close"}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18 18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block text-sm font-medium text-gray-700">
            {t("reference")}
            <input
              ref={referenceInput}
              required
              autoComplete="off"
              value={reference}
              onChange={(event) => setReference(event.target.value.toUpperCase())}
              placeholder="VAY-XXXXXX"
              className="mt-1.5 w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 uppercase tracking-wider text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </label>
          <label className="block text-sm font-medium text-gray-700">
            {t("emailAddress")}
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="guest@example.com"
              className="mt-1.5 w-full rounded-lg border border-gray-300 bg-gray-50 px-4 py-3 text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </label>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !reference.trim() || !email.trim()}
            className="w-full rounded-full bg-primary-600 py-3 font-semibold text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? tc("loading") : t("findBooking")}
          </button>
        </form>
      </div>
    </dialog>
  );
}
