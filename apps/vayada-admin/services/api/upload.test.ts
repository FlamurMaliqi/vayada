import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadPlatformMedia = vi.hoisted(() => vi.fn());

vi.mock("@vayada/marketplace-shared/api/platformMedia", () => ({ uploadPlatformMedia }));

import { uploadService } from "./upload";

const file = { name: "photo.jpg", size: 123, type: "image/jpeg" } as File;
const result = (mediaId: string, url: string) => ({
  mediaId,
  url,
  storageKey: `private/media/${mediaId}`,
  contentType: "image/jpeg",
  sizeBytes: 123,
  widthPx: 1200,
  heightPx: 800,
  originalFilename: "photo.jpg",
});

describe("uploadService", () => {
  beforeEach(() => uploadPlatformMedia.mockReset());

  it("uploads a creator image for the exact managed user and returns its media ID", async () => {
    uploadPlatformMedia.mockResolvedValue([
      result("media-creator", "https://cdn.example.test/creator.webp"),
    ]);

    await expect(uploadService.uploadCreatorProfileImage(file, "user-creator")).resolves.toEqual(
      expect.objectContaining({
        mediaObjectId: "media-creator",
        url: "https://cdn.example.test/creator.webp",
      }),
    );
    expect(uploadPlatformMedia).toHaveBeenCalledWith({
      purpose: "marketplace.creator.profile_image",
      visibility: "public",
      resource: {
        product: "marketplace",
        resourceType: "creator_profile",
        resourceId: "user-creator",
      },
      files: [file],
      idempotencyKey: "admin:creator-profile:user-creator",
    });
  });

  it("rejects creator media without a public display derivative", async () => {
    uploadPlatformMedia.mockResolvedValue([result("media-private", "private/media/object")]);

    await expect(uploadService.uploadCreatorProfileImage(file, "user-creator")).rejects.toThrow(
      "still processing",
    );
  });
});
