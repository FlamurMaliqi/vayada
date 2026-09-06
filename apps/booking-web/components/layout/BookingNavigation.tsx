"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useHotel } from "@/contexts/HotelContext";
import { useCurrency } from "@/contexts/CurrencyContext";
import { useTranslations, useLocale } from "next-intl";
import { Link, useRouter, usePathname } from "@/i18n/navigation";

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "id", label: "Indonesia" },
  { code: "nl", label: "Nederlands" },
] as const;

const CURRENCY_LABELS: Record<string, string> = {
  USD: "$ US Dollar",
  EUR: "\u20AC Euro",
  GBP: "\u00A3 British Pound",
  IDR: "Rp Indonesian Rupiah",
  AUD: "A$ Australian Dollar",
  CHF: "CHF Swiss Franc",
  JPY: "\u00A5 Japanese Yen",
  CAD: "C$ Canadian Dollar",
  CNY: "\u00A5 Chinese Yuan",
  SEK: "kr Swedish Krona",
  NOK: "kr Norwegian Krone",
  DKK: "kr Danish Krone",
  SGD: "S$ Singapore Dollar",
  HKD: "HK$ Hong Kong Dollar",
  THB: "\u0E3F Thai Baht",
  MYR: "RM Malaysian Ringgit",
  NZD: "NZ$ New Zealand Dollar",
  ZAR: "R South African Rand",
  BRL: "R$ Brazilian Real",
  INR: "\u20B9 Indian Rupee",
  KRW: "\u20A9 South Korean Won",
  LKR: "Rs Sri Lankan Rupee",
  MXN: "MX$ Mexican Peso",
  TRY: "\u20BA Turkish Lira",
  PLN: "z\u0142 Polish Zloty",
  CZK: "K\u010D Czech Koruna",
  HUF: "Ft Hungarian Forint",
  ILS: "\u20AA Israeli Shekel",
  PHP: "\u20B1 Philippine Peso",
  TWD: "NT$ Taiwan Dollar",
  ISK: "kr Icelandic Krona",
  BGN: "\u043B\u0432 Bulgarian Lev",
  RON: "lei Romanian Leu",
  HRK: "kn Croatian Kuna",
};

function useClickOutside(ref: React.RefObject<HTMLElement | null>, handler: () => void) {
  useEffect(() => {
    const listener = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      // Skip if element is hidden (e.g. inside a responsive display:none container)
      if (ref.current.offsetParent === null) return;
      handler();
    };
    document.addEventListener("mousedown", listener);
    return () => document.removeEventListener("mousedown", listener);
  }, [ref, handler]);
}

