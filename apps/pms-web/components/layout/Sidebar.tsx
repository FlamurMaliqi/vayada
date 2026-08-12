"use client";

import { Fragment, useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BoltIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
  CheckIcon,
  StarIcon,
} from "@heroicons/react/24/outline";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import {
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
  type BrowserAuthSurface,
} from "@vayada/product-onboarding";

type Product = "booking" | "pms" | "marketplace";

const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";
const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || "https://app.vayada.com";

interface NavItem {
  labelKey?: string;
  label?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
  unavailable?: boolean;
}

const CORE_NAV_ITEMS: Omit<NavItem, "badge">[] = [
  { labelKey: "layout.sidebar.dashboard", href: "/dashboard", icon: DashboardIcon },
  { labelKey: "layout.sidebar.calendar", href: "/calendar", icon: CalendarIcon },
  { labelKey: "layout.sidebar.reservations", href: "/bookings", icon: ReservationsIcon },
  { label: "Reviews", href: "/reviews", icon: StarIcon },
  { labelKey: "layout.sidebar.roomsAndRates", href: "/rooms", icon: RoomsIcon },
  {
    labelKey: "layout.sidebar.channelManager",
    href: "/channel-manager",
    icon: ChannelsIcon,
    unavailable: true,
  },
  { labelKey: "layout.sidebar.settings", href: "/settings", icon: SettingsIcon },
];

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [enabledProducts, setEnabledProducts] = useState<Set<Product>>(
    () => new Set<Product>(["pms"]),
  );
  const { t } = useTranslation();
  const switcherRef = useRef<HTMLDivElement>(null);

  const switchApp = async (
    baseUrl: string,
    targetSurface: BrowserAuthSurface,
    targetPath: string,
  ) => {
    setSwitchError(null);
    setShowSwitcher(false);
    const csrfToken = getAuthCsrfToken();
    if (csrfToken) {
      try {
        window.location.href = await createBrowserAuthHandoff({
          csrfToken,
          sourceSurface: "pms-web",
          targetPath,
          targetSurface,
        });
        return;
      } catch {
        // Require target-app authentication when the one-time exchange is unavailable.
      }
    }
    try {
      window.location.href = crossAppReauthenticationUrl(baseUrl, targetPath);
    } catch {
      setSwitchError("We couldn't open that app. Please try again later.");
    }
  };

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setShowSwitcher(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void sharedHotelSetupApi
      .getStatus({ entryProduct: "pms" })
      .then((status) => {
        if (!cancelled) {
          setEnabledProducts(
            new Set<Product>([
              "pms",
              ...status.organization.tracks.flatMap((track) =>
                track.components
                  .filter((component) => component.access === "active")
                  .map((component) => component.product),
              ),
            ]),
          );
        }
      })
      .catch(() => {
        // Keep the current product available when account status cannot be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const baseNavItems: Omit<NavItem, "badge">[] = [
    CORE_NAV_ITEMS[0],
    CORE_NAV_ITEMS[1],
    CORE_NAV_ITEMS[2],
    CORE_NAV_ITEMS[3],
    CORE_NAV_ITEMS[4],
    CORE_NAV_ITEMS[5],
  ];

  const navItems: NavItem[] = baseNavItems;

  return (
    <aside
      className={cn(
        "h-full bg-white border-r border-gray-200 flex flex-col shrink-0 transition-all duration-200",
        collapsed ? "w-14" : "w-52",
      )}
    >
      {/* App Switcher */}
      <div className="relative border-b border-gray-200 shrink-0" ref={switcherRef}>
        <button
          onClick={() => !collapsed && setShowSwitcher(!showSwitcher)}
          className={cn(
            "h-12 w-full px-3 flex items-center gap-2.5 hover:bg-gray-50 transition-colors",
            collapsed && "justify-center px-0",
          )}
        >
          <div className="w-7 h-7 bg-emerald-600 rounded-md flex items-center justify-center shrink-0">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
              <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
              <path d="M3 7h18" />
              <path d="M8 11h8" />
            </svg>
          </div>
          {!collapsed && (
            <>
              <div className="min-w-0 text-left flex-1">
                <p className="text-xs font-semibold text-gray-900 leading-tight">
                  {t("layout.sidebar.propertyManager")}
                </p>
                <p className="text-[10px] text-gray-500 leading-tight truncate">
                  {t("layout.sidebar.propertyManagerDescription")}
                </p>
              </div>
              <ChevronDownIcon
                className={cn(
                  "w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform",
                  showSwitcher && "rotate-180",
                )}
              />
            </>
          )}
        </button>

        {switchError && (
          <p className="px-3 py-2 text-xs text-red-600" role="alert">
            {switchError}
          </p>
        )}

        {showSwitcher && !collapsed && (
          <div className="absolute top-full left-2 right-2 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1.5">
            <p className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
              <svg
                className="w-3 h-3"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="3" y="3" width="7" height="7" />
                <rect x="14" y="3" width="7" height="7" />
                <rect x="3" y="14" width="7" height="7" />
                <rect x="14" y="14" width="7" height="7" />
              </svg>
              {t("layout.sidebar.switchApp")}
            </p>
            {enabledProducts.has("booking") && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void switchApp(BOOKING_ADMIN_URL, "booking-admin", "/dashboard");
                }}
                className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors"
              >
                <div className="w-7 h-7 bg-primary-500 rounded-md flex items-center justify-center shrink-0">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 18 18"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <rect
                      x="2"
                      y="3"
                      width="14"
                      height="12"
                      rx="2"
                      stroke="white"
                      strokeWidth="1.5"
                    />
                    <path d="M2 7H16" stroke="white" strokeWidth="1.5" />
                    <path d="M6 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M12 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-gray-900 leading-tight">
                    {t("layout.sidebar.bookingEngine")}
                  </p>
                  <p className="text-[10px] text-gray-500 leading-tight">
                    {t("layout.sidebar.bookingEngineDescription")}
                  </p>
                </div>
              </a>
            )}
            {enabledProducts.has("marketplace") && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void switchApp(MARKETPLACE_URL, "marketplace-web", "/marketplace");
                }}
                className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors"
              >
                <div className="w-7 h-7 bg-violet-600 rounded-md flex items-center justify-center shrink-0">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="white"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-gray-900 leading-tight">
                    {t("layout.sidebar.creatorMarketplace")}
                  </p>
                  <p className="text-[10px] text-gray-500 leading-tight">
                    {t("layout.sidebar.creatorMarketplaceDescription")}
                  </p>
                </div>
              </a>
            )}
            <button
              onClick={() => setShowSwitcher(false)}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors w-full"
            >
              <div className="w-7 h-7 bg-emerald-600 rounded-md flex items-center justify-center shrink-0">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
                  <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
                  <path d="M3 7h18" />
                  <path d="M8 11h8" />
                </svg>
              </div>
              <div className="min-w-0 flex-1 text-left">
                <p className="text-xs font-medium text-gray-900 leading-tight">
                  {t("layout.sidebar.propertyManager")}
                </p>
                <p className="text-[10px] text-gray-500 leading-tight">
                  {t("layout.sidebar.propertyManagerDescription")}
                </p>
              </div>
              <CheckIcon className="w-4 h-4 text-primary-500 shrink-0" />
            </button>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          const label = item.labelKey ? t(item.labelKey) : item.label || "";
          const featureHubActive = pathname.startsWith("/settings/feature-hub");
          return (
            <Fragment key={item.href}>
              {item.unavailable ? (
                <div
                  aria-disabled="true"
                  className={cn(
                    "relative flex cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-gray-400",
                    collapsed && "justify-center px-0",
                  )}
                  title={`${label} — not available yet`}
                >
                  <item.icon className="h-[18px] w-[18px] shrink-0 text-gray-300" />
                  {!collapsed && (
                    <>
                      <span className="flex-1">{label}</span>
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                        Soon
                      </span>
                    </>
                  )}
                </div>
              ) : (
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "relative flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors",
                    isActive
                      ? "text-gray-900 font-semibold bg-gray-50"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-50",
                    collapsed && "justify-center px-0",
                  )}
                  title={collapsed ? label : undefined}
                >
                  <item.icon
                    className={cn(
                      "w-[18px] h-[18px] shrink-0",
                      isActive ? "text-gray-900" : "text-gray-400",
                    )}
                  />
                  {!collapsed && (
                    <>
                      <span className="flex-1">{label}</span>
                      {item.badge != null && (
                        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-bold bg-emerald-600 text-white rounded-full shrink-0">
                          {item.badge > 99 ? "99+" : item.badge}
                        </span>
                      )}
                    </>
                  )}
                  {collapsed && item.badge != null && (
                    <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-emerald-600 rounded-full" />
                  )}
                </Link>
              )}
              {item.href === "/settings" && !collapsed && (
                <Link
                  href="/settings/feature-hub"
                  onClick={onNavigate}
                  className={cn(
                    "ml-5 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] transition-colors",
                    featureHubActive
                      ? "bg-emerald-50 font-semibold text-emerald-700"
                      : "text-gray-500 hover:bg-gray-50 hover:text-gray-900",
                  )}
                >
                  <BoltIcon className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("layout.sidebar.featureHub")}</span>
                </Link>
              )}
            </Fragment>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <div className="px-2 pb-2">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            "flex items-center gap-2 w-full px-2.5 py-1.5 text-[13px] text-gray-500 hover:text-gray-700 rounded-md hover:bg-gray-50 transition-colors",
            collapsed && "justify-center px-0",
          )}
        >
          <ChevronLeftIcon
            className={cn("w-3.5 h-3.5 transition-transform", collapsed && "rotate-180")}
          />
          {!collapsed && <span>{t("layout.sidebar.collapse")}</span>}
        </button>
      </div>
    </aside>
  );
}

/* ── Icon components ── */

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
      <path d="M8 14h.01" />
      <path d="M12 14h.01" />
      <path d="M16 14h.01" />
      <path d="M8 18h.01" />
      <path d="M12 18h.01" />
    </svg>
  );
}

function ReservationsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </svg>
  );
}

function RoomsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
      <path d="M6 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2" />
      <path d="M3 7h18" />
      <path d="M8 11h8" />
    </svg>
  );
}

function ChannelsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
