import {
  createMarketplaceHotelCollaborationPreferencesEvidence,
  type MarketplaceHotelCollaborationPreferences,
} from "@vayada/domain-marketplace";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMarketplacePreferencesClient } from "./marketplacePreferencesClient";

const propertyId = "11111111-1111-4111-8111-111111111111";
const otherPropertyId = "22222222-2222-4222-8222-222222222222";
const now = "2026-08-04T12:00:00.000Z";
const calls = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
const client = createMarketplacePreferencesClient(calls);
const preferences: MarketplaceHotelCollaborationPreferences = {
  compensationTypes: ["free_stay"],
  contentPlatforms: ["instagram"],
  contentTypes: ["short_form_video"],
  availability: { mode: "selected_months", selectedMonths: [5, 6] },
};

describe("marketplacePreferencesClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads the explicit revision-zero unanswered document", async () => {
    calls.get.mockResolvedValue({
      contractVersion: "marketplace-hotel-collaboration-preferences.v1",
      propertyId,
      revision: 0,
      sourceRevision: "preferences:0",
      preferences: null,
      readiness: createMarketplaceHotelCollaborationPreferencesEvidence(propertyId, 0, null),
    });
    await expect(client.load(propertyId)).resolves.toMatchObject({
      revision: 0,
      preferences: null,
    });
  });

  it("sends a complete replacement and rejects cross-property receipts", async () => {
    calls.put.mockResolvedValue(response(propertyId));
    await expect(
      client.save(propertyId, { expectedRevision: 0, ...preferences }),
    ).resolves.toMatchObject({ revision: 1, preferences });
    expect(calls.put).toHaveBeenCalledWith(
      `/api/marketplace/properties/${propertyId}/hotel-collaboration-preferences`,
      { expectedRevision: 0, ...preferences },
      expect.any(Object),
    );

    calls.put.mockResolvedValue(response(otherPropertyId));
    await expect(client.save(propertyId, { expectedRevision: 0, ...preferences })).rejects.toThrow(
      /response is invalid/i,
    );
  });
});

function response(targetPropertyId: string) {
  return {
    contractVersion: "marketplace-hotel-collaboration-preferences.v1",
    propertyId: targetPropertyId,
    revision: 1,
    sourceRevision: "preferences:1",
    preferences,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(
      targetPropertyId,
      1,
      preferences,
    ),
    outcome: "updated",
    acceptedAt: now,
  };
}
