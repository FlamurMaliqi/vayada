"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, CheckIcon } from "@heroicons/react/24/outline";
import { STORAGE_KEYS } from "@/lib/constants";
import type { UserType } from "@/lib/types";
import { sharedHotelSetupApi } from "@/services/api/sharedHotelSetupClient";
import { getAuthCsrfToken } from "@/services/auth/sessionStore";
import {
  createBrowserAuthHandoff,
  crossAppReauthenticationUrl,
  type BrowserAuthSurface,
} from "@vayada/product-onboarding";

type Product = "booking" | "pms" | "marketplace";

const PMS_FRONTEND_URL = process.env.NEXT_PUBLIC_PMS_URL || "https://pms.vayada.com";
const BOOKING_ADMIN_URL =
  process.env.NEXT_PUBLIC_BOOKING_ADMIN_URL || "https://admin.booking.vayada.com";

export function AppSwitcher({
  isCollapsed,
  placement = "nav",
}: {
  isCollapsed: boolean;
  placement?: "brand" | "nav";
}) {
  const [open, setOpen] = useState(false);
  const [userType, setUserType] = useState<UserType | null>(null);
  const [enabledProducts, setEnabledProducts] = useState<Set<Product>>(
    () => new Set<Product>(["marketplace"]),
  );
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setUserType(localStorage.getItem(STORAGE_KEYS.USER_TYPE) as UserType | null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void sharedHotelSetupApi
      .getStatus({ entryProduct: "marketplace" })
      .then((status) => {
        if (!cancelled) {
          setEnabledProducts(
            new Set<Product>([
              "marketplace",
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

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  // PMS / Booking Engine are hotel-only products. Creators have nothing to
  // switch to, so the switcher is hidden for them.
  const canSwitchToHotelApps = userType === "hotel";
  if (!canSwitchToHotelApps) return null;

  const goTo = async (baseUrl: string, targetSurface: BrowserAuthSurface, targetPath: string) => {
    setOpen(false);
    const csrfToken = getAuthCsrfToken();
    if (csrfToken) {
      try {
        window.location.href = await createBrowserAuthHandoff({
          csrfToken,
          sourceSurface: "marketplace-web",
          targetPath,
          targetSurface,
        });
        return;
      } catch {
        // A failed/disabled handoff falls back to normal target-app authentication.
      }
    }
    window.location.href = crossAppReauthenticationUrl(baseUrl, targetPath);
  };

  return (
    <div
      ref={rootRef}
      className={`relative ${placement === "nav" ? "border-b border-gray-100" : "w-full"}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center transition-colors hover:bg-gray-50 ${
          isCollapsed
            ? "h-12 justify-center px-2"
            : placement === "brand"
              ? "h-12 gap-2.5 px-3"
              : "gap-2.5 px-3 py-3"
        }`}
        title={isCollapsed ? "Switch app" : undefined}
      >
        <div className="w-7 h-7 bg-violet-600 rounded-md flex items-center justify-center shrink-0">
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
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        </div>
        {!isCollapsed && (
          <>
            <div className="min-w-0 text-left flex-1">
              <p className="text-xs font-semibold text-gray-900 leading-tight">Marketplace</p>
              <p className="text-[10px] text-gray-500 leading-tight truncate">
                Creator collaborations
              </p>
            </div>
            <ChevronDownIcon
              className={`w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform ${
                open ? "rotate-180" : ""
              }`}
            />
          </>
        )}
      </button>

      {open && (
        <div
          className={`absolute top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50 py-1.5 ${
            isCollapsed ? "left-2 w-56" : "left-2 right-2"
          }`}
        >
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
            Switch app
          </p>

          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 transition-colors w-full"
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
            <div className="min-w-0 flex-1 text-left">
              <p className="text-xs font-medium text-gray-900 leading-tight">Marketplace</p>
              <p className="text-[10px] text-gray-500 leading-tight">Creator collaborations</p>
            </div>
            <CheckIcon className="w-4 h-4 text-primary-500 shrink-0" />
          </button>

          {enabledProducts.has("booking") && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void goTo(BOOKING_ADMIN_URL, "booking-admin", "/dashboard");
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
                <p className="text-xs font-medium text-gray-900 leading-tight">Booking Engine</p>
                <p className="text-[10px] text-gray-500 leading-tight">Direct bookings</p>
              </div>
            </a>
          )}

          {enabledProducts.has("pms") && (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                void goTo(PMS_FRONTEND_URL, "pms-web", "/dashboard");
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
                <p className="text-xs font-medium text-gray-900 leading-tight">Property Manager</p>
                <p className="text-[10px] text-gray-500 leading-tight">PMS</p>
              </div>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
