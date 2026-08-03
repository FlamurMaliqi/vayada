import {
  createHotelMediaResolutionPort,
  createRoomMediaProjectionInput,
  type PropertyMediaPublicVariant,
  type PropertyMediaUploadPurpose,
  type ResolvedRoomMediaBatch,
} from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import {
  PMS_ROOM_AMENITIES_CONTRACT_VERSION,
  parseRoomAmenitiesSnapshot,
} from "./roomAmenities.js";
import { PMS_ROOM_FACTS_CONTRACT_VERSION, parseRoomTypeFacts } from "./roomFacts.js";
import {
  PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
  createRoomPublicationSnapshot,
  parseAssignRoomTypeMediaCommand,
  parseAssignRoomTypeMediaResult,
  serializeAssignRoomTypeMediaFingerprint,
  type RoomPublicationMediaSource,
  type RoomPublicationRoomSource,
  type RoomPublicationSnapshotInput,
} from "./roomPublication.js";

const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOrganizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const otherPropertyId = "22222222-2222-4222-8222-222222222222";
const firstRoomId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const secondRoomId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const digitRoomId = "99999999-9999-4999-8999-999999999999";
const letterRoomId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const actorId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const mediaId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const facts = parseRoomTypeFacts({
  name: "Garden Suite",
  description: "A calm suite facing the garden.",
  category: "suite",
  occupancy: { maxGuests: 3, maxAdults: 2, maxChildren: 1 },
  beds: [{ type: "king", quantity: 1 }],
  bedrooms: 1,
  bathrooms: 1,
  bathroomType: "private",
  size: { value: 32, unit: "sqm" },
})!;

const oldStructuralHttpsPayload = {
  outcome: "resolved",
  roomMediaRevision: 1,
  assignments: [
    {
      mediaObjectId: mediaId,
      altText: null,
      sortOrder: 0,
      publicVariants: [
        { variantName: "original_safe", publicUrl: "https://attacker.example/forged.webp" },
      ],
    },
  ],
};
// @ts-expect-error A structural HTTPS assignment is not VAY-1047's opaque room proof.
const structuralMediaProofMustNotCompile: RoomPublicationMediaSource = oldStructuralHttpsPayload;
void structuralMediaProofMustNotCompile;

function mediaCommand() {
  return {
    organizationId,
    propertyId,
    roomTypeId: firstRoomId,
    expectedRoomMediaRevision: 3,
    assignments: [{ mediaObjectId: mediaId, altText: "Garden suite", sortOrder: 0 }],
    idempotencyKey: "room-media-command",
    audit: {
      actor: { kind: "user", userId: actorId },
      requestId: "request-1",
      correlationId: null,
      requestedAt: "2026-08-03T08:00:00.000Z",
    },
  };
}

