import {
  setApiBearerTokenProvider,
  setVayadaApiBearerTokenProvider,
} from "@vayada/marketplace-shared/api/client";

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
let authKitAccessTokenExpiresAt: number | null = null;
let authKitRefreshPromise: Promise<string | null> | null = null;
let legacyCompatibilityToken: { token: string; expiresAt: number } | null = null;
// Refreshes may only commit to the login/logout state they started against.
let authStateGeneration = 0;

setApiBearerTokenProvider(() => getAuthBearerToken());
setVayadaApiBearerTokenProvider((signal, forceRefresh) =>
  getOrRefreshAuthKitAccessToken(signal, forceRefresh),
);

export function isAuthKitLoginEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED !== "false";
}

export function isCompatibilityTokenEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED === "true";
}

export function getAuthStateGeneration(): number {
  return authStateGeneration;
}

export function setAuthKitSession(
  session: AuthKitSessionResponse,
  expectedGeneration?: number,
): number | null {
  if (expectedGeneration !== undefined && expectedGeneration !== authStateGeneration) {
    return null;
  }
  if (expectedGeneration === undefined) {
    authStateGeneration += 1;
    authKitRefreshPromise = null;
  }
  const replacesIdentity =
    expectedGeneration === undefined ||
    authKitSession?.user.id !== session.user.id ||
    authKitSession?.organizationId !== session.organizationId;
  if (replacesIdentity) legacyCompatibilityToken = null;
  authKitSession = session;
  authKitAccessTokenExpiresAt = readJwtExpiresAt(session.accessToken);
  if (typeof window === "undefined") return authStateGeneration;
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
  return authStateGeneration;
}

export function setLegacyCompatibilityToken(
  token: string,
  expiresIn: number,
  expectedGeneration?: number,
): boolean {
  if (expectedGeneration !== undefined && expectedGeneration !== authStateGeneration) {
    return false;
  }
  legacyCompatibilityToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  return true;
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

export function clearAuthData(expectedGeneration?: number): boolean {
  if (expectedGeneration !== undefined && expectedGeneration !== authStateGeneration) {
    return false;
  }
  authStateGeneration += 1;
  authKitSession = null;
  authKitAccessTokenExpiresAt = null;
  authKitRefreshPromise = null;
  legacyCompatibilityToken = null;
  if (typeof window === "undefined") return true;

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
  return true;
}

export function getAuthKitAccessToken(): string | null {
  return authKitSession?.accessToken ?? null;
}

export async function getOrRefreshAuthKitAccessToken(
  signal?: AbortSignal,
  forceRefresh = false,
): Promise<string | null> {
  const accessToken = getAuthKitAccessToken();
  const expiresSoon =
    authKitAccessTokenExpiresAt !== null && Date.now() >= authKitAccessTokenExpiresAt - 30_000;
  if (accessToken && !forceRefresh && !expiresSoon) return accessToken;

  signal?.throwIfAborted();

  if (!authKitRefreshPromise) {
    const refreshGeneration = getAuthStateGeneration();
    const refreshPromise = (async () => {
      try {
        const { authService } = await import("./auth");
        await authService.refreshSession(undefined, undefined, refreshGeneration);
        return getAuthStateGeneration() === refreshGeneration ? getAuthKitAccessToken() : null;
      } catch {
        clearAuthData(refreshGeneration);
        return null;
      }
    })();
    authKitRefreshPromise = refreshPromise;
    const releaseRefreshPromise = () => {
      if (authKitRefreshPromise === refreshPromise) {
        authKitRefreshPromise = null;
      }
    };
    void refreshPromise.then(releaseRefreshPromise, releaseRefreshPromise);
  }

  return waitForRefresh(authKitRefreshPromise, signal);
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

function readJwtExpiresAt(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const normalized = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(normalized)) as { exp?: unknown };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

function waitForRefresh(
  refreshPromise: Promise<string | null>,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!signal) return refreshPromise;
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    void refreshPromise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", handleAbort);
    });
  });
}
