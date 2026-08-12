import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api/client";
import { authService } from "./index";
import {
  clearAuthData,
  getAuthBearerToken,
  setAuthKitSession,
  type AuthKitSessionResponse,
} from "./storage";

describe("affiliate auth service", () => {
  beforeEach(() => {
    clearAuthData();
  });

  afterEach(() => {
    clearAuthData();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("logs in through same-origin auth even when a public auth API origin is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTH_API_URL", "https://api.example.test");
    const fetchMock = vi.fn(async () => jsonResponse(session()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authService.login("affiliate@example.test", "secret")).resolves.toMatchObject({
      accessToken: "workos-access-token",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/password/login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          email: "affiliate@example.test",
          password: "secret",
          surface: "affiliate-dashboard",
        }),
      }),
    );
    expect(getAuthBearerToken()).toBe("workos-access-token");
  });

  it("loads and refreshes sessions through same-origin auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(session()))
      .mockResolvedValueOnce(jsonResponse(session({ organizationId: "org_affiliate" })));
    vi.stubGlobal("fetch", fetchMock);

    await authService.refreshSession();
    await authService.refreshSession("org_affiliate");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/auth/session?surface=affiliate-dashboard",
      "/auth/session/refresh",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "x-vayada-csrf": "csrf-token" }),
        body: JSON.stringify({
          organizationId: "org_affiliate",
          surface: "affiliate-dashboard",
        }),
      }),
    );
  });

  it("logs out through same-origin auth and follows the backend return URL", async () => {
    const storage = memoryStorage();
    const location = {
      href: "https://affiliate.localhost/dashboard",
      origin: "https://affiliate.localhost",
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage, location });
    setAuthKitSession(session());
    const fetchMock = vi.fn(async () =>
      jsonResponse({ logoutUrl: "https://auth.workos.test/logout?return_to=affiliate" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await authService.logout();

    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "x-vayada-csrf": "csrf-token" }),
        body: JSON.stringify({ surface: "affiliate-dashboard" }),
      }),
    );
    expect(location.href).toBe("https://auth.workos.test/logout?return_to=affiliate");
    expect(getAuthBearerToken()).toBeNull();
  });

  it("keeps affiliate product requests on their configured API origin", async () => {
    setAuthKitSession(session());
    const fetchMock = vi.fn(async () => jsonResponse({ id: "affiliate_123" }));
    vi.stubGlobal("fetch", fetchMock);

    await new ApiClient("https://api.product.test").get("/api/affiliate-dashboard/me");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.product.test/api/affiliate-dashboard/me",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer workos-access-token" }),
      }),
    );
  });
});

function session(overrides: Partial<AuthKitSessionResponse> = {}): AuthKitSessionResponse {
  return {
    accessToken: "workos-access-token",
    csrfToken: "csrf-token",
    organizationId: "org_affiliate",
    user: {
      id: "user_affiliate",
      email: "affiliate@example.test",
      status: "active",
    },
    ...overrides,
  };
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
