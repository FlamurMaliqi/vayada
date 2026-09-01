import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadHotelProfileImage = vi.hoisted(() => vi.fn());

import { apiClient, ApiErrorResponse } from "./client";
import {
  hasPropertyHero,
  isPropertyHeroPublicationConfirmed,
  type PlatformAdminPropertyHero,
  propertyHeroService,
  PropertyHeroPublicationError,
} from "./propertyHero";

vi.mock("./client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./client")>();
  return { ...original, apiClient: { get: vi.fn(), put: vi.fn() } };
});
vi.mock("./upload", () => ({ uploadService: { uploadHotelProfileImage } }));

const propertyHero = (
  mediaObjectId: string | null,
  profileRevision = 8,
): PlatformAdminPropertyHero => ({
  contractVersion: "platform-admin-property-hero.v1",
  propertyId: "property-984",
  profileRevision,
  hero:
    mediaObjectId === null ? null : { mediaObjectId, url: "https://cdn.example.test/hero.webp" },
});

describe("Platform Admin property hero client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("treats a canonical media ID as an existing hero without a display URL", () => {
    expect(hasPropertyHero("media-984", "")).toBe(true);
    expect(hasPropertyHero(null, "blob:local-preview")).toBe(true);
    expect(hasPropertyHero(null, "")).toBe(false);
  });

  it("reads the exact property and replaces it with only a canonical media ID", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({});
    vi.mocked(apiClient.put).mockResolvedValue(propertyHero("media-984"));

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
    vi.mocked(apiClient.put).mockResolvedValue(propertyHero(null, 9));

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
    vi.mocked(apiClient.put).mockResolvedValue(propertyHero("media-984"));

    await propertyHeroService.uploadAndReplace(file, "property-984", 7);

    expect(uploadHotelProfileImage).toHaveBeenCalledWith(file, "property-984");
    expect(apiClient.put).toHaveBeenCalledWith(
      expect.any(String),
      { expectedProfileRevision: 7, mediaObjectId: "media-984" },
      expect.any(Object),
    );
  });

  it("rejects when the command response does not match the uploaded media object", async () => {
    const file = { name: "hero.jpg" } as File;
    uploadHotelProfileImage.mockResolvedValue({ mediaObjectId: "media-984" });
    vi.mocked(apiClient.put).mockResolvedValue(propertyHero("media-other"));

    await expect(
      propertyHeroService.uploadAndReplace(file, "property-984", 7),
    ).rejects.toMatchObject({ mediaObjectId: "media-984" });
  });

  it("reconciles a lost upload acknowledgement by canonical media ID", async () => {
    const file = { name: "hero.jpg" } as File;
    uploadHotelProfileImage.mockResolvedValue({ mediaObjectId: "media-984" });
    vi.mocked(apiClient.put).mockRejectedValue(new TypeError("response lost"));
    vi.mocked(apiClient.get).mockResolvedValue(propertyHero("media-984"));

    const error = await propertyHeroService
      .uploadAndReplace(file, "property-984", 7)
      .catch((failure: unknown) => failure);
    const current = await propertyHeroService.get("property-984");

    expect(error).toBeInstanceOf(PropertyHeroPublicationError);
    expect(error).toMatchObject({ mediaObjectId: "media-984" });
    expect(isPropertyHeroPublicationConfirmed(current, error)).toBe(true);
  });

  it("reconciles a lost clear acknowledgement only when the exact hero is absent", async () => {
    vi.mocked(apiClient.put).mockRejectedValue(new TypeError("response lost"));
    vi.mocked(apiClient.get).mockResolvedValue(propertyHero(null, 9));

    const error = await propertyHeroService
      .replace("property-984", 8, null)
      .catch((failure: unknown) => failure);
    const current = await propertyHeroService.get("property-984");

    expect(error).toMatchObject({ mediaObjectId: null });
    expect(isPropertyHeroPublicationConfirmed(current, error)).toBe(true);
    expect(
      isPropertyHeroPublicationConfirmed(
        { ...current, hero: { mediaObjectId: "media-other", url: null } },
        error,
      ),
    ).toBe(false);
  });

  it.each([403, 409])("does not reconcile an explicit HTTP %i failure", async (status) => {
    const responseError = new ApiErrorResponse(status, { detail: "definite failure" });
    vi.mocked(apiClient.put).mockRejectedValue(responseError);
    vi.mocked(apiClient.get).mockResolvedValue(propertyHero("media-984"));

    const error = await propertyHeroService
      .replace("property-984", 7, "media-984")
      .catch((failure: unknown) => failure);
    const current = await propertyHeroService.get("property-984");

    expect(error).toBe(responseError);
    expect(isPropertyHeroPublicationConfirmed(current, error)).toBe(false);
  });

  it.each([null, undefined])("reconciles an invalid 2xx response of %s", async (response) => {
    vi.mocked(apiClient.put).mockResolvedValue(response);
    vi.mocked(apiClient.get).mockResolvedValue(propertyHero("media-984"));

    const error = await propertyHeroService
      .replace("property-984", 7, "media-984")
      .catch((failure: unknown) => failure);
    const current = await propertyHeroService.get("property-984");

    expect(error).toBeInstanceOf(PropertyHeroPublicationError);
    expect(error).toMatchObject({ mediaObjectId: "media-984" });
    expect(isPropertyHeroPublicationConfirmed(current, error)).toBe(true);
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER])(
    "rejects an invalid command profile revision of %s",
    async (profileRevision) => {
      vi.mocked(apiClient.put).mockResolvedValue(propertyHero("media-984", profileRevision));

      await expect(
        propertyHeroService.replace("property-984", 7, "media-984"),
      ).rejects.toBeInstanceOf(PropertyHeroPublicationError);
    },
  );
});
