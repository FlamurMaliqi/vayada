"use client";

import { useState, useEffect } from "react";
import {
  BoltIcon,
  CalendarDaysIcon,
  ClockIcon,
  ClipboardDocumentCheckIcon,
  GlobeAltIcon,
} from "@heroicons/react/24/outline";
import { HotelIcon } from "@vayada/product-onboarding";
import { bookingsService } from "@/services/bookings";
import { channexService } from "@/services/channex";
import {
  getPmsCalendarSettings,
  getPmsPropertyProfile,
  updatePmsCalendarSettings,
  updatePmsPropertyProfile,
  type PmsCalendarSettings,
  type PmsPropertyProfile,
} from "@/services/api/pmsPropertyClient";
import { useTranslation } from "@/lib/i18n";
import { SettingsLayout, type SettingsNavSection } from "@/components/settings/layout";
import { PropertySection } from "@/components/settings/PropertySection";
import { BookingEngineSection } from "@/components/settings/BookingEngineSection";
import { CalendarSection } from "@/components/settings/CalendarSection";
import { CheckInOutSection } from "@/components/settings/CheckInOutSection";
import { LocalizationSection } from "@/components/settings/LocalizationSection";
import { humanizeApiError } from "@/components/settings/constants";

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

  // Currency
  const [currency, setCurrency] = useState("EUR");
  const [savingCurrency, setSavingCurrency] = useState(false);

  // Check-in / Check-out times
  const [checkInFrom, setCheckInFrom] = useState("14:00");
  const [checkInUntil, setCheckInUntil] = useState("22:00");
  const [checkOutFrom, setCheckOutFrom] = useState("07:00");
  const [checkOutUntil, setCheckOutUntil] = useState("11:00");
  const [savingTimes, setSavingTimes] = useState(false);

  // Property details — only fields Channex actually enforces (timezone + country).
  // Title/currency/contact-email live elsewhere; other address fields are filled
  // later by each OTA's own validation flow when needed.
  const [timezone, setTimezone] = useState("Asia/Makassar");
  const [country, setCountry] = useState("");
  const [savingProperty, setSavingProperty] = useState(false);

  // Booking engine
  const [instantBook, setInstantBook] = useState(false);
  const [savingInstantBook, setSavingInstantBook] = useState(false);
  const [sameDayBookingsEnabled, setSameDayBookingsEnabled] = useState(true);
  const [sameDayBookingCutoffTime, setSameDayBookingCutoffTime] = useState("18:00");
  const [savingSameDay, setSavingSameDay] = useState(false);
  const [channexConnected, setChannexConnected] = useState(false);

  // Calendar — VAY-397 auto-rearrange toggle
  const [autoRearrange, setAutoRearrange] = useState(true);
  const [savingAutoRearrange, setSavingAutoRearrange] = useState(false);
  const [autoOpenEnabled, setAutoOpenEnabled] = useState(false);
  const [autoOpenMode, setAutoOpenMode] = useState<"rolling" | "fixed">("rolling");
  const [autoOpenMonths, setAutoOpenMonths] = useState<12 | 18 | 24>(18);
  const [autoOpenFixedMonth, setAutoOpenFixedMonth] = useState("");
  const [autoOpenThrough, setAutoOpenThrough] = useState<string | null>(null);
  const [autoOpenWarnings, setAutoOpenWarnings] = useState<string[]>([]);

  useEffect(() => {
    bookingsService
      .getPaymentSettings()
      .then((res) => {
        setCurrency(res.paymentSettings.defaultCurrency || "EUR");
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    getPmsPropertyProfile()
      .then((h) => {
        if (h.timezone) setTimezone(h.timezone);
        if (h.country) setCountry(h.country);
        setInstantBook(Boolean(h.instant_book ?? h.instantBook));
        setSameDayBookingsEnabled(h.same_day_bookings_enabled ?? h.sameDayBookingsEnabled ?? true);
        setSameDayBookingCutoffTime(
          h.same_day_booking_cutoff_time ?? h.sameDayBookingCutoffTime ?? "18:00",
        );
      })
      .catch(() => {});

    channexService
      .getStatus()
      .then((status) => setChannexConnected(Boolean(status.isConnected)))
      .catch(() => setChannexConnected(false));

    getPmsCalendarSettings()
      .then((s) => {
        setAutoRearrange(Boolean(s.autoRearrangeEnabled));
        setAutoOpenEnabled(Boolean(s.autoOpenEnabled));
        setAutoOpenMode(s.autoOpenMode || "rolling");
        setAutoOpenMonths(s.autoOpenMonths || 18);
        setAutoOpenFixedMonth(s.autoOpenFixedMonth?.slice(0, 7) || "");
        setAutoOpenThrough(s.autoOpenThrough || null);
        setAutoOpenWarnings(s.autoOpenWarnings || []);
      })
      .catch(() => {});
  }, []);

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

  const saveTimes = async () => {
    setSavingTimes(true);
    setError("");
    setSuccess("");
    try {
      throw new Error("Check-in/out time settings are not available on PMS next-stack yet.");
    } catch (err: any) {
      setError(err.message || t("settings.failedToSaveTimes"));
    } finally {
      setSavingTimes(false);
    }
  };

  const savePropertyDetails = async () => {
    setSavingProperty(true);
    setError("");
    setSuccess("");
    try {
      // PATCH only the fields the form actually edits; the backend leaves
      // unsent fields untouched (so any address/lat-lon set during onboarding
      // or via a future OTA-specific flow is preserved).
      await updatePmsPropertyProfile({ timezone, country });
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

  const toggleAutoRearrange = async (next: boolean) => {
    setSavingAutoRearrange(true);
    setError("");
    setSuccess("");
    const previous = autoRearrange;
    setAutoRearrange(next);
    try {
      await updatePmsCalendarSettings({
        autoRearrangeEnabled: next,
      });
      setSuccess(
        next
          ? "Auto-rearrange enabled — new bookings will shuffle existing reservations when needed"
          : "Auto-rearrange disabled — bookings that don’t fit will go to Unassigned",
      );
    } catch (err: any) {
      setAutoRearrange(previous);
      setError(humanizeApiError(err, "Couldn’t update auto-rearrange setting. Please try again."));
    } finally {
      setSavingAutoRearrange(false);
    }
  };

  const saveAutoOpen = async () => {
    setSavingAutoRearrange(true);
    setError("");
    setSuccess("");
    try {
      const payload: Record<string, unknown> = {
        autoOpenEnabled,
        autoOpenMode,
        autoOpenMonths,
      };
      if (autoOpenMode === "fixed" && /^\d{4}-\d{2}$/.test(autoOpenFixedMonth)) {
        payload.autoOpenFixedMonth = `${autoOpenFixedMonth}-01`;
      }
      const saved = await updatePmsCalendarSettings(payload as Partial<PmsCalendarSettings>);
      setAutoOpenEnabled(Boolean(saved.autoOpenEnabled));
      setAutoOpenMode(saved.autoOpenMode || "rolling");
      setAutoOpenMonths(saved.autoOpenMonths || 18);
      setAutoOpenFixedMonth(saved.autoOpenFixedMonth?.slice(0, 7) || "");
      setAutoOpenThrough(saved.autoOpenThrough || null);
      setAutoOpenWarnings(saved.autoOpenWarnings || []);
      setSuccess(
        saved.autoOpenEnabled ? "Calendar auto-open settings saved" : "Calendar auto-open disabled",
      );
    } catch (err: any) {
      setError(
        humanizeApiError(err, "Couldn’t update calendar auto-open settings. Please try again."),
      );
    } finally {
      setSavingAutoRearrange(false);
    }
  };

  const toggleInstantBook = async (next: boolean) => {
    setSavingInstantBook(true);
    setError("");
    setSuccess("");
    const previous = instantBook;
    setInstantBook(next);
    try {
      await updatePmsPropertyProfile({ instant_book: next });
      setSuccess(next ? "Instant booking enabled" : "Booking requests re-enabled");
    } catch (err: any) {
      setInstantBook(previous);
      setError(
        humanizeApiError(
          err,
          "Couldn’t update booking acceptance setting. Please try again, or contact support if the issue persists.",
        ),
      );
    } finally {
      setSavingInstantBook(false);
    }
  };

  const saveSameDayBookingCutoff = async () => {
    setSavingSameDay(true);
    setError("");
    setSuccess("");
    try {
      const payload = {
        sameDayBookingsEnabled,
        sameDayBookingCutoffTime: sameDayBookingsEnabled ? sameDayBookingCutoffTime : null,
      };
      const h = await updatePmsPropertyProfile(payload as Partial<PmsPropertyProfile>);
      setSameDayBookingsEnabled(
        h.same_day_bookings_enabled ?? h.sameDayBookingsEnabled ?? sameDayBookingsEnabled,
      );
      setSameDayBookingCutoffTime(
        h.same_day_booking_cutoff_time ?? h.sameDayBookingCutoffTime ?? "18:00",
      );
      setSuccess("Same-day booking cutoff saved");
    } catch (err: any) {
      setError(humanizeApiError(err, "Couldn’t update same-day booking cutoff. Please try again."));
    } finally {
      setSavingSameDay(false);
    }
  };

  const saveCurrency = async () => {
    setSavingCurrency(true);
    setError("");
    setSuccess("");
    try {
      await bookingsService.updatePaymentSettings({ defaultCurrency: currency });
      setSuccess(t("settings.currencySaved"));
    } catch (err: any) {
      setError(err.message || t("settings.failedToSaveCurrency"));
    } finally {
      setSavingCurrency(false);
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
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
          {success}
        </div>
      )}

      <PropertySection
        timezone={timezone}
        setTimezone={setTimezone}
        country={country}
        setCountry={setCountry}
        saving={savingProperty}
        onSave={savePropertyDetails}
      />

      <BookingEngineSection
        instantBook={instantBook}
        saving={savingInstantBook}
        onToggle={toggleInstantBook}
        sameDayBookingsEnabled={sameDayBookingsEnabled}
        sameDayBookingCutoffTime={sameDayBookingCutoffTime}
        savingSameDay={savingSameDay}
        channexConnected={channexConnected}
        onSameDayEnabledChange={setSameDayBookingsEnabled}
        onSameDayCutoffTimeChange={setSameDayBookingCutoffTime}
        onSaveSameDay={saveSameDayBookingCutoff}
      />

      <CalendarSection
        autoRearrange={autoRearrange}
        autoOpenEnabled={autoOpenEnabled}
        autoOpenMode={autoOpenMode}
        autoOpenMonths={autoOpenMonths}
        autoOpenFixedMonth={autoOpenFixedMonth}
        autoOpenThrough={autoOpenThrough}
        autoOpenWarnings={autoOpenWarnings}
        saving={savingAutoRearrange}
        onToggle={toggleAutoRearrange}
        onAutoOpenEnabledChange={setAutoOpenEnabled}
        onAutoOpenModeChange={setAutoOpenMode}
        onAutoOpenMonthsChange={setAutoOpenMonths}
        onAutoOpenFixedMonthChange={setAutoOpenFixedMonth}
        onSaveAutoOpen={saveAutoOpen}
      />

      <CheckInOutSection
        checkInFrom={checkInFrom}
        setCheckInFrom={setCheckInFrom}
        checkInUntil={checkInUntil}
        setCheckInUntil={setCheckInUntil}
        checkOutFrom={checkOutFrom}
        setCheckOutFrom={setCheckOutFrom}
        checkOutUntil={checkOutUntil}
        setCheckOutUntil={setCheckOutUntil}
        saving={savingTimes}
        onSave={saveTimes}
      />

      <LocalizationSection
        currency={currency}
        setCurrency={setCurrency}
        savingCurrency={savingCurrency}
        onSaveCurrency={saveCurrency}
      />
    </SettingsLayout>
  );
}
