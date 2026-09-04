"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { DEFAULT_LOCALE, SUPPORTED_LANGUAGES } from "./languages";
import defaultEnMessages from "../../messages/en.json";

type Messages = Record<string, string>;

interface I18nContextValue {
  locale: string;
  setLocale: (locale: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const STORAGE_KEY = "admin_language";

// Cache loaded messages to avoid re-fetching
const messageCache: Record<string, Messages> = {
  en: defaultEnMessages as Messages,
};

const supportedLocales = new Set(SUPPORTED_LANGUAGES.map(({ code }) => code));

function withEnglishFallback(messages: Messages): Messages {
  return { ...(defaultEnMessages as Messages), ...messages };
}

function translate(
  messages: Messages,
  key: string,
  params?: Record<string, string | number>,
): string {
  let value = messages[key] || (defaultEnMessages as Messages)[key] || key;
  if (params) {
    Object.entries(params).forEach(([param, replacement]) => {
      value = value.split(`{${param}}`).join(String(replacement));
    });
  }
  return value;
}

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => undefined,
  t: (key, params) => translate(defaultEnMessages as Messages, key, params),
});

async function loadMessages(locale: string): Promise<Messages> {
  if (messageCache[locale]) return messageCache[locale];
  try {
    const messages = withEnglishFallback((await import(`../../messages/${locale}.json`)).default);
    messageCache[locale] = messages;
    return messages;
  } catch {
    // Fallback to English if locale file not found
    if (locale !== DEFAULT_LOCALE) {
      return loadMessages(DEFAULT_LOCALE);
    }
    return messageCache[DEFAULT_LOCALE] ?? {};
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState(DEFAULT_LOCALE);
  const [messages, setMessages] = useState<Messages>(defaultEnMessages as Messages);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && supportedLocales.has(stored) && stored !== DEFAULT_LOCALE) {
      setLocaleState(stored);
      document.documentElement.lang = stored;
      loadMessages(stored).then(setMessages);
    } else {
      document.documentElement.lang = DEFAULT_LOCALE;
    }
  }, []);

  const setLocale = useCallback((newLocale: string) => {
    if (!supportedLocales.has(newLocale)) return;
    setLocaleState(newLocale);
    localStorage.setItem(STORAGE_KEY, newLocale);
    document.documentElement.lang = newLocale;
    loadMessages(newLocale).then(setMessages);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string =>
      translate(messages, key, params),
    [messages],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useTranslation() {
  return useContext(I18nContext);
}
