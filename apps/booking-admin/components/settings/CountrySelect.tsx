"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "@/lib/i18n";
import { STRIPE_COUNTRIES } from "@/lib/constants/stripeCountries";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface CountrySelectProps {
  value: string;
  onChange: (v: string) => void;
  t: Translate;
}

export function CountrySelect({ value, onChange, t }: CountrySelectProps) {
  const { locale } = useTranslation();
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const countries = STRIPE_COUNTRIES.map((country) => ({
    ...country,
    n: names.of(country.c) ?? country.n,
  }));
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const filtered = countries.filter(
    (c) =>
      c.n.toLowerCase().includes(search.toLowerCase()) ||
      c.c.toLowerCase().includes(search.toLowerCase()),
  );
  const selected = countries.find((c) => c.c === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setSearch("");
        }}
        className="w-full px-2.5 py-1.5 text-left border border-gray-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white flex items-center justify-between"
      >
        <span>
          {selected ? `${selected.f} ${selected.n}` : t("settings.billing.selectCountry")}
        </span>
        <svg
          className="w-3.5 h-3.5 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg">
          <div className="p-1.5">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("settings.billing.searchCountry")}
              autoFocus
              className="w-full px-2.5 py-1.5 text-[13px] border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <ul className="max-h-52 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-[13px] text-gray-400">
                {t("settings.billing.noResults")}
              </li>
            ) : (
              filtered.map((c) => (
                <li
                  key={c.c}
                  onClick={() => {
                    onChange(c.c);
                    setOpen(false);
                  }}
                  className={`px-3 py-1.5 text-[13px] cursor-pointer hover:bg-primary-50 flex items-center gap-2 ${
                    c.c === value ? "bg-primary-50 font-medium text-primary-700" : "text-gray-700"
                  }`}
                >
                  <span>{c.f}</span>
                  <span>{c.n}</span>
                  <span className="text-gray-400 text-[11px] ml-auto">{c.c}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
