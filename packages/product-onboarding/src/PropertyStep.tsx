"use client";

import { useState, useRef, useEffect } from "react";

export interface CountryOption {
  code: string;
  name: string;
  flag: string;
}

export interface CurrencyOption {
  code: string;
  name: string;
  flag: string;
}

export interface LanguageOption {
  code: string;
  name: string;
  nativeName: string;
  flag: string;
}

interface PropertyStepProps {
  propertyName: string;
  setPropertyName: (v: string) => void;
  city: string;
  setCity: (v: string) => void;
  country: string;
  setCountry: (v: string) => void;
  address: string;
  setAddress: (v: string) => void;
  reservationEmail: string;
  setReservationEmail: (v: string) => void;
  phoneNumber: string;
  setPhoneNumber: (v: string) => void;
  whatsapp: string;
  setWhatsapp: (v: string) => void;
  instagram: string;
  setInstagram: (v: string) => void;
  facebook: string;
  setFacebook: (v: string) => void;
  tiktok: string;
  setTiktok: (v: string) => void;
  youtube: string;
  setYoutube: (v: string) => void;
  currency: string;
  setCurrency: (v: string) => void;
  defaultLanguage: string;
  setDefaultLanguage: (v: string) => void;
  supportedCurrencies: string[];
  setSupportedCurrencies: (v: string[]) => void;
  supportedLanguages: string[];
  setSupportedLanguages: (v: string[]) => void;
  prefilled: boolean;
  error: string;
  canProceed: boolean;
  onContinue: () => void;
  stepIndicators: React.ReactNode;
  countryOptions: CountryOption[];
  currencyOptions: CurrencyOption[];
  languageOptions: LanguageOption[];
  popularCurrencyCodes: string[];
  popularLanguageCodes: string[];
}

