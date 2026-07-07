import { afterEach, describe, expect, it, vi } from "vitest";

import { authService } from "./index";

describe("booking admin auth service", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
