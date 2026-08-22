"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { bookingsService } from "@/services/bookings";
import { roomsService, RoomType } from "@/services/rooms";
import { useTranslation } from "@/lib/i18n";

interface SearchResult {
  id: string;
  label: string;
  sublabel: string;
  category: "page" | "setting" | "reservation" | "room";
  href: string;
}

interface PageEntry {
  id: string;
  labelKey: string;
  sublabelKey: string;
  href: string;
}

interface SettingEntry {
  id: string;
  labelKey: string;
  sublabelKey: string;
  href: string;
  // Lowercase, language-agnostic keywords matched in addition to the
  // translated label/sublabel — e.g. "money" → currency, "arrival" → check-in.
  keywords: string[];
}

const PAGES: PageEntry[] = [
  {
    id: "dashboard",
    labelKey: "layout.sidebar.dashboard",
    sublabelKey: "search.pageDashboardHint",
    href: "/dashboard",
  },
  {
    id: "calendar",
    labelKey: "layout.sidebar.calendar",
    sublabelKey: "search.pageCalendarHint",
    href: "/calendar",
  },
  {
    id: "bookings",
    labelKey: "layout.sidebar.reservations",
    sublabelKey: "search.pageReservationsHint",
    href: "/bookings",
  },
  {
    id: "rooms",
    labelKey: "layout.sidebar.roomsAndRates",
    sublabelKey: "search.pageRoomsHint",
    href: "/rooms",
  },
  {
    id: "channel-manager",
    labelKey: "layout.sidebar.channelManager",
    sublabelKey: "search.pageChannelManagerHint",
    href: "/channel-manager",
  },
  {
    id: "settings",
    labelKey: "layout.sidebar.settings",
    sublabelKey: "search.pageSettingsHint",
    href: "/settings",
  },
];

const SETTINGS: SettingEntry[] = [
  {
    id: "change-language",
    labelKey: "search.settingChangeLanguage",
    sublabelKey: "search.settingChangeLanguageHint",
    href: "/settings#language",
    keywords: [
      "language",
      "locale",
      "translate",
      "translation",
      "sprache",
      "idioma",
      "langue",
      "bahasa",
      "语言",
      "язык",
    ],
  },
  {
    id: "change-currency",
    labelKey: "search.settingChangeCurrency",
    sublabelKey: "search.settingChangeCurrencyHint",
    href: "/settings#currency",
    keywords: ["currency", "money", "price", "eur", "usd", "gbp", "idr", "fx"],
  },
  {
    id: "property-details",
    labelKey: "search.settingPropertyDetails",
    sublabelKey: "search.settingPropertyDetailsHint",
    href: "/settings#property-details",
    keywords: [
      "property",
      "property details",
      "property settings",
      "hotel",
      "address",
      "city",
      "country",
      "state",
      "zip",
      "phone",
      "timezone",
      "lat",
      "long",
      "latitude",
      "longitude",
    ],
  },
  {
    id: "instant-booking",
    labelKey: "search.settingInstantBooking",
    sublabelKey: "search.settingInstantBookingHint",
    href: "/settings#booking-engine",
    keywords: [
      "instant book",
      "instant booking",
      "auto accept",
      "request to book",
      "booking request",
      "accept",
      "booking engine",
      "booking settings",
    ],
  },
  {
    id: "calendar-settings",
    labelKey: "search.settingCalendar",
    sublabelKey: "search.settingCalendarHint",
    href: "/settings#calendar",
    keywords: [
      "auto-rearrange",
      "auto rearrange",
      "rearrange",
      "auto-open",
      "auto open",
      "future calendar",
      "calendar settings",
      "calendar auto",
    ],
  },
  {
    id: "checkin-checklist",
    labelKey: "search.settingCheckinChecklist",
    sublabelKey: "search.settingCheckinChecklistHint",
    href: "/settings/checkin-checklist",
    keywords: [
      "checklist",
      "check-in checklist",
      "checkin checklist",
      "arrival tasks",
      "guest tasks",
    ],
  },
  {
    id: "checkout-inspection",
    labelKey: "search.settingCheckoutInspection",
    sublabelKey: "search.settingCheckoutInspectionHint",
    href: "/settings/checkout-inspection",
    keywords: [
      "checkout inspection",
      "check-out inspection",
      "inspection",
      "departure checklist",
      "room inspection",
    ],
  },
  {
    id: "localization",
    labelKey: "search.settingLocalization",
    sublabelKey: "search.settingLocalizationHint",
    href: "/settings#localization",
    keywords: ["localization", "localisation", "locale settings", "regional"],
  },
];

