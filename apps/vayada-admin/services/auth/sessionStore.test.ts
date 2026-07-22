import { afterEach, describe, expect, it, vi } from "vitest";

import { vayadaApiClient } from "@vayada/marketplace-shared/api/client";
import { clearAuthData, setAuthKitSession } from "./sessionStore";

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
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
