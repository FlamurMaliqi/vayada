import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadHotelProfileImage = vi.hoisted(() => vi.fn());

import { apiClient } from "./client";
import { propertyHeroService } from "./propertyHero";

vi.mock("./client", () => ({
  apiClient: { get: vi.fn(), put: vi.fn() },
}));
vi.mock("./upload", () => ({ uploadService: { uploadHotelProfileImage } }));

describe("Platform Admin property hero client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the exact property and replaces it with only a canonical media ID", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({});
    vi.mocked(apiClient.put).mockResolvedValue({});

    await propertyHeroService.get("property-984");
    await propertyHeroService.replace("property-984", 7, "media-984");

    expect(apiClient.get).toHaveBeenCalledWith(
      "/api/platform/admin/properties/property-984/media/hero",
    );
    expect(apiClient.put).toHaveBeenCalledWith(
      "/api/platform/admin/properties/property-984/media/hero",
      { expectedProfileRevision: 7, mediaObjectId: "media-984" },
      {
        headers: {
          "Idempotency-Key": "admin:property-hero:property-984:7:media-984",
        },
      },
    );
  });

  it("uses a stable, resource-scoped command when clearing the hero", async () => {
    vi.mocked(apiClient.put).mockResolvedValue({});

    await propertyHeroService.replace("property-984", 8, null);

    expect(apiClient.put).toHaveBeenCalledWith(
      "/api/platform/admin/properties/property-984/media/hero",
      { expectedProfileRevision: 8, mediaObjectId: null },
      { headers: { "Idempotency-Key": "admin:property-hero:property-984:8:clear" } },
    );
  });

  it("publishes only the media ID returned by the exact property upload", async () => {
    const file = { name: "hero.jpg" } as File;
    uploadHotelProfileImage.mockResolvedValue({ mediaObjectId: "media-984" });
    vi.mocked(apiClient.put).mockResolvedValue({
      propertyId: "property-984",
      profileRevision: 8,
      hero: { mediaObjectId: "media-984", url: null },
    });

    await propertyHeroService.uploadAndReplace(file, "property-984", 7);

    expect(uploadHotelProfileImage).toHaveBeenCalledWith(file, "property-984");
    expect(apiClient.put).toHaveBeenCalledWith(
      expect.any(String),
      { expectedProfileRevision: 7, mediaObjectId: "media-984" },
      expect.any(Object),
    );
  });
});
