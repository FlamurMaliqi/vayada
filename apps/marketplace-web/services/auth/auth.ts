/**
 * Authentication service
 */

import { ApiErrorResponse } from "../api/client";
import type { LoginRequest } from "@/lib/types";
import {
  clearAuthData,
  currentUserType,
  getAuthCsrfToken,
  getAuthSessionUser,
  hasAuthenticatedSession,
  isAuthOrganizationSelectionResponse,
  setAuthKitSession,
  setPendingOrganizationSelection,
  type AuthSessionResponse,
} from "./sessionStore";
import { isSafeRelativeReturnTo } from "@vayada/product-onboarding/returnTo";

const AUTH_SURFACE = "marketplace-web";
const AUTH_BROWSER_BASE_PATH = "/auth";

type SignupRequest = {
  email: string;
  password: string;
};

type OnboardingAccountType = "creator" | "hotel";

export type AuthStateResponse = {
  state:
    | "invalid_credentials"
    | "email_verification_required"
    | "organization_selection_required"
    | "mfa_required"
    | "sso_required"
    | "auth_failed";
  message: string;
  pendingAuthenticationToken?: string;
  email?: string;
  emailVerificationId?: string;
};

export class AuthStateError extends Error {
  status: number;
  state: AuthStateResponse["state"];
  pendingAuthenticationToken?: string;
  email?: string;
  emailVerificationId?: string;

  constructor(status: number, response: AuthStateResponse) {
    super(response.message);
    this.name = "AuthStateError";
    this.status = status;
    this.state = response.state;
    this.pendingAuthenticationToken = response.pendingAuthenticationToken;
    this.email = response.email;
    this.emailVerificationId = response.emailVerificationId;
  }
}

export type PendingEmailVerification = {
  pendingAuthenticationToken: string;
  email?: string;
  emailVerificationId?: string;
  flow?: "login" | "signup";
};

const PENDING_EMAIL_VERIFICATION_KEY = "vayada_pending_email_verification";

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
    if (isAuthStateResponse(body)) {
      throw new AuthStateError(response.status, body);
    }
    throw new ApiErrorResponse(response.status, {
      detail: body?.message ?? body?.error ?? "Authentication request failed",
    });
  }

  return body as T;
}

function isAuthStateResponse(value: unknown): value is AuthStateResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { state?: unknown }).state === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

export function storePendingEmailVerification(
  input: Omit<PendingEmailVerification, "pendingAuthenticationToken"> & {
    pendingAuthenticationToken?: string;
  },
): boolean {
  if (typeof window === "undefined" || !input.pendingAuthenticationToken) return false;
  const pending: PendingEmailVerification = {
    pendingAuthenticationToken: input.pendingAuthenticationToken,
    email: input.email,
    emailVerificationId: input.emailVerificationId,
    flow: input.flow,
  };
  try {
    window.sessionStorage.setItem(PENDING_EMAIL_VERIFICATION_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function getPendingEmailVerification(): PendingEmailVerification | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_EMAIL_VERIFICATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingEmailVerification>;
    if (typeof parsed.pendingAuthenticationToken !== "string") return null;
    return {
      pendingAuthenticationToken: parsed.pendingAuthenticationToken,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      emailVerificationId:
        typeof parsed.emailVerificationId === "string" ? parsed.emailVerificationId : undefined,
      flow: parsed.flow === "signup" ? "signup" : "login",
    };
  } catch {
    return null;
  }
}

export function clearPendingEmailVerification(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PENDING_EMAIL_VERIFICATION_KEY);
  } catch {
    return;
  }
}

