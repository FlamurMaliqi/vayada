export type ReturnToParam = string | string[] | null | undefined;

const SAME_ORIGIN_RETURN_TO_BASE = "https://vayada.local";

type HeaderGetter = {
  get(name: string): string | null;
};

export type HostedSignupRedirectInput = {
  authApiBaseUrl: string;
  headers: HeaderGetter;
  surface: string;
  intent: string;
  fallbackOrigin: string;
  returnTo: string;
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
  const host = input.headers.get("x-forwarded-host") ?? input.headers.get("host");
  const proto = input.headers.get("x-forwarded-proto") ?? "https";
  const origin = host ? `${proto}://${host}` : input.fallbackOrigin;

  const url = new URL("/auth/workos/signup", input.authApiBaseUrl);
  url.searchParams.set("surface", input.surface);
  url.searchParams.set("intent", input.intent);

  const callbackUrl = new URL("/login?auth=callback", origin);
  callbackUrl.searchParams.set("returnTo", input.returnTo);
  url.searchParams.set("return_to", callbackUrl.toString());

  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}
