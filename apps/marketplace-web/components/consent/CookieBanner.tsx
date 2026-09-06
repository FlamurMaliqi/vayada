"use client";
import { CookieBanner as SharedCookieBanner } from "@vayada/marketplace-shared/consent/CookieBanner";
import { useCookieConsent } from "@/context/CookieConsentContext";
export function CookieBanner() {
  return (
    <SharedCookieBanner controls={useCookieConsent()} privacyHref="https://vayada.com/privacy" />
  );
}
export default CookieBanner;
