import { afterEach, describe, expect, it, vi } from "vitest";

type StoredValue = string | null;

describe("uploadImages", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("uses the explicitly captured Booking hotel for platform media uploads", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://next-api.vayada.com");
    const window = createWindowWithStorage();
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", window.localStorage);

    const { setAuthKitSession } = await import("@/services/auth/sessionStore");
    const { uploadImages } = await import("./uploadImage");
    setAuthKitSession({
      accessToken: "authkit-token",
      resources: {
        "booking:booking_hotel": ["booking_hotel_alpenrose", "booking_hotel_bergwald"],
      },
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });
    window.localStorage.setItem("selectedHotelId", "booking_hotel_alpenrose");

    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer authkit-token");
      if (url === "https://next-api.vayada.com/api/media/upload-sessions") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          purpose: "property.hero_image",
          expectedProfileRevision: 7,
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_bergwald",
          },
        });
        return jsonResponse({
          uploadSession: { sessionId: "session_1" },
          uploadTargets: [
            {
              uploadTargetId: "target_1",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/target_1",
              headers: { "content-type": "image/jpeg" },
            },
          ],
        });
      }
      expect(url).toBe("https://next-api.vayada.com/api/media/upload-sessions/session_1/finalize");
      return jsonResponse({
        mediaObjects: [
          {
            storageKey: "media/room.jpg",
            variants: [{ publicCdnUrl: "https://cdn.vayada.com/media/room.jpg" }],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      uploadImages(
        new File(["image"], "room.jpg", { type: "image/jpeg" }),
        "property.hero_image",
        "booking_hotel_bergwald",
        7,
      ),
    ).resolves.toEqual(["https://cdn.vayada.com/media/room.jpg"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("requires an editor-loaded profile revision for hero image uploads", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://next-api.vayada.com");
    const { setAuthKitSession } = await import("@/services/auth/sessionStore");
    const { uploadSingleImage } = await import("./uploadImage");
    setAuthKitSession({
      accessToken: "authkit-token",
      resources: { "booking:booking_hotel": ["booking_hotel_alpenrose"] },
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      uploadSingleImage(
        new File(["image"], "hero.jpg", { type: "image/jpeg" }),
        "property.hero_image",
        "booking_hotel_alpenrose",
      ),
    ).rejects.toThrow("valid property profile revision is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send a profile revision for gallery image uploads", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://next-api.vayada.com");
    const window = createWindowWithStorage();
    vi.stubGlobal("window", window);
    vi.stubGlobal("localStorage", window.localStorage);

    const { setAuthKitSession } = await import("@/services/auth/sessionStore");
    const { uploadImages } = await import("./uploadImage");
    setAuthKitSession({
      accessToken: "authkit-token",
      resources: { "booking:booking_hotel": ["booking_hotel_alpenrose"] },
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });

    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/media/upload-sessions")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          purpose: "property.gallery_image",
          visibility: "public",
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
          },
          files: [
            {
              clientFileId: "file_1",
              filename: "room.jpg",
              contentType: "image/jpeg",
              sizeBytes: 5,
            },
          ],
        });
        return jsonResponse({
          uploadSession: { sessionId: "session_1" },
          uploadTargets: [
            {
              uploadTargetId: "target_1",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/target_1",
              headers: {},
            },
          ],
        });
      }
      return jsonResponse({
        mediaObjects: [
          {
            variants: [{ publicCdnUrl: "https://cdn.vayada.com/media/room.jpg" }],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      uploadImages(
        new File(["image"], "room.jpg", { type: "image/jpeg" }),
        "property.gallery_image",
        "booking_hotel_alpenrose",
        99,
      ),
    ).resolves.toEqual(["https://cdn.vayada.com/media/room.jpg"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uploads a Booking-owned SVG header logo without a Catalog profile revision", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://next-api.vayada.com");
    const { setAuthKitSession } = await import("@/services/auth/sessionStore");
    const { uploadSingleImage } = await import("./uploadImage");
    setAuthKitSession({
      accessToken: "authkit-token",
      resources: { "booking:booking_hotel": ["booking_hotel_alpenrose"] },
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });

    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/media/upload-sessions")) {
        expect(JSON.parse(String(init?.body))).toEqual({
          purpose: "booking.header_logo",
          visibility: "public",
          resource: {
            product: "booking",
            resourceType: "booking_hotel",
            resourceId: "booking_hotel_alpenrose",
          },
          files: [
            {
              clientFileId: "file_1",
              filename: "wordmark.svg",
              contentType: "image/svg+xml",
              sizeBytes: 6,
            },
          ],
        });
        return jsonResponse({
          uploadSession: { sessionId: "header_logo_session" },
          uploadTargets: [
            {
              uploadTargetId: "header_logo_target",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.vayada.localhost/header_logo_target",
              headers: { "content-type": "image/svg+xml" },
            },
          ],
        });
      }
      expect(url).toContain("/header_logo_session/finalize");
      return jsonResponse({
        mediaObjects: [
          {
            variants: [
              { publicCdnUrl: "https://cdn.vayada.com/media/header-logo/original_safe.webp" },
            ],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      uploadSingleImage(
        new File(["<svg/>"], "wordmark.svg"),
        "booking.header_logo",
        "booking_hotel_alpenrose",
      ),
    ).resolves.toBe("https://cdn.vayada.com/media/header-logo/original_safe.webp");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects a finalized image that has no public HTTPS URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://next-api.vayada.com");
    const { setAuthKitSession } = await import("@/services/auth/sessionStore");
    const { uploadSingleImage } = await import("./uploadImage");
    setAuthKitSession({
      accessToken: "authkit-token",
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/finalize")
          ? jsonResponse({ mediaObjects: [{ storageKey: "media/hero.jpg", variants: [] }] })
          : jsonResponse({
              uploadSession: { sessionId: "session_1" },
              uploadTargets: [
                {
                  uploadTargetId: "target_1",
                  clientFileId: "file_1",
                  method: "PUT",
                  uploadUrl: "https://uploads.vayada.localhost/target_1",
                  headers: {},
                },
              ],
            }),
      ),
    );

    await expect(
      uploadSingleImage(
        new File(["image"], "hero.jpg", { type: "image/jpeg" }),
        "property.hero_image",
        undefined,
        3,
      ),
    ).rejects.toThrow("did not return a public HTTPS image URL");
  });

  it("rejects an explicit Booking hotel outside the active organization scope", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://next-api.vayada.com");
    const { setAuthKitSession } = await import("@/services/auth/sessionStore");
    const { uploadSingleImage } = await import("./uploadImage");
    setAuthKitSession({
      accessToken: "authkit-token",
      resources: { "booking:booking_hotel": ["booking_hotel_alpenrose"] },
      user: { id: "user_1", email: "owner@example.com", status: "active" },
    });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      uploadSingleImage(
        new File(["image"], "hero.jpg", { type: "image/jpeg" }),
        "property.hero_image",
        "booking_hotel_bergwald",
        2,
      ),
    ).rejects.toThrow("outside the active organization scope");
    expect(fetch).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createWindowWithStorage(): Window {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (key: string): StoredValue => storage.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storage.set(key, value);
    },
    removeItem: (key: string): void => {
      storage.delete(key);
    },
  };

  return { localStorage } as Window;
}
