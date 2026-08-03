import { parseSavePropertySetupDraftRequest } from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import {
  RoomDraftManifestUnavailableError,
  buildRoomsDraftRequest,
  createEmptyRoomDraft,
  hydrateRoomDrafts,
  roomDraftToFacts,
  validateRoomDraft,
  type RoomAuthoringDraft,
  type RoomDraftRevisionContext,
} from "./roomAuthoringState";

const mediaObjectId = "55555555-5555-4555-8555-555555555555";

describe("room authoring state", () => {
  it("validates complete facts and serializes generated units plus reviewed-empty amenities", () => {
    const room = completeRoom();

    expect(validateRoomDraft(room, [room])).toEqual({});
    expect(roomDraftToFacts(room)).toMatchObject({
      name: "Garden Suite",
      occupancy: { maxGuests: 4, maxAdults: 4, maxChildren: 4 },
      beds: [{ type: "king", quantity: 1 }],
      bathroomType: "private",
    });

    const request = buildRoomsDraftRequest([room], revisionManifest());
    expect(parseSavePropertySetupDraftRequest(request)).toMatchObject({ ok: true });
    expect(request).toMatchObject({
      stepId: "rooms",
      expectedBaseRevisions: {
        "pms.room_types": "types:1",
        "pms.room_units": "units:1",
        "pms.room_media": "media:1",
      },
      payload: {
        "room.name": { [room.draftRoomId]: "Garden Suite" },
        "room.unit_count": { [room.draftRoomId]: 3 },
        "room.images": { [room.draftRoomId]: [mediaObjectId] },
        "room.amenities": {
          [room.draftRoomId]: { keys: [], reviewedEmpty: true },
        },
      },
    });
  });

  it("rejects duplicate names and incomplete media or amenity review", () => {
    const first = completeRoom();
    const duplicate = {
      ...completeRoom("draft:77777777-7777-4777-8777-777777777777"),
      name: " garden suite ",
      photos: [],
      reviewedEmptyAmenities: false,
    };

    expect(validateRoomDraft(duplicate, [first, duplicate])).toMatchObject({
      name: "Room type names must be unique.",
      photos: "Add at least one room photo.",
      amenities: "Choose room amenities or confirm that none apply.",
    });
  });

  it("blocks save until every failed photo is retried or removed", () => {
    const room = completeRoom();
    room.photos.push({
      mediaObjectId: "upload:failed-photo",
      previewUrl: "blob:failed-photo",
      uploadState: "failed",
      errorMessage: "Upload failed.",
    });

    expect(validateRoomDraft(room, [room])).toMatchObject({
      photos: "Retry or remove every failed photo before saving.",
    });
  });

  it("does not mark canonical facts complete before media and amenities are complete", () => {
    const room = completeRoom();
    const [hydrated] = hydrateRoomDrafts(
      null,
      [
        {
          draftRoomId: room.draftRoomId,
          roomTypeId: "88888888-8888-4888-8888-888888888888",
          roomFactsRevision: 1,
          roomUnitsRevision: 1,
          roomMediaRevision: 1,
          roomAmenitiesRevision: 1,
          facts: roomDraftToFacts(room),
          activeUnitCount: 3,
          photos: [],
          amenityKeys: [],
          amenitiesReviewed: false,
        },
      ],
      { ensureBlank: false },
    );

    expect(hydrated).toMatchObject({ saved: false, roomTypeId: expect.any(String) });
  });

  it("fails closed without the exact first-visit revision manifest", () => {
    const revision = revisionManifest();
    revision.baseRevisions = null;

    expect(() => buildRoomsDraftRequest([completeRoom()], revision)).toThrow(
      RoomDraftManifestUnavailableError,
    );
  });
});

function completeRoom(
  draftRoomId = "draft:44444444-4444-4444-8444-444444444444",
): RoomAuthoringDraft {
  return {
    ...createEmptyRoomDraft(() => draftRoomId),
    name: "Garden Suite",
    unitCount: "3",
    maxGuests: "4",
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
    amenityKeys: [],
    reviewedEmptyAmenities: true,
    dirty: true,
  };
}

function revisionManifest(): RoomDraftRevisionContext {
  return {
    sessionId: "33333333-3333-4333-8333-333333333333",
    trackRevision: 3,
    sessionRevision: 7,
    draftRevision: 4,
    baseRevisions: {
      "pms.room_types": "types:1",
      "pms.room_units": "units:1",
      "pms.room_media": "media:1",
    },
  };
}
