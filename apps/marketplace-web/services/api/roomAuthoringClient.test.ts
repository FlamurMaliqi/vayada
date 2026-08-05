import {
  PMS_ROOM_AMENITIES_CONTRACT_VERSION,
  PMS_ROOM_FACTS_CONTRACT_VERSION,
  PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
} from "@vayada/domain-pms";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEmptyRoomDraft,
  type RoomAuthoringDraft,
} from "@/components/setup/adaptive/rooms/roomAuthoringState";
import {
  createRoomAuthoringClient,
  RoomAuthoringOwnerError,
  type RoomAuthoringHttpClient,
  type RoomMediaUploadHttpClient,
} from "./roomAuthoringClient";
import { ApiErrorResponse } from "./client";

const propertyId = "11111111-1111-4111-8111-111111111111";
const otherPropertyId = "99999999-9999-4999-8999-999999999999";
const roomTypeId = "22222222-2222-4222-8222-222222222222";
const mediaObjectId = "33333333-3333-4333-8333-333333333333";
const draftRoomId = "draft:44444444-4444-4444-8444-444444444444";
const now = "2026-08-03T12:00:00.000Z";

const calls = vi.hoisted(() => ({
  get: vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>(),
  put: vi.fn<(endpoint: string, data?: unknown, options?: RequestInit) => Promise<unknown>>(),
  post: vi.fn<(endpoint: string, data?: unknown, options?: RequestInit) => Promise<unknown>>(),
  delete: vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>(),
  mediaPost: vi.fn<(endpoint: string, data?: unknown, options?: RequestInit) => Promise<unknown>>(),
  uploadFetch: vi.fn<typeof fetch>(),
}));

const http: RoomAuthoringHttpClient = {
  get: calls.get as RoomAuthoringHttpClient["get"],
  put: calls.put as RoomAuthoringHttpClient["put"],
  post: calls.post as RoomAuthoringHttpClient["post"],
  delete: calls.delete as RoomAuthoringHttpClient["delete"],
};
const mediaHttp: RoomMediaUploadHttpClient = {
  post: calls.mediaPost as RoomMediaUploadHttpClient["post"],
};