export const authService = {
  startGoogleLogin: (returnTo?: string): void => {
    if (typeof window === "undefined") return;

    const callbackUrl = new URL("/login", window.location.origin);
    callbackUrl.searchParams.set("auth", "callback");
    if (isSafeRelativeReturnTo(returnTo)) {
      callbackUrl.searchParams.set("returnTo", returnTo);
    }
    const errorUrl = new URL("/login", window.location.origin);
    const url = new URL(`${AUTH_BROWSER_BASE_PATH}/oauth/google/start`, window.location.origin);
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
    const url = new URL(`${AUTH_BROWSER_BASE_PATH}/oauth/google/start`, window.location.origin);
    url.searchParams.set("surface", AUTH_SURFACE);
    url.searchParams.set("flow", "signup");
    url.searchParams.set("return_to", callbackUrl.toString());
    url.searchParams.set("error_return_to", errorUrl.toString());
    window.location.href = url.toString();
  },

  refreshSession: async (
    organizationId?: string,
    signal?: AbortSignal,
  ): Promise<AuthSessionResponse> => {
    const csrfToken = getAuthCsrfToken();
    const response = csrfToken
      ? await authFetch<AuthSessionResponse>("/session/refresh", {
          method: "POST",
          headers: { "x-vayada-csrf": csrfToken },
          body: JSON.stringify({
            ...(organizationId ? { organizationId } : {}),
            surface: AUTH_SURFACE,
          }),
          signal,
        })
      : await authFetch<AuthSessionResponse>(
          `/session?${new URLSearchParams({
            surface: AUTH_SURFACE,
          }).toString()}`,
          { signal },
        );

    if (isAuthOrganizationSelectionResponse(response)) {
      setPendingOrganizationSelection(response);
      return response;
    }
    setAuthKitSession(response);
    return response;
  },

  ensureSession: async (signal?: AbortSignal): Promise<boolean> => {
    if (hasAuthenticatedSession()) return true;
    try {
      const response = await authService.refreshSession(undefined, signal);
      if (isAuthOrganizationSelectionResponse(response)) return false;
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!hasAuthenticatedSession()) clearAuthData();
      return false;
    }
  },

  /**
   * Login user
   */
  login: async (data: LoginRequest): Promise<AuthSessionResponse> => {
    try {
      const response = await authFetch<AuthSessionResponse>("/password/login", {
        method: "POST",
        body: JSON.stringify({
          ...data,
          surface: AUTH_SURFACE,
        }),
      });

      if (isAuthOrganizationSelectionResponse(response)) {
        setPendingOrganizationSelection(response);
        return response;
      }
      setAuthKitSession(response);
      return response;
    } catch (error) {
      if (error instanceof ApiErrorResponse || error instanceof AuthStateError) {
        throw error;
      }
      throw new Error("Login failed: Network error");
    }
  },

  signup: async (data: SignupRequest): Promise<AuthSessionResponse> => {
    try {
      const response = await authFetch<AuthSessionResponse>("/password/signup", {
        method: "POST",
        body: JSON.stringify({
          ...data,
          surface: AUTH_SURFACE,
        }),
      });

      if (isAuthOrganizationSelectionResponse(response)) {
        setPendingOrganizationSelection(response);
        return response;
      }
      setAuthKitSession(response);
      return response;
    } catch (error) {
      if (error instanceof ApiErrorResponse || error instanceof AuthStateError) {
        throw error;
      }
      throw new Error("Signup failed: Network error");
    }
  },

  updateAccountDetails: async (data: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    profilePictureUrl?: string;
    profilePictureMediaObjectId?: string;
  }): Promise<void> => {
    const csrfToken = getAuthCsrfToken();
    if (!csrfToken) throw new Error("Your session has expired. Please sign in again.");
    await authFetch<{ updated: true }>("/profile", {
      method: "POST",
      headers: { "x-vayada-csrf": csrfToken },
      body: JSON.stringify({ ...data, surface: AUTH_SURFACE }),
    });
    await authService.refreshSession();
  },

  /**
   * Logout user
   */
  logout: async (): Promise<void> => {
    const csrfToken = getAuthCsrfToken();
    let logoutUrl = "/login";

    if (csrfToken) {
      try {
        const response = await authFetch<{ logoutUrl: string }>("/logout", {
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

  getUserType: () => currentUserType(),

  getSessionUser: () => getAuthSessionUser(),

  /**
   * Request password reset
   * Sends a password reset email to the user
   * Always succeeds (for security - don't reveal if email exists)
   */
  forgotPassword: async (email: string): Promise<{ message: string }> => {
    try {
      return await authFetch<{ message: string }>("/password/reset/request", {
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

      const response = await authFetch<{ message: string }>("/password/reset/confirm", {
        method: "POST",
        body: JSON.stringify({
          token,
          newPassword,
        }),
      });

      return response;
    } catch (error: unknown) {
      if (error instanceof AuthStateError || error instanceof ApiErrorResponse) {
        throw new Error(error.message);
      }
      if (error instanceof Error) {
        throw new Error(error.message || "Failed to reset password. Please try again.");
      }
      throw new Error("Failed to reset password. Please try again.");
    }
  },

  confirmEmailVerification: async (code: string): Promise<AuthSessionResponse> => {
    const pending = getPendingEmailVerification();
    if (!pending) {
      throw new Error("Verification has expired. Please sign in again.");
    }

    try {
      const response = await authFetch<AuthSessionResponse>("/email-verification/confirm", {
        method: "POST",
        body: JSON.stringify({
          pendingAuthenticationToken: pending.pendingAuthenticationToken,
          code,
          flow: pending.flow,
          surface: AUTH_SURFACE,
        }),
      });

      if (isAuthOrganizationSelectionResponse(response)) {
        setPendingOrganizationSelection(response);
        return response;
      }
      setAuthKitSession(response);
      clearPendingEmailVerification();
      return response;
    } catch (error) {
      if (error instanceof AuthStateError || error instanceof ApiErrorResponse) {
        throw error;
      }
      throw new Error("Failed to verify email. Please try again.");
    }
  },

  resendEmailVerification: async (): Promise<{ message: string }> => {
    const pending = getPendingEmailVerification();
    if (!pending?.emailVerificationId) {
      throw new Error("Please sign in again to request a new verification code.");
    }

    try {
      return await authFetch<{ message: string }>("/email-verification/resend", {
        method: "POST",
        body: JSON.stringify({
          emailVerificationId: pending.emailVerificationId,
        }),
      });
    } catch (error) {
      if (error instanceof AuthStateError || error instanceof ApiErrorResponse) {
        throw error;
      }
      throw new Error("Failed to resend verification code. Please try again.");
    }
  },

  completeOnboarding: async (
    type: OnboardingAccountType,
    options: { inviteCode?: string } = {},
  ): Promise<AuthSessionResponse> => {
    const csrfToken = getAuthCsrfToken();
    if (!csrfToken) {
      throw new Error("Your session has expired. Please sign in again.");
    }
    const response = await authFetch<AuthSessionResponse>("/onboarding", {
      method: "POST",
      headers: { "x-vayada-csrf": csrfToken },
      body: JSON.stringify({
        type,
        surface: AUTH_SURFACE,
        ...(options.inviteCode ? { inviteCode: options.inviteCode } : {}),
      }),
    });
    if (isAuthOrganizationSelectionResponse(response)) {
      setPendingOrganizationSelection(response);
      return response;
    }
    setAuthKitSession(response);
    return response;
  },
};
