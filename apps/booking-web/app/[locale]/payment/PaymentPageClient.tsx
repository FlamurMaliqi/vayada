"use client";

import { useState, useEffect, useRef, Suspense, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import Image from "next/image";
import { Booking } from "@/lib/types";
import BookingFooter from "@/components/layout/BookingFooter";
import HeroSection from "@/components/booking/HeroSection";
import StepIndicator from "@/components/booking/StepIndicator";
import StripeProvider from "@/components/StripeProvider";
import StripeConfirmStep from "@/components/payment/StripeConfirmStep";
import PolicyModal from "@/components/payment/PolicyModal";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { useHotel, useRooms, useAddons, useSlug } from "@/contexts/HotelContext";
import { formatDate } from "@/lib/utils";
import { useCurrency } from "@/contexts/CurrencyContext";
import {
  bookingService,
  type BookingCreateRequest,
  type BookingQuote,
} from "@/services/api/booking";
import { ApiError } from "@/services/api/client";
import { getFreeCancellationDays } from "@/lib/constants/booking";
import { usePricing } from "@/lib/hooks/usePricing";
import { useBookingSteps } from "@/lib/hooks/useBookingSteps";
import {
  clearPendingBookingCreate,
  expireCheckoutIdempotencyKeyAt,
  getCheckoutIdempotencyKey,
  GuestDetailsDraft,
  readGuestDetails,
  readPendingBookingCreate,
  saveLastBooking,
  savePendingBookingCreate,
  toConfirmationBooking,
} from "@/lib/storage/bookingDraft";

function PaymentPageContent() {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("payment");
  const tc = useTranslations("common");
  const ts = useTranslations("steps");
  const tb = useTranslations("book");
  const { hotel } = useHotel();
  const { refetchRooms } = useRooms();
  const { addons } = useAddons();
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency();
  const { slug } = useSlug();
  const searchParams = useSearchParams();

  const roomId = searchParams.get("room") || "";
  const checkIn = searchParams.get("checkIn") || "";
  const checkOut = searchParams.get("checkOut") || "";

  const adultsParam = parseInt(searchParams.get("adults") || "2");
  const childrenParam = parseInt(searchParams.get("children") || "0");

  useEffect(() => {
    if (checkIn && checkOut) refetchRooms(checkIn, checkOut, adultsParam, childrenParam);
  }, [adultsParam, checkIn, checkOut, childrenParam, refetchRooms]);
  const roomsParam = parseInt(searchParams.get("rooms") || "1");
  const { steps: STEPS, currentStep } = useBookingSteps("payment");

  const rateType = searchParams.get("rateType") || "flexible";
  const isNonRefundable = rateType === "nonrefundable";

  const [guestDetails, setGuestDetails] = useState<GuestDetailsDraft | null>(null);
  const selectedAddonIds = guestDetails?.addonIds || [];
  const addonQuantities = guestDetails?.addonQuantities || {};
  const addonDates = guestDetails?.addonDates || {};
  const promoCodeParam = searchParams.get("promoCode") || "";
  const selectedAddonIdsKey = selectedAddonIds.join(",");
  const addonQuantitiesKey = JSON.stringify(addonQuantities);
  const addonDatesKey = JSON.stringify(addonDates);

  const {
    room,
    nights,
    quoteReady,
    nightlyRate,
    rateLineItems,
    variableNightlyRates,
    roomTotal,
    promoDiscount,
    discountAmount,
    grandTotal,
  } = usePricing({
    roomId,
    checkIn,
    checkOut,
    rateType,
    roomsParam,
    adults: adultsParam,
    selectedAddonIds,
    addonQuantities,
    addonDates,
    promoCode: promoCodeParam,
  });
  const roomRateBreakdown = rateLineItems
    .map(
      (item) => `${formatPrice(item.nightlyRate * roomsParam, selectedCurrency)} × ${item.nights}`,
    )
    .join(" + ");
  const [paymentMethod, setPaymentMethod] = useState<
    "card" | "pay_at_property" | "xendit" | "bank_transfer" | "paypal"
  >("pay_at_property");
  const [payAtPropertyEnabled, setPayAtPropertyEnabled] = useState(false);
  const [onlineCardPayment, setOnlineCardPayment] = useState(false);
  const [xenditPaymentsEnabled, setXenditPaymentsEnabled] = useState(false);
  const [bankTransferEnabled, setBankTransferEnabled] = useState(false);
  const [paypalEnabled, setPaypalEnabled] = useState(false);
  const [paypalPaymentWindowHours, setPaypalPaymentWindowHours] = useState(24);
  const [payAtHotelMethods, setPayAtHotelMethods] = useState<string[]>(["cash", "card"]);
  const [termsText, setTermsText] = useState("");
  const [cancellationPolicyText, setCancellationPolicyText] = useState("");
  const [policyModal, setPolicyModal] = useState<null | "terms" | "cancellation">(null);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [checkoutQuote, setCheckoutQuote] = useState<BookingQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  // VAY-402: when the booking fails because the room is no longer available,
  // show a recovery CTA back to the room list instead of a dead-end error.
  const [soldOut, setSoldOut] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null);
  const [pendingBooking, setPendingBooking] = useState<Booking | null>(null);
  // VAY-388: draft id returned for card payments — passed to
  // confirmAuthorization once Stripe authorizes the card.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [pendingCreateRecovery, setPendingCreateRecovery] = useState<{
    quote: BookingQuote;
    quoteId: string;
    paymentMethod: "card" | "pay_at_property" | "xendit" | "bank_transfer" | "paypal";
    requestBody: BookingCreateRequest;
    createIdempotencyKey: string;
    draftId?: string;
    confirmationToken?: string;
  } | null>(null);
  const resumedCreateAttempt = useRef<string | null>(null);

  // Load guest details from the booking draft (set by /book on submit)
  useEffect(() => {
    const draft = readGuestDetails();
    if (draft) setGuestDetails(draft);
    else router.push("/book");
  }, [router]);

  useEffect(() => {
    if (!slug) return;
    const recovery = readPendingBookingCreate<BookingQuote, BookingCreateRequest>(slug);
    if (
      !recovery ||
      !["card", "pay_at_property", "xendit", "bank_transfer", "paypal"].includes(
        recovery.paymentMethod,
      )
    )
      return;
    setPaymentMethod(recovery.paymentMethod as typeof paymentMethod);
    setCheckoutQuote(recovery.quote);
    setPendingCreateRecovery(recovery as typeof pendingCreateRecovery);
  }, [slug]);

  // Per-rate allow-list from the room. When null, every hotel-enabled method is
  // offered (pre-Bug-2 behavior). When set, only methods in the list for the
  // selected rate are offered — replacing the old hardcoded !isNonRefundable gates.
  const rateAllowList: string[] | null =
    room?.ratePaymentMethods?.[rateType] && Array.isArray(room.ratePaymentMethods[rateType])
      ? room.ratePaymentMethods[rateType]
      : null;
  const depositSetting = room?.rateDepositSettings?.[rateType];
  const depositRequired = !!depositSetting?.enabled && !!depositSetting.percentage;
  const depositPercentage = depositSetting?.percentage ?? 0;
  const depositAmount = depositRequired
    ? Math.round(((grandTotal * depositPercentage) / 100) * 100) / 100
    : 0;
  const remainingBalance = depositRequired ? Math.max(grandTotal - depositAmount, 0) : grandTotal;
  const isMethodAllowedForRate = (method: string) =>
    depositRequired && method === "pay_at_property"
      ? false
      : rateAllowList === null
        ? true
        : rateAllowList.includes(method);

  // Check if pay-at-property is enabled
  useEffect(() => {
    if (slug) {
      bookingService.getPaymentSettings(slug).then((settings) => {
        setPayAtPropertyEnabled(settings.payAtPropertyEnabled);
        setOnlineCardPayment(settings.onlineCardPayment || false);
        setXenditPaymentsEnabled(settings.xenditPaymentsEnabled || false);
        setBankTransferEnabled(settings.bankTransfer || false);
        if (settings.payAtHotelMethods) setPayAtHotelMethods(settings.payAtHotelMethods);
        setTermsText(settings.termsText || "");
        setCancellationPolicyText(settings.cancellationPolicyText || "");
        // Default to first available payment method, honoring the rate-level
        // allow-list if one is set on this room.
        setPaypalEnabled(!!settings.paypalEnabled);
        setPaypalPaymentWindowHours(settings.paypalPaymentWindowHours || 24);
        const preference: ("card" | "pay_at_property" | "paypal" | "bank_transfer" | "xendit")[] = [
          "card",
          "pay_at_property",
          "paypal",
          "bank_transfer",
          "xendit",
        ];
        const hotelEnabled: Record<string, boolean> = {
          card: !!settings.onlineCardPayment,
          pay_at_property: !!settings.payAtPropertyEnabled && !depositRequired,
          paypal: !!settings.paypalEnabled,
          bank_transfer: !!settings.bankTransfer,
          xendit: !!settings.xenditPaymentsEnabled,
        };
        for (const m of preference) {
          if (hotelEnabled[m] && isMethodAllowedForRate(m)) {
            setPaymentMethod(m);
            break;
          }
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, rateType, room?.id]);

  useEffect(() => {
    if (pendingCreateRecovery) {
      setCheckoutQuote(pendingCreateRecovery.quote);
      setQuoteLoading(false);
      setQuoteError("");
      return;
    }
    if (!guestDetails || !room || !slug || !quoteReady) {
      setCheckoutQuote(null);
      return;
    }

    let cancelled = false;
    const quoteIdentity = [
      slug,
      room.id,
      checkIn,
      checkOut,
      adultsParam,
      childrenParam,
      roomsParam,
      paymentMethod,
      rateType,
      selectedAddonIdsKey,
      addonQuantitiesKey,
      addonDatesKey,
      promoCodeParam,
    ].join("|");
    const quoteIdempotencyKey = getCheckoutIdempotencyKey("quote", quoteIdentity);
    setQuoteLoading(true);
    setQuoteError("");

    bookingService
      .quote(
        slug,
        {
          ...guestDetails,
          checkIn,
          checkOut,
          adults: adultsParam,
          children: childrenParam,
          numberOfRooms: roomsParam,
          paymentMethod,
          rateType,
          addonIds: selectedAddonIds,
          addonQuantities,
          addonDates,
          promoCode: promoCodeParam || undefined,
        },
        quoteIdempotencyKey,
      )
      .then((quote) => {
        expireCheckoutIdempotencyKeyAt("quote", quoteIdentity, quote.expiresAt);
        if (!cancelled) setCheckoutQuote(quote);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCheckoutQuote(null);
        setQuoteError(err instanceof Error ? err.message : t("errorGeneric"));
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // selectedAddonIdsKey/addonQuantitiesKey/addonDatesKey are stable identity
    // proxies for the selected add-on inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    slug,
    guestDetails,
    room?.id,
    checkIn,
    checkOut,
    adultsParam,
    childrenParam,
    roomsParam,
    paymentMethod,
    rateType,
    selectedAddonIdsKey,
    addonQuantitiesKey,
    addonDatesKey,
    promoCodeParam,
    quoteReady,
    pendingCreateRecovery,
  ]);

  const quotedCurrency = checkoutQuote?.currency || selectedCurrency;
  const quotedRoomTotal = checkoutQuote?.roomTotal ?? roomTotal;
  const quotedNightlyRate = checkoutQuote?.nightlyRate ?? nightlyRate;
  const quotedPromoDiscount = checkoutQuote?.promoDiscount ?? discountAmount;
  const quotedGrandTotal = checkoutQuote?.totalAmount ?? grandTotal;
  const quotedDepositRequired = checkoutQuote?.depositRequired ?? depositRequired;
  const quotedDepositPercentage = checkoutQuote?.depositPercentage ?? depositPercentage ?? 0;
  const quotedDepositAmount = checkoutQuote?.depositAmount ?? depositAmount;
  const quotedRemainingBalance = checkoutQuote?.balanceAmount ?? remainingBalance;

  const submitBooking = async (recovery = pendingCreateRecovery) => {
    if (!guestDetails || (!recovery && !room)) return;
    if (!recovery && !agreedToTerms) {
      setError(t("termsRequired"));
      return;
    }
    const quote = recovery?.quote ?? checkoutQuote;
    const selectedPaymentMethod = recovery?.paymentMethod ?? paymentMethod;
    if ((!recovery && (!quoteReady || quoteLoading)) || !quote) {
      setError(tc("pricingUpdating"));
      return;
    }

    setSubmitting(true);
    setError("");
    setSoldOut(false);

    const createIdempotencyKey =
      recovery?.createIdempotencyKey ??
      getCheckoutIdempotencyKey("create", quote.quoteId ?? "missing-quote");
    const requestBody: BookingCreateRequest = recovery?.requestBody ?? {
      ...guestDetails,
      checkIn,
      checkOut,
      adults: adultsParam,
      children: childrenParam,
      numberOfRooms: roomsParam,
      paymentMethod: selectedPaymentMethod,
      rateType,
      addonIds: selectedAddonIds,
      addonQuantities,
      addonDates,
      promoCode: promoCodeParam || undefined,
      quoteId: quote.quoteId,
      expectedTotalAmount: quote.totalAmount,
      balanceAmount: quote.balanceAmount,
    };
    const pendingAttempt = quote.quoteId
      ? {
          slug,
          quote,
          quoteId: quote.quoteId,
          paymentMethod: selectedPaymentMethod,
          requestBody,
          createIdempotencyKey,
          draftId: recovery?.draftId,
        }
      : null;
    if (pendingAttempt) savePendingBookingCreate(pendingAttempt);

    try {
      const result = await bookingService.create(slug, requestBody, createIdempotencyKey);

      if (selectedPaymentMethod === "card" && result.authorizationExpired) {
        clearPendingBookingCreate();
        setPendingCreateRecovery(null);
        resumedCreateAttempt.current = null;
        setCheckoutQuote(null);
        setSubmitting(false);
        setError(t("paymentExpiredRetry"));
        return;
      }

      const booking = toConfirmationBooking(result.booking, {
        hotelName: hotel.name,
        roomName: quote.roomName,
        guestFirstName: requestBody.guestFirstName,
        guestLastName: requestBody.guestLastName,
        guestEmail: requestBody.guestEmail,
        checkIn: requestBody.checkIn,
        checkOut: requestBody.checkOut,
        adults: requestBody.adults,
        children: requestBody.children,
        numberOfRooms: requestBody.numberOfRooms,
        nightlyRate: quote.nightlyRate,
        totalAmount: quote.totalAmount,
        depositRequired: quote.depositRequired,
        depositPercentage: quote.depositPercentage ?? 0,
        depositAmount: quote.depositAmount,
        balanceAmount: quote.balanceAmount,
        addonTotal: quote.addonTotal,
        addonIds: requestBody.addonIds,
        addonNames: (requestBody.addonIds ?? []).map(
          (addonId) => addons.find((addon) => addon.id === addonId)?.name || addonId,
        ),
        addonQuantities: requestBody.addonQuantities,
        addonDates: requestBody.addonDates,
        currency: quote.currency,
        paymentMethod: selectedPaymentMethod,
      });

      if (selectedPaymentMethod === "card" && result.authorizationComplete) {
        clearPendingBookingCreate();
        saveLastBooking(booking);
        const confirmationParams = new URLSearchParams({ booking: booking.bookingReference });
        if (result.confirmationToken) {
          confirmationParams.set("token", result.confirmationToken);
        }
        router.push(`/confirmation?${confirmationParams}`);
      } else if (selectedPaymentMethod === "card" && result.clientSecret) {
        // VAY-388: `booking` is a draft preview here, not a persisted row.
        // We hold the draftId so StripeConfirmStep can materialize the
        // booking after Stripe authorizes the card.
        if (quote.quoteId) {
          const cardAttempt = {
            slug,
            quote,
            quoteId: quote.quoteId,
            paymentMethod: selectedPaymentMethod,
            requestBody,
            createIdempotencyKey,
            draftId: result.draftId || recovery?.draftId,
            confirmationToken: result.confirmationToken || recovery?.confirmationToken,
          };
          savePendingBookingCreate(cardAttempt);
          setPendingCreateRecovery(cardAttempt);
        }
        setPendingBooking(booking);
        setClientSecret(result.clientSecret);
        setStripeAccountId(result.stripeAccountId || null);
        setDraftId(result.draftId || null);
      } else if (selectedPaymentMethod === "xendit" && result.xenditInvoiceUrl) {
        // Redirect to Xendit payment page (QRIS, e-wallets, VA)
        clearPendingBookingCreate();
        saveLastBooking(booking);
        window.location.href = result.xenditInvoiceUrl;
      } else {
        // Pay at property — redirect to confirmation
        clearPendingBookingCreate();
        saveLastBooking(booking);
        router.push(`/booking/${booking.bookingReference}`);
      }
    } catch (err: any) {
      const blob =
        err instanceof ApiError
          ? `${err.message ?? ""} ${typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail ?? "")}`.toLowerCase()
          : "";
      const ambiguousReplayFailure = /idempoten|in[_ -]?progress|already (?:used|processing)/.test(
        blob,
      );
      if (
        err instanceof ApiError &&
        err.status >= 400 &&
        err.status < 500 &&
        !ambiguousReplayFailure
      ) {
        clearPendingBookingCreate();
        setPendingCreateRecovery(null);
        resumedCreateAttempt.current = null;
      } else if (pendingAttempt) {
        setPendingCreateRecovery(pendingAttempt);
        resumedCreateAttempt.current = createIdempotencyKey;
      }
      // VAY-402: never show the raw "API error: POST 422". Classify the
      // failure and map it to friendly, localized copy.
      const availabilityGone =
        err instanceof ApiError &&
        !ambiguousReplayFailure &&
        (err.status === 409 ||
          ([400, 409, 422].includes(err.status) &&
            /not enough rooms|no longer available|not available|sold ?out|availab/.test(blob)));

      if (ambiguousReplayFailure) {
        setError(t("recoveryInProgress"));
      } else if (blob.includes("same-day bookings are no longer available")) {
        setSoldOut(true);
        setError(t("errorSameDaySoldOut"));
      } else if (availabilityGone) {
        setSoldOut(true);
        setError(t("errorSoldOut"));
      } else if (
        err instanceof ApiError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 422 &&
        err.detail &&
        typeof err.detail === "object" &&
        typeof (err.detail as any).detail === "string"
      ) {
        // Backend raised a specific, human-readable client error (e.g.
        // "Pay at property is not enabled for this hotel"). Still friendlier
        // than a status code — surface it as-is.
        setError((err.detail as any).detail as string);
      } else {
        setError(t("errorGeneric"));
      }
      setSubmitting(false);
    }
  };

  const handleSubmit = () => {
    void submitBooking();
  };

  useEffect(() => {
    if (!pendingCreateRecovery || !guestDetails || resumedCreateAttempt.current) return;
    resumedCreateAttempt.current = pendingCreateRecovery.createIdempotencyKey;
    void submitBooking(pendingCreateRecovery);
    // Recovery deliberately replays the original quote and create command,
    // even after the quote's display expiry, so a committed booking or settled
    // card payment cannot be duplicated by a new checkout attempt after reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCreateRecovery, guestDetails]);

  if (!guestDetails || (!room && !pendingCreateRecovery)) {
    return <div className="min-h-screen bg-gray-50" />;
  }

  if (pendingCreateRecovery && !room && !clientSecret) {
    if (submitting) return <div className="min-h-screen bg-gray-50" aria-busy="true" />;
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 text-center">
          <p className="text-sm text-gray-700">{error || t("errorGeneric")}</p>
          <button
            type="button"
            onClick={() => void submitBooking(pendingCreateRecovery)}
            className="mt-4 rounded-full bg-primary-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-primary-700"
          >
            {t("recoveryRetry")}
          </button>
        </div>
      </div>
    );
  }

  // If we have a client secret, render the Stripe payment form
  if (clientSecret && pendingBooking) {
    const paymentRequest = pendingCreateRecovery?.requestBody;
    const paymentQuote = pendingCreateRecovery?.quote ?? checkoutQuote;
    const paymentCheckIn = paymentRequest?.checkIn ?? checkIn;
    const paymentCheckOut = paymentRequest?.checkOut ?? checkOut;
    const paymentNights = Math.max(
      1,
      Math.round(
        (new Date(`${paymentCheckOut}T00:00:00.000Z`).getTime() -
          new Date(`${paymentCheckIn}T00:00:00.000Z`).getTime()) /
          86_400_000,
      ),
    );
    const paymentRooms = paymentRequest?.numberOfRooms ?? roomsParam;
    const paymentCurrency = paymentQuote?.currency ?? quotedCurrency;
    const paymentNightlyRate = paymentQuote?.nightlyRate ?? quotedNightlyRate;
    const paymentRoomTotal = paymentQuote?.roomTotal ?? quotedRoomTotal;
    const paymentGrandTotal = paymentQuote?.totalAmount ?? quotedGrandTotal;
    const paymentDepositRequired = paymentQuote?.depositRequired ?? quotedDepositRequired;
    const paymentDepositPercentage = paymentQuote?.depositPercentage ?? quotedDepositPercentage;
    const paymentDepositAmount = paymentQuote?.depositAmount ?? quotedDepositAmount;
    const paymentBalance = paymentQuote?.balanceAmount ?? quotedRemainingBalance;
    return (
      <StripeProvider clientSecret={clientSecret} stripeAccountId={stripeAccountId}>
        <StripeConfirmStep
          hotel={hotel}
          roomName={paymentQuote?.roomName ?? room?.name ?? ""}
          checkIn={paymentCheckIn}
          checkOut={paymentCheckOut}
          nights={paymentNights}
          adults={paymentRequest?.adults ?? adultsParam}
          roomTotal={paymentRoomTotal}
          roomRateBreakdown={`${formatPrice(paymentNightlyRate * paymentRooms, paymentCurrency)} × ${paymentNights}`}
          addons={addons}
          selectedAddonIds={paymentRequest?.addonIds ?? selectedAddonIds}
          addonQuantities={paymentRequest?.addonQuantities ?? addonQuantities}
          addonDates={paymentRequest?.addonDates ?? addonDates}
          grandTotal={paymentGrandTotal}
          booking={pendingBooking}
          draftId={draftId}
          confirmationToken={pendingCreateRecovery?.confirmationToken}
          slug={slug}
          formatPrice={formatPrice}
          formatDate={formatDate}
          locale={locale}
          roomsParam={paymentRooms}
          selectedCurrency={paymentCurrency}
          convertAndRound={convertAndRound}
          depositRequired={paymentDepositRequired}
          depositPercentage={paymentDepositPercentage || 0}
          depositAmount={paymentDepositAmount}
          remainingBalance={paymentBalance}
        />
      </StripeProvider>
    );
  }

  if (!room) return <div className="min-h-screen bg-gray-50" />;

  return (
    <div className="min-h-screen bg-gray-50">
      <HeroSection
        heroImage={hotel.heroImage}
        hotelName={hotel.name}
        description={hotel.description}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        {/* Header + Step Indicator */}
        <div className="flex flex-col md:flex-row md:items-center justify-between mb-10 gap-4">
          <h2 className="text-3xl font-heading text-gray-900">{t("securePayment")}</h2>
          <StepIndicator steps={STEPS} currentStep={currentStep} />
        </div>

        {/* Guest confirmation banner */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="text-base font-bold text-gray-900">
              {guestDetails.guestFirstName} {guestDetails.guestLastName}
            </p>
            <p className="text-sm text-gray-500">{guestDetails.guestEmail}</p>
          </div>
          <div className="flex items-center gap-1.5 text-sm text-primary-600 font-medium">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
            {t("detailsConfirmed")}
          </div>
        </div>

        {(error || quoteError) && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <p>{error || quoteError}</p>
            {soldOut && (
              <button
                type="button"
                onClick={() =>
                  router.push(
                    `/?checkIn=${encodeURIComponent(checkIn)}&checkOut=${encodeURIComponent(checkOut)}&adults=${adultsParam}&children=${childrenParam}`,
                  )
                }
                className="mt-3 inline-flex items-center px-4 py-2 bg-primary-600 text-white text-sm font-semibold rounded-lg hover:bg-primary-700 transition-colors"
              >
                {t("chooseAnotherRoom")}
              </button>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Payment Method Selection */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="flex items-center gap-2.5 mb-6">
                <svg
                  className="w-5 h-5 text-gray-700"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                  />
                </svg>
                <h3 className="text-lg font-bold text-gray-900">{t("paymentDetails")}</h3>
              </div>

              {/* Payment method tabs */}
              <div className="space-y-3 mb-6">
                {onlineCardPayment && isMethodAllowedForRate("card") && (
                  <button
                    onClick={() => setPaymentMethod("card")}
                    className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                      paymentMethod === "card"
                        ? "border-primary-600 bg-primary-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${paymentMethod === "card" ? "border-primary-600" : "border-gray-300"}`}
                      >
                        {paymentMethod === "card" && (
                          <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <svg
                            className="w-5 h-5 text-gray-700"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                            />
                          </svg>
                          <span className="font-semibold text-sm text-gray-900">
                            {t("payWithCard") || "Credit / Debit Card"}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 ml-7">
                          {t("cardAuthNote") ||
                            "Secure payment via Stripe. Your card will be charged now."}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <span className="text-[10px] font-medium text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">
                          Visa
                        </span>
                        <span className="text-[10px] font-medium text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">
                          Mastercard
                        </span>
                      </div>
                    </div>
                  </button>
                )}
                {xenditPaymentsEnabled && isMethodAllowedForRate("xendit") && (
                  <button
                    onClick={() => setPaymentMethod("xendit")}
                    className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                      paymentMethod === "xendit"
                        ? "border-primary-600 bg-primary-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${paymentMethod === "xendit" ? "border-primary-600" : "border-gray-300"}`}
                      >
                        {paymentMethod === "xendit" && (
                          <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <svg
                            className="w-5 h-5 text-gray-700"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                            />
                          </svg>
                          <span className="font-semibold text-sm text-gray-900">
                            {t("xenditTitle")}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 ml-7">{t("xenditNote")}</p>
                      </div>
                    </div>
                  </button>
                )}
                {payAtPropertyEnabled && isMethodAllowedForRate("pay_at_property") && (
                  <button
                    onClick={() => setPaymentMethod("pay_at_property")}
                    className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                      paymentMethod === "pay_at_property"
                        ? "border-primary-600 bg-primary-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${paymentMethod === "pay_at_property" ? "border-primary-600" : "border-gray-300"}`}
                      >
                        {paymentMethod === "pay_at_property" && (
                          <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <svg
                            className="w-5 h-5 text-gray-700"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
                            />
                          </svg>
                          <span className="font-semibold text-sm text-gray-900">
                            {t("payAtProperty") || "Pay at Property"}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 ml-7">
                          {payAtHotelMethods.length === 1 && payAtHotelMethods[0] === "cash"
                            ? t("payAtPropertyCashOnly") ||
                              "Pay with cash at check-in — no online payment needed"
                            : payAtHotelMethods.length === 1 && payAtHotelMethods[0] === "card"
                              ? t("payAtPropertyCardOnly") ||
                                "Pay with card at check-in — no online payment needed"
                              : t("payAtPropertyNote") ||
                                "Pay at check-in — cash & card accepted, no online payment needed"}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
                {bankTransferEnabled && isMethodAllowedForRate("bank_transfer") && (
                  <button
                    onClick={() => setPaymentMethod("bank_transfer")}
                    className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                      paymentMethod === "bank_transfer"
                        ? "border-primary-600 bg-primary-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${paymentMethod === "bank_transfer" ? "border-primary-600" : "border-gray-300"}`}
                      >
                        {paymentMethod === "bank_transfer" && (
                          <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <svg
                            className="w-5 h-5 text-gray-700"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M3 6l9-4 9 4M3 6v12l9 4 9-4V6M3 6l9 4 9-4M12 10v10"
                            />
                          </svg>
                          <span className="font-semibold text-sm text-gray-900">
                            {t("bankTransfer") || "Bank Transfer"}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 ml-7">
                          {t("bankTransferNote") || "Transfer directly to our bank account"}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
                {paypalEnabled && isMethodAllowedForRate("paypal") && (
                  <button
                    onClick={() => setPaymentMethod("paypal")}
                    className={`w-full p-4 rounded-xl border-2 transition-colors text-left ${
                      paymentMethod === "paypal"
                        ? "border-primary-600 bg-primary-50"
                        : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${paymentMethod === "paypal" ? "border-primary-600" : "border-gray-300"}`}
                      >
                        {paymentMethod === "paypal" && (
                          <div className="w-2.5 h-2.5 rounded-full bg-primary-600" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <svg
                            className="w-5 h-5 text-gray-700"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 6v12m-4-8h5a3 3 0 010 6H8V6h6a2 2 0 010 4H8"
                            />
                          </svg>
                          <span className="font-semibold text-sm text-gray-900">
                            {t("paypalLabel")}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 ml-7">{t("paypalHelper")}</p>
                      </div>
                    </div>
                  </button>
                )}
              </div>

              {/* Hint when the rate restricts some hotel-enabled methods */}
              {rateAllowList !== null &&
                ((payAtPropertyEnabled && !isMethodAllowedForRate("pay_at_property")) ||
                  (bankTransferEnabled && !isMethodAllowedForRate("bank_transfer"))) && (
                  <p className="text-xs text-gray-400 mb-4">
                    {t("ratePaymentHint") ||
                      "Some payment methods are not available for this rate."}
                  </p>
                )}

              {quotedDepositRequired && (
                <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-2">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="font-semibold text-emerald-900">
                      Deposit due now: {quotedDepositPercentage}%
                    </span>
                    <span className="font-bold text-emerald-900">
                      {formatPrice(quotedDepositAmount, quotedCurrency)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-emerald-700">
                      Remaining balance due at the property upon arrival
                    </span>
                    <span className="font-semibold text-emerald-900">
                      {formatPrice(quotedRemainingBalance, quotedCurrency)}
                    </span>
                  </div>
                </div>
              )}

              {/* Payment method info */}
              {paymentMethod === "card" ? (
                <div className="space-y-3">
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700">
                    {quotedDepositRequired
                      ? `You will be charged ${formatPrice(quotedDepositAmount, quotedCurrency)} now. The remaining ${formatPrice(quotedRemainingBalance, quotedCurrency)} is due at the property.`
                      : t("cardAuthExplanation") ||
                        `Your card will be charged ${formatPrice(quotedGrandTotal, quotedCurrency)} now to confirm the booking.`}
                  </div>
                  <div className="flex items-center gap-2 p-3 bg-accent rounded-xl text-sm text-gray-600">
                    <svg
                      className="w-4 h-4 text-gray-400 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                      />
                    </svg>
                    {t("cardNextStep") || "You will enter your card details in the next step."}
                  </div>
                </div>
              ) : paymentMethod === "xendit" ? (
                <div className="space-y-3">
                  <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700">
                    {t("xenditExplanation")}
                  </div>
                </div>
              ) : paymentMethod === "bank_transfer" ? (
                <div className="space-y-3">
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700">
                    {quotedDepositRequired
                      ? t("bankTransferDepositExplanation", {
                          deposit: formatPrice(quotedDepositAmount, quotedCurrency),
                          remaining: formatPrice(quotedRemainingBalance, quotedCurrency),
                        }) ||
                        `Submit your booking request now. If we accept it, we'll email the bank transfer details for the ${formatPrice(quotedDepositAmount, quotedCurrency)} deposit. The remaining ${formatPrice(quotedRemainingBalance, quotedCurrency)} is due with us at check-in.`
                      : t("bankTransferExplanation") ||
                        "Submit your booking request now. If we accept it, we'll email the bank transfer details and payment deadline."}
                  </div>
                </div>
              ) : paymentMethod === "paypal" ? (
                <div className="space-y-3">
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl text-sm text-blue-700">
                    {t("paypalInstructions", { hours: paypalPaymentWindowHours })}
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
                  {hotel.instantBook
                    ? t("payAtPropertyExplanationInstant") ||
                      "No payment is required now. You will pay directly at the property upon check-in. Your booking will be confirmed instantly."
                    : t("payAtPropertyExplanation") ||
                      "No payment is required now. You will pay directly at the property upon check-in. We'll review your booking request."}
                </div>
              )}
            </div>

            {/* Terms Agreement */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <label className="flex items-start gap-3 cursor-pointer">
                <button
                  onClick={() => setAgreedToTerms(!agreedToTerms)}
                  className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors ${
                    agreedToTerms ? "bg-primary-600 border-primary-600" : "border-gray-300"
                  }`}
                >
                  {agreedToTerms && (
                    <svg
                      className="w-3 h-3 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </button>
                <span className="text-sm text-gray-700 leading-relaxed">
                  {(() => {
                    const renderTermsLink = (chunks: ReactNode) =>
                      termsText.trim() ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            setPolicyModal("terms");
                          }}
                          className="text-primary-600 underline font-medium hover:text-primary-700"
                        >
                          {chunks}
                        </button>
                      ) : (
                        chunks
                      );
                    const renderCancellationLink = (chunks: ReactNode) => (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setPolicyModal("cancellation");
                        }}
                        className="text-primary-600 underline font-medium hover:text-primary-700"
                      >
                        {chunks}
                      </button>
                    );
                    return paymentMethod === "card"
                      ? t.rich("agreeTerms", {
                          terms: renderTermsLink,
                          cancellation: renderCancellationLink,
                          amount: formatPrice(
                            quotedDepositRequired ? quotedDepositAmount : quotedGrandTotal,
                            quotedCurrency,
                          ),
                        })
                      : t.rich("agreeTermsProperty", {
                          terms: renderTermsLink,
                          cancellation: renderCancellationLink,
                        });
                  })()}
                </span>
              </label>
            </div>

            {/* Cancellation Policy */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h3 className="text-base font-bold text-gray-900 mb-2">
                {t("cancellationPolicyTitle")}
              </h3>
              <p className="text-sm text-gray-600">
                {t("cancellationPolicyDesc", {
                  date: formatDate(
                    new Date(
                      new Date(checkIn).getTime() -
                        getFreeCancellationDays(room?.cancellationPolicy) * 86400000,
                    )
                      .toISOString()
                      .slice(0, 10),
                    locale,
                  ),
                })}
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => {
                  const params = new URLSearchParams({
                    room: roomId,
                    checkIn,
                    checkOut,
                    adults: String(adultsParam),
                    children: String(childrenParam),
                    rooms: String(roomsParam),
                    rateType,
                  });
                  if (promoCodeParam) params.set("promoCode", promoCodeParam);
                  router.push(`/book?${params.toString()}`);
                }}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1 transition-colors border border-gray-300 rounded-full px-5 py-2.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
                {t("backToDetails")}
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !quoteReady || quoteLoading || !checkoutQuote}
                className={`px-8 py-3 font-semibold rounded-full transition-colors text-sm flex items-center gap-2 ${
                  !submitting && quoteReady && !quoteLoading && checkoutQuote
                    ? "bg-primary-600 text-white hover:bg-primary-700"
                    : "bg-gray-200 text-gray-400 cursor-not-allowed"
                }`}
              >
                {submitting || quoteLoading ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                    {quoteLoading ? tc("pricingUpdating") : t("processing") || "Processing..."}
                  </>
                ) : paymentMethod === "card" ? (
                  <>
                    {t("continueToPayment") || "Continue to Payment"}
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </>
                ) : hotel.instantBook ? (
                  t("confirmBooking") || "Confirm Booking"
                ) : (
                  t("submitRequest") || "Submit Booking Request"
                )}
              </button>
            </div>
          </div>

          {/* Right Sidebar — Order Summary */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl border border-gray-200 p-6 sticky top-8">
              <h3 className="text-lg font-bold text-gray-900 mb-5">{t("orderSummary")}</h3>

              {/* Room info */}
              <div className="flex items-center gap-3 pb-5 border-b border-gray-100">
                <div className="relative w-14 h-14 rounded-xl overflow-hidden flex-shrink-0">
                  <Image
                    src={room.images[0]}
                    alt={room.name}
                    fill
                    className="object-cover"
                    sizes={bookingImageSizes.orderRoomThumb}
                  />
                </div>
                <div>
                  <p className="text-sm font-bold text-gray-900">
                    {roomsParam > 1 ? `${roomsParam}× ` : ""}
                    {room.name}
                  </p>
                  <p className="text-xs text-gray-500">
                    {isNonRefundable ? tb("nonRefundableRate") : tb("flexibleRate")}
                  </p>
                </div>
              </div>

              {/* Stay details */}
              <div className="space-y-3 py-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{tb("checkIn")}</span>
                  <span className="font-semibold text-gray-900 text-right">
                    {formatDate(checkIn, locale)}
                    {hotel.checkInTime && (
                      <span className="block text-xs font-normal text-gray-500">
                        {tc("checkInFrom", { time: hotel.checkInTime })}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{tb("checkOut")}</span>
                  <span className="font-semibold text-gray-900 text-right">
                    {formatDate(checkOut, locale)}
                    {hotel.checkOutTime && (
                      <span className="block text-xs font-normal text-gray-500">
                        {tc("checkOutBy", { time: hotel.checkOutTime })}
                      </span>
                    )}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{tb("duration")}</span>
                  <span className="font-semibold text-gray-900">
                    {tc("nights", { count: nights })}
                  </span>
                </div>
              </div>

              {/* Price breakdown */}
              <div className="space-y-3 py-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">
                    {ts("rooms")} ({tc("nights", { count: nights })})
                  </span>
                  <span className="font-semibold text-gray-900">
                    {formatPrice(quotedRoomTotal, quotedCurrency)}
                  </span>
                </div>
                <p className="text-xs text-gray-500 text-right">
                  {checkoutQuote
                    ? `${formatPrice(quotedNightlyRate * roomsParam, quotedCurrency)} × ${nights}`
                    : variableNightlyRates
                      ? roomRateBreakdown
                      : `${formatPrice(nightlyRate * roomsParam, selectedCurrency)} × ${nights}`}
                </p>
                {addons
                  .filter((a) => selectedAddonIds.includes(a.id))
                  .map((addon) => {
                    const count = addonQuantities[addon.id];
                    const dates = addonDates[addon.id];
                    const people = addon.perPerson
                      ? Math.max(
                          1,
                          Math.min(count ?? Math.max(1, adultsParam), Math.max(1, adultsParam)),
                        )
                      : 1;
                    const days = addon.perNight
                      ? Math.max(1, Math.min(dates?.length ?? count ?? nights, nights))
                      : 1;
                    const items = !addon.perPerson && !addon.perNight ? Math.max(1, count ?? 1) : 1;
                    const linePrice = convertAndRound(
                      addon.price * people * days * items,
                      addon.currency,
                    );
                    const parts: string[] = [];
                    if (addon.perPerson && people < adultsParam)
                      parts.push(`${people}/${adultsParam}`);
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
              </div>

              {/* Promo Discount */}
              {promoDiscount && (
                <div className="flex justify-between text-sm pt-2">
                  <span className="text-primary-600 font-medium">
                    Promo {promoCodeParam}
                    {promoDiscount.type === "percentage" ? ` (-${promoDiscount.value}%)` : ""}
                  </span>
                  <span className="font-semibold text-primary-600">
                    -{formatPrice(quotedPromoDiscount, quotedCurrency)}
                  </span>
                </div>
              )}

              {/* Total */}
              <div className="pt-5">
                <div className="flex justify-between items-start">
                  <span className="text-base font-bold text-gray-900">{tc("total")}</span>
                  <div className="text-right">
                    <p className="text-xl font-bold text-gray-900">
                      {formatPrice(quotedGrandTotal, quotedCurrency)}
                    </p>
                    <p className="text-xs text-gray-500">{tc("includesTaxes")}</p>
                  </div>
                </div>
                {quotedDepositRequired && (
                  <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">Due now</span>
                      <span className="font-semibold text-gray-900">
                        {formatPrice(quotedDepositAmount, quotedCurrency)}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">Due at arrival</span>
                      <span className="font-semibold text-gray-900">
                        {formatPrice(quotedRemainingBalance, quotedCurrency)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <BookingFooter />

      <PolicyModal
        kind={policyModal}
        onClose={() => setPolicyModal(null)}
        termsText={termsText}
        cancellationPolicyText={cancellationPolicyText}
        cancellationFallback={t("cancellationPolicyDesc", {
          date: formatDate(
            new Date(
              new Date(checkIn).getTime() -
                getFreeCancellationDays(room?.cancellationPolicy) * 86400000,
            )
              .toISOString()
              .slice(0, 10),
            locale,
          ),
        })}
      />
    </div>
  );
}

export default function PaymentPageClient() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <PaymentPageContent />
    </Suspense>
  );
}
