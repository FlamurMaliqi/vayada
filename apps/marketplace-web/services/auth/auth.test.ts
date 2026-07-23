import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthStateError,
  authService,
  clearPendingEmailVerification,
  getPendingEmailVerification,
  storePendingEmailVerification,
} from "./auth";
import {
  clearAuthData,
  getAuthBearerToken,
  getAuthCsrfToken,
  isAuthOrganizationSelectionResponse,
  setAuthKitSession,
  setLegacyCompatibilityToken,
} from "./sessionStore";
import { sharedHotelSetupApi } from "../api/sharedHotelSetupClient";
import { targetApiClient } from "../api/targetClient";
import { apiClient } from "../api/client";
import { getMyMarketplaceCollaborations } from "@vayada/marketplace-shared/api/collaborations";
import { uploadPlatformMedia } from "@vayada/marketplace-shared/api/platformMedia";

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

  it("uses the AuthKit token for shared hotel setup requests", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    setAuthKitSession({
      accessToken: "hotel-workos-access-token",
      csrfToken: "hotel-csrf-token",
      organizationKind: "hotel_group",
      user: { id: "user_hotel", email: "hotel@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("legacy-marketplace-token", 900);
    expect(getAuthBearerToken()).toBe("legacy-marketplace-token");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://api.localhost/api/hotel-setup/status?entryProduct=marketplace",
        );
        expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
          "Bearer hotel-workos-access-token",
        );
        return jsonResponse({ contractVersion: "shared-hotel-setup-status.v1" });
      }),
    );

    await sharedHotelSetupApi.getStatus({ entryProduct: "marketplace" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the AuthKit token for target Marketplace requests", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    setAuthKitSession({
      accessToken: "hotel-workos-access-token",
      organizationKind: "hotel_group",
      user: { id: "user_hotel", email: "hotel@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("legacy-marketplace-token", 900);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://api.localhost/api/marketplace/collaborations/me?side=hotel",
        );
        expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
          "Bearer hotel-workos-access-token",
        );
        return jsonResponse({
          contractVersion: "marketplace-collaboration-reads.v1",
          authorizationMode: "hotel_group_resource_link",
          items: [],
        });
      }),
    );

    await getMyMarketplaceCollaborations({ side: "hotel" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never sends an AuthKit access token to the legacy Marketplace API", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "false");
    setAuthKitSession({
      accessToken: "workos-access-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.marketplace.localhost/public-bootstrap");
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
        return jsonResponse({ ok: true });
      }),
    );

    await expect(apiClient.get("/public-bootstrap")).resolves.toEqual({ ok: true });
  });

  it("shares one refresh while each actual client retries with its own token family", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    setAuthKitSession({
      accessToken: "expired-across-clients",
      csrfToken: "expired-csrf-token",
      organizationKind: "creator_workspace",
      user: { id: "user_creator", email: "creator@example.com", status: "active" },
    });
    setLegacyCompatibilityToken("expired-legacy-token", 900);
    let sessionRefreshes = 0;
    let compatibilityRefreshes = 0;
    const requests: Array<{ href: string; token: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href === "https://api.localhost/auth/session?surface=marketplace-web") {
          sessionRefreshes += 1;
          return jsonResponse({
            accessToken: "fresh-across-clients",
            csrfToken: "fresh-csrf-token",
            organizationKind: "creator_workspace",
            user: { id: "user_creator", email: "creator@example.com", status: "active" },
          });
        }
        if (href === "https://api.localhost/auth/compat/marketplace-web-token") {
          compatibilityRefreshes += 1;
          expect(new Headers(init?.headers).get("x-vayada-csrf")).toBe("fresh-csrf-token");
          return jsonResponse({ accessToken: "fresh-legacy-token", expiresIn: 900 });
        }

        const token = new Headers(init?.headers).get("Authorization");
        requests.push({ href, token });
        if (token === "Bearer expired-across-clients" || token === "Bearer expired-legacy-token") {
          return jsonResponse({ detail: "expired" }, 401);
        }
        if (href === "https://api.localhost/api/media/upload-sessions") {
          return jsonResponse({
            uploadSession: { sessionId: "upload-session" },
            uploadTargets: [
              {
                uploadTargetId: "upload-target",
                clientFileId: "file_1",
                method: "PUT",
                uploadUrl: "https://uploads.vayada.localhost/upload-target",
                headers: { "content-type": "image/jpeg" },
              },
            ],
          });
        }
        if (href.endsWith("/api/media/upload-sessions/upload-session/finalize")) {
          return jsonResponse({
            mediaObjects: [
              {
                mediaId: "media-001",
                storageKey: "media/offer.jpg",
                contentType: "image/jpeg",
                sizeBytes: 5,
                originalFilename: "offer.jpg",
                variants: [{ publicCdnUrl: "https://cdn.example/offer.jpg", storageKey: "x" }],
              },
            ],
          });
        }
        if (href.includes("/api/hotel-setup/status")) {
          return jsonResponse({ contractVersion: "shared-hotel-setup-status.v1" });
        }
        if (href.includes("/api/marketplace/collaborations/me")) {
          return jsonResponse({
            contractVersion: "marketplace-collaboration-reads.v1",
            authorizationMode: "creator_workspace_resource_link",
            items: [],
          });
        }
        return jsonResponse({ ok: true });
      }),
    );

    const [, , , , uploaded] = await Promise.all([
      targetApiClient.get("/api/target-bootstrap"),
      sharedHotelSetupApi.getStatus({ entryProduct: "marketplace" }),
      getMyMarketplaceCollaborations({ side: "creator" }),
      apiClient.get("/legacy-bootstrap"),
      uploadPlatformMedia({
        purpose: "marketplace.offer.media",
        resource: {
          product: "marketplace",
          resourceType: "marketplace_offer",
          resourceId: "offer-001",
        },
        files: [new File(["photo"], "offer.jpg", { type: "image/jpeg" })],
      }),
    ]);

    expect(sessionRefreshes).toBe(1);
    expect(compatibilityRefreshes).toBe(1);
    expect(uploaded).toEqual([
      expect.objectContaining({ mediaId: "media-001", url: "https://cdn.example/offer.jpg" }),
    ]);
    expect(requests.filter(({ token }) => token === "Bearer expired-across-clients")).toHaveLength(
      4,
    );
    expect(requests.filter(({ token }) => token === "Bearer fresh-across-clients")).toHaveLength(5);
    expect(requests.filter(({ token }) => token === "Bearer expired-legacy-token")).toHaveLength(1);
    expect(requests.filter(({ token }) => token === "Bearer fresh-legacy-token")).toHaveLength(1);
    expect(
      requests
        .filter(({ href }) => href.startsWith("https://api.marketplace.localhost"))
        .map(({ token }) => token),
    ).toEqual(["Bearer expired-legacy-token", "Bearer fresh-legacy-token"]);
    expect(
      requests.some(
        ({ href, token }) =>
          href.startsWith("https://api.marketplace.localhost") &&
          token === "Bearer fresh-across-clients",
      ),
    ).toBe(false);
  });

  it("shares one cold-session check across concurrent target requests", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "false");
    const sessionStarted = Promise.withResolvers<void>();
    const sessionResponse = Promise.withResolvers<Response>();
    let sessionRequests = 0;
    let targetRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href === "https://api.localhost/auth/session?surface=marketplace-web") {
          sessionRequests += 1;
          sessionStarted.resolve();
          return sessionResponse.promise;
        }
        targetRequests += 1;
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer fresh-cold-session-token",
        );
        return jsonResponse({ ok: true });
      }),
    );

    const first = targetApiClient.get<{ ok: boolean }>("/api/cold-one");
    const second = targetApiClient.get<{ ok: boolean }>("/api/cold-two");
    await sessionStarted.promise;
    sessionResponse.resolve(
      jsonResponse({
        accessToken: "fresh-cold-session-token",
        organizationKind: "creator_workspace",
        user: { id: "user_creator", email: "creator@example.com", status: "active" },
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(sessionRequests).toBe(1);
    expect(targetRequests).toBe(2);
  });

  it("does not let an aborted cold-session owner sign out or poison another request", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "false");
    const firstSessionStarted = Promise.withResolvers<void>();
    const controller = new AbortController();
    let sessionRequests = 0;
    let logoutRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const href = String(url);
        if (href === "https://api.localhost/auth/session?surface=marketplace-web") {
          sessionRequests += 1;
          if (sessionRequests === 1) {
            firstSessionStarted.resolve();
            return new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              const rejectAborted = () =>
                reject(
                  signal?.reason ?? new DOMException("The operation was aborted", "AbortError"),
                );
              if (signal?.aborted) rejectAborted();
              else signal?.addEventListener("abort", rejectAborted, { once: true });
            });
          }
          return jsonResponse({
            accessToken: "fresh-after-abort",
            organizationKind: "creator_workspace",
            user: { id: "user_creator", email: "creator@example.com", status: "active" },
          });
        }
        if (href === "https://api.localhost/auth/logout") {
          logoutRequests += 1;
          return jsonResponse({ logoutUrl: "/login" });
        }
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fresh-after-abort");
        return jsonResponse({ ok: true });
      }),
    );

    const owner = targetApiClient.get("/api/aborted-owner", { signal: controller.signal });
    await firstSessionStarted.promise;
    const waitingRequest = targetApiClient.get<{ ok: boolean }>("/api/waiting-request");
    controller.abort(new DOMException("The operation was aborted", "AbortError"));

    await expect(owner).rejects.toMatchObject({ name: "AbortError" });
    await expect(waitingRequest).resolves.toEqual({ ok: true });
    expect(sessionRequests).toBe(2);
    expect(logoutRequests).toBe(0);
  });

  it("keeps the AuthKit session when compatibility token loading is canceled", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    mockBrowserStorage();
    const controller = new AbortController();
    let compatibilityAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url) === "https://api.localhost/auth/session?surface=marketplace-web") {
          return jsonResponse({
            accessToken: "workos-access-token",
            csrfToken: "csrf-token",
            organizationKind: "creator_workspace",
            user: { id: "user_creator", email: "creator@example.com", status: "active" },
          });
        }
        compatibilityAttempts += 1;
        if (compatibilityAttempts === 1) {
          controller.abort();
          throw new DOMException("The operation was aborted", "AbortError");
        }
        return jsonResponse({ accessToken: "legacy-marketplace-token", expiresIn: 900 });
      }),
    );

    await expect(authService.ensureSession(controller.signal)).resolves.toBe(true);
    expect(getAuthBearerToken()).toBe("workos-access-token");

    await expect(authService.ensureSession()).resolves.toBe(true);

    expect(compatibilityAttempts).toBe(1);
    expect(getAuthBearerToken()).toBe("workos-access-token");
  });
});

