import { analyticsChoice } from "./analyticsConsent";

export function getBookingWebSessionId(slug: string): string | undefined {
  if (analyticsChoice(slug) !== true) return undefined;
  let sid = sessionStorage.getItem(`vayada_sid:${slug}`);
  if (!sid) {
    sid = crypto.randomUUID();
    sessionStorage.setItem(`vayada_sid:${slug}`, sid);
  }
  return sid;
}