// ── Custom Select Dropdown ───────────────────────────────────────────
function FlagSelect<T extends { code: string; flag: string }>({
  value,
  onChange,
  options,
  getLabel,
  getValue,
  placeholder = "Select...",
}: {
  value: string;
  onChange: (value: string) => void;
  options: T[];
  getLabel: (opt: T) => string;
  getValue?: (opt: T) => string;
  placeholder?: string;
}) {
  const resolveValue = getValue ?? ((o: T) => o.code);
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

  const selected = options.find((o) => resolveValue(o) === value);
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
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900"
      >
        <span>{selected ? `${selected.flag} ${getLabel(selected)}` : placeholder}</span>
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
              className="w-full px-2.5 py-1.5 text-[12px] border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-gray-400">No results</div>
            ) : (
              filtered.map((opt) => {
                const optValue = resolveValue(opt);
                const isSelected = optValue === value;
                return (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => {
                      onChange(optValue);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left hover:bg-gray-50 ${isSelected ? "bg-gray-50 font-medium" : ""}`}
                  >
                    {isSelected ? (
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
                    ) : (
                      <span className="w-3.5 flex-shrink-0" />
                    )}
                    <span>
                      {opt.flag} {getLabel(opt)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Searchable Multi-Select ──────────────────────────────────────────
function SearchableMultiSelect<T extends { code: string; flag: string }>({
  selected,
  onToggle,
  options,
  excludeCode,
  placeholder,
  getLabel,
  getSearchLabel,
  popularCodes,
  emptyMessage,
}: {
  selected: string[];
  onToggle: (code: string) => void;
  options: T[];
  excludeCode: string;
  placeholder: string;
  getLabel: (opt: T) => string;
  getSearchLabel: (opt: T) => string;
  popularCodes: string[];
  emptyMessage: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const available = options.filter((o) => o.code !== excludeCode);
  const filtered = query.trim()
    ? available.filter((o) => getSearchLabel(o).toLowerCase().includes(query.toLowerCase()))
    : available;
  const popular = available.filter((o) => popularCodes.includes(o.code));

  return (
    <div ref={ref}>
      {/* Search input */}
      <div className="relative">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder}
          className="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
        />
        {/* Dropdown */}
        {open && query.trim() && (
          <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[12px] text-gray-400">No results found</p>
            ) : (
              filtered.map((opt) => {
                const isSelected = selected.includes(opt.code);
                return (
                  <button
                    key={opt.code}
                    type="button"
                    onClick={() => {
                      onToggle(opt.code);
                      setQuery("");
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-[12px] text-left transition-colors ${isSelected ? "bg-primary-500 text-white" : "hover:bg-gray-50 text-gray-900"}`}
                  >
                    <span>{opt.flag}</span>
                    <span>{getSearchLabel(opt)}</span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Popular choices */}
      <div className="mt-2.5">
        <p className="text-[11px] text-gray-400 font-medium mb-1.5">Popular choices &mdash;</p>
        <div className="flex flex-wrap gap-1.5">
          {popular.map((opt) => {
            const isSelected = selected.includes(opt.code);
            return (
              <button
                key={opt.code}
                type="button"
                onClick={() => onToggle(opt.code)}
                className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium rounded-full transition-colors ${
                  isSelected
                    ? "bg-primary-100 text-primary-700 border border-primary-300"
                    : "bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100"
                }`}
              >
                {opt.flag} {getLabel(opt)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Added items */}
      {selected.length > 0 ? (
        <div className="mt-2.5">
          <p className="text-[11px] text-gray-400 font-medium mb-1.5">Added ({selected.length}):</p>
          <div className="flex flex-wrap gap-1.5">
            {selected.map((code) => {
              const opt = options.find((o) => o.code === code);
              if (!opt) return null;
              return (
                <span
                  key={code}
                  className="inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-medium rounded-full bg-primary-100 text-primary-700 border border-primary-300"
                >
                  {opt.flag} {getLabel(opt)}
                  <button
                    type="button"
                    onClick={() => onToggle(code)}
                    className="ml-0.5 text-primary-400 hover:text-primary-600"
                  >
                    &times;
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="mt-2.5 text-[11px] text-gray-400 italic">{emptyMessage}</p>
      )}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────
export default function PropertyStep({
  propertyName,
  setPropertyName,
  city,
  setCity,
  country,
  setCountry,
  address,
  setAddress,
  reservationEmail,
  setReservationEmail,
  phoneNumber,
  setPhoneNumber,
  whatsapp,
  setWhatsapp,
  instagram,
  setInstagram,
  facebook,
  setFacebook,
  tiktok,
  setTiktok,
  youtube,
  setYoutube,
  currency,
  setCurrency,
  defaultLanguage,
  setDefaultLanguage,
  supportedCurrencies,
  setSupportedCurrencies,
  supportedLanguages,
  setSupportedLanguages,
  prefilled,
  error,
  canProceed,
  onContinue,
  stepIndicators,
  countryOptions,
  currencyOptions,
  languageOptions,
  popularCurrencyCodes,
  popularLanguageCodes,
}: PropertyStepProps) {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
        {stepIndicators}
        {prefilled && (
          <div className="mb-4 px-3 py-2.5 rounded-lg text-[13px] bg-blue-50 text-blue-800 border border-blue-200">
            Some fields were pre-filled from your marketplace profile. Review and adjust as needed.
          </div>
        )}

        <div className="text-center mb-6">
          <h2 className="text-base font-bold text-gray-900">Your Property</h2>
          <p className="text-[12px] text-gray-500 mt-1">
            Tell us about your property so we can set up everything for you.
          </p>
        </div>

        {/* Basic Information */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-5 space-y-4 mb-5">
          <div className="flex items-center gap-1.5">
            <svg
              className="w-3.5 h-3.5 text-primary-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
              <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
              <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
              <path d="M10 6h4" />
              <path d="M10 10h4" />
              <path d="M10 14h4" />
              <path d="M10 18h4" />
            </svg>
            <h3 className="text-[13px] font-bold text-gray-900">Basic Information</h3>
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-gray-800 mb-1">
              Property Name <span className="text-gray-800">*</span>
            </label>
            <input
              type="text"
              value={propertyName}
              onChange={(e) => setPropertyName(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
              placeholder="e.g. Sundancer Villas & Suites"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                City <span className="text-gray-800">*</span>
              </label>
              <input
                type="text"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                placeholder="e.g. Seminyak"
              />
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                Country <span className="text-gray-800">*</span>
              </label>
              <FlagSelect<CountryOption>
                value={country}
                onChange={setCountry}
                options={countryOptions}
                getLabel={(o) => o.name}
                getValue={(o) => o.name}
                placeholder="Select country"
              />
            </div>
          </div>

          <div>
            <label className="block text-[12px] font-semibold text-gray-800 mb-1">
              Full Address <span className="text-gray-800">*</span>
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
              placeholder="Street address, area"
            />
          </div>
        </div>

        {/* Contact Details */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-5 space-y-4 mb-5">
          <div className="flex items-center gap-1.5">
            <svg
              className="w-3.5 h-3.5 text-primary-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"
              />
            </svg>
            <h3 className="text-[13px] font-bold text-gray-900">Contact Details</h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                Email <span className="text-gray-800">*</span>
              </label>
              <input
                type="email"
                value={reservationEmail}
                onChange={(e) => setReservationEmail(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                placeholder="reservations@yourproperty.com"
              />
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                Phone Number <span className="text-gray-800">*</span>
              </label>
              <input
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                placeholder="+62 812 3456 7890"
              />
            </div>
          </div>

          <div>
            <label className="flex items-center gap-1 text-[12px] text-gray-800 mb-1">
              <svg
                className="w-3 h-3 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
                />
              </svg>
              <span className="font-semibold">WhatsApp</span>{" "}
              <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
            </label>
            <input
              type="tel"
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
              placeholder="+62 812 ..."
            />
          </div>
        </div>

        {/* Social Media */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-5 space-y-4 mb-5">
          <div className="flex items-center gap-1.5">
            <svg
              className="w-3.5 h-3.5 text-primary-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
              />
            </svg>
            <h3 className="text-[13px] font-bold text-gray-900">Social Media</h3>
            <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
          </div>
          <p className="text-[11px] text-gray-400">Links shown in your booking site footer</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] text-gray-800 mb-1">
                <span className="font-semibold">Instagram</span>
              </label>
              <input
                type="text"
                value={instagram}
                onChange={(e) => setInstagram(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                placeholder="https://instagram.com/yourhotel"
              />
            </div>
            <div>
              <label className="block text-[12px] text-gray-800 mb-1">
                <span className="font-semibold">Facebook</span>
              </label>
              <input
                type="text"
                value={facebook}
                onChange={(e) => setFacebook(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                placeholder="https://facebook.com/yourhotel"
              />
            </div>
            <div>
              <label className="block text-[12px] text-gray-800 mb-1">
                <span className="font-semibold">TikTok</span>
              </label>
              <input
                type="text"
                value={tiktok}
                onChange={(e) => setTiktok(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                placeholder="https://www.tiktok.com/@yourhotel"
              />
            </div>
            <div>
              <label className="block text-[12px] text-gray-800 mb-1">
                <span className="font-semibold">YouTube</span>
              </label>
              <input
                type="text"
                value={youtube}
                onChange={(e) => setYoutube(e.target.value)}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-[12px] focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent focus:bg-white text-gray-900 placeholder:text-gray-400"
                placeholder="https://youtube.com/@yourhotel"
              />
            </div>
          </div>
        </div>

        {/* Currency & Languages */}
        <div className="bg-white rounded-xl border border-gray-200 px-5 py-5 space-y-5">
          <div className="flex items-center gap-1.5">
            <svg
              className="w-3.5 h-3.5 text-primary-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
              />
            </svg>
            <h3 className="text-[13px] font-bold text-gray-900">Currency & Languages</h3>
          </div>

          {/* Default Currency & Language */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                Default Currency <span className="text-gray-800">*</span>
              </label>
              <FlagSelect<CurrencyOption>
                value={currency}
                onChange={(code) => {
                  const oldDefault = currency;
                  setCurrency(code);
                  const without = supportedCurrencies.filter((c) => c !== code);
                  setSupportedCurrencies(
                    oldDefault && !without.includes(oldDefault)
                      ? [...without, oldDefault]
                      : without,
                  );
                }}
                options={currencyOptions}
                getLabel={(o) => o.name}
              />
            </div>
            <div>
              <label className="block text-[12px] font-semibold text-gray-800 mb-1">
                Default Language <span className="text-gray-800">*</span>
              </label>
              <FlagSelect<LanguageOption>
                value={defaultLanguage}
                onChange={(code) => {
                  const oldDefault = defaultLanguage;
                  setDefaultLanguage(code);
                  const without = supportedLanguages.filter((l) => l !== code);
                  setSupportedLanguages(
                    oldDefault && !without.includes(oldDefault)
                      ? [...without, oldDefault]
                      : without,
                  );
                }}
                options={languageOptions}
                getLabel={(o) => o.name}
              />
            </div>
          </div>

          {/* Additional Currencies */}
          <div>
            <label className="block text-[12px] text-gray-800 mb-1.5">
              <span className="font-semibold">Additional Currencies</span>{" "}
              <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
            </label>
            <SearchableMultiSelect<CurrencyOption>
              selected={supportedCurrencies}
              onToggle={(code) => {
                setSupportedCurrencies(
                  supportedCurrencies.includes(code)
                    ? supportedCurrencies.filter((x) => x !== code)
                    : [...supportedCurrencies, code],
                );
              }}
              options={currencyOptions}
              excludeCode={currency}
              placeholder={`Search currencies, e.g. "Swiss" or "CHF"...`}
              getLabel={(o) => o.code}
              getSearchLabel={(o) => `${o.name} \u00b7 ${o.code}`}
              popularCodes={popularCurrencyCodes}
              emptyMessage={`No additional currencies added \u2014 your booking page will show only ${currency}`}
            />
          </div>

          {/* Additional Languages */}
          <div>
            <label className="block text-[12px] text-gray-800 mb-1.5">
              <span className="font-semibold">Additional Languages</span>{" "}
              <span className="text-gray-400 font-normal text-[11px]">(optional)</span>
            </label>
            <SearchableMultiSelect<LanguageOption>
              selected={supportedLanguages}
              onToggle={(code) => {
                setSupportedLanguages(
                  supportedLanguages.includes(code)
                    ? supportedLanguages.filter((x) => x !== code)
                    : [...supportedLanguages, code],
                );
              }}
              options={languageOptions}
              excludeCode={defaultLanguage}
              placeholder={`Search languages, e.g. "German" or "Deutsch"...`}
              getLabel={(o) => o.nativeName}
              getSearchLabel={(o) => `${o.name} \u00b7 ${o.nativeName}`}
              popularCodes={popularLanguageCodes}
              emptyMessage={`No additional languages added \u2014 your booking page will show only ${defaultLanguage.toUpperCase()}`}
            />
          </div>
        </div>

        {error && (
          <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3">
            <p className="text-[12px] text-red-700 font-medium">{error}</p>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between">
          <button className="px-5 py-2 text-[13px] font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
            Back
          </button>
          <button
            onClick={onContinue}
            disabled={!canProceed}
            className="px-5 py-2 bg-primary-500 text-white text-[13px] font-semibold rounded-lg hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
