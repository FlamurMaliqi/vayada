"use client";
import { useTranslation } from "@/lib/i18n";

import { XMarkIcon, CheckIcon } from "@heroicons/react/24/outline";

const BENEFIT_OPTIONS = [
  "Welcome Drink on Arrival",
  "10% Spa Discount",
  "Late Check-out (subject to availability)",
  "Early Check-in (subject to availability)",
  "Free Airport Transfer",
  "Daily Breakfast Included",
  "Room Upgrade (subject to availability)",
];

interface BenefitsTabProps {
  benefits: string[];
  setBenefits: (benefits: string[]) => void;
  benefitInput: string;
  setBenefitInput: (value: string) => void;
  saveBenefits: () => void;
  savingBenefits: boolean;
}

export default function BenefitsTab({
  benefits,
  setBenefits,
  benefitInput,
  setBenefitInput,
  saveBenefits,
  savingBenefits,
}: BenefitsTabProps) {
  const { t } = useTranslation();
  const addCustomBenefit = () => {
    const trimmed = benefitInput.trim();
    if (trimmed && !benefits.includes(trimmed)) {
      setBenefits([...benefits, trimmed]);
    }
    setBenefitInput("");
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5">
      <h3 className="text-[14px] font-semibold text-gray-900 mb-0.5">
        {t("bookingFlow.benefits.title")}
      </h3>
      <p className="text-[12px] text-gray-500 mb-4">{t("bookingFlow.benefits.subtitle")}</p>

      <div className="space-y-2 mb-4">
        {BENEFIT_OPTIONS.map((benefit, index) => {
          const isSelected = benefits.includes(benefit);
          return (
            <button
              key={benefit}
              type="button"
              onClick={() => {
                if (isSelected) {
                  setBenefits(benefits.filter((b) => b !== benefit));
                } else {
                  setBenefits([...benefits, benefit]);
                }
              }}
              className={`w-full flex items-center gap-3 px-4 py-2 rounded-lg border text-left transition-colors ${
                isSelected
                  ? "border-primary-300 bg-primary-50/30"
                  : "border-gray-200 bg-gray-50 hover:bg-gray-100"
              }`}
            >
              <div
                className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                  isSelected ? "border-primary-500 bg-primary-500" : "border-gray-300"
                }`}
              >
                {isSelected && <CheckIcon className="w-2 h-2 text-white" />}
              </div>
              <span className="text-[12px] text-gray-700">{t(`benefits.option.${index}`)}</span>
            </button>
          );
        })}
      </div>

      {/* Custom benefit input */}
      <div className="mb-4">
        <label className="block text-[11px] text-gray-500 mb-1.5">
          {t("bookingFlow.benefits.customBenefitLabel")}
          <span className="text-gray-400">{t("common.optional")}</span>
        </label>
        <input
          type="text"
          value={benefitInput}
          onChange={(e) => setBenefitInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustomBenefit();
            }
          }}
          className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
          placeholder={t("bookingFlow.benefits.customBenefitPlaceholder")}
        />
      </div>

      {/* Selected custom benefits */}
      {benefits.filter((b) => !BENEFIT_OPTIONS.includes(b)).length > 0 && (
        <div className="mb-4 space-y-1">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider">
            {t("bookingFlow.benefits.customBenefits")}
          </span>
          <div className="flex flex-wrap gap-2">
            {benefits
              .filter((b) => !BENEFIT_OPTIONS.includes(b))
              .map((b, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2.5 py-1 bg-primary-50 text-primary-700 text-[11px] font-medium rounded-full border border-primary-200"
                >
                  {b}
                  <button
                    type="button"
                    onClick={() => setBenefits(benefits.filter((x) => x !== b))}
                    className="text-primary-400 hover:text-primary-600"
                  >
                    <XMarkIcon className="w-3 h-3" />
                  </button>
                </span>
              ))}
          </div>
        </div>
      )}

      <button
        onClick={saveBenefits}
        disabled={savingBenefits}
        className="px-4 py-2 text-[13px] font-medium text-white bg-primary-500 rounded-lg hover:bg-primary-600 disabled:opacity-50 transition-colors flex items-center gap-1.5"
      >
        {savingBenefits && (
          <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        )}
        {savingBenefits ? t("bookingFlow.benefits.saving") : t("bookingFlow.benefits.save")}
      </button>
    </div>
  );
}
