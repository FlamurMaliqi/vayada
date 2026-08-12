import { describe, expect, it } from "vitest";

import {
  ROOM_MEDIA_MAX_ALT_TEXT_LENGTH,
  ROOM_MEDIA_MAX_ITEMS,
  parseReplaceRoomMediaRequest,
  parseRoomMediaCommandError,
  parseRoomMediaCommandResponse,
} from "./roomMedia.js";

const firstMediaId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondMediaId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("room media command contract", () => {
  it("accepts a complete replacement, reorder, and explicit removal", () => {
    const request = {
      expectedRoomMediaRevision: 3,
      assignments: [
        { mediaObjectId: secondMediaId.toUpperCase(), altText: "Suite view", sortOrder: 0 },
        { mediaObjectId: firstMediaId, altText: null, sortOrder: 1 },
      ],
    };
    const parsed = parseReplaceRoomMediaRequest(request);
    expect(parsed).not.toBeNull();
    expect(parsed?.assignments[0]?.mediaObjectId).toBe(secondMediaId);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.assignments)).toBe(true);
    expect(Object.isFrozen(parsed?.assignments[0])).toBe(true);
    request.assignments[0]!.altText = "mutated";
    expect(parsed?.assignments[0]?.altText).toBe("Suite view");
    expect(
      parseReplaceRoomMediaRequest({
        expectedRoomMediaRevision: 3,
        assignments: [],
      }),
    ).not.toBeNull();
  });

  it("bounds room media alt text", () => {
    expect(
      parseReplaceRoomMediaRequest({
        expectedRoomMediaRevision: 3,
        assignments: [
          {
            mediaObjectId: firstMediaId,
            altText: "a".repeat(ROOM_MEDIA_MAX_ALT_TEXT_LENGTH),
            sortOrder: 0,
          },
        ],
      }),
    ).not.toBeNull();
    expect(
      parseReplaceRoomMediaRequest({
        expectedRoomMediaRevision: 3,
        assignments: [
          {
            mediaObjectId: firstMediaId,
            altText: "a".repeat(ROOM_MEDIA_MAX_ALT_TEXT_LENGTH + 1),
            sortOrder: 0,
          },
        ],
      }),
    ).toBeNull();
  });

  it("accepts PostgreSQL UUID versions beyond the legacy v1-v5 range", () => {
    for (const mediaObjectId of [
      "00000000-0000-0000-8000-000000000001",
      "00000000-0000-7000-9000-000000000002",
      "00000000-0000-8000-a000-000000000003",
    ]) {
      expect(
        parseReplaceRoomMediaRequest({
          expectedRoomMediaRevision: 3,
          assignments: [{ mediaObjectId, altText: null, sortOrder: 0 }],
        }),
      ).not.toBeNull();
    }
  });

  it("accepts an ordered compatibility snapshot while legacy URLs remain", () => {
    const parsed = parseReplaceRoomMediaRequest({
      expectedRoomMediaRevision: 3,
      assignments: [{ mediaObjectId: firstMediaId, altText: "New photo", sortOrder: 0 }],
      legacyMediaSnapshot: [
        {
          mediaObjectId: null,
          url: "https://legacy.example.com/room.webp",
          altText: null,
          sortOrder: 0,
        },
        {
          mediaObjectId: firstMediaId,
          url: "https://cdn.example.com/new.webp",
          altText: "New photo",
          sortOrder: 1,
        },
      ],
    });

    expect(parsed?.legacyMediaSnapshot).toHaveLength(2);
    expect(Object.isFrozen(parsed?.legacyMediaSnapshot)).toBe(true);
    expect(
      parseReplaceRoomMediaRequest({
        expectedRoomMediaRevision: 3,
        assignments: [{ mediaObjectId: firstMediaId, altText: null, sortOrder: 0 }],
        legacyMediaSnapshot: [
          {
            mediaObjectId: firstMediaId,
            url: "https://cdn.example.com/new.webp",
            altText: null,
            sortOrder: 0,
          },
        ],
      }),
    ).toBeNull();
  });

  it("rejects duplicate media, gaps, oversized sets, and unknown fields", () => {
    expect(
      parseReplaceRoomMediaRequest({
        expectedRoomMediaRevision: 3,
        assignments: [
          { mediaObjectId: firstMediaId, altText: null, sortOrder: 0 },
          { mediaObjectId: firstMediaId.toUpperCase(), altText: null, sortOrder: 1 },
        ],
      }),
    ).toBeNull();
    expect(
      parseReplaceRoomMediaRequest({
        expectedRoomMediaRevision: 3,
        assignments: [{ mediaObjectId: firstMediaId, altText: null, sortOrder: 1 }],
      }),
    ).toBeNull();
    expect(
      parseReplaceRoomMediaRequest({
        expectedRoomMediaRevision: 3,
        assignments: Array.from({ length: ROOM_MEDIA_MAX_ITEMS + 1 }, (_, index) => ({
          mediaObjectId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          altText: null,
          sortOrder: index,
        })),
      }),
    ).toBeNull();
    expect(
      parseReplaceRoomMediaRequest({
        expectedRoomMediaRevision: 3,
        assignments: [],
        legacyUrls: [],
      }),
    ).toBeNull();
  });

  it("validates strict command results and safe errors", () => {
    const responseSource = {
      outcome: "updated" as const,
      roomMediaRevision: 4,
      assignments: [{ mediaObjectId: firstMediaId, altText: null, sortOrder: 0 }],
    };
    const response = parseRoomMediaCommandResponse(responseSource);
    expect(response).not.toBeNull();
    expect(Object.isFrozen(response)).toBe(true);
    responseSource.assignments[0]!.sortOrder = 9;
    expect(response?.assignments[0]?.sortOrder).toBe(0);
    expect(
      parseRoomMediaCommandResponse({
        outcome: "updated",
        roomMediaRevision: 4,
        assignments: [{ mediaObjectId: firstMediaId, altText: null, sortOrder: 0 }],
      }),
    ).not.toBeNull();
    expect(
      parseRoomMediaCommandError({
        code: "room_media_revision_conflict",
        currentRevision: 4,
      }),
    ).not.toBeNull();
    expect(parseRoomMediaCommandError({ code: "idempotency_key_conflict" })).not.toBeNull();
    expect(
      parseRoomMediaCommandError({
        code: "media_not_ready",
        mediaObjectIds: [firstMediaId.toUpperCase(), secondMediaId],
      }),
    ).toEqual({ code: "media_not_ready", mediaObjectIds: [firstMediaId, secondMediaId] });
    expect(
      parseRoomMediaCommandError({
        code: "media_not_ready",
        mediaObjectIds: [firstMediaId],
        privateUrl: "https://private.example/image",
      }),
    ).toBeNull();
  });

  it("rejects inherited, accessor, hidden, sparse, and subclassed shapes", () => {
    const inherited = Object.create({ expectedRoomMediaRevision: 3 }) as Record<string, unknown>;
    inherited["assignments"] = [];
    expect(parseReplaceRoomMediaRequest(inherited)).toBeNull();

    const accessor = { assignments: [] } as Record<string, unknown>;
    Object.defineProperty(accessor, "expectedRoomMediaRevision", {
      enumerable: true,
      get: () => 3,
    });
    expect(parseReplaceRoomMediaRequest(accessor)).toBeNull();

    const hidden = { expectedRoomMediaRevision: 3, assignments: [] };
    Object.defineProperty(hidden, "legacy", { enumerable: false, value: [] });
    expect(parseReplaceRoomMediaRequest(hidden)).toBeNull();

    const sparse = new Array(1);
    expect(
      parseReplaceRoomMediaRequest({ expectedRoomMediaRevision: 3, assignments: sparse }),
    ).toBeNull();

    class Assignments extends Array<unknown> {}
    expect(
      parseReplaceRoomMediaRequest({
        expectedRoomMediaRevision: 3,
        assignments: new Assignments(),
      }),
    ).toBeNull();
  });
});