async function resolvedMediaSource(options: {
  roomTypeId: string;
  ownerOrganizationId?: string;
  mediaPropertyId?: string;
  roomMediaRevision?: number;
  declaredRevision?: number;
  assignments?: readonly {
    mediaObjectId: string;
    altText: string | null;
    sortOrder: number;
  }[];
  purpose?: PropertyMediaUploadPurpose;
  publicVariants?: readonly PropertyMediaPublicVariant[];
}): Promise<RoomPublicationMediaSource> {
  const ownerOrganizationId = options.ownerOrganizationId ?? organizationId;
  const mediaPropertyId = options.mediaPropertyId ?? propertyId;
  const roomMediaRevision = options.roomMediaRevision ?? 6;
  const assignments =
    options.assignments ??
    ([{ mediaObjectId: mediaId, altText: "Garden suite", sortOrder: 0 }] as const);
  const requestedIds = assignments.map(({ mediaObjectId: id }) => id);
  const resolutionPort = createHotelMediaResolutionPort({
    async loadPublicMedia(input) {
      return {
        ok: true as const,
        resolvedTarget: input.target,
        media: input.mediaObjectIds.map((id) => ({
          mediaObjectId: id,
          ownerOrganizationId: input.ownerOrganizationId,
          propertyId: input.target.propertyId,
          purpose: options.purpose ?? "property.gallery_image",
          publicVariants: options.publicVariants ?? [
            {
              variantName: "thumbnail" as const,
              publicUrl: `https://images.vayada.com/media/${id}/thumbnail/v1.webp`,
            },
            {
              variantName: "original_safe" as const,
              publicUrl: `https://images.vayada.com/media/${id}/original_safe/v1.webp`,
            },
          ],
        })),
      };
    },
  });
  const resolved = await resolutionPort.resolvePublicMedia({
    ownerOrganizationId,
    target: { kind: "room_type", propertyId: mediaPropertyId, roomTypeId: options.roomTypeId },
    mediaObjectIds: requestedIds,
  });
  if (!resolved.ok) throw new Error("test media resolution failed");
  if (resolved.batch.target.kind !== "room_type") {
    throw new Error("test media resolution returned the wrong target kind");
  }
  const projection = createRoomMediaProjectionInput({
    resolvedMedia: resolved.batch as ResolvedRoomMediaBatch,
    roomMediaRevision,
    assignments,
  });
  if (!projection) throw new Error("test room media projection failed");
  return {
    outcome: "resolved",
    roomMediaRevision: options.declaredRevision ?? roomMediaRevision,
    projection,
  };
}

async function roomSource(
  roomTypeId: string,
  overrides: Partial<RoomPublicationRoomSource> = {},
): Promise<RoomPublicationRoomSource> {
  return {
    roomFacts: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomFactsRevision: 4,
      lifecycle: "active",
      facts,
      createdAt: "2026-08-03T07:00:00.000Z",
      updatedAt: "2026-08-03T08:00:00.000Z",
    },
    capacity: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomUnitsRevision: 5,
      activeUnitCount: 2,
      capturedAt: "2026-08-03T08:00:00.000Z",
    },
    media: await resolvedMediaSource({ roomTypeId }),
    roomAmenities: parseRoomAmenitiesSnapshot({
      contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomAmenitiesRevision: 7,
      reviewed: true,
      amenities: ["wifi", "air_conditioning"],
      reviewedAt: "2026-08-03T08:00:00.000Z",
    })!,
    ...overrides,
  };
}

function publicationInput(
  rooms: readonly RoomPublicationRoomSource[],
): RoomPublicationSnapshotInput {
  return { organizationId, propertyId, rooms };
}

