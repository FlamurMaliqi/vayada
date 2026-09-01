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

  it("uploads offer images against the exact offer and returns only their media IDs", async () => {
    uploadPlatformMedia.mockResolvedValue([
      result("media-one", "private/media/one"),
      result("media-two", "private/media/two"),
    ]);

    const response = await uploadService.uploadListingImages([file, file], "offer-801");

    expect(uploadPlatformMedia).toHaveBeenCalledWith({
      purpose: "marketplace.offer.media",
      visibility: "private",
      resource: {
        product: "marketplace",
        resourceType: "marketplace_offer",
        resourceId: "offer-801",
      },
      files: [file, file],
      idempotencyKey: "admin:offer:offer-801",
    });
    expect(response).toEqual({ mediaObjectIds: ["media-one", "media-two"] });
  });

  it("fails when the media API does not return every selected offer image", async () => {
    uploadPlatformMedia.mockResolvedValue([result("media-one", "private/media/one")]);

    await expect(uploadService.uploadListingImages([file, file], "offer-801")).rejects.toThrow(
      "Not every selected offer image",
    );
  });
});
