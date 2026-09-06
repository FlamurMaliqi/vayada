export interface CookieConsent {
  necessary: boolean;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
}

export const necessaryConsent: CookieConsent = {
  necessary: true,
  functional: false,
  analytics: false,
  marketing: false,
};

export function readConsent(value: unknown): CookieConsent | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.necessary !== true ||
    typeof record.functional !== "boolean" ||
    typeof record.analytics !== "boolean" ||
    typeof record.marketing !== "boolean"
  )
    return null;
  return {
    necessary: true,
    functional: record.functional,
    analytics: record.analytics,
    marketing: record.marketing,
  };
}