export default function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [rooms, setRooms] = useState<RoomType[]>([]);
  const [roomsLoaded, setRoomsLoaded] = useState(false);

  // Load room types once (small dataset, OK to filter client-side)
  useEffect(() => {
    if (!open || roomsLoaded) return;
    roomsService
      .list()
      .then((r) => {
        setRooms(r);
        setRoomsLoaded(true);
      })
      .catch(console.error);
  }, [open, roomsLoaded]);

  // Reset state when modal opens
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    setResults([]);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  // Search with debounce
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setActiveIndex(0);
      return;
    }

    const q = query.toLowerCase();
    const timer = setTimeout(async () => {
      // Pages match instantly against the translated label so the user
      // can jump between sections regardless of UI language.
      const pageResults: SearchResult[] = PAGES.filter((p) => {
        const label = t(p.labelKey).toLowerCase();
        return label.includes(q) || p.id.includes(q);
      }).map((p) => ({
        id: `page-${p.id}`,
        label: t(p.labelKey),
        sublabel: t(p.sublabelKey),
        category: "page",
        href: p.href,
      }));

      // Settings actions match against translated label/sublabel + keywords,
      // so synonyms like "money" or "arrival time" still surface the right setting.
      const settingResults: SearchResult[] = SETTINGS.filter((s) => {
        const label = t(s.labelKey).toLowerCase();
        const sublabel = t(s.sublabelKey).toLowerCase();
        if (label.includes(q) || sublabel.includes(q)) return true;
        return s.keywords.some((k) => k.includes(q) || q.includes(k));
      }).map((s) => ({
        id: `setting-${s.id}`,
        label: t(s.labelKey),
        sublabel: t(s.sublabelKey),
        category: "setting",
        href: s.href,
      }));

      // Server-side booking search
      let bookingResults: SearchResult[] = [];
      try {
        const res = await bookingsService.list({ search: query.trim(), limit: 5 });
        bookingResults = res.bookings.map((b) => ({
          id: b.id,
          label: `${b.guestFirstName} ${b.guestLastName}`,
          sublabel: `${b.bookingReference} · ${b.roomName} · ${b.checkIn}`,
          category: "reservation",
          href: `/bookings/${b.id}`,
        }));
      } catch {
        // Silently handle — rooms will still show
      }

      // Client-side room filtering (small dataset)
      const roomResults: SearchResult[] = rooms
        .filter((r) => r.name?.toLowerCase().includes(q) || r.category?.toLowerCase().includes(q))
        .slice(0, 5)
        .map((r) => ({
          id: r.id,
          label: r.name,
          sublabel: `${r.category} · ${r.totalRooms} rooms · €${r.baseRate}/night`,
          category: "room",
          href: `/rooms`,
        }));

      setResults([...pageResults, ...settingResults, ...bookingResults, ...roomResults]);
      setActiveIndex(0);
    }, 250);

    return () => clearTimeout(timer);
  }, [query, rooms, t]);

  const navigate = useCallback(
    (result: SearchResult) => {
      onClose();
      router.push(result.href);
    },
    [onClose, router],
  );

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[activeIndex]) {
        e.preventDefault();
        navigate(results[activeIndex]);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, results, activeIndex, navigate, onClose]);

  if (!open) return null;

  const CATEGORY_LABELS: Record<string, string> = {
    page: t("search.categoryPages"),
    setting: t("search.categorySettings"),
    reservation: t("search.categoryReservations"),
    room: t("search.categoryRoomTypes"),
  };

  // Group results by category
  const grouped: { category: string; items: SearchResult[] }[] = [];
  for (const r of results) {
    const group = grouped.find((g) => g.category === r.category);
    if (group) group.items.push(r);
    else grouped.push({ category: r.category, items: [r] });
  }

  let globalIndex = 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh]"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 h-12 border-b border-gray-100">
          <svg
            className="w-4 h-4 text-gray-400 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search.placeholder")}
            className="flex-1 text-sm text-gray-900 placeholder:text-gray-400 outline-none bg-transparent"
          />
          <kbd className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-gray-50 text-gray-400 leading-none">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto">
          {query.trim() && results.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              {t("search.noResults", { query })}
            </div>
          )}

          {grouped.map((group) => (
            <div key={group.category}>
              <div className="px-4 pt-3 pb-1.5 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                {CATEGORY_LABELS[group.category] || group.category}
              </div>
              {group.items.map((item) => {
                const idx = globalIndex++;
                return (
                  <button
                    key={item.id}
                    onClick={() => navigate(item)}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors ${
                      idx === activeIndex ? "bg-primary-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                        item.category === "page"
                          ? "bg-violet-50 text-violet-500"
                          : item.category === "setting"
                            ? "bg-amber-50 text-amber-500"
                            : item.category === "reservation"
                              ? "bg-blue-50 text-blue-500"
                              : "bg-emerald-50 text-emerald-500"
                      }`}
                    >
                      {item.category === "page" ? (
                        <svg
                          className="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M5 12h14" />
                          <path d="m13 18 6-6-6-6" />
                        </svg>
                      ) : item.category === "setting" ? (
                        <svg
                          className="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="3" />
                          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                      ) : item.category === "reservation" ? (
                        <svg
                          className="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                          <circle cx="9" cy="7" r="4" />
                        </svg>
                      ) : (
                        <svg
                          className="w-3.5 h-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          <polyline points="9 22 9 12 15 12 15 22" />
                        </svg>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-gray-900 truncate">{item.label}</p>
                      <p className="text-[11px] text-gray-400 truncate">{item.sublabel}</p>
                    </div>
                    {idx === activeIndex && (
                      <kbd className="text-[10px] border border-gray-200 rounded px-1.5 py-0.5 bg-gray-50 text-gray-400 leading-none shrink-0">
                        ↵
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {!query.trim() && (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              {t("search.startTyping")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