describe("roomAuthoringClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses one stable create key for a draft room and retains the canonical target", async () => {
    calls.post.mockResolvedValue(createFactsResponse());
    const client = createRoomAuthoringClient(http, mediaHttp, calls.uploadFetch);

    const first = await client.ensureRoomTarget({ propertyId, room: completeRoom() });
    const second = await client.ensureRoomTarget({ propertyId, room: completeRoom() });

    expect(first).toMatchObject({ roomTypeId, roomFactsRevision: 1 });
    expect(second).toMatchObject({ roomTypeId, roomFactsRevision: 1 });
    expect(calls.post).toHaveBeenCalledTimes(2);
    const firstOptions = calls.post.mock.calls[0]?.[2];
    const secondOptions = calls.post.mock.calls[1]?.[2];
    expect(new Headers(firstOptions?.headers).get("Idempotency-Key")).toBe(
      `room-create:${propertyId}:${draftRoomId}`,
    );
    expect(new Headers(secondOptions?.headers).get("Idempotency-Key")).toBe(
      new Headers(firstOptions?.headers).get("Idempotency-Key"),
    );
  });

  it("recovers an already-created room through its durable draft binding", async () => {
    const bindingConflict = new ApiErrorResponse(409, {
      code: "draft_room_binding_conflict",
    });
    Object.assign(bindingConflict.data, { roomTypeId, currentRevision: 1 });
    calls.post.mockRejectedValue(bindingConflict);
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith(`/room-type-bindings/${encodeURIComponent(draftRoomId)}`)) {
        return { propertyId, draftRoomId, roomTypeId };
      }
      if (endpoint.endsWith(`/room-types/${roomTypeId}`)) return factsSnapshot();
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    const client = createRoomAuthoringClient(http, mediaHttp, calls.uploadFetch);

    await expect(
      client.ensureRoomTarget({ propertyId, room: completeRoom() }),
    ).resolves.toMatchObject({
      roomTypeId,
      roomFactsRevision: 1,
    });
    expect(calls.post).toHaveBeenCalledOnce();
    expect(calls.get).toHaveBeenCalledWith(
      `/api/pms/properties/${propertyId}/room-type-bindings/${encodeURIComponent(draftRoomId)}`,
      { cache: "no-store" },
    );
    expect(calls.put).not.toHaveBeenCalled();
  });

  it("fails closed without writing when the canonical facts revision is stale", async () => {
    calls.get.mockResolvedValue({
      ...factsSnapshot(),
      roomFactsRevision: 2,
      facts: { ...facts(), name: "Server-edited Garden Suite" },
    });
    const client = createRoomAuthoringClient(http, mediaHttp, calls.uploadFetch);
    const room = {
      ...completeRoom(),
      roomTypeId,
      roomFactsRevision: 1,
      name: "Locally edited Garden Suite",
    };

    const result = client.ensureRoomTarget({ propertyId, room });
    await expect(result).rejects.toBeInstanceOf(RoomAuthoringOwnerError);
    await expect(result).rejects.toMatchObject({
      code: "room_facts_revision_conflict",
      requiresRefresh: true,
    });
    expect(calls.put).not.toHaveBeenCalled();
    expect(calls.post).not.toHaveBeenCalled();
  });

  it("treats an inactive canonical room as a refresh-required conflict", async () => {
    calls.get.mockResolvedValue({
      ...factsSnapshot(),
      lifecycle: "inactive",
      roomFactsRevision: 2,
    });
    const client = createRoomAuthoringClient(http, mediaHttp, calls.uploadFetch);
    const room = { ...completeRoom(), roomTypeId, roomFactsRevision: 1 };

    const result = client.ensureRoomTarget({ propertyId, room });
    await expect(result).rejects.toBeInstanceOf(RoomAuthoringOwnerError);
    await expect(result).rejects.toMatchObject({
      code: "room_facts_revision_conflict",
      requiresRefresh: true,
    });
    expect(calls.put).not.toHaveBeenCalled();
  });

  it("rejects well-formed create and delete receipts from another owner scope", async () => {
    const wrongCreate = createFactsResponse();
    wrongCreate.roomType.propertyId = otherPropertyId;
    wrongCreate.draftRoomBinding.propertyId = otherPropertyId;
    calls.post.mockResolvedValue(wrongCreate);
    const client = createRoomAuthoringClient(http, mediaHttp, calls.uploadFetch);

    await expect(client.ensureRoomTarget({ propertyId, room: completeRoom() })).rejects.toThrow(
      /returned invalid data/i,
    );

    calls.delete.mockResolvedValue({
      contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
      outcome: "deleted",
      propertyId: otherPropertyId,
      roomTypeId,
      lifecycle: "inactive",
      deletedRevision: 2,
      acceptedAt: now,
    });
    await expect(
      client.removeRoom(propertyId, {
        ...completeRoom(),
        roomTypeId,
        roomFactsRevision: 1,
      }),
    ).rejects.toThrow(/returned invalid data/i);
  });

  it("rejects a capacity snapshot for a different canonical room", async () => {
    const room = { ...completeRoom(), roomTypeId, roomFactsRevision: 1 };
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith(`/room-types/${roomTypeId}`)) return factsSnapshot();
      if (endpoint.endsWith(`/room-types/${roomTypeId}/capacity`)) {
        return {
          ...capacity(1, 3),
          roomTypeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        };
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    const client = createRoomAuthoringClient(http, mediaHttp, calls.uploadFetch);

    await expect(client.saveRoom({ propertyId, room })).rejects.toThrow(/returned invalid data/i);
    expect(calls.put).not.toHaveBeenCalled();
  });

  it("uploads only against the returned canonical room UUID, never the draft ID", async () => {
    calls.mediaPost
      .mockResolvedValueOnce({
        contractVersion: "platform-media-upload.v2",
        uploadSession: { sessionId: "room-upload-1", status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: "target-1",
            clientFileId: "file_1",
            method: "PUT",
            uploadUrl: "https://uploads.example/room.jpg",
            headers: { "content-type": "image/jpeg" },
          },
        ],
      })
      .mockResolvedValueOnce({
        contractVersion: "platform-media-upload.v2",
        mediaObjects: [
          {
            mediaObjectId,
            purpose: "pms.room_type.media",
            status: "private_ready",
            publicVariants: [],
          },
        ],
      });
    calls.uploadFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const client = createRoomAuthoringClient(http, mediaHttp, calls.uploadFetch);
    const file = new File([new Uint8Array([1, 2, 3])], "room.jpg", {
      type: "image/jpeg",
    });

    await expect(
      client.uploadRoomPhotos({ propertyId, roomTypeId, draftRoomId, files: [file] }),
    ).resolves.toEqual([
      expect.objectContaining({ mediaObjectId, purpose: "pms.room_type.media" }),
    ]);

    const createRequest = calls.mediaPost.mock.calls[0]?.[1] as {
      resource: { resourceId: string; targetResourceId: string };
    };
    expect(createRequest.resource).toMatchObject({
      resourceId: propertyId,
      targetResourceId: roomTypeId,
    });
    expect(createRequest.resource.targetResourceId).not.toBe(draftRoomId);
    expect(JSON.stringify(createRequest)).not.toContain('targetResourceId":"draft:');
  });

  it("correlates reversed multi-file upload targets by client file id", async () => {
    const secondMediaObjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    calls.mediaPost
      .mockResolvedValueOnce({
        contractVersion: "platform-media-upload.v2",
        uploadSession: { sessionId: "room-upload-2", status: "signed" },
        uploadTargets: [
          {
            uploadTargetId: "target-2",
            clientFileId: "file_2",
            method: "PUT",
            uploadUrl: "https://uploads.example/second.jpg",
            headers: { "content-type": "image/jpeg" },
          },
          {
            uploadTargetId: "target-1",
            clientFileId: "file_1",
            method: "PUT",
            uploadUrl: "https://uploads.example/first.jpg",
            headers: { "content-type": "image/jpeg" },
          },
        ],
      })
      .mockResolvedValueOnce({
        contractVersion: "platform-media-upload.v2",
        mediaObjects: [
          {
            mediaObjectId,
            purpose: "pms.room_type.media",
            status: "private_ready",
            publicVariants: [],
          },
          {
            mediaObjectId: secondMediaObjectId,
            purpose: "pms.room_type.media",
            status: "private_ready",
            publicVariants: [],
          },
        ],
      });
    calls.uploadFetch.mockResolvedValue(new Response(null, { status: 200 }));
    const client = createRoomAuthoringClient(http, mediaHttp, calls.uploadFetch);
    const first = new File([new Uint8Array([1])], "first.jpg", { type: "image/jpeg" });
    const second = new File([new Uint8Array([2])], "second.jpg", { type: "image/jpeg" });

    await client.uploadRoomPhotos({
      propertyId,
      roomTypeId,
      draftRoomId,
      files: [first, second],
    });

    expect(calls.uploadFetch.mock.calls[0]?.[0]).toBe("https://uploads.example/first.jpg");
    expect(calls.uploadFetch.mock.calls[0]?.[1]?.body).toBe(first);
    expect(calls.uploadFetch.mock.calls[1]?.[0]).toBe("https://uploads.example/second.jpg");
    expect(calls.uploadFetch.mock.calls[1]?.[1]?.body).toBe(second);
    expect(calls.mediaPost.mock.calls[1]?.[1]).toEqual({
      files: [
        expect.objectContaining({ uploadTargetId: "target-1" }),
        expect.objectContaining({ uploadTargetId: "target-2" }),
      ],
    });
  });

  it("saves units, ordered media, and explicit reviewed-empty amenities without pricing or calendar", async () => {
    const room = {
      ...completeRoom(),
      roomTypeId,
      roomFactsRevision: 1,
    };
    let capacityReads = 0;
    let publicationReads = 0;
    calls.get.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith(`/room-types/${roomTypeId}`)) return factsSnapshot();
      if (endpoint.endsWith(`/room-types/${roomTypeId}/capacity`)) {
        capacityReads += 1;
        return capacity(capacityReads === 1 ? 1 : 2, capacityReads === 1 ? 1 : 3);
      }
      if (endpoint.endsWith("/room-publication-snapshot")) {
        publicationReads += 1;
        return publication(publicationReads === 1);
      }
      throw new Error(`Unexpected GET ${endpoint}`);
    });
    calls.put.mockImplementation(async (endpoint) => {
      if (endpoint.endsWith("/physical-units/reconcile")) return reconcileResponse();
      if (endpoint.endsWith("/media")) return mediaResponse();
      if (endpoint.endsWith("/amenities")) return amenitiesResponse();
      throw new Error(`Unexpected PUT ${endpoint}`);
    });
    const client = createRoomAuthoringClient(http, mediaHttp, calls.uploadFetch);

    await expect(client.saveRoom({ propertyId, room })).resolves.toMatchObject({
      roomTypeId,
      activeUnitCount: 3,
      roomFactsRevision: 1,
      roomUnitsRevision: 2,
      roomMediaRevision: 2,
      roomAmenitiesRevision: 2,
      amenityKeys: [],
      amenitiesReviewed: true,
    });

    expect(calls.put.mock.calls.find(([endpoint]) => endpoint.endsWith("/amenities"))?.[1]).toEqual(
      { expectedRoomAmenitiesRevision: 1, amenities: [] },
    );
    expect(
      calls.put.mock.calls.find(([endpoint]) => endpoint.endsWith("/media"))?.[1],
    ).toMatchObject({
      expectedRoomMediaRevision: 1,
      assignments: [{ mediaObjectId, sortOrder: 0 }],
    });
    expect(
      calls.put.mock.calls.some(
        ([endpoint]) => endpoint === `/api/pms/properties/${propertyId}/room-types/${roomTypeId}`,
      ),
    ).toBe(false);
    const allEndpoints = [
      ...calls.get.mock.calls.map(([endpoint]) => endpoint),
      ...calls.put.mock.calls.map(([endpoint]) => endpoint),
      ...calls.post.mock.calls.map(([endpoint]) => endpoint),
    ].join(" ");
    expect(allEndpoints).not.toMatch(/pricing|calendar/);
  });
});

