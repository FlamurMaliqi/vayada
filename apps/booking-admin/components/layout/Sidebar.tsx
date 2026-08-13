"use client";

import { Fragment, useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BoltIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronDownIcon,
  CheckIcon,
  Cog6ToothIcon,
  UserGroupIcon,
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

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_FRONTEND_URL || "https://pms.vayada.com";
const MARKETPLACE_URL = process.env.NEXT_PUBLIC_MARKETPLACE_URL || "https://app.vayada.com";
const RESERVATIONS_NAV_ENABLED = process.env.NEXT_PUBLIC_BOOKING_RESERVATIONS_ENABLED === "true";

interface NavItem {
  labelKey?: string;
  label?: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

const coreNavItems: NavItem[] = [
  { labelKey: "layout.sidebar.dashboard", href: "/", icon: DashboardIcon },
  ...(RESERVATIONS_NAV_ENABLED
    ? [{ label: "Reservations", href: "/reservations", icon: CalendarDaysIcon }]
    : []),
  { labelKey: "layout.sidebar.designStudio", href: "/design-studio", icon: DesignStudioIcon },
  { labelKey: "layout.sidebar.bookingFlow", href: "/booking-flow", icon: BookingFlowIcon },
  { labelKey: "layout.sidebar.settings", href: "/settings", icon: Cog6ToothIcon },
  { label: "Affiliates", href: "/affiliates", icon: UserGroupIcon },
];

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [enabledProducts, setEnabledProducts] = useState<Set<Product>>(
    () => new Set<Product>(["booking"]),
  );
  const switcherRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const navItems = coreNavItems;

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
          sourceSurface: "booking-admin",
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
      .getStatus({ entryProduct: "booking" })
      .then((status) => {
        if (!cancelled) {
          setEnabledProducts(
            new Set<Product>([
              "booking",
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
          <div className="w-7 h-7 bg-primary-500 rounded-md flex items-center justify-center shrink-0">
            <svg
              width="14"
              height="14"
              viewBox="0 0 18 18"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect x="2" y="3" width="14" height="12" rx="2" stroke="white" strokeWidth="1.5" />
              <path d="M2 7H16" stroke="white" strokeWidth="1.5" />
              <path d="M6 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M12 3V1" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          {!collapsed && (
            <>
              <div className="min-w-0 text-left flex-1">
                <p className="text-xs font-semibold text-gray-900 leading-tight">
                  {t("layout.sidebar.bookingEngine")}
                </p>
                <p className="text-[10px] text-gray-500 leading-tight truncate">
                  {t("layout.sidebar.bookingEngineDescription")}
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
            <button
              onClick={() => setShowSwitcher(false)}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors w-full"
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
              <div className="min-w-0 flex-1 text-left">
                <p className="text-xs font-medium text-gray-900 leading-tight">
                  {t("layout.sidebar.bookingEngine")}
                </p>
                <p className="text-[10px] text-gray-500 leading-tight">
                  {t("layout.sidebar.bookingEngineDescription")}
                </p>
              </div>
              <CheckIcon className="w-4 h-4 text-primary-500 shrink-0" />
            </button>
            {enabledProducts.has("pms") && (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void switchApp(PMS_FRONTEND_URL, "pms-web", "/dashboard");
                }}
                className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors"
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
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-gray-900 leading-tight">
                    {t("layout.sidebar.propertyManager")}
                  </p>
                  <p className="text-[10px] text-gray-500 leading-tight">
                    {t("layout.sidebar.propertyManagerDescription")}
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
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const label = item.labelKey ? t(item.labelKey) : item.label || "";
          const featureHubActive = pathname.startsWith("/settings/feature-hub");
          return (
            <Fragment key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-2.5 px-2.5 py-2 rounded-md text-[13px] transition-colors",
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
                {!collapsed && <span>{label}</span>}
              </Link>
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

      {/* Bottom section */}
      <div className="px-2 pb-2 space-y-1.5">
        {/* Collapse toggle */}
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

/* Custom icon components matching the screenshot */

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

function DesignStudioIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
    </svg>
  );
}

function BookingFlowIcon({ className }: { className?: string }) {
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
      <rect x="3" y="4" width="4" height="4" rx="1" />
      <rect x="10" y="4" width="4" height="4" rx="1" />
      <rect x="17" y="4" width="4" height="4" rx="1" />
      <path d="M5 8v3" />
      <path d="M12 8v3" />
      <path d="M19 8v3" />
      <path d="M5 11h14" />
      <path d="M12 11v5" />
      <rect x="9" y="16" width="6" height="4" rx="1" />
    </svg>
  );
}
