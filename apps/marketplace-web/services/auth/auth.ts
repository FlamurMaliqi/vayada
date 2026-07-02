/**
 * Authentication service
 */

import { apiClient, ApiErrorResponse } from "../api/client";
import type { LoginRequest, LoginResponse } from "@/lib/types";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  clearAuthData,
  currentUserType,
  getAuthBearerToken,
  getAuthCsrfToken,
  hasAuthenticatedSession,
  isAuthOrganizationSelectionResponse,
  isAuthKitLoginEnabled,
  setAuthKitSession,
  setPendingOrganizationSelection,
  type AuthSessionResponse,
} from "./sessionStore";

const TOKEN_KEY = "access_token";
const EXPIRES_AT_KEY = "token_expires_at";
const AUTH_API_BASE_URL = process.env.NEXT_PUBLIC_AUTH_API_URL || "https://api.localhost";
const AUTH_SURFACE = "marketplace-web";

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

/**
 * Store JWT token and expiration time
 */
function storeToken(token: string, expiresIn: number): void {
  if (typeof window === "undefined") return;

  localStorage.setItem(TOKEN_KEY, token);
  const expiresAt = Date.now() + expiresIn * 1000;
  localStorage.setItem(EXPIRES_AT_KEY, expiresAt.toString());
}

/**
 * Store user data in localStorage
 */
function storeUserData(data: {
  id: string;
  email: string;
  name: string;
  type: string;
  status: string;
  is_superadmin?: boolean;
}): void {
  if (typeof window === "undefined") return;

  localStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "true");
  localStorage.setItem(STORAGE_KEYS.USER_ID, data.id);
  localStorage.setItem(STORAGE_KEYS.USER_EMAIL, data.email);
  localStorage.setItem(STORAGE_KEYS.USER_NAME, data.name);
  localStorage.setItem(STORAGE_KEYS.USER_TYPE, data.type);
  localStorage.setItem(STORAGE_KEYS.USER_STATUS, data.status);
  localStorage.setItem(STORAGE_KEYS.IS_SUPERADMIN, data.is_superadmin ? "true" : "false");

  // Store full user object for easy access
  localStorage.setItem(
    STORAGE_KEYS.USER,
    JSON.stringify({
      id: data.id,
      email: data.email,
      name: data.name,
      type: data.type,
      status: data.status,
      is_superadmin: data.is_superadmin || false,
    }),
  );
}

/**
 * Clear all auth data from localStorage
 */
function clearLegacyAuthData(): void {
  if (typeof window === "undefined") return;

  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem(STORAGE_KEYS.USER_ID);
  localStorage.removeItem(STORAGE_KEYS.USER_EMAIL);
  localStorage.removeItem(STORAGE_KEYS.USER_NAME);
  localStorage.removeItem(STORAGE_KEYS.USER_TYPE);
  localStorage.removeItem(STORAGE_KEYS.USER_STATUS);
  localStorage.removeItem(STORAGE_KEYS.IS_SUPERADMIN);
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.setItem(STORAGE_KEYS.IS_LOGGED_IN, "false");
  localStorage.setItem(STORAGE_KEYS.PROFILE_COMPLETE, "false");
  localStorage.setItem(STORAGE_KEYS.HAS_PROFILE, "false");
}

/**
 * Get token if not expired
 */
function getToken(): string | null {
  if (typeof window === "undefined") return null;

  const token = localStorage.getItem(TOKEN_KEY);
  const expiresAt = localStorage.getItem(EXPIRES_AT_KEY);

  if (!token || !expiresAt) return null;

  if (Date.now() >= parseInt(expiresAt)) {
    clearLegacyAuthData();
    return null;
  }

  return token;
}

