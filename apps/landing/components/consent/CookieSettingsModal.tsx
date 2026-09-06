"use client";
import { CookieSettingsModal as SharedCookieSettingsModal } from "@vayada/marketplace-shared/consent/CookieSettingsModal";
import { useCookieConsent } from "@/context/CookieConsentContext";
export function CookieSettingsModal() {
  return <SharedCookieSettingsModal controls={useCookieConsent()} privacyHref="/privacy" />;
}
export default CookieSettingsModal;
