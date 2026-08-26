"use client";

import { useEffect, useId, useState } from "react";

import {
  NATIONALITY_OPTIONS,
  nationalityInputLabel,
  nationalityLabel,
  normalizeNationalityCode,
} from "@vayada/locale-constants";

export type NationalitySelectProps = {
  label?: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  placeholder?: string;
  containerClassName?: string;
  labelClassName?: string;
  inputClassName: string;
  reviewClassName?: string;
  reviewMessage?: string;
};

export function NationalitySelect({
  label = "Nationality",
  value,
  onChange,
  disabled = false,
  placeholder = "Search country",
  containerClassName,
  labelClassName,
  inputClassName,
  reviewClassName,
  reviewMessage = "Non-standard nationality · Needs review",
}: NationalitySelectProps) {
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState(() => nationalityInputLabel(value));
  const needsReview = Boolean(value.trim()) && !nationalityLabel(value);

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
    <div className={containerClassName}>
      <label htmlFor={inputId} className={labelClassName}>
        {label}
      </label>
      <input
        id={inputId}
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
        placeholder={placeholder}
        className={inputClassName}
      />
      <datalist id={listId}>
        {NATIONALITY_OPTIONS.map((option) => (
          <option key={option.code} value={option.name} label={`${option.flag} ${option.code}`} />
        ))}
      </datalist>
      {needsReview && (
        <p role="status" className={reviewClassName}>
          {reviewMessage}
        </p>
      )}
    </div>
  );
}
