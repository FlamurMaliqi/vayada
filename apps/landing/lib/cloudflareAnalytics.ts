import { readConsent } from "@vayada/marketplace-shared/consent/preferences";

const consentKey = "vayada_cookie_consent";
// Public site identifier, not a credential. Configured only for the Landing build.
const token = process.env.NEXT_PUBLIC_CLOUDFLARE_ANALYTICS_TOKEN;
const source = "https://static.cloudflareinsights.com/beacon.min.js";
// Reviewed 2026-09-06: this beacon uses XHR and sendBeacon only. Vendor changes fail closed.
const integrity = "sha384-rZU/V+RlKzHYA4/iZCw3bxslsQ5p/NEWjmbcnlJgM+uAQl7yofrR6Wa/+l+S8x0M";
let script: HTMLScriptElement | undefined;
let revoked = false;

const withdrawalCookie = "vayada_analytics_withdrawn";
export function analyticsWasWithdrawn(): boolean {
  return document.cookie.split(";").some((part) => part.trim() === `${withdrawalCookie}=1`);
}
export function rememberAnalyticsWithdrawal(withdrawn: boolean): void {
  // Necessary preference fallback when localStorage mutations fail. Host-only.
  document.cookie = `${withdrawalCookie}=${withdrawn ? "1" : ""}; Path=/; Max-Age=${withdrawn ? 31536000 : 0}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}
function accepted(): boolean {
  try {
    if (analyticsWasWithdrawn()) return false;
    return readConsent(JSON.parse(localStorage.getItem(consentKey) ?? "null"))?.analytics === true;
  } catch {
    return false;
  }
}
function isRum(url: string | URL): boolean {
  const parsed = new URL(String(url), location.href);
  return (
    parsed.pathname.startsWith("/cdn-cgi/rum") &&
    (parsed.hostname === "cloudflareinsights.com" || parsed.origin === location.origin)
  );
}
function permitted(): boolean {
  if (!accepted()) stopCloudflareAnalytics();
  return !revoked;
}

export function stopCloudflareAnalytics(): void {
  if (!script) return;
  // Keep guards installed until this document ends: removing a script does not unload listeners.
  revoked = true;
  script.remove();
}

export function syncCloudflareAnalytics(): void {
  if (!accepted()) {
    stopCloudflareAnalytics();
    return;
  }
  if (script || !token || !/^[a-f0-9]{32}$/i.test(token)) return;
  const beacon = navigator.sendBeacon;
  if (typeof beacon !== "function") return; // Unsupported transport surface: stay off.
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const destinations = new WeakMap<XMLHttpRequest, string | URL>();
  try {
    navigator.sendBeacon = function (url, data) {
      if (isRum(url) && !permitted()) return false;
      return beacon.call(this, url, data);
    };
    XMLHttpRequest.prototype.open = function (
      method: string,
      url: string | URL,
      async: boolean = true,
      username?: string | null,
      password?: string | null,
    ) {
      destinations.set(this, url);
      return open.call(this, method, url, async, username, password);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const url = destinations.get(this);
      if (url && isRum(url) && !permitted()) {
        this.abort();
        return;
      }
      return send.call(this, body);
    };
  } catch {
    // Some browsers lock transport methods. Do not load a beacon we cannot stop.
    return;
  }
  script = document.createElement("script");
  script.src = source;
  script.integrity = integrity;
  script.crossOrigin = "anonymous";
  script.dataset.cfBeacon = JSON.stringify({ token, spa: true });
  document.head.appendChild(script);
}
