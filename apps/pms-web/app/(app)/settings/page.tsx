"use client";

import { useCallback, useState, useEffect } from "react";
import { bookingsService } from "@/services/bookings";
import {
  getPmsCalendarSettings,
  getPmsPropertyProfile,
  updatePmsCalendarSettings,
  updatePmsPropertyProfile,
} from "@/services/api/pmsPropertyClient";
import { useTranslation } from "@/lib/i18n";
import { SettingsLayout } from "@vayada/settings-ui";
import { PropertySection } from "@/components/settings/PropertySection";
import { LocalizationSection } from "@/components/settings/LocalizationSection";
import { BookingEngineSection } from "@/components/settings/BookingEngineSection";
import { CalendarSection } from "@/components/settings/CalendarSection";
import { CalendarAutoOpenEditor } from "@/components/settings/CalendarAutoOpenEditor";
import { settingsService, type BookingAcceptanceMode } from "@/services/settings";
import { OtaCommissionSettingsSection } from "@/components/settings/OtaCommissionSettingsSection";
import { humanizeApiError } from "@/components/settings/constants";
import {
  pmsPropertyDetailsSaveError,
  type PmsPropertyProfileLoadStatus,
} from "@/lib/settings/propertyDetails";
import { getPmsSettingsSections } from "@/lib/settings/navigation";

// Rail items also map to anchor IDs. Localization combines the existing
// #currency + #language anchors (both preserved as sub-targets so the global
// SearchModal links from VAY-367 still scroll to the right place).
type SectionId =
  | "property-details"
  | "ota-commissions"
  | "booking-engine"
  | "calendar"
  | "checkin-checklist"
  | "checkout-inspection"
  | "localization";

// Anchors used by SearchModal (apps/pms-web/components/layout/SearchModal.tsx)
// that map onto a parent rail section.
const ANCHOR_TO_SECTION: Record<string, SectionId> = {
  "property-details": "property-details",
  "ota-commissions": "ota-commissions",
  "booking-engine": "booking-engine",
  calendar: "calendar",
  "checkin-checklist": "checkin-checklist",
  "checkout-inspection": "checkout-inspection",
  currency: "localization",
  language: "localization",
};

