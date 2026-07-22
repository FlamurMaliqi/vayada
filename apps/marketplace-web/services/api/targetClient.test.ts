import { afterEach, describe, expect, it, vi } from "vitest";

describe("target API routing", () => {
  afterEach(() => {
    vi.doUnmock("../auth/sessionStore");
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the Vayada API URL when it differs from the auth API URL", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_VAYADA_API_URL", "https://next-api.example.test");
    vi.stubEnv("NEXT_PUBLIC_AUTH_API_URL", "https://auth-api.example.test");
    vi.doMock("../auth/sessionStore", () => ({
      getAuthKitAccessToken: () => "workos-access-token",
    }));

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { targetApiClient } = await import("./targetClient");
    await expect(targetApiClient.get("/api/marketplace/creators/me")).resolves.toEqual({
      ok: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://next-api.example.test/api/marketplace/creators/me",
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(request?.credentials).toBe("include");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer workos-access-token");
  });
});
