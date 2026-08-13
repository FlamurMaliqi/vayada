"use client";

import { useState, useEffect, useMemo, use } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import Image from "next/image";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { Booking } from "@/lib/types";
import { readLastBooking } from "@/lib/storage/bookingDraft";
import { bookingService, ChangeRequestPreview } from "@/services/api/booking";

export default function RequestChangePage({
  params,
  searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ email?: string }>;
}) {
  const { reference } = use(params);
  const { email: emailParam } = use(searchParams);
  const t = useTranslations("requestChange");
  const { hotel } = useHotel();
  const { slug } = useSlug();
  const { formatPrice } = useCurrency();
  const router = useRouter();

  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [hasPending, setHasPending] = useState(false);

  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [preview, setPreview] = useState<ChangeRequestPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const [guestEmail, setGuestEmail] = useState(emailParam || "");
  const [emailResolved, setEmailResolved] = useState(Boolean(emailParam));

  useEffect(() => {
    if (emailParam) {
      setGuestEmail(emailParam);
    } else {
      const stored = readLastBooking();
      if (stored?.bookingReference === reference) setGuestEmail(stored.guestEmail);
    }
    setEmailResolved(true);
  }, [emailParam, reference]);

  // Load the booking and any existing date-change request.
  useEffect(() => {
    if (!emailResolved) return;
    if (!guestEmail) {
      setLoadError(
        t("missingEmail") || "This page must be opened from the booking confirmation link.",
      );
      setLoading(false);
      return;
    }
    let cancelled = false;
    bookingService
      .lookup(slug, reference, guestEmail)
      .then(async (fetched) => {
        if (cancelled) return;
        setBooking(fetched);
        setCheckIn(fetched.checkIn);
        setCheckOut(fetched.checkOut);
        try {
          const cr = await bookingService.getChangeRequest(slug, fetched.id, guestEmail);
          if (cr && cr.status === "pending") {
            setHasPending(true);
          }
        } catch {
          // 404 or auth error — fine, treat as no pending request.
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err.message || t("loadError") || "Could not load this booking.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reference, guestEmail, emailResolved, slug, t]);

  // Debounced preview fetch whenever the form changes.
  useEffect(() => {
    if (!booking || hasPending || !checkIn || !checkOut) return;
    if (new Date(checkOut).getTime() <= new Date(checkIn).getTime()) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    setPreviewError("");
    const timer = setTimeout(async () => {
      try {
        const res = await bookingService.previewChangeRequest(slug, booking.id, {
          guestEmail,
          checkIn,
          checkOut,
          addonIds: [],
          addonQuantities: {},
          addonDates: {},
        });
        if (!cancelled) {
          setPreview(res);
          setPreviewError(res.blocked ? res.blockReason || t("previewUnavailable") : "");
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(
            err instanceof Error && err.message ? err.message : t("previewUnavailable"),
          );
        }
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [booking, hasPending, slug, guestEmail, checkIn, checkOut, t]);

  const handleSubmit = async () => {
    if (!booking) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      await bookingService.submitChangeRequest(slug, booking.id, {
        guestEmail,
        checkIn,
        checkOut,
        addonIds: [],
        addonQuantities: {},
        addonDates: {},
      });
      router.push(`/booking/${reference}`);
    } catch (err: unknown) {
      setSubmitError(err instanceof Error && err.message ? err.message : t("submitError"));
    } finally {
      setSubmitting(false);
    }
  };

  const noChange = useMemo(() => {
    if (!booking) return true;
    return checkIn === booking.checkIn && checkOut === booking.checkOut;
  }, [booking, checkIn, checkOut]);

  const submitDisabled =
    submitting || previewing || hasPending || !preview || preview.blocked || noChange;

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex flex-col">
        <div className="relative h-32 w-full">
          <Image
            src={hotel.heroImage}
            alt={hotel.name}
            fill
            className="object-cover"
            priority
            sizes={bookingImageSizes.hero}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60" />
          <BookingNavigation />
        </div>
        <div className="max-w-xl mx-auto px-4 py-12 flex-1 text-center text-gray-500 text-sm">
          {t("loading") || "Loading…"}
        </div>
        <BookingFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <div className="relative h-32 w-full">
        <Image
          src={hotel.heroImage}
          alt={hotel.name}
          fill
          className="object-cover"
          priority
          sizes={bookingImageSizes.hero}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/40 to-black/60" />
        <BookingNavigation />
      </div>

      <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8 py-12 flex-1 w-full">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          {t("title") || "Request Booking Changes"}
        </h1>
        <p className="text-sm text-gray-600 mb-6">
          {t("subtitle") ||
            "Choose new stay dates. We'll verify availability and price before we review your request."}
        </p>

        {loadError && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {loadError}
          </div>
        )}

        {hasPending && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
            {t("pendingExists") ||
              "A change request is already pending approval for this booking. Please wait for us to respond."}
          </div>
        )}

        {booking && !hasPending && (
          <>
            <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
              <h2 className="text-sm font-semibold text-gray-900 mb-3">
                {t("newDates") || "New dates"}
              </h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    {t("checkIn") || "Check-in"}
                  </label>
                  <input
                    type="date"
                    value={checkIn}
                    onChange={(e) => setCheckIn(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 bg-gray-50 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    {t("checkOut") || "Check-out"}
                  </label>
                  <input
                    type="date"
                    value={checkOut}
                    onChange={(e) => setCheckOut(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 bg-gray-50 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-200 p-6 mb-4">
              <h2 className="text-sm font-semibold text-gray-900 mb-3">
                {t("summary") || "Summary"}
              </h2>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">{t("currentDates") || "Current dates"}</span>
                  <span className="font-medium text-gray-900">
                    {booking.checkIn} → {booking.checkOut}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">{t("requestedDates") || "Requested dates"}</span>
                  <span className="font-medium text-gray-900">
                    {checkIn} → {checkOut}
                  </span>
                </div>
                <div className="flex justify-between pt-2 border-t border-gray-100">
                  <span className="text-gray-500">{t("oldTotal") || "Old total"}</span>
                  <span className="font-medium text-gray-900">
                    {formatPrice(booking.totalAmount, booking.currency)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">{t("newTotal") || "New total"}</span>
                  <span className="font-medium text-gray-900">
                    {preview ? formatPrice(preview.newTotal, preview.currency) : "—"}
                  </span>
                </div>
                <div className="flex justify-between pt-2 border-t border-gray-100">
                  <span className="font-semibold text-gray-900">
                    {t("priceDifference") || "Price difference"}
                  </span>
                  <span
                    className={`font-bold ${preview && preview.priceDifference > 0 ? "text-amber-600" : preview && preview.priceDifference < 0 ? "text-green-600" : "text-gray-900"}`}
                  >
                    {preview
                      ? preview.priceDifference > 0
                        ? `+${formatPrice(preview.priceDifference, preview.currency)}`
                        : formatPrice(preview.priceDifference, preview.currency)
                      : "—"}
                  </span>
                </div>
              </div>
              {preview?.blocked && preview.blockReason && (
                <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                  {preview.blockReason}
                </p>
              )}
              {!preview?.blocked && previewError && (
                <p className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                  {previewError}
                </p>
              )}
            </div>

            {submitError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {submitError}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitDisabled}
              className="w-full py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {submitting
                ? t("submitting") || "Submitting…"
                : t("submit") || "Submit Change Request"}
            </button>
          </>
        )}
      </div>

      <BookingFooter />
    </div>
  );
}