export default function SettingsPage() {
  const [autoOpenReloadKey, setAutoOpenReloadKey] = useState(0);
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState<SectionId>("property-details");
  const [acceptanceMode, setAcceptanceMode] = useState<BookingAcceptanceMode>("instant");
  const [acceptanceLoadError, setAcceptanceLoadError] = useState("");
  const [loadingAcceptance, setLoadingAcceptance] = useState(true);
  const [savingAcceptance, setSavingAcceptance] = useState(false);
  const [sameDayEnabled, setSameDayEnabled] = useState(true);
  const [sameDayCutoffTime, setSameDayCutoffTime] = useState<string | null>("18:00");
  const [sameDayTimeZone, setSameDayTimeZone] = useState("");
  const [sameDayLoading, setSameDayLoading] = useState(true);
  const [sameDaySaving, setSameDaySaving] = useState(false);
  const [sameDayLoadError, setSameDayLoadError] = useState("");
  const [autoRearrangeEnabled, setAutoRearrangeEnabled] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarSaving, setCalendarSaving] = useState(false);
  const [calendarLoadError, setCalendarLoadError] = useState("");

  // Currency
  const [currency, setCurrency] = useState("");
  const [currencyLoadError, setCurrencyLoadError] = useState("");
  const [currencyLoadStatus, setCurrencyLoadStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  // Property details — only fields Channex actually enforces (timezone + country).
  // Title/currency/contact-email live elsewhere; other address fields are filled
  // later by each OTA's own validation flow when needed.
  const [timezone, setTimezone] = useState("");
  const [country, setCountry] = useState("");
  const [savingProperty, setSavingProperty] = useState(false);
  const [propertyProfileLoadStatus, setPropertyProfileLoadStatus] =
    useState<PmsPropertyProfileLoadStatus>("loading");
  const [propertyProfileLoadError, setPropertyProfileLoadError] = useState("");

  const loadPropertyProfile = useCallback(async () => {
    setPropertyProfileLoadStatus("loading");
    setPropertyProfileLoadError("");
    try {
      const profile = await getPmsPropertyProfile();
      setTimezone(profile.timezone ?? "");
      setCountry(profile.country ?? "");
      setPropertyProfileLoadStatus("ready");
    } catch (loadError) {
      setPropertyProfileLoadStatus("error");
      setPropertyProfileLoadError(
        humanizeApiError(
          loadError,
          "We couldn’t load the canonical property profile. Retry before editing these fields.",
        ),
      );
    }
  }, []);

  const loadAcceptanceMode = useCallback(async () => {
    setLoadingAcceptance(true);
    setAcceptanceLoadError("");
    try {
      const settings = await settingsService.getBookingAcceptance();
      setAcceptanceMode(settings.acceptanceMode);
    } catch (loadError) {
      setAcceptanceLoadError(
        humanizeApiError(loadError, "We couldn’t load booking acceptance settings."),
      );
    } finally {
      setLoadingAcceptance(false);
    }
  }, []);

  const loadCalendarSettings = useCallback(async () => {
    setCalendarLoading(true);
    setCalendarLoadError("");
    try {
      const settings = await getPmsCalendarSettings();
      setAutoRearrangeEnabled(settings.autoRearrangeEnabled);
    } catch (loadError) {
      setCalendarLoadError(
        humanizeApiError(loadError, "We couldn’t load automatic room-assignment settings."),
      );
    } finally {
      setCalendarLoading(false);
    }
  }, []);

  const loadSameDayBooking = useCallback(async () => {
    setSameDayLoading(true);
    setSameDayLoadError("");
    try {
      const settings = await settingsService.getSameDayBooking();
      setSameDayEnabled(settings.enabled);
      setSameDayCutoffTime(settings.cutoffLocalTime);
      setSameDayTimeZone(settings.propertyTimeZone);
    } catch (loadError) {
      setSameDayLoadError(
        humanizeApiError(loadError, "We couldn’t load same-day booking settings."),
      );
    } finally {
      setSameDayLoading(false);
    }
  }, []);

  useEffect(() => {
    bookingsService
      .getPaymentSettings()
      .then((res) => {
        setCurrency(res.paymentSettings.defaultCurrency || "");
        setCurrencyLoadError("");
        setCurrencyLoadStatus("ready");
      })
      .catch(() => {
        setCurrency("");
        setCurrencyLoadError("We couldn’t load the persisted property currency.");
        setCurrencyLoadStatus("error");
      })
      .finally(() => setLoading(false));

    void loadPropertyProfile();
    void loadAcceptanceMode();
    void loadCalendarSettings();
    void loadSameDayBooking();
  }, [loadAcceptanceMode, loadCalendarSettings, loadPropertyProfile, loadSameDayBooking]);

  const saveAcceptanceMode = async (instantBook: boolean) => {
    setSavingAcceptance(true);
    setError("");
    setSuccess("");
    try {
      const saved = await settingsService.updateBookingAcceptance(
        instantBook ? "instant" : "request",
      );
      setAcceptanceMode(saved.acceptanceMode);
      setSuccess("Booking acceptance settings saved");
    } catch (saveError) {
      setError(humanizeApiError(saveError, "Couldn’t save booking acceptance settings."));
    } finally {
      setSavingAcceptance(false);
    }
  };

  const saveAutoRearrange = async (enabled: boolean) => {
    setCalendarSaving(true);
    setError("");
    setSuccess("");
    try {
      const saved = await updatePmsCalendarSettings(enabled);
      setAutoRearrangeEnabled(saved.autoRearrangeEnabled);
      setSuccess("Calendar settings saved");
    } catch (saveError) {
      setError(humanizeApiError(saveError, "Couldn’t save calendar settings."));
    } finally {
      setCalendarSaving(false);
    }
  };

  const saveSameDayBooking = async (enabled: boolean, cutoffLocalTime: string | null) => {
    setSameDaySaving(true);
    setError("");
    setSuccess("");
    try {
      const saved = await settingsService.updateSameDayBooking(enabled, cutoffLocalTime);
      setSameDayEnabled(saved.enabled);
      setSameDayCutoffTime(saved.cutoffLocalTime);
      setSameDayTimeZone(saved.propertyTimeZone);
      setSuccess("Same-day booking settings saved");
    } catch (saveError) {
      setError(humanizeApiError(saveError, "Couldn’t save same-day booking settings."));
    } finally {
      setSameDaySaving(false);
    }
  };

  // Hash → active rail item + scrollIntoView. Re-runs on hashchange so the
  // global SearchModal navigation (VAY-367) lands on the right section even
  // when already on /settings.
  useEffect(() => {
    if (loading) return;
    const handle = () => {
      const hash = window.location.hash.slice(1);
      if (!hash) return;
      const mapped = ANCHOR_TO_SECTION[hash];
      if (mapped) setActiveId(mapped);
      const el = document.getElementById(hash);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    handle();
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, [loading]);

  const handleSelect = (id: string) => {
    setActiveId(id as SectionId);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `#${id}`);
    }
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const savePropertyDetails = async () => {
    const validationError = pmsPropertyDetailsSaveError({
      loadStatus: propertyProfileLoadStatus,
      timezone,
      country,
    });
    if (validationError) {
      setError(validationError);
      return;
    }

    setSavingProperty(true);
    setError("");
    setSuccess("");
    try {
      // PATCH only the fields the form actually edits; the backend leaves
      // unsent fields untouched (so any address/lat-lon set during onboarding
      // or via a future OTA-specific flow is preserved).
      const normalizedTimezone = timezone.trim();
      const normalizedCountry = country.trim().toUpperCase();
      await updatePmsPropertyProfile({
        timezone: normalizedTimezone,
        country: normalizedCountry,
      });
      setTimezone(normalizedTimezone);
      setCountry(normalizedCountry);
      setAutoOpenReloadKey((key) => key + 1);
      setSuccess("Property details saved");
    } catch (err: any) {
      setError(
        humanizeApiError(
          err,
          "Couldn’t save property details. Please try again, or contact support if the issue persists.",
        ),
      );
    } finally {
      setSavingProperty(false);
    }
  };

  const sections = getPmsSettingsSections(true);

  if (loading) {
    return (
      <div className="p-4 md:p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-48" />
          <div className="h-64 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  return (
    <SettingsLayout
      title={t("settings.title")}
      sections={sections}
      activeId={activeId}
      onSelect={handleSelect}
    >
      {error && (
        <div
          role="alert"
          className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"
        >
          {error}
        </div>
      )}
      {success && (
        <div
          role="status"
          className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700"
        >
          {success}
        </div>
      )}

      <PropertySection
        timezone={timezone}
        setTimezone={setTimezone}
        country={country}
        setCountry={setCountry}
        saving={savingProperty}
        loadStatus={propertyProfileLoadStatus}
        loadError={propertyProfileLoadError}
        onRetry={loadPropertyProfile}
        onSave={savePropertyDetails}
      />

      <CalendarSection
        enabled={autoRearrangeEnabled}
        loading={calendarLoading}
        saving={calendarSaving}
        loadError={calendarLoadError}
        onToggle={(next) => void saveAutoRearrange(next)}
        onRetry={() => void loadCalendarSettings()}
        autoOpenEditor={<CalendarAutoOpenEditor key={autoOpenReloadKey} />}
        sameDayEnabled={sameDayEnabled}
        sameDayCutoffTime={sameDayCutoffTime}
        sameDayTimeZone={sameDayTimeZone}
        sameDayLoading={sameDayLoading}
        sameDaySaving={sameDaySaving}
        sameDayLoadError={sameDayLoadError}
        onSameDayToggle={(next) => void saveSameDayBooking(next, sameDayCutoffTime)}
        onSameDayCutoffChange={(next) => void saveSameDayBooking(sameDayEnabled, next)}
        onSameDayRetry={() => void loadSameDayBooking()}
      />

      <BookingEngineSection
        instantBook={acceptanceMode === "instant"}
        saving={savingAcceptance || loadingAcceptance}
        loadError={acceptanceLoadError}
        onToggle={(next) => void saveAcceptanceMode(next)}
        onRetry={() => void loadAcceptanceMode()}
      />

      <OtaCommissionSettingsSection />

      <LocalizationSection
        currency={currency}
        currencyLoadError={currencyLoadError}
        currencyLoadStatus={currencyLoadStatus}
      />
    </SettingsLayout>
  );
}
