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

  it("uploads gallery photos against the canonical property and returns media object IDs", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://next-api.vayada.com");
    const propertyId = "55555555-5555-4555-8555-555555555552";
    const mediaObjectId = "66666666-6666-4666-8666-666666666663";
    const { uploadPropertyGalleryImages } = await import("./uploadImage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/api/media/upload-sessions")) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            purpose: "property.gallery_image",
            visibility: "private",
            resource: {
              product: "hotel_catalog",
              resourceType: "property",
              resourceId: propertyId,
            },
          });
          return jsonResponse({
            contractVersion: "platform-media-upload.v2",
            uploadSession: { sessionId: "session_1", status: "signed" },
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
          contractVersion: "platform-media-upload.v2",
          uploadSession: { sessionId: "session_1", status: "completed" },
          uploadTargets: [],
          mediaObjects: [
            {
              mediaObjectId,
              purpose: "property.gallery_image",
              status: "private_ready",
              publicVariants: [],
            },
          ],
        });
      }),
    );

    await expect(
      uploadPropertyGalleryImages(
        [new File(["image"], "pool.jpg", { type: "image/jpeg" })],
        propertyId,
      ),
    ).resolves.toEqual([mediaObjectId]);
  });

  it("returns a stable error when gallery upload session creation times out", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://next-api.vayada.com");
    const { uploadPropertyGalleryImages } = await import("./uploadImage");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("request timed out");
        error.name = "TimeoutError";
        throw error;
      }),
    );

    await expect(
      uploadPropertyGalleryImages(
        [new File(["image"], "pool.jpg", { type: "image/jpeg" })],
        "55555555-5555-4555-8555-555555555554",
      ),
    ).rejects.toThrow("Gallery upload timed out. Try again.");
  });

  it("matches reversed upload targets to files and finalizes their metadata in file order", async () => {
    vi.stubEnv("NEXT_PUBLIC_PLATFORM_MEDIA_API_URL", "https://next-api.vayada.com");
    const propertyId = "55555555-5555-4555-8555-555555555553";
    const firstFile = new File(["first"], "pool.jpg", { type: "image/jpeg" });
    const secondFile = new File(["second-image"], "suite.webp", { type: "image/webp" });
    const firstMediaObjectId = "66666666-6666-4666-8666-666666666664";
    const secondMediaObjectId = "66666666-6666-4666-8666-666666666665";
    const { uploadPropertyGalleryImages } = await import("./uploadImage");
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/media/upload-sessions")) {
        return jsonResponse({
          contractVersion: "platform-media-upload.v2",
          uploadSession: { sessionId: "session_2", status: "signed" },
          uploadTargets: [
            {
              uploadTargetId: "target_2",
              clientFileId: "file_2",
              method: "PUT",
              uploadUrl: "https://uploads.example.com/target_2",
              headers: { "Content-Type": "image/webp" },
            },
            {
              uploadTargetId: "target_1",
              clientFileId: "file_1",
              method: "PUT",
              uploadUrl: "https://uploads.example.com/target_1",
              headers: { "Content-Type": "image/jpeg" },
            },
          ],
        });
      }
      if (url.startsWith("https://uploads.example.com/")) {
        return new Response(null, { status: 200 });
      }
      expect(url).toContain("/api/media/upload-sessions/session_2/finalize");
      expect(JSON.parse(String(init?.body))).toEqual({
        files: [
          {
            uploadTargetId: "target_1",
            contentType: "image/jpeg",
            sizeBytes: firstFile.size,
          },
          {
            uploadTargetId: "target_2",
            contentType: "image/webp",
            sizeBytes: secondFile.size,
          },
        ],
      });
      return jsonResponse({
        contractVersion: "platform-media-upload.v2",
        uploadSession: { sessionId: "session_2", status: "completed" },
        uploadTargets: [],
        mediaObjects: [
          {
            clientFileId: "file_2",
            mediaObjectId: secondMediaObjectId,
            purpose: "property.gallery_image",
            status: "private_ready",
          },
          {
            clientFileId: "file_1",
            mediaObjectId: firstMediaObjectId,
            purpose: "property.gallery_image",
            status: "private_ready",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(uploadPropertyGalleryImages([firstFile, secondFile], propertyId)).resolves.toEqual(
      [firstMediaObjectId, secondMediaObjectId],
    );

    const firstUpload = fetch.mock.calls.find(([input]) => String(input).endsWith("/target_1"));
    const secondUpload = fetch.mock.calls.find(([input]) => String(input).endsWith("/target_2"));
    expect(firstUpload?.[1]?.body).toBe(firstFile);
    expect(secondUpload?.[1]?.body).toBe(secondFile);
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