// --- Contact Popover ---
function ContactPopover({
  open,
  onClose,
  phone,
  whatsapp,
  email,
}: {
  open: boolean;
  onClose: () => void;
  phone: string;
  whatsapp?: string;
  email: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useTranslations("nav");
  useClickOutside(ref, onClose);
  if (!open) return null;

  const phoneDigits = phone.replace(/\s+/g, "");
  const whatsappDigits = whatsapp?.replace(/\D/g, "");

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 w-64 bg-white rounded-xl shadow-xl border border-gray-100 py-2 z-50"
    >
      <a
        href={`tel:${phoneDigits}`}
        className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <div className="w-8 h-8 rounded-full bg-primary-50 flex items-center justify-center flex-shrink-0">
          <svg
            className="w-4 h-4 text-primary-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
            />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-gray-900">{t("phone")}</p>
          <p className="text-xs text-gray-500">{phone}</p>
        </div>
      </a>
      {whatsapp && whatsappDigits && (
        <a
          href={`https://wa.me/${whatsappDigits}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-success-50 flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-success-600" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.198-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">{t("whatsapp")}</p>
            <p className="text-xs text-gray-500">{whatsapp}</p>
          </div>
        </a>
      )}
      <a
        href={`mailto:${email}`}
        className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <div className="w-8 h-8 rounded-full bg-info-50 flex items-center justify-center flex-shrink-0">
          <svg
            className="w-4 h-4 text-info-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        </div>
        <div>
          <p className="text-sm font-medium text-gray-900">{t("email")}</p>
          <p className="text-xs text-gray-500">{email}</p>
        </div>
      </a>
    </div>
  );
}

// --- Dropdown (for Language & Currency) ---
function Dropdown({
  open,
  onClose,
  items,
  selected,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  items: { value: string; label: string }[];
  selected: string;
  onSelect: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose);
  if (!open) return null;

  return (
    <div
      ref={ref}
      className="absolute right-0 top-full mt-2 w-52 bg-white rounded-xl shadow-xl border border-gray-100 py-1 z-50 overflow-hidden"
    >
      {items.map((item) => (
        <button
          key={item.value}
          onClick={() => {
            onSelect(item.value);
            onClose();
          }}
          className={`w-full flex items-center justify-between px-4 py-2.5 text-sm transition-colors ${
            selected === item.value
              ? "bg-primary-50 text-primary-700 font-medium"
              : "text-gray-700 hover:bg-gray-50"
          }`}
        >
          {item.label}
          {selected === item.value && (
            <svg
              className="w-4 h-4 text-primary-600"
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
        </button>
      ))}
    </div>
  );
}

// --- Main Navigation ---
export default function BookingNavigation() {
  const { hotel } = useHotel();
  const { selectedCurrency, setSelectedCurrency } = useCurrency();
  const t = useTranslations("nav");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [contactOpen, setContactOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [currOpen, setCurrOpen] = useState(false);
  const logoUrl = hotel.branding?.logoUrl;
  const header = hotel.headerSettings ?? {
    showContactButton: true,
    showLanguageSelector: true,
    showCurrencySelector: true,
  };

  const availableLanguages = useMemo(() => {
    const codes = new Set<string>(hotel?.supportedLanguages ?? []);
    if (hotel?.defaultLanguage) codes.add(hotel.defaultLanguage);
    return LANGUAGES.filter((l) => codes.has(l.code));
  }, [hotel?.defaultLanguage, hotel?.supportedLanguages]);
  const selectedLangLabel =
    LANGUAGES.find((l) => l.code === locale)
      ?.label.slice(0, 2)
      .toUpperCase() || "EN";

  const currencyItems = useMemo(() => {
    const codes = Array.from(new Set([hotel.currency, ...(hotel.supportedCurrencies || [])]));
    return codes
      .map((code: string) => ({
        value: code,
        label: CURRENCY_LABELS[code] || code,
      }))
      .sort((a, b) => {
        const nameA = a.label.split(" ").slice(1).join(" ") || a.label;
        const nameB = b.label.split(" ").slice(1).join(" ") || b.label;
        return nameA.localeCompare(nameB);
      });
  }, [hotel.currency, hotel.supportedCurrencies]);

  const closeAll = () => {
    setContactOpen(false);
    setLangOpen(false);
    setCurrOpen(false);
  };

  const handleLanguageChange = (newLocale: string) => {
    router.replace(pathname, { locale: newLocale as "en" | "de" | "fr" | "es" | "id" | "nl" });
  };

  return (
    <>
      <nav className="absolute top-0 left-0 right-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="relative flex items-center justify-between h-16">
            {/* The existing mobile text fallback stays hidden; an uploaded logo gets
                a constrained slot that cannot shrink the action controls. */}
            <Link
              href="/"
              aria-label={hotel.name}
              className={`${logoUrl ? "flex" : "hidden"} min-w-0 flex-1 items-center overflow-hidden pr-2 md:flex md:flex-none`}
            >
              {logoUrl ? (
                // Dynamic CDN logos retain their intrinsic aspect ratio and must not
                // reserve a fixed next/image box that could displace mobile controls.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoUrl}
                  alt={`${hotel.name} logo`}
                  loading="eager"
                  fetchPriority="high"
                  decoding="async"
                  className="max-h-8 max-w-full object-contain object-left md:max-h-10 md:max-w-[300px]"
                />
              ) : (
                <span className="text-lg font-semibold text-white">{hotel.name}</span>
              )}
            </Link>

            {/* Right - Actions (always visible on mobile, full nav on desktop) */}
            <div className="hidden md:flex items-center gap-2">
              {/* Contact */}
              {header.showContactButton && (
                <div className="relative">
                  <button
                    onClick={() => {
                      closeAll();
                      setContactOpen(!contactOpen);
                    }}
                    className="px-5 py-2 text-sm font-semibold text-white bg-primary-600 rounded-full hover:bg-primary-700 transition-colors"
                  >
                    {t("contact")}
                  </button>
                </div>
              )}

              {/* Language */}
              {header.showLanguageSelector && availableLanguages.length > 1 && (
                <div className="relative">
                  <button
                    onClick={() => {
                      closeAll();
                      setLangOpen(!langOpen);
                    }}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white border-2 border-white/60 rounded-full hover:bg-white/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
                      />
                    </svg>
                    {selectedLangLabel}
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>
                  <Dropdown
                    open={langOpen}
                    onClose={() => setLangOpen(false)}
                    items={availableLanguages.map((l) => ({ value: l.code, label: l.label }))}
                    selected={locale}
                    onSelect={handleLanguageChange}
                  />
                </div>
              )}

              {/* Currency */}
              {header.showCurrencySelector && currencyItems.length > 1 && (
                <div className="relative">
                  <button
                    onClick={() => {
                      closeAll();
                      setCurrOpen(!currOpen);
                    }}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white border-2 border-white/60 rounded-full hover:bg-white/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
                  >
                    {selectedCurrency}
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>
                  <Dropdown
                    open={currOpen}
                    onClose={() => setCurrOpen(false)}
                    items={currencyItems}
                    selected={selectedCurrency}
                    onSelect={setSelectedCurrency}
                  />
                </div>
              )}
            </div>

            {/* Mobile inline actions */}
            <div className="md:hidden flex shrink-0 items-center gap-1.5 ml-auto">
              {header.showContactButton && (
                <div className="relative">
                  <button
                    type="button"
                    data-testid="mobile-contact-button"
                    aria-label={t("contact")}
                    onClick={() => {
                      closeAll();
                      setContactOpen(!contactOpen);
                    }}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-600 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"
                      />
                    </svg>
                  </button>
                </div>
              )}
              {header.showLanguageSelector && availableLanguages.length > 1 && (
                <div className="relative">
                  <button
                    onClick={() => {
                      closeAll();
                      setLangOpen(!langOpen);
                    }}
                    className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-white/90"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"
                      />
                    </svg>
                    {selectedLangLabel}
                  </button>
                  <Dropdown
                    open={langOpen}
                    onClose={() => setLangOpen(false)}
                    items={availableLanguages.map((l) => ({ value: l.code, label: l.label }))}
                    selected={locale}
                    onSelect={handleLanguageChange}
                  />
                </div>
              )}
              {header.showCurrencySelector && currencyItems.length > 1 && (
                <div className="relative">
                  <button
                    onClick={() => {
                      closeAll();
                      setCurrOpen(!currOpen);
                    }}
                    className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-white/90"
                  >
                    {selectedCurrency}
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>
                  <Dropdown
                    open={currOpen}
                    onClose={() => setCurrOpen(false)}
                    items={currencyItems}
                    selected={selectedCurrency}
                    onSelect={setSelectedCurrency}
                  />
                </div>
              )}
            </div>
            {header.showContactButton && (
              <ContactPopover
                open={contactOpen}
                onClose={() => setContactOpen(false)}
                phone={hotel.contact.phone}
                whatsapp={hotel.contact.whatsapp}
                email={hotel.contact.email}
              />
            )}
          </div>
        </div>
      </nav>
    </>
  );
}
