"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authService } from "@/services/auth";
import { resolveBookingSetupGuard } from "@/lib/utils/sharedSetupGuard";
import { settingsService, type HotelSummary } from "@/services/settings";
import { useTranslation } from "@/lib/i18n";

/**
 * Post-login hotel picker.
 *
 * When a user owns multiple properties, the login flow sends them here
 * instead of dropping them into an arbitrary "last-used" dashboard.
 * The page fetches the user's hotel list and lets them explicitly pick
 * one — that choice persists to localStorage as `selectedHotelId` and
 * drives target route resource selection on subsequent API calls.
 *
 * Edge cases handled inline:
 *   - 0 hotels → send through /setup to the canonical Marketplace wizard
 *   - 1 hotel  → auto-select and bounce to /dashboard (no modal spam)
 *   - 2+ hotels → render the picker
 *   - Not logged in → /login
 */
export default function ChoosePropertyPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const [hotels, setHotels] = useState<HotelSummary[] | null>(null);
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
        const list = await settingsService.listHotels();
        if (cancelled) return;

        if (list.length === 0) {
          router.replace("/setup");
          return;
        }
        if (list.length === 1) {
          const hotel = list[0];
          localStorage.setItem("selectedSharedPropertyId", hotel.propertyId ?? hotel.id);
          const decision = await resolveBookingSetupGuard("/dashboard");
          if (cancelled) return;
          if (decision.action === "redirect_to_setup") {
            localStorage.removeItem("selectedHotelId");
            window.location.replace(decision.redirectPath);
          } else {
            localStorage.setItem("selectedHotelId", hotel.id);
            router.replace("/dashboard");
          }
          return;
        }
        setHotels(list);
      } catch {
        if (!cancelled) {
          setError(t("auth.chooseProperty.loadError"));
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [router, t]);

  const selectHotel = async (hotel: HotelSummary) => {
    localStorage.setItem("selectedSharedPropertyId", hotel.propertyId ?? hotel.id);
    try {
      const decision = await resolveBookingSetupGuard("/dashboard");
      if (decision.action === "redirect_to_setup") {
        localStorage.removeItem("selectedHotelId");
        window.location.replace(decision.redirectPath);
        return;
      }
      localStorage.setItem("selectedHotelId", hotel.id);
      router.replace("/dashboard");
    } catch {
      setError(t("auth.chooseProperty.loadError"));
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
            <span className="text-white font-bold text-[16px]">B</span>
          </div>
          <h1 className="text-xl font-bold text-gray-900">
            {userName
              ? `${t("auth.chooseProperty.welcomeBack")}, ${userName}`
              : t("auth.chooseProperty.welcome")}
          </h1>
          <p className="text-[13px] text-gray-500 mt-1">{t("auth.chooseProperty.subtitle")}</p>
        </div>

        <div className="space-y-2">
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
              try {
                localStorage.removeItem("selectedHotelId");
              } catch {}
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
            {t("admin.addHotel")}
          </button>
        </div>
      </div>
    </div>
  );
}
