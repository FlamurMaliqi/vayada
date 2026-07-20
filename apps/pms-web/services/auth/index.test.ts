import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthStateError,
  authService,
  clearPendingEmailVerification,
  getPendingEmailVerification,
  storePendingEmailVerification,
} from "./index";
import { clearAuthData, getAuthBearerToken, setAuthKitSession } from "./sessionStore";

describe("PMS AuthKit session refresh", () => {
  beforeEach(() => {
    clearAuthData();
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
  });

  afterEach(() => {
    clearAuthData();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the AuthKit session when the first-run PMS compatibility token is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/session?surface=pms-web")) {
        return jsonResponse({
          accessToken: "authkit-token",
          csrfToken: "csrf-token",
          organizationId: "org_hotel_group",
          user: {
            id: "user_hotel_admin",
            email: "hotel@example.com",
            status: "active",
          },
        });
      }
      if (url.endsWith("/auth/compat/pms-web-token")) {
        return jsonResponse({ error: "missing_pms_property_link" }, 403);
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(authService.refreshSession()).resolves.toMatchObject({
      accessToken: "authkit-token",
      organizationId: "org_hotel_group",
    });
    expect(getAuthBearerToken()).toBe("authkit-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes a persisted compatibility session and keeps using the WorkOS token", async () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    localStorage.setItem("access_token", "persisted-compatibility-token");
    localStorage.setItem("token_expires_at", String(Date.now() + 3_600_000));
    localStorage.setItem("userType", "hotel");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/session?surface=pms-web")) {
        return jsonResponse({
          accessToken: "workos-access-token",
          csrfToken: "csrf-token",
          organizationId: "org_hotel_group",
          user: {
            id: "user_hotel_admin",
            email: "hotel@example.com",
            status: "active",
          },
        });
      }
      if (url.endsWith("/auth/compat/pms-web-token")) {
        return jsonResponse({
          accessToken: "new-compatibility-token",
          expiresIn: 3600,
          tokenType: "Bearer",
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(authService.ensureSession()).resolves.toBe(true);
    expect(getAuthBearerToken()).toBe("workos-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an in-memory WorkOS session usable when the AuthKit login UI is disabled", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "false");
    setAuthKitSession({
      accessToken: "workos-access-token",
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
        status: "active",
      },
    });

    expect(getAuthBearerToken()).toBe("workos-access-token");
    expect(authService.isLoggedIn()).toBe(true);
  });

  it("preserves verification-required auth state for the verification page", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          state: "email_verification_required",
          message: "Verify your email address to continue.",
          pendingAuthenticationToken: "pending-email-token",
          email: "hotel@example.com",
          emailVerificationId: "email_verification_123",
        },
        403,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    let thrown: unknown;
    try {
      await authService.signup({
        email: "hotel@example.com",
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

  it("uses pending verification state to confirm email and store the PMS AuthKit session", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "false");
    mockBrowserStorage();
    expect(
      storePendingEmailVerification({
        pendingAuthenticationToken: "pending-email-token",
        email: "hotel@example.com",
        emailVerificationId: "email_verification_123",
        flow: "signup",
        intent: "hotel",
      }),
    ).toBe(true);
    expect(getPendingEmailVerification()).toMatchObject({
      pendingAuthenticationToken: "pending-email-token",
      flow: "signup",
      intent: "hotel",
    });

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        accessToken: "verified-workos-access-token",
        csrfToken: "verified-csrf-token",
        user: {
          id: "user_hotel_admin",
          email: "hotel@example.com",
          status: "active",
          workosUserId: "user_workos_hotel",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

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
          intent: "hotel",
          surface: "pms-web",
        }),
      }),
    );
    expect(getAuthBearerToken()).toBe("verified-workos-access-token");
    expect(getPendingEmailVerification()).toBeNull();
  });

  it("clears the selected shared property when the AuthKit organization changes", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });

    setAuthKitSession({
      accessToken: "org-a-token",
      organizationId: "org_hotel_a",
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
        status: "active",
      },
    });
    localStorage.setItem("selectedSharedPropertyId", "property_a");
    localStorage.setItem("selectedHotelId", "property_a");

    setAuthKitSession({
      accessToken: "org-b-token",
      organizationId: "org_hotel_b",
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
        status: "active",
      },
    });

    expect(localStorage.getItem("selectedSharedPropertyId")).toBeNull();
    expect(localStorage.getItem("selectedHotelId")).toBeNull();
  });

  it("stores the PMS resource scope as the selected property", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });

    setAuthKitSession({
      accessToken: "authkit-token",
      organizationId: "org_hotel_a",
      workosOrganizationId: "org_workos_hotel_a",
      resources: {
        "pms:pms_property": [" property_a "],
      },
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
        status: "active",
      },
    });

    expect(localStorage.getItem("selectedSharedPropertyId")).toBe("property_a");
    expect(localStorage.getItem("selectedHotelId")).toBe("property_a");
    expect(localStorage.getItem("selectedSharedPropertyOrganizationId")).toBe("org_hotel_a");
    expect(localStorage.getItem("selectedWorkosOrganizationId")).toBe("org_workos_hotel_a");
  });

  it("preserves a valid non-first PMS property selection", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage });
    localStorage.setItem("selectedSharedPropertyOrganizationId", "org_hotel_a");
    localStorage.setItem("selectedSharedPropertyId", "property_b");
    localStorage.setItem("selectedHotelId", "property_b");

    setAuthKitSession({
      accessToken: "authkit-token",
      organizationId: "org_hotel_a",
      resources: {
        "pms:pms_property": ["property_a", "property_b"],
      },
      user: {
        id: "user_hotel_admin",
        email: "hotel@example.com",
        status: "active",
      },
    });

    expect(localStorage.getItem("selectedSharedPropertyId")).toBe("property_b");
    expect(localStorage.getItem("selectedHotelId")).toBe("property_b");
  });

  it("starts Google login through the AuthKit backend", () => {
    const location = {
      href: "https://pms.localhost/login",
      origin: "https://pms.localhost",
    };
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { location, localStorage: storage });

    authService.startGoogleLogin("/dashboard");

    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.localhost/auth/oauth/google/start");
    expect(url.searchParams.get("surface")).toBe("pms-web");
    expect(url.searchParams.get("flow")).toBe("login");
    expect(url.searchParams.get("return_to")).toBe(
      "https://pms.localhost/login?auth=callback&returnTo=%2Fdashboard",
    );
    expect(url.searchParams.get("error_return_to")).toBe("https://pms.localhost/login");
  });

  it("starts hotel Google signup through the AuthKit backend", () => {
    const location = {
      href: "https://pms.localhost/signup",
      origin: "https://pms.localhost",
    };
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { location, localStorage: storage });

    authService.startGoogleSignup("/dashboard");

    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.localhost/auth/oauth/google/start");
    expect(url.searchParams.get("surface")).toBe("pms-web");
    expect(url.searchParams.get("flow")).toBe("signup");
    expect(url.searchParams.get("type")).toBe("hotel");
    expect(url.searchParams.get("return_to")).toBe(
      "https://pms.localhost/login?auth=callback&returnTo=%2Fdashboard",
    );
    expect(url.searchParams.get("error_return_to")).toBe("https://pms.localhost/signup");
  });

  it("requests and confirms password resets through the AuthKit backend", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          message: "If an account with that email exists, a password reset link has been sent.",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          message: "Password reset successful. Please sign in with your new password.",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authService.forgotPassword("owner@example.test")).resolves.toEqual({
      message: "If an account with that email exists, a password reset link has been sent.",
    });
    await expect(authService.resetPassword("reset-token", "new-password")).resolves.toEqual({
      message: "Password reset successful. Please sign in with your new password.",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.localhost/auth/password/reset/request",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ email: "owner@example.test" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.localhost/auth/password/reset/confirm",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ token: "reset-token", newPassword: "new-password" }),
      }),
    );
  });
});

function mockBrowserStorage(): void {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, sessionStorage: storage });
  clearPendingEmailVerification();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}
