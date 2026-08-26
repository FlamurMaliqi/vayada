import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth/sessionStore", () => ({
  clearAuthData: vi.fn(),
  getAuthBearerToken: vi.fn(() => "admin-token"),
}));

import { ApiClient } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiClient request headers", () => {
  it("does not label a bodyless DELETE as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await new ApiClient("https://api.example.test").delete("/api/identity/admin/users/user-1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(headers.has("Content-Type")).toBe(false);
    expect(headers.get("Authorization")).toBe("Bearer admin-token");
  });

  it("keeps JSON headers for requests with a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await new ApiClient("https://api.example.test").post("/api/users", { name: "Smoke" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "Smoke" }));
  });

  it("preserves an explicitly supplied content type", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await new ApiClient("https://api.example.test").delete("/api/identity/admin/users/user-1", {
      headers: { "Content-Type": "application/json" },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("preserves the API message for non-detail errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            statusCode: 400,
            error: "Bad Request",
            message: "Body cannot be empty when content-type is set to 'application/json'",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    await expect(
      new ApiClient("https://api.example.test").delete("/api/identity/admin/users/user-1"),
    ).rejects.toMatchObject({
      status: 400,
      message: "Body cannot be empty when content-type is set to 'application/json'",
    });
  });

  it("recognizes an expired token from the API message field", async () => {
    const windowStub = { location: { href: "" } };
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "Token expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(new ApiClient("https://api.example.test").get("/api/users")).rejects.toMatchObject(
      {
        status: 401,
        message: "Token expired",
      },
    );
    expect(windowStub.location.href).toBe("/login?expired=true");
  });
});
