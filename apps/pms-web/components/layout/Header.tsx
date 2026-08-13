"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDownIcon, PlusIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import { bookingsService } from "@/services/bookings";
import { pmsSettingsService, settingsService, HotelSummary } from "@/services/settings";
import {
  getStoredPmsPropertyId,
  storeSelectedPmsPropertyId,
} from "@/services/api/pmsPropertyClient";
import { isPmsOperationsReadModelEnabled } from "@/services/api/pmsOperationsClient";
import {
  getArrivalsToday,
  getDeparturesToday,
  getPropertyToday,
  getRemainingArrivals,
} from "@/lib/dashboardBookings";
import { useTranslation, SUPPORTED_LANGUAGES } from "@/lib/i18n";
import { CURRENCY_OPTIONS } from "@/lib/constants/options";
import SearchModal from "./SearchModal";

interface DayStats {
  arrivals: number;
  remainingArrivals: number;
  departures: number;
}

export default function Header({ onMenuToggle }: { onMenuToggle?: () => void }) {
  const router = useRouter();
  const { t, locale, setLocale } = useTranslation();
  const [profileOpen, setProfileOpen] = useState(false);
  const [propertyOpen, setPropertyOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [currency, setCurrency] = useState("EUR");
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hotels, setHotels] = useState<HotelSummary[] | null>(null);
  const [selectedHotel, setSelectedHotel] = useState<HotelSummary | null>(null);
  const currencyEditable = !isPmsOperationsReadModelEnabled();

  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [stats, setStats] = useState<DayStats>({
    arrivals: 0,
    remainingArrivals: 0,
    departures: 0,
  });
  const profileRef = useRef<HTMLDivElement>(null);
  const propertyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
      if (propertyRef.current && !propertyRef.current.contains(e.target as Node)) {
        setPropertyOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Cmd+K (mac) / Ctrl+K (everywhere else) opens the global search modal.
  // Also handle "/" the way GitHub/Linear do, but only when the user
  // isn't already typing into a form field.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isModK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      const target = e.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;
      const isSlash = e.key === "/" && !isTyping;
      if (isModK || isSlash) {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    setUserName(localStorage.getItem("userName") || "");
    setUserEmail(localStorage.getItem("userEmail") || "");

    pmsSettingsService
      .listHotels()
      .then((list) => {
        setHotels(list);
        if (list.length > 0) {
          const savedId = getStoredPmsPropertyId();
          const saved = list.find((h) => h.id === savedId);
          const selected = saved || list[0];
          setSelectedHotel(selected);
          storeSelectedPmsPropertyId(selected.id);
        }
      })
      .catch(() => {});

    if (currencyEditable) {
      settingsService
        .getPropertySettings()
        .then((settings) => {
          if (settings.default_currency) setCurrency(settings.default_currency);
        })
        .catch(() => {});
    }
  }, [currencyEditable]);

  const handleCurrencyChange = async (code: string) => {
    if (!currencyEditable || code === currency || savingCurrency) return;
    setSavingCurrency(true);
    try {
      await settingsService.updatePropertySettings({ default_currency: code });
      // Reload so the dashboard, bookings, financials, and any other
      // currency-aware view picks up the new property default_currency
      // on its next mount.
      window.location.reload();
    } catch {
      setSavingCurrency(false);
    }
  };

  useEffect(() => {
    Promise.all([bookingsService.listAll(), pmsSettingsService.getHotelDetails().catch(() => null)])
      .then(([bookings, hotel]) => {
        const today = getPropertyToday(hotel?.timezone ?? null);
        const arrivalsToday = getArrivalsToday(bookings, today);
        const departuresToday = getDeparturesToday(bookings, today);
        setStats({
          arrivals: arrivalsToday.length,
          remainingArrivals: getRemainingArrivals(arrivalsToday),
          departures: departuresToday.length,
        });
      })
      .catch(console.error);
  }, []);

  const initials = userName
    ? userName
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "?";

  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  return (
    <header className="h-12 bg-white border-b border-gray-200 flex items-center px-4 shrink-0 gap-3">
      {/* Mobile menu button */}
      <button
        onClick={onMenuToggle}
        className="lg:hidden p-1 -ml-1 text-gray-600 hover:text-gray-900"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
      </button>
      {/* Left: property switcher + date */}
      <div className="flex items-center gap-4 shrink-0">
        {/* Property Selector — always shown so single-hotel users can
            still reach the "Add Property" action that lives inside it. */}
        <div className="relative" ref={propertyRef}>
          <button
            onClick={() => setPropertyOpen(!propertyOpen)}
            className="flex items-center gap-1 text-[13px] text-gray-700 hover:text-gray-900 transition-colors max-w-[140px] sm:max-w-[220px]"
            title={selectedHotel?.name || undefined}
          >
            <span className="font-medium truncate">
              {selectedHotel?.name ||
                (hotels === null ? t("common.loading") : t("layout.header.noProperties"))}
            </span>
            <ChevronDownIcon
              className={`w-3.5 h-3.5 text-gray-400 transition-transform shrink-0 ${propertyOpen ? "rotate-180" : ""}`}
            />
          </button>

          {propertyOpen && (
            <div className="absolute top-full left-0 mt-1.5 w-60 bg-white border border-gray-200 rounded-lg shadow-lg py-1.5 z-50">
              <p className="px-3 py-1.5 text-xs text-gray-500">
                {t("layout.header.switchProperty")}
              </p>
              <div className="px-1.5 max-h-60 overflow-y-auto">
                {hotels?.map((hotel) => {
                  const isSelected = selectedHotel?.id === hotel.id;
                  return (
                    <button
                      key={hotel.id}
                      onClick={() => {
                        if (!isSelected) {
                          storeSelectedPmsPropertyId(hotel.id);
                          window.location.reload();
                        }
                        setPropertyOpen(false);
                      }}
                      className={`w-full text-left px-2.5 py-2 rounded-md transition-colors ${
                        isSelected ? "bg-primary-500 text-white" : "hover:bg-gray-50"
                      }`}
                    >
                      <p
                        className={`text-[13px] font-semibold ${isSelected ? "text-white" : "text-gray-900"}`}
                      >
                        {hotel.name}
                      </p>
                      <p
                        className={`text-[11px] ${isSelected ? "text-primary-100" : "text-gray-500"}`}
                      >
                        {hotel.location}
                      </p>
                    </button>
                  );
                })}
              </div>
              <div className="border-t border-gray-100 mt-1 pt-1 px-1.5">
                <button
                  onClick={() => {
                    setPropertyOpen(false);
                    router.push("/setup?mode=add&entryProduct=pms");
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[13px] text-primary-600 hover:bg-primary-50 transition-colors"
                >
                  <PlusIcon className="w-4 h-4" />
                  {t("layout.header.addProperty")}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Separator */}
        <div className="w-px h-5 bg-gray-200 hidden md:block" />

        {/* Date + stats */}
        <div className="hidden md:flex flex-col justify-center">
          <p className="text-[12px] font-semibold text-gray-900 leading-tight">{dateStr}</p>
          <p className="text-[10px] text-gray-400 leading-tight">
            {stats.arrivals} {t("layout.header.arrivals")} · {stats.remainingArrivals}{" "}
            {t("layout.header.remaining")} · {stats.departures} {t("layout.header.departures")}
          </p>
        </div>
      </div>

      {/* Center: global search trigger.
          Mobile (< sm) collapses to an icon-only button so the row fits a
          320px viewport — VAY-374. The same modal opens either way. */}
      <div className="flex-1 flex justify-end sm:justify-center px-2 sm:px-4 min-w-0">
        <button
          onClick={() => setSearchOpen(true)}
          aria-label={t("search.placeholder")}
          className="sm:hidden w-8 h-8 flex items-center justify-center rounded-md border border-gray-200 bg-gray-50 text-gray-500 hover:bg-white hover:border-gray-300 hover:text-gray-700 transition-colors shrink-0"
        >
          <MagnifyingGlassIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => setSearchOpen(true)}
          className="hidden sm:flex w-full max-w-sm items-center gap-2 h-8 px-3 rounded-md border border-gray-200 bg-gray-50 text-gray-400 hover:bg-white hover:border-gray-300 hover:text-gray-600 transition-colors"
        >
          <MagnifyingGlassIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[12px] flex-1 text-left truncate">{t("search.placeholder")}</span>
        </button>
      </div>

      {/* Right: avatar */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Profile avatar */}
        <div className="relative" ref={profileRef}>
          <button
            onClick={() => setProfileOpen(!profileOpen)}
            className="w-7 h-7 bg-primary-600 rounded-full flex items-center justify-center text-white text-[10px] font-semibold hover:bg-primary-700 transition-colors"
          >
            {initials}
          </button>

          {profileOpen && (
            <div className="absolute top-full right-0 mt-1.5 w-52 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1">
              <div className="px-3.5 py-2.5">
                <p
                  className="text-[13px] font-semibold text-gray-900 truncate"
                  title={userName || undefined}
                >
                  {userName || t("layout.header.user")}
                </p>
                <p className="text-xs text-gray-500 truncate" title={userEmail || undefined}>
                  {userEmail}
                </p>
              </div>
              <div className="border-t border-gray-100" />
              <div className="py-1">
                <button
                  onClick={() => {
                    setProfileOpen(false);
                    router.push("/settings");
                  }}
                  className="w-full text-left px-3.5 py-2 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  {t("layout.sidebar.settings")}
                </button>
                {/* Language selector */}
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setLangOpen(!langOpen);
                    }}
                    className="w-full flex items-center justify-between px-3.5 py-2 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <span>{t("layout.header.language")}</span>
                    <span className="text-gray-400">
                      {SUPPORTED_LANGUAGES.find((l) => l.code === locale)?.flag}{" "}
                      {SUPPORTED_LANGUAGES.find((l) => l.code === locale)?.nativeName}
                    </span>
                  </button>
                  {langOpen && (
                    <div className="absolute right-full top-0 mr-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 max-h-72 overflow-y-auto">
                      {SUPPORTED_LANGUAGES.map((lang) => (
                        <button
                          key={lang.code}
                          onClick={() => {
                            setLocale(lang.code);
                            setLangOpen(false);
                            setProfileOpen(false);
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left transition-colors ${
                            locale === lang.code
                              ? "bg-primary-50 text-primary-700 font-medium"
                              : "text-gray-700 hover:bg-gray-50"
                          }`}
                        >
                          <span>{lang.flag}</span>
                          <span>{lang.nativeName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Currency selector */}
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setCurrencyOpen(!currencyOpen);
                    }}
                    disabled={savingCurrency || !currencyEditable}
                    className="w-full flex items-center justify-between px-3.5 py-2 text-[13px] text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
                  >
                    <span>{t("layout.header.currency")}</span>
                    <span className="text-gray-400">
                      {CURRENCY_OPTIONS.find((c) => c.code === currency)?.flag} {currency}
                    </span>
                  </button>
                  {currencyOpen && (
                    <div className="absolute right-full top-0 mr-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 max-h-72 overflow-y-auto">
                      {CURRENCY_OPTIONS.map((cur) => (
                        <button
                          key={cur.code}
                          onClick={() => {
                            setCurrencyOpen(false);
                            setProfileOpen(false);
                            handleCurrencyChange(cur.code);
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left transition-colors ${
                            currency === cur.code
                              ? "bg-primary-50 text-primary-700 font-medium"
                              : "text-gray-700 hover:bg-gray-50"
                          }`}
                        >
                          <span>{cur.flag}</span>
                          <span>{cur.code}</span>
                          <span className="text-gray-400 truncate">{cur.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="border-t border-gray-100" />
              <div className="py-1">
                <button
                  onClick={() => authService.logout()}
                  className="w-full text-left px-3.5 py-2 text-[13px] text-red-500 hover:bg-red-50 transition-colors"
                >
                  {t("layout.header.signOut")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
