import { afterEach, describe, expect, it, vi } from "vitest";

import { authService } from "./index";
import {
  clearAuthData,
  getAuthBearerToken,
  getAuthCsrfToken,
  isAuthOrganizationSelectionResponse,
  setAuthKitSession,
} from "./sessionStore";

describe("booking admin auth service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuthData();
    vi.restoreAllMocks();
  });

  it("uses the refresh-token endpoint when an in-memory session expires", async () => {
    setAuthKitSession({
      accessToken: "expired-access-token",
      csrfToken: "csrf-token",
      organizationId: "org_hotel_group",
      user: {
        id: "user_hotel",
        email: "owner@example.test",
        status: "active",
      },
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        accessToken: "fresh-access-token",
        csrfToken: "fresh-csrf-token",
        organizationId: "org_hotel_group",
        user: {
          id: "user_hotel",
          email: "owner@example.test",
          status: "active",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(authService.refreshSession()).resolves.toMatchObject({
      accessToken: "fresh-access-token",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/session/refresh",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "x-vayada-csrf": "csrf-token" }),
        body: JSON.stringify({ surface: "booking-admin" }),
      }),
    );
  });

  it("drops the expired bearer when refresh requires organization selection", async () => {
    setAuthKitSession({
      accessToken: "expired-access-token",
      csrfToken: "expired-csrf-token",
      user: {
        id: "user_hotel",
        email: "owner@example.test",
        status: "active",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          organizationSelectionRequired: true,
          csrfToken: "selection-csrf-token",
          organizations: [],
          user: {
            id: "user_hotel",
            email: "owner@example.test",
            status: "active",
          },
        }),
      ),
    );

    const response = await authService.refreshSession();

    expect(isAuthOrganizationSelectionResponse(response)).toBe(true);
    expect(getAuthBearerToken()).toBeNull();
    expect(getAuthCsrfToken()).toBe("selection-csrf-token");
  });

  it("starts Google login through the AuthKit backend", () => {
    const location = {
      href: "https://admin.booking.localhost/login",
      origin: "https://admin.booking.localhost",
    };
    vi.stubGlobal("window", { location });

    authService.startGoogleLogin("/dashboard");

    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.localhost/auth/oauth/google/start");
    expect(url.searchParams.get("surface")).toBe("booking-admin");
    expect(url.searchParams.get("flow")).toBe("login");
    expect(url.searchParams.get("return_to")).toBe(
      "https://admin.booking.localhost/login?auth=callback&returnTo=%2Fdashboard",
    );
    expect(url.searchParams.get("error_return_to")).toBe("https://admin.booking.localhost/login");
  });

  it("starts hotel Google signup through the AuthKit backend", () => {
    const location = {
      href: "https://admin.booking.localhost/signup",
      origin: "https://admin.booking.localhost",
    };
    vi.stubGlobal("window", { location });

    authService.startGoogleSignup("/dashboard");

    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.localhost/auth/oauth/google/start");
    expect(url.searchParams.get("surface")).toBe("booking-admin");
    expect(url.searchParams.get("flow")).toBe("signup");
    expect(url.searchParams.get("type")).toBe("hotel");
    expect(url.searchParams.get("return_to")).toBe(
      "https://admin.booking.localhost/login?auth=callback&returnTo=%2Fdashboard",
    );
    expect(url.searchParams.get("error_return_to")).toBe("https://admin.booking.localhost/signup");
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
