"use client";

import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { MonthlyRate } from "@/services/rooms";
import { useTranslation } from "@/lib/i18n";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface MonthlyRatesEditorProps {
  monthlyRates: Record<string, MonthlyRate>;
  defaultBaseRate: number;
  defaultNonRefundableRate: number | null | undefined;
  onChange: (rates: Record<string, MonthlyRate>) => void;
}

export default function MonthlyRatesEditor({
  monthlyRates,
  defaultBaseRate,
  defaultNonRefundableRate,
  onChange,
}: MonthlyRatesEditorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const handleChange = (month: number, field: "baseRate" | "nonRefundableRate", value: string) => {
    const key = String(month);
    const existing = monthlyRates[key] || {};
    const numVal = value === "" ? null : parseFloat(value);

    const updated = { ...existing, [field]: numVal };

    // If both fields are null/empty, remove the month entry
    if (updated.baseRate == null && updated.nonRefundableRate == null) {
      const next = { ...monthlyRates };
      delete next[key];
      onChange(next);
    } else {
      onChange({ ...monthlyRates, [key]: updated });
    }
  };

  const overrideCount = Object.keys(monthlyRates).length;

  return (
    <div className="bg-white border border-gray-200 rounded-xl">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-6"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900">{t("rooms.form.monthlyPricing")}</h2>
          {overrideCount > 0 && (
            <span className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded-full">
              {t(
                overrideCount === 1
                  ? "rooms.form.monthlyPricingOverride"
                  : "rooms.form.monthlyPricingOverrides",
                { count: overrideCount },
              )}
            </span>
          )}
        </div>
        {open ? (
          <ChevronDownIcon className="w-4 h-4 text-gray-400" />
        ) : (
          <ChevronRightIcon className="w-4 h-4 text-gray-400" />
        )}
      </button>

      {open && (
        <div className="px-6 pb-6 space-y-1">
          <p className="text-xs text-gray-500 mb-3">{t("rooms.form.monthlyPricingHint")}</p>

          <div className="grid grid-cols-[1fr_1fr_1fr] gap-x-3 gap-y-0 text-xs font-medium text-gray-500 mb-2">
            <span>{t("calendar.viewMonth")}</span>
            <span>{t("rooms.form.baseRateColumn")}</span>
            <span>{t("rooms.form.nonRefundableColumn")}</span>
          </div>

          {MONTHS.map((name, idx) => {
            const month = idx + 1;
            const key = String(month);
            const entry = monthlyRates[key] || {};
            return (
              <div key={month} className="grid grid-cols-[1fr_1fr_1fr] gap-x-3 items-center py-1.5">
                <span className="text-sm text-gray-700">{name}</span>
                <input
                  type="number"
                  step="0.01"
                  value={entry.baseRate ?? ""}
                  onChange={(e) => handleChange(month, "baseRate", e.target.value)}
                  placeholder={String(defaultBaseRate)}
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
                <input
                  type="number"
                  step="0.01"
                  value={entry.nonRefundableRate ?? ""}
                  onChange={(e) => handleChange(month, "nonRefundableRate", e.target.value)}
                  placeholder={
                    defaultNonRefundableRate != null ? String(defaultNonRefundableRate) : "auto"
                  }
                  className="w-full px-2.5 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
