import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiSessionRecoveryHandlers } from "@vayada/product-onboarding/apiSessionRecovery";
import { clearAuthData, setAuthKitSession } from "../auth/sessionStore";
import { ApiClient } from "./client";
import { pmsOperationsRequestOptions } from "./pmsOperationsClient";

afterEach(() => {
  clearAuthData();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("PMS API client", () => {
  it("does not reuse stale operational read-model responses", () => {
    expect(pmsOperationsRequestOptions.cache).toBe("no-store");
  });

  it("refreshes an expired AuthKit session and retries the request once", async () => {
    setAuthKitSession({
      accessToken: "expired-workos-token",
      csrfToken: "csrf-token",
      user: {
        id: "user_1",
        email: "owner@example.com",
        status: "active",
      },
    });
    const handlers: ApiSessionRecoveryHandlers = {
      refresh: vi.fn(async () => {
        setAuthKitSession({
          accessToken: "fresh-workos-token",
          csrfToken: "fresh-csrf-token",
          user: {
            id: "user_1",
            email: "owner@example.com",
            status: "active",
          },
        });
      }),
      signOut: vi.fn(),
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ApiClient("https://api.localhost", handlers).get("/api/pms/properties/property_1/rooms"),
    ).resolves.toEqual({ ok: true });

    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(handlers.signOut).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizationHeader(fetchMock, 0)).toBe("Bearer expired-workos-token");
    expect(authorizationHeader(fetchMock, 1)).toBe("Bearer fresh-workos-token");
  });
});

function authorizationHeader(fetchMock: ReturnType<typeof vi.fn>, call: number): string | null {
  return new Headers(fetchMock.mock.calls[call]?.[1]?.headers).get("Authorization");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
