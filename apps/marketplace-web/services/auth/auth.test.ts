import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthStateError,
  authService,
  clearPendingEmailVerification,
  getPendingEmailVerification,
  storePendingEmailVerification,
} from "./auth";
import {
  clearAuthData,
  getAuthBearerToken,
  getAuthCsrfToken,
  isAuthOrganizationSelectionResponse,
  setAuthKitSession,
  setLegacyCompatibilityToken,
} from "./sessionStore";
import { sharedHotelSetupApi } from "../api/sharedHotelSetupClient";

const fetchMock = vi.fn();

afterEach(() => {
  clearAuthData();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("marketplace AuthKit compatibility token", () => {
  it("prefers the marketplace compatibility token after session refresh", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href === "https://api.localhost/auth/session?surface=marketplace-web") {
          return jsonResponse({
            accessToken: "workos-access-token",
            csrfToken: "csrf-token",
            organizationKind: "creator_workspace",
            user: { id: "user_creator", email: "creator@example.com", status: "active" },
          });
        }
        if (href === "https://api.localhost/auth/compat/marketplace-web-token") {
          expect(init?.method).toBe("POST");
          expect((init?.headers as Record<string, string>)["x-vayada-csrf"]).toBe("csrf-token");
          return jsonResponse({ accessToken: "legacy-marketplace-token", expiresIn: 900 });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      }),
    );

    await authService.refreshSession();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getAuthBearerToken()).toBe("legacy-marketplace-token");
  });

  it("clears stale compatibility tokens when the AuthKit session changes", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    setAuthKitSession({
      accessToken: "old-workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("legacy-marketplace-token", 900);

    expect(getAuthBearerToken()).toBe("legacy-marketplace-token");

    setAuthKitSession({
      accessToken: "new-workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    expect(getAuthBearerToken()).toBe("new-workos-access-token");
  });

  it("uses the AuthKit token for shared hotel setup requests", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    setAuthKitSession({
      accessToken: "hotel-workos-access-token",
      csrfToken: "hotel-csrf-token",
      organizationKind: "hotel_group",
      user: { id: "user_hotel", email: "hotel@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("legacy-marketplace-token", 900);
    expect(getAuthBearerToken()).toBe("legacy-marketplace-token");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://api.localhost/api/hotel-setup/status?entryProduct=marketplace",
        );
        expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
          "Bearer hotel-workos-access-token",
        );
        return jsonResponse({ contractVersion: "shared-hotel-setup-status.v1" });
      }),
    );

    await sharedHotelSetupApi.getStatus({ entryProduct: "marketplace" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries session hydration after compatibility token loading is canceled", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    mockBrowserStorage();
    const controller = new AbortController();
    let compatibilityAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url) === "https://api.localhost/auth/session?surface=marketplace-web") {
          return jsonResponse({
            accessToken: "workos-access-token",
            csrfToken: "csrf-token",
            organizationKind: "creator_workspace",
            user: { id: "user_creator", email: "creator@example.com", status: "active" },
          });
        }
        compatibilityAttempts += 1;
        if (compatibilityAttempts === 1) {
          controller.abort();
          throw new DOMException("The operation was aborted", "AbortError");
        }
        return jsonResponse({ accessToken: "legacy-marketplace-token", expiresIn: 900 });
      }),
    );

    await expect(authService.ensureSession(controller.signal)).rejects.toThrow("aborted");
    expect(getAuthBearerToken()).toBeNull();

    await expect(authService.ensureSession()).resolves.toBe(true);

    expect(compatibilityAttempts).toBe(2);
    expect(getAuthBearerToken()).toBe("legacy-marketplace-token");
  });
});

