/**
 * Authentication service for PMS frontend
 * Uses the same booking engine auth backend (port 8001)
 */

import { ApiErrorResponse } from "../api/client";
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
  setAuthKitSession,
  setLegacyCompatibilityToken,
  setPendingOrganizationSelection,
  type AuthSessionResponse,
} from "./sessionStore";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const AUTH_SURFACE = "pms-web";

export interface LoginRequest {
  email: string;
  password: string;
}

export interface SignupRequest {
  name: string;
  email: string;
  password: string;
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

async function storeAuthSessionResponse(
  response: AuthSessionResponse,
): Promise<AuthSessionResponse> {
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
}

export const authService = {
  isAuthKitEnabled: isAuthKitLoginEnabled,

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

    return storeAuthSessionResponse(response);
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

  login: async (data: LoginRequest): Promise<AuthSessionResponse> => {
    const response = await authFetch<AuthSessionResponse>("/auth/password/login", {
      method: "POST",
      body: JSON.stringify({ ...data, surface: AUTH_SURFACE }),
    });
    return storeAuthSessionResponse(response);
  },

  signup: async (data: SignupRequest): Promise<AuthSessionResponse> => {
    const response = await authFetch<AuthSessionResponse>("/auth/password/signup", {
      method: "POST",
      body: JSON.stringify({ ...data, surface: AUTH_SURFACE, type: "hotel" }),
    });
    return storeAuthSessionResponse(response);
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
