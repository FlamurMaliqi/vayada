"use client";

import { useCallback, useState, useEffect } from "react";
import {
  BoltIcon,
  CalendarDaysIcon,
  ClockIcon,
  ClipboardDocumentCheckIcon,
  GlobeAltIcon,
} from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import { bookingsService } from "@/services/bookings";
import {
  getPmsCalendarSettings,
  getPmsPropertyProfile,
  updatePmsCalendarSettings,
  updatePmsPropertyProfile,
} from "@/services/api/pmsPropertyClient";
import { useTranslation } from "@/lib/i18n";
import {
  SettingsCard,
  SettingsLayout,
  SettingsSection,
  type SettingsNavSection,
} from "@/components/settings/layout";
import { PropertySection } from "@/components/settings/PropertySection";
import { LocalizationSection } from "@/components/settings/LocalizationSection";
import { BookingEngineSection } from "@/components/settings/BookingEngineSection";
import { CalendarSection } from "@/components/settings/CalendarSection";
import { settingsService, type BookingAcceptanceMode } from "@/services/settings";
import { humanizeApiError } from "@/components/settings/constants";
import {
  pmsPropertyDetailsSaveError,
  type PmsPropertyProfileLoadStatus,
} from "@/lib/settings/propertyDetails";

// Rail items also map to anchor IDs. Localization combines the existing
// #currency + #language anchors (both preserved as sub-targets so the global
// SearchModal links from VAY-367 still scroll to the right place).
type SectionId =
  | "property-details"
  | "booking-engine"
  | "calendar"
  | "check-in-out"
  | "checkin-checklist"
  | "checkout-inspection"
  | "localization";

// Anchors used by SearchModal (apps/pms-web/components/layout/SearchModal.tsx)
// that map onto a parent rail section.
const ANCHOR_TO_SECTION: Record<string, SectionId> = {
  "property-details": "property-details",
  "booking-engine": "booking-engine",
  calendar: "calendar",
  "check-in-out": "check-in-out",
  "checkin-checklist": "checkin-checklist",
  "checkout-inspection": "checkout-inspection",
  currency: "localization",
  language: "localization",
};

export default function SettingsPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState<SectionId>("property-details");
  const [acceptanceMode, setAcceptanceMode] = useState<BookingAcceptanceMode>("instant");
  const [acceptanceLoadError, setAcceptanceLoadError] = useState("");
  const [loadingAcceptance, setLoadingAcceptance] = useState(true);
  const [savingAcceptance, setSavingAcceptance] = useState(false);
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
  }, [loadAcceptanceMode, loadCalendarSettings, loadPropertyProfile]);

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

  const sections: SettingsNavSection[] = [
    {
      id: "property-details",
      label: "Property",
      icon: HotelIcon,
    },
    { id: "booking-engine", label: "Booking Engine", icon: BoltIcon },
    { id: "calendar", label: "Calendar", icon: CalendarDaysIcon },
    {
      id: "check-in-out",
      label: t("settings.checkInCheckOut"),
      icon: ClockIcon,
    },
    {
      id: "checkin-checklist",
      label: "Check-in checklist",
      icon: ClipboardDocumentCheckIcon,
      href: "/settings/checkin-checklist",
    },
    {
      id: "checkout-inspection",
      label: "Check-out inspection",
      icon: ClipboardDocumentCheckIcon,
      href: "/settings/checkout-inspection",
    },
    { id: "localization", label: "Localization", icon: GlobeAltIcon },
  ];

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

      <BookingEngineSection
        instantBook={acceptanceMode === "instant"}
        saving={savingAcceptance || loadingAcceptance}
        loadError={acceptanceLoadError}
        onToggle={(next) => void saveAcceptanceMode(next)}
        onRetry={() => void loadAcceptanceMode()}
      />

      <CalendarSection
        enabled={autoRearrangeEnabled}
        loading={calendarLoading}
        saving={calendarSaving}
        loadError={calendarLoadError}
        onToggle={(next) => void saveAutoRearrange(next)}
        onRetry={() => void loadCalendarSettings()}
      />

      <UnavailableSettingsSection
        id="check-in-out"
        title={t("settings.checkInCheckOut")}
        description="Check-in and check-out time controls are not available in PMS yet."
      />

      <LocalizationSection
        currency={currency}
        currencyLoadError={currencyLoadError}
        currencyLoadStatus={currencyLoadStatus}
      />
    </SettingsLayout>
  );
}

function UnavailableSettingsSection({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <SettingsSection id={id} title={title} description={description}>
      <SettingsCard>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-gray-500">No settings can be changed here yet.</p>
          <span className="shrink-0 rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-600">
            Not available yet
          </span>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
