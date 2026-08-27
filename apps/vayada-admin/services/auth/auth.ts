/**
 * Authentication service for admin.
 */

import { apiClient, ApiErrorResponse } from "../api/client";
import type { LoginRequest, LoginResponse } from "@/lib/types";
import {
  clearAuthData,
  getAuthBearerToken,
  getAuthCsrfToken,
  getAuthStateGeneration,
  getLegacyPasswordToken,
  hasAuthenticatedSession,
  hasPlatformAccessMarker,
  isAuthKitLoginEnabled,
  isCompatibilityTokenEnabled,
  setAuthKitSession,
  setLegacyCompatibilityToken,
  type AuthKitSessionResponse,
} from "./sessionStore";

const PLATFORM_AUTH_SURFACE = "platform-admin";
const AUTH_BROWSER_BASE_PATH = "/auth";

type CompatibilityTokenResponse = {
  accessToken: string;
  expiresIn: number;
  tokenType: "Bearer";
};

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
    throw new ApiErrorResponse(response.status, {
      detail: body?.message ?? body?.error ?? "Authentication request failed",
    });
  }

  return body as T;
}

async function attachMarketplaceCompatibilityToken(
  csrfToken = getAuthCsrfToken(),
  expectedGeneration?: number,
): Promise<void> {
  if (!csrfToken) return;

  try {
    const response = await authFetch<CompatibilityTokenResponse>(
      "/compat/marketplace-admin-token",
      {
        method: "POST",
        headers: { "x-vayada-csrf": csrfToken },
      },
    );
    setLegacyCompatibilityToken(response.accessToken, response.expiresIn, expectedGeneration);
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
    expectedGeneration = getAuthStateGeneration(),
  ): Promise<AuthKitSessionResponse | null> => {
    const csrfToken = getAuthCsrfToken();
    const response =
      organizationId && csrfToken
        ? await authFetch<AuthKitSessionResponse>("/session/refresh", {
            method: "POST",
            signal,
            headers: { "x-vayada-csrf": csrfToken },
            body: JSON.stringify({ organizationId, surface: PLATFORM_AUTH_SURFACE }),
          })
        : await authFetch<AuthKitSessionResponse>(`/session?surface=${PLATFORM_AUTH_SURFACE}`, {
            signal,
          });

    const committedGeneration = setAuthKitSession(response, expectedGeneration);
    if (committedGeneration === null) return null;
    if (isCompatibilityTokenEnabled()) {
      await attachMarketplaceCompatibilityToken(response.csrfToken, committedGeneration);
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
    const expectedGeneration = getAuthStateGeneration();
    try {
      await authService.refreshSession(undefined, undefined, expectedGeneration);
    } catch {
      clearAuthData(expectedGeneration);
    }
    return hasAuthenticatedSession() && hasPlatformAccessMarker();
  },

  login: async (data: LoginRequest): Promise<LoginResponse> => {
    const organizationId = process.env.NEXT_PUBLIC_PLATFORM_WORKOS_ORG_ID?.trim();
    const response = await authFetch<AuthKitSessionResponse>("/password/login", {
      method: "POST",
      body: JSON.stringify({
        ...data,
        surface: PLATFORM_AUTH_SURFACE,
        ...(organizationId ? { organizationId } : {}),
      }),
    });
    const committedGeneration = setAuthKitSession(response);
    if (committedGeneration !== null && isCompatibilityTokenEnabled()) {
      await attachMarketplaceCompatibilityToken(response.csrfToken, committedGeneration);
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
        const response = await authFetch<{ logoutUrl: string }>("/logout", {
          method: "POST",
          headers: { "x-vayada-csrf": csrfToken },
          body: JSON.stringify({ surface: PLATFORM_AUTH_SURFACE }),
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
      const response = await authFetch<{ message: string }>("/password/reset/request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      return { message: response.message };
    } catch {
      return {
        message: "If an account with that email exists, a password reset link has been sent.",
      };
    }
  },

  resetPassword: async (token: string, newPassword: string): Promise<{ message: string }> => {
    const response = await authFetch<{ message: string }>("/password/reset/confirm", {
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
