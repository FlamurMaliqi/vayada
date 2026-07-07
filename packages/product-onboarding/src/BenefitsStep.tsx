"use client";

import { useState } from "react";
import { PlusIcon, XMarkIcon, CheckIcon } from "@heroicons/react/24/outline";

const BENEFIT_OPTIONS = [
  "Welcome Drink on Arrival",
  "10% Spa Discount",
  "Late Check-out (subject to availability)",
  "Early Check-in (subject to availability)",
  "Free Airport Transfer",
  "Daily Breakfast Included",
  "Room Upgrade (subject to availability)",
];

interface BenefitsStepProps {
  benefits: string[];
  setBenefits: (v: string[]) => void;
  error: string;
  canProceed: boolean;
  onBack: () => void;
  onContinue: () => void;
  stepIndicators: React.ReactNode;
}

export default function BenefitsStep({
  benefits,
  setBenefits,
  error,
  canProceed,
  onBack,
  onContinue,
  stepIndicators,
}: BenefitsStepProps) {
  const [benefitInput, setBenefitInput] = useState("");

  const addCustomBenefit = () => {
    const trimmed = benefitInput.trim();
    if (trimmed && !benefits.includes(trimmed)) {
      setBenefits([...benefits, trimmed]);
    }
    setBenefitInput("");
  };

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 py-6">
      {stepIndicators}

      <h1 className="text-xl font-bold text-gray-900 mb-1">Book Direct Benefits</h1>
      <p className="text-[13px] text-gray-500 mb-6">
        Encourage guests to book directly on your website instead of OTAs. These benefits appear in
        the room detail modal and apply to all rooms.
      </p>

      <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 space-y-5">
        <div>
          <h3 className="text-[11px] font-bold text-gray-900 uppercase tracking-widest mb-1">
            Select Benefits
          </h3>
          <p className="text-[10px] text-gray-400 mb-3">
            Choose from common benefits or add your own custom ones below.
          </p>
        </div>

        <div className="space-y-2">
          {BENEFIT_OPTIONS.map((benefit) => {
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
                <span className="text-[12px] text-gray-700">{benefit}</span>
              </button>
            );
          })}
        </div>

        {/* Custom benefit input */}
        <div>
          <label className="block text-[11px] text-gray-500 mb-1.5">
            Custom Benefit <span className="text-gray-400">(optional)</span>
          </label>
          <div className="flex gap-2">
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
              className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
              placeholder="e.g. Complimentary sunset cocktail"
            />
            <button
              type="button"
              onClick={addCustomBenefit}
              className="px-3 py-2 border border-gray-200 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
            >
              <PlusIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Selected custom benefits */}
        {benefits.filter((b) => !BENEFIT_OPTIONS.includes(b)).length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px] text-gray-400 uppercase tracking-wider">
              Custom benefits
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

        <p className="text-[10px] text-gray-400">
          {benefits.length} benefit{benefits.length !== 1 ? "s" : ""} selected
        </p>
      </div>

      {error && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-[11px] text-red-700 font-medium">{error}</p>
        </div>
      )}

      <div className="mt-6 flex items-center justify-between">
        <button
          onClick={onBack}
          className="px-5 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Back
        </button>
        <button
          onClick={onContinue}
          className="px-5 py-2 text-[13px] font-semibold bg-primary-500 text-white rounded-lg hover:bg-primary-600 transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
