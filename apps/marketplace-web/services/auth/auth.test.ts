import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authService } from "./auth";
import {
  clearAuthData,
  getAuthBearerToken,
  getAuthCsrfToken,
  isAuthOrganizationSelectionResponse,
  setAuthKitSession,
  setLegacyCompatibilityToken,
} from "./sessionStore";

const fetchMock = vi.fn();

afterEach(() => {
  clearAuthData();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("marketplace AuthKit compatibility token", () => {
  it("prefers the marketplace compatibility token after session refresh", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
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
      }),
    );

    await authService.refreshSession();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getAuthBearerToken()).toBe("legacy-marketplace-token");
  });

  it("clears stale compatibility tokens when the AuthKit session changes", () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    setAuthKitSession({
      accessToken: "old-workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("legacy-marketplace-token", 900);

    expect(getAuthBearerToken()).toBe("legacy-marketplace-token");

    setAuthKitSession({
      accessToken: "new-workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });

    expect(getAuthBearerToken()).toBe("new-workos-access-token");
  });
});

describe("authService.login", () => {
  beforeEach(() => {
    clearAuthData();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("posts credentials to the backend password endpoint and stores the AuthKit session", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "workos-access-token",
        csrfToken: "csrf-token",
        organizationId: "org_creator",
        organizationKind: "creator_workspace",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
          workosUserId: "user_workos_creator",
        },
      }),
    );

    const response = await authService.login({
      email: "creator@example.test",
      password: "correct-password",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/password/login",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          email: "creator@example.test",
          password: "correct-password",
          surface: "marketplace-web",
        }),
      }),
    );
    expect(getAuthBearerToken()).toBe("workos-access-token");
    expect(getAuthCsrfToken()).toBe("csrf-token");
    expect(isAuthOrganizationSelectionResponse(response)).toBe(false);
  });

  it("preserves controlled backend login errors", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          state: "invalid_credentials",
          message: "Email or password is incorrect.",
        },
        401,
      ),
    );

    await expect(
      authService.login({
        email: "creator@example.test",
        password: "wrong-password",
      }),
    ).rejects.toThrow("Email or password is incorrect.");
  });

  it("keeps pending organization selection state from password login", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        organizationSelectionRequired: true,
        csrfToken: "pending-csrf-token",
        organizations: [
          {
            organizationId: "org_creator",
            workosOrganizationId: "org_workos_creator",
            displayName: "Creator Workspace",
            kind: "creator_workspace",
          },
        ],
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
          workosUserId: "user_workos_creator",
        },
      }),
    );

    const response = await authService.login({
      email: "creator@example.test",
      password: "correct-password",
    });

    expect(isAuthOrganizationSelectionResponse(response)).toBe(true);
    expect(getAuthBearerToken()).toBeNull();
    expect(getAuthCsrfToken()).toBe("pending-csrf-token");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
