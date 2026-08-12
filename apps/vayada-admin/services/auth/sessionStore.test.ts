import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vayadaApiClient } from "@vayada/marketplace-shared/api/client";
import { authService } from "./auth";
import {
  clearAuthData,
  getAuthBearerToken,
  getAuthKitAccessToken,
  getAuthStateGeneration,
  getOrRefreshAuthKitAccessToken,
  setAuthKitSession,
  setLegacyCompatibilityToken,
} from "./sessionStore";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});

afterEach(() => {
  clearAuthData();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("admin Vayada API authentication", () => {
  it("refreshes an expired AuthKit token once and retries the request", async () => {
    setAuthKitSession({
      accessToken: "stale-workos-token",
      csrfToken: "csrf-token",
      user: { id: "admin-user", email: "admin@example.com", status: "active" },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: "fresh-workos-token",
          csrfToken: "fresh-csrf-token",
          user: { id: "admin-user", email: "admin@example.com", status: "active" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      vayadaApiClient.get<{ ok: boolean }>("/api/marketplace/admin/test"),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.localhost/api/marketplace/admin/test",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer stale-workos-token" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/auth/session?surface=platform-admin",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.localhost/api/marketplace/admin/test",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer fresh-workos-token" }),
      }),
    );
  });

  it("clears the session and allows another refresh after refresh rejection", async () => {
    setAuthKitSession({
      accessToken: "stale-workos-token",
      csrfToken: "csrf-token",
      user: { id: "admin-user", email: "admin@example.com", status: "active" },
    });

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("session refresh failed"))
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: "fresh-workos-token",
          csrfToken: "fresh-csrf-token",
          user: { id: "admin-user", email: "admin@example.com", status: "active" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOrRefreshAuthKitAccessToken(undefined, true)).resolves.toBeNull();
    expect(getAuthKitAccessToken()).toBeNull();
    expect(localStorage.getItem("isLoggedIn")).toBe("false");

    await expect(getOrRefreshAuthKitAccessToken(undefined, true)).resolves.toBe(
      "fresh-workos-token",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the session when refresh is intentionally aborted", async () => {
    setAuthKitSession({
      accessToken: "current-workos-token",
      csrfToken: "csrf-token",
      user: { id: "admin-user", email: "admin@example.com", status: "active" },
    });

    const controller = new AbortController();
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    controller.abort(abortError);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOrRefreshAuthKitAccessToken(controller.signal, true)).rejects.toBe(abortError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAuthKitAccessToken()).toBe("current-workos-token");
    expect(localStorage.getItem("isLoggedIn")).toBe("true");
  });

  it("lets one caller abort without cancelling a shared refresh", async () => {
    setAuthKitSession({
      accessToken: "stale-workos-token",
      csrfToken: "csrf-token",
      user: { id: "admin-user", email: "admin@example.com", status: "active" },
    });

    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(refreshResponse);
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const abortedCaller = getOrRefreshAuthKitAccessToken(controller.signal, true);
    const waitingCaller = getOrRefreshAuthKitAccessToken(undefined, true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const abortError = new DOMException("The operation was aborted.", "AbortError");
    controller.abort(abortError);
    await expect(abortedCaller).rejects.toBe(abortError);

    resolveRefresh(
      jsonResponse({
        accessToken: "fresh-workos-token",
        csrfToken: "fresh-csrf-token",
        user: { id: "admin-user", email: "admin@example.com", status: "active" },
      }),
    );
    await expect(waitingCaller).resolves.toBe("fresh-workos-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not restore a session when refresh succeeds after logout", async () => {
    setAuthKitSession({
      accessToken: "stale-workos-token",
      csrfToken: "csrf-token",
      user: { id: "admin-user", email: "admin@example.com", status: "active" },
    });

    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(refreshResponse);
    vi.stubGlobal("fetch", fetchMock);

    const refresh = getOrRefreshAuthKitAccessToken(undefined, true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    clearAuthData();

    resolveRefresh(
      jsonResponse({
        accessToken: "late-workos-token",
        csrfToken: "late-csrf-token",
        user: { id: "admin-user", email: "admin@example.com", status: "active" },
      }),
    );

    await expect(refresh).resolves.toBeNull();
    expect(getAuthKitAccessToken()).toBeNull();
    expect(localStorage.getItem("isLoggedIn")).toBe("false");
  });

  it("reports a direct refresh as stale when logout wins the race", async () => {
    setAuthKitSession({
      accessToken: "old-workos-token",
      csrfToken: "old-csrf-token",
      user: { id: "old-admin", email: "old-admin@example.com", status: "active" },
    });

    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(refreshResponse));

    const refresh = authService.refreshSession();
    clearAuthData();
    resolveRefresh(
      jsonResponse({
        accessToken: "late-workos-token",
        csrfToken: "late-csrf-token",
        user: { id: "old-admin", email: "old-admin@example.com", status: "active" },
      }),
    );

    await expect(refresh).resolves.toBeNull();
    expect(getAuthKitAccessToken()).toBeNull();
  });

  it("does not retry an old request under a newer login after refresh succeeds", async () => {
    setAuthKitSession({
      accessToken: "old-workos-token",
      csrfToken: "old-csrf-token",
      user: { id: "old-admin", email: "old-admin@example.com", status: "active" },
    });

    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, 401))
      .mockReturnValueOnce(refreshResponse);
    vi.stubGlobal("fetch", fetchMock);

    const request = vayadaApiClient.post("/api/marketplace/admin/write", { name: "old write" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    setAuthKitSession({
      accessToken: "new-workos-token",
      csrfToken: "new-csrf-token",
      user: { id: "new-admin", email: "new-admin@example.com", status: "active" },
    });

    resolveRefresh(
      jsonResponse({
        accessToken: "late-old-workos-token",
        csrfToken: "late-old-csrf-token",
        user: { id: "old-admin", email: "old-admin@example.com", status: "active" },
      }),
    );

    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAuthKitAccessToken()).toBe("new-workos-token");
    expect(localStorage.getItem("userEmail")).toBe("new-admin@example.com");
  });

  it("does not clear a newer login when an older refresh fails", async () => {
    setAuthKitSession({
      accessToken: "stale-workos-token",
      csrfToken: "stale-csrf-token",
      user: { id: "old-admin", email: "old-admin@example.com", status: "active" },
    });

    let rejectRefresh!: (reason: Error) => void;
    const refreshResponse = new Promise<Response>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const fetchMock = vi.fn().mockReturnValue(refreshResponse);
    vi.stubGlobal("fetch", fetchMock);

    const refresh = getOrRefreshAuthKitAccessToken(undefined, true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    setAuthKitSession({
      accessToken: "new-workos-token",
      csrfToken: "new-csrf-token",
      user: { id: "new-admin", email: "new-admin@example.com", status: "active" },
    });

    rejectRefresh(new Error("old session refresh failed"));

    await expect(refresh).resolves.toBeNull();
    expect(getAuthKitAccessToken()).toBe("new-workos-token");
    expect(localStorage.getItem("userEmail")).toBe("new-admin@example.com");
    expect(localStorage.getItem("isLoggedIn")).toBe("true");
  });

  it("keeps a newer login when an older ensure-session refresh fails", async () => {
    let rejectRefresh!: (reason: Error) => void;
    const refreshResponse = new Promise<Response>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    const fetchMock = vi.fn().mockReturnValue(refreshResponse);
    vi.stubGlobal("fetch", fetchMock);

    const ensureSession = authService.ensureSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    setAuthKitSession({
      accessToken: "new-workos-token",
      csrfToken: "new-csrf-token",
      user: { id: "new-admin", email: "new-admin@example.com", status: "active" },
    });

    rejectRefresh(new Error("old session refresh failed"));

    await expect(ensureSession).resolves.toBe(true);
    expect(getAuthKitAccessToken()).toBe("new-workos-token");
    expect(localStorage.getItem("userEmail")).toBe("new-admin@example.com");
  });

  it("routes login and the admin compatibility bridge through same-origin auth", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: "workos-access-token",
          csrfToken: "csrf-token",
          user: { id: "admin-user", email: "admin@example.com", status: "active" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: "compatibility-token",
          expiresIn: 900,
          tokenType: "Bearer",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await authService.login({ email: "admin@example.com", password: "secret" });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/auth/password/login",
      "/auth/compat/marketplace-admin-token",
    ]);
    expect(getAuthBearerToken()).toBe("compatibility-token");
  });

  it("includes the platform surface on CSRF-protected session switches", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "false");
    setAuthKitSession({
      accessToken: "workos-access-token",
      csrfToken: "csrf-token",
      user: { id: "admin-user", email: "admin@example.com", status: "active" },
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        accessToken: "switched-workos-token",
        csrfToken: "csrf-token",
        organizationId: "org_platform",
        user: { id: "admin-user", email: "admin@example.com", status: "active" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await authService.refreshSession("org_platform");

    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/session/refresh",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "x-vayada-csrf": "csrf-token" }),
        body: JSON.stringify({ organizationId: "org_platform", surface: "platform-admin" }),
      }),
    );
  });

  it("routes recovery and logout through same-origin auth", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "false");
    const location = { href: "https://admin.localhost/dashboard" };
    Object.assign(window, { location });
    setAuthKitSession({
      accessToken: "workos-access-token",
      csrfToken: "csrf-token",
      user: { id: "admin-user", email: "admin@example.com", status: "active" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Recovery email sent." }))
      .mockResolvedValueOnce(jsonResponse({ message: "Password reset." }))
      .mockResolvedValueOnce(jsonResponse({ logoutUrl: "/login" }));
    vi.stubGlobal("fetch", fetchMock);

    await authService.forgotPassword("admin@example.com");
    await authService.resetPassword("reset-token", "new-password");
    await authService.logout();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/auth/password/reset/request",
      "/auth/password/reset/confirm",
      "/auth/logout",
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "x-vayada-csrf": "csrf-token" }),
        body: JSON.stringify({ surface: "platform-admin" }),
      }),
    );
    expect(location.href).toBe("/login");
  });

  it("drops a compatibility token when a different AuthKit session is committed", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    setAuthKitSession({
      accessToken: "old-workos-token",
      csrfToken: "old-csrf-token",
      user: { id: "old-admin", email: "old-admin@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("old-compatibility-token", 900);
    expect(getAuthBearerToken()).toBe("old-compatibility-token");

    setAuthKitSession({
      accessToken: "new-workos-token",
      csrfToken: "new-csrf-token",
      user: { id: "new-admin", email: "new-admin@example.com", status: "active" },
    });

    expect(getAuthBearerToken()).toBe("new-workos-token");
  });

  it("keeps a compatibility token during a same-session refresh", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    setAuthKitSession({
      accessToken: "old-workos-token",
      csrfToken: "old-csrf-token",
      organizationId: "organization-a",
      user: { id: "admin-a", email: "admin@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("current-compatibility-token", 900);

    setAuthKitSession(
      {
        accessToken: "refreshed-workos-token",
        csrfToken: "refreshed-csrf-token",
        organizationId: "organization-a",
        user: { id: "admin-a", email: "admin@example.com", status: "active" },
      },
      getAuthStateGeneration(),
    );

    expect(getAuthBearerToken()).toBe("current-compatibility-token");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
