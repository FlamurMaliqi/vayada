"use client";

import { useEffect, useId, useState } from "react";

import {
  NATIONALITY_OPTIONS,
  nationalityInputLabel,
  nationalityLabel,
  normalizeNationalityCode,
} from "@/lib/nationalities";

export function NationalitySelect({
  label = "Nationality",
  value,
  onChange,
  disabled = false,
}: {
  label?: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const [query, setQuery] = useState(() => nationalityInputLabel(value));

  useEffect(() => setQuery(nationalityInputLabel(value)), [value]);

  const commit = (input: string) => {
    if (!input.trim()) {
      onChange("");
      setQuery("");
      return;
    }
    const code = normalizeNationalityCode(input);
    if (code) {
      onChange(code);
      setQuery(nationalityLabel(code) ?? "");
    } else {
      setQuery(nationalityInputLabel(value));
    }
  };

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      <input
        type="text"
        list={listId}
        value={query}
        onChange={(event) => {
          const input = event.target.value;
          setQuery(input);
          const code = normalizeNationalityCode(input);
          if (code) onChange(code);
          else if (!input) onChange("");
        }}
        onBlur={(event) => commit(event.target.value)}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search country"
        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
      />
      <datalist id={listId}>
        {NATIONALITY_OPTIONS.map((option) => (
          <option key={option.code} value={option.name} label={`${option.flag} ${option.code}`} />
        ))}
      </datalist>
    </label>
  );
}
