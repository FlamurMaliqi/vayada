"use client";
import RoomSelectionSummary from "@/components/booking/RoomSelectionSummary";

import { trackEvent } from "@/services/api/tracking";
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useStripe, useElements, PaymentElement } from "@stripe/react-stripe-js";
import BookingFooter from "@/components/layout/BookingFooter";
import HeroSection from "@/components/booking/HeroSection";
import { Hotel, Addon, Booking } from "@/lib/types";
import { bookingService } from "@/services/api/booking";
import {
  clearPendingBookingCreate,
  getCheckoutIdempotencyKey,
  saveLastBooking,
  toConfirmationBooking,
} from "@/lib/storage/bookingDraft";

interface StripeConfirmStepProps {
  hotel: Hotel;
  roomName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  roomTotal: number;
  roomRateBreakdown: string;
  addons: Addon[];
  selectedAddonIds: string[];
  addonQuantities: Record<string, number>;
  addonPackageQuantities?: Record<string, number>;
  addonDates?: Record<string, string[]>;
  grandTotal: number;
  // For the VAY-388 card flow this is the draft preview (status='draft',
  // empty id). After Stripe authorizes, we replace it with the real
  // booking returned by confirmAuthorization.
  booking: Booking;
  // Soft-hold draft id from POST /bookings; pass it to
  // confirmAuthorization to materialize the real booking row.
  draftId: string | null;
  confirmationToken?: string;
  slug: string;
  formatPrice: (amount: number, fromCurrency: string) => string;
  formatDate: (date: string | Date, locale?: string) => string;
  locale: string;
  roomsParam: number;
  selectedCurrency: string;
  convertAndRound: (amount: number, fromCurrency: string) => number;
  depositRequired: boolean;
  depositPercentage: number;
  depositAmount: number;
  remainingBalance: number;
}

