import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiErrorResponse,
  apiClient,
  setApiBearerTokenProvider,
  setVayadaApiBearerTokenProvider,
  setVayadaApiSessionRecoveryHandlers,
  vayadaApiClient,
} from "@vayada/marketplace-shared/api/client";
import { uploadPlatformMedia } from "@vayada/marketplace-shared/api/platformMedia";
import {
  getConsentStatus,
  getConsentHistory,
  downloadExport,
  getCookieConsent,
} from "@vayada/marketplace-shared/api/privacy";

describe("marketplace shared API token routing", () => {
  beforeEach(() => {
    const storage = createMemoryStorage();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("window", { localStorage: storage, location: { href: "/marketplace" } });
    setApiBearerTokenProvider(() => "legacy-compatibility-token");
    setVayadaApiBearerTokenProvider(() => "workos-access-token");
  });

  afterEach(() => {
    setVayadaApiSessionRecoveryHandlers(null);
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
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ detail: "Unauthorized" }, 401),
    );
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

  it("infers PNG content type when a mobile browser omits it", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/api/media/upload-sessions")) {
        expect(body.files[0].contentType).toBe("image/png");
        return jsonResponse({
          uploadSession: { sessionId: "mobile-session" },
          uploadTargets: [
            {
              uploadTargetId: "mobile-target",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/deterministic",
              headers: {},
            },
          ],
        });
      }
      expect(body.files[0].contentType).toBe("image/png");
      return jsonResponse({ mediaObjects: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await uploadPlatformMedia({
      purpose: "marketplace.creator.profile_image",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: "creator_mobile",
      },
      files: [new File(["qa"], "camera.png", { type: "" })],
    });
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

  it("recovers a cold privacy session once for concurrent status/history requests", async () => {
    let token: string | null = null;
    setVayadaApiBearerTokenProvider(() => token);
    const refresh = vi.fn(async () => {
      await Promise.resolve();
      token = "restored";
    });
    setVayadaApiSessionRecoveryHandlers({ refresh, signOut: vi.fn() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) =>
        new Headers(init?.headers).get("authorization") === "Bearer restored"
          ? jsonResponse({ history: [], total: 0 })
          : jsonResponse({ detail: "Unauthorized" }, 401),
      ),
    );
    await Promise.all([getConsentStatus(), getConsentHistory()]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("bounds rejected-session retry and keeps anonymous cookie reads out of recovery", async () => {
    let token = "expired";
    setVayadaApiBearerTokenProvider(() => token);
    const refresh = vi.fn(async () => {
      token = "refreshed";
    });
    const signOut = vi.fn(async () => {});
    setVayadaApiSessionRecoveryHandlers({ refresh, signOut });
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ detail: "Unauthorized" }, 401),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getConsentStatus()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledTimes(1);
    await expect(getCookieConsent("qa-visitor")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[2]?.[1]?.headers).has("authorization")).toBe(false);
  });

  it("preserves binary export downloads after authenticated recovery", async () => {
    let token: string | null = null;
    setVayadaApiBearerTokenProvider(() => token);
    setVayadaApiSessionRecoveryHandlers({
      refresh: async () => {
        token = "restored";
      },
      signOut: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) =>
        new Headers(init?.headers).get("authorization") === "Bearer restored"
          ? new Response(new Uint8Array([0, 255, 17]), {
              headers: { "content-type": "application/zip" },
            })
          : jsonResponse({ detail: "Unauthorized" }, 401),
      ),
    );
    const blob = await downloadExport("synthetic-download-token");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0, 255, 17]));
  });

  it("preserves empty and text privacy errors as typed failures", async () => {
    for (const body of ["", "temporarily unavailable"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 503 })),
      );
      await expect(getConsentStatus()).rejects.toMatchObject({ status: 503 });
    }
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
