import {
  HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
  type HotelCatalogStep1ReadModel,
} from "@vayada/domain-hotels";
import {
  MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
  createMarketplaceHotelCollaborationPreferencesEvidence,
} from "@vayada/domain-marketplace";
import { describe, expect, it, vi } from "vitest";

import {
  createPropertySetupHotelCatalogStateProvider,
  createPropertySetupMarketplaceStateProvider,
} from "./platform/propertySetupCatalogMarketplaceState.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";

describe("property setup Catalog and Marketplace owner state", () => {
  it("projects the exact Step 1 manifest and canonical saved state", async () => {
    const readModel = catalogReadModel({ summary: "A".repeat(50), reviewed: false });
    const provider = createPropertySetupHotelCatalogStateProvider({
      getState: vi.fn(async () => ({ readModel, presentationAssignments: [] })),
    });

    await expect(provider.getOwnerState(request("present_hotel"))).resolves.toMatchObject({
      outcome: "found",
      facts: [
        {
          stepId: "present_hotel",
          state: "saved",
          sourceRevision: "profile:3",
          currentBaseRevisions: readModel.baseRevisions,
        },
      ],
    });
  });

  it("fails closed for malformed Catalog state and preserves canonical absence", async () => {
    const valid = catalogReadModel({ summary: "A".repeat(50), reviewed: true });
    const malformed = {
      ...valid,
      baseRevisions: { ...valid.baseRevisions, "hotel_catalog.media": "profile:2" },
    } as HotelCatalogStep1ReadModel;
    const malformedProvider = createPropertySetupHotelCatalogStateProvider({
      getState: vi.fn(async () => ({ readModel: malformed, presentationAssignments: [] })),
    });
    const missingProvider = createPropertySetupHotelCatalogStateProvider({
      getState: vi.fn(async () => null),
    });

    await expect(malformedProvider.getOwnerState(request("present_hotel"))).resolves.toEqual({
      outcome: "provider_failure",
    });
    await expect(missingProvider.getOwnerState(request("present_hotel"))).resolves.toEqual({
      outcome: "not_found",
      providerKey: "hotel_catalog",
    });
  });

  it("uses the typed Marketplace revision-zero omission and complete document", async () => {
    const missing = marketplaceReadModel(0);
    const complete = marketplaceReadModel(4);
    const getHotelCollaborationPreferences = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "available", readModel: missing })
      .mockResolvedValueOnce({ outcome: "available", readModel: complete });
    const provider = createPropertySetupMarketplaceStateProvider({
      getHotelCollaborationPreferences,
    });

    await expect(provider.getOwnerState(request("marketplace_preferences"))).resolves.toMatchObject(
      {
        outcome: "found",
        facts: [
          {
            state: "not_started",
            currentBaseRevisions: {
              "marketplace.collaboration_preferences": "preferences:0",
            },
          },
        ],
      },
    );
    await expect(provider.getOwnerState(request("marketplace_preferences"))).resolves.toMatchObject(
      {
        outcome: "found",
        facts: [{ state: "complete", sourceRevision: "preferences:4" }],
      },
    );
  });
});

function request(stepId: "present_hotel" | "marketplace_preferences") {
  return {
    organizationId,
    propertyId,
    actorUserId,
    selectedTracks: ["creator_marketplace"] as const,
    expectedTrackRevision: 2,
    stepIds: [stepId],
  };
}

function catalogReadModel(input: { summary: string | null; reviewed: boolean }) {
  return {
    contractVersion: HOTEL_CATALOG_STEP1_CONTRACT_VERSION,
    propertyId,
    displayName: "Hotel Example",
    profileRevision: 3,
    supportedLocales: ["en"],
    profile: {
      locale: "en",
      shortDescription: input.summary,
      publicSlug: input.summary ? "hotel-example" : null,
      amenities: { reviewed: input.reviewed, keys: [] },
      media: { coverMediaObjectId: null, galleryMediaObjectIds: [] },
    },
    baseRevisions: {
      "hotel_catalog.profile": "profile:3",
      "hotel_catalog.media": "profile:3",
      "hotel_catalog.amenities": "profile:3",
    },
  } satisfies HotelCatalogStep1ReadModel;
}

function marketplaceReadModel(revision: 0 | 4) {
  const preferences =
    revision === 0
      ? null
      : {
          compensationTypes: ["free_stay"] as const,
          contentPlatforms: ["instagram"] as const,
          contentTypes: ["post"] as const,
          availability: { mode: "year_round" as const, selectedMonths: [] as const },
        };
  return {
    contractVersion: MARKETPLACE_HOTEL_COLLABORATION_PREFERENCES_CONTRACT_VERSION,
    propertyId,
    revision,
    sourceRevision: `preferences:${revision}` as const,
    preferences,
    readiness: createMarketplaceHotelCollaborationPreferencesEvidence(
      propertyId,
      revision,
      preferences,
    ),
  };
}