export default function StripeConfirmStep({
  hotel,
  roomName,
  checkIn,
  checkOut,
  nights,
  adults,
  roomTotal,
  roomRateBreakdown,
  addons,
  selectedAddonIds,
  addonQuantities,
  addonPackageQuantities = {},
  addonDates,
  grandTotal,
  booking,
  draftId,
  confirmationToken,
  slug,
  formatPrice,
  formatDate,
  locale,
  roomsParam,
  selectedCurrency,
  convertAndRound,
  depositRequired,
  depositPercentage,
  depositAmount,
  remainingBalance,
}: StripeConfirmStepProps) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const t = useTranslations("payment");
  const tc = useTranslations("common");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const confirmationStarted = useRef(false);

  const handleConfirmPayment = async () => {
    if (!stripe || !elements || confirmationStarted.current) return;

    confirmationStarted.current = true;
    setSubmitting(true);
    setError("");

    try {
      const localePrefix = locale === "en" ? "" : `/${locale}`;
      const confirmationUrl = new URL(`${localePrefix}/confirmation`, window.location.origin);
      confirmationUrl.searchParams.set("booking", booking.bookingReference);
      if (confirmationToken) confirmationUrl.searchParams.set("token", confirmationToken);
      const { error: stripeError, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: confirmationUrl.toString() },
        redirect: "if_required",
      });

      if (stripeError) {
        setError(stripeError.message || "Payment failed");
        confirmationStarted.current = false;
        setSubmitting(false);
        return;
      }

      if (paymentIntent && ["succeeded", "requires_capture"].includes(paymentIntent.status)) {
        trackEvent(slug, "payment_authorized", { paymentMethod: "card" });
      }

      // VAY-388: pass the draft id so the backend materializes the real
      // booking row. Falls back to booking.id for the legacy path (only
      // hit if a non-card flow ever lands on this component, which it
      // shouldn't).
      const handle = draftId || booking.id;
      const materialized = await bookingService.confirmAuthorization(
        slug,
        handle,
        getCheckoutIdempotencyKey("confirm", handle),
      );
      saveLastBooking(
        toConfirmationBooking(materialized, {
          ...booking,
          paymentMethod: "card",
          paymentStatus: "paid",
        }),
      );
      clearPendingBookingCreate();
      const confirmationParams = new URLSearchParams({
        booking: materialized.bookingReference,
      });
      if (confirmationToken) confirmationParams.set("token", confirmationToken);
      router.push(`/confirmation?${confirmationParams}`);
    } catch (err: unknown) {
      setError(err instanceof Error && err.message ? err.message : "Payment confirmation failed");
      confirmationStarted.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <HeroSection heroImage={hotel.heroImage} hotelName={hotel.name} compact />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="bg-white rounded-2xl border border-gray-200 p-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            {t("confirmPayment") || "Confirm Payment"}
          </h2>
          <p className="text-gray-600 mb-6">
            {t("confirmPaymentDescInstant") ||
              "Complete your payment to confirm the booking. Your card will be charged now."}
          </p>

          <div className="mb-6 p-4 bg-accent rounded-xl space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">
                {!booking.roomSelection && roomsParam > 1 ? `${roomsParam}× ` : ""}
                {roomName}
              </span>
              <span className="font-semibold text-gray-900">
                {formatPrice(roomTotal, selectedCurrency)}
              </span>
            </div>
            {booking.roomLines ? (
              <RoomSelectionSummary
                lines={booking.roomLines}
                currency={booking.currency}
                checkIn={checkIn}
                timezone={hotel.timezone}
                beforeDiscounts
              />
            ) : (
              <p className="text-xs text-gray-500 text-right">{roomRateBreakdown}</p>
            )}
            {addons
              .filter((a) => selectedAddonIds.includes(a.id))
              .map((addon) => {
                const count = addonQuantities?.[addon.id];
                const dates = addonDates?.[addon.id];
                const people = addon.perPerson
                  ? Math.max(1, Math.min(count ?? Math.max(1, adults), Math.max(1, adults)))
                  : 1;
                const days = addon.perNight
                  ? Math.max(
                      1,
                      Math.min(
                        dates?.length ?? (addon.perPerson ? nights : (count ?? nights)),
                        nights,
                      ),
                    )
                  : 1;
                const items = !addon.perPerson && !addon.perNight ? Math.max(1, count ?? 1) : 1;
                const linePrice = convertAndRound(
                  addon.price * people * days * items * (addonPackageQuantities[addon.id] ?? 1),
                  addon.currency,
                );
                const parts: string[] = [];
                if ((addonPackageQuantities[addon.id] ?? 1) > 1)
                  parts.push(`×${addonPackageQuantities[addon.id]}`);
                if (addon.perPerson && people < adults) parts.push(`${people}/${adults}`);
                if (addon.perNight && days < nights) parts.push(`${days}/${nights}`);
                if (!addon.perPerson && !addon.perNight && items > 1) parts.push(`×${items}`);
                const annotation = parts.length ? ` (${parts.join(" · ")})` : "";
                return (
                  <div key={addon.id} className="flex justify-between text-sm">
                    <span className="text-gray-500">
                      {addon.name}
                      {annotation}
                    </span>
                    <span className="font-semibold text-gray-900">
                      {formatPrice(linePrice, selectedCurrency)}
                    </span>
                  </div>
                );
              })}
            <div className="flex justify-between text-sm">
              <span className="text-gray-500">
                {formatDate(checkIn, locale)} — {formatDate(checkOut, locale)}
              </span>
              <span className="text-gray-500">{tc("nights", { count: nights })}</span>
            </div>
            <div className="flex justify-between text-sm pt-2 border-t border-gray-200">
              <span className="font-semibold text-gray-900">Total</span>
              <span className="font-bold text-gray-900">
                {formatPrice(grandTotal, selectedCurrency)}
              </span>
            </div>
            {depositRequired && (
              <div className="space-y-2 pt-2 border-t border-gray-200">
                <div className="flex justify-between text-sm">
                  <span className="font-semibold text-gray-900">
                    Deposit due now ({depositPercentage}%)
                  </span>
                  <span className="font-bold text-gray-900">
                    {formatPrice(depositAmount, selectedCurrency)}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Remaining due at arrival</span>
                  <span className="font-semibold text-gray-900">
                    {formatPrice(remainingBalance, selectedCurrency)}
                  </span>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="mb-6">
            <PaymentElement />
          </div>

          <button
            onClick={handleConfirmPayment}
            disabled={!stripe || submitting}
            className={`w-full py-3 text-center font-semibold rounded-lg transition-colors text-sm ${
              !stripe || submitting
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-primary-600 text-white hover:bg-primary-700"
            }`}
          >
            {submitting
              ? t("processing") || "Processing..."
              : depositRequired
                ? `Pay deposit ${formatPrice(depositAmount, selectedCurrency)}`
                : t("authorizePayment") || `Pay ${formatPrice(grandTotal, selectedCurrency)}`}
          </button>

          <p className="text-xs text-gray-500 text-center mt-3">
            {depositRequired
              ? `Your card is charged ${formatPrice(depositAmount, selectedCurrency)} now. The remaining balance is paid at the property.`
              : t("authorizationNote") ||
                `Your card is charged ${formatPrice(grandTotal, selectedCurrency)} now.`}
          </p>
        </div>
      </div>

      <BookingFooter />
    </div>
  );
}
