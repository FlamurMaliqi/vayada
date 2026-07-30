import { describe, expect, it } from "vitest";

import {
  parsePropertyMediaCommandError,
  parsePropertyMediaCommandResponse,
} from "./propertyMediaWire.js";

const mediaObjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

describe("property media wire contract", () => {
  it("strictly parses CAS command responses", () => {
    const response = {
      outcome: "updated",
      profileRevision: 5,
      logoAssignment: { mediaObjectId, role: "logo", altText: null, sortOrder: 0 },
      presentationAssignments: [{ mediaObjectId, role: "cover", altText: null, sortOrder: 0 }],
    };
    expect(parsePropertyMediaCommandResponse(response)).toEqual(response);
    const parsed = parsePropertyMediaCommandResponse(response);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.presentationAssignments)).toBe(true);
    (response.presentationAssignments[0] as { altText: string | null }).altText = "mutated";
    expect(parsed?.presentationAssignments[0]?.altText).toBeNull();
    expect(parsePropertyMediaCommandResponse({ ...response, profileRevision: 0 })).toBeNull();
    expect(parsePropertyMediaCommandResponse({ ...response, legacyImages: [] })).toBeNull();
  });

  it("strictly parses revision and media command errors", () => {
    expect(
      parsePropertyMediaCommandError({
        code: "profile_revision_conflict",
        currentRevision: 5,
      }),
    ).not.toBeNull();
    expect(
      parsePropertyMediaCommandError({
        code: "media_not_ready",
        mediaObjectIds: [mediaObjectId],
      }),
    ).not.toBeNull();
    expect(
      parsePropertyMediaCommandError({
        code: "media_not_ready",
        mediaObjectIds: [],
      }),
    ).toBeNull();
    const canonical = parsePropertyMediaCommandError({
      code: "media_not_ready",
      mediaObjectIds: [mediaObjectId.toUpperCase()],
    });
    expect(canonical).toEqual({ code: "media_not_ready", mediaObjectIds: [mediaObjectId] });
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(
      Object.isFrozen(canonical && "mediaObjectIds" in canonical ? canonical.mediaObjectIds : null),
    ).toBe(true);
    expect(
      parsePropertyMediaCommandError({
        code: "media_not_ready",
        mediaObjectIds: [mediaObjectId, mediaObjectId.toUpperCase()],
      }),
    ).toBeNull();
  });

  it("rejects inherited, accessor, hidden, symbolic, sparse, and subclassed shapes", () => {
    const inherited = Object.create({ code: "profile_revision_conflict" }) as Record<
      string,
      unknown
    >;
    inherited["currentRevision"] = 5;
    expect(parsePropertyMediaCommandError(inherited)).toBeNull();

    const accessor = { currentRevision: 5 } as Record<string, unknown>;
    Object.defineProperty(accessor, "code", {
      enumerable: true,
      get: () => "profile_revision_conflict",
    });
    expect(parsePropertyMediaCommandError(accessor)).toBeNull();

    const hidden = { code: "profile_revision_conflict", currentRevision: 5 };
    Object.defineProperty(hidden, "legacy", { enumerable: false, value: true });
    expect(parsePropertyMediaCommandError(hidden)).toBeNull();

    const symbolic = { code: "profile_revision_conflict", currentRevision: 5 };
    Object.defineProperty(symbolic, Symbol("legacy"), { enumerable: true, value: true });
    expect(parsePropertyMediaCommandError(symbolic)).toBeNull();

    const sparse = new Array(1) as string[];
    expect(
      parsePropertyMediaCommandError({ code: "media_not_ready", mediaObjectIds: sparse }),
    ).toBeNull();

    class MediaIds extends Array<string> {}
    expect(
      parsePropertyMediaCommandError({
        code: "media_not_ready",
        mediaObjectIds: new MediaIds(mediaObjectId),
      }),
    ).toBeNull();
  });
});
