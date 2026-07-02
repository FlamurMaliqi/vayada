/**
 * Authentication service for PMS frontend
 * Uses the same booking engine auth backend (port 8001)
 */

import { apiClient, ApiErrorResponse } from "../api/client";
import {
  clearAuthData,
  getAuthBearerToken,
  getAuthCsrfToken,
  getLegacyPasswordToken,
  hasAuthenticatedSession,
  hasHotelAccessMarker,
  isAuthOrganizationSelectionResponse,
  isAuthKitLoginEnabled,
  isCompatibilityTokenEnabled,
  isLegacyPasswordFallbackEnabled,
  setAuthKitSession,
  setLegacyCompatibilityToken,
  setLegacyPasswordSession,
  setPendingOrganizationSelection,
  type AuthSessionResponse,
} from "./sessionStore";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const AUTH_SURFACE = "pms-web";

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  id: string;
  email: string;
  name: string;
  type: string;
  status: string;
  access_token: string;
  token_type: string;
  expires_in: number;
  message: string;
}

type CompatibilityTokenResponse = {
  accessToken: string;
  expiresIn: number;
  tokenType: "Bearer";
};

async function authFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${AUTH_API_BASE_URL}${endpoint}`, {
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
    throw new ApiErrorResponse(response.status, {
      detail: body?.message ?? body?.error ?? "Authentication request failed",
    });
  }

  return body as T;
}

async function attachPmsCompatibilityToken(): Promise<void> {
  const csrfToken = getAuthCsrfToken();
  if (!csrfToken) return;

  const response = await authFetch<CompatibilityTokenResponse>("/auth/compat/pms-web-token", {
    method: "POST",
    headers: { "x-vayada-csrf": csrfToken },
  });
  setLegacyCompatibilityToken(response.accessToken, response.expiresIn);
}

export const authService = {
  isAuthKitEnabled: isAuthKitLoginEnabled,

  isLegacyFallbackEnabled: isLegacyPasswordFallbackEnabled,

  startHostedLogin: (loginHint?: string, returnTo?: string): void => {
    const url = new URL(`${AUTH_API_BASE_URL}/auth/workos/login`);
    url.searchParams.set("surface", AUTH_SURFACE);
    if (typeof window !== "undefined") {
      const callbackUrl = new URL("/login?auth=callback", window.location.origin);
      if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
        callbackUrl.searchParams.set("returnTo", returnTo);
      }
      url.searchParams.set("return_to", callbackUrl.toString());
    }
    if (loginHint) url.searchParams.set("login_hint", loginHint);
    window.location.href = url.toString();
  },

  refreshSession: async (organizationId?: string): Promise<AuthSessionResponse> => {
    const csrfToken = getAuthCsrfToken();
    const response =
      organizationId && csrfToken
        ? await authFetch<AuthSessionResponse>("/auth/session/refresh", {
            method: "POST",
            headers: { "x-vayada-csrf": csrfToken },
            body: JSON.stringify({ organizationId, surface: AUTH_SURFACE }),
          })
        : await authFetch<AuthSessionResponse>(`/auth/session?surface=${AUTH_SURFACE}`);

    if (isAuthOrganizationSelectionResponse(response)) {
      setPendingOrganizationSelection(response);
      return response;
    }
    setAuthKitSession(response);
    if (isCompatibilityTokenEnabled()) {
      try {
        await attachPmsCompatibilityToken();
      } catch {
        /* First-run PMS setup can complete before a legacy PMS property link exists. */
      }
    }
    return response;
  },

  ensureSession: async (): Promise<boolean> => {
    if (!isAuthKitLoginEnabled()) {
      return Boolean(getLegacyPasswordToken() && hasHotelAccessMarker());
    }
    if (hasAuthenticatedSession() && hasHotelAccessMarker()) {
      return true;
    }
    try {
      const response = await authService.refreshSession();
      if (isAuthOrganizationSelectionResponse(response)) return false;
      return true;
    } catch {
      clearAuthData();
      return false;
    }
  },

  login: async (data: LoginRequest): Promise<LoginResponse> => {
    const response = await apiClient.post<LoginResponse>("/auth/login", data);

    if (response.type !== "hotel") {
      throw new Error("Access denied. Hotel admin account required.");
    }

    setLegacyPasswordSession({
      token: response.access_token,
      expiresIn: response.expires_in,
      user: {
        id: response.id,
        email: response.email,
        name: response.name,
        type: response.type,
        status: response.status,
      },
    });

    return response;
  },

  logout: async (): Promise<void> => {
    const csrfToken = getAuthCsrfToken();
    let logoutUrl = "/login";

    if (isAuthKitLoginEnabled() && csrfToken) {
      try {
        const response = await authFetch<{ logoutUrl: string }>("/auth/logout", {
          method: "POST",
          headers: { "x-vayada-csrf": csrfToken },
          body: JSON.stringify({ surface: AUTH_SURFACE }),
        });
        logoutUrl = response.logoutUrl;
      } catch {
        logoutUrl = "/login";
      }
    }

    clearAuthData();
    if (typeof window !== "undefined") {
      localStorage.removeItem("pmsSetupComplete");
      window.location.href = logoutUrl;
    }
  },

  isLoggedIn: (): boolean => {
    return hasAuthenticatedSession();
  },

  isHotelAdmin: (): boolean => {
    return hasHotelAccessMarker();
  },

  getToken: (): string | null => {
    return getAuthBearerToken();
  },
};
