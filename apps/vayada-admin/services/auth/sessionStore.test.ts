import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { vayadaApiClient } from "@vayada/marketplace-shared/api/client";
import {
  clearAuthData,
  getAuthKitAccessToken,
  getOrRefreshAuthKitAccessToken,
  setAuthKitSession,
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
      "https://api.localhost/auth/session",
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
    const fetchMock = vi.fn().mockRejectedValueOnce(abortError);
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOrRefreshAuthKitAccessToken(controller.signal, true)).rejects.toBe(abortError);
    expect(getAuthKitAccessToken()).toBe("current-workos-token");
    expect(localStorage.getItem("isLoggedIn")).toBe("true");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
