import {
  clearAuthData,
  getAuthBearerToken,
  getAuthCsrfToken,
  getUserName,
  hasAuthenticatedSession,
  isLoggedInHint,
  setAuthKitSession,
  type AuthKitSessionResponse,
} from "./storage";

const AFFILIATE_SURFACE = "affiliate-dashboard";
const AUTH_BROWSER_BASE_PATH = "/auth";

async function authFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${AUTH_BROWSER_BASE_PATH}${endpoint}`, {
    ...options,
    credentials: "include",
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.headers as Record<string, string> | undefined),
    },
  });

  const contentType = response.headers.get("content-type");
  const body =
    contentType?.includes("application/json") && response.status !== 204
      ? await response.json()
      : null;

  if (!response.ok) {
    throw new Error(body?.message ?? body?.error ?? "Authentication request failed");
  }

  return body as T;
}

export const authService = {
  login: async (email: string, password: string): Promise<AuthKitSessionResponse> => {
    const response = await authFetch<AuthKitSessionResponse>("/password/login", {
      method: "POST",
      body: JSON.stringify({ email, password, surface: AFFILIATE_SURFACE }),
    });
    setAuthKitSession(response);
    return response;
  },

  refreshSession: async (organizationId?: string): Promise<AuthKitSessionResponse> => {
    const csrfToken = getAuthCsrfToken();
    const response =
      organizationId && csrfToken
        ? await authFetch<AuthKitSessionResponse>("/session/refresh", {
            method: "POST",
            headers: { "x-vayada-csrf": csrfToken },
            body: JSON.stringify({ organizationId, surface: AFFILIATE_SURFACE }),
          })
        : await authFetch<AuthKitSessionResponse>(
            `/session?surface=${encodeURIComponent(AFFILIATE_SURFACE)}`,
          );

    setAuthKitSession(response);
    return response;
  },

  ensureSession: async (): Promise<boolean> => {
    if (hasAuthenticatedSession()) {
      return true;
    }
    try {
      await authService.refreshSession();
      return Boolean(getAuthBearerToken());
    } catch {
      clearAuthData();
      return false;
    }
  },

  logout: async (): Promise<void> => {
    const csrfToken = getAuthCsrfToken();
    let logoutUrl = "/login";

    if (csrfToken) {
      try {
        const response = await authFetch<{ logoutUrl: string }>("/logout", {
          method: "POST",
          headers: { "x-vayada-csrf": csrfToken },
          body: JSON.stringify({ surface: AFFILIATE_SURFACE }),
        });
        logoutUrl = response.logoutUrl;
      } catch {
        logoutUrl = "/login";
      }
    }

    clearAuthData();

    if (typeof window !== "undefined") {
      window.location.href = logoutUrl;
    }
  },

  isLoggedIn: isLoggedInHint,

  isAffiliate: (): boolean => isLoggedInHint(),

  getUserName,

  getUserInitials: (): string => {
    const name = getUserName();
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
  },
};
