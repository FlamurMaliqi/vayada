"use client";

import { useState, useEffect } from "react";
import { CheckIcon, ArrowLeftIcon } from "@heroicons/react/24/outline";
import { inviteCodesService, type InviteCode, type InviteData } from "@/services/api/inviteCodes";
import { uploadSingleImage, uploadImages } from "@/lib/utils/uploadImage";
import { COLOR_PRESETS, FONT_PAIRINGS } from "@/lib/constants/branding";
import { TrashIcon, ClipboardIcon, PlusIcon } from "@heroicons/react/24/outline";

import {
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  POPULAR_CURRENCY_CODES,
  POPULAR_LANGUAGE_CODES,
} from "@/lib/constants/options";
import {
  AddonsStep,
  BenefitsStep,
  BrandMediaStep,
  LastMinuteStep,
  PoliciesStep,
  PropertyStep,
  RoomsStep,
  useSetupWizardState,
  type LastMinuteConfig,
  type RoomTab,
  type RoomType,
  type SetupAddon,
} from "@vayada/product-onboarding";

const GOOGLE_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Sans+Pro:wght@300;400;600;700&family=Inter:wght@300;400;500;600;700&family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400&family=Lato:wght@300;400;700&family=Italiana&display=swap";

const STEPS = [
  { number: 1, label: "Property" },
  { number: 2, label: "Brand & Media" },
  { number: 3, label: "Rooms & Rates" },
  { number: 4, label: "Add-ons" },
  { number: 5, label: "Benefits" },
  { number: 6, label: "Last-Minute" },
  { number: 7, label: "Policies" },
  { number: 8, label: "Payment Terms" },
];

