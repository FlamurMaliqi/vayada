"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { NationalitySelect } from "@vayada/locale-ui/NationalitySelect";
import { useRouter } from "@/i18n/navigation";
import Image from "next/image";
import BookingFooter from "@/components/layout/BookingFooter";
import HeroSection from "@/components/booking/HeroSection";
import StepIndicator from "@/components/booking/StepIndicator";
import CountryDialCodePicker from "@/components/booking/CountryDialCodePicker";
import { bookingImageSizes } from "@/components/booking/imageSizes";
import { useHotel, useRooms, useAddons, useSlug } from "@/contexts/HotelContext";
import { bookingService } from "@/services/api/booking";
import { formatDate, ensureMinOneNight } from "@/lib/utils";
import { useCurrency } from "@/contexts/CurrencyContext";
import { COUNTRY_DIAL_CODES, findDialCodeByCountryName } from "@/lib/constants/countryDialCodes";
import { trackEvent } from "@/services/api/tracking";
import { usePricing } from "@/lib/hooks/usePricing";
import { useBookingSteps } from "@/lib/hooks/useBookingSteps";
import { saveGuestDetails } from "@/lib/storage/bookingDraft";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function FieldError({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-center gap-1 text-xs text-red-600">
      <svg
        className="w-3.5 h-3.5 flex-shrink-0"
        fill="currentColor"
        viewBox="0 0 20 20"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"
          clipRule="evenodd"
        />
      </svg>
      {message}
    </p>
  );
}

const ARRIVAL_TIMES = Array.from({ length: 24 }, (_, i) => {
  const h = i.toString().padStart(2, "0");
  return `${h}:00`;
});

