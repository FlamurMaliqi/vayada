import { CURRENCY_OPTIONS, LANGUAGE_OPTIONS } from "@vayada/locale-constants";

export type PropertyLaunchSettings = {
  defaultCurrency: string;
  supportedCurrencies: string[];
  defaultLanguage: string;
  supportedLanguages: string[];
  instagram: string;
  facebook: string;
  tiktok: string;
  youtube: string;
};

export type PropertyLaunchSettingsApi = {
  get(propertyId: string, options?: RequestInit): Promise<PropertyLaunchSettings>;
  update(propertyId: string, settings: PropertyLaunchSettings): Promise<void>;
};

const COUNTRY_DEFAULTS: Record<
  string,
  Pick<PropertyLaunchSettings, "defaultCurrency" | "defaultLanguage" | "supportedLanguages">
> = {
  ID: { defaultCurrency: "IDR", defaultLanguage: "en", supportedLanguages: ["id"] },
  LK: { defaultCurrency: "LKR", defaultLanguage: "en", supportedLanguages: [] },
  MX: { defaultCurrency: "MXN", defaultLanguage: "es", supportedLanguages: ["en"] },
  DE: { defaultCurrency: "EUR", defaultLanguage: "de", supportedLanguages: ["en"] },
  PH: { defaultCurrency: "PHP", defaultLanguage: "en", supportedLanguages: [] },
};

export const ONBOARDING_POPULAR_CURRENCY_CODES = [
  "AUD",
  "CAD",
  "CHF",
  "EUR",
  "GBP",
  "JPY",
  "SGD",
  "THB",
] as const;

export function propertyLaunchSettingsDefaults(countryCode: string): PropertyLaunchSettings {
  const defaults = COUNTRY_DEFAULTS[countryCode.trim().toUpperCase()] ?? {
    defaultCurrency: "USD",
    defaultLanguage: "en",
    supportedLanguages: [],
  };
  return {
    ...defaults,
    supportedCurrencies: [],
    instagram: "",
    facebook: "",
    tiktok: "",
    youtube: "",
  };
}

export function validatePropertyLaunchSettings(
  settings: PropertyLaunchSettings,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  if (!CURRENCY_OPTIONS.some(({ code }) => code === settings.defaultCurrency)) {
    errors.defaultCurrency = ["Select a default currency."];
  }
  if (!LANGUAGE_OPTIONS.some(({ code }) => code === settings.defaultLanguage)) {
    errors.defaultLanguage = ["Select a default language."];
  }
  for (const field of ["instagram", "facebook", "tiktok", "youtube"] as const) {
    if (settings[field] && !isHttpUrl(settings[field])) {
      errors[field] = ["Enter a complete URL, including https://."];
    }
  }
  return errors;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
