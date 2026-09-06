"use client";

import { useEffect, useId, useRef, useState } from "react";

export function filterLocalizationOptions<T extends { code: string }>(
  options: readonly T[],
  excludeCode: string,
  query: string,
  getSearchLabel: (option: T) => string,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  return options.filter(
    (option) =>
      option.code !== excludeCode &&
      (!normalizedQuery ||
        `${option.code} ${getSearchLabel(option)}`.toLowerCase().includes(normalizedQuery)),
  );
}

export function LocalizationMultiSelect<T extends { code: string; flag: string }>({
  id,
  selected,
  onToggle,
  options,
  excludeCode,
  placeholder,
  getLabel,
  getSearchLabel,
  popularCodes,
  emptyMessage,
  comfortable = false,
  copy,
}: {
  id?: string;
  selected: string[];
  onToggle: (code: string) => void;
  options: readonly T[];
  excludeCode: string;
  placeholder: string;
  getLabel: (option: T) => string;
  getSearchLabel: (option: T) => string;
  popularCodes: readonly string[];
  emptyMessage: string;
  comfortable?: boolean;
  copy?: {
    noResults: string;
    popular: string;
    added: (count: number) => string;
    remove: (name: string) => string;
  };
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const resultsId = `${inputId}-results`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const available = filterLocalizationOptions(options, excludeCode, "", getSearchLabel);
  const filtered = filterLocalizationOptions(options, excludeCode, query, getSearchLabel);
  const popular = available.filter((option) => popularCodes.includes(option.code));
  const selectedItems = selected
    .filter((code) => code !== excludeCode)
    .map((code) => {
      const option = options.find((candidate) => candidate.code === code);
      return {
        code,
        flag: option?.flag ?? "",
        label: option ? getLabel(option) : code,
      };
    });
  const showResults = open && Boolean(query.trim());

  return (
    <div ref={ref}>
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={resultsId}
          aria-expanded={showResults}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className={
            comfortable
              ? "w-full rounded-xl border border-gray-200 bg-gray-50 py-2.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-transparent focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
              : "w-full rounded-lg border border-gray-300 bg-white py-1.5 pl-9 pr-3 text-[13px] text-gray-900 placeholder:text-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500"
          }
        />
        {showResults && (
          <div
            id={resultsId}
            role={filtered.length === 0 ? "status" : "listbox"}
            aria-multiselectable={filtered.length === 0 ? undefined : true}
            className={`absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto border border-gray-200 bg-white shadow-lg ${comfortable ? "rounded-xl" : "rounded-lg"}`}
          >
            {filtered.length === 0 ? (
              <p
                className={
                  comfortable
                    ? "px-3 py-2 text-sm text-gray-400"
                    : "px-3 py-2 text-[13px] text-gray-400"
                }
              >
                {copy?.noResults ?? "No results found"}
              </p>
            ) : (
              filtered.map((option) => {
                const isSelected = selected.includes(option.code);
                return (
                  <button
                    key={option.code}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onToggle(option.code);
                      setQuery("");
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${comfortable ? "text-sm" : "text-[13px]"} ${isSelected ? "bg-primary-500 text-white" : "text-gray-900 hover:bg-gray-50"}`}
                  >
                    <span>{option.flag}</span>
                    <span>{getSearchLabel(option)}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      <div className={comfortable ? "mt-2.5" : "mt-2"}>
        <p
          className={
            comfortable
              ? "mb-1.5 text-xs font-medium text-gray-400"
              : "mb-1.5 text-[11px] font-medium text-gray-400"
          }
        >
          {copy?.popular ?? "Popular choices —"}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {popular.map((option) => {
            const isSelected = selected.includes(option.code);
            return (
              <button
                key={option.code}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onToggle(option.code)}
                className={`inline-flex items-center gap-1 rounded-full font-medium transition-colors ${comfortable ? "px-2.5 py-1 text-xs" : "px-2.5 py-0.5 text-[11px]"} ${
                  isSelected
                    ? "border border-primary-300 bg-primary-100 text-primary-700"
                    : "border border-gray-200 bg-gray-50 text-gray-600 hover:bg-gray-100"
                }`}
              >
                {option.flag} {getLabel(option)}
              </button>
            );
          })}
        </div>
      </div>

      {selectedItems.length > 0 ? (
        <div className={comfortable ? "mt-2.5" : "mt-2"}>
          <p
            className={
              comfortable
                ? "mb-1.5 text-xs font-medium text-gray-400"
                : "mb-1.5 text-[11px] font-medium text-gray-400"
            }
          >
            {copy?.added(selectedItems.length) ?? `Added (${selectedItems.length}):`}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {selectedItems.map((item) => (
              <span
                key={item.code}
                className={`inline-flex items-center gap-1 rounded-full border border-primary-300 bg-primary-100 font-medium text-primary-700 ${comfortable ? "px-2.5 py-1 text-xs" : "px-2.5 py-0.5 text-[11px]"}`}
              >
                {item.flag && <span>{item.flag}</span>} {item.label}
                <button
                  type="button"
                  onClick={() => onToggle(item.code)}
                  className="ml-0.5 text-primary-400 hover:text-primary-600"
                  aria-label={copy?.remove(item.label) ?? `Remove ${item.label}`}
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p
          className={
            comfortable
              ? "mt-2.5 text-xs italic text-gray-400"
              : "mt-2 text-[11px] italic text-gray-400"
          }
        >
          {emptyMessage}
        </p>
      )}
    </div>
  );
}
