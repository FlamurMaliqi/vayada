import { setApiBearerTokenProvider } from "@vayada/marketplace-shared/api/client";

export type AuthUser = {
  id: string;
  email: string;
  status: string;
  workosUserId?: string;
};

export type AuthKitSessionResponse = {
  accessToken: string;
  csrfToken?: string;
  organizationId?: string;
  user: AuthUser;
};

const LEGACY_TOKEN_KEY = "access_token";
const LEGACY_EXPIRES_AT_KEY = "token_expires_at";

let authKitSession: AuthKitSessionResponse | null = null;
let legacyCompatibilityToken: { token: string; expiresAt: number } | null = null;

setApiBearerTokenProvider(() => getAuthBearerToken());

export function isAuthKitLoginEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED !== "false";
}

export function isCompatibilityTokenEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED === "true";
}

export function setAuthKitSession(session: AuthKitSessionResponse): void {
  authKitSession = session;
  if (typeof window === "undefined") return;
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", session.user.id);
  localStorage.setItem("userEmail", session.user.email);
  localStorage.setItem("userStatus", session.user.status);
  localStorage.setItem("isSuperAdmin", "true");
  localStorage.setItem(
    "user",
    JSON.stringify({
      id: session.user.id,
      email: session.user.email,
      status: session.user.status,
      is_superadmin: true,
      workos_user_id: session.user.workosUserId,
    }),
  );
}

export function setLegacyCompatibilityToken(token: string, expiresIn: number): void {
  legacyCompatibilityToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function setLegacyPasswordSession(input: {
  token: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    name: string;
    type: string;
    status: string;
    is_superadmin?: boolean;
  };
}): void {
  if (typeof window === "undefined") return;

  localStorage.setItem(LEGACY_TOKEN_KEY, input.token);
  localStorage.setItem(LEGACY_EXPIRES_AT_KEY, String(Date.now() + input.expiresIn * 1000));
  localStorage.setItem("isLoggedIn", "true");
  localStorage.setItem("userId", input.user.id);
  localStorage.setItem("userEmail", input.user.email);
  localStorage.setItem("userName", input.user.name);
  localStorage.setItem("userType", input.user.type);
  localStorage.setItem("userStatus", input.user.status);
  localStorage.setItem("isSuperAdmin", input.user.is_superadmin ? "true" : "false");
  localStorage.setItem("user", JSON.stringify(input.user));
}

export function clearAuthData(): void {
  authKitSession = null;
  legacyCompatibilityToken = null;
  if (typeof window === "undefined") return;

  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_EXPIRES_AT_KEY);
  localStorage.removeItem("userId");
  localStorage.removeItem("userEmail");
  localStorage.removeItem("userName");
  localStorage.removeItem("userType");
  localStorage.removeItem("userStatus");
  localStorage.removeItem("isSuperAdmin");
  localStorage.removeItem("user");
  localStorage.setItem("isLoggedIn", "false");
}

export function getAuthKitAccessToken(): string | null {
  return authKitSession?.accessToken ?? null;
}

export function getAuthCsrfToken(): string | null {
  return authKitSession?.csrfToken ?? null;
}

export function getAuthBearerToken(): string | null {
  const compatibilityToken = getLegacyCompatibilityToken();
  if (isCompatibilityTokenEnabled() && compatibilityToken) return compatibilityToken;
  if (authKitSession?.accessToken) return authKitSession.accessToken;
  return getLegacyPasswordToken();
}

function getLegacyCompatibilityToken(): string | null {
  if (legacyCompatibilityToken && Date.now() < legacyCompatibilityToken.expiresAt - 30_000) {
    return legacyCompatibilityToken.token;
  }
  return null;
}

export function getLegacyPasswordToken(): string | null {
  if (typeof window === "undefined") return null;

  const token = localStorage.getItem(LEGACY_TOKEN_KEY);
  const expiresAt = localStorage.getItem(LEGACY_EXPIRES_AT_KEY);

  if (!token || !expiresAt) return null;

  if (Date.now() >= Number(expiresAt)) {
    clearAuthData();
    return null;
  }

  return token;
}

export function hasAuthenticatedSession(): boolean {
  return Boolean(authKitSession?.accessToken || getLegacyPasswordToken());
}

export function hasPlatformAccessMarker(): boolean {
  if (authKitSession) return true;
  if (typeof window === "undefined") return false;
  return localStorage.getItem("isSuperAdmin") === "true";
}