describe("authService", () => {
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
        organizationKind: "hotel_group",
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

  it("preserves a session committed by a concurrent session check", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "false");
    const firstRequest = Promise.withResolvers<Response>();
    fetchMock.mockReturnValueOnce(firstRequest.promise).mockResolvedValueOnce(
      jsonResponse({
        accessToken: "concurrent-workos-access-token",
        user: { id: "user_creator", email: "creator@example.test", status: "active" },
      }),
    );

    const failingCheck = authService.ensureSession();
    await expect(authService.ensureSession()).resolves.toBe(true);
    firstRequest.reject(new Error("request failed"));

    await expect(failingCheck).resolves.toBe(false);
    expect(getAuthBearerToken()).toBe("concurrent-workos-access-token");
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

  it("preserves verification-required auth state for the verification page", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          state: "email_verification_required",
          message: "Verify your email address to continue.",
          pendingAuthenticationToken: "pending-email-token",
          email: "creator@example.test",
          emailVerificationId: "email_verification_123",
        },
        403,
      ),
    );

    let thrown: unknown;
    try {
      await authService.login({
        email: "creator@example.test",
        password: "correct-password",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthStateError);
    expect(thrown).toMatchObject({
      state: "email_verification_required",
      pendingAuthenticationToken: "pending-email-token",
      emailVerificationId: "email_verification_123",
    });
  });

  it("posts account signup credentials to the backend and stores the AuthKit session", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "signup-workos-access-token",
        csrfToken: "signup-csrf-token",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
          workosUserId: "user_workos_creator",
        },
      }),
    );

    const response = await authService.signup({
      email: "creator@example.test",
      password: "correct-password",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/password/signup",
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
    expect(getAuthBearerToken()).toBe("signup-workos-access-token");
    expect(getAuthCsrfToken()).toBe("signup-csrf-token");
    expect(isAuthOrganizationSelectionResponse(response)).toBe(false);
  });

  it("keeps the current portless fallback port for signup requests", async () => {
    const localStorage = createStorageMock();
    vi.stubGlobal("window", {
      location: {
        protocol: "https:",
        port: "1355",
      },
      localStorage,
    });
    vi.stubGlobal("localStorage", localStorage);
    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "signup-workos-access-token",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
        },
      }),
    );

    await authService.signup({
      email: "creator@example.test",
      password: "correct-password",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost:1355/auth/password/signup",
      expect.any(Object),
    );
  });

  it("starts Google login through the AuthKit backend", () => {
    const location = {
      href: "https://marketplace.localhost/login",
      origin: "https://marketplace.localhost",
    };
    const localStorage = createStorageMock();
    vi.stubGlobal("window", {
      location,
      localStorage,
    });
    vi.stubGlobal("localStorage", localStorage);

    authService.startGoogleLogin("/marketplace");

    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.localhost/auth/oauth/google/start");
    expect(url.searchParams.get("surface")).toBe("marketplace-web");
    expect(url.searchParams.get("flow")).toBe("login");
    expect(url.searchParams.get("return_to")).toBe(
      "https://marketplace.localhost/login?auth=callback&returnTo=%2Fmarketplace",
    );
    expect(url.searchParams.get("error_return_to")).toBe("https://marketplace.localhost/login");
  });

  it("starts Google signup for the onboarding flow", () => {
    const location = {
      href: "https://marketplace.localhost/signup",
      origin: "https://marketplace.localhost",
    };
    const localStorage = createStorageMock();
    vi.stubGlobal("window", {
      location,
      localStorage,
    });
    vi.stubGlobal("localStorage", localStorage);

    authService.startGoogleSignup("/onboarding");

    const url = new URL(location.href);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.localhost/auth/oauth/google/start");
    expect(url.searchParams.get("surface")).toBe("marketplace-web");
    expect(url.searchParams.get("flow")).toBe("signup");
    expect(url.searchParams.get("type")).toBeNull();
    expect(url.searchParams.get("return_to")).toBe(
      "https://marketplace.localhost/login?auth=callback&returnTo=%2Fonboarding",
    );
    expect(url.searchParams.get("error_return_to")).toBe("https://marketplace.localhost/signup");
  });

  it("requests password reset through the AuthKit backend", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        message: "If an account with that email exists, a password reset link has been sent.",
      }),
    );

    await expect(authService.forgotPassword("creator@example.test")).resolves.toEqual({
      message: "If an account with that email exists, a password reset link has been sent.",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/password/reset/request",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          email: "creator@example.test",
        }),
      }),
    );
  });

  it("confirms password reset through the AuthKit backend", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        message: "Password reset successful. Please sign in with your new password.",
      }),
    );

    await expect(authService.resetPassword("reset-token", "new-secure-password")).resolves.toEqual({
      message: "Password reset successful. Please sign in with your new password.",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/password/reset/confirm",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          token: "reset-token",
          newPassword: "new-secure-password",
        }),
      }),
    );
  });

  it("uses pending verification state to confirm email and store the AuthKit session", async () => {
    mockBrowserStorage();
    expect(
      storePendingEmailVerification({
        pendingAuthenticationToken: "pending-email-token",
        email: "creator@example.test",
        emailVerificationId: "email_verification_123",
        flow: "signup",
      }),
    ).toBe(true);
    expect(getPendingEmailVerification()).toMatchObject({
      pendingAuthenticationToken: "pending-email-token",
      flow: "signup",
    });

    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "verified-workos-access-token",
        csrfToken: "verified-csrf-token",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
          workosUserId: "user_workos_creator",
        },
      }),
    );

    await expect(authService.confirmEmailVerification("123456")).resolves.toMatchObject({
      accessToken: "verified-workos-access-token",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/email-verification/confirm",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          pendingAuthenticationToken: "pending-email-token",
          code: "123456",
          flow: "signup",
          surface: "marketplace-web",
        }),
      }),
    );
    expect(getAuthBearerToken()).toBe("verified-workos-access-token");
    expect(getAuthCsrfToken()).toBe("verified-csrf-token");
    expect(getPendingEmailVerification()).toBeNull();
  });

  it("keeps a verified AuthKit session when the optional compatibility exchange fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_AUTHKIT_COMPATIBILITY_TOKEN_ENABLED", "true");
    mockBrowserStorage();
    storePendingEmailVerification({
      pendingAuthenticationToken: "pending-email-token",
      email: "creator@example.test",
      emailVerificationId: "email_verification_123",
      flow: "signup",
    });
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          accessToken: "verified-workos-access-token",
          csrfToken: "verified-csrf-token",
          user: {
            id: "user_creator",
            email: "creator@example.test",
            status: "active",
            workosUserId: "user_workos_creator",
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "compatibility_unavailable" }, 503));

    await expect(authService.confirmEmailVerification("123456")).resolves.toMatchObject({
      accessToken: "verified-workos-access-token",
    });
    expect(getAuthBearerToken()).toBe("verified-workos-access-token");
    expect(getPendingEmailVerification()).toBeNull();
  });

  it("completes hotel onboarding from account type alone", async () => {
    setAuthKitSession({
      accessToken: "signup-workos-access-token",
      csrfToken: "signup-csrf-token",
      user: { id: "user_creator", email: "creator@example.test", status: "active" },
    });
    fetchMock.mockResolvedValue(
      jsonResponse({
        accessToken: "creator-workos-access-token",
        csrfToken: "creator-csrf-token",
        organizationId: "org_creator",
        organizationKind: "hotel_group",
        user: {
          id: "user_creator",
          email: "creator@example.test",
          status: "active",
          workosUserId: "user_workos_creator",
        },
      }),
    );

    await expect(authService.completeOnboarding("hotel")).resolves.toMatchObject({
      organizationKind: "hotel_group",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.localhost/auth/onboarding",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          "x-vayada-csrf": "signup-csrf-token",
        }),
        body: JSON.stringify({
          type: "hotel",
          surface: "marketplace-web",
        }),
      }),
    );
    expect(getAuthBearerToken()).toBe("creator-workos-access-token");
    expect(getAuthCsrfToken()).toBe("creator-csrf-token");
  });

  it("falls back when pending verification storage is blocked", () => {
    mockBrowserStorage();
    vi.mocked(window.sessionStorage.setItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(window.sessionStorage.getItem).mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(window.sessionStorage.removeItem).mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(
      storePendingEmailVerification({
        pendingAuthenticationToken: "pending-email-token",
        email: "creator@example.test",
      }),
    ).toBe(false);
    expect(getPendingEmailVerification()).toBeNull();
    expect(() => clearPendingEmailVerification()).not.toThrow();
  });

  it("surfaces controlled invalid reset token errors", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          state: "auth_failed",
          message: "Invalid or expired reset token. Please request a new password reset link.",
        },
        400,
      ),
    );

    await expect(authService.resetPassword("expired-token", "new-secure-password")).rejects.toThrow(
      "Invalid or expired reset token. Please request a new password reset link.",
    );
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

function mockBrowserStorage() {
  const sessionStorage = createStorageMock();
  const localStorage = createStorageMock();
  vi.stubGlobal("window", { sessionStorage, localStorage });
  vi.stubGlobal("sessionStorage", sessionStorage);
  vi.stubGlobal("localStorage", localStorage);
}

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    length: 0,
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
  };
}
