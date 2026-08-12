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
import { isSafeRelativeReturnTo } from "@vayada/product-onboarding/returnTo";

const AUTH_SURFACE = "pms-web";
const AUTH_BROWSER_BASE_PATH = "/auth";

export interface LoginRequest {
  email: string;
  password: string;
}

export interface SignupRequest {
  name?: string;
  email: string;
  password: string;
}

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
  intent?: "hotel";
};

type CompatibilityTokenResponse = {
  accessToken: string;
  expiresIn: number;
  tokenType: "Bearer";
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
    intent: input.intent,
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
      intent: parsed.intent === "hotel" ? "hotel" : undefined,
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

async function attachPmsCompatibilityToken(): Promise<void> {
  const csrfToken = getAuthCsrfToken();
  if (!csrfToken) return;

  const response = await authFetch<CompatibilityTokenResponse>("/compat/pms-web-token", {
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
    url.searchParams.set("type", "hotel");
    url.searchParams.set("return_to", callbackUrl.toString());
    url.searchParams.set("error_return_to", errorUrl.toString());
    window.location.href = url.toString();
  },

  refreshSession: async (organizationId?: string): Promise<AuthSessionResponse> => {
    const csrfToken = getAuthCsrfToken();
    const response = csrfToken
      ? await authFetch<AuthSessionResponse>("/session/refresh", {
          method: "POST",
          headers: { "x-vayada-csrf": csrfToken },
          body: JSON.stringify({
            ...(organizationId ? { organizationId } : {}),
            surface: AUTH_SURFACE,
          }),
        })
      : await authFetch<AuthSessionResponse>(`/session?surface=${AUTH_SURFACE}`);

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
    const response = await authFetch<AuthSessionResponse>("/password/login", {
      method: "POST",
      body: JSON.stringify({ ...data, surface: AUTH_SURFACE }),
    });
    return storeAuthSessionResponse(response);
  },

  signup: async (data: SignupRequest): Promise<AuthSessionResponse> => {
    const response = await authFetch<AuthSessionResponse>("/password/signup", {
      method: "POST",
      body: JSON.stringify({ ...data, surface: AUTH_SURFACE, type: "hotel" }),
    });
    return storeAuthSessionResponse(response);
  },

  updateAccountDetails: async (data: {
    firstName: string;
    lastName: string;
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

  confirmEmailVerification: async (code: string): Promise<AuthSessionResponse> => {
    const pending = getPendingEmailVerification();
    if (!pending) {
      throw new Error("Verification has expired. Please sign in again.");
    }

    const response = await authFetch<AuthSessionResponse>("/email-verification/confirm", {
      method: "POST",
      body: JSON.stringify({
        pendingAuthenticationToken: pending.pendingAuthenticationToken,
        code,
        flow: pending.flow,
        intent: pending.intent,
        surface: AUTH_SURFACE,
      }),
    });
    const stored = await storeAuthSessionResponse(response);
    if (!isAuthOrganizationSelectionResponse(response)) {
      clearPendingEmailVerification();
    }
    return stored;
  },

  resendEmailVerification: async (): Promise<{ message: string }> => {
    const pending = getPendingEmailVerification();
    if (!pending?.emailVerificationId) {
      throw new Error("Please sign in again to request a new verification code.");
    }

    return authFetch<{ message: string }>("/email-verification/resend", {
      method: "POST",
      body: JSON.stringify({
        emailVerificationId: pending.emailVerificationId,
      }),
    });
  },

  logout: async (): Promise<void> => {
    const csrfToken = getAuthCsrfToken();
    let logoutUrl = "/login";

    if (isAuthKitLoginEnabled() && csrfToken) {
      try {
        const response = await authFetch<{ logoutUrl: string }>("/logout", {
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

  resetPassword: async (token: string, newPassword: string): Promise<{ message: string }> => {
    try {
      if (!token.trim()) {
        throw new Error("Invalid reset token. Please request a new password reset link.");
      }
      if (newPassword.length < 8) {
        throw new Error("Password must be at least 8 characters long.");
      }
      return await authFetch<{ message: string }>("/password/reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token, newPassword }),
      });
    } catch (error) {
      if (error instanceof AuthStateError || error instanceof ApiErrorResponse) {
        throw new Error(error.message);
      }
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Failed to reset password. Please try again.");
    }
  },
};
