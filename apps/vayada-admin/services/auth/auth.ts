/**
 * Authentication service for admin.
 */

import { apiClient, ApiErrorResponse } from "../api/client";
import type { LoginRequest, LoginResponse } from "@/lib/types";
import {
  clearAuthData,
  getAuthBearerToken,
  getAuthCsrfToken,
  getLegacyPasswordToken,
  hasAuthenticatedSession,
  hasPlatformAccessMarker,
  isAuthKitLoginEnabled,
  isCompatibilityTokenEnabled,
  setAuthKitSession,
  setLegacyCompatibilityToken,
  type AuthKitSessionResponse,
} from "./sessionStore";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const PLATFORM_AUTH_SURFACE = "platform-admin";

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

async function attachMarketplaceCompatibilityToken(): Promise<void> {
  const csrfToken = getAuthCsrfToken();
  if (!csrfToken) return;

  try {
    const response = await authFetch<CompatibilityTokenResponse>(
      "/auth/compat/marketplace-admin-token",
      {
        method: "POST",
        headers: { "x-vayada-csrf": csrfToken },
      },
    );
    setLegacyCompatibilityToken(response.accessToken, response.expiresIn);
  } catch (error) {
    if (error instanceof ApiErrorResponse && error.status === 404) {
      return;
    }
    throw error;
  }
}

export const authService = {
  isAuthKitEnabled: isAuthKitLoginEnabled,

  /**
   * Refresh the AuthKit browser session and in-memory access token. Passing a
   * WorkOS organization ID switches organization through the apps/api session
   * refresh route.
   */
  refreshSession: async (
    organizationId?: string,
    signal?: AbortSignal,
  ): Promise<AuthKitSessionResponse> => {
    const csrfToken = getAuthCsrfToken();
    const response =
      organizationId && csrfToken
        ? await authFetch<AuthKitSessionResponse>("/auth/session/refresh", {
            method: "POST",
            signal,
            headers: { "x-vayada-csrf": csrfToken },
            body: JSON.stringify({ organizationId }),
          })
        : await authFetch<AuthKitSessionResponse>("/auth/session", { signal });

    setAuthKitSession(response);
    if (isCompatibilityTokenEnabled()) {
      await attachMarketplaceCompatibilityToken();
    }
    return response;
  },

  ensureSession: async (): Promise<boolean> => {
    if (!isAuthKitLoginEnabled()) {
      return Boolean(getLegacyPasswordToken() && hasPlatformAccessMarker());
    }
    if (hasAuthenticatedSession() && hasPlatformAccessMarker()) {
      return true;
    }
    try {
      await authService.refreshSession();
      return true;
    } catch {
      clearAuthData();
      return false;
    }
  },

  login: async (data: LoginRequest): Promise<LoginResponse> => {
    const response = await authFetch<AuthKitSessionResponse>("/auth/password/login", {
      method: "POST",
      body: JSON.stringify({ ...data, surface: PLATFORM_AUTH_SURFACE }),
    });
    setAuthKitSession(response);
    if (isCompatibilityTokenEnabled()) {
      await attachMarketplaceCompatibilityToken();
    }
    return {
      id: response.user.id,
      email: response.user.email,
      name: response.user.email,
      type: "admin",
      status: response.user.status,
      access_token: response.accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      message: "Login successful",
      is_superadmin: true,
    };
  },

  /**
   * Logout user.
   */
  logout: async (): Promise<void> => {
    const csrfToken = getAuthCsrfToken();
    let logoutUrl = "/login";

    if (isAuthKitLoginEnabled() && csrfToken) {
      try {
        const response = await authFetch<{ logoutUrl: string }>("/auth/logout", {
          method: "POST",
          headers: { "x-vayada-csrf": csrfToken },
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

  getCurrentUser: async () => {
    try {
      if (isAuthKitLoginEnabled()) {
        return await authService.refreshSession();
      }
      return await apiClient.get<LoginResponse>("/auth/me");
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error;
      }
      throw new Error("Failed to get current user");
    }
  },

  isLoggedIn: (): boolean => {
    return hasAuthenticatedSession();
  },

  isAdmin: (): boolean => {
    return hasPlatformAccessMarker();
  },

  getToken: (): string | null => {
    return getAuthBearerToken();
  },

  forgotPassword: async (email: string): Promise<{ message: string }> => {
    try {
      const response = await apiClient.post<{ message: string }>("/auth/forgot-password", {
        email,
      });
      return { message: response.message };
    } catch {
      return {
        message: "If an account with that email exists, a password reset link has been sent.",
      };
    }
  },

  resetPassword: async (token: string, newPassword: string): Promise<{ message: string }> => {
    const response = await apiClient.post<{ message: string }>("/auth/reset-password", {
      token,
      new_password: newPassword,
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
