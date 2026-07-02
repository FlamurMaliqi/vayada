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
  isLegacyPasswordFallbackEnabled,
  setAuthKitSession,
  setLegacyPasswordSession,
  setPendingOrganizationSelection,
  type AuthSessionResponse,
} from "./sessionStore";
import { ensureBookingCompatibilityToken } from "./compatibilityToken";

const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const AUTH_SURFACE = "booking-admin";

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  id?: string;
  email?: string;
  name?: string;
  type?: string;
  status?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  message: string;
  is_superadmin?: boolean;
  requires_totp?: boolean;
  totp_session?: string;
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

  ensureBookingCompatibilityToken: async (): Promise<void> => {
    if (!isCompatibilityTokenEnabled()) return;
    await ensureBookingCompatibilityToken();
  },

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
    if (!isNextApiTarget() && isCompatibilityTokenEnabled()) {
      try {
        await ensureBookingCompatibilityToken();
      } catch {
        /* Legacy admin routes will surface their normal auth error if the bridge is unavailable. */
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

  /**
   * Login user (hotel admin or super admin). Returns early with requires_totp=true
   * if TOTP is needed. Caller must call verifyTotp() to complete the flow.
   */
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    const response = await apiClient.post<LoginResponse>("/auth/login", data);

    if (response.requires_totp) {
      return response;
    }

    // Verify user is hotel admin or super admin
    if (response.type !== "hotel" && !response.is_superadmin) {
      throw new Error("Access denied. Hotel admin account required.");
    }

    storeLegacyLoginResponse(response);

    return response;
  },

  /**
   * Complete TOTP login step after a successful password auth.
   */
  verifyTotp: async (totpSession: string, code: string): Promise<LoginResponse> => {
    const response = await apiClient.post<LoginResponse>("/auth/totp/verify", {
      totp_session: totpSession,
      code,
    });

    if (response.type !== "hotel" && !response.is_superadmin) {
      throw new Error("Access denied. Hotel admin account required.");
    }

    storeLegacyLoginResponse(response);

    return response;
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
  forgotPassword: async (email: string): Promise<{ message: string; token?: string }> => {
    const response = await apiClient.post<{ message: string; token?: string }>(
      "/auth/forgot-password",
      { email },
    );
    return response;
  },

  /**
   * Reset password using a reset token
   */
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
