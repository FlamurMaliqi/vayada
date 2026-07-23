"use client";

import { SettingsSection, SettingsCard } from "./layout";
import { useTranslation, SUPPORTED_LANGUAGES } from "@/lib/i18n";

interface LocalizationSectionProps {
  currency: string;
  currencyLoadError: string;
}

export function LocalizationSection({ currency, currencyLoadError }: LocalizationSectionProps) {
  const { t, locale, setLocale } = useTranslation();

  return (
    <SettingsSection
      id="localization"
      title="Localization"
      description="Default currency and interface language."
    >
      <SettingsCard title={t("settings.currency")} description={t("settings.currencyDescription")}>
        <div id="currency" className="scroll-mt-24">
          {currencyLoadError ? (
            <p className="text-sm text-red-600" role="alert">
              {currencyLoadError}
            </p>
          ) : currency ? (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <span className="text-sm font-medium text-gray-700">{currency}</span>
              <span className="text-[11px] font-medium text-gray-500">
                Editing not available yet
              </span>
            </div>
          ) : (
            <p className="text-sm text-gray-500" role="status">
              Loading persisted currency…
            </p>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title={t("settings.language")} description={t("settings.languageDescription")}>
        <div
          id="language"
          className="scroll-mt-24 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"
        >
          {SUPPORTED_LANGUAGES.map((lang) => (
            <button
              key={lang.code}
              type="button"
              onClick={() => setLocale(lang.code)}
              className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors ${
                locale === lang.code
                  ? "bg-primary-50 border-primary-300 text-primary-700 font-medium"
                  : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
              }`}
            >
              <span>{lang.flag}</span>
              <span className="truncate">{lang.nativeName}</span>
            </button>
          ))}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
