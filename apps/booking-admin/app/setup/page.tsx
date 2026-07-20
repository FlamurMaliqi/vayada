"use client";

import { Suspense, useState, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authService } from "@/services/auth";
import { settingsService } from "@/services/settings";
import type { CreateBookingAddonItemBody } from "@/services/api/bookingAddonItemsClient";
import type { CreateBookingPromoCodeBody } from "@/services/api/bookingPromoCodesClient";
import { updateBookingBenefitsSettings } from "@/services/api/bookingBenefitsSettingsClient";
import { updateBookingLastMinuteSettings } from "@/services/api/bookingLastMinuteSettingsClient";
import { getBookingHotelPropertyLink } from "@/services/api/bookingPropertyLinkClient";
import {
  buildFinancePaymentSettingsBody,
  updateFinancePaymentSettings,
} from "@/services/api/financePaymentSettingsClient";
import { checkSetupStatus } from "@/lib/utils/setupStatus";
import {
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  POPULAR_CURRENCY_CODES,
  POPULAR_LANGUAGE_CODES,
} from "@/lib/constants/options";
import { CheckIcon } from "@heroicons/react/24/outline";
import { uploadSingleImage, uploadImages } from "@/lib/utils/uploadImage";
import { getCurrencySymbol } from "@/lib/utils";
import { COLOR_PRESETS, FONT_PAIRINGS } from "@/lib/constants/branding";
import { SharedHotelSetupPage } from "@/components/setup/SharedHotelSetupPage";
import { reconcileSetupAddons, reconcileSetupPromoCodes } from "@/lib/utils/reconcileSetupCatalog";

import {
  AddonsStep,
  BenefitsStep,
  BrandMediaStep,
  LastMinuteStep,
  PoliciesStep,
  PropertyStep,
  type SetupAddon,
  useSetupWizardState,
} from "@vayada/product-onboarding";

const BRANDING_STEP = 6;
const STEPS = [
  { number: 1, label: "Your Property" },
  { number: 2, label: "Add-ons" },
  { number: 3, label: "Benefits" },
  { number: 4, label: "Last-Minute" },
  { number: 5, label: "Policies" },
];
const ACTIVATION_STEPS = [
  STEPS[0]!,
  { number: BRANDING_STEP, label: "Brand & Media" },
  ...STEPS.slice(1),
];

const GOOGLE_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Source+Sans+Pro:wght@300;400;600;700&family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400;0,700;1,400&family=Cinzel:wght@400;600;700&family=Italiana&display=swap";

function toAddonPricingModel(addon: { perPerson?: boolean; perNight?: boolean }) {
  if (addon.perPerson && addon.perNight) return "per_guest_night";
  if (addon.perPerson) return "per_guest";
  if (addon.perNight) return "per_night";
  return "per_stay";
}

function toAddonCategory(category: string) {
  if (category === "food") return "dining";
  return ["dining", "experience", "transport", "wellness", "other"].includes(category)
    ? (category as "dining" | "experience" | "transport" | "wellness" | "other")
    : "other";
}

