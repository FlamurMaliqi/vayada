"use client";

import { SettingsSection, SettingsCard } from "@vayada/settings-ui";
import { ArrivalTimesSection } from "./ArrivalTimesSection";
import { useTranslation } from "@/lib/i18n";

interface BookingEngineSectionProps {
  instantBook: boolean;
  saving: boolean;
  loadError: string;
  onToggle: (next: boolean) => void;
  onRetry: () => void;
}

export function BookingEngineSection({
  instantBook,
  saving,
  loadError,
  onToggle,
  onRetry,
}: BookingEngineSectionProps) {
  const { t } = useTranslation();

  return (
    <SettingsSection
      id="booking-engine"
      title={t("settings.bookingEngine.title")}
      description={t("settings.bookingEngine.description")}
    >
      <SettingsCard>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900">
              {t("settings.bookingEngine.instant")}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {instantBook
                ? t("settings.bookingEngine.instantOn")
                : t("settings.bookingEngine.instantOff")}
            </p>
            <p className="text-[11px] text-gray-400 mt-2">
              {t("settings.bookingEngine.bankTransfer")}
            </p>
          </div>
          {loadError ? (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              {t("settings.retry")}
            </button>
          ) : (
            <button
              type="button"
              role="switch"
              aria-label={t("settings.bookingEngine.instant")}
              aria-checked={instantBook}
              disabled={saving}
              onClick={() => onToggle(!instantBook)}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:opacity-50 ${
                instantBook ? "bg-primary-600" : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                  instantBook ? "translate-x-5" : "translate-x-0.5"
                }`}
              />
            </button>
          )}
        </div>
        {loadError && <p className="mt-3 text-xs text-red-600">{loadError}</p>}
      </SettingsCard>
      <ArrivalTimesSection />
    </SettingsSection>
  );
}
