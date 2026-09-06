import { bookingWebPublic } from "./client";
import { getBookingWebSessionId } from "./session";

export function trackEvent(
  hotelSlug: string,
  eventType: string,
  metadata?: Record<string, unknown>,
) {
  if (typeof window === "undefined" || !hotelSlug) return;
  // Analytics must never interrupt checkout when storage is disabled or full.
  try {
    const sessionId = getBookingWebSessionId(hotelSlug);
    if (!sessionId) return;
    const key = `vayada_funnel_sequence:${sessionId}`;
    const sequence = Number(sessionStorage.getItem(key) || 0) + 1;
    sessionStorage.setItem(key, String(sequence));
    void fetch(`${bookingWebPublic.baseURL}/api/booking-web/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        analyticsConsent: true,
        consentVersion: 1,
        hotelSlug,
        eventType,
        sessionId,
        eventId: crypto.randomUUID(),
        metadata: { ...metadata, funnelVersion: 1, funnelSequence: sequence },
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
