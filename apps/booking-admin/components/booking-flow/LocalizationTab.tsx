"use client";

import { useEffect, useRef, useState } from "react";
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import { LocalizationMultiSelect } from "@vayada/product-onboarding/LocalizationMultiSelect";
import { useTranslation } from "@/lib/i18n";
import { SaveButton } from "@/components/ui";
import {
  CURRENCY_OPTIONS,
  LANGUAGE_OPTIONS,
  POPULAR_CURRENCY_CODES,
  POPULAR_LANGUAGE_CODES,
} from "@/lib/constants/options";
import type { CurrencyOption, LanguageOption } from "@/lib/constants/options";

interface LocalizationTabProps {
  defaultCurrency: string;
  setDefaultCurrency: (code: string) => void;
  defaultLanguage: string;
  setDefaultLanguage: (code: string) => void;
  supportedCurrencies: string[];
  setSupportedCurrencies: React.Dispatch<React.SetStateAction<string[]>>;
  supportedLanguages: string[];
  setSupportedLanguages: React.Dispatch<React.SetStateAction<string[]>>;
  onSave: () => void;
  saving: boolean;
}

export default function LocalizationTab({
  defaultCurrency,
  setDefaultCurrency,
  defaultLanguage,
  setDefaultLanguage,
  supportedCurrencies,
  setSupportedCurrencies,
  supportedLanguages,
  setSupportedLanguages,
  onSave,
  saving,
}: LocalizationTabProps) {
  const { t } = useTranslation();

  const toggleCurrency = (code: string) => {
    setSupportedCurrencies((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const toggleLanguage = (code: string) => {
    setSupportedLanguages((prev) =>
      prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code],
    );
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 md:p-5 space-y-4">
      <div className="flex items-center gap-1.5">
        <GlobeAltIcon className="w-4 h-4 text-gray-700" />
        <h2 className="text-sm font-semibold text-gray-900">
          {t("bookingFlow.localization.title")}
        </h2>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
            {t("bookingFlow.localization.defaultCurrency")} <span className="text-gray-700">*</span>
          </label>
          <FlagSelect<CurrencyOption>
            value={defaultCurrency}
            onChange={(code) => {
              const oldDefault = defaultCurrency;
              setDefaultCurrency(code);
              setSupportedCurrencies((prev) => {
                const without = prev.filter((c) => c !== code);
                return oldDefault && !without.includes(oldDefault)
                  ? [...without, oldDefault]
                  : without;
              });
            }}
            options={CURRENCY_OPTIONS}
            getLabel={(o) => o.name}
          />
        </div>
        <div>
          <label className="block text-[13px] font-medium text-gray-700 mb-0.5">
            {t("bookingFlow.localization.defaultLanguage")} <span className="text-gray-700">*</span>
          </label>
          <FlagSelect<LanguageOption>
            value={defaultLanguage}
            onChange={(code) => {
              const oldDefault = defaultLanguage;
              setDefaultLanguage(code);
              setSupportedLanguages((prev) => {
                const without = prev.filter((l) => l !== code);
                return oldDefault && !without.includes(oldDefault)
                  ? [...without, oldDefault]
                  : without;
              });
            }}
            options={LANGUAGE_OPTIONS}
            getLabel={(o) => o.name}
          />
        </div>
      </div>

      <div>
        <label
          htmlFor="booking-localization-additional-currencies"
          className="block text-[13px] text-gray-700 mb-1"
        >
          <span className="font-medium">{t("bookingFlow.localization.additionalCurrencies")}</span>{" "}
          <span className="text-gray-400 font-normal text-[11px]">
            {t("bookingFlow.localization.optional")}
          </span>
        </label>
        <LocalizationMultiSelect<CurrencyOption>
          id="booking-localization-additional-currencies"
          selected={supportedCurrencies}
          onToggle={toggleCurrency}
          options={CURRENCY_OPTIONS}
          excludeCode={defaultCurrency}
          placeholder={`Search currencies, e.g. "Swiss" or "CHF"...`}
          getLabel={(o) => o.code}
          getSearchLabel={(o) => `${o.name} · ${o.code}`}
          popularCodes={POPULAR_CURRENCY_CODES}
          emptyMessage={`No additional currencies added — your booking page will show only ${defaultCurrency}`}
        />
      </div>

      <div>
        <label
          htmlFor="booking-localization-additional-languages"
          className="block text-[13px] text-gray-700 mb-1"
        >
          <span className="font-medium">{t("bookingFlow.localization.additionalLanguages")}</span>{" "}
          <span className="text-gray-400 font-normal text-[11px]">
            {t("bookingFlow.localization.optional")}
          </span>
        </label>
        <LocalizationMultiSelect<LanguageOption>
          id="booking-localization-additional-languages"
          selected={supportedLanguages}
          onToggle={toggleLanguage}
          options={LANGUAGE_OPTIONS}
          excludeCode={defaultLanguage}
          placeholder={`Search languages, e.g. "German" or "Deutsch"...`}
          getLabel={(o) => o.nativeName}
          getSearchLabel={(o) => `${o.name} · ${o.nativeName}`}
          popularCodes={POPULAR_LANGUAGE_CODES}
          emptyMessage={`No additional languages added — your booking page will show only ${defaultLanguage.toUpperCase()}`}
        />
      </div>

      <div className="flex justify-end">
        <SaveButton onClick={onSave} saving={saving} />
      </div>
    </div>
  );
}

function FlagSelect<T extends { code: string; flag: string }>({
  value,
  onChange,
  options,
  getLabel,
}: {
  value: string;
  onChange: (code: string) => void;
  options: T[];
  getLabel: (opt: T) => string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const selected = options.find((o) => o.code === value);
  const filtered = options.filter(
    (o) =>
      getLabel(o).toLowerCase().includes(search.toLowerCase()) ||
      o.code.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setSearch("");
        }}
        className="w-full flex items-center justify-between px-2.5 py-1.5 border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white text-gray-900"
      >
        <span>{selected ? `${selected.flag} ${getLabel(selected)}` : "Select..."}</span>
        <svg
          className={`w-3.5 h-3.5 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg">
          <div className="p-1.5">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              autoFocus
              className="w-full px-2.5 py-1.5 text-[13px] border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[13px] text-gray-400">No results</div>
            ) : (
              filtered.map((opt) => (
                <button
                  key={opt.code}
                  type="button"
                  onClick={() => {
                    onChange(opt.code);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-[13px] text-left hover:bg-gray-50 ${opt.code === value ? "bg-gray-50 font-medium" : ""}`}
                >
                  {opt.code === value && (
                    <svg
                      className="w-3.5 h-3.5 text-gray-700 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                  {opt.code !== value && <span className="w-3.5 flex-shrink-0" />}
                  <span>
                    {opt.flag} {getLabel(opt)}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