function toSetupPromoCode(
  input: unknown,
  fallbackCurrency: string,
): CreateBookingPromoCodeBody | null {
  if (!isRecord(input)) return null;
  const code = readString(input.code)?.toUpperCase();
  const rawType = readString(input.discountType ?? input.discount_type)?.toLowerCase();
  if (rawType !== "fixed" && rawType !== "percentage") return null;
  const discountType = rawType;
  const rawValue = input.discountValue ?? input.discount_value;
  const discountValue =
    typeof rawValue === "number" ? rawValue.toFixed(2) : (readString(rawValue) ?? "");
  if (!code || !discountValue) return null;
  const currency = (readString(input.currency) ?? fallbackCurrency).toUpperCase();
  return {
    code,
    discountType,
    discountValue,
    currency: discountType === "fixed" ? currency : null,
    validFrom: readString(input.validFrom ?? input.valid_from) ?? null,
    validUntil: readString(input.validUntil ?? input.valid_until) ?? null,
    isActive: readBoolean(input.isActive ?? input.is_active) ?? true,
    maxUses: readPositiveInteger(input.maxUses ?? input.max_uses),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function BookingProductSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const productActivationMode = searchParams.get("legacy") === "booking";
  const activationPropertyId = productActivationMode
    ? readString(searchParams.get("propertyId"))
    : null;
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [activationSettingsLoaded, setActivationSettingsLoaded] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [applyingInvite, setApplyingInvite] = useState(false);
  const [appliedInviteCode, setAppliedInviteCode] = useState("");
  const [showWizard, setShowWizard] = useState(false);
  const [setupPromoCodes, setSetupPromoCodes] = useState<CreateBookingPromoCodeBody[]>([]);
  const [heroHeading, setHeroHeading] = useState("");
  const activationHotelIdRef = useRef<string | null>(null);
  const setupSteps = productActivationMode ? ACTIVATION_STEPS : STEPS;

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
    selectedFont,
    setSelectedFont,
    propertyDescription,
    setPropertyDescription,
    fileInputRef,
    uploading,
    handleImageUpload,
    setupAddons,
    setSetupAddons,
    benefits,
    setBenefits,
    lastMinuteConfig,
    setLastMinuteConfig,
    checkInFrom,
    setCheckInFrom,
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
    paymentProvider,
    setPaymentProvider,
    xenditChannelCode,
    setXenditChannelCode,
    xenditAccountNumber,
    setXenditAccountNumber,
    xenditAccountHolderName,
    setXenditAccountHolderName,
  } = useSetupWizardState({
    uploadSingleImage: (file) =>
      uploadSingleImage(file, "property.hero_image", activationHotelIdRef.current ?? undefined),
    uploadImages: (files) =>
      uploadImages(files, "property.gallery_image", activationHotelIdRef.current ?? undefined),
    defaultCurrency: "USD",
    defaultCheckInFrom: "14:00",
    defaultBookingFilters: [
      "includeBreakfast",
      "freeCancellation",
      "payAtHotel",
      "bestRated",
      "mountainView",
    ],
  });

  useEffect(() => {
    async function checkAuth() {
      activationHotelIdRef.current = null;
      // Accept auth token passed via URL hash (cross-domain handoff from PMS)
      if (typeof window !== "undefined" && window.location.hash) {
        const params = new URLSearchParams(window.location.hash.slice(1));
        const token = params.get("token");
        const expiresAt = params.get("expires_at");
        const userData = params.get("user");
        const fromPms = params.get("from") === "pms";
        if (fromPms) {
          localStorage.setItem("setup_from", "pms");
        }
        if (token && expiresAt) {
          localStorage.setItem("access_token", token);
          localStorage.setItem("token_expires_at", expiresAt);
          if (userData) {
            try {
              const user = JSON.parse(decodeURIComponent(userData));
              localStorage.setItem("isLoggedIn", "true");
              localStorage.setItem("userId", user.id);
              localStorage.setItem("userEmail", user.email);
              localStorage.setItem("userName", user.name);
              localStorage.setItem("userType", user.type);
              localStorage.setItem("userStatus", user.status);
              localStorage.setItem("user", JSON.stringify(user));
            } catch {
              /* ignore */
            }
          }
          // Clean the hash from the URL
          window.history.replaceState(null, "", window.location.pathname);
        }
      }

      const authorized = await authService.ensureSession();
      if (!authorized || !authService.isHotelAdmin()) {
        router.replace("/login");
        return;
      }

      if (productActivationMode) {
        const hotels = await settingsService.listHotels();
        const activationHotel = activationPropertyId
          ? hotels.find(
              (hotel) =>
                hotel.propertyId === activationPropertyId || hotel.id === activationPropertyId,
            )
          : null;
        if (!activationHotel) {
          localStorage.removeItem("selectedHotelId");
          router.replace("/setup?entryProduct=booking");
          return;
        }
        activationHotelIdRef.current = activationHotel.id;
        localStorage.setItem("selectedHotelId", activationHotel.id);
      }

      // Multi-hotel "Add Property" flow: the header's Add Property
      // button routes to /setup?mode=add for users who already have
      // >= 1 hotel. Skip the setup_complete redirect in that case
      // — the user explicitly came here to create a NEW property.
      const urlParams =
        typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
      const addMode = urlParams?.get("mode") === "add";
      if (addMode && !productActivationMode) {
        try {
          localStorage.removeItem("selectedHotelId");
        } catch {}
      }

      const status = await checkSetupStatus();
      if (status?.setup_complete && !addMode && !productActivationMode) {
        localStorage.setItem("setupComplete", "true");
        router.replace("/dashboard");
        return;
      }
      // In add mode we intentionally DON'T prefill from the existing
      // setup — the user is creating a fresh property, so start blank.
      if (productActivationMode) {
        setActivationSettingsLoaded(false);
        try {
          const activationHotelId = activationHotelIdRef.current!;
          const [profile, design] = await Promise.all([
            settingsService.getPropertySettings(activationHotelId),
            settingsService.getDesignSettings(activationHotelId),
          ]);
          if (profile.property_name) setPropertyName(profile.property_name);
          if (profile.city) setCity(profile.city);
          if (profile.country) setCountry(profile.country);
          if (profile.address) setAddress(profile.address);
          if (profile.reservation_email) setReservationEmail(profile.reservation_email);
          if (profile.phone_number) setPhoneNumber(profile.phone_number);
          if (profile.whatsapp_number) setWhatsapp(profile.whatsapp_number);
          if (profile.instagram) setInstagram(profile.instagram);
          if (profile.facebook) setFacebook(profile.facebook);
          if (profile.default_currency) setCurrency(profile.default_currency);
          if (profile.default_language) setDefaultLanguage(profile.default_language);
          if (profile.supported_currencies) {
            setSupportedCurrencies(profile.supported_currencies);
          }
          if (profile.supported_languages) {
            setSupportedLanguages(profile.supported_languages);
          }
          if (profile.check_in_from ?? profile.check_in_time) {
            setCheckInFrom(profile.check_in_from ?? profile.check_in_time);
          }
          if (profile.check_out_until ?? profile.check_out_time) {
            setCheckOutUntil(profile.check_out_until ?? profile.check_out_time);
          }
          if (profile.pay_at_property_enabled !== undefined) {
            setPayAtHotel(profile.pay_at_property_enabled);
          }
          if (profile.pay_at_hotel_methods) {
            setPayAtHotelMethods(profile.pay_at_hotel_methods);
          }
          if (profile.online_card_payment !== undefined) {
            setOnlineCardPayment(profile.online_card_payment);
          }
          if (profile.bank_transfer !== undefined) setBankTransfer(profile.bank_transfer);
          if (profile.payout_account_holder) {
            setPayoutAccountHolder(profile.payout_account_holder);
          }
          if (profile.payout_account_type) setPayoutAccountType(profile.payout_account_type);
          if (profile.payout_iban) setPayoutIban(profile.payout_iban);
          if (profile.payout_account_number) {
            setPayoutAccountNumber(profile.payout_account_number);
          }
          if (profile.payout_bank_name) setPayoutBankName(profile.payout_bank_name);
          if (profile.payout_swift) setPayoutSwift(profile.payout_swift);
          if (profile.special_requests_enabled !== undefined) {
            setSpecialRequests(profile.special_requests_enabled);
          }
          if (profile.arrival_time_enabled !== undefined) {
            setEstimatedArrivalTime(profile.arrival_time_enabled);
          }
          if (profile.guest_count_enabled !== undefined) {
            setNumberOfGuests(profile.guest_count_enabled);
          }
          setHeroImage(design.hero_image);
          setHeroHeading(design.hero_heading);
          setPropertyDescription(design.hero_subtext);
          setPrimaryColor(design.primary_color);
          setSelectedFont(design.font_pairing);
          setActivationSettingsLoaded(true);
          setPrefilled(true);
        } catch {
          setError("We couldn't load your Booking settings. Refresh the page to try again.");
          setShowWizard(true);
        }
      } else if (!addMode) {
        const prefill = status?.prefill_data;
        if (prefill) {
          if (prefill.property_name) setPropertyName(prefill.property_name);
          if (prefill.reservation_email) setReservationEmail(prefill.reservation_email);
          if (prefill.phone_number) setPhoneNumber(prefill.phone_number);
          if (prefill.address) setAddress(prefill.address);
          setPrefilled(true);
        }
      }
      setLoading(false);
    }
    checkAuth();
  }, [activationPropertyId, productActivationMode, router]);

  const canProceed = (): boolean => {
    if (step === 1) {
      if (productActivationMode) {
        return activationSettingsLoaded && Boolean(currency && defaultLanguage);
      }
      return !!(
        propertyName.trim() &&
        city.trim() &&
        country &&
        address.trim() &&
        reservationEmail.trim() &&
        phoneNumber.trim()
      );
    }
    if (step === BRANDING_STEP) {
      return (
        activationSettingsLoaded &&
        !uploading &&
        /^#[0-9A-Fa-f]{6}$/.test(primaryColor) &&
        FONT_PAIRINGS.some((pairing) => pairing.id === selectedFont)
      );
    }
    return true;
  };

  const handleComplete = async () => {
    setError("");
    setSaving(true);
    try {
      if (productActivationMode) {
        if (!activationPropertyId || !activationHotelIdRef.current) {
          throw new Error("Select a property before activating Booking.");
        }
        if (!activationSettingsLoaded) {
          throw new Error("Booking settings must load before activation can continue.");
        }
      } else {
        localStorage.removeItem("selectedHotelId");
      }
      const propertyPayload = {
        ...(productActivationMode
          ? {}
          : {
              property_name: propertyName,
              reservation_email: reservationEmail,
              phone_number: phoneNumber,
              address,
              city,
              country,
            }),
        whatsapp_number: whatsapp,
        instagram,
        facebook,
        default_currency: currency,
        default_language: defaultLanguage,
        supported_currencies: supportedCurrencies,
        supported_languages: supportedLanguages,
        check_in_time: checkInFrom,
        check_out_time: checkOutUntil,
        check_in_from: checkInFrom,
        check_out_until: checkOutUntil,
        pay_at_property_enabled: payAtHotel,
        pay_at_hotel_methods: payAtHotelMethods,
        online_card_payment: onlineCardPayment,
        bank_transfer: bankTransfer,
        payout_account_holder: payoutAccountHolder,
        payout_account_type: payoutAccountType,
        payout_iban: payoutIban,
        payout_account_number: payoutAccountNumber,
        payout_bank_name: payoutBankName,
        payout_swift: payoutSwift,
        special_requests_enabled: specialRequests,
        arrival_time_enabled: estimatedArrivalTime,
        guest_count_enabled: numberOfGuests,
      };

      const savedSettings = productActivationMode
        ? await settingsService.updatePropertySettings(
            propertyPayload,
            activationHotelIdRef.current!,
          )
        : await settingsService.createHotel(propertyPayload);
      const createdHotelId =
        savedSettings.booking_hotel_id ??
        savedSettings.id ??
        (productActivationMode ? activationHotelIdRef.current : null) ??
        savedSettings.property_id;
      if (createdHotelId) {
        localStorage.setItem("selectedHotelId", createdHotelId);
      }

      if (productActivationMode) {
        await settingsService.updateDesignSettings(
          {
            hero_image: heroImage,
            hero_heading: heroHeading,
            hero_subtext: propertyDescription,
            primary_color: primaryColor,
            font_pairing: selectedFont,
          },
          activationHotelIdRef.current!,
        );
      }

      if (setupAddons.length > 0) {
        if (!createdHotelId) {
          throw new Error("Booking hotel id is required before saving add-ons.");
        }
        const addonBodies: CreateBookingAddonItemBody[] = setupAddons.map((addon, index) => {
          const parsedPrice = Number(addon.price);
          if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
            throw new Error(`Invalid add-on price for "${addon.name}".`);
          }
          return {
            name: addon.name,
            description: addon.description,
            price: parsedPrice.toFixed(2),
            currency: addon.currency || currency,
            category: toAddonCategory(addon.category),
            imageUrl: addon.image || null,
            duration: addon.duration || null,
            pricingModel: toAddonPricingModel(addon),
            publicVisible: true,
            status: "active",
            sortOrder: index,
          };
        });
        await reconcileSetupAddons({ hotelId: createdHotelId, addons: addonBodies });
      }
      if (setupPromoCodes.length > 0 && createdHotelId) {
        const failedPromoCodes = await reconcileSetupPromoCodes({
          hotelId: createdHotelId,
          promoCodes: setupPromoCodes,
        });
        if (failedPromoCodes.length > 0) {
          localStorage.setItem(
            "setupWarning",
            `Hotel created, but some promo codes were not saved: ${failedPromoCodes.join(", ")}. Add them from Booking Flow > Promo Codes.`,
          );
        }
      }
      if (createdHotelId) {
        try {
          const propertyLink = await getBookingHotelPropertyLink({ hotelId: createdHotelId });
          await updateFinancePaymentSettings({
            propertyId: propertyLink.propertyId,
            body: buildFinancePaymentSettingsBody({
              payAtPropertyEnabled: payAtHotel,
              payAtHotelMethods,
              onlineCardPayment,
              bankTransfer,
              payoutAccountHolder,
              payoutAccountType,
              payoutIban,
              payoutAccountNumber,
              payoutBankName,
              payoutSwift,
              paymentProvider,
              defaultCurrency: currency,
              commandPrefix: `setup-payment-settings-${createdHotelId}`,
            }),
          });
        } catch {
          localStorage.setItem(
            "setupWarning",
            "Hotel created, but payment settings were not saved. Update them from Settings > Payments.",
          );
        }
      }

      // 8. Save benefits
      if (benefits.length > 0 && createdHotelId) {
        try {
          await updateBookingBenefitsSettings({
            hotelId: createdHotelId,
            body: { benefits },
          });
        } catch {
          // Non-fatal: benefits can be added later from Settings
        }
      }

      if (createdHotelId && lastMinuteConfig.enabled) {
        try {
          await updateBookingLastMinuteSettings({
            hotelId: createdHotelId,
            body: lastMinuteConfig,
          });
        } catch {
          localStorage.setItem(
            "setupWarning",
            "Last-minute settings could not be saved during setup. You can retry from Booking Settings.",
          );
        }
      }

      localStorage.setItem("setupComplete", "true");

      // Mark invite code as redeemed
      if (appliedInviteCode) {
        try {
          const token = localStorage.getItem("access_token");
          await fetch(`${API_URL}/api/invite-codes/${appliedInviteCode}/redeem`, {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          });
        } catch {
          /* non-critical */
        }
      }

      // If the user came from PMS, redirect back there
      const fromPms = localStorage.getItem("setup_from") === "pms";
      if (fromPms) {
        localStorage.removeItem("setup_from");
        const pmsUrl = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";
        window.location.href = `${pmsUrl}/dashboard`;
        return;
      }

      router.push("/dashboard");
    } catch (err: unknown) {
      console.error("Setup failed:", err);
      let message = "An unexpected error occurred. Please try again.";
      if (err && typeof err === "object" && "data" in err) {
        const apiErr = err as { data: { detail: string | Array<{ msg: string }> } };
        if (typeof apiErr.data.detail === "string") {
          message = apiErr.data.detail;
        } else if (Array.isArray(apiErr.data.detail)) {
          message = apiErr.data.detail.map((e) => e.msg).join(", ");
        }
      } else if (err instanceof TypeError && err.message === "Failed to fetch") {
        message =
          "Could not connect to the server. Please check your internet connection and try again.";
      } else if (err instanceof Error) {
        message = err.message;
      }
      setError(message);
      setSaving(false);
    }
  };

  const currentStepIdx = setupSteps.findIndex((s) => s.number === step);
  const stepIndicators = (
    <ol
      className="mb-4 flex items-center justify-center sm:mb-5"
      aria-label="Booking Engine setup progress"
    >
      {setupSteps.map((s, idx) => {
        const isCompleted = currentStepIdx > idx;
        const isActive = currentStepIdx === idx;
        return (
          <li
            key={s.number}
            className="flex items-center"
            aria-current={isActive ? "step" : undefined}
          >
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors ${
                  isCompleted || isActive
                    ? "bg-primary-600 text-white"
                    : "bg-gray-200 text-gray-500"
                }`}
              >
                {isCompleted ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : idx + 1}
              </span>
              <span
                className={`sr-only whitespace-nowrap text-xs font-medium xl:not-sr-only ${
                  isCompleted || isActive ? "text-gray-900" : "text-gray-400"
                }`}
              >
                {s.label}
              </span>
            </span>
            {idx < setupSteps.length - 1 && (
              <span
                className={`mx-1.5 h-px w-5 shrink-0 sm:mx-2 sm:w-8 xl:mx-3 xl:w-10 ${isCompleted ? "bg-primary-600" : "bg-gray-300"}`}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );

  const API_URL =
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.NEXT_PUBLIC_AUTH_API_URL ||
    "https://api.localhost";

  const applyInviteCode = async () => {
    if (!inviteCode.trim()) return;
    setInviteError("");
    setApplyingInvite(true);
    try {
      const res = await fetch(`${API_URL}/api/invite-codes/${inviteCode.trim().toUpperCase()}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setInviteError(err.detail || "Invalid invite code");
        setApplyingInvite(false);
        return;
      }
      const { data } = await res.json();

      // Prefill property
      if (data.property) {
        const p = data.property;
        if (p.property_name) setPropertyName(p.property_name);
        if (p.city) setCity(p.city);
        if (p.country) setCountry(p.country);
        if (p.address) setAddress(p.address);
        if (p.reservation_email) setReservationEmail(p.reservation_email);
        if (p.phone_number) setPhoneNumber(p.phone_number);
        if (p.whatsapp_number) setWhatsapp(p.whatsapp_number);
        if (p.instagram) setInstagram(p.instagram);
        if (p.facebook) setFacebook(p.facebook);
        if (p.default_currency) setCurrency(p.default_currency);
        if (p.default_language) setDefaultLanguage(p.default_language);
        if (p.supported_currencies) setSupportedCurrencies(p.supported_currencies);
        if (p.supported_languages) setSupportedLanguages(p.supported_languages);
      }

      // Prefill addons
      if (data.addons && data.addons.length > 0) {
        setSetupAddons(
          data.addons.map((a: Partial<SetupAddon>) => ({
            _localId: crypto.randomUUID(),
            name: a.name || "",
            description: a.description || "",
            price: a.price || 0,
            currency: a.currency || data.property?.default_currency || "EUR",
            category: a.category || "experience",
            image: a.image || "",
            duration: a.duration || "",
            perPerson: a.perPerson || false,
            perNight: a.perNight || false,
          })),
        );
      }

      const invitePromoCodes = Array.isArray(data.promoCodes) ? (data.promoCodes as unknown[]) : [];
      setSetupPromoCodes(
        invitePromoCodes
          .map((promoCode: unknown) =>
            toSetupPromoCode(promoCode, data.property?.default_currency || "EUR"),
          )
          .filter((promoCode): promoCode is CreateBookingPromoCodeBody => promoCode !== null),
      );

      // Prefill benefits
      if (data.benefits && data.benefits.length > 0) {
        setBenefits(data.benefits);
      }

      // Prefill policies
      if (data.policies) {
        const pol = data.policies;
        if (pol.check_in_from) setCheckInFrom(pol.check_in_from);
        else if (pol.check_in_time) setCheckInFrom(pol.check_in_time);
        if (pol.check_out_until) setCheckOutUntil(pol.check_out_until);
        else if (pol.check_out_time) setCheckOutUntil(pol.check_out_time);
        if (pol.pay_at_property !== undefined) setPayAtHotel(pol.pay_at_property);
        if (pol.online_card_payment !== undefined) setOnlineCardPayment(pol.online_card_payment);
        if (pol.bank_transfer !== undefined) setBankTransfer(pol.bank_transfer);
        if (pol.special_requests !== undefined) setSpecialRequests(pol.special_requests);
        if (pol.arrival_time !== undefined) setEstimatedArrivalTime(pol.arrival_time);
        if (pol.guest_count !== undefined) setNumberOfGuests(pol.guest_count);
      }

      // Prefill payment provider from internal settings
      if (data.internal?.payment_provider) {
        setPaymentProvider(data.internal.payment_provider);
      }

      // Prefill last-minute discount config
      if (data.last_minute_discount) {
        setLastMinuteConfig({
          enabled: !!data.last_minute_discount.enabled,
          stackWithPromo: !!data.last_minute_discount.stackWithPromo,
          tiers: Array.isArray(data.last_minute_discount.tiers)
            ? data.last_minute_discount.tiers
            : [],
        });
      }

      setAppliedInviteCode(inviteCode.trim().toUpperCase());
      setPrefilled(true);
      setShowWizard(true);
    } catch {
      setInviteError("Failed to fetch invite data. Please try again.");
    } finally {
      setApplyingInvite(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Welcome screen with invite code option
  if (!showWizard && !prefilled) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col">
        <div className="bg-white border-b border-gray-200 px-4 sm:px-8 py-3 shrink-0">
          <div className="flex items-center gap-2.5">
            <svg
              width="28"
              height="28"
              viewBox="0 0 32 32"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect width="32" height="32" rx="6" fill="#4338CA" />
              <path
                d="M10 16.5L14 20.5L22 12.5"
                stroke="white"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[15px] font-semibold text-gray-900">Booking Engine Setup</span>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center px-4">
          <div className="max-w-md w-full space-y-6">
            <div className="text-center">
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Welcome to vayada</h1>
              <p className="text-sm text-gray-500">Set up your property in just a few minutes</p>
            </div>

            {/* Invite Code */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h2 className="text-[14px] font-semibold text-gray-900 mb-1">Have an invite code?</h2>
              <p className="text-[12px] text-gray-500 mb-4">
                If vayada pre-configured your property, enter the code to load everything.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => {
                    setInviteCode(e.target.value.toUpperCase());
                    setInviteError("");
                  }}
                  placeholder="e.g. A7K3-X9M2"
                  className="flex-1 px-3 py-2.5 border border-gray-300 rounded-lg text-[14px] font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyInviteCode();
                  }}
                />
                <button
                  onClick={applyInviteCode}
                  disabled={applyingInvite || !inviteCode.trim()}
                  className="px-5 py-2.5 bg-primary-600 text-white text-[13px] font-semibold rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
                >
                  {applyingInvite ? "Loading..." : "Apply"}
                </button>
              </div>
              {inviteError && <p className="text-[12px] text-red-600 mt-2">{inviteError}</p>}
            </div>

            {/* Divider */}
            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-gray-200" />
              <span className="text-[12px] text-gray-400 font-medium">or</span>
              <div className="flex-1 h-px bg-gray-200" />
            </div>

            {/* Start from scratch */}
            <button
              onClick={() => setShowWizard(true)}
              className="w-full py-3 bg-white border border-gray-300 text-gray-900 text-[14px] font-semibold rounded-xl hover:bg-gray-50 transition-colors"
            >
              Set up manually
            </button>
          </div>
        </div>

        {/* Sign out */}
        <div className="fixed bottom-6 left-6">
          <button
            onClick={() => authService.logout()}
            className="text-[13px] text-gray-400 hover:text-gray-600 transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <link rel="stylesheet" href={GOOGLE_FONTS_URL} />
      {/* Top bar */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-4 py-3 sm:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <svg
              width="28"
              height="28"
              viewBox="0 0 32 32"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect width="32" height="32" rx="6" fill="#4338CA" />
              <path
                d="M10 16.5L14 20.5L22 12.5"
                stroke="white"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[15px] font-semibold text-gray-900">Booking Engine Setup</span>
          </div>
          <span className="whitespace-nowrap text-xs text-gray-500 sm:text-[13px]">
            Step {setupSteps.findIndex((s) => s.number === step) + 1} of {setupSteps.length}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-[3px] shrink-0 bg-gray-100">
        <div
          className="h-full bg-primary-600 transition-all duration-300"
          style={{
            width: `${((setupSteps.findIndex((s) => s.number === step) + 1) / setupSteps.length) * 100}%`,
          }}
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
          currency={currency}
          setCurrency={setCurrency}
          defaultLanguage={defaultLanguage}
          setDefaultLanguage={setDefaultLanguage}
          supportedCurrencies={supportedCurrencies}
          setSupportedCurrencies={setSupportedCurrencies}
          supportedLanguages={supportedLanguages}
          setSupportedLanguages={setSupportedLanguages}
          prefilled={prefilled}
          hideSharedHotelFields={productActivationMode}
          error={error}
          canProceed={canProceed()}
          onContinue={() => {
            setError("");
            setStep(productActivationMode ? BRANDING_STEP : 2);
          }}
          stepIndicators={stepIndicators}
          countryOptions={COUNTRY_OPTIONS}
          currencyOptions={CURRENCY_OPTIONS}
          languageOptions={LANGUAGE_OPTIONS}
          popularCurrencyCodes={POPULAR_CURRENCY_CODES}
          popularLanguageCodes={POPULAR_LANGUAGE_CODES}
        />
      )}

      {productActivationMode && step === BRANDING_STEP && (
        <BrandMediaStep
          heroImage={heroImage}
          setHeroImage={setHeroImage}
          heroImageRequired={false}
          heroHeading={heroHeading}
          setHeroHeading={setHeroHeading}
          primaryColor={primaryColor}
          setPrimaryColor={setPrimaryColor}
          selectedFont={selectedFont}
          setSelectedFont={setSelectedFont}
          propertyDescription={propertyDescription}
          setPropertyDescription={setPropertyDescription}
          uploading={uploading}
          fileInputRef={fileInputRef}
          handleImageUpload={handleImageUpload}
          propertyName={propertyName}
          currency={currency}
          defaultLanguage={defaultLanguage}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(1)}
          onContinue={() => {
            setError("");
            setStep(2);
          }}
          stepIndicators={stepIndicators}
          colorPresets={COLOR_PRESETS}
          fontPairings={FONT_PAIRINGS}
          formatPrice={(amount, code) => `${getCurrencySymbol(code)}${amount.toFixed(2)}`}
        />
      )}

      {step === 2 && (
        <AddonsStep
          addons={setupAddons}
          setAddons={setSetupAddons}
          currency={currency}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(productActivationMode ? BRANDING_STEP : 1)}
          onContinue={() => {
            setError("");
            setStep(3);
          }}
          stepIndicators={stepIndicators}
          uploadImage={uploadSingleImage}
          formatPrice={(amt, c) => `${getCurrencySymbol(c)}${amt.toFixed(2)}`}
        />
      )}

      {step === 3 && (
        <BenefitsStep
          benefits={benefits}
          setBenefits={setBenefits}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(2)}
          onContinue={() => {
            setError("");
            setStep(4);
          }}
          stepIndicators={stepIndicators}
        />
      )}

      {step === 4 && (
        <LastMinuteStep
          config={lastMinuteConfig}
          setConfig={setLastMinuteConfig}
          error={error}
          canProceed={canProceed()}
          onBack={() => setStep(3)}
          onContinue={() => {
            setError("");
            setStep(5);
          }}
          stepIndicators={stepIndicators}
        />
      )}

      {step === 5 && (
        <PoliciesStep
          checkInFrom={checkInFrom}
          setCheckInFrom={setCheckInFrom}
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
          error={error}
          saving={saving}
          onBack={() => setStep(4)}
          onComplete={handleComplete}
          stepIndicators={stepIndicators}
        />
      )}
    </div>
  );
}

export default function SetupPage() {
  return (
    <Suspense fallback={<SetupLoading />}>
      <SetupPageContent />
    </Suspense>
  );
}

function SetupPageContent() {
  const searchParams = useSearchParams();

  if (searchParams.get("legacy") === "booking") {
    return <BookingProductSetupPage />;
  }

  return <SharedHotelSetupPage defaultEntryProduct="booking" defaultReturnTo="/dashboard" />;
}

function SetupLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-gray-950" />
    </div>
  );
}
