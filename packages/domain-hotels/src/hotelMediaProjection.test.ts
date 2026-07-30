import { describe, expect, it } from "vitest";

import {
  createHotelMediaResolutionPort,
  createPropertyMediaProjectionInput,
  createRoomMediaProjectionInput,
  type BookingHotelMediaProjectionInput,
  type HotelMediaResolutionAdapter,
  type MarketplaceHotelMediaProjectionInput,
  type PublicHotelMediaResolutionSnapshot,
  type ResolvedPropertyMediaBatch,
  type ResolvedRoomMediaBatch,
} from "./hotelMediaProjection.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const roomTypeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const mediaObjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function mediaSnapshot(
  overrides: Partial<PublicHotelMediaResolutionSnapshot> = {},
): PublicHotelMediaResolutionSnapshot {
  return {
    mediaObjectId,
    ownerOrganizationId: organizationId,
    propertyId,
    purpose: "property.gallery_image",
    publicVariants: [
      {
        variantName: "large",
        publicUrl: "https://cdn.example/property/gallery-large.webp",
      },
    ],
    ...overrides,
  };
}

function resolutionPort(
  result: Awaited<ReturnType<HotelMediaResolutionAdapter["loadPublicMedia"]>>,
) {
  return createHotelMediaResolutionPort({
    async loadPublicMedia() {
      return result;
    },
  });
}

async function propertyBatch(
  snapshot: PublicHotelMediaResolutionSnapshot = mediaSnapshot(),
): Promise<ResolvedPropertyMediaBatch> {
  const result = await resolutionPort({
    ok: true,
    resolvedTarget: { kind: "property", propertyId },
    media: [snapshot],
  }).resolvePublicMedia({
    ownerOrganizationId: organizationId,
    target: { kind: "property", propertyId },
    mediaObjectIds: [mediaObjectId],
  });
  expect(result.ok).toBe(true);
  return (result as { ok: true; batch: ResolvedPropertyMediaBatch }).batch;
}

async function roomBatch(
  mediaObjectIds: readonly string[] = [mediaObjectId],
): Promise<ResolvedRoomMediaBatch> {
  const result = await resolutionPort({
    ok: true,
    resolvedTarget: { kind: "room_type", propertyId, roomTypeId },
    media: mediaObjectIds.map((id) =>
      mediaSnapshot({ mediaObjectId: id, purpose: "pms.room_type.media" }),
    ),
  }).resolvePublicMedia({
    ownerOrganizationId: organizationId,
    target: { kind: "room_type", propertyId, roomTypeId },
    mediaObjectIds,
  });
  expect(result.ok).toBe(true);
  return (result as { ok: true; batch: ResolvedRoomMediaBatch }).batch;
}

