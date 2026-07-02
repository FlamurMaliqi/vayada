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
  isLegacyPasswordFallbackEnabled,
  setAuthKitSession,
  setLegacyCompatibilityToken,
  setLegacyPasswordSession,
  type AuthKitSessionResponse,
} from "./sessionStore";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const PLATFORM_AUTH_SURFACE = "platform-admin";
const PLATFORM_WORKOS_ORG_ID = process.env.NEXT_PUBLIC_PLATFORM_WORKOS_ORG_ID;

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

function storeLegacyLoginResponse(response: LoginResponse): void {
  setLegacyPasswordSession({
    token: response.access_token!,
    expiresIn: response.expires_in!,
    user: {
      id: response.id!,
      email: response.email!,
      name: response.name!,
      type: response.type!,
      status: response.status!,
      is_superadmin: response.is_superadmin,
    },
  });
}

export const authService = {
  isAuthKitEnabled: isAuthKitLoginEnabled,

  isLegacyFallbackEnabled: isLegacyPasswordFallbackEnabled,

  startHostedLogin: (loginHint?: string): void => {
    const url = new URL(`${AUTH_API_BASE_URL}/auth/workos/login`);
    url.searchParams.set("surface", PLATFORM_AUTH_SURFACE);
    if (PLATFORM_WORKOS_ORG_ID) url.searchParams.set("organization_id", PLATFORM_WORKOS_ORG_ID);
    if (loginHint) url.searchParams.set("login_hint", loginHint);
    window.location.href = url.toString();
  },

  /**
   * Refresh the AuthKit browser session and in-memory access token. Passing a
   * WorkOS organization ID switches organization through the apps/api session
   * refresh route.
   */
  refreshSession: async (organizationId?: string): Promise<AuthKitSessionResponse> => {
    const csrfToken = getAuthCsrfToken();
    const response =
      organizationId && csrfToken
        ? await authFetch<AuthKitSessionResponse>("/auth/session/refresh", {
            method: "POST",
            headers: { "x-vayada-csrf": csrfToken },
            body: JSON.stringify({ organizationId }),
          })
        : await authFetch<AuthKitSessionResponse>("/auth/session");

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

  /**
   * Legacy password fallback. AuthKit is the primary login path while rollout
   * fallback remains enabled for unlinked users.
   */
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    try {
      const response = await apiClient.post<LoginResponse>("/auth/login", data);

      if (response.requires_totp) {
        return response;
      }

      if (!response.is_superadmin) {
        throw new Error("Access denied. Superadmin account required.");
      }

      storeLegacyLoginResponse(response);
      return response;
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error;
      }
      throw error;
    }
  },

  /**
   * Complete legacy TOTP login step after successful password auth.
   */
  verifyTotp: async (totpSession: string, code: string): Promise<LoginResponse> => {
    const response = await apiClient.post<LoginResponse>("/auth/totp/verify", {
      totp_session: totpSession,
      code,
    });

    if (!response.is_superadmin) {
      throw new Error("Access denied. Superadmin account required.");
    }

    storeLegacyLoginResponse(response);
    return response;
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
