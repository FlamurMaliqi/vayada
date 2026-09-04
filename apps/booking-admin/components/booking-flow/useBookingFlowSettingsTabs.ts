"use client";

import { useCallback, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import {
  updateBookingBenefitsSettings,
  type BookingBenefitsSettings,
} from "@/services/api/bookingBenefitsSettingsClient";
import {
  updateBookingGuestFormSettings,
  type BookingGuestFormSettings,
} from "@/services/api/bookingGuestFormSettingsClient";
import {
  updateBookingLocalizationSettings,
  type BookingLocalizationSettings,
} from "@/services/api/bookingLocalizationSettingsClient";

type ShowFeedback = (type: "success" | "error", message: string) => void;

interface BookingFlowSettingsTabInput {
  getBookingHotelIdForSave: () => string;
  showFeedback: ShowFeedback;
}

export function useBenefitsSettingsTab({
  getBookingHotelIdForSave,
  showFeedback,
}: BookingFlowSettingsTabInput) {
  const { t } = useTranslation();
  const [benefits, setBenefits] = useState<string[]>([]);
  const [benefitInput, setBenefitInput] = useState("");
  const [savingBenefits, setSavingBenefits] = useState(false);

  const handleSaveBenefits = async () => {
    try {
      setSavingBenefits(true);
      const trimmed = benefitInput.trim();
      let finalBenefits = benefits;
      if (trimmed && !benefits.includes(trimmed)) {
        finalBenefits = [...benefits, trimmed];
        setBenefits(finalBenefits);
        setBenefitInput("");
      }
      const saved = await updateBookingBenefitsSettings({
        hotelId: getBookingHotelIdForSave(),
        body: { benefits: finalBenefits },
      });
      setBenefits(saved.benefits);
      showFeedback("success", t("bookingFlow.benefits.feedback.saveSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.benefits.feedback.saveError"));
    } finally {
      setSavingBenefits(false);
    }
  };

  return {
    benefits,
    setBenefits,
    benefitInput,
    setBenefitInput,
    savingBenefits,
    handleSaveBenefits,
  };
}

export function useGuestFormSettingsTab({
  getBookingHotelIdForSave,
  showFeedback,
}: BookingFlowSettingsTabInput) {
  const { t } = useTranslation();
  const [specialRequestsEnabled, setSpecialRequestsEnabled] = useState(true);
  const [arrivalTimeEnabled, setArrivalTimeEnabled] = useState(false);
  const [guestCountEnabled, setGuestCountEnabled] = useState(false);
  const [phoneRequired, setPhoneRequired] = useState(true);
  const [adultAgeThreshold, setAdultAgeThreshold] = useState(18);
  const [childrenEnabled, setChildrenEnabled] = useState(true);
  const [savingGuestForm, setSavingGuestForm] = useState(false);

  const applyGuestFormSettings = useCallback((settings: BookingGuestFormSettings) => {
    setSpecialRequestsEnabled(settings.specialRequestsEnabled);
    setArrivalTimeEnabled(settings.arrivalTimeEnabled);
    setGuestCountEnabled(settings.guestCountEnabled);
    setPhoneRequired(settings.phoneRequired);
    setAdultAgeThreshold(settings.adultAgeThreshold);
    setChildrenEnabled(settings.childrenEnabled);
  }, []);

  const handleSaveGuestForm = async () => {
    try {
      setSavingGuestForm(true);
      const saved = await updateBookingGuestFormSettings({
        hotelId: getBookingHotelIdForSave(),
        body: {
          specialRequestsEnabled,
          arrivalTimeEnabled,
          guestCountEnabled,
          phoneRequired,
          adultAgeThreshold,
          childrenEnabled,
        },
      });
      applyGuestFormSettings(saved);
      showFeedback("success", t("bookingFlow.guestForm.feedback.saveSuccess"));
    } catch {
      showFeedback("error", t("bookingFlow.guestForm.feedback.saveError"));
    } finally {
      setSavingGuestForm(false);
    }
  };

  return {
    specialRequestsEnabled,
    setSpecialRequestsEnabled,
    arrivalTimeEnabled,
    setArrivalTimeEnabled,
    guestCountEnabled,
    setGuestCountEnabled,
    phoneRequired,
    setPhoneRequired,
    adultAgeThreshold,
    setAdultAgeThreshold,
    childrenEnabled,
    setChildrenEnabled,
    savingGuestForm,
    applyGuestFormSettings,
    handleSaveGuestForm,
  };
}

export function useLocalizationSettingsTab({
  getBookingHotelIdForSave,
  showFeedback,
}: BookingFlowSettingsTabInput) {
  const { t } = useTranslation();
  const [defaultCurrency, setDefaultCurrency] = useState("EUR");
  const [defaultLanguage, setDefaultLanguage] = useState("en");
  const [supportedCurrencies, setSupportedCurrencies] = useState<string[]>([]);
  const [supportedLanguages, setSupportedLanguages] = useState<string[]>([]);
  const [savingCurrencyLang, setSavingCurrencyLang] = useState(false);

  const applyLocalizationSettings = useCallback((settings: BookingLocalizationSettings) => {
    setDefaultCurrency(settings.defaultCurrency);
    setDefaultLanguage(settings.defaultLanguage);
    setSupportedCurrencies(settings.supportedCurrencies);
    setSupportedLanguages(settings.supportedLanguages);
  }, []);

  const handleSaveCurrencyLang = async () => {
    try {
      setSavingCurrencyLang(true);
      const saved = await updateBookingLocalizationSettings({
        hotelId: getBookingHotelIdForSave(),
        body: {
          defaultCurrency,
          defaultLanguage,
          supportedCurrencies,
          supportedLanguages,
        },
      });
      applyLocalizationSettings(saved);
      showFeedback("success", t("bookingFlow.localization.feedback.saveSuccess"));
      return saved;
    } catch {
      showFeedback("error", t("bookingFlow.localization.feedback.saveError"));
      return null;
    } finally {
      setSavingCurrencyLang(false);
    }
  };

  return {
    defaultCurrency,
    setDefaultCurrency,
    defaultLanguage,
    setDefaultLanguage,
    supportedCurrencies,
    setSupportedCurrencies,
    supportedLanguages,
    setSupportedLanguages,
    savingCurrencyLang,
    applyLocalizationSettings,
    handleSaveCurrencyLang,
  };
}

export type { BookingBenefitsSettings, BookingGuestFormSettings, BookingLocalizationSettings };
