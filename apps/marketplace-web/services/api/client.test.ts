import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient, type ApiSessionRecoveryHandlers } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ApiClient request logging", () => {
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
      return token;
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

  it("signs out without retrying when session refresh fails", async () => {
    const handlers = recoveryHandlers(async () => {
      throw new Error("refresh failed");
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "expired" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = clientFor(() => "expired-token", handlers);

    await expect(client.get("/api/marketplace/offers")).rejects.toMatchObject({ status: 401 });
    expect(handlers.refresh).toHaveBeenCalledOnce();
    expect(handlers.signOut).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("allows a later request to recover after a transient refresh failure", async () => {
    let token = "expired-transient-token";
    let refreshAttempt = 0;
    const handlers = recoveryHandlers(async () => {
      refreshAttempt += 1;
      if (refreshAttempt === 1) return null;
      token = "fresh-after-transient-failure";
      return token;
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      (init.headers as Record<string, string>).Authorization ===
      "Bearer fresh-after-transient-failure"
        ? jsonResponse({ ok: true })
        : jsonResponse({ detail: "expired" }, 401),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = clientFor(() => token, handlers);
    await expect(client.get("/api/marketplace/offers")).rejects.toMatchObject({ status: 401 });
    await expect(client.get("/api/marketplace/offers")).resolves.toEqual({ ok: true });

    expect(handlers.refresh).toHaveBeenCalledTimes(2);
    expect(handlers.signOut).toHaveBeenCalledOnce();
  });

  it("stops after one retry and signs out when the refreshed request is also unauthorized", async () => {
    let token = "expired-token";
    const handlers = recoveryHandlers(async () => {
      token = "fresh-but-rejected-token";
      return token;
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
    const refresh = Promise.withResolvers<string | null>();
    const handlers = recoveryHandlers(async () => {
      const refreshed = await refresh.promise;
      token = refreshed ?? token;
      return refreshed;
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
      return token;
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

function recoveryHandlers(refresh: () => Promise<string | null>): ApiSessionRecoveryHandlers & {
  refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
  signOut: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    refresh: vi.fn(async () => {
      await refresh();
    }),
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
