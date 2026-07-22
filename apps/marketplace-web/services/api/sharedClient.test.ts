import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorResponse,
  apiClient,
  setApiBearerTokenProvider,
  setVayadaApiBearerTokenProvider,
  vayadaApiClient,
} from "@vayada/marketplace-shared/api/client";
import { uploadPlatformMedia } from "@vayada/marketplace-shared/api/platformMedia";
import { getConsentStatus } from "@vayada/marketplace-shared/api/privacy";

describe("marketplace shared API token routing", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage, location: { href: "/marketplace" } });
    setApiBearerTokenProvider(() => "legacy-compatibility-token");
    setVayadaApiBearerTokenProvider(() => "workos-access-token");
  });

  afterEach(() => {
    setApiBearerTokenProvider(null);
    setVayadaApiBearerTokenProvider(null);
    vi.unstubAllGlobals();
  });

  it("keeps the compatibility JWT on legacy routes and the WorkOS token on Vayada routes", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await apiClient.get("/api/hotels/me");
    await vayadaApiClient.get("/api/marketplace/collaborations");

    expect(requestAuthorization(fetchMock, 0)).toBe("Bearer legacy-compatibility-token");
    expect(requestAuthorization(fetchMock, 1)).toBe("Bearer workos-access-token");
  });

  it("does not clear or redirect the browser when a Vayada route returns 401", async () => {
    localStorage.setItem("access_token", "legacy-compatibility-token");
    localStorage.setItem("token_expires_at", String(Date.now() + 60_000));
    const fetchMock = vi.fn(async () => jsonResponse({ detail: "Unauthorized" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(vayadaApiClient.get("/api/marketplace/collaborations")).rejects.toBeInstanceOf(
      ApiErrorResponse,
    );

    expect(localStorage.getItem("access_token")).toBe("legacy-compatibility-token");
    expect(window.location.href).toBe("/marketplace");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the WorkOS provider and retries required profile-media calls once after 401", async () => {
    let accessToken = "stale-workos-token";
    setVayadaApiBearerTokenProvider((_signal, forceRefresh) => {
      if (forceRefresh) accessToken = "fresh-workos-token";
      return accessToken;
    });
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const href = String(url);
        const authorization = new Headers(init?.headers).get("authorization");
        if (
          href.endsWith("/api/media/upload-sessions") &&
          authorization !== "Bearer fresh-workos-token"
        ) {
          return jsonResponse({ detail: "Unauthorized" }, 401);
        }
        if (href.endsWith("/api/media/upload-sessions")) {
          return jsonResponse({
            uploadSession: { sessionId: "session_qa" },
            uploadTargets: [
              {
                uploadTargetId: "target_qa",
                clientFileId: "file_1",
                method: "PUT",
                uploadUrl: "https://uploads.vayada.localhost/deterministic",
                headers: {},
              },
            ],
          });
        }
        if (href.endsWith("/api/media/upload-sessions/session_qa/finalize")) {
          expect(authorization).toBe("Bearer fresh-workos-token");
          return jsonResponse({
            mediaObjects: [
              {
                mediaId: "media_qa",
                storageKey: "creator/media_qa.png",
                contentType: "image/png",
                sizeBytes: 2,
                originalFilename: "avatar.png",
                variants: [
                  {
                    publicCdnUrl: "https://cdn.example.test/avatar.png",
                    storageKey: "creator/media_qa.png",
                  },
                ],
              },
            ],
          });
        }
        throw new Error(`Unexpected fetch: ${href}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadPlatformMedia({
        purpose: "identity.user.profile_image",
        resource: { product: "platform", resourceType: "user_profile", resourceId: "user_qa" },
        files: [new File(["qa"], "avatar.png", { type: "image/png" })],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        mediaId: "media_qa",
        url: "https://cdn.example.test/avatar.png",
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes the WorkOS token before retrying an identity privacy request", async () => {
    let accessToken = "stale-workos-token";
    setVayadaApiBearerTokenProvider((_signal, forceRefresh) => {
      if (forceRefresh) accessToken = "fresh-workos-token";
      return accessToken;
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer fresh-workos-token"
        ? jsonResponse({ consent: null })
        : jsonResponse({ detail: "Unauthorized" }, 401);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConsentStatus()).resolves.toEqual({ consent: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves typed Vayada error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            code: "invalid_transition",
            category: "conflict",
            message: "An active collaboration already exists for this offer.",
          },
          409,
        ),
      ),
    );

    await expect(vayadaApiClient.post("/api/marketplace/collaborations", {})).rejects.toThrow(
      "An active collaboration already exists for this offer.",
    );
  });

  it("keeps the existing sign-in redirect for legacy-route 401 responses", async () => {
    localStorage.setItem("access_token", "legacy-compatibility-token");
    localStorage.setItem("token_expires_at", String(Date.now() + 60_000));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ detail: "Unauthorized" }, 401)),
    );

    await expect(apiClient.get("/api/hotels/me")).rejects.toBeInstanceOf(ApiErrorResponse);

    expect(localStorage.getItem("access_token")).toBeNull();
    expect(window.location.href).toBe("/login");
  });
});

function requestAuthorization(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex: number,
): string | null {
  const requestInit = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return new Headers(requestInit?.headers).get("authorization");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