function completeRoom(): RoomAuthoringDraft {
  return {
    ...createEmptyRoomDraft(() => draftRoomId),
    name: "Garden Suite",
    unitCount: "3",
    maxGuests: "2",
    beds: [{ id: `${draftRoomId}:bed:1`, type: "king", quantity: "1" }],
    bathroomType: "private",
    bathrooms: "1",
    photos: [
      {
        mediaObjectId,
        previewUrl: null,
        uploadState: "ready",
        errorMessage: null,
      },
    ],
    reviewedEmptyAmenities: true,
    dirty: true,
  };
}

function facts() {
  return {
    name: "Garden Suite",
    description: "",
    category: null,
    occupancy: { maxGuests: 2, maxAdults: 2, maxChildren: 2 },
    beds: [{ type: "king", quantity: 1 }],
    bedrooms: null,
    bathrooms: 1,
    bathroomType: "private",
    size: null,
  };
}

function factsSnapshot() {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomFactsRevision: 1,
    lifecycle: "active",
    facts: facts(),
    createdAt: now,
    updatedAt: now,
  };
}

function createFactsResponse() {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    outcome: "created",
    roomType: factsSnapshot(),
    draftRoomBinding: { propertyId, draftRoomId, roomTypeId },
    acceptedAt: now,
  };
}