export const authService = {
  isAuthKitEnabled: isAuthKitLoginEnabled,

  startHostedLogin: (loginHint?: string, returnTo?: string): void => {
    if (typeof window === "undefined") return;

    const url = new URL(`${AUTH_API_BASE_URL}/auth/workos/login`);
    url.searchParams.set("surface", AUTH_SURFACE);
    const callbackUrl = new URL("/login?auth=callback", window.location.origin);
    if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
      callbackUrl.searchParams.set("returnTo", returnTo);
    }
    url.searchParams.set("return_to", callbackUrl.toString());
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
        : await authFetch<AuthSessionResponse>(
            `/auth/session?${new URLSearchParams({
              surface: AUTH_SURFACE,
            }).toString()}`,
          );

    if (isAuthOrganizationSelectionResponse(response)) {
      setPendingOrganizationSelection(response);
      return response;
    }
    setAuthKitSession(response);
    return response;
  },

  ensureSession: async (): Promise<boolean> => {
    if (hasAuthenticatedSession()) return true;
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
   * Login user
   */
  login: async (data: LoginRequest): Promise<LoginResponse> => {
    try {
      const response = await apiClient.post<LoginResponse>("/auth/login", data);

      // Store token and user data
      storeToken(response.access_token, response.expires_in);
      storeUserData({
        id: response.id,
        email: response.email,
        name: response.name,
        type: response.type,
        status: response.status,
      });

      return response;
    } catch (error) {
      if (error instanceof ApiErrorResponse) {
        throw error;
      }
      throw new Error("Login failed: Network error");
    }
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
          body: JSON.stringify({
            surface: AUTH_SURFACE,
            return_to:
              typeof window !== "undefined" ? `${window.location.origin}/login` : undefined,
          }),
        });
        logoutUrl = response.logoutUrl;
      } catch {
        logoutUrl = "/login";
      }
    }

    if (typeof window !== "undefined") {
      window.location.href = logoutUrl;
    }
    clearAuthData();
  },

  /**
   * Get current user
   */
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

  /**
   * Check if user is logged in (has valid token)
   */
  isLoggedIn: (): boolean => {
    return hasAuthenticatedSession() || getToken() !== null;
  },

  /**
   * Get token if available and not expired
   */
  getToken: (): string | null => {
    return getAuthBearerToken() ?? getToken();
  },

  getUserType: () => currentUserType(),

  /**
   * Request password reset
   * Sends a password reset email to the user
   * Always succeeds (for security - don't reveal if email exists)
   */
  forgotPassword: async (email: string): Promise<{ message: string }> => {
    try {
      const response = await apiClient.post<{ message: string; token: string | null }>(
        "/auth/forgot-password",
        { email },
      );
      return { message: response.message };
    } catch (error: unknown) {
      // For security, always show success message even if email doesn't exist
      // This prevents email enumeration attacks
      if (error instanceof ApiErrorResponse) {
        // Still return success message for security
        return {
          message: "If an account with that email exists, a password reset link has been sent.",
        };
      }
      // For network errors, still show success to maintain security
      return {
        message: "If an account with that email exists, a password reset link has been sent.",
      };
    }
  },

  /**
   * Reset password with token
   * Validates the reset token and updates the password
   */
  resetPassword: async (token: string, newPassword: string): Promise<{ message: string }> => {
    try {
      if (!token || token.trim() === "") {
        throw new Error("Invalid reset token. Please request a new password reset link.");
      }

      if (!newPassword || newPassword.length < 8) {
        throw new Error("Password must be at least 8 characters long.");
      }

      const response = await apiClient.post<{ message: string }>("/auth/reset-password", {
        token,
        new_password: newPassword,
      });

      return response;
    } catch (error: unknown) {
      if (error instanceof ApiErrorResponse) {
        // Handle backend validation errors
        if (error.status === 400 || error.status === 422) {
          const detail = error.data.detail;
          if (typeof detail === "string") {
            throw new Error(detail);
          }
          if (Array.isArray(detail) && detail.length > 0) {
            // Pydantic validation errors
            const firstError = detail[0];
            const field = Array.isArray(firstError.loc)
              ? firstError.loc.slice(1).join(".")
              : "field";
            throw new Error(`${field}: ${firstError.msg || "Validation error"}`);
          }
          throw new Error(
            "Invalid or expired reset token. Please request a new password reset link.",
          );
        }
        if (error.status === 404) {
          throw new Error(
            "Invalid or expired reset token. Please request a new password reset link.",
          );
        }
        // For other errors, use the detail message if available
        const detail = error.data.detail;
        if (typeof detail === "string") {
          throw new Error(detail);
        }
        throw new Error("Failed to reset password. Please try again.");
      }
      if (error instanceof Error) {
        throw new Error(error.message || "Failed to reset password. Please try again.");
      }
      throw new Error("Failed to reset password. Please try again.");
    }
  },

  /**
   * Send email verification code
   * Sends a verification code to the provided email address
   * Code expires in 15 minutes
   */
  sendVerificationCode: async (
    email: string,
  ): Promise<{ message: string; code: string | null }> => {
    try {
      const response = await apiClient.post<{ message: string; code: string | null }>(
        "/auth/send-verification-code",
        { email },
      );
      return response;
    } catch (error: unknown) {
      if (error instanceof ApiErrorResponse) {
        const detail = error.data.detail;
        if (typeof detail === "string") {
          throw new Error(detail);
        }
        throw new Error("Failed to send verification code. Please try again.");
      }
      throw new Error("Failed to send verification code. Please try again.");
    }
  },

  /**
   * Verify email verification code
   * Verifies the code sent to the email address
   * Code can only be used once
   * @deprecated Use verifyEmail with token instead (link-based verification)
   */
  verifyEmailCode: async (
    email: string,
    code: string,
  ): Promise<{ message: string; verified: boolean }> => {
    try {
      const response = await apiClient.post<{ message: string; verified: boolean }>(
        "/auth/verify-email-code",
        {
          email,
          code,
        },
      );
      return response;
    } catch (error: unknown) {
      if (error instanceof ApiErrorResponse) {
        const detail = error.data.detail;
        if (typeof detail === "string") {
          throw new Error(detail);
        }
        // Check if it's a verification error
        if (error.status === 400 || error.status === 422) {
          throw new Error("Invalid or expired verification code. Please request a new code.");
        }
        throw new Error("Failed to verify code. Please try again.");
      }
      throw new Error("Failed to verify code. Please try again.");
    }
  },

  /**
   * Verify email using token from verification link
   * Used after profile completion - user clicks link in email
   * Token expires after 48 hours
   */
  verifyEmail: async (
    token: string,
  ): Promise<{ message: string; verified: boolean; email: string | null }> => {
    try {
      if (!token || token.trim() === "") {
        throw new Error("Invalid verification token. Please request a new verification link.");
      }

      const response = await apiClient.get<{
        message: string;
        verified: boolean;
        email: string | null;
      }>(`/auth/verify-email?token=${encodeURIComponent(token)}`);
      return response;
    } catch (error: unknown) {
      if (error instanceof ApiErrorResponse) {
        const detail = error.data.detail;
        if (typeof detail === "string") {
          throw new Error(detail);
        }
        // Check if it's a verification error
        if (error.status === 400 || error.status === 404 || error.status === 422) {
          throw new Error(
            "Invalid or expired verification token. Please request a new verification link.",
          );
        }
        throw new Error("Failed to verify email. Please try again.");
      }
      throw new Error("Failed to verify email. Please try again.");
    }
  },
};
