"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  clearStoredPmsPropertyId,
  getStoredPmsPropertyId,
  storeSelectedPmsPropertyId,
  type PmsPropertySummary,
} from "@/services/api/pmsPropertyClient";
import { authService } from "@/services/auth";
import { resolvePmsSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { pmsSettingsService } from "@/services/settings";
import { useTranslation } from "@/lib/i18n";
import { isPmsSetupExitPath } from "@vayada/product-onboarding";

/**
 * Post-login hotel picker for the PMS.
 *
 * Mirrors the booking-admin /choose-property page. Multi-hotel users
 * land here after login and pick which property to manage. The
 * selection is persisted to localStorage.selectedHotelId. Typed PMS
 * operations use this as the path-scoped pms_property id.
 *
 * The "Add a new property" action passes through the local setup alias
 * to the canonical Marketplace wizard while retaining PMS as the return product.
 */
export default function PmsChoosePropertyPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [hotels, setHotels] = useState<PmsPropertySummary[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const authorized = await authService.ensureSession();
      if (cancelled) return;
      if (!authorized || !authService.isHotelAdmin()) {
        router.replace("/login");
        return;
      }
      try {
        const list = await pmsSettingsService.listHotels();
        if (cancelled) return;

        if (list.length === 0) {
          if (isPmsSetupExitPath(`${window.location.pathname}${window.location.search}`)) {
            setHotels([]);
            return;
          }
          router.replace("/setup");
          return;
        }
        if (list.length === 1) {
          storeSelectedPmsPropertyId(list[0].id);
          const decision = await resolvePmsSetupGuard("/dashboard");
          if (cancelled) return;
          if (decision.action === "redirect_to_setup") {
            window.location.replace(decision.redirectPath);
            return;
          }
          router.replace("/dashboard");
          return;
        }
        setHotels(list);
      } catch (e) {
        if (cancelled) return;
        if (getStoredPmsPropertyId()) {
          router.replace("/dashboard");
          return;
        }
        setError(e instanceof Error ? e.message : t("auth.chooseProperty.loadError"));
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [router, t]);

  const selectHotel = async (hotel: PmsPropertySummary) => {
    storeSelectedPmsPropertyId(hotel.id);
    try {
      const decision = await resolvePmsSetupGuard("/dashboard");
      if (decision.action === "redirect_to_setup") {
        window.location.replace(decision.redirectPath);
        return;
      }
      router.replace("/dashboard");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("auth.chooseProperty.loadError"));
    }
  };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-8 text-center">
          <p className="text-[14px] text-red-600 mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="text-[13px] text-primary-600 hover:text-primary-700 font-medium"
          >
            {t("auth.chooseProperty.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!hotels) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="w-6 h-6 border-2 border-primary-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const userName = (typeof window !== "undefined" && localStorage.getItem("userName")) || "";

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-8">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center justify-center w-10 h-10 bg-primary-600 rounded-lg mb-3">
            <svg
              width="18"
              height="18"
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
          <h1 className="text-xl font-bold text-gray-900">
            {userName
              ? `${t("auth.chooseProperty.welcomeBack")}, ${userName}`
              : t("auth.chooseProperty.welcome")}
          </h1>
          <p className="text-[13px] text-gray-500 mt-1">{t("auth.chooseProperty.subtitle")}</p>
        </div>

        <div className="space-y-2">
          {hotels.length === 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-center text-sm leading-6 text-amber-950">
              No property has been created yet. Start or resume setup when you&apos;re ready.
            </p>
          )}
          {hotels.map((hotel) => (
            <button
              key={hotel.id}
              onClick={() => selectHotel(hotel)}
              className="w-full text-left p-4 border border-gray-200 rounded-lg hover:border-primary-500 hover:bg-primary-50 transition-colors group"
            >
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center group-hover:bg-primary-100">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-gray-500 group-hover:text-primary-600"
                  >
                    <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z" />
                    <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
                    <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2" />
                    <path d="M10 6h4" />
                    <path d="M10 10h4" />
                    <path d="M10 14h4" />
                    <path d="M10 18h4" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold text-gray-900 truncate">{hotel.name}</p>
                  {(hotel.location || hotel.country) && (
                    <p className="text-[12px] text-gray-500 truncate">
                      {[hotel.location, hotel.country].filter(Boolean).join(", ")}
                    </p>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="border-t border-gray-100 mt-5 pt-4">
          <button
            onClick={() => {
              clearStoredPmsPropertyId();
              window.location.replace("/setup?mode=add");
            }}
            className="w-full flex items-center justify-center gap-2 text-[13px] text-primary-600 hover:text-primary-700 font-medium py-2"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {t("auth.chooseProperty.addProperty")}
          </button>
        </div>
      </div>
    </div>
  );
}
