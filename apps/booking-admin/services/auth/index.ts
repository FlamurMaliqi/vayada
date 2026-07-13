/**
 * Authentication service for booking engine admin
 */

import { apiClient, ApiErrorResponse, isNextApiTarget } from "../api/client";
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
  setPendingOrganizationSelection,
  type AuthSessionResponse,
} from "./sessionStore";
import { ensureBookingCompatibilityToken } from "./compatibilityToken";
import { isSafeRelativeReturnTo } from "@vayada/product-onboarding/returnTo";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const AUTH_SURFACE = "booking-admin";

export interface LoginRequest {
  email: string;
  password: string;
}

export interface SignupRequest {
  name?: string;
  email: string;
  password: string;
}

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

async function storeAuthSessionResponse(
  response: AuthSessionResponse,
): Promise<AuthSessionResponse> {
  if (isAuthOrganizationSelectionResponse(response)) {
    setPendingOrganizationSelection(response);
    return response;
  }
  setAuthKitSession(response);
  if (!isNextApiTarget() && isCompatibilityTokenEnabled()) {
    try {
      await ensureBookingCompatibilityToken();
    } catch {
      /* Legacy admin routes will surface their normal auth error if the bridge is unavailable. */
    }
  }
  return response;
}

export const authService = {
  isAuthKitEnabled: isAuthKitLoginEnabled,

  startGoogleLogin: (returnTo?: string): void => {
    if (typeof window === "undefined") return;

    const callbackUrl = new URL("/login", window.location.origin);
    callbackUrl.searchParams.set("auth", "callback");
    if (isSafeRelativeReturnTo(returnTo)) {
      callbackUrl.searchParams.set("returnTo", returnTo);
    }
    const errorUrl = new URL("/login", window.location.origin);
    const url = new URL(`${AUTH_API_BASE_URL}/auth/oauth/google/start`);
    url.searchParams.set("surface", AUTH_SURFACE);
    url.searchParams.set("flow", "login");
    url.searchParams.set("return_to", callbackUrl.toString());
    url.searchParams.set("error_return_to", errorUrl.toString());
    window.location.href = url.toString();
  },

  startGoogleSignup: (returnTo: string): void => {
    if (typeof window === "undefined") return;

    const callbackUrl = new URL("/login", window.location.origin);
    callbackUrl.searchParams.set("auth", "callback");
    if (isSafeRelativeReturnTo(returnTo)) {
      callbackUrl.searchParams.set("returnTo", returnTo);
    }
    const errorUrl = new URL("/signup", window.location.origin);
    const url = new URL(`${AUTH_API_BASE_URL}/auth/oauth/google/start`);
    url.searchParams.set("surface", AUTH_SURFACE);
    url.searchParams.set("flow", "signup");
    url.searchParams.set("type", "hotel");
    url.searchParams.set("return_to", callbackUrl.toString());
    url.searchParams.set("error_return_to", errorUrl.toString());
    window.location.href = url.toString();
  },

  ensureBookingCompatibilityToken: async (): Promise<void> => {
    if (!isCompatibilityTokenEnabled()) return;
    await ensureBookingCompatibilityToken();
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

  /**
   * Logout user
   */
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
      localStorage.removeItem("setupComplete");
      window.location.href = logoutUrl;
    }
  },

  /**
   * Check if user is logged in (has valid token)
   */
  isLoggedIn: (): boolean => {
    return hasAuthenticatedSession();
  },

  /**
   * Check if current user is hotel admin
   */
  isHotelAdmin: (): boolean => {
    return hasHotelAccessMarker();
  },

  /**
   * Check if current user is super admin
   */
  isSuperAdmin: (): boolean => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("isSuperAdmin") === "true";
  },

  /**
   * Get token if available and not expired
   */
  getToken: (): string | null => {
    return getAuthBearerToken();
  },

  /**
   * Request a password reset link
   */
  forgotPassword: async (email: string): Promise<{ message: string }> => {
    try {
      return await authFetch<{ message: string }>("/auth/password/reset/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    } catch {
      return {
        message: "If an account with that email exists, a password reset link has been sent.",
      };
    }
  },

  /**
   * Reset password using a reset token
   */
  resetPassword: async (token: string, newPassword: string): Promise<{ message: string }> => {
    const response = await authFetch<{ message: string }>("/auth/password/reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token, newPassword }),
    });
    return response;
  },

  totpStatus: async (): Promise<{ enrolled: boolean }> => {
    return apiClient.get<{ enrolled: boolean }>("/auth/totp/status");
  },

  totpSetup: async (): Promise<{ otpauth_uri: string; secret: string; message: string }> => {
    return apiClient.post<{ otpauth_uri: string; secret: string; message: string }>(
      "/auth/totp/setup",
      {},
    );
  },

  totpConfirm: async (code: string): Promise<{ recovery_codes: string[]; message: string }> => {
    return apiClient.post<{ recovery_codes: string[]; message: string }>("/auth/totp/confirm", {
      code,
    });
  },

  totpRegenerateCodes: async (
    code: string,
  ): Promise<{ recovery_codes: string[]; message: string }> => {
    return apiClient.post<{ recovery_codes: string[]; message: string }>(
      "/auth/totp/recovery-codes/regenerate",
      { code },
    );
  },

  totpCodeCount: async (): Promise<{ count: number }> => {
    return apiClient.get<{ count: number }>("/auth/totp/recovery-codes/count");
  },

  loginHistory: async (): Promise<{
    entries: Array<{
      id: string;
      success: boolean;
      auth_method: string | null;
      failure_reason: string | null;
      ip_address: string | null;
      user_agent: string | null;
      created_at: string;
    }>;
  }> => {
    return apiClient.get("/auth/login-history");
  },
};