describe("resolved hotel media projection contract", () => {
  it("keeps the logo separate while reusing one immutable canonical identity", async () => {
    const resolvedMedia = await propertyBatch();
    const projection = createPropertyMediaProjectionInput({
      resolvedMedia,
      profileRevision: 5,
      logoAssignment: { mediaObjectId, role: "logo", altText: "Hotel logo", sortOrder: 0 },
      presentationAssignments: [
        { mediaObjectId, role: "cover", altText: "Hotel entrance", sortOrder: 0 },
        { mediaObjectId, role: "gallery", altText: "Hotel entrance", sortOrder: 1 },
      ],
    });
    expect(projection).not.toBeNull();
    const marketplaceProjection: MarketplaceHotelMediaProjectionInput = projection!;
    const bookingProjection: BookingHotelMediaProjectionInput = marketplaceProjection;

    expect(bookingProjection.logoAssignment?.media.mediaObjectId).toBe(mediaObjectId);
    expect(
      bookingProjection.presentationAssignments.map(({ media }) => media.mediaObjectId),
    ).toEqual([mediaObjectId, mediaObjectId]);
    expect(Object.isFrozen(bookingProjection)).toBe(true);
    expect(Object.isFrozen(bookingProjection.presentationAssignments[0]!.media)).toBe(true);
    expect(
      Object.isFrozen(bookingProjection.presentationAssignments[0]!.media.publicVariants[0]),
    ).toBe(true);
  });

  it("binds a PMS room proof and media snapshot into one opaque batch", async () => {
    const resolvedMedia = await roomBatch();
    const roomProjection = createRoomMediaProjectionInput({
      resolvedMedia,
      roomMediaRevision: 2,
      assignments: [{ mediaObjectId, altText: "Suite", sortOrder: 0 }],
    });

    expect(roomProjection).not.toBeNull();
    expect(roomProjection?.roomTypeId).toBe(roomTypeId);
    expect(roomProjection?.assignments[0]?.media.mediaObjectId).toBe(mediaObjectId);
    expect(
      createRoomMediaProjectionInput({
        resolvedMedia,
        roomMediaRevision: 2,
        assignments: [
          {
            mediaObjectId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            altText: null,
            sortOrder: 0,
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects cast-only forged batches at runtime", () => {
    const forged = {
      ownerOrganizationId: organizationId,
      target: { kind: "property", propertyId },
      media: [mediaSnapshot()],
    } as unknown as ResolvedPropertyMediaBatch;

    expect(
      createPropertyMediaProjectionInput({
        resolvedMedia: forged,
        profileRevision: 1,
        logoAssignment: null,
        presentationAssignments: [],
      }),
    ).toBeNull();
  });

  it("rejects cross-scope, wrong-target, and wrong-purpose adapter output", async () => {
    for (const result of [
      {
        ok: true as const,
        resolvedTarget: { kind: "property" as const, propertyId: "other-property" },
        media: [mediaSnapshot()],
      },
      {
        ok: true as const,
        resolvedTarget: { kind: "property" as const, propertyId },
        media: [mediaSnapshot({ ownerOrganizationId: "other-organization" })],
      },
      {
        ok: true as const,
        resolvedTarget: { kind: "property" as const, propertyId },
        media: [mediaSnapshot({ purpose: "pms.room_type.media" })],
      },
    ]) {
      const resolved = await resolutionPort(result).resolvePublicMedia({
        ownerOrganizationId: organizationId,
        target: { kind: "property", propertyId },
        mediaObjectIds: [mediaObjectId],
      });
      expect(resolved).toEqual({
        ok: false,
        error: { code: "media_not_authorized", mediaObjectIds: [mediaObjectId] },
      });
    }
  });

  it("requires exact requested-media cardinality and canonicalizes UUIDs", async () => {
    const upperId = mediaObjectId.toUpperCase();
    const resolved = await resolutionPort({
      ok: true,
      resolvedTarget: { kind: "property", propertyId },
      media: [mediaSnapshot({ mediaObjectId: upperId })],
    }).resolvePublicMedia({
      ownerOrganizationId: organizationId,
      target: { kind: "property", propertyId },
      mediaObjectIds: [upperId],
    });
    expect(resolved.ok && resolved.batch.media[0]?.mediaObjectId).toBe(mediaObjectId);

    const duplicateRequest = await resolutionPort({
      ok: true,
      resolvedTarget: { kind: "property", propertyId },
      media: [mediaSnapshot()],
    }).resolvePublicMedia({
      ownerOrganizationId: organizationId,
      target: { kind: "property", propertyId },
      mediaObjectIds: [mediaObjectId, upperId],
    });
    expect(duplicateRequest.ok).toBe(false);
  });

  it("copies plain adapter snapshots without freezing or retaining caller objects", async () => {
    const source = mediaSnapshot();
    const sourceVariant = source.publicVariants[0]! as { publicUrl: string };
    const resolvedMedia = await propertyBatch(source);

    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.publicVariants)).toBe(false);
    sourceVariant.publicUrl = "https://attacker.example/replaced.webp";
    expect(resolvedMedia.media[0]?.publicVariants[0]?.publicUrl).toBe(
      "https://cdn.example/property/gallery-large.webp",
    );

    const accessor = { ...mediaSnapshot() } as Record<string, unknown>;
    Object.defineProperty(accessor, "propertyId", {
      enumerable: true,
      get: () => propertyId,
    });
    const rejected = await resolutionPort({
      ok: true,
      resolvedTarget: { kind: "property", propertyId },
      media: [accessor as PublicHotelMediaResolutionSnapshot],
    }).resolvePublicMedia({
      ownerOrganizationId: organizationId,
      target: { kind: "property", propertyId },
      mediaObjectIds: [mediaObjectId],
    });
    expect(rejected.ok).toBe(false);
  });

  it("rejects room projections larger than the PMS assignment limit", async () => {
    const mediaObjectIds = Array.from(
      { length: 21 },
      (_, index) => `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const resolvedMedia = await roomBatch(mediaObjectIds);
    expect(
      createRoomMediaProjectionInput({
        resolvedMedia,
        roomMediaRevision: 2,
        assignments: mediaObjectIds.map((mediaObjectId, sortOrder) => ({
          mediaObjectId,
          altText: null,
          sortOrder,
        })),
      }),
    ).toBeNull();
  });
});