export default function InviteCodesPage() {
  const [view, setView] = useState<"list" | "create">("list");
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // ── Create form state ──

  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);

  // Internal: vayada payment terms (not shown to hotel during setup)
  const [activePlan, setActivePlan] = useState<"commission" | "fixed">("commission");
  const [commissionRate, setCommissionRate] = useState("5");
  const [fixedMonthlyFee, setFixedMonthlyFee] = useState("49");

  const {
    propertyName,
    setPropertyName,
    city,
    setCity,
    country,
    setCountry,
    address,
    setAddress,
    reservationEmail,
    setReservationEmail,
    phoneNumber,
    setPhoneNumber,
    whatsapp,
    setWhatsapp,
    instagram,
    setInstagram,
    facebook,
    setFacebook,
    tiktok,
    setTiktok,
    youtube,
    setYoutube,
    currency,
    setCurrency,
    defaultLanguage,
    setDefaultLanguage,
    supportedCurrencies,
    setSupportedCurrencies,
    supportedLanguages,
    setSupportedLanguages,
    heroImage,
    setHeroImage,
    primaryColor,
    setPrimaryColor,
    accentColor,
    setAccentColor,
    selectedFont,
    setSelectedFont,
    propertyDescription,
    setPropertyDescription,
    bookingFilters,
    setBookingFilters,
    fileInputRef,
    uploading,
    handleImageUpload,
    rooms,
    setRooms,
    activeRoomIndex,
    setActiveRoomIndex,
    activeRoomTab,
    setActiveRoomTab,
    amenityInput,
    setAmenityInput,
    featureInput,
    setFeatureInput,
    roomFileInputRef,
    uploadingRoomImages,
    handleRoomImageUpload,
    setupAddons,
    setSetupAddons,
    benefits,
    setBenefits,
    lastMinuteConfig,
    setLastMinuteConfig,
    checkInFrom,
    setCheckInFrom,
    checkInUntil,
    setCheckInUntil,
    checkOutFrom,
    setCheckOutFrom,
    checkOutUntil,
    setCheckOutUntil,
    payAtHotel,
    setPayAtHotel,
    payAtHotelMethods,
    setPayAtHotelMethods,
    onlineCardPayment,
    setOnlineCardPayment,
    bankTransfer,
    setBankTransfer,
    payoutAccountHolder,
    setPayoutAccountHolder,
    payoutAccountType,
    setPayoutAccountType,
    payoutIban,
    setPayoutIban,
    payoutAccountNumber,
    setPayoutAccountNumber,
    payoutBankName,
    setPayoutBankName,
    payoutSwift,
    setPayoutSwift,
    specialRequests,
    setSpecialRequests,
    estimatedArrivalTime,
    setEstimatedArrivalTime,
    numberOfGuests,
    setNumberOfGuests,
    enableReferAGuest,
    setEnableReferAGuest,
    paymentProvider,
    setPaymentProvider,
    xenditChannelCode,
    setXenditChannelCode,
    xenditAccountNumber,
    setXenditAccountNumber,
    xenditAccountHolderName,
    setXenditAccountHolderName,
    reset,
  } = useSetupWizardState({
    uploadSingleImage,
    uploadImages,
    defaultCurrency: "EUR",
    defaultCheckInFrom: "15:00",
    defaultEnableReferAGuest: true,
    syncAddonCurrency: false,
  });

  useEffect(() => {
    loadInvites();
  }, []);

  // Auto-set payment provider based on country
  useEffect(() => {
    setPaymentProvider(country === "ID" ? "xendit" : "stripe");
  }, [country]);

  const loadInvites = async () => {
    try {
      setInvites(await inviteCodesService.list());
    } catch {
      /* */
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (code: string, id: string) => {
    navigator.clipboard.writeText(code);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this invite code?")) return;
    await inviteCodesService.delete(id);
    setInvites((prev) => prev.filter((i) => i.id !== id));
  };

  const canProceed = (): boolean => {
    if (step === 1) return !!(propertyName.trim() && city.trim() && country);
    if (step === 2) return !!(primaryColor && accentColor && selectedFont);
    if (step === 3)
      return rooms.every(
        (r) => !!r.name.trim() && r.seasons.some((s) => s.rate && Number(s.rate) > 0),
      );
    return true;
  };

  const handleGenerate = async () => {
    try {
      setSaving(true);
      const data: InviteData = {
        property: {
          property_name: propertyName,
          city,
          country,
          address,
          reservation_email: reservationEmail,
          phone_number: phoneNumber,
          whatsapp_number: whatsapp,
          instagram,
          facebook,
          tiktok,
          youtube,
          default_currency: currency,
          default_language: defaultLanguage,
          supported_currencies: supportedCurrencies,
          supported_languages: supportedLanguages,
        },
        branding: {
          hero_image: heroImage.startsWith("blob:") ? "" : heroImage,
          primary_color: primaryColor,
          accent_color: accentColor,
          font_pairing: selectedFont,
          description: propertyDescription,
          booking_filters: bookingFilters,
        },
        rooms: rooms.map((r) => ({
          ...r,
          baseRate: r.baseRate,
          nonRefundableRate: r.nonRefundableRate,
        })),
        addons: setupAddons.map((a) => ({
          name: a.name,
          description: a.description,
          price: a.price,
          currency: a.currency,
          category: a.category,
          image: a.image.startsWith("blob:") ? "" : a.image,
          duration: a.duration || undefined,
          perPerson: a.perPerson,
          perNight: a.perNight,
        })),
        internal: {
          active_plan: activePlan,
          commission_rate: parseFloat(commissionRate) || 0,
          fixed_monthly_fee: parseFloat(fixedMonthlyFee) || 0,
          payment_provider: paymentProvider,
          ...(paymentProvider === "xendit"
            ? {
                xendit_channel_code: xenditChannelCode,
                xendit_account_number: xenditAccountNumber,
                xendit_account_holder_name: xenditAccountHolderName,
              }
            : {}),
        },
        benefits,
        policies: {
          check_in_time: checkInFrom,
          check_out_time: checkOutUntil,
          check_in_from: checkInFrom,
          check_in_until: checkInUntil,
          check_out_from: checkOutFrom,
          check_out_until: checkOutUntil,
          pay_at_property: payAtHotel,
          pay_at_hotel_methods: payAtHotelMethods,
          online_card_payment: onlineCardPayment,
          bank_transfer: bankTransfer,
          payout_account_holder: payoutAccountHolder,
          payout_account_type: payoutAccountType,
          payout_iban: payoutIban,
          payout_account_number: payoutAccountNumber,
          payout_bank_name: payoutBankName,
          payout_swift: payoutSwift,
          special_requests: specialRequests,
          arrival_time: estimatedArrivalTime,
          guest_count: numberOfGuests,
          refer_a_guest: enableReferAGuest,
        },
        last_minute_discount: lastMinuteConfig,
      };
      const result = await inviteCodesService.create(data);
      setGeneratedCode(result.code);
      loadInvites();
    } catch {
      alert("Failed to create invite code");
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    reset();
    setStep(1);
    setActivePlan("commission");
    setCommissionRate("5");
    setFixedMonthlyFee("49");
    setGeneratedCode(null);
    setView("list");
  };

  // ── Create View ──

  if (view === "create") {
    if (generatedCode) {
      return (
        <div className="p-6 flex items-center justify-center min-h-[80vh]">
          <div className="bg-white rounded-xl border border-gray-200 p-8 max-w-md w-full text-center">
            <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckIcon className="w-7 h-7 text-green-600" />
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-1">Invite Code Created</h2>
            <p className="text-sm text-gray-500 mb-6">Share this code with the hotel owner</p>
            <div className="bg-gray-50 rounded-lg border border-gray-200 p-4 mb-6">
              <p className="text-3xl font-mono font-bold text-gray-900 tracking-widest">
                {generatedCode}
              </p>
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(generatedCode)}
              className="w-full mb-3 py-2.5 bg-primary-500 text-white text-sm font-semibold rounded-lg hover:bg-primary-600 transition-colors"
            >
              Copy Code
            </button>
            <button
              onClick={resetForm}
              className="w-full py-2.5 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Back to List
            </button>
          </div>
        </div>
      );
    }

    const stepIndicators = (
      <div className="flex items-center justify-center mb-8">
        {STEPS.map((s, idx) => (
          <div key={s.number} className="flex items-center">
            <div className="flex items-center gap-1.5 shrink-0">
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold transition-colors shrink-0 ${
                  step > s.number
                    ? "bg-primary-500 text-white"
                    : step === s.number
                      ? "bg-primary-500 text-white"
                      : "bg-gray-200 text-gray-500"
                }`}
              >
                {step > s.number ? <CheckIcon className="w-3.5 h-3.5" /> : s.number}
              </div>
              <span
                className={`text-[12px] font-medium whitespace-nowrap ${step >= s.number ? "text-gray-900" : "text-gray-400"}`}
              >
                {s.label}
              </span>
            </div>
            {idx < STEPS.length - 1 && (
              <div
                className={`w-12 h-px mx-3 shrink-0 ${step > s.number ? "bg-primary-500" : "bg-gray-300"}`}
              />
            )}
          </div>
        ))}
      </div>
    );

    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        {}
        <link rel="stylesheet" href={GOOGLE_FONTS_URL} />

        {/* Top bar */}
        <div className="bg-white border-b border-gray-200 px-8 py-3 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <button
                onClick={resetForm}
                className="p-1 text-gray-400 hover:text-gray-600 rounded-md"
              >
                <ArrowLeftIcon className="w-5 h-5" />
              </button>
              <span className="font-semibold text-gray-900 text-[15px]">Create Invite</span>
            </div>
            <span className="text-[13px] text-gray-500">
              Step {step} of {STEPS.length}
            </span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="h-[3px] bg-gray-100 shrink-0">
          <div
            className="h-full bg-primary-600 transition-all duration-300"
            style={{ width: `${(step / STEPS.length) * 100}%` }}
          />
        </div>

        {step === 1 && (
          <PropertyStep
            propertyName={propertyName}
            setPropertyName={setPropertyName}
            city={city}
            setCity={setCity}
            country={country}
            setCountry={setCountry}
            address={address}
            setAddress={setAddress}
            reservationEmail={reservationEmail}
            setReservationEmail={setReservationEmail}
            phoneNumber={phoneNumber}
            setPhoneNumber={setPhoneNumber}
            whatsapp={whatsapp}
            setWhatsapp={setWhatsapp}
            instagram={instagram}
            setInstagram={setInstagram}
            facebook={facebook}
            setFacebook={setFacebook}
            tiktok={tiktok}
            setTiktok={setTiktok}
            youtube={youtube}
            setYoutube={setYoutube}
            currency={currency}
            setCurrency={setCurrency}
            defaultLanguage={defaultLanguage}
            setDefaultLanguage={setDefaultLanguage}
            supportedCurrencies={supportedCurrencies}
            setSupportedCurrencies={setSupportedCurrencies}
            supportedLanguages={supportedLanguages}
            setSupportedLanguages={setSupportedLanguages}
            stepIndicators={stepIndicators}
            prefilled={false}
            error=""
            canProceed={canProceed()}
            onContinue={() => setStep(2)}
            countryOptions={COUNTRY_OPTIONS}
            currencyOptions={CURRENCY_OPTIONS}
            languageOptions={LANGUAGE_OPTIONS}
            popularCurrencyCodes={POPULAR_CURRENCY_CODES}
            popularLanguageCodes={POPULAR_LANGUAGE_CODES}
          />
        )}

        {step === 2 && (
          <BrandMediaStep
            heroImage={heroImage}
            setHeroImage={setHeroImage}
            primaryColor={primaryColor}
            setPrimaryColor={setPrimaryColor}
            accentColor={accentColor}
            setAccentColor={setAccentColor}
            selectedFont={selectedFont}
            setSelectedFont={setSelectedFont}
            propertyDescription={propertyDescription}
            setPropertyDescription={setPropertyDescription}
            fileInputRef={fileInputRef}
            handleImageUpload={handleImageUpload}
            uploading={uploading}
            propertyName={propertyName}
            currency={currency}
            defaultLanguage={defaultLanguage}
            stepIndicators={stepIndicators}
            error=""
            canProceed={canProceed()}
            onBack={() => setStep(1)}
            onContinue={() => setStep(3)}
            colorPresets={COLOR_PRESETS}
            fontPairings={FONT_PAIRINGS}
          />
        )}

        {step === 3 && (
          <RoomsStep
            rooms={rooms}
            setRooms={setRooms}
            activeRoomIndex={activeRoomIndex}
            setActiveRoomIndex={setActiveRoomIndex}
            activeRoomTab={activeRoomTab}
            setActiveRoomTab={setActiveRoomTab}
            amenityInput={amenityInput}
            setAmenityInput={setAmenityInput}
            featureInput={featureInput}
            setFeatureInput={setFeatureInput}
            roomFileInputRef={roomFileInputRef}
            handleRoomImageUpload={handleRoomImageUpload}
            uploadingRoomImages={uploadingRoomImages}
            currency={currency}
            stepIndicators={stepIndicators}
            error=""
            canProceed={canProceed()}
            onBack={() => setStep(2)}
            onContinue={() => setStep(4)}
          />
        )}

        {step === 4 && (
          <AddonsStep
            addons={setupAddons}
            setAddons={setSetupAddons}
            currency={currency}
            error=""
            canProceed={true}
            onBack={() => setStep(3)}
            onContinue={() => setStep(5)}
            stepIndicators={stepIndicators}
            uploadImage={uploadSingleImage}
          />
        )}

        {step === 5 && (
          <BenefitsStep
            benefits={benefits}
            setBenefits={setBenefits}
            error=""
            canProceed={canProceed()}
            onBack={() => setStep(4)}
            onContinue={() => setStep(6)}
            stepIndicators={stepIndicators}
          />
        )}

        {step === 6 && (
          <LastMinuteStep
            config={lastMinuteConfig}
            setConfig={setLastMinuteConfig}
            error=""
            canProceed={true}
            onBack={() => setStep(5)}
            onContinue={() => setStep(7)}
            stepIndicators={stepIndicators}
          />
        )}

        {step === 7 && (
          <PoliciesStep
            checkInFrom={checkInFrom}
            setCheckInFrom={setCheckInFrom}
            checkInUntil={checkInUntil}
            setCheckInUntil={setCheckInUntil}
            checkOutFrom={checkOutFrom}
            setCheckOutFrom={setCheckOutFrom}
            checkOutUntil={checkOutUntil}
            setCheckOutUntil={setCheckOutUntil}
            payAtHotel={payAtHotel}
            setPayAtHotel={setPayAtHotel}
            payAtHotelMethods={payAtHotelMethods}
            setPayAtHotelMethods={setPayAtHotelMethods}
            onlineCardPayment={onlineCardPayment}
            setOnlineCardPayment={setOnlineCardPayment}
            bankTransfer={bankTransfer}
            setBankTransfer={setBankTransfer}
            paymentProvider={paymentProvider}
            setPaymentProvider={setPaymentProvider}
            xenditChannelCode={xenditChannelCode}
            setXenditChannelCode={setXenditChannelCode}
            xenditAccountNumber={xenditAccountNumber}
            setXenditAccountNumber={setXenditAccountNumber}
            xenditAccountHolderName={xenditAccountHolderName}
            setXenditAccountHolderName={setXenditAccountHolderName}
            payoutAccountHolder={payoutAccountHolder}
            setPayoutAccountHolder={setPayoutAccountHolder}
            payoutAccountType={payoutAccountType}
            setPayoutAccountType={setPayoutAccountType}
            payoutIban={payoutIban}
            setPayoutIban={setPayoutIban}
            payoutAccountNumber={payoutAccountNumber}
            setPayoutAccountNumber={setPayoutAccountNumber}
            payoutBankName={payoutBankName}
            setPayoutBankName={setPayoutBankName}
            payoutSwift={payoutSwift}
            setPayoutSwift={setPayoutSwift}
            specialRequests={specialRequests}
            setSpecialRequests={setSpecialRequests}
            estimatedArrivalTime={estimatedArrivalTime}
            setEstimatedArrivalTime={setEstimatedArrivalTime}
            numberOfGuests={numberOfGuests}
            setNumberOfGuests={setNumberOfGuests}
            enableReferAGuest={enableReferAGuest}
            setEnableReferAGuest={setEnableReferAGuest}
            stepIndicators={stepIndicators}
            error=""
            saving={false}
            onBack={() => setStep(6)}
            onComplete={() => setStep(8)}
          />
        )}

        {/* Step 8: vayada Payment Terms */}
        {step === 8 && (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-8 py-8">
              {stepIndicators}

              <div className="text-center mb-8">
                <h2 className="text-xl font-bold text-gray-900">Payment Terms</h2>
                <p className="text-sm text-gray-500 mt-1">
                  Set pricing for both plans — the hotel can switch between them
                </p>
              </div>

              {/* Both plans side by side */}
              <div className="grid grid-cols-2 gap-4 mb-6">
                {/* Commission Plan */}
                <div
                  className={`bg-white rounded-xl border-2 p-5 transition-all ${activePlan === "commission" ? "border-primary-500 ring-1 ring-primary-200" : "border-gray-200"}`}
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <svg
                        className="w-5 h-5 text-primary-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        strokeWidth="1.5"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M2 12h4l3-9 4 18 3-9h4"
                        />
                      </svg>
                      <h3 className="text-[14px] font-semibold text-gray-900">Commission</h3>
                    </div>
                    {activePlan === "commission" && (
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-primary-100 text-primary-700 rounded-full">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-500 mb-4">Percentage of each booking</p>
                  <div className="bg-gray-50 rounded-xl p-4 flex items-baseline justify-center gap-1 mb-4">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.5"
                      value={commissionRate}
                      onChange={(e) => setCommissionRate(e.target.value)}
                      className="w-16 bg-transparent text-3xl font-bold text-gray-900 text-center focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                    <span className="text-xl font-bold text-gray-400">%</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActivePlan("commission")}
                    className={`w-full py-2 text-[12px] font-semibold rounded-lg transition-colors ${
                      activePlan === "commission"
                        ? "bg-primary-500 text-white"
                        : "border border-gray-300 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {activePlan === "commission" ? "Active Plan" : "Set as Active"}
                  </button>
                </div>

                {/* Fixed Fee Plan */}
                <div
                  className={`bg-white rounded-xl border-2 p-5 transition-all ${activePlan === "fixed" ? "border-primary-500 ring-1 ring-primary-200" : "border-gray-200"}`}
                >
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <svg
                        className="w-5 h-5 text-primary-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        strokeWidth="1.5"
                      >
                        <rect x="3" y="6" width="18" height="12" rx="2" />
                        <path d="M3 10h18" />
                        <path strokeLinecap="round" d="M7 14h4" />
                      </svg>
                      <h3 className="text-[14px] font-semibold text-gray-900">Fixed Fee</h3>
                    </div>
                    {activePlan === "fixed" && (
                      <span className="px-2 py-0.5 text-[10px] font-bold bg-primary-100 text-primary-700 rounded-full">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-500 mb-4">Flat monthly subscription</p>
                  <div className="bg-gray-50 rounded-xl p-4 flex items-baseline justify-center gap-1.5 mb-4">
                    <span className="text-lg font-bold text-gray-400">{currency}</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={fixedMonthlyFee}
                      onChange={(e) => setFixedMonthlyFee(e.target.value)}
                      className="w-20 bg-transparent text-3xl font-bold text-gray-900 text-center focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      placeholder="49"
                    />
                    <span className="text-[12px] text-gray-400">/mo</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActivePlan("fixed")}
                    className={`w-full py-2 text-[12px] font-semibold rounded-lg transition-colors ${
                      activePlan === "fixed"
                        ? "bg-primary-500 text-white"
                        : "border border-gray-300 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {activePlan === "fixed" ? "Active Plan" : "Set as Active"}
                  </button>
                </div>
              </div>

              <p className="text-center text-[11px] text-gray-400 mb-6">
                The hotel will see both plans and can request to switch for the next month
              </p>

              {/* Payment Provider */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 mb-8">
                <h3 className="text-[13px] font-semibold text-gray-900 mb-1">Payout Provider</h3>
                <p className="text-[11px] text-gray-500 mb-3">
                  Auto-selected based on country. Override if needed.
                </p>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={paymentProvider === "stripe"}
                      onChange={() => setPaymentProvider("stripe")}
                      className="text-primary-600"
                    />
                    <span className="text-sm text-gray-700">Stripe</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={paymentProvider === "xendit"}
                      onChange={() => setPaymentProvider("xendit")}
                      className="text-primary-600"
                    />
                    <span className="text-sm text-gray-700">Xendit (Indonesia)</span>
                  </label>
                </div>
              </div>

              {/* Navigation */}
              <div className="flex justify-between">
                <button
                  onClick={() => setStep(7)}
                  className="px-8 py-2.5 text-[14px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={saving}
                  className="px-8 py-2.5 bg-green-600 text-white text-[14px] font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
                >
                  {saving && (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  )}
                  Generate Invite Code
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── List View ──

  return (
    <div>
      <header className="bg-white border-b border-gray-200">
        <div className="px-6 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Invite Codes</h1>
            <p className="text-sm text-gray-500">Pre-configure hotel setups for onboarding</p>
          </div>
          <button
            onClick={() => setView("create")}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary-500 text-white text-sm font-semibold rounded-lg hover:bg-primary-600 transition-colors"
          >
            <PlusIcon className="w-4 h-4" /> Create Invite
          </button>
        </div>
      </header>

      <div className="p-6">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : invites.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-lg border border-gray-200">
            <p className="text-gray-500 text-sm">No invite codes yet</p>
            <p className="text-gray-400 text-xs mt-1">Create one to pre-configure a hotel setup</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Code
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Hotel
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Payout
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Status
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Created
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Expires
                  </th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {invites.map((inv) => (
                  <tr key={inv.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono font-semibold text-gray-900">{inv.code}</td>
                    <td className="px-4 py-3 text-gray-700">{inv.hotel_name || "—"}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                          inv.setup_data?.internal?.payment_provider === "xendit"
                            ? "bg-orange-100 text-orange-800"
                            : "bg-blue-100 text-blue-800"
                        }`}
                      >
                        {inv.setup_data?.internal?.payment_provider === "xendit"
                          ? "Xendit"
                          : "Stripe"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 text-xs font-semibold rounded-full ${
                          inv.status === "pending"
                            ? "bg-yellow-100 text-yellow-800"
                            : inv.status === "redeemed"
                              ? "bg-green-100 text-green-800"
                              : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(inv.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(inv.expires_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleCopy(inv.code, inv.id)}
                          className="p-1.5 text-gray-400 hover:text-gray-600 rounded-md hover:bg-gray-100"
                          title="Copy code"
                        >
                          {copiedId === inv.id ? (
                            <CheckIcon className="w-4 h-4 text-green-500" />
                          ) : (
                            <ClipboardIcon className="w-4 h-4" />
                          )}
                        </button>
                        <button
                          onClick={() => handleDelete(inv.id)}
                          className="p-1.5 text-gray-400 hover:text-red-500 rounded-md hover:bg-red-50"
                          title="Delete"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