function BookPageContent() {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("book");
  const tc = useTranslations("common");
  const { hotel } = useHotel();
  const { refetchRooms } = useRooms();
  const { addons } = useAddons();
  const { formatPrice, convertAndRound, selectedCurrency } = useCurrency();
  const { slug } = useSlug();
  const searchParams = useSearchParams();
  const roomId = searchParams.get("room") || "";

  // Defensively coerce a same-day or invalid URL range to a valid one-night
  // window before anything downstream computes nights / pricing.
  const { checkIn, checkOut } = ensureMinOneNight(
    searchParams.get("checkIn") || "2026-02-13",
    searchParams.get("checkOut") || "2026-02-18",
  );

  // Ensure rooms have date-resolved rates (in case of direct navigation)
  useEffect(() => {
    const a = parseInt(searchParams.get("adults") || "2");
    const c = parseInt(searchParams.get("children") || "0");
    if (checkIn && checkOut) refetchRooms(checkIn, checkOut, a, c);
  }, []);
  const adultsParam = parseInt(searchParams.get("adults") || "2");
  const childrenParam = parseInt(searchParams.get("children") || "0");
  const roomsParam = parseInt(searchParams.get("rooms") || "1");
  const rateType = searchParams.get("rateType") || "flexible";

  const { steps: STEPS, currentStep } = useBookingSteps("details");

  const addonEntries = (searchParams.get("addons") || "").split(",").filter(Boolean);
  const selectedAddonIds: string[] = [];
  const addonQuantities: Record<string, number> = {};
  for (const entry of addonEntries) {
    const [id, qtyStr] = entry.split(":");
    selectedAddonIds.push(id);
    if (qtyStr) addonQuantities[id] = parseInt(qtyStr);
  }
  const addonPackageQuantities: Record<string, number> = {};
  for (const entry of (searchParams.get("addonPackages") || "").split(",").filter(Boolean)) {
    const [id, quantity] = entry.split(":");
    if (selectedAddonIds.includes(id)) addonPackageQuantities[id] = Number(quantity);
  }
  const addonDates: Record<string, string[]> = {};
  for (const entry of (searchParams.get("addonDates") || "").split(",").filter(Boolean)) {
    const [id, datesStr] = entry.split(":");
    if (id && datesStr) addonDates[id] = datesStr.split("|").filter(Boolean);
  }
  const promoCodeParam = searchParams.get("promoCode") || "";

  const {
    room,
    nights,
    quoteReady,
    nightlyRate,
    rateLineItems,
    variableNightlyRates,
    roomTotal,
    promoDiscount,
    promotion,
    promoError,
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
    addonPackageQuantities,
    addonDates,
    promoCode: promoCodeParam,
  });
  const roomRateBreakdown = rateLineItems
    .map(
      (item) => `${formatPrice(item.nightlyRate * roomsParam, selectedCurrency)} × ${item.nights}`,
    )
    .join(" + ");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [phoneCountryIso, setPhoneCountryIso] = useState(
    () => findDialCodeByCountryName(hotel?.country)?.iso2 ?? "",
  );
  const [country, setCountry] = useState("");
  const [specialRequests, setSpecialRequests] = useState("");
  const [estimatedArrivalTime, setEstimatedArrivalTime] = useState("");
  const [numberOfGuests, setNumberOfGuests] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  }>({});

  const firstNameRef = useRef<HTMLInputElement>(null);
  const lastNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  const [guestFormSettings, setGuestFormSettings] = useState<{
    specialRequestsEnabled: boolean;
    arrivalTimeEnabled: boolean;
    guestCountEnabled: boolean;
    phoneRequired: boolean;
  }>({
    specialRequestsEnabled: true,
    arrivalTimeEnabled: false,
    guestCountEnabled: false,
    phoneRequired: true,
  });

  useEffect(() => {
    if (!slug) return;
    bookingService.getPaymentSettings(slug).then((settings) => {
      setGuestFormSettings({
        specialRequestsEnabled: settings.specialRequestsEnabled ?? true,
        arrivalTimeEnabled: settings.arrivalTimeEnabled ?? false,
        guestCountEnabled: settings.guestCountEnabled ?? false,
        phoneRequired: settings.phoneRequired ?? true,
      });
    });
  }, [slug]);

  const validateFields = () => {
    const errors: typeof fieldErrors = {};
    if (!firstName.trim()) errors.firstName = t("errorRequired");
    if (!lastName.trim()) errors.lastName = t("errorRequired");
    if (!email.trim()) errors.email = t("errorRequired");
    else if (!EMAIL_RE.test(email)) errors.email = t("errorInvalidEmail");
    if (guestFormSettings.phoneRequired && !phone.trim()) errors.phone = t("errorRequired");
    return errors;
  };

  const handleBlur = (field: keyof typeof fieldErrors) => {
    const errors = validateFields();
    setFieldErrors((prev) => ({ ...prev, [field]: errors[field] }));
  };

  const handleSubmit = async () => {
    const errors = validateFields();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      if (errors.firstName && firstNameRef.current) {
        firstNameRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
        firstNameRef.current.focus();
      } else if (errors.lastName && lastNameRef.current) {
        lastNameRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
        lastNameRef.current.focus();
      } else if (errors.email && emailRef.current) {
        emailRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
        emailRef.current.focus();
      } else if (errors.phone && phoneRef.current) {
        phoneRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
        phoneRef.current.querySelector("input")?.focus();
      }
      return;
    }
    if (!room) {
      setSubmitError("No room selected");
      return;
    }
    if (!quoteReady) {
      setSubmitError(tc("pricingUpdating"));
      return;
    }

    setSubmitting(true);
    setSubmitError("");

    try {
      // Read referral cookie if present
      const refCookie = document.cookie.match(/(^| )ref=([^;]+)/);
      const referralCode = refCookie ? decodeURIComponent(refCookie[2]) : undefined;

      // Strip national trunk prefix (leading 0) before prepending the dial code.
      const dialEntry = COUNTRY_DIAL_CODES.find((c) => c.iso2 === phoneCountryIso);
      const localPart = phone.replace(/[^0-9]/g, "").replace(/^0+/, "");
      const composedPhone = phone.trim()
        ? dialEntry
          ? `+${dialEntry.dial} ${localPart}`
          : phone
        : "";

      saveGuestDetails({
        roomTypeId: room.id,
        guestFirstName: firstName,
        guestLastName: lastName,
        guestEmail: email,
        guestPhone: composedPhone,
        guestCountry: country,
        specialRequests: guestFormSettings.specialRequestsEnabled ? specialRequests : undefined,
        estimatedArrivalTime:
          guestFormSettings.arrivalTimeEnabled && estimatedArrivalTime
            ? estimatedArrivalTime
            : undefined,
        numberOfGuests:
          guestFormSettings.guestCountEnabled && numberOfGuests
            ? parseInt(numberOfGuests)
            : undefined,
        referralCode,
        addonIds: selectedAddonIds,
        addonQuantities,
        addonPackageQuantities,
        addonDates,
      });

      // Redirect to payment page with booking params
      const params = new URLSearchParams({
        room: room.id,
        checkIn,
        checkOut,
        adults: String(adultsParam),
        children: String(childrenParam),
        rooms: String(roomsParam),
        rateType,
      });
      if (promoCodeParam) params.set("promoCode", promoCodeParam);
      trackEvent(slug, "details_completed");
      router.push(`/payment?${params.toString()}`);
    } catch (err: any) {
      setSubmitError(err.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  if (!room) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500">No room selected. Please go back and select a room.</p>
      </div>
    );
  }

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
          <h2 className="text-3xl font-heading text-gray-900">{t("guestInformation")}</h2>

          <StepIndicator steps={STEPS} currentStep={currentStep} />
        </div>

        {submitError && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            {submitError}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Booking Summary Card */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h3 className="text-lg font-bold text-gray-900 mb-5">{t("bookingSummary")}</h3>

              {/* Room row */}
              <div className="flex items-start gap-4 pb-5 border-b border-gray-100">
                <div className="relative w-16 h-16 rounded-xl overflow-hidden flex-shrink-0">
                  <Image
                    src={room.images[0]}
                    alt={room.name}
                    fill
                    className="object-cover"
                    sizes={bookingImageSizes.checkoutRoomThumb}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-gray-900">
                    {roomsParam > 1 ? `${roomsParam}× ` : ""}
                    {room.name}
                  </p>
                  <p className="text-sm text-gray-500">
                    {formatDate(checkIn, locale)} - {formatDate(checkOut, locale)} &middot;{" "}
                    {tc("nights", { count: nights })}
                  </p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-bold text-gray-900">
                    {formatPrice(roomTotal, selectedCurrency)}
                  </p>
                  <p className="text-xs text-gray-500">
                    {variableNightlyRates
                      ? roomRateBreakdown
                      : `${formatPrice(nightlyRate * roomsParam, selectedCurrency)} × ${nights}`}
                  </p>
                </div>
              </div>

              {/* Selected Addons */}
              {selectedAddonIds.length > 0 && (
                <div className="pb-5 border-b border-gray-100">
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
                        ? Math.max(1, Math.min(dates?.length ?? (addon.perPerson ? nights : count ?? nights), nights))
                        : 1;
                      const items =
                        !addon.perPerson && !addon.perNight ? Math.max(1, count ?? 1) : 1;
                      const linePrice = convertAndRound(
                        addon.price *
                          people *
                          days *
                          items *
                          (addonPackageQuantities[addon.id] ?? 1),
                        addon.currency,
                      );
                      const parts: string[] = [];
                      if ((addonPackageQuantities[addon.id] ?? 1) > 1)
                        parts.push(`×${addonPackageQuantities[addon.id]}`);
                      if (addon.perPerson && people < adultsParam)
                        parts.push(`${people}/${adultsParam} ${tc("guests").toLowerCase()}`);
                      if (addon.perNight && days < nights)
                        parts.push(`${days}/${nights} ${tc("days", { count: nights })}`);
                      if (!addon.perPerson && !addon.perNight && items > 1) parts.push(`×${items}`);
                      const annotation = parts.length ? ` (${parts.join(" · ")})` : "";
                      return (
                        <div key={addon.id} className="flex items-center justify-between pt-3">
                          <p className="text-sm text-gray-700">
                            {addon.name}
                            {annotation}
                          </p>
                          <p className="text-sm font-semibold text-gray-900">
                            {formatPrice(linePrice, selectedCurrency)}
                          </p>
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Promo Discount */}
              {promoError && promoCodeParam && (
                <p role="alert" className="border-b border-red-100 py-3 text-sm text-red-600">
                  {promoError}
                </p>
              )}
              {promotion && (
                <div className="flex justify-between pt-2 text-sm text-primary-600">
                  <span>{promotion.name}</span>
                  <span>-{formatPrice(promotion.discountAmount, selectedCurrency)}</span>
                </div>
              )}
              {promoDiscount && (
                <div className="flex items-center justify-between pt-3 pb-3 border-b border-gray-100">
                  <p className="text-sm text-primary-600 font-medium">
                    Promo {promoCodeParam}:{" "}
                    {promoDiscount.type === "percentage"
                      ? `-${promoDiscount.value}%`
                      : `-${formatPrice(discountAmount, selectedCurrency)}`}
                  </p>
                  {promoDiscount.type === "percentage" && (
                    <p className="text-sm font-semibold text-primary-600">
                      -{formatPrice(discountAmount, selectedCurrency)}
                    </p>
                  )}
                </div>
              )}

              {/* Total */}
              <div className="flex items-center justify-between pt-4">
                <p className="text-base font-bold text-gray-900">{tc("total")}</p>
                <div className="text-right">
                  <p className="text-xl font-bold text-gray-900">
                    {formatPrice(grandTotal, selectedCurrency)}
                  </p>
                  <p className="text-xs text-gray-500">{tc("includesTaxes")}</p>
                </div>
              </div>
            </div>

            {/* Guest Form Card */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <p className="text-gray-600 mb-6">{t("pleaseProvide")}</p>

              <div className="space-y-5">
                {/* First + Last Name */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="firstName"
                      className="block text-sm font-semibold text-gray-900 mb-1.5"
                    >
                      {t("firstName")} <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="firstName"
                      ref={firstNameRef}
                      type="text"
                      value={firstName}
                      onChange={(e) => {
                        setFirstName(e.target.value);
                        if (fieldErrors.firstName && e.target.value.trim())
                          setFieldErrors((prev) => ({ ...prev, firstName: undefined }));
                      }}
                      onBlur={() => handleBlur("firstName")}
                      placeholder="John"
                      aria-invalid={!!fieldErrors.firstName}
                      aria-describedby={fieldErrors.firstName ? "firstName-error" : undefined}
                      className={`w-full px-4 py-3 rounded-lg border ${fieldErrors.firstName ? "border-red-400 focus:ring-red-500 focus:border-red-500" : "border-gray-300 focus:ring-primary-500 focus:border-primary-500"} text-gray-900 focus:outline-none focus:ring-2 placeholder:text-gray-400`}
                    />
                    {fieldErrors.firstName && (
                      <FieldError id="firstName-error" message={fieldErrors.firstName} />
                    )}
                  </div>
                  <div>
                    <label
                      htmlFor="lastName"
                      className="block text-sm font-semibold text-gray-900 mb-1.5"
                    >
                      {t("lastName")} <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="lastName"
                      ref={lastNameRef}
                      type="text"
                      value={lastName}
                      onChange={(e) => {
                        setLastName(e.target.value);
                        if (fieldErrors.lastName && e.target.value.trim())
                          setFieldErrors((prev) => ({ ...prev, lastName: undefined }));
                      }}
                      onBlur={() => handleBlur("lastName")}
                      placeholder="Doe"
                      aria-invalid={!!fieldErrors.lastName}
                      aria-describedby={fieldErrors.lastName ? "lastName-error" : undefined}
                      className={`w-full px-4 py-3 rounded-lg border ${fieldErrors.lastName ? "border-red-400 focus:ring-red-500 focus:border-red-500" : "border-gray-300 focus:ring-primary-500 focus:border-primary-500"} text-gray-900 focus:outline-none focus:ring-2 placeholder:text-gray-400`}
                    />
                    {fieldErrors.lastName && (
                      <FieldError id="lastName-error" message={fieldErrors.lastName} />
                    )}
                  </div>
                </div>

                {/* Email */}
                <div>
                  <label
                    htmlFor="email"
                    className="block text-sm font-semibold text-gray-900 mb-1.5"
                  >
                    {t("emailAddress")} <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="email"
                    ref={emailRef}
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (
                        fieldErrors.email &&
                        e.target.value.trim() &&
                        EMAIL_RE.test(e.target.value)
                      )
                        setFieldErrors((prev) => ({ ...prev, email: undefined }));
                    }}
                    onBlur={() => handleBlur("email")}
                    placeholder="john.doe@example.com"
                    aria-invalid={!!fieldErrors.email}
                    aria-describedby={fieldErrors.email ? "email-error" : undefined}
                    className={`w-full px-4 py-3 rounded-lg border ${fieldErrors.email ? "border-red-400 focus:ring-red-500 focus:border-red-500" : "border-gray-300 focus:ring-primary-500 focus:border-primary-500"} text-gray-900 focus:outline-none focus:ring-2 placeholder:text-gray-400`}
                  />
                  {fieldErrors.email && <FieldError id="email-error" message={fieldErrors.email} />}
                </div>

                {/* Phone + Country */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="phone"
                      className="block text-sm font-semibold text-gray-900 mb-1.5"
                    >
                      {t("phoneNumber")}{" "}
                      {guestFormSettings.phoneRequired ? (
                        <span className="text-red-500">*</span>
                      ) : (
                        <span className="font-normal text-gray-500">{t("optional")}</span>
                      )}
                    </label>
                    <div
                      ref={phoneRef}
                      className={`flex rounded-lg border ${fieldErrors.phone ? "border-red-400 focus-within:ring-red-500 focus-within:border-red-500" : "border-gray-300 focus-within:ring-primary-500 focus-within:border-primary-500"} focus-within:ring-2`}
                    >
                      <CountryDialCodePicker
                        value={phoneCountryIso}
                        onChange={setPhoneCountryIso}
                      />
                      <input
                        id="phone"
                        type="tel"
                        value={phone}
                        onChange={(e) => {
                          setPhone(e.target.value);
                          if (fieldErrors.phone && e.target.value.trim())
                            setFieldErrors((prev) => ({ ...prev, phone: undefined }));
                        }}
                        onBlur={() => handleBlur("phone")}
                        required={guestFormSettings.phoneRequired}
                        placeholder={t("phoneLocalPlaceholder")}
                        aria-invalid={!!fieldErrors.phone}
                        aria-describedby={fieldErrors.phone ? "phone-error" : undefined}
                        className="flex-1 min-w-0 px-4 py-3 text-gray-900 focus:outline-none placeholder:text-gray-400"
                      />
                    </div>
                    {fieldErrors.phone && (
                      <FieldError id="phone-error" message={fieldErrors.phone} />
                    )}
                  </div>
                  <NationalitySelect
                    label={t("country")}
                    value={country}
                    onChange={setCountry}
                    placeholder={t("selectCountry")}
                    labelClassName="mb-1.5 block text-sm font-semibold text-gray-900"
                    inputClassName="w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>

                {/* Estimated Arrival Time */}
                {guestFormSettings.arrivalTimeEnabled && (
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      {t("estimatedArrival")}
                    </label>
                    <select
                      value={estimatedArrivalTime}
                      onChange={(e) => setEstimatedArrivalTime(e.target.value)}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20fill%3D%22none%22%20viewBox%3D%220%200%2020%2020%22%3E%3Cpath%20stroke%3D%22%236b7280%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20stroke-width%3D%221.5%22%20d%3D%22m6%208%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:1.25rem] bg-[right_0.75rem_center] bg-no-repeat"
                    >
                      <option value="">{t("selectArrival")}</option>
                      {ARRIVAL_TIMES.map((time) => (
                        <option key={time} value={time}>
                          {time}
                        </option>
                      ))}
                      <option value="unknown">{t("iDontKnow")}</option>
                    </select>
                  </div>
                )}

                {/* Number of Guests */}
                {guestFormSettings.guestCountEnabled && (
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      {t("numberOfGuests")}
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={numberOfGuests}
                      onChange={(e) => setNumberOfGuests(e.target.value)}
                      placeholder="2"
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400"
                    />
                  </div>
                )}

                {/* Special Requests */}
                {guestFormSettings.specialRequestsEnabled && (
                  <div>
                    <label className="block text-sm font-semibold text-gray-900 mb-1.5">
                      {t("specialRequests")}
                    </label>
                    <textarea
                      rows={4}
                      value={specialRequests}
                      onChange={(e) => setSpecialRequests(e.target.value)}
                      placeholder={t("specialRequestsPlaceholder")}
                      className="w-full px-4 py-3 rounded-lg border border-gray-300 text-gray-900 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 placeholder:text-gray-400 resize-y"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Bottom Action Bar */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => {
                  const params = new URLSearchParams();
                  if (checkIn) params.set("checkIn", checkIn);
                  if (checkOut) params.set("checkOut", checkOut);
                  params.set("adults", String(adultsParam));
                  if (childrenParam > 0) params.set("children", String(childrenParam));
                  const qs = params.toString();
                  router.push(qs ? `/?${qs}` : "/");
                }}
                className="text-sm font-medium text-gray-600 hover:text-gray-900 flex items-center gap-1 transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 19l-7-7 7-7"
                  />
                </svg>
                {t("backToRooms") || "Back to rooms"}
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || !quoteReady}
                className="px-8 py-3 bg-primary-600 text-white font-semibold rounded-full hover:bg-primary-700 transition-colors text-sm disabled:opacity-50"
              >
                {submitting
                  ? t("booking") || "Processing..."
                  : t("continueToPayment") || "Continue to Payment"}
              </button>
            </div>
          </div>

          {/* Right Sidebar — Your Stay */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl border border-gray-200 p-6 sticky top-8">
              <h3 className="text-lg font-bold text-gray-900 mb-5">{t("yourStay")}</h3>

              {/* Stay details */}
              <div className="space-y-3 pb-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t("roomLabel")}</span>
                  <span className="font-semibold text-gray-900 text-right">{room.name}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t("checkIn")}</span>
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
                  <span className="text-gray-500">{t("checkOut")}</span>
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
                  <span className="text-gray-500">{t("duration")}</span>
                  <span className="font-semibold text-gray-900">
                    {tc("nights", { count: nights })}
                  </span>
                </div>
              </div>

              {/* Price breakdown */}
              <div className="space-y-3 py-5 border-b border-gray-100">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">
                    {t("roomLabel")} ({tc("nights", { count: nights })})
                  </span>
                  <span className="font-semibold text-gray-900">
                    {formatPrice(roomTotal, selectedCurrency)}
                  </span>
                </div>
                <p className="text-xs text-gray-500 text-right">
                  {variableNightlyRates
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
                      ? Math.max(1, Math.min(dates?.length ?? (addon.perPerson ? nights : count ?? nights), nights))
                      : 1;
                    const items = !addon.perPerson && !addon.perNight ? Math.max(1, count ?? 1) : 1;
                    const linePrice = convertAndRound(
                      addon.price * people * days * items * (addonPackageQuantities[addon.id] ?? 1),
                      addon.currency,
                    );
                    const parts: string[] = [];
                    if ((addonPackageQuantities[addon.id] ?? 1) > 1)
                      parts.push(`×${addonPackageQuantities[addon.id]}`);
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
              {promoError && promoCodeParam && (
                <p role="alert" className="pt-2 text-sm text-red-600">
                  {promoError}
                </p>
              )}
              {promotion && (
                <div className="flex justify-between pt-2 text-sm text-primary-600">
                  <span>{promotion.name}</span>
                  <span>-{formatPrice(promotion.discountAmount, selectedCurrency)}</span>
                </div>
              )}
              {promoDiscount && (
                <div className="flex justify-between text-sm pt-2">
                  <span className="text-primary-600 font-medium">
                    Promo {promoCodeParam}:{" "}
                    {promoDiscount.type === "percentage"
                      ? `-${promoDiscount.value}%`
                      : `-${formatPrice(discountAmount, selectedCurrency)}`}
                  </span>
                  {promoDiscount.type === "percentage" && (
                    <span className="font-semibold text-primary-600">
                      -{formatPrice(discountAmount, selectedCurrency)}
                    </span>
                  )}
                </div>
              )}

              {/* Total */}
              <div className="pt-5">
                <div className="flex justify-between items-start">
                  <span className="text-base font-bold text-gray-900">{tc("total")}</span>
                  <div className="text-right">
                    <p className="text-xl font-bold text-gray-900">
                      {formatPrice(grandTotal, selectedCurrency)}
                    </p>
                    <p className="text-xs text-gray-500">{tc("includesTaxes")}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <BookingFooter />
    </div>
  );
}

export default function BookPageClient() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <BookPageContent />
    </Suspense>
  );
}
