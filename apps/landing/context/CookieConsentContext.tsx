"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";

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

  // Landing consent is local to this browser. Account-level privacy settings
  // live in the authenticated application.
  useEffect(() => {
    const loadConsent = () => {
      try {
        const storedConsent = localStorage.getItem(CONSENT_KEY);
        if (storedConsent) {
          const parsed = readConsent(JSON.parse(storedConsent));
          if (!parsed) {
            setShowBanner(true);
            return;
          }
          setConsent(parsed);
          setHasConsented(true);
          setShowBanner(false);
          return;
        }
        setShowBanner(true);
      } catch (error) {
        console.error("Error loading cookie consent:", error);
        setShowBanner(true);
      } finally {
        setIsLoading(false);
      }
    };

    loadConsent();
  }, []);

  // Save consent locally so the public site never depends on an account API.
  const saveConsent = useCallback(async (newConsent: CookieConsent) => {
    // Always ensure necessary is true
    const finalConsent = { ...newConsent, necessary: true };

    // Save to localStorage
    localStorage.setItem(CONSENT_KEY, JSON.stringify(finalConsent));
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
