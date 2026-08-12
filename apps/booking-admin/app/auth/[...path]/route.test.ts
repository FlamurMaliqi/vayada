import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const upstreamFetch = vi.fn();

beforeEach(() => {
  upstreamFetch.mockReset();
  vi.stubGlobal("fetch", upstreamFetch);
  vi.stubEnv("AUTH_GATEWAY_UPSTREAM_ORIGIN", "http://127.0.0.1:8003");
  vi.stubEnv("AUTH_PUBLIC_ORIGIN", "https://admin.booking.localhost:1355");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Booking Admin auth gateway", () => {
  it("forwards the auth path, query, body, cookies, CSRF, and trusted proxy metadata", async () => {
    upstreamFetch.mockResolvedValue(jsonResponse({ ok: true }));
    const request = new Request(
      "https://admin.booking.localhost:1355/auth/session/refresh?attempt=1",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          cookie: "vayada_fp_workos_session=sealed-session",
          "content-type": "application/json",
          host: "attacker.example",
          origin: "https://admin.booking.localhost:1355",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
          "x-internal-secret": "do-not-forward",
          "x-vayada-csrf": "csrf-token",
        },
        body: JSON.stringify({ surface: "booking-admin" }),
      },
    );

    const response = await POST(request, routeContext("session", "refresh"));

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    const [url, init] = upstreamFetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:8003/auth/session/refresh?attempt=1");
    const headers = new Headers(init.headers);
    expect(headers.get("cookie")).toBe("vayada_fp_workos_session=sealed-session");
    expect(headers.get("origin")).toBe("https://admin.booking.localhost:1355");
    expect(headers.get("x-vayada-csrf")).toBe("csrf-token");
    expect(headers.get("x-forwarded-host")).toBe("admin.booking.localhost:1355");
    expect(headers.get("x-forwarded-proto")).toBe("https");
    expect(headers.get("host")).toBeNull();
    expect(headers.get("x-internal-secret")).toBeNull();
    expect(init.redirect).toBe("manual");
    expect(await new Response(init.body).text()).toBe(JSON.stringify({ surface: "booking-admin" }));
  });

  it("preserves auth response status, cookies, redirects, cache controls, and safe headers", async () => {
    const headers = new Headers({
      "access-control-allow-origin": "https://attacker.example",
      "cache-control": "public, max-age=300, no-cache",
      "content-type": "application/json",
      location: "https://auth.workos.test/authorize",
      server: "internal-api",
      vary: "Accept-Encoding, Origin",
      "www-authenticate": 'Bearer realm="workos"',
      "x-internal-debug": "secret",
      "x-request-id": "request-123",
      "x-workos-session": "secret",
    });
    headers.append("set-cookie", "vayada_fp_workos_session=sealed; Path=/auth; HttpOnly");
    headers.append("set-cookie", "vayada_fp_auth_csrf=csrf; Path=/auth; HttpOnly");
    upstreamFetch.mockResolvedValue(
      new Response(JSON.stringify({ redirected: true }), { status: 302, headers }),
    );

    const response = await GET(
      new Request("https://admin.booking.localhost:1355/auth/oauth/google/start"),
      routeContext("oauth", "google", "start"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://auth.workos.test/authorize");
    expect(response.headers.get("cache-control")).toBe("no-cache, private, no-store");
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin, Cookie");
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="workos"');
    expect(response.headers.get("x-request-id")).toBe("request-123");
    expect(getSetCookies(response.headers)).toEqual([
      "vayada_fp_workos_session=sealed; Path=/auth; HttpOnly",
      "vayada_fp_auth_csrf=csrf; Path=/auth; HttpOnly",
    ]);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("server")).toBeNull();
    expect(response.headers.get("x-internal-debug")).toBeNull();
    expect(response.headers.get("x-workos-session")).toBeNull();
  });

  it("rejects unsafe requests without the exact configured browser origin", async () => {
    for (const origin of [null, "https://attacker.example", "https://admin.booking.localhost"]) {
      const headers = new Headers({ "content-type": "application/json" });
      if (origin) headers.set("origin", origin);
      const response = await POST(
        new Request("https://admin.booking.localhost:1355/auth/password/login", {
          method: "POST",
          headers,
          body: "{}",
        }),
        routeContext("password", "login"),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "origin_rejected" });
    }
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects oversized declared and streamed request bodies before proxying", async () => {
    const headers = {
      "content-type": "application/json",
      origin: "https://admin.booking.localhost:1355",
    };
    const declaredOversized = await POST(
      new Request("https://admin.booking.localhost:1355/auth/password/login", {
        method: "POST",
        headers: { ...headers, "content-length": String(256 * 1024 + 1) },
        body: "{}",
      }),
      routeContext("password", "login"),
    );
    const streamedOversized = await POST(
      new Request("https://admin.booking.localhost:1355/auth/password/login", {
        method: "POST",
        headers,
        body: "x".repeat(256 * 1024 + 1),
      }),
      routeContext("password", "login"),
    );

    expect(declaredOversized.status).toBe(413);
    expect(await declaredOversized.json()).toEqual({ error: "auth_request_too_large" });
    expect(streamedOversized.status).toBe(413);
    expect(await streamedOversized.json()).toEqual({ error: "auth_request_too_large" });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("handles request-body stream failures without invoking the upstream", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("request stream failed"));
      },
    });
    const request = new Request("https://admin.booking.localhost:1355/auth/password/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://admin.booking.localhost:1355",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await POST(request, routeContext("password", "login"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "auth_request_invalid" });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("fails closed for missing configuration and path traversal", async () => {
    vi.stubEnv("AUTH_PUBLIC_ORIGIN", "");
    const missingConfig = await GET(
      new Request("https://admin.booking.localhost/auth/session"),
      routeContext("session"),
    );
    expect(missingConfig.status).toBe(503);

    vi.stubEnv("AUTH_PUBLIC_ORIGIN", "https://admin.booking.localhost:1355");
    const traversal = await GET(
      new Request("https://admin.booking.localhost:1355/auth/../api/private"),
      routeContext("..", "api", "private"),
    );
    expect(traversal.status).toBe(404);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });
});

function routeContext(...path: string[]) {
  return { params: Promise.resolve({ path }) };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function getSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return getSetCookie ? getSetCookie.call(headers) : [];
}
