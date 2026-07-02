export type ReturnToParam = string | string[] | null | undefined;

const SAME_ORIGIN_RETURN_TO_BASE = "https://vayada.local";

type HeaderGetter = {
  get(name: string): string | null;
};

export type HostedSignupSurface = "booking-admin" | "marketplace-web" | "pms-web";
export type HostedSignupIntent = "hotel" | "creator";

export type HostedSignupRedirectInput = {
  authApiBaseUrl: string;
  headers: HeaderGetter;
  surface: HostedSignupSurface;
  intent: HostedSignupIntent;
  fallbackOrigin: string;
  returnTo: string;
  returnToFallback?: string;
  loginHint?: string;
};

export function firstSearchParam(value: ReturnToParam): string | undefined {
  return Array.isArray(value) ? value[0] : (value ?? undefined);
}

export function safeRelativeReturnTo(value: ReturnToParam, fallback: string): string {
  const raw = firstSearchParam(value);
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return fallback;
  }
  try {
    return new URL(raw, SAME_ORIGIN_RETURN_TO_BASE).origin === SAME_ORIGIN_RETURN_TO_BASE
      ? raw
      : fallback;
  } catch {
    return fallback;
  }
}

export function buildHostedSignupRedirectUrl(input: HostedSignupRedirectInput): string {
  const origin = requestOrigin(input.headers, input.fallbackOrigin);

  const url = new URL("/auth/workos/signup", input.authApiBaseUrl);
  url.searchParams.set("surface", input.surface);
  url.searchParams.set("intent", input.intent);

  const callbackUrl = new URL("/login?auth=callback", origin);
  callbackUrl.searchParams.set(
    "returnTo",
    safeRelativeReturnTo(input.returnTo, input.returnToFallback ?? "/"),
  );
  url.searchParams.set("return_to", callbackUrl.toString());

  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

function requestOrigin(headers: HeaderGetter, fallbackOrigin: string): string {
  const host =
    firstForwardedValue(headers.get("x-forwarded-host")) ??
    firstForwardedValue(headers.get("host"));
  const proto = (firstForwardedValue(headers.get("x-forwarded-proto")) ?? "https").toLowerCase();
  if (!host || (proto !== "http" && proto !== "https")) return fallbackOrigin;
  try {
    const origin = new URL(`${proto}://${host}`);
    if (
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.username ||
      origin.password
    ) {
      return fallbackOrigin;
    }
    return origin.origin;
  } catch {
    return fallbackOrigin;
  }
}

function firstForwardedValue(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}