describe("authService", () => {
  beforeEach(() => {
    clearAuthData();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("posts credentials to the backend password endpoint and stores the AuthKit session", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "workos-access-token",
        csrfToken: "csrf-token",
        organizationId: "org_creator",
        organizationKind: "hotel_group",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
          workosUserId: "user_workos_creator",
        },
      }),
    );

    const response = await authService.login({
      email: "creator@example.test",
      password: "correct-password",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/password/login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          email: "creator@example.test",
          password: "correct-password",
          surface: "marketplace-web",
        }),
      }),
    );
    expect(getAuthBearerToken()).toBe("workos-access-token");
    expect(getAuthCsrfToken()).toBe("csrf-token");
    expect(isAuthOrganizationSelectionResponse(response)).toBe(false);
  });

  it("preserves a session committed by a concurrent session check", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "false");
    const firstRequest = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(firstRequest.promise).mockResolvedValueOnce(
      jsonResponse({
        accessToken: "concurrent-workos-access-token",
        user: { id: "user_creator", email: "creator@example.test", status: "active" },
      }),
    );

    const failingCheck = authService.ensureSession();
    await expect(authService.ensureSession()).resolves.toBe(true);
    firstRequest.reject(new Error("request failed"));

    await expect(failingCheck).resolves.toBe(false);
    expect(getAuthBearerToken()).toBe("concurrent-workos-access-token");
  });

  it("preserves controlled backend login errors", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          state: "invalid_credentials",
          message: "Email or password is incorrect.",
        },
        401,
      ),
    );

    await expect(
      authService.login({
        email: "creator@example.test",
        password: "wrong-password",
      }),
    ).rejects.toThrow("Email or password is incorrect.");
  });

  it("keeps pending organization selection state from password login", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        organizationSelectionRequired: true,
        csrfToken: "pending-csrf-token",
        organizations: [
          {
            organizationId: "org_creator",
            workosOrganizationId: "org_workos_creator",
            displayName: "Creator Workspace",
            kind: "creator_workspace",
          },
        ],
      }),
    );

    const response = await authService.login({
      email: "creator@example.test",
      password: "correct-password",
    });

    expect(isAuthOrganizationSelectionResponse(response)).toBe(true);
    expect(getAuthBearerToken()).toBeNull();
    expect(getAuthCsrfToken()).toBe("pending-csrf-token");
  });

  it("preserves verification-required auth state for the verification page", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          state: "email_verification_required",
          message: "Verify your email address to continue.",
          pendingAuthenticationToken: "pending-email-token",
          email: "creator@example.test",
          emailVerificationId: "email_verification_123",
        },
        403,
      ),
    );

    let thrown: unknown;
    try {
      await authService.login({
        email: "creator@example.test",
        password: "correct-password",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthStateError);
    expect(thrown).toMatchObject({
      state: "email_verification_required",
      pendingAuthenticationToken: "pending-email-token",
      emailVerificationId: "email_verification_123",
    });
  });

  it("posts account signup credentials to the backend and stores the AuthKit session", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "signup-workos-access-token",
        csrfToken: "signup-csrf-token",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
          workosUserId: "user_workos_creator",
        },
      }),
    );

    const response = await authService.signup({
      email: "creator@example.test",
      password: "correct-password",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/password/signup",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          email: "creator@example.test",
          password: "correct-password",
          surface: "marketplace-web",
        }),
      }),
    );
    expect(getAuthBearerToken()).toBe("signup-workos-access-token");
    expect(getAuthCsrfToken()).toBe("signup-csrf-token");
    expect(isAuthOrganizationSelectionResponse(response)).toBe(false);
  });

  it("keeps the current portless fallback port for signup requests", async () => {
    const localStorage = createStorageMock();
    vi.stubGlobal("window", {
      location: {
        protocol: "https:",
        port: "1355",
      },
      localStorage,
    });
    vi.stubGlobal("localStorage", localStorage);
    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "signup-workos-access-token",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
        },
      }),
    );

    await authService.signup({
      email: "creator@example.test",
      password: "correct-password",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost:1355/auth/password/signup",
      expect.any(Object),
    );
  });

  it("starts Google login through the AuthKit backend", () => {
    const location = {
      href: "https://marketplace.localhost/login",
      origin: "https://marketplace.localhost",
    };
    const localStorage = createStorageMock();
    vi.stubGlobal("window", {
      location,
      localStorage,
    });
    vi.stubGlobal("localStorage", localStorage);

    authService.startGoogleLogin("/marketplace");

    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.localhost/auth/oauth/google/start");
    expect(url.searchParams.get("surface")).toBe("marketplace-web");
    expect(url.searchParams.get("flow")).toBe("login");
    expect(url.searchParams.get("return_to")).toBe(
      "https://marketplace.localhost/login?auth=callback&returnTo=%2Fmarketplace",
    );
    expect(url.searchParams.get("error_return_to")).toBe("https://marketplace.localhost/login");
  });

  it("starts Google signup for the onboarding flow", () => {
    const location = {
      href: "https://marketplace.localhost/signup",
      origin: "https://marketplace.localhost",
    };
    const localStorage = createStorageMock();
    vi.stubGlobal("window", {
      location,
      localStorage,
    });
    vi.stubGlobal("localStorage", localStorage);

    authService.startGoogleSignup("/onboarding");

    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.localhost/auth/oauth/google/start");
    expect(url.searchParams.get("surface")).toBe("marketplace-web");
    expect(url.searchParams.get("flow")).toBe("signup");
    expect(url.searchParams.get("type")).toBeNull();
    expect(url.searchParams.get("return_to")).toBe(
      "https://marketplace.localhost/login?auth=callback&returnTo=%2Fonboarding",
    );
    expect(url.searchParams.get("error_return_to")).toBe("https://marketplace.localhost/signup");
  });

  it("requests password reset through the AuthKit backend", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        message: "If an account with that email exists, a password reset link has been sent.",
      }),
    );

    await expect(authService.forgotPassword("creator@example.test")).resolves.toEqual({
      message: "If an account with that email exists, a password reset link has been sent.",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/password/reset/request",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          email: "creator@example.test",
        }),
      }),
    );
  });

  it("confirms password reset through the AuthKit backend", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        message: "Password reset successful. Please sign in with your new password.",
      }),
    );

    await expect(authService.resetPassword("reset-token", "new-secure-password")).resolves.toEqual({
      message: "Password reset successful. Please sign in with your new password.",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/password/reset/confirm",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          token: "reset-token",
          newPassword: "new-secure-password",
        }),
      }),
    );
  });

  it("uses pending verification state to confirm email and store the AuthKit session", async () => {
    mockBrowserStorage();
    expect(
      storePendingEmailVerification({
        pendingAuthenticationToken: "pending-email-token",
        email: "creator@example.test",
        emailVerificationId: "email_verification_123",
        flow: "signup",
      }),
    ).toBe(true);
    expect(getPendingEmailVerification()).toMatchObject({
      pendingAuthenticationToken: "pending-email-token",
      flow: "signup",
    });

    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "verified-workos-access-token",
        csrfToken: "verified-csrf-token",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
          workosUserId: "user_workos_creator",
        },
      }),
    );

    await expect(authService.confirmEmailVerification("123456")).resolves.toMatchObject({
      accessToken: "verified-workos-access-token",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/email-verification/confirm",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          pendingAuthenticationToken: "pending-email-token",
          code: "123456",
          flow: "signup",
          surface: "marketplace-web",
        }),
      }),
    );
    expect(getAuthBearerToken()).toBe("verified-workos-access-token");
    expect(getAuthCsrfToken()).toBe("verified-csrf-token");
    expect(getPendingEmailVerification()).toBeNull();
  });

  it("completes hotel onboarding from account type alone", async () => {
    setAuthKitSession({
      accessToken: "signup-workos-access-token",
      csrfToken: "signup-csrf-token",
      user: { id: "user_creator", email: "creator@example.test", status: "active" },
    });
    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "creator-workos-access-token",
        csrfToken: "creator-csrf-token",
        organizationId: "org_creator",
        organizationKind: "hotel_group",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
          workosUserId: "user_workos_creator",
        },
      }),
    );

    await expect(authService.completeOnboarding("hotel")).resolves.toMatchObject({
      organizationKind: "hotel_group",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/onboarding",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          "x-vayada-csrf": "signup-csrf-token",
        }),
        body: JSON.stringify({
          type: "hotel",
          surface: "marketplace-web",
        }),
      }),
    );
    expect(getAuthBearerToken()).toBe("creator-workos-access-token");
    expect(getAuthCsrfToken()).toBe("creator-csrf-token");
  });

  it("falls back when pending verification storage is blocked", () => {
    mockBrowserStorage();
    vi.mocked(window.sessionStorage.setItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(window.sessionStorage.getItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(window.sessionStorage.removeItem).mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(
      storePendingEmailVerification({
        pendingAuthenticationToken: "pending-email-token",
        email: "creator@example.test",
      }),
    ).toBe(false);
    expect(getPendingEmailVerification()).toBeNull();
    expect(() => clearPendingEmailVerification()).not.toThrow();
  });

  it("surfaces controlled invalid reset token errors", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          state: "auth_failed",
          message: "Invalid or expired reset token. Please request a new password reset link.",
        },
        400,
      ),
    );

    await expect(authService.resetPassword("expired-token", "new-secure-password")).rejects.toThrow(
      "Invalid or expired reset token. Please request a new password reset link.",
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function mockBrowserStorage() {
  const sessionStorage = createStorageMock();
  const localStorage = createStorageMock();
  vi.stubGlobal("window", { sessionStorage, localStorage });
  vi.stubGlobal("sessionStorage", sessionStorage);
  vi.stubGlobal("localStorage", localStorage);
}

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    length: 0,
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
  };
}
