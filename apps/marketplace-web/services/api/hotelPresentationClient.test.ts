import { beforeEach, describe, expect, it, vi } from "vitest";

import { createHotelPresentationClient } from "./hotelPresentationClient";

const propertyId = "11111111-1111-4111-8111-111111111111";
const mediaObjectId = "22222222-2222-4222-8222-222222222222";
const calls = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), upload: vi.fn() }));
const client = createHotelPresentationClient(
  { get: calls.get, put: calls.put },
  { post: calls.post },
  calls.upload,
);

describe("hotelPresentationClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads and saves the exact Step 1 owner model", async () => {
    calls.get.mockResolvedValue(readModel());
    await expect(client.load(propertyId)).resolves.toEqual(readModel());
    expect(calls.get).toHaveBeenCalledWith(
      `/api/hotel-setup/properties/${propertyId}/steps/present-hotel`,
      undefined,
    );

    calls.put.mockResolvedValue({ ...readModel(8), outcome: "idempotent_replay" });
    await expect(
      client.save(propertyId, {
        expectedProfileRevision: 7,
        locale: "en",
        shortDescription: "A calm city hotel close to museums, cafés, and the historic centre.",
        amenities: { reviewed: true, keys: ["wifi"] },
        media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
      }),
    ).resolves.toMatchObject({ profileRevision: 8, outcome: "idempotent_replay" });
  });

  it("loads the exact nullable first-visit Step 1 model", async () => {
    const firstVisit = {
      ...readModel(),
      profile: {
        ...readModel().profile,
        shortDescription: null,
        publicSlug: null,
        amenities: { reviewed: false, keys: [] },
      },
    };
    calls.get.mockResolvedValue(firstVisit);

    await expect(client.load(propertyId)).resolves.toEqual(firstVisit);
  });

  it("uses the target media v2 upload flow and returns only property gallery media", async () => {
    calls.post
      .mockResolvedValueOnce({
        contractVersion: "platform-media-upload.v2",
        uploadSession: { sessionId: "upload-1", status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: "target-1",
            clientFileId: "file_1",
            method: "PUT",
            uploadUrl: "https://uploads.vayada.localhost/hotel.jpg",
            headers: { "content-type": "image/jpeg" },
          },
        ],
      })
      .mockResolvedValueOnce({
        contractVersion: "platform-media-upload.v2",
        mediaObjects: [
          {
            mediaObjectId,
            purpose: "property.gallery_image",
            status: "private_ready",
            publicVariants: [],
          },
        ],
      });
    const file = new File([new Uint8Array([1, 2, 3])], "hotel.jpg", { type: "image/jpeg" });

    await expect(client.upload(propertyId, [file])).resolves.toEqual([
      expect.objectContaining({ mediaObjectId, purpose: "property.gallery_image" }),
    ]);
    const request = calls.post.mock.calls[0]?.[1] as {
      purpose: string;
      visibility: string;
      resource: { propertyId: string };
    };
    expect(request).toMatchObject({
      purpose: "property.gallery_image",
      visibility: "private",
      resource: { propertyId },
    });
    expect(calls.upload).not.toHaveBeenCalled();
  });

  it("uses the API's private Catalog contract for canonical hero uploads", async () => {
    calls.post.mockResolvedValueOnce({
      contractVersion: "platform-media-upload.v2",
      uploadSession: { sessionId: "upload-hero", status: "completed" },
      uploadTargets: [],
      mediaObjects: [
        {
          mediaObjectId,
          purpose: "property.hero_image",
          status: "private_ready",
          publicVariants: [],
        },
      ],
    });
    const file = new File([new Uint8Array([1, 2, 3])], "hero.jpg", { type: "image/jpeg" });

    await expect(client.upload(propertyId, [file], "property.hero_image")).resolves.toEqual([
      expect.objectContaining({ mediaObjectId, purpose: "property.hero_image" }),
    ]);
    expect(calls.post.mock.calls[0]?.[1]).toMatchObject({
      purpose: "property.hero_image",
      visibility: "private",
      resource: {
        product: "hotel_catalog",
        resourceType: "property",
        resourceId: propertyId,
        propertyId,
      },
    });
  });
});

function readModel(revision = 7) {
  return {
    contractVersion: "hotel-catalog-step1.v1",
    propertyId,
    displayName: "Canal House",
    profileRevision: revision,
    supportedLocales: ["de", "en"],
    profile: {
      locale: "en",
      shortDescription: "A calm city hotel close to museums, cafés, and the historic centre.",
      publicSlug: "canal-house",
      amenities: { reviewed: true, keys: ["wifi"] },
      media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
    },
    baseRevisions: {
      "hotel_catalog.profile": `profile:${revision}`,
      "hotel_catalog.media": `profile:${revision}`,
      "hotel_catalog.amenities": `profile:${revision}`,
    },
  };
}
