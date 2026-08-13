"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import BookingNavigation from "@/components/layout/BookingNavigation";
import BookingFooter from "@/components/layout/BookingFooter";
import Image from "next/image";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { useHotel, useSlug } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { Booking } from "@/lib/types";
import {
  bookingService,
  type BookingChangeRequest,
  type BookingCreateRequest,
  type BookingQuote,
} from "@/services/api/booking";
import { trackEvent } from "@/services/api/tracking";
import { ApiError } from "@/services/api/client";
import {
  clearPendingBookingCreate,
  readGuestDetails,
  readLastBooking,
  readPendingBookingCreate,
  saveLastBooking,
  toConfirmationBooking,
} from "@/lib/storage/bookingDraft";

function CountdownTimer({ deadline }: { deadline: string }) {
  const [timeLeft, setTimeLeft] = useState("");

  useEffect(() => {
    const update = () => {
      const now = new Date().getTime();
      const end = new Date(deadline).getTime();
      const diff = end - now;

      if (diff <= 0) {
        setTimeLeft("Expired");
        return;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      setTimeLeft(`${hours}h ${minutes}m ${seconds}s`);
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  return <span className="font-mono text-lg font-bold text-amber-600">{timeLeft}</span>;
}

function displayCardBrand(brand: string): string {
  return brand.charAt(0).toUpperCase() + brand.slice(1).replaceAll("_", " ");
}

export default function BookingConfirmationPageClient({
  reference,
  emailParam,
  tokenParam,
}: {
  reference: string;
  emailParam?: string;
  tokenParam?: string;
}) {
  const t = useTranslations("confirmation");
  const tc = useTranslations("common");
  const tp = useTranslations("payment");
  const { hotel } = useHotel();
  const { slug } = useSlug();
  const { formatPrice } = useCurrency();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [status, setStatus] = useState<string>("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState("");
  const [hydrating, setHydrating] = useState(false);
  const [hydrateError, setHydrateError] = useState(false);
  const [changeRequest, setChangeRequest] = useState<BookingChangeRequest | null>(null);
  const cardRecovery = useRef<Promise<Booking | null> | null>(null);
  const confirmationLookup = useRef<Promise<Booking | null> | null>(null);
  const [paypalInfo, setPaypalInfo] = useState<{
    email: string;
    windowHours: number;
  } | null>(null);

  // Use the saved booking on refresh. If Stripe redirected away for a payment
  // challenge, replay the original create command: the backend checks the same
  // PaymentIntent and materializes the booking without charging again.
  useEffect(() => {
    trackEvent(slug, "completed_booking");
    setHydrateError(false);
    const stored = readLastBooking();
    if (stored && stored.bookingReference === reference) {
      const guest = readGuestDetails();
      const normalized = toConfirmationBooking(stored, {
        hotelName: hotel.name,
        guestFirstName: guest?.guestFirstName,
        guestLastName: guest?.guestLastName,
        guestEmail: guest?.guestEmail || emailParam,
      });
      setBooking(normalized);
      setStatus(normalized.status);
      saveLastBooking(normalized);
      return;
    }

    const recovery = readPendingBookingCreate<BookingQuote, BookingCreateRequest>(slug);
    if (
      recovery?.paymentMethod === "card" &&
      (!tokenParam || recovery.confirmationToken === tokenParam)
    ) {
      let cancelled = false;
      setHydrating(true);
      cardRecovery.current ??= (async () => {
        for (let attempt = 0; attempt < 15; attempt += 1) {
          try {
            const result = await bookingService.create(
              slug,
              recovery.requestBody,
              recovery.createIdempotencyKey,
            );
            if (result.authorizationExpired) {
              clearPendingBookingCreate();
              return null;
            }
            if (result.authorizationComplete) {
              const quote = recovery.quote;
              const request = recovery.requestBody;
              const normalized = toConfirmationBooking(result.booking, {
                hotelName: hotel.name,
                roomName: quote.roomName,
                guestFirstName: request.guestFirstName,
                guestLastName: request.guestLastName,
                guestEmail: request.guestEmail,
                checkIn: request.checkIn,
                checkOut: request.checkOut,
                adults: request.adults,
                children: request.children,
                numberOfRooms: request.numberOfRooms,
                nightlyRate: quote.nightlyRate,
                totalAmount: quote.totalAmount,
                depositRequired: quote.depositRequired,
                depositPercentage: quote.depositPercentage ?? 0,
                depositAmount: quote.depositAmount,
                balanceAmount: quote.balanceAmount,
                addonTotal: quote.addonTotal,
                addonIds: request.addonIds,
                addonQuantities: request.addonQuantities,
                addonDates: request.addonDates,
                currency: quote.currency,
                paymentMethod: "card",
              });
              if (normalized.bookingReference !== reference) return null;
              saveLastBooking(normalized);
              clearPendingBookingCreate();
              return normalized;
            }
          } catch {
            // A command may still be completing; retry with the same key.
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return null;
      })();
      void cardRecovery.current
        .then((normalized) => {
          if (cancelled) return;
          if (!normalized) {
            setHydrateError(true);
            return;
          }
          setBooking(normalized);
          setStatus(normalized.status);
        })
        .finally(() => {
          if (!cancelled) setHydrating(false);
        });
      return () => {
        cancelled = true;
      };
    }

    if (tokenParam) {
      let cancelled = false;
      setHydrating(true);
      confirmationLookup.current ??= (async () => {
        for (let attempt = 0; attempt < 15; attempt += 1) {
          try {
            return await bookingService.confirmation(slug, reference, tokenParam);
          } catch (error) {
            if (error instanceof ApiError && error.status !== 409 && error.status < 500) {
              return null;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return null;
      })();
      void confirmationLookup.current
        .then((fetched) => {
          if (cancelled) return;
          if (!fetched) {
            setHydrateError(true);
            return;
          }
          const normalized = toConfirmationBooking(fetched, { hotelName: hotel.name });
          setBooking(normalized);
          setStatus(normalized.status);
          saveLastBooking(normalized);
        })
        .finally(() => {
          if (!cancelled) setHydrating(false);
        });
      return () => {
        cancelled = true;
      };
    }

    // A confirmation-email link carries the guest email so the stored booking
    // can be hydrated on another device without exposing it by reference alone.
    const email = emailParam;
    if (!email) return;

    let cancelled = false;
    setHydrating(true);
    bookingService
      .lookup(slug, reference, email)
      .then((fetched) => {
        if (cancelled) return;
        const normalized = toConfirmationBooking(fetched, {
          hotelName: hotel.name,
          guestEmail: email,
        });
        setBooking(normalized);
        setStatus(normalized.status);
        saveLastBooking(normalized);
      })
      .catch(() => {
        if (cancelled) return;
        setHydrateError(true);
      })
      .finally(() => {
        if (!cancelled) setHydrating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reference, emailParam, tokenParam, hotel.name, slug]);

  useEffect(() => {
    if (booking?.paymentMethod !== "paypal") return;
    bookingService
      .getPaymentInstructions(slug, booking.id || booking.bookingReference)
      .then((instructions) => {
        if (instructions.paypal.enabled && instructions.paypal.email) {
          setPaypalInfo({
            email: instructions.paypal.email,
            windowHours: instructions.paypal.paymentWindowHours || 24,
          });
        }
      })
      .catch(() => {});
  }, [booking?.id, booking?.bookingReference, booking?.paymentMethod, slug]);

  // Fetch any existing change request once we know the booking + email.
  useEffect(() => {
    const email = booking?.guestEmail || emailParam;
    if (!booking?.id || !email) return;
    let cancelled = false;
    bookingService
      .getChangeRequest(slug, booking.id, email)
      .then((cr) => {
        if (!cancelled) setChangeRequest(cr);
      })
      .catch(() => {
        /* 404 / network — leave null */
      });
    return () => {
      cancelled = true;
    };
  }, [booking?.id, booking?.guestEmail, emailParam, slug]);

  // Poll for status updates every 30s when pending
  useEffect(() => {
    if (status !== "pending" || !booking?.guestEmail) return;

    const poll = async () => {
      try {
        const result = await bookingService.getStatus(slug, reference, booking.guestEmail);
        if (result.status !== status) {
          setStatus(result.status);
          // Update stored booking
          if (booking) {
            const updated = { ...booking, status: result.status as Booking["status"] };
            setBooking(updated);
            saveLastBooking(updated);
          }
        }
      } catch {
        // Ignore polling errors
      }
    };

    const interval = setInterval(poll, 30000);
    return () => clearInterval(interval);
  }, [status, booking, slug, reference]);

  const handleWithdraw = async () => {
    if (!booking) return;
    setWithdrawing(true);
    setWithdrawError("");

    try {
      await bookingService.withdraw(slug, booking.id, booking.guestEmail);
      setStatus("cancelled");
      const updated = { ...booking, status: "cancelled" as const };
      setBooking(updated);
      saveLastBooking(updated);
    } catch (err: unknown) {
      setWithdrawError(
        err instanceof Error && err.message ? err.message : "Failed to withdraw booking",
      );
    } finally {
      setWithdrawing(false);
    }
  };

  const isPending = status === "pending";
  const isConfirmed = status === "confirmed";
  const isCancelled = status === "cancelled";
  // VAY-404: host-rejected request. Shares the red-X visual with cancelled
  // but uses different copy so the guest doesn't think they cancelled.
  const isDeclined = status === "declined";
  const isExpired = status === "expired";
  const displayedNights =
    booking && Number.isInteger(booking.nights) && booking.nights > 0 ? booking.nights : null;
  const displayedAdults =
    booking && Number.isInteger(booking.adults) && booking.adults >= 0 ? booking.adults : null;
  const displayedChildren =
    booking && Number.isInteger(booking.children) && booking.children >= 0 ? booking.children : 0;
  const displayedRooms =
    booking?.numberOfRooms && Number.isInteger(booking.numberOfRooms) && booking.numberOfRooms > 0
      ? booking.numberOfRooms
      : 1;
  const guestEmail = (booking?.guestEmail || emailParam || "").trim();
  const manageBookingHref = `/my-booking?reference=${encodeURIComponent(reference)}${guestEmail ? `&email=${encodeURIComponent(guestEmail)}` : ""}`;
  const requestChangesHref = guestEmail
    ? `/booking/${encodeURIComponent(reference)}/request-change?email=${encodeURIComponent(guestEmail)}`
    : null;
  const isPayAtProperty =
    booking?.paymentMethod === "pay_at_property" || booking?.paymentMethod === "cash";
  const isTotalPaid = booking?.paymentStatus === "captured" || booking?.paymentStatus === "paid";

  return (
    <div className="min-h-screen bg-surface">
      {/* Mini Hero */}
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

      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center">
          {/* Status Icon */}
          {isPending && (
            <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg
                className="w-8 h-8 text-amber-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </div>
          )}
          {isConfirmed && (
            <div className="w-16 h-16 bg-success-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg
                className="w-8 h-8 text-success-600"
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
            </div>
          )}
          {(isCancelled || isDeclined || isExpired) && (
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg
                className="w-8 h-8 text-red-600"
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
            </div>
          )}

          {/* Status Title */}
          {isPending && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                {t("requestSubmitted") || "Booking Request Submitted"}
              </h1>
              <p className="text-gray-600 mb-4">
                {t("pendingSubtitle") ||
                  "Your booking request has been submitted. We'll respond within 24 hours."}
              </p>
              {booking?.hostResponseDeadline && (
                <div className="mb-6">
                  <p className="text-sm text-gray-500 mb-1">
                    {t("hostResponseIn") || "We'll respond latest:"}
                  </p>
                  <CountdownTimer deadline={booking.hostResponseDeadline} />
                </div>
              )}
            </>
          )}
          {isConfirmed && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">{t("title")}</h1>
              <p className="text-gray-600 mb-6">{t("subtitle")}</p>
            </>
          )}
          {isCancelled && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                {t("cancelledTitle") || "Booking Cancelled"}
              </h1>
              <p className="text-gray-600 mb-6">
                {booking?.paymentMethod === "card"
                  ? t("cancelledCardSubtitle") ||
                    "Your booking has been cancelled. Any authorization hold on your card has been released."
                  : t("cancelledSubtitle") || "Your booking has been cancelled."}
              </p>
            </>
          )}
          {isDeclined && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                {t("declinedTitle") || "Booking Request Declined"}
              </h1>
              <p className="text-gray-600 mb-6">
                {booking?.paymentMethod === "card"
                  ? t("declinedCardSubtitle") ||
                    "We declined your booking request. Any authorization hold on your card has been released."
                  : t("declinedSubtitle") ||
                    "We declined your booking request. We encourage you to explore alternative dates or properties."}
              </p>
            </>
          )}
          {isExpired && (
            <>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">
                {t("expiredTitle") || "Booking Request Expired"}
              </h1>
              <p className="text-gray-600 mb-6">
                {t("expiredSubtitle") ||
                  "Your booking request expired because we did not respond within 24 hours. Any card hold has been released."}
              </p>
            </>
          )}

          {/* Booking Reference */}
          <div className="bg-accent rounded-xl p-4 mb-8 inline-block">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
              {t("bookingReference")}
            </p>
            <p className="text-2xl font-bold text-primary-600 tracking-wider">{reference}</p>
          </div>

          {/* Booking Details */}
          {hydrating && !booking ? (
            <div className="py-8 text-center text-gray-500 text-sm">
              {t("loadingDetails") || "Loading booking details…"}
            </div>
          ) : !booking && hydrateError ? (
            <div className="py-6 text-center">
              <p className="text-sm text-gray-600 mb-3">
                {t("detailsUnavailable") || "We couldn't load your booking details here."}
              </p>
              <Link
                href={manageBookingHref}
                className="text-sm font-medium text-primary-600 hover:text-primary-700 underline"
              >
                {t("manageBooking") || "Manage your booking"}
              </Link>
            </div>
          ) : (
            <div className="text-left space-y-0 divide-y divide-gray-100">
              <div className="flex justify-between py-3">
                <span className="text-gray-600">{t("hotel")}</span>
                <span className="font-medium text-gray-900">
                  {booking?.hotelName || hotel.name}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600">{t("room")}</span>
                <span className="font-medium text-gray-900">
                  {booking
                    ? `${displayedRooms > 1 ? `${displayedRooms}× ` : ""}${booking.roomName || t("room")}`
                    : "—"}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600">{t("checkIn")}</span>
                <span className="font-medium text-gray-900">
                  {booking?.checkIn ? `${booking.checkIn}, ${hotel.checkInTime}` : "—"}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600">{t("checkOut")}</span>
                <span className="font-medium text-gray-900">
                  {booking?.checkOut ? `${booking.checkOut}, ${hotel.checkOutTime}` : "—"}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600">{t("duration")}</span>
                <span className="font-medium text-gray-900">
                  {displayedNights ? tc("nights", { count: displayedNights }) : "—"}
                </span>
              </div>
              <div className="flex justify-between py-3">
                <span className="text-gray-600">{t("guests")}</span>
                <span className="font-medium text-gray-900">
                  {displayedAdults !== null
                    ? `${tc("adults", { count: displayedAdults })}${displayedChildren > 0 ? `, ${tc("children", { count: displayedChildren })}` : ""}`
                    : "—"}
                </span>
              </div>
              {booking?.addonIds && booking.addonIds.length > 0 && (
                <div className="py-3">
                  <p className="text-gray-600 mb-2">{t("addons") || "Add-ons"}</p>
                  <div className="space-y-1.5">
                    {booking.addonIds.map((addonId, idx) => {
                      const qty = booking.addonQuantities?.[addonId];
                      const name = booking.addonNames?.[idx] || addonId;
                      return (
                        <div key={addonId} className="flex justify-between text-sm">
                          <span className="font-medium text-gray-900">{name}</span>
                          {qty && qty > 1 ? <span className="text-gray-500">× {qty}</span> : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="flex justify-between py-3">
                <span className="text-gray-600">
                  {booking?.depositRequired || !isTotalPaid ? tc("total") : t("totalPaid")}
                </span>
                <span className="font-bold text-gray-900 text-lg">
                  {booking ? formatPrice(booking.totalAmount, booking.currency) : "—"}
                </span>
              </div>
              {booking?.depositRequired && (
                <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">
                      {booking.paymentStatus === "captured"
                        ? "Deposit paid"
                        : booking.paymentStatus === "refunded"
                          ? "Deposit refunded"
                          : "Deposit pending"}
                    </span>
                    <span className="font-semibold text-gray-900">
                      {formatPrice(booking.depositAmount || 0, booking.currency)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Remaining balance due at check-in</span>
                    <span className="font-semibold text-gray-900">
                      {formatPrice(booking.balanceAmount || 0, booking.currency)}
                    </span>
                  </div>
                </div>
              )}
              {booking?.paymentMethod && (
                <div className="flex justify-between py-3">
                  <span className="text-gray-600">{t("paymentMethodLabel") || "Payment"}</span>
                  <span className="font-medium text-gray-900">
                    {booking.paymentMethod === "card"
                      ? booking.cardBrand && booking.cardLast4
                        ? `${displayCardBrand(booking.cardBrand)} •••• ${booking.cardLast4}`
                        : tp("payWithCard")
                      : isPayAtProperty
                        ? tp("payAtProperty")
                        : booking.paymentMethod === "paypal"
                          ? tp("paypalLabel")
                          : booking.paymentMethod === "bank_transfer"
                            ? tp("bankTransfer")
                            : booking.paymentMethod === "xendit"
                              ? tp("xenditTitle")
                              : booking.paymentMethod || "Other"}
                  </span>
                </div>
              )}
            </div>
          )}

          {isPending && booking?.paymentMethod === "paypal" && paypalInfo && (
            <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-xl text-left">
              <p className="text-sm font-semibold text-blue-900">PayPal payment pending</p>
              <p className="text-xs text-blue-700 mt-1">
                Send {formatPrice(booking.totalAmount, booking.currency)} to {paypalInfo.email} and
                include {booking.bookingReference} in the PayPal note so we can match it. Payment
                must be confirmed within {paypalInfo.windowHours} hours.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(paypalInfo.email)}
                  className="px-3 py-1.5 rounded-lg bg-white border border-blue-200 text-xs font-semibold text-blue-700"
                >
                  Copy email
                </button>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(booking.bookingReference)}
                  className="px-3 py-1.5 rounded-lg bg-white border border-blue-200 text-xs font-semibold text-blue-700"
                >
                  Copy booking reference
                </button>
              </div>
            </div>
          )}

          {/* Change request status (VAY-379) */}
          {changeRequest && changeRequest.status === "pending" && (
            <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-xl text-left">
              <p className="text-sm font-semibold text-blue-900">
                {t("changePending") || "Change request pending approval"}
              </p>
              <p className="text-xs text-blue-700 mt-1">
                {t("changePendingDesc") ||
                  "We'll review your requested change and email you once we respond."}
              </p>
              <p className="text-xs text-blue-700 mt-2">
                {changeRequest.requestedCheckIn} → {changeRequest.requestedCheckOut}
                {" · "}
                {changeRequest.priceDifference > 0
                  ? `+${formatPrice(changeRequest.priceDifference, changeRequest.currency)}`
                  : formatPrice(changeRequest.priceDifference, changeRequest.currency)}
              </p>
            </div>
          )}

          {/* Request Changes — only for confirmed bookings without a pending request. */}
          {isConfirmed &&
            (!changeRequest || changeRequest.status !== "pending") &&
            booking &&
            requestChangesHref && (
              <div className="mt-6">
                <Link
                  href={requestChangesHref}
                  className="inline-flex px-6 py-3 border border-primary-200 text-primary-700 font-semibold rounded-full hover:bg-primary-50 transition-colors"
                >
                  {t("requestChanges") || "Request Changes"}
                </Link>
              </div>
            )}

          {/* Withdraw button for pending bookings */}
          {isPending && (
            <div className="mt-8">
              {withdrawError && <p className="text-sm text-red-600 mb-3">{withdrawError}</p>}
              <button
                onClick={handleWithdraw}
                disabled={withdrawing}
                className="px-6 py-3 border border-red-300 text-red-600 font-semibold rounded-full hover:bg-red-50 transition-colors disabled:opacity-50"
              >
                {withdrawing
                  ? t("withdrawing") || "Withdrawing..."
                  : t("withdrawRequest") || "Withdraw Request"}
              </button>
            </div>
          )}

          {/* Actions */}
          <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/"
              className="px-6 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors"
            >
              {t("backToHotel", { property: hotel.name })}
            </Link>
            <Link
              href={manageBookingHref}
              className="px-6 py-3 border border-gray-300 text-gray-700 font-semibold rounded-full hover:bg-gray-50 transition-colors"
            >
              {t("manageBooking")}
            </Link>
          </div>
        </div>

        {/* Email notice */}
        <p className="text-center text-sm text-gray-500 mt-6">
          {guestEmail
            ? t("emailNotice", { email: guestEmail })
            : "A confirmation email has been sent to your email address."}
        </p>
      </div>

      <BookingFooter />
    </div>
  );
}