describe("room publication contract", () => {
  it("parses the expected-versioned media command and stable fingerprint", () => {
    const parsed = parseAssignRoomTypeMediaCommand(mediaCommand());
    expect(parsed).not.toBeNull();
    expect(parsed?.assignments[0]?.mediaObjectId).toBe(mediaId);
    expect(serializeAssignRoomTypeMediaFingerprint(parsed!)).toBe(
      JSON.stringify({
        organizationId,
        propertyId,
        roomTypeId: firstRoomId,
        expectedRoomMediaRevision: 3,
        assignments: [{ mediaObjectId: mediaId, altText: "Garden suite", sortOrder: 0 }],
      }),
    );
    expect(
      parseAssignRoomTypeMediaCommand({ ...mediaCommand(), expectedRoomMediaRevision: 0 }),
    ).toBeNull();
  });

  it("strictly parses media results and safe failures", () => {
    expect(
      parseAssignRoomTypeMediaResult({
        ok: true,
        response: {
          contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
          outcome: "assigned",
          propertyId,
          roomTypeId: firstRoomId,
          roomMediaRevision: 4,
          assignments: mediaCommand().assignments,
          acceptedAt: "2026-08-03T08:00:00.000Z",
        },
      }),
    ).not.toBeNull();
    expect(
      parseAssignRoomTypeMediaResult({
        ok: false,
        error: { code: "media_not_ready", mediaObjectIds: [mediaId] },
      }),
    ).toEqual({ ok: false, error: { code: "media_not_ready", mediaObjectIds: [mediaId] } });
    expect(
      parseAssignRoomTypeMediaResult({
        ok: false,
        error: { code: "media_not_ready", mediaObjectIds: [mediaId], privateUrl: "secret" },
      }),
    ).toBeNull();
  });

  it("projects opaque media proofs, public facts, and exact revisions deterministically", async () => {
    const firstRoom = await roomSource(firstRoomId);
    const secondRoom = await roomSource(secondRoomId);
    const first = createRoomPublicationSnapshot(publicationInput([secondRoom, firstRoom]));
    const second = createRoomPublicationSnapshot(publicationInput([firstRoom, secondRoom]));
    expect(first).toEqual(second);
    expect(first.status).toBe("ready");
    expect(first.rooms.map(({ roomTypeId }) => roomTypeId)).toEqual([firstRoomId, secondRoomId]);
    expect(first.rooms[0]).toMatchObject({
      facts,
      activeUnitCount: 2,
      amenities: ["air_conditioning", "wifi"],
      sourceRevisions: {
        roomFactsRevision: 4,
        roomUnitsRevision: 5,
        roomMediaRevision: 6,
        roomAmenitiesRevision: 7,
      },
    });
    expect(first.rooms[0]?.media[0]?.publicVariants[0]?.variantName).toBe("original_safe");
    expect(Object.isFrozen(first.rooms[0]?.facts)).toBe(true);
  });

  it("changes source evidence when media safety output or purpose changes", async () => {
    const v1 = await roomSource(firstRoomId);
    const v2 = await roomSource(firstRoomId, {
      media: await resolvedMediaSource({
        roomTypeId: firstRoomId,
        purpose: "pms.room_type.media",
        publicVariants: [
          {
            variantName: "original_safe",
            publicUrl: `https://images.vayada.com/media/${mediaId}/original_safe/v2.webp`,
          },
        ],
      }),
    });
    const unavailable = await roomSource(firstRoomId, {
      media: { outcome: "unavailable", roomMediaRevision: 6 },
    });
    const first = createRoomPublicationSnapshot(publicationInput([v1]));
    const second = createRoomPublicationSnapshot(publicationInput([v2]));
    const third = createRoomPublicationSnapshot(publicationInput([unavailable]));
    expect(new Set([first.sourceRevision, second.sourceRevision, third.sourceRevision]).size).toBe(
      3,
    );
    expect(third.status).toBe("blocked");
  });

  it("treats reviewed-empty as ready and untouched selections as private blockers", async () => {
    const reviewedEmpty = await roomSource(firstRoomId, {
      roomAmenities: {
        contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
        propertyId,
        roomTypeId: firstRoomId,
        roomAmenitiesRevision: 2,
        reviewed: true,
        amenities: [],
        reviewedAt: "2026-08-03T08:00:00.000Z",
      },
    });
    expect(createRoomPublicationSnapshot(publicationInput([reviewedEmpty]))).toMatchObject({
      status: "ready",
      rooms: [{ amenities: [] }],
    });

    const untouched = await roomSource(firstRoomId, {
      roomAmenities: parseRoomAmenitiesSnapshot({
        contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
        propertyId,
        roomTypeId: firstRoomId,
        roomAmenitiesRevision: 1,
        reviewed: false,
        amenities: ["wifi"],
        reviewedAt: null,
      })!,
    });
    const blocked = createRoomPublicationSnapshot(publicationInput([untouched]));
    expect(blocked.rooms[0]?.amenities).toBeNull();
    expect(blocked.blockers).toContainEqual(
      expect.objectContaining({
        code: "room_amenities_review_required",
        affectedEntity: { entityType: "room_type", entityId: firstRoomId },
        owningStepId: "rooms",
      }),
    );
  });

  it("blocks missing units, photos, unavailable media, and an empty property", async () => {
    const noUnits = await roomSource(firstRoomId, {
      capacity: {
        contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
        propertyId,
        roomTypeId: firstRoomId,
        roomUnitsRevision: 5,
        activeUnitCount: 0,
        capturedAt: "2026-08-03T08:00:00.000Z",
      },
      media: await resolvedMediaSource({ roomTypeId: firstRoomId, assignments: [] }),
    });
    expect(
      createRoomPublicationSnapshot(publicationInput([noUnits])).blockers.map(({ code }) => code),
    ).toEqual(["room_photo_required", "room_units_required"]);

    const unsafe = createRoomPublicationSnapshot(
      publicationInput([
        await roomSource(firstRoomId, {
          media: { outcome: "unavailable", roomMediaRevision: 6 },
        }),
      ]),
    );
    expect(unsafe.rooms[0]?.media).toEqual([]);
    expect(unsafe.blockers[0]?.code).toBe("room_media_unavailable");

    expect(createRoomPublicationSnapshot(publicationInput([])).blockers[0]).toMatchObject({
      code: "room_type_required",
      affectedEntity: { entityType: "property", entityId: propertyId },
    });
  });

  it("binds opaque proofs to organization, property, room, and current revision", async () => {
    const cases: RoomPublicationMediaSource[] = [
      await resolvedMediaSource({
        roomTypeId: firstRoomId,
        ownerOrganizationId: otherOrganizationId,
      }),
      await resolvedMediaSource({ roomTypeId: firstRoomId, mediaPropertyId: otherPropertyId }),
      await resolvedMediaSource({ roomTypeId: secondRoomId }),
      await resolvedMediaSource({ roomTypeId: firstRoomId, declaredRevision: 7 }),
    ];
    for (const media of cases) {
      expect(() =>
        createRoomPublicationSnapshot(
          publicationInput([awaitRoomSourceForScopeTest(firstRoomId, media)]),
        ),
      ).toThrow("media proof is outside");
    }
  });

  it("uses code-unit ordering and rejects accessor or sparse top-level input", async () => {
    const digit = await roomSource(digitRoomId);
    const letter = await roomSource(letterRoomId);
    expect(
      createRoomPublicationSnapshot(publicationInput([letter, digit])).rooms.map(
        ({ roomTypeId }) => roomTypeId,
      ),
    ).toEqual([digitRoomId, letterRoomId]);

    let getterReads = 0;
    const accessorInput = Object.defineProperty({ organizationId, rooms: [] }, "propertyId", {
      enumerable: true,
      get() {
        getterReads += 1;
        return propertyId;
      },
    });
    expect(() =>
      createRoomPublicationSnapshot(accessorInput as unknown as RoomPublicationSnapshotInput),
    ).toThrow("input is invalid");
    expect(getterReads).toBe(0);

    expect(() =>
      createRoomPublicationSnapshot({
        organizationId,
        propertyId,
        rooms: Array(1) as RoomPublicationRoomSource[],
      }),
    ).toThrow("input is invalid");
  });
});

function awaitRoomSourceForScopeTest(
  roomTypeId: string,
  media: RoomPublicationMediaSource,
): RoomPublicationRoomSource {
  return {
    roomFacts: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomFactsRevision: 4,
      lifecycle: "active",
      facts,
      createdAt: "2026-08-03T07:00:00.000Z",
      updatedAt: "2026-08-03T08:00:00.000Z",
    },
    capacity: {
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomUnitsRevision: 5,
      activeUnitCount: 2,
      capturedAt: "2026-08-03T08:00:00.000Z",
    },
    media,
    roomAmenities: parseRoomAmenitiesSnapshot({
      contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomAmenitiesRevision: 7,
      reviewed: true,
      amenities: [],
      reviewedAt: "2026-08-03T08:00:00.000Z",
    })!,
  };
}
