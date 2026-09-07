"use client";

import { formatCheckInTime, formatCheckOutTime } from "@/lib/arrivalTimes";
import { Link } from "@/i18n/navigation";
import RoomSelectionSummary from "@/components/booking/RoomSelectionSummary";
import { useState, useEffect } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { bookingService, CancelPreview, type BookingLookupResponse } from "@/services/api/booking";
import { readLastBooking } from "@/lib/storage/bookingDraft";

export default function MyBookingPageClient() {
  const t = useTranslations("myBooking");
  const tc = useTranslations("common");
  const tr = useTranslations("roomSelection");
  const { hotel } = useHotel();
  const { formatPrice } = useCurrency();
  const searchParams = useSearchParams();
  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  const [booking, setBooking] = useState<BookingLookupResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const { slug } = useSlug();

  const [cancelPreview, setCancelPreview] = useState<CancelPreview | null>(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [successMessage, setSuccessMessage] = useState("");

  const handleSearch = async (overrideReference?: string, overrideEmail?: string) => {
    const ref = overrideReference ?? reference;
    const em = overrideEmail ?? email;
    if (!ref || !em) return;
    setSearching(true);
    setError("");
    setBooking(null);
    setSuccessMessage("");

    try {
      const result = await bookingService.lookup(slug, ref, em);
      setBooking(result);
    } catch (err: any) {
      setError(err.message || t("notFound") || "Booking not found");
    } finally {
      setSearching(false);
    }
  };

  // Skip the lookup form when the guest came in from the confirmation
  // email link with ?reference=&email= already populated (VAY-379).
  useEffect(() => {
    const qpRef = searchParams.get("reference");
    const stored = readLastBooking();
    const qpEmail =
      searchParams.get("email") ||
      (stored?.bookingReference === qpRef?.toUpperCase() ? (stored?.guestEmail ?? "") : "");
    if (qpRef && qpEmail) {
      setReference(qpRef.toUpperCase());
      setEmail(qpEmail);
      handleSearch(qpRef.toUpperCase(), qpEmail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isPending = booking?.status === "pending";
  const isConfirmed = booking?.status === "confirmed";
  const isFutureCheckIn = booking
    ? booking.checkIn >= new Date().toISOString().slice(0, 10)
    : false;
  const canCancel = (isPending || isConfirmed) && isFutureCheckIn;

  const handleCancelClick = async () => {
    if (!booking) return;

    if (isPending) {
      setShowConfirmDialog(true);
      return;
    }

    setLoadingPreview(true);
    setError("");
    try {
      const preview = await bookingService.cancelPreview(slug, booking.id, email);
      setCancelPreview(preview);
      setShowConfirmDialog(true);
    } catch (err: any) {
      setError(err.message || "Failed to load cancellation details");
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleConfirmCancel = async () => {
    if (!booking) return;
    setCancelling(true);
    setError("");

    try {
      if (isPending) {
        await bookingService.withdraw(slug, booking.id, email);
        setBooking({ ...booking, status: "cancelled" });
        setSuccessMessage(t("bookingWithdrawn"));
      } else {
        await bookingService.cancel(slug, booking.id, email);
        setBooking({ ...booking, status: "cancelled" });
        setSuccessMessage(t("bookingCancelled"));
      }
      setShowConfirmDialog(false);
      setCancelPreview(null);
    } catch (err: any) {
      setError(err.message || "Cancellation failed");
    } finally {
      setCancelling(false);
    }
  };

  const handleCloseDialog = () => {
    setShowConfirmDialog(false);
    setCancelPreview(null);
  };

  const statusColor: Record<string, string> = {
    confirmed: "text-success-600",
    pending: "text-yellow-600",
    cancelled: "text-red-600",
    // VAY-404 — host-rejected request, distinct from guest cancel.
    declined: "text-red-700",
    expired: "text-gray-500",
  };

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      {/* Mini Hero */}
      <div className="relative h-48 w-full">
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
        <div className="absolute inset-0 flex items-center justify-center">
          <h1 className="text-3xl md:text-4xl font-heading italic text-white">{t("title")}</h1>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8 py-12 flex-1">
        {/* Lookup Form */}
        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="text-xl font-bold text-gray-900 mb-2">{t("lookUp")}</h2>
          <p className="text-sm text-gray-600 mb-6">{t("lookUpDesc")}</p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t("reference")} *
              </label>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value.toUpperCase())}
                placeholder="VAY-XXXXXX"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-gray-50 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400 uppercase tracking-wider"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                {t("emailAddress")} *
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="john@example.com"
                className="w-full px-4 py-3 rounded-lg border border-gray-300 bg-gray-50 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
              />
            </div>
            <button
              onClick={() => handleSearch()}
              disabled={searching || !reference || !email}
              className="w-full py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors disabled:opacity-50"
            >
              {searching ? "..." : t("findBooking")}
            </button>
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Success Message */}
        {successMessage && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700 flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            {successMessage}
          </div>
        )}

        {/* Result */}
        {booking && (
          <div className="mt-6 bg-white rounded-2xl border border-gray-200 p-6">
            <div className="flex items-center gap-3 mb-4">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center ${
                  booking.status === "cancelled" ||
                  booking.status === "declined" ||
                  booking.status === "expired"
                    ? "bg-red-100"
                    : "bg-success-100"
                }`}
              >
                {booking.status === "cancelled" ||
                booking.status === "declined" ||
                booking.status === "expired" ? (
                  <svg
                    className="w-5 h-5 text-red-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                ) : (
                  <svg
                    className="w-5 h-5 text-success-600"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                )}
              </div>
              <div>
                <p className="font-bold text-gray-900">{t("bookingFound")}</p>
                <p
                  className={`text-sm font-medium capitalize ${statusColor[booking.status] || ""}`}
                >
                  {booking.status === "cancelled"
                    ? t("cancelled")
                    : booking.status === "declined"
                      ? t("declined") || "Declined"
                      : booking.status}
                </p>
              </div>
            </div>

            <div className="space-y-0 divide-y divide-gray-100">
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("reference")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {booking.bookingReference}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("hotel")}</span>
                <span className="font-medium text-gray-900 text-sm">{booking.hotelName}</span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("room")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {!booking.roomSelection && booking.numberOfRooms && booking.numberOfRooms > 1
                    ? `${booking.numberOfRooms}× `
                    : ""}
                  {booking.roomName}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("checkIn")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {booking.checkIn}, {formatCheckInTime(hotel)}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("checkOut")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {booking.checkOut}, {formatCheckOutTime(hotel)}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("guests")}</span>
                <span className="font-medium text-gray-900 text-sm">
                  {tc("adults", { count: booking.adults })}
                  {booking.children > 0 && `, ${tc("children", { count: booking.children })}`}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600 text-sm">{t("total")}</span>
                <span className="font-bold text-gray-900">
                  {formatPrice(booking.totalAmount, booking.currency)}
                </span>
              </div>
            </div>

            {booking.roomLines && (
              <div className="mt-5">
                <RoomSelectionSummary
                  lines={booking.roomLines}
                  currency={booking.currency}
                  checkIn={booking.checkIn}
                  timezone={hotel.timezone}
                />
              </div>
            )}
            {isPending &&
              booking.canEditRequest &&
              booking.confirmationToken &&
              (!booking.hostResponseDeadline ||
                Date.parse(booking.hostResponseDeadline) > Date.now()) && (
                <Link
                  href={`/booking/${encodeURIComponent(booking.bookingReference)}/edit-request?token=${encodeURIComponent(booking.confirmationToken)}`}
                  className="mt-6 inline-block rounded-full border border-gray-300 px-6 py-3 font-semibold"
                >
                  {tr("editRequest")}
                </Link>
              )}
            {/* Cancel / Withdraw Button */}
            {canCancel && (
              <button
                onClick={handleCancelClick}
                disabled={loadingPreview}
                className="w-full mt-6 py-3 border-2 border-red-300 text-red-600 font-semibold rounded-full hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {loadingPreview ? "..." : isPending ? t("withdrawBooking") : t("cancelBooking")}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Confirmation Dialog Overlay */}
      {showConfirmDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900 mb-3">
              {isPending ? t("withdrawConfirmTitle") : t("cancelConfirmTitle")}
            </h3>

            {/* Refund info for confirmed bookings */}
            {cancelPreview && !isPending && (
              <div className="mb-4 space-y-2">
                <div
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                    cancelPreview.cancellationFeeAmount === 0 ||
                    cancelPreview.refundPercentage >= 100
                      ? "bg-green-100 text-green-700"
                      : cancelPreview.refundPercentage > 0
                        ? "bg-yellow-100 text-yellow-700"
                        : "bg-red-100 text-red-700"
                  }`}
                >
                  {cancelPreview.cancellationFeeAmount === 0 ||
                  cancelPreview.refundPercentage >= 100
                    ? t("freeCancellation")
                    : t("cancellationFeeApplies")}
                </div>
                <p className="text-sm text-gray-700">
                  {cancelPreview.amountPaid === 0 && cancelPreview.cancellationFeeAmount === 0
                    ? t("noPaymentToRefund")
                    : cancelPreview.refundPercentage >= 100
                      ? t("fullRefund", {
                          amount: formatPrice(cancelPreview.refundAmount, cancelPreview.currency),
                        })
                      : cancelPreview.refundPercentage > 0
                        ? t("partialRefund", {
                            amount: formatPrice(cancelPreview.refundAmount, cancelPreview.currency),
                            percentage: cancelPreview.refundPercentage,
                          })
                        : t("noRefund")}
                </p>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button
                onClick={handleCloseDialog}
                disabled={cancelling}
                className="flex-1 py-3 border border-gray-300 text-gray-700 font-semibold rounded-full hover:bg-gray-50 transition-colors"
              >
                {t("goBack")}
              </button>
              <button
                onClick={handleConfirmCancel}
                disabled={cancelling}
                className="flex-1 py-3 bg-red-600 text-white font-semibold rounded-full hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {cancelling
                  ? isPending
                    ? t("withdrawing")
                    : t("cancelling")
                  : isPending
                    ? t("confirmWithdraw")
                    : t("confirmCancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      <BookingFooter />
    </div>
  );
}
