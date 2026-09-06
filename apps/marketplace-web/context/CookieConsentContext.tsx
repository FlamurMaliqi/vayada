"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from "react";
import { consentService } from "@/services/api/consent";

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

const VISITOR_ID_KEY = "vayada_visitor_id";
const CONSENT_KEY = "vayada_cookie_consent";
const RETRY_MS = 15_000;

function storedConsent(consent: CookieConsent, pending: boolean): string {
  // One write keeps the choice and its acknowledgement status together.
  return JSON.stringify({ ...consent, pending });
}

// Generate a unique visitor ID
function generateVisitorId(): string {
  return "v_" + Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Get or create visitor ID
function getVisitorId(): string {
  if (typeof window === "undefined") return "";

  let visitorId = localStorage.getItem(VISITOR_ID_KEY);
  if (!visitorId) {
    visitorId = generateVisitorId();
    localStorage.setItem(VISITOR_ID_KEY, visitorId);
  }
  return visitorId;
}

const CookieConsentContext = createContext<CookieConsentContextType | undefined>(undefined);

export function CookieConsentProvider({ children }: { children: ReactNode }) {
  const [consent, setConsent] = useState<CookieConsent | null>(null);
  const [hasConsented, setHasConsented] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showBanner, setShowBanner] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const localChoice = useRef<CookieConsent | null>(null);
  const pending = useRef<CookieConsent | null>(null);
  const saving = useRef(false);
  const mounted = useRef(false);

  const syncPending = useCallback(async () => {
    if (saving.current || !mounted.current) return;
    saving.current = true;
    try {
      // Serialize writes; a new choice waits behind the current request.
      while (pending.current && mounted.current) {
        const choice = pending.current;
        try {
          const saved = await consentService.saveCookieConsent({
            visitor_id: getVisitorId(),
            ...choice,
          });
          if (JSON.stringify(readConsent(saved)) !== JSON.stringify(choice)) {
            throw new Error("Cookie consent save was not acknowledged");
          }
          if (!mounted.current) return;
          if (pending.current === choice) {
            if (localStorage.getItem(CONSENT_KEY) === storedConsent(choice, true)) {
              localStorage.setItem(CONSENT_KEY, storedConsent(choice, false));
            }
            pending.current = null;
          }
        } catch {
          // Keep the durable pending choice for online/timer/reload recovery.
          if (pending.current === choice) return;
        }
      }
    } finally {
      saving.current = false;
    }
  }, []);

  // Load consent from localStorage on mount
  useEffect(() => {
    let active = true;
    mounted.current = true;
    const loadConsent = async () => {
      try {
        const raw = localStorage.getItem(CONSENT_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        const stored = readConsent(parsed);
        if (stored) {
          localChoice.current = stored;
          setConsent(stored);
          setHasConsented(true);
          setShowBanner(false);
          // Old records have no acknowledgement field: sync them once too.
          if (parsed.pending !== false) {
            pending.current = stored;
            localStorage.setItem(CONSENT_KEY, storedConsent(stored, true));
            void syncPending();
          }
          return;
        }
        setShowBanner(true);
        // Invalid local data requires a fresh choice, never old server acceptance.
        if (raw) return;
        const visitorId = getVisitorId();
        if (visitorId) {
          const backend = readConsent(await consentService.getCookieConsent(visitorId));
          if (active && backend && !localChoice.current && !localStorage.getItem(CONSENT_KEY)) {
            localStorage.setItem(CONSENT_KEY, storedConsent(backend, false));
            localChoice.current = backend;
            setConsent(backend);
            setHasConsented(true);
            setShowBanner(false);
          }
        }
      } catch (error) {
        console.error("Error loading cookie consent:", error);
        if (active && !localChoice.current) setShowBanner(true);
      }
    };

    void loadConsent();
    // A remote read must never hold the first-visit controls hostage.
    setIsLoading(false);
    const retry = () => {
      void syncPending();
    };
    const timer = window.setInterval(retry, RETRY_MS);
    window.addEventListener("online", retry);
    return () => {
      active = false;
      mounted.current = false;
      window.clearInterval(timer);
      window.removeEventListener("online", retry);
    };
  }, [syncPending]);

  // Save consent to localStorage and backend
  const saveConsent = useCallback(
    async (newConsent: CookieConsent) => {
      // Always ensure necessary is true
      const finalConsent = { ...newConsent, necessary: true };

      // Save to localStorage
      localStorage.setItem(CONSENT_KEY, storedConsent(finalConsent, true));
      localChoice.current = finalConsent;
      pending.current = finalConsent;
      setConsent(finalConsent);
      setHasConsented(true);
      setShowBanner(false);
      setShowSettings(false);

      void syncPending();
    },
    [syncPending],
  );

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
