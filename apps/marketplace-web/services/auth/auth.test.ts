import { afterEach, describe, expect, it, vi } from "vitest";

import { authService } from "./auth";
import { clearAuthData, getAuthBearerToken } from "./sessionStore";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    json: async () => body,
  } as Response;
}

describe("marketplace AuthKit compatibility token", () => {
  afterEach(() => {
    clearAuthData();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("prefers the marketplace compatibility token after session refresh", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://api.localhost/auth/session?surface=marketplace-web") {
        return jsonResponse({
          accessToken: "workos-access-token",
          csrfToken: "csrf-token",
          organizationKind: "creator_workspace",
          user: { id: "user_creator", email: "creator@example.com", status: "active" },
        });
      }
      if (href === "https://api.localhost/auth/compat/marketplace-web-token") {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>)["x-vayada-csrf"]).toBe("csrf-token");
        return jsonResponse({ accessToken: "legacy-marketplace-token", expiresIn: 900 });
      }
      throw new Error(`Unexpected fetch: ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await authService.refreshSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getAuthBearerToken()).toBe("legacy-marketplace-token");
  });
});
