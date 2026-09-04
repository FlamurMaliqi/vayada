"use client";

import { SettingsSection, SettingsCard } from "@vayada/settings-ui";
import { useTranslation } from "@/lib/i18n";

interface CheckInOutSectionProps {
  checkInFrom: string;
  setCheckInFrom: (v: string) => void;
  checkInUntil: string;
  setCheckInUntil: (v: string) => void;
  checkOutFrom: string;
  setCheckOutFrom: (v: string) => void;
  checkOutUntil: string;
  setCheckOutUntil: (v: string) => void;
  saving: boolean;
  onSave: () => void;
}

const timeInputClass =
  "w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent";

export function CheckInOutSection({
  checkInFrom,
  setCheckInFrom,
  checkInUntil,
  setCheckInUntil,
  checkOutFrom,
  setCheckOutFrom,
  checkOutUntil,
  setCheckOutUntil,
  saving,
  onSave,
}: CheckInOutSectionProps) {
  const { t } = useTranslation();

  return (
    <SettingsSection
      id="check-in-out"
      title={t("settings.checkInCheckOut")}
      description={t("settings.checkInCheckOutDescription")}
    >
      <SettingsCard
        footer={
          <div className="flex justify-end">
            <button
              onClick={onSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 md:gap-6">
          <TimePeriod
            label={t("settings.checkInPeriod")}
            fromLabel={t("common.from")}
            untilLabel={t("common.until")}
            fromValue={checkInFrom}
            untilValue={checkInUntil}
            onFromChange={setCheckInFrom}
            onUntilChange={setCheckInUntil}
            help={t("settings.checkInExample")}
          />
          <TimePeriod
            label={t("settings.checkOutPeriod")}
            fromLabel={t("common.from")}
            untilLabel={t("common.until")}
            fromValue={checkOutFrom}
            untilValue={checkOutUntil}
            onFromChange={setCheckOutFrom}
            onUntilChange={setCheckOutUntil}
            help={t("settings.checkOutExample")}
          />
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

function TimePeriod({
  label,
  fromLabel,
  untilLabel,
  fromValue,
  untilValue,
  onFromChange,
  onUntilChange,
  help,
}: {
  label: string;
  fromLabel: string;
  untilLabel: string;
  fromValue: string;
  untilValue: string;
  onFromChange: (v: string) => void;
  onUntilChange: (v: string) => void;
  help: string;
}) {
  return (
    <div>
      <label className="block text-[12px] font-semibold text-gray-700 mb-2">{label}</label>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="block text-[10px] text-gray-400 mb-0.5">{fromLabel}</label>
          <input
            type="time"
            value={fromValue}
            onChange={(e) => onFromChange(e.target.value)}
            className={timeInputClass}
          />
        </div>
        <span className="text-gray-400 mt-4">—</span>
        <div className="flex-1">
          <label className="block text-[10px] text-gray-400 mb-0.5">{untilLabel}</label>
          <input
            type="time"
            value={untilValue}
            onChange={(e) => onUntilChange(e.target.value)}
            className={timeInputClass}
          />
        </div>
      </div>
      <p className="text-[10px] text-gray-400 mt-1">{help}</p>
    </div>
  );
}
