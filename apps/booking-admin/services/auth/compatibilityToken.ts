import {
  getAuthCsrfToken,
  getLegacyCompatibilityToken,
  isCompatibilityTokenEnabled,
  setLegacyCompatibilityToken,
} from "./sessionStore";

const AUTH_COMPATIBILITY_TOKEN_PATH = "/auth/compat/booking-admin-token";

type CompatibilityTokenResponse = {
  accessToken: string;
  expiresIn: number;
};

export async function ensureBookingCompatibilityToken(): Promise<void> {
  if (!isCompatibilityTokenEnabled() || getLegacyCompatibilityToken()) return;

  const csrfToken = getAuthCsrfToken();
  if (!csrfToken) return;

  const response = await fetch(AUTH_COMPATIBILITY_TOKEN_PATH, {
    method: "POST",
    credentials: "include",
    headers: { "x-vayada-csrf": csrfToken },
  }).catch(() => null);
  if (!response?.ok) return;

  const body = (await response.json()) as CompatibilityTokenResponse;
  setLegacyCompatibilityToken(body.accessToken, body.expiresIn);
}
