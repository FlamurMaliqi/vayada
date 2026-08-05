import {
  PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
  PROPERTY_SETUP_STEP_DEFINITIONS,
  buildPropertySetupRoute,
  getActivePropertySetupStepIds,
  type PropertySetupSession,
  type PropertySetupStepId,
  type SetupTrack,
} from "@vayada/domain-hotels";
import { describe, expect, it, vi } from "vitest";

import {
  PROPERTY_SETUP_STATE_PROVIDER_KEYS,
  createPropertySetupRouteStateReadPort,
  type PropertySetupOwnerStateProviderPort,
  type PropertySetupOwnerStateRequest,
  type PropertySetupStateProviderKey,
} from "./platform/propertySetupRouteState.js";
import type {
  PropertySetupRouteOwnerStepFact,
  PropertySetupRouteStateReadInput,
} from "./routes/propertySetupRoute.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const actorUserId = "33333333-3333-4333-8333-333333333333";
const selectedTracks = ["hotel_operations", "creator_marketplace"] as const;

describe("property setup route state composition", () => {
  it("preserves canonical progress separately from draft and launch-readiness state", async () => {
    const draftRepository = {
      getActiveSession: vi.fn(async () => sessionWithBookingDraft()),
    };
    const providers = makeProviders(selectedTracks, {
      present_hotel: "complete",
      marketplace_preferences: "saved",
      booking_design: "not_started",
      rooms: "saved",
      guest_experience: "blocked",
      review: "blocked",
    });
    const port = createPropertySetupRouteStateReadPort({
      draftRepository,
      trackRepository: trackRepository(selectedTracks, 4),
      ownerStateProviders: providers,
    });

    const result = await port.getPropertySetupRouteState(input(selectedTracks));

    expect(result).toMatchObject({
      outcome: "found",
      trackRevision: 4,
      session: { drafts: [{ stepId: "booking_design" }] },
      ownerFacts: [
        { stepId: "present_hotel", state: "complete" },
        { stepId: "marketplace_preferences", state: "saved" },
        { stepId: "booking_design", state: "not_started" },
        { stepId: "rooms", state: "saved" },
        { stepId: "pricing", state: "not_started" },
        { stepId: "calendar", state: "not_started" },
        { stepId: "guest_experience", state: "blocked" },
        { stepId: "payments", state: "not_started" },
        { stepId: "review", state: "blocked" },
      ],
    });
    expect(draftRepository.getActiveSession).toHaveBeenCalledWith({
      organizationId,
      propertyId,
      actorUserId,
      authorizedStepIds: getActivePropertySetupStepIds(selectedTracks),
    });
    expect(providers.booking?.getOwnerState).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        propertyId,
        actorUserId,
        selectedTracks: [...selectedTracks],
        expectedTrackRevision: 4,
        stepIds: ["booking_design", "guest_experience"],
      }),
    );
    expect(providers.review_lifecycle?.getOwnerState).toHaveBeenCalledWith(
      expect.objectContaining({ stepIds: ["review"] }),
    );
    if (result.outcome !== "found") throw new Error("Expected a composed route state");
    expect(
      buildPropertySetupRoute({
        organizationId,
        propertyId,
        selectedTracks,
        trackRevision: result.trackRevision,
        session: result.session,
        ownerFacts: result.ownerFacts,
      }).steps.map(({ stepId, state }) => [stepId, state]),
    ).toEqual([
      ["present_hotel", "complete"],
      ["marketplace_preferences", "saved"],
      ["booking_design", "draft"],
      ["rooms", "saved"],
      ["pricing", "not_started"],
      ["calendar", "not_started"],
      ["guest_experience", "blocked"],
      ["payments", "not_started"],
      ["review", "blocked"],
    ]);
  });

  it("requests only owners needed by the selected route", async () => {
    const providers = makeProviders(["creator_marketplace"]);
    const port = createPropertySetupRouteStateReadPort({
      draftRepository: { getActiveSession: vi.fn(async () => null) },
      trackRepository: trackRepository(["creator_marketplace"], 4),
      ownerStateProviders: providers,
    });

    const result = await port.getPropertySetupRouteState(input(["creator_marketplace"]));

    expect(result).toMatchObject({
      outcome: "found",
      ownerFacts: [
        { stepId: "present_hotel" },
        { stepId: "marketplace_preferences" },
        { stepId: "review" },
      ],
    });
    expect(providers.hotel_catalog?.getOwnerState).toHaveBeenCalledTimes(1);
    expect(providers.marketplace?.getOwnerState).toHaveBeenCalledTimes(1);
    expect(providers.review_lifecycle?.getOwnerState).toHaveBeenCalledTimes(1);
    expect(providers.booking).toBeUndefined();
    expect(providers.pms).toBeUndefined();
    expect(providers.finance).toBeUndefined();
  });

  it("fails closed when a required owner is missing or unavailable", async () => {
    const missing = makeProviders(selectedTracks);
    delete missing.finance;
    const missingPort = createPropertySetupRouteStateReadPort({
      draftRepository: { getActiveSession: vi.fn(async () => null) },
      trackRepository: trackRepository(selectedTracks, 4),
      ownerStateProviders: missing,
    });
    await expect(missingPort.getPropertySetupRouteState(input(selectedTracks))).resolves.toEqual({
      outcome: "provider_failure",
    });

    const failed = makeProviders(selectedTracks);
    failed.finance = {
      getOwnerState: vi.fn(async () => ({ outcome: "provider_failure" as const })),
    };
    const failedPort = createPropertySetupRouteStateReadPort({
      draftRepository: { getActiveSession: vi.fn(async () => null) },
      trackRepository: trackRepository(selectedTracks, 4),
      ownerStateProviders: failed,
    });
    await expect(failedPort.getPropertySetupRouteState(input(selectedTracks))).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("rejects incomplete, cross-tenant, or wrongly attributed owner snapshots", async () => {
    const invalidFacts: Array<(fact: PropertySetupRouteOwnerStepFact) => unknown> = [
      () => [],
      (fact) => [{ ...fact, organizationId: "another-organization" }],
      (fact) => [{ ...fact, product: "booking" }],
    ];

    for (const mutate of invalidFacts) {
      const providers = makeProviders(["creator_marketplace"]);
      providers.marketplace = {
        getOwnerState: vi.fn(async (request) => {
          const fact = ownerFact(request.stepIds[0]!);
          return {
            outcome: "found" as const,
            facts: mutate(fact) as readonly PropertySetupRouteOwnerStepFact[],
          };
        }),
      };
      const port = createPropertySetupRouteStateReadPort({
        draftRepository: { getActiveSession: vi.fn(async () => null) },
        trackRepository: trackRepository(["creator_marketplace"], 4),
        ownerStateProviders: providers,
      });

      await expect(
        port.getPropertySetupRouteState(input(["creator_marketplace"])),
      ).resolves.toEqual({ outcome: "provider_failure" });
    }
  });

  it("fails closed when independent owners disagree on a shared current revision", async () => {
    const providers = makeProviders(selectedTracks);
    providers.booking = {
      getOwnerState: vi.fn(async (request: PropertySetupOwnerStateRequest) => ({
        outcome: "found" as const,
        facts: request.stepIds.map((stepId) => {
          const fact = ownerFact(stepId);
          return stepId === "booking_design"
            ? {
                ...fact,
                currentBaseRevisions: {
                  ...fact.currentBaseRevisions,
                  "hotel_catalog.profile": "revision:2",
                },
              }
            : fact;
        }),
      })),
    };
    const port = createPropertySetupRouteStateReadPort({
      draftRepository: { getActiveSession: vi.fn(async () => null) },
      trackRepository: trackRepository(selectedTracks, 4),
      ownerStateProviders: providers,
    });

    await expect(port.getPropertySetupRouteState(input(selectedTracks))).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("fails closed for malformed persisted historical drafts", async () => {
    const session = sessionWithBookingDraft();
    session.drafts[0]!.baseRevisions = {
      "booking.design": "design-r1",
      "hotel_catalog.profile": "profile-r1",
    } as never;
    const port = createPropertySetupRouteStateReadPort({
      draftRepository: { getActiveSession: vi.fn(async () => session) },
      trackRepository: trackRepository(selectedTracks, 4),
      ownerStateProviders: makeProviders(selectedTracks),
    });

    await expect(port.getPropertySetupRouteState(input(selectedTracks))).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("returns not found when a canonical owner cannot find the property", async () => {
    const providers = makeProviders(["creator_marketplace"]);
    providers.hotel_catalog = {
      getOwnerState: vi.fn(async () => ({
        outcome: "not_found" as const,
        providerKey: "hotel_catalog" as const,
      })),
    };
    const port = createPropertySetupRouteStateReadPort({
      draftRepository: { getActiveSession: vi.fn(async () => null) },
      trackRepository: trackRepository(["creator_marketplace"], 4),
      ownerStateProviders: providers,
    });

    await expect(port.getPropertySetupRouteState(input(["creator_marketplace"]))).resolves.toEqual({
      outcome: "not_found",
    });
  });

  it("treats not-found from a product owner as provider failure", async () => {
    const providers = makeProviders(["creator_marketplace"]);
    providers.marketplace = {
      getOwnerState: vi.fn(async () => ({
        outcome: "not_found" as const,
        providerKey: "hotel_catalog" as const,
      })),
    };
    const port = createPropertySetupRouteStateReadPort({
      draftRepository: { getActiveSession: vi.fn(async () => null) },
      trackRepository: trackRepository(["creator_marketplace"], 4),
      ownerStateProviders: providers,
    });

    await expect(port.getPropertySetupRouteState(input(["creator_marketplace"]))).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("checks track revision after all owner snapshots have been composed", async () => {
    const events: string[] = [];
    const providers = makeProviders(["creator_marketplace"], {}, events);
    providers.marketplace = {
      getOwnerState: vi.fn(() => {
        events.push("marketplace_failure");
        throw new Error("owner unavailable");
      }),
    };
    const port = createPropertySetupRouteStateReadPort({
      draftRepository: {
        getActiveSession: vi.fn(async () => {
          events.push("draft");
          return null;
        }),
      },
      trackRepository: {
        getTrackStatus: vi.fn(async () => {
          events.push("track");
          return {
            trackRevision: 5,
            selectedTracks: ["hotel_operations"] as SetupTrack[],
            tracks: [],
          };
        }),
      },
      ownerStateProviders: providers,
    });

    await expect(port.getPropertySetupRouteState(input(["creator_marketplace"]))).resolves.toEqual({
      outcome: "track_revision_conflict",
      currentRevision: 5,
    });
    expect(events.at(-1)).toBe("track");
  });
});

function input(selected: readonly SetupTrack[]): PropertySetupRouteStateReadInput {
  return {
    organizationId,
    propertyId,
    actorUserId,
    selectedTracks: selected,
    expectedTrackRevision: 4,
    authorizedDraftStepIds: getActivePropertySetupStepIds(selected),
  };
}

function makeProviders(
  selected: readonly SetupTrack[],
  states: Partial<Record<PropertySetupStepId, PropertySetupRouteOwnerStepFact["state"]>> = {},
  events?: string[],
): Partial<Record<PropertySetupStateProviderKey, PropertySetupOwnerStateProviderPort>> {
  const active = getActivePropertySetupStepIds(selected);
  const providers: Partial<
    Record<PropertySetupStateProviderKey, PropertySetupOwnerStateProviderPort>
  > = {};
  for (const providerKey of PROPERTY_SETUP_STATE_PROVIDER_KEYS) {
    const stepIds = active.filter((stepId) => providerFor(stepId) === providerKey);
    if (stepIds.length === 0) continue;
    providers[providerKey] = {
      getOwnerState: vi.fn(async (request: PropertySetupOwnerStateRequest) => {
        events?.push(providerKey);
        return {
          outcome: "found" as const,
          facts: request.stepIds.map((stepId) => ownerFact(stepId, states[stepId])),
        };
      }),
    };
  }
  return providers;
}

function ownerFact(
  stepId: PropertySetupStepId,
  state: PropertySetupRouteOwnerStepFact["state"] = "not_started",
): PropertySetupRouteOwnerStepFact {
  const provenance = ownerProvenance(stepId);
  return {
    organizationId,
    propertyId,
    stepId,
    ...provenance,
    state,
    sourceRevision: `${stepId}-r1`,
    currentBaseRevisions: Object.fromEntries(
      PROPERTY_SETUP_STEP_DEFINITIONS.find(
        (definition) => definition.stepId === stepId,
      )!.baseRevisionKeys.map((key) => [key, "revision:1"]),
    ),
    blockers:
      state === "blocked"
        ? [
            {
              code: `${stepId}_incomplete`,
              product: provenance.product,
              ownerDomain: provenance.ownerDomain,
              owningStepId: stepId === "review" ? "guest_experience" : stepId,
              message: "Complete this setup step.",
              kind: "user_fixable",
              sourceRevision: `${stepId}-r1`,
            },
          ]
        : [],
  };
}

function providerFor(stepId: PropertySetupStepId): PropertySetupStateProviderKey {
  if (stepId === "present_hotel") return "hotel_catalog";
  if (stepId === "marketplace_preferences") return "marketplace";
  if (stepId === "booking_design" || stepId === "guest_experience") return "booking";
  if (stepId === "rooms" || stepId === "pricing" || stepId === "calendar") return "pms";
  if (stepId === "payments") return "finance";
  return "review_lifecycle";
}

function ownerProvenance(
  stepId: PropertySetupStepId,
): Pick<PropertySetupRouteOwnerStepFact, "product" | "ownerDomain"> {
  if (stepId === "marketplace_preferences") {
    return { product: "marketplace", ownerDomain: "marketplace" };
  }
  if (stepId === "booking_design" || stepId === "guest_experience") {
    return { product: "booking", ownerDomain: "booking" };
  }
  if (stepId === "rooms" || stepId === "pricing" || stepId === "calendar") {
    return { product: "pms", ownerDomain: "pms" };
  }
  if (stepId === "payments") return { product: "finance", ownerDomain: "finance" };
  return { product: "hotel_catalog", ownerDomain: "hotel_catalog" };
}

function trackRepository(selected: readonly SetupTrack[], revision: number) {
  return {
    getTrackStatus: vi.fn(async () => ({
      trackRevision: revision,
      selectedTracks: [...selected],
      tracks: [],
    })),
  };
}

function sessionWithBookingDraft(): PropertySetupSession {
  return {
    contractVersion: PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
    sessionId: "44444444-4444-4444-8444-444444444444",
    organizationId,
    propertyId,
    selectedTracks: [...selectedTracks],
    trackRevision: 4,
    revision: 3,
    resumeStepId: "booking_design",
    completedStepIds: [],
    drafts: [
      {
        stepId: "booking_design",
        payload: { "booking.primary_color": "#243ce5" },
        dirtyFields: ["booking.primary_color"],
        baseRevisions: {
          "booking.design": "design-r1",
          "hotel_catalog.profile": "profile-r1",
          "hotel_catalog.media": "media-r1",
        },
        piiClassification: "potential_incidental_pii",
        retentionExpiresAt: "2026-10-01T00:00:00.000Z",
        revision: 1,
        updatedAt: "2026-08-02T00:00:00.000Z",
      },
    ],
    retentionExpiresAt: "2026-10-01T00:00:00.000Z",
  };
}
