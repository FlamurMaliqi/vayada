import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient, type ApiSessionRecoveryHandlers, type ApiSessionRefreshResult } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ApiClient request logging", () => {
  it("sends JSON PATCH requests through the shared authenticated client", async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return jsonResponse({ updated: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ApiClient("https://api.example.test").patch("/settings", { enabled: true }),
    ).resolves.toEqual({ updated: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.method).toBe("PATCH");
    expect(options?.body).toBe(JSON.stringify({ enabled: true }));
    expect(new Headers(options?.headers).get("Content-Type")).toBe("application/json");
  });

  it("does not declare JSON for a bodyless delete", async () => {
    const fetchMock = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await new ApiClient("https://api.example.test").delete("/offers/offer-one");

    expect(fetchMock).toHaveBeenCalledOnce();
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.body).toBeUndefined();
    expect(new Headers(options?.headers).get("Content-Type")).toBeNull();
  });

  it("does not log a caller-initiated abort as an API failure", async () => {
    const controller = new AbortController();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }),
    );

    const request = new ApiClient("https://api.example.test").get("/status", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still logs an unexpected network failure", async () => {
    const error = new TypeError("Failed to fetch");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));

    await expect(new ApiClient("https://api.example.test").get("/status")).rejects.toBe(error);
    expect(errorSpy).toHaveBeenCalledWith("API request failed:", error);
  });
});

describe("shared Marketplace API session recovery", () => {
  it("refreshes once and retries with the new access token", async () => {
    let token = "expired-token";
    const handlers = recoveryHandlers(async () => {
      token = "fresh-token";
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = clientFor(() => token, handlers);

    await expect(client.get<{ ok: boolean }>("/api/marketplace/offers")).resolves.toEqual({
      ok: true,
    });
    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(handlers.signOut).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizationHeader(fetchMock, 0)).toBe("Bearer expired-token");
    expect(authorizationHeader(fetchMock, 1)).toBe("Bearer fresh-token");
  });

  it("keeps a transient session refresh failure retryable without signing out", async () => {
    const handlers = recoveryHandlers(async () => {
      throw new TypeError("Failed to fetch");
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "expired" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = clientFor(() => "expired-token", handlers);

    await expect(client.get("/api/marketplace/offers")).rejects.toMatchObject({ status: 401 });
    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(handlers.signOut).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("signs out when session refresh is definitively rejected", async () => {
    const handlers = recoveryHandlers(async () => {
      throw Object.assign(new Error("invalid session"), { status: 401 });
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "expired" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = clientFor(() => "expired-token", handlers);

    await expect(client.get("/api/marketplace/offers")).rejects.toMatchObject({ status: 401 });
    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(handlers.signOut).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("signs out when refresh succeeds without replacing the expired token", async () => {
    const handlers = recoveryHandlers(async () => undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "expired" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = clientFor(() => "expired-token", handlers);
    await expect(client.get("/api/marketplace/offers")).rejects.toMatchObject({ status: 401 });

    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(handlers.signOut).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("routes organization selection without signing out the pending session", async () => {
    let token: string | null = "expired-token";
    const handlers = recoveryHandlers(async () => {
      token = null;
      return { status: "organization_selection_required" };
    });
    handlers.onOrganizationSelectionRequired = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "expired" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = clientFor(() => token, handlers);
    await expect(client.get("/api/marketplace/offers")).rejects.toMatchObject({ status: 401 });

    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(handlers.onOrganizationSelectionRequired).toHaveBeenCalledOnce();
    expect(handlers.signOut).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops after one retry and signs out when the refreshed request is also unauthorized", async () => {
    let token = "expired-token";
    const handlers = recoveryHandlers(async () => {
      token = "fresh-but-rejected-token";
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = clientFor(() => token, handlers);

    await expect(client.get("/api/marketplace/offers")).rejects.toMatchObject({ status: 401 });
    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(handlers.signOut).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one refresh across concurrent unauthorized requests from different client families", async () => {
    let token = "expired-token";
    const refresh = Promise.withResolvers<string>();
    const handlers = recoveryHandlers(async () => {
      const refreshed = await refresh.promise;
      token = refreshed;
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization === "Bearer fresh-token"
        ? jsonResponse({ ok: true })
        : jsonResponse({ detail: "expired" }, 401),
    );
    vi.stubGlobal("fetch", fetchMock);

    const marketplaceClient = clientFor(() => token, handlers);
    const targetClient = clientFor(() => token, handlers);
    const sharedSetupClient = clientFor(() => token, handlers);
    const first = marketplaceClient.get("/api/marketplace/offers");
    const second = targetClient.get("/api/marketplace/collaborations");
    const third = sharedSetupClient.get("/api/hotel/setup");
    await vi.waitFor(() => expect(handlers.refresh).toHaveBeenCalledOnce());
    refresh.resolve("fresh-token");

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { ok: true },
      { ok: true },
      { ok: true },
    ]);
    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(handlers.signOut).not.toHaveBeenCalled();
  });

  it("retries profile uploads through the same recovery path", async () => {
    let token = "expired-upload-token";
    const handlers = recoveryHandlers(async () => {
      token = "fresh-upload-token";
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ mediaId: "media-profile-001" }));
    vi.stubGlobal("fetch", fetchMock);
    const formData = new FormData();
    formData.append("file", new Blob(["photo"], { type: "image/jpeg" }), "profile.jpg");

    await expect(
      clientFor(() => token, handlers).upload("/api/account/profile-image", formData),
    ).resolves.toEqual({ mediaId: "media-profile-001" });

    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authorizationHeader(fetchMock, 1)).toBe("Bearer fresh-upload-token");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(formData);
  });
});

function clientFor(
  tokenProvider: () => string | null,
  handlers: ApiSessionRecoveryHandlers,
): ApiClient {
  return new ApiClient("https://api.localhost", tokenProvider, () => handlers);
}

function recoveryHandlers(
  refresh: () => Promise<ApiSessionRefreshResult | void>,
): ApiSessionRecoveryHandlers & {
  refresh: ReturnType<typeof vi.fn<() => Promise<ApiSessionRefreshResult | void>>>;
  signOut: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    refresh: vi.fn(refresh),
    signOut: vi.fn(async () => undefined),
  };
}

function authorizationHeader(
  fetchMock: ReturnType<typeof vi.fn>,
  call: number,
): string | undefined {
  return (fetchMock.mock.calls[call]?.[1]?.headers as Record<string, string> | undefined)
    ?.Authorization;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
