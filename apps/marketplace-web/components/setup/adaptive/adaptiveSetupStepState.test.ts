import type { PropertySetupRouteReadModel } from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import {
  AdaptiveStepManifestUnavailableError,
  adaptiveStepDraftRevision,
  adaptiveStepResetRequest,
  draftRequest,
  exactSourceRevision,
  withDraftReceipt,
} from "./adaptiveSetupStepState";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-04T12:00:00.000Z";

describe("adaptiveSetupStepState", () => {
  it("retains a persisted draft's exact historical base manifest", () => {
    const route = setupRoute(true);
    const revision = adaptiveStepDraftRevision(route, route.steps[0]!, "present_hotel");

    expect(revision).toEqual({
      trackRevision: 4,
      sessionRevision: 8,
      draftRevision: 3,
      baseRevisions: {
        "hotel_catalog.profile": "profile:7",
        "hotel_catalog.media": "profile:7",
        "hotel_catalog.amenities": "profile:7",
      },
    });
    expect(
      draftRequest(revision, {
        stepId: "present_hotel",
        payload: { "profile.short_description": "unfinished text" },
        dirtyFields: ["profile.short_description"],
      }),
    ).toMatchObject({
      expectedTrackRevision: 4,
      expectedSessionRevision: 8,
      expectedDraftRevision: 3,
      expectedBaseRevisions: revision.baseRevisions,
    });
  });

  it("uses the current manifest for the first draft save", () => {
    const route = setupRoute(false);
    const revision = adaptiveStepDraftRevision(route, route.steps[0]!, "present_hotel");
    expect(
      draftRequest(revision, {
        stepId: "present_hotel",
        payload: { "profile.short_description": "local text stays local" },
        dirtyFields: ["profile.short_description"],
      }),
    ).toMatchObject({
      expectedDraftRevision: 0,
      expectedBaseRevisions: {
        "hotel_catalog.profile": "profile:11",
        "hotel_catalog.media": "profile:11",
        "hotel_catalog.amenities": "profile:11",
      },
    });
  });

  it("builds reset CAS only from the persisted historical draft manifest", () => {
    const route = setupRoute(true);
    expect(adaptiveStepResetRequest(route, route.steps[0]!, "present_hotel")).toEqual({
      sessionId,
      stepId: "present_hotel",
      expectedTrackRevision: 4,
      expectedSessionRevision: 8,
      expectedDraftRevision: 3,
      expectedBaseRevisions: {
        "hotel_catalog.profile": "profile:7",
        "hotel_catalog.media": "profile:7",
        "hotel_catalog.amenities": "profile:7",
      },
    });
    expect(
      adaptiveStepResetRequest(setupRoute(false), setupRoute(false).steps[0]!, "present_hotel"),
    ).toBeNull();
  });

  it("fails closed when no validated manifest is available", () => {
    expect(() =>
      draftRequest(
        {
          trackRevision: 4,
          sessionRevision: 8,
          draftRevision: 3,
          baseRevisions: null,
        },
        {
          stepId: "present_hotel",
          payload: { "profile.short_description": "local text stays local" },
          dirtyFields: ["profile.short_description"],
        },
      ),
    ).toThrow(AdaptiveStepManifestUnavailableError);
  });

  it("advances only session and draft revisions after a successful draft receipt", () => {
    const route = setupRoute(true);
    const revision = adaptiveStepDraftRevision(route, route.steps[0]!, "present_hotel");
    const next = withDraftReceipt(revision, {
      contractVersion: "property-setup-draft.v1",
      sessionId,
      stepId: "present_hotel",
      selectedTracks: ["hotel_operations"],
      trackRevision: 4,
      sessionRevision: 9,
      draftRevision: 4,
      retentionExpiresAt: now,
      updatedAt: now,
      replayed: false,
    });
    expect(next.baseRevisions).toBe(revision.baseRevisions);
    expect(next).toMatchObject({ sessionRevision: 9, draftRevision: 4 });
  });

  it("accepts only exact aggregate revision tokens", () => {
    expect(exactSourceRevision("preferences:0", "preferences")).toBe(0);
    expect(exactSourceRevision("design:42", "design")).toBe(42);
    expect(exactSourceRevision("aggregate:preferences:42", "preferences")).toBeNull();
    expect(exactSourceRevision("profile:01", "profile")).toBeNull();
  });
});

function setupRoute(withDraft: boolean): PropertySetupRouteReadModel {
  return {
    contractVersion: "property-setup-route.v2",
    scope: { organizationId, propertyId },
    selectedTracks: ["hotel_operations"],
    trackRevision: 4,
    sessionId: withDraft ? sessionId : null,
    sessionRevision: withDraft ? 8 : null,
    resumeStepId: withDraft ? "present_hotel" : null,
    progress: { complete: 0, total: 1 },
    steps: [
      {
        stepId: "present_hotel",
        position: 1,
        state: withDraft ? "draft" : "not_started",
        sourceRevision: "profile:7",
        currentBaseRevisions: {
          "hotel_catalog.profile": "profile:11",
          "hotel_catalog.media": "profile:11",
          "hotel_catalog.amenities": "profile:11",
        },
        draft: withDraft
          ? {
              stepId: "present_hotel",
              payload: { "profile.short_description": "unfinished text" },
              dirtyFields: ["profile.short_description"],
              baseRevisions: {
                "hotel_catalog.profile": "profile:7",
                "hotel_catalog.media": "profile:7",
                "hotel_catalog.amenities": "profile:7",
              },
              piiClassification: "potential_incidental_pii",
              retentionExpiresAt: now,
              revision: 3,
              updatedAt: now,
            }
          : null,
        blockers: [],
      },
    ],
  };
}