function capacity(roomUnitsRevision: number, activeUnitCount: number) {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomUnitsRevision,
    activeUnitCount,
    capturedAt: now,
  };
}

function reconcileResponse() {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    outcome: "reconciled",
    propertyId,
    roomTypeId,
    previousActiveUnitCount: 1,
    capacity: capacity(2, 3),
    addedUnits: [
      physicalUnit("55555555-5555-4555-8555-555555555555"),
      physicalUnit("66666666-6666-4666-8666-666666666666"),
    ],
    retiredUnitIds: [],
    acceptedAt: now,
  };
}

function physicalUnit(roomUnitId: string) {
  return {
    contractVersion: PMS_ROOM_FACTS_CONTRACT_VERSION,
    propertyId,
    roomTypeId,
    roomUnitId,
    lifecycle: "active",
    operationalLabel: null,
    operationalLabelStatus: "unverified",
  };
}

function publication(initial: boolean) {
  return {
    contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
    propertyId,
    rooms: [
      {
        propertyId,
        roomTypeId,
        facts: facts(),
        activeUnitCount: 3,
        media: initial
          ? []
          : [
              {
                mediaObjectId,
                altText: "Garden Suite photo 1",
                sortOrder: 0,
                publicVariants: [
                  {
                    variantName: "thumbnail",
                    publicUrl: `https://images.example/${mediaObjectId}/thumbnail.webp`,
                  },
                ],
              },
            ],
        amenities: initial ? null : [],
        sourceRevisions: {
          roomFactsRevision: 1,
          roomUnitsRevision: 2,
          roomMediaRevision: initial ? 1 : 2,
          roomAmenitiesRevision: initial ? 1 : 2,
        },
      },
    ],
  };
}

function mediaResponse() {
  return {
    contractVersion: PMS_ROOM_PUBLICATION_CONTRACT_VERSION,
    outcome: "assigned",
    propertyId,
    roomTypeId,
    roomMediaRevision: 2,
    assignments: [{ mediaObjectId, altText: "Garden Suite photo 1", sortOrder: 0 }],
    acceptedAt: now,
  };
}

function amenitiesResponse() {
  return {
    contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
    outcome: "confirmed",
    roomAmenities: {
      contractVersion: PMS_ROOM_AMENITIES_CONTRACT_VERSION,
      propertyId,
      roomTypeId,
      roomAmenitiesRevision: 2,
      reviewed: true,
      amenities: [],
      reviewedAt: now,
    },
    acceptedAt: now,
  };
}
