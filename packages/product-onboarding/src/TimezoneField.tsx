"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { filterTimezones } from "./timezones";

export default function TimezoneField({
  value,
  options,
  onChange,
  error,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  error?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visibleOptions = useMemo(() => filterTimezones(options, query), [options, query]);
  const [activeTimezone, setActiveTimezone] = useState(value);
  const activeOption = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (open) activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [activeTimezone, open]);

  const openPicker = () => {
    setQuery("");
    setActiveTimezone(options.includes(value) ? value : (options[0] ?? ""));
    setOpen(true);
  };

  return (
    <div className="relative">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">
        Time zone
      </label>
      <p className="mt-1 text-xs text-gray-500">
        Detected from the property address. Change it if needed.
      </p>
      <div className="relative mt-2">
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-options`}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeTimezone ? `${id}-option-${options.indexOf(activeTimezone)}` : undefined
          }
          aria-invalid={Boolean(error)}
          aria-required="true"
          value={open ? query : value}
          placeholder="Search time zones"
          onFocus={openPicker}
          onChange={(event) => {
            const nextQuery = event.target.value;
            const nextOptions = filterTimezones(options, nextQuery);
            setQuery(nextQuery);
            setActiveTimezone(nextOptions[0] ?? "");
            setOpen(true);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              setQuery("");
            } else if (event.key === "Enter" && open && activeTimezone) {
              event.preventDefault();
              onChange(activeTimezone);
              setOpen(false);
              setQuery("");
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const currentIndex = visibleOptions.indexOf(activeTimezone);
              const delta = event.key === "ArrowDown" ? 1 : -1;
              const nextIndex =
                currentIndex < 0
                  ? 0
                  : (currentIndex + delta + visibleOptions.length) % visibleOptions.length;
              setActiveTimezone(visibleOptions[nextIndex] ?? "");
            }
          }}
          className={`w-full rounded-xl border px-4 py-2.5 pr-10 text-base outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100 sm:text-sm ${
            error ? "border-red-300 bg-red-50" : "border-gray-200"
          }`}
        />
        <button
          type="button"
          aria-label="Open time zone options"
          onMouseDown={(event) => event.preventDefault()}
          onClick={openPicker}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-gray-500"
        >
          <span aria-hidden="true">⌄</span>
        </button>
      </div>
      {open && (
        <ul
          id={`${id}-options`}
          role="listbox"
          className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-gray-200 bg-white p-1 shadow-lg"
        >
          {visibleOptions.map((timezone) => (
            <li
              key={timezone}
              id={`${id}-option-${options.indexOf(timezone)}`}
              ref={timezone === activeTimezone ? activeOption : undefined}
              role="option"
              aria-selected={timezone === activeTimezone}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveTimezone(timezone)}
              onClick={() => {
                onChange(timezone);
                setOpen(false);
                setQuery("");
              }}
              className={`cursor-pointer rounded-lg px-3 py-2 text-sm hover:bg-primary-50 ${
                timezone === activeTimezone
                  ? "bg-primary-50 font-semibold text-primary-800"
                  : "text-gray-700"
              }`}
            >
              {timezone}
            </li>
          ))}
          {visibleOptions.length === 0 && (
            <li className="px-3 py-2 text-sm text-gray-500">No matching time zone</li>
          )}
        </ul>
      )}
      {error && (
        <p className="mt-1.5 text-xs font-medium text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
