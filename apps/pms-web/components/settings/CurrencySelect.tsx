"use client";

import { useEffect, useRef, useState } from "react";
import { CURRENCIES } from "./constants";

interface CurrencySelectProps {
  value: string;
  onChange: (v: string) => void;
  t: (key: string) => string;
}

export function CurrencySelect({ value, onChange, t }: CurrencySelectProps) {
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

  const filtered = CURRENCIES.filter((c) => c.label.toLowerCase().includes(search.toLowerCase()));

  const selectedLabel = CURRENCIES.find((c) => c.value === value)?.label ?? value;

  return (
    <div ref={ref} className="relative w-full sm:max-w-xs">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setSearch("");
        }}
        className="w-full px-3 py-2 text-sm text-left border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white flex items-center justify-between"
      >
        <span>{selectedLabel}</span>
        <svg
          className="w-4 h-4 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-gray-300 rounded-lg shadow-lg">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("settings.searchCurrency")}
            autoFocus
            className="w-full px-3 py-2 text-sm border-b border-gray-200 focus:outline-none rounded-t-lg"
          />
          <ul className="max-h-60 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-400">{t("common.noResults")}</li>
            ) : (
              filtered.map((c) => (
                <li
                  key={c.value}
                  onClick={() => {
                    onChange(c.value);
                    setOpen(false);
                  }}
                  className={`px-3 py-2 text-sm cursor-pointer hover:bg-primary-50 ${
                    c.value === value
                      ? "bg-primary-50 font-medium text-primary-700"
                      : "text-gray-700"
                  }`}
                >
                  {c.label}
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
