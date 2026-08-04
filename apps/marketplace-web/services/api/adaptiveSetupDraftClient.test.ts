import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAdaptiveSetupDraftClient,
  type AdaptiveSetupDraftHttpClient,
} from "./adaptiveSetupDraftClient";

const propertyId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-04T12:00:00.000Z";
const put = vi.fn<AdaptiveSetupDraftHttpClient["put"]>();

describe("adaptiveSetupDraftClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves an exact manifest-bound draft without exposing payload values in metadata", async () => {
    put.mockResolvedValue({
      contractVersion: "property-setup-draft.v1",
      sessionId,
      stepId: "present_hotel",
      selectedTracks: ["hotel_operations"],
      trackRevision: 3,
      sessionRevision: 1,
      draftRevision: 1,
      retentionExpiresAt: now,
      updatedAt: now,
      replayed: false,
    });
    const client = createAdaptiveSetupDraftClient({
      put: put as AdaptiveSetupDraftHttpClient["put"],
    });
    const request = {
      stepId: "present_hotel" as const,
      payload: { "profile.short_description": "A private unfinished description" },
      dirtyFields: ["profile.short_description" as const],
      expectedBaseRevisions: {
        "hotel_catalog.profile": "profile:7",
        "hotel_catalog.media": "profile:7",
        "hotel_catalog.amenities": "profile:7",
      },
      expectedTrackRevision: 3,
      expectedSessionRevision: 0,
      expectedDraftRevision: 0,
    };

    await expect(client.save(propertyId, request)).resolves.toMatchObject({
      sessionId,
      draftRevision: 1,
    });
    expect(put).toHaveBeenCalledWith(
      `/api/hotel-setup/properties/${propertyId}/setup-drafts/present_hotel`,
      request,
      expect.any(Object),
    );
    const key = new Headers(put.mock.calls[0]?.[2]?.headers).get("Idempotency-Key");
    expect(key).toMatch(/^setup-draft:present_hotel:/);
    expect(key).not.toContain("unfinished");
  });

  it("rejects malformed receipts fail-closed", async () => {
    put.mockResolvedValue({
      contractVersion: "property-setup-draft.v1",
      sessionId,
      stepId: "present_hotel",
      selectedTracks: ["hotel_operations"],
      trackRevision: 3,
      sessionRevision: 1,
      draftRevision: 1,
      retentionExpiresAt: "not-a-date",
      updatedAt: now,
      replayed: false,
    });
    const client = createAdaptiveSetupDraftClient({
      put: put as AdaptiveSetupDraftHttpClient["put"],
    });

    await expect(
      client.save(propertyId, {
        stepId: "present_hotel",
        payload: {},
        dirtyFields: [],
        expectedBaseRevisions: {
          "hotel_catalog.profile": "profile:7",
          "hotel_catalog.media": "profile:7",
          "hotel_catalog.amenities": "profile:7",
        },
        expectedTrackRevision: 3,
        expectedSessionRevision: 0,
        expectedDraftRevision: 0,
      }),
    ).rejects.toThrow(/response is invalid/i);
  });
});
