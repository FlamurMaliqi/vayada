"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";

import {
  analyticsWasWithdrawn,
  rememberAnalyticsWithdrawal,
  stopCloudflareAnalytics,
  syncCloudflareAnalytics,
} from "@/lib/cloudflareAnalytics";

import { CookieConsent, readConsent } from "@vayada/marketplace-shared/consent/preferences";
export type { CookieConsent } from "@vayada/marketplace-shared/consent/preferences";

// Context value type
interface CookieConsentContextType {
  consent: CookieConsent | null;
  hasConsented: boolean;
  isLoading: boolean;
  showBanner: boolean;
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  acceptAll: () => Promise<void>;
  acceptNecessaryOnly: () => Promise<void>;
  updateConsent: (consent: Partial<CookieConsent>) => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
}

const CONSENT_KEY = "vayada_cookie_consent";

const CookieConsentContext = createContext<CookieConsentContextType | undefined>(undefined);

export function CookieConsentProvider({ children }: { children: ReactNode }) {
  const [consent, setConsent] = useState<CookieConsent | null>(null);
  const [hasConsented, setHasConsented] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showBanner, setShowBanner] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [storageError, setStorageError] = useState(false);

  // Landing consent is local to this browser. Account-level privacy settings
  // live in the authenticated application.
  useEffect(() => {
    const loadConsent = () => {
      let parsed: CookieConsent | null = null;
      try {
        parsed = readConsent(JSON.parse(localStorage.getItem(CONSENT_KEY) ?? "null"));
        if (parsed && analyticsWasWithdrawn()) parsed = { ...parsed, analytics: false };
      } catch {}
      setConsent(parsed);
      setHasConsented(Boolean(parsed));
      setShowBanner(!parsed);
      setIsLoading(false);
      syncCloudflareAnalytics();
    };
    loadConsent();
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) return;
      if (event.key !== CONSENT_KEY && event.key !== null) return;
      // Observe each withdrawal even if another tab has already accepted again.
      let next: CookieConsent | null = null;
      try {
        next = readConsent(JSON.parse(event.newValue ?? "null"));
      } catch {}
      if (!next?.analytics) stopCloudflareAnalytics();
      loadConsent();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Save consent locally so the public site never depends on an account API.
  const saveConsent = useCallback(async (newConsent: CookieConsent) => {
    // Always ensure necessary is true
    const finalConsent = { ...newConsent, necessary: true };

    if (!finalConsent.analytics) {
      stopCloudflareAnalytics();
      rememberAnalyticsWithdrawal(true);
    }
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify(finalConsent));
      if (finalConsent.analytics) rememberAnalyticsWithdrawal(false);
      setStorageError(false);
    } catch {
      stopCloudflareAnalytics();
      rememberAnalyticsWithdrawal(true);
      try {
        localStorage.removeItem(CONSENT_KEY);
      } catch {}
      setStorageError(true);
      return;
    }
    syncCloudflareAnalytics();
    setConsent(finalConsent);
    setHasConsented(true);
    setShowBanner(false);
    setShowSettings(false);
  }, []);

  const acceptAll = useCallback(async () => {
    await saveConsent({
      necessary: true,
      functional: true,
      analytics: true,
      marketing: true,
    });
  }, [saveConsent]);

  const acceptNecessaryOnly = useCallback(async () => {
    await saveConsent({
      necessary: true,
      functional: false,
      analytics: false,
      marketing: false,
    });
  }, [saveConsent]);

  const updateConsent = useCallback(
    async (partialConsent: Partial<CookieConsent>) => {
      const currentConsent = consent || {
        necessary: true,
        functional: false,
        analytics: false,
        marketing: false,
      };
      await saveConsent({
        ...currentConsent,
        ...partialConsent,
        necessary: true, // Always true
      });
    },
    [consent, saveConsent],
  );

  const openSettings = useCallback(() => {
    setShowSettings(true);
  }, []);

  const closeSettings = useCallback(() => {
    setShowSettings(false);
  }, []);

  return (
    <CookieConsentContext.Provider
      value={{
        consent,
        hasConsented,
        isLoading,
        showBanner,
        showSettings,
        setShowSettings,
        acceptAll,
        acceptNecessaryOnly,
        updateConsent,
        openSettings,
        closeSettings,
      }}
    >
      {children}
      {storageError && (
        <p
          role="alert"
          className="fixed top-3 left-3 right-3 z-[60] rounded border bg-white p-3 text-sm text-red-700"
        >
          We couldn’t save your cookie choice. Analytics is off. Please try again.
        </p>
      )}
    </CookieConsentContext.Provider>
  );
}

export function useCookieConsent() {
  const context = useContext(CookieConsentContext);
  if (context === undefined) {
    throw new Error("useCookieConsent must be used within a CookieConsentProvider");
  }
  return context;
}
