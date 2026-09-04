"use client";

import { SettingsSection, SettingsCard, FormRow } from "@vayada/settings-ui";
import { TIMEZONE_OPTIONS } from "./constants";
import {
  canSavePmsPropertyDetails,
  type PmsPropertyProfileLoadStatus,
} from "@/lib/settings/propertyDetails";
import { useTranslation } from "@/lib/i18n";

const inputClass =
  "w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white";

interface PropertySectionProps {
  timezone: string;
  setTimezone: (v: string) => void;
  country: string;
  setCountry: (v: string) => void;
  saving: boolean;
  loadStatus: PmsPropertyProfileLoadStatus;
  loadError: string;
  onRetry: () => void;
  onSave: () => void;
}

export function PropertySection({
  timezone,
  setTimezone,
  country,
  setCountry,
  saving,
  loadStatus,
  loadError,
  onRetry,
  onSave,
}: PropertySectionProps) {
  const { t } = useTranslation();
  const fieldsDisabled = saving || loadStatus !== "ready";
  const saveDisabled =
    saving || canSavePmsPropertyDetails({ loadStatus, timezone, country }) === false;

  return (
    <SettingsSection
      id="property-details"
      title={t("settings.property.title")}
      description={t("settings.property.description")}
    >
      <SettingsCard
        footer={
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onSave}
              disabled={saveDisabled}
              className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        }
      >
        {loadStatus === "loading" && (
          <p className="mb-4 text-sm text-gray-600" role="status">
            {t("settings.property.loading")}
          </p>
        )}
        {loadStatus === "error" && (
          <div
            className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
            role="alert"
          >
            <span>{loadError || t("settings.property.loadError")}</span>
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded-md border border-red-300 bg-white px-3 py-1.5 font-medium text-red-700 hover:bg-red-100"
            >
              {t("settings.retry")}
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormRow label={t("settings.property.timezone")} htmlFor="pms-property-timezone" required>
            <select
              id="pms-property-timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              disabled={fieldsDisabled}
              className={inputClass}
            >
              <option value="" disabled>
                {t("settings.property.selectTimezone")}
              </option>
              {timezone && !TIMEZONE_OPTIONS.includes(timezone) && (
                <option value={timezone}>{timezone}</option>
              )}
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </FormRow>

          <FormRow label={t("settings.property.country")} htmlFor="pms-property-country" required>
            <input
              id="pms-property-country"
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
              disabled={fieldsDisabled}
              placeholder={t("settings.property.countryPlaceholder")}
              maxLength={2}
              className={inputClass}
            />
          </FormRow>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
