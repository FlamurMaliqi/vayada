"use client";

import { useState, useRef, useEffect } from "react";

import { LocalizationMultiSelect } from "./LocalizationMultiSelect";

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
  tiktok?: string;
  setTiktok?: (v: string) => void;
  youtube?: string;
  setYoutube?: (v: string) => void;
  currency: string;
  setCurrency: (v: string) => void;
  defaultLanguage: string;
  setDefaultLanguage: (v: string) => void;
  supportedCurrencies: string[];
  setSupportedCurrencies: (v: string[]) => void;
  supportedLanguages: string[];
  setSupportedLanguages: (v: string[]) => void;
  prefilled: boolean;
  sharedBasicsReadOnly?: boolean;
  hideSharedHotelFields?: boolean;
  bookingSection?: "contact" | "localization";
  error: string;
  canProceed: boolean;
  onBack?: () => void;
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
  id,
  value,
  onChange,
  options,
  getLabel,
  getValue,
  placeholder = "Select...",
}: {
  id: string;
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
        id={id}
        type="button"
        onClick={() => {
          setOpen(!open);
          setSearch("");
        }}
        className="flex w-full items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 transition-colors focus:border-transparent focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500"
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
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-xl border border-gray-200 bg-white shadow-lg">
          <div className="p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              autoFocus
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-400">No results</div>
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
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 ${isSelected ? "bg-gray-50 font-medium" : ""}`}
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
  sharedBasicsReadOnly = false,
  hideSharedHotelFields = false,
  bookingSection,
  error,
  canProceed,
  onBack,
  onContinue,
  stepIndicators,
  countryOptions,
  currencyOptions,
  languageOptions,
  popularCurrencyCodes,
  popularLanguageCodes,
}: PropertyStepProps) {
  const inputClassName =
    "w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 transition-colors focus:border-transparent focus:bg-white focus:outline-none focus:ring-2 focus:ring-primary-500";
  const showContactSection = bookingSection !== "localization";
  const showLocalizationSection = bookingSection !== "contact";
  const additionalCurrencies = supportedCurrencies.filter((code) => code !== currency);
  const additionalLanguages = supportedLanguages.filter((code) => code !== defaultLanguage);
  const additionalSelectionCount = additionalCurrencies.length + additionalLanguages.length;
  const [additionalOptionsOpen, setAdditionalOptionsOpen] = useState(
    bookingSection === "localization" || additionalSelectionCount > 0,
  );
  useEffect(() => {
    if (bookingSection === "localization") setAdditionalOptionsOpen(true);
  }, [bookingSection]);
  const heading =
    bookingSection === "localization"
      ? "Currency & Languages"
      : bookingSection === "contact"
        ? "Contact details"
        : "Your Property";
  const description =
    bookingSection === "localization"
      ? ""
      : bookingSection === "contact"
        ? "Add the optional contact and social links shown on your booking page."
        : "Configure how this hotel should appear and communicate in Booking Engine.";

  return (
    <div
      className={`flex-1 overflow-auto bg-gray-50/50 ${bookingSection ? "flex items-center" : ""}`}
    >
      <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6 sm:py-7">
        {stepIndicators}
        {prefilled && bookingSection !== "localization" && (
          <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
            {hideSharedHotelFields || sharedBasicsReadOnly
              ? "Hotel basics are reused from shared setup. Configure only Booking-specific settings below."
              : "Some hotel basics were prefilled from shared setup. Complete the missing fields below."}
          </div>
        )}

        <div className="mb-5 text-center">
          <h2 className="text-2xl font-semibold tracking-tight text-gray-950">{heading}</h2>
          {description && <p className="mt-1.5 text-sm text-gray-500">{description}</p>}
        </div>

        <div className="divide-y divide-gray-200 rounded-2xl border border-gray-200 bg-white shadow-sm">
          {!hideSharedHotelFields && (
            <section className="space-y-4 p-4 sm:p-5">
              <div className="flex items-center gap-2">
                <svg
                  className="h-4 w-4 text-primary-500"
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
                <h3 className="text-base font-semibold text-gray-950">
                  {sharedBasicsReadOnly ? "Shared hotel profile" : "Basic Information"}
                </h3>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-800">
                  Property Name <span aria-hidden="true">*</span>
                </label>
                <input
                  type="text"
                  value={propertyName}
                  onChange={(e) => setPropertyName(e.target.value)}
                  readOnly={sharedBasicsReadOnly}
                  className={inputClassName}
                  placeholder="e.g. Sundancer Villas & Suites"
                />
              </div>

              <div
                className={
                  bookingSection === "localization"
                    ? "grid grid-cols-1 gap-4"
                    : "grid grid-cols-1 gap-3 sm:grid-cols-2"
                }
              >
                <div>
                  <label
                    htmlFor="property-step-city"
                    className="mb-1.5 block text-sm font-medium text-gray-800"
                  >
                    City <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id="property-step-city"
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    readOnly={sharedBasicsReadOnly}
                    className={inputClassName}
                    placeholder="e.g. Seminyak"
                  />
                </div>
                <div>
                  <label
                    htmlFor="property-step-country"
                    className="mb-1.5 block text-sm font-medium text-gray-800"
                  >
                    Country <span aria-hidden="true">*</span>
                  </label>
                  {sharedBasicsReadOnly ? (
                    <input
                      id="property-step-country"
                      type="text"
                      value={
                        countryOptions.find((option) => option.code === country)?.name ?? country
                      }
                      readOnly
                      className="w-full rounded-xl border border-gray-200 bg-gray-100 px-3.5 py-2.5 text-sm text-gray-600"
                    />
                  ) : (
                    <FlagSelect<CountryOption>
                      id="property-step-country"
                      value={country}
                      onChange={setCountry}
                      options={countryOptions}
                      getLabel={(o) => o.name}
                      getValue={(o) => o.code}
                      placeholder="Select country"
                    />
                  )}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-sm font-medium text-gray-800">
                  Full Address <span aria-hidden="true">*</span>
                </label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  readOnly={sharedBasicsReadOnly}
                  className={inputClassName}
                  placeholder="Street address, area"
                />
              </div>
            </section>
          )}

          {showContactSection && (
            <section
              className={
                hideSharedHotelFields
                  ? "grid grid-cols-1 gap-4 p-4 sm:p-5"
                  : "grid divide-y divide-gray-200 lg:grid-cols-2 lg:divide-x lg:divide-y-0"
              }
            >
              <div className={hideSharedHotelFields ? "contents" : "space-y-4 p-4 sm:p-5"}>
                <div className="flex items-center gap-2">
                  <svg
                    className="h-4 w-4 text-primary-500"
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
                  <h3 className="text-base font-semibold text-gray-950">
                    {hideSharedHotelFields
                      ? "Contact & social links"
                      : sharedBasicsReadOnly
                        ? "Shared hotel contact"
                        : "Hotel contact"}
                  </h3>
                  {hideSharedHotelFields && (
                    <span className="text-xs font-normal text-gray-400">(optional)</span>
                  )}
                </div>

                {!hideSharedHotelFields && (
                  <div className="space-y-3">
                    <div>
                      <label
                        htmlFor="property-step-reservation-email"
                        className="mb-1.5 block text-sm font-medium text-gray-800"
                      >
                        Hotel contact email <span aria-hidden="true">*</span>
                      </label>
                      <input
                        id="property-step-reservation-email"
                        type="email"
                        value={reservationEmail}
                        onChange={(e) => setReservationEmail(e.target.value)}
                        readOnly={sharedBasicsReadOnly}
                        className={inputClassName}
                        placeholder="reservations@yourproperty.com"
                      />
                      <p className="mt-1.5 text-xs leading-5 text-gray-400">
                        {sharedBasicsReadOnly
                          ? "Managed once in the shared hotel profile."
                          : "Saved to the shared hotel profile and used by Booking Engine."}
                      </p>
                    </div>
                    <div>
                      <label
                        htmlFor="property-step-phone"
                        className="mb-1.5 block text-sm font-medium text-gray-800"
                      >
                        Hotel phone <span aria-hidden="true">*</span>
                      </label>
                      <input
                        id="property-step-phone"
                        type="tel"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        readOnly={sharedBasicsReadOnly}
                        className={inputClassName}
                        placeholder="+62 812 3456 7890"
                      />
                      <p className="mt-1.5 text-xs leading-5 text-gray-400">
                        {sharedBasicsReadOnly
                          ? "Managed once in the shared hotel profile."
                          : "Saved to the shared hotel profile and used by Booking Engine."}
                      </p>
                    </div>
                  </div>
                )}

                <div>
                  <label
                    htmlFor="property-step-whatsapp"
                    className="mb-1.5 flex items-center gap-1.5 text-sm text-gray-800"
                  >
                    <svg
                      className="h-3.5 w-3.5 text-gray-400"
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
                    <span className="font-medium">WhatsApp</span>
                    {!hideSharedHotelFields && (
                      <span className="text-xs font-normal text-gray-400">(optional)</span>
                    )}
                  </label>
                  <input
                    id="property-step-whatsapp"
                    type="tel"
                    value={whatsapp}
                    onChange={(e) => setWhatsapp(e.target.value)}
                    className={inputClassName}
                    placeholder="+62 812 ..."
                  />
                </div>
              </div>

              <div className={hideSharedHotelFields ? "contents" : "space-y-4 p-4 sm:p-5"}>
                <div className={hideSharedHotelFields ? "hidden" : undefined}>
                  <div className="flex items-center gap-2">
                    <svg
                      className="h-4 w-4 text-primary-500"
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
                    <h3 className="text-base font-semibold text-gray-950">Social Media</h3>
                    <span className="text-xs font-normal text-gray-400">(optional)</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-400">
                    Links shown in your booking site footer
                  </p>
                </div>

                <div
                  className={
                    hideSharedHotelFields ? "contents" : "grid grid-cols-1 gap-3 sm:grid-cols-2"
                  }
                >
                  <div>
                    <label
                      htmlFor="property-step-instagram"
                      className="mb-1.5 block text-sm font-medium text-gray-800"
                    >
                      Instagram
                    </label>
                    <input
                      id="property-step-instagram"
                      type="text"
                      value={instagram}
                      onChange={(e) => setInstagram(e.target.value)}
                      className={inputClassName}
                      placeholder="https://instagram.com/yourhotel"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="property-step-facebook"
                      className="mb-1.5 block text-sm font-medium text-gray-800"
                    >
                      Facebook
                    </label>
                    <input
                      id="property-step-facebook"
                      type="text"
                      value={facebook}
                      onChange={(e) => setFacebook(e.target.value)}
                      className={inputClassName}
                      placeholder="https://facebook.com/yourhotel"
                    />
                  </div>
                  {tiktok !== undefined && setTiktok && (
                    <div>
                      <label
                        htmlFor="property-step-tiktok"
                        className="mb-1.5 block text-sm font-medium text-gray-800"
                      >
                        TikTok
                      </label>
                      <input
                        id="property-step-tiktok"
                        type="text"
                        value={tiktok}
                        onChange={(e) => setTiktok(e.target.value)}
                        className={inputClassName}
                        placeholder="https://www.tiktok.com/@yourhotel"
                      />
                    </div>
                  )}
                  {youtube !== undefined && setYoutube && (
                    <div>
                      <label
                        htmlFor="property-step-youtube"
                        className="mb-1.5 block text-sm font-medium text-gray-800"
                      >
                        YouTube
                      </label>
                      <input
                        id="property-step-youtube"
                        type="text"
                        value={youtube}
                        onChange={(e) => setYoutube(e.target.value)}
                        className={inputClassName}
                        placeholder="https://youtube.com/@yourhotel"
                      />
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {showLocalizationSection && (
            <section className="space-y-4 p-4 sm:p-5">
              {bookingSection !== "localization" && (
                <div className="flex items-center gap-2">
                  <svg
                    className="h-4 w-4 text-primary-500"
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
                  <h3 className="text-base font-semibold text-gray-950">Currency & Languages</h3>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="property-step-default-currency"
                    className="mb-1.5 block text-sm font-medium text-gray-800"
                  >
                    Default Currency <span aria-hidden="true">*</span>
                  </label>
                  <FlagSelect<CurrencyOption>
                    id="property-step-default-currency"
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
                  <label
                    htmlFor="property-step-default-language"
                    className="mb-1.5 block text-sm font-medium text-gray-800"
                  >
                    Default Language <span aria-hidden="true">*</span>
                  </label>
                  <FlagSelect<LanguageOption>
                    id="property-step-default-language"
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

              <details
                className="rounded-xl bg-gray-50 p-3 sm:p-4"
                open={additionalOptionsOpen}
                onToggle={(event) => setAdditionalOptionsOpen(event.currentTarget.open)}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-gray-800 [&::-webkit-details-marker]:hidden">
                  <span>Additional currencies &amp; languages</span>
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs font-normal text-gray-500">
                    {additionalSelectionCount > 0
                      ? `${additionalSelectionCount} added`
                      : "Optional"}
                  </span>
                </summary>
                <p className="mt-1 text-xs text-gray-500">
                  Add more display options only when your booking site needs them.
                </p>
                <div
                  className={`mt-4 grid grid-cols-1 gap-5 ${
                    bookingSection === "localization" ? "" : "lg:grid-cols-2"
                  }`}
                >
                  <div>
                    <label
                      htmlFor="property-step-additional-currencies"
                      className="mb-1.5 block text-sm font-medium text-gray-800"
                    >
                      Additional Currencies
                    </label>
                    <LocalizationMultiSelect<CurrencyOption>
                      id="property-step-additional-currencies"
                      selected={additionalCurrencies}
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
                      comfortable
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="property-step-additional-languages"
                      className="mb-1.5 block text-sm font-medium text-gray-800"
                    >
                      Additional Languages
                    </label>
                    <LocalizationMultiSelect<LanguageOption>
                      id="property-step-additional-languages"
                      selected={additionalLanguages}
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
                      comfortable
                    />
                  </div>
                </div>
              </details>
            </section>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3">
            <p className="text-sm font-medium text-red-700">{error}</p>
          </div>
        )}

        <div className="mt-5 flex flex-col-reverse justify-center gap-3 sm:flex-row">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="w-full rounded-full border border-gray-200 bg-white px-6 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 sm:w-auto"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onContinue}
            disabled={!canProceed}
            className="w-full rounded-full bg-primary-500 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
