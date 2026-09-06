"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { DEFAULT_LOCALE, SUPPORTED_LANGUAGES } from "./languages";
import defaultEnMessages from "../../messages/en.json";

type Messages = Record<string, string>;

interface I18nContextValue {
  locale: string;
  setLocale: (locale: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = "admin_language";

// Cache loaded messages to avoid re-fetching
const messageCache: Record<string, Messages> = {
  en: defaultEnMessages as Messages,
};

async function loadMessages(locale: string): Promise<Messages | undefined> {
  if (messageCache[locale]) return messageCache[locale];
  try {
    const messages = (await import(`../../messages/${locale}.json`)).default;
    messageCache[locale] = messages;
    return messages;
  } catch {
    return undefined;
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(DEFAULT_LOCALE);
  const [messages, setMessages] = useState<Messages>(defaultEnMessages as Messages);
  const requestVersion = useRef(0);

  const applyLocale = useCallback(async (nextLocale: string) => {
    const version = ++requestVersion.current;
    const nextMessages = await loadMessages(nextLocale);
    if (version !== requestVersion.current || !nextMessages) return;
    localStorage.setItem(STORAGE_KEY, nextLocale);
    setLocaleState(nextLocale);
    setMessages(nextMessages);
    document.documentElement.lang = nextLocale;
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LANGUAGES.some(({ code }) => code === stored)) {
      void applyLocale(stored);
    } else document.documentElement.lang = DEFAULT_LOCALE;
    return () => {
      requestVersion.current += 1;
    };
  }, [applyLocale]);

  const setLocale = useCallback(
    (newLocale: string) => {
      if (!SUPPORTED_LANGUAGES.some(({ code }) => code === newLocale)) return;
      void applyLocale(newLocale);
    },
    [applyLocale],
  );

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      let value = messages[key] || key;
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          value = value.split(`{${k}}`).join(String(v));
        });
      }
      return value;
    },
    [messages],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useTranslation must be used within a LanguageProvider");
  }
  return context;
}
