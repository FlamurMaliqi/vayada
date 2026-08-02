import { describe, expect, it } from "vitest";

import {
  PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
  type PropertySetupSession,
  type PropertySetupStepDraft,
  type PropertySetupStepId,
} from "./propertySetupDraft.js";
import {
  PROPERTY_SETUP_ROUTE_CONTRACT_VERSION,
  buildPropertySetupRoute,
  type BuildPropertySetupRouteInput,
  type PropertySetupOwnerStepFact,
  type PropertySetupOwnerStepState,
} from "./propertySetupRoute.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const marketplaceRoute = ["present_hotel", "marketplace_preferences", "review"] as const;
const operationsRoute = [
  "present_hotel",
  "booking_design",
  "rooms",
  "pricing",
  "calendar",
  "guest_experience",
  "payments",
  "review",
] as const;
const combinedRoute = [
  "present_hotel",
  "marketplace_preferences",
  ...operationsRoute.slice(1),
] as const;

describe("property setup route", () => {
  it.each([
    [["creator_marketplace"], marketplaceRoute],
    [["hotel_operations"], operationsRoute],
    [["creator_marketplace", "hotel_operations"], combinedRoute],
  ] as const)("projects the approved route for tracks %j", (selectedTracks, expected) => {
    const route = project({ selectedTracks });

    expect(route.contractVersion).toBe(PROPERTY_SETUP_ROUTE_CONTRACT_VERSION);
    expect(route).toMatchObject({
      scope: { organizationId, propertyId },
      trackRevision: 7,
      sessionRevision: null,
    });
    expect(route.steps.map(({ stepId }) => stepId)).toEqual(expected);
    expect(route.steps.map(({ position }) => position)).toEqual(
      expected.map((_, index) => index + 1),
    );
    expect(route.selectedTracks).toEqual(
      selectedTracks.length === 2 ? ["hotel_operations", "creator_marketplace"] : selectedTracks,
    );
    expect(route.progress).toEqual({ complete: 0, total: expected.length });
  });

  it("applies state precedence and recognizes a zero-dirty retained draft", () => {
    const roomBlocker = {
      code: "room_details_incomplete",
      product: "pms",
      ownerDomain: "pms",
      owningStepId: "rooms",
      message: "Complete the room details.",
      kind: "user_fixable",
      sourceRevision: "pms-rooms-r2",
    } as const;
    const session = makeSession({
      completedStepIds: ["marketplace_preferences", "booking_design", "rooms"],
      drafts: [
        draft("present_hotel", ["profile.short_description"]),
        draft("marketplace_preferences", ["marketplace.preferences.content_types"]),
        draft("booking_design", ["booking.primary_color"]),
        draft("rooms", ["room.name"]),
        draft("pricing", ["rate.currency"]),
        draft("calendar", []),
      ],
    });
    const route = project({
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      session,
      ownerFacts: [
        fact("present_hotel", "complete"),
        fact("marketplace_preferences", "saved"),
        fact("booking_design", "not_started"),
        { ...fact("rooms", "blocked"), blockers: [roomBlocker] },
        fact("guest_experience", "not_started"),
      ],
    });

    expect(
      Object.fromEntries(route.steps.map(({ stepId, state }) => [stepId, state])),
    ).toMatchObject({
      present_hotel: "complete",
      marketplace_preferences: "saved",
      booking_design: "draft",
      rooms: "blocked",
      pricing: "draft",
      calendar: "draft",
      guest_experience: "not_started",
    });
    expect(route.progress).toEqual({ complete: 1, total: 9 });
  });

  it("filters hidden state without mutating it and restores stable step IDs", () => {
    const blocker = {
      code: "booking_design_invalid",
      product: "booking",
      ownerDomain: "booking",
      owningStepId: "booking_design",
      affectedEntity: { entityType: "design_preset", entityId: "modern" },
      message: "Choose an available booking page style.",
      kind: "user_fixable",
      sourceRevision: "booking-design-r2",
    } as const;
    const session = makeSession({
      selectedTracks: ["creator_marketplace", "hotel_operations"],
      resumeStepId: "booking_design",
      completedStepIds: ["rooms"],
      drafts: [
        draft("booking_design", ["booking.font_pairing"]),
        draft("pricing", ["rate.currency"]),
      ],
    });
    const ownerFacts = [{ ...fact("booking_design", "blocked"), blockers: [blocker] }];
    const retainedInput = structuredClone({ session, ownerFacts });

    const marketplace = project({
      selectedTracks: ["creator_marketplace"],
      session,
      ownerFacts,
    });
    const combined = project({
      selectedTracks: ["hotel_operations", "creator_marketplace"],
      session,
      ownerFacts,
    });

    expect(marketplace.resumeStepId).toBeNull();
    expect(marketplace.progress).toEqual({ complete: 0, total: 3 });
    expect(marketplace.steps.find(({ stepId }) => stepId === "booking_design")).toBeUndefined();
    expect(marketplace.steps.find(({ stepId }) => stepId === "rooms")).toBeUndefined();
    expect(marketplace.steps.every(({ blockers }) => blockers.length === 0)).toBe(true);
    expect(marketplace.steps.some(({ draft: activeDraft }) => activeDraft !== null)).toBe(false);
    expect(combined.resumeStepId).toBe("booking_design");
    expect(combined.sessionRevision).toBe(5);
    expect(combined.steps.find(({ stepId }) => stepId === "booking_design")).toMatchObject({
      stepId: "booking_design",
      position: 3,
      state: "blocked",
      draft: {
        stepId: "booking_design",
        payload: { "booking.font_pairing": "draft-value" },
        dirtyFields: ["booking.font_pairing"],
        baseRevisions: {},
        revision: 3,
      },
      blockers: [{ ...blocker, owningStepPosition: 3 }],
    });
    expect(combined.steps.find(({ stepId }) => stepId === "rooms")?.state).toBe("complete");
    expect(combined.steps.find(({ stepId }) => stepId === "pricing")?.state).toBe("draft");
    expect({ session, ownerFacts }).toEqual(retainedInput);
  });

  it("rejects duplicate route inputs, out-of-scope owner facts, and mismatched sessions", () => {
    const duplicate = fact("present_hotel", "saved");
    expect(() => project({ ownerFacts: [duplicate, duplicate] })).toThrow(/Duplicate/);
    expect(() =>
      project({
        session: makeSession({
          drafts: [draft("present_hotel", ["profile.name"]), draft("present_hotel", [])],
        }),
      }),
    ).toThrow(/Duplicate property setup draft/);
    expect(() =>
      project({
        ownerFacts: [{ ...fact("present_hotel", "saved"), propertyId: "another-property" }],
      }),
    ).toThrow(/outside the requested scope/);
    expect(() =>
      project({ session: makeSession({ organizationId: "another-organization" }) }),
    ).toThrow(/outside the requested scope/);
    expect(() =>
      project({
        selectedTracks: ["hotel_operations"],
        ownerFacts: [
          {
            ...fact("review", "blocked"),
            blockers: [
              {
                code: "marketplace_profile_incomplete",
                product: "marketplace",
                ownerDomain: "marketplace",
                owningStepId: "marketplace_preferences",
                message: "Complete the Marketplace preferences.",
                kind: "user_fixable",
                sourceRevision: "marketplace-r2",
              },
            ],
          },
        ],
      }),
    ).toThrow(/blocker for inactive step/);
    expect(() => project({ ownerFacts: [fact("present_hotel", "blocked")] })).toThrow(
      /pair blocked state with blockers/,
    );
  });
});

function project(overrides: Partial<BuildPropertySetupRouteInput> = {}) {
  return buildPropertySetupRoute({
    organizationId,
    propertyId,
    selectedTracks: ["creator_marketplace"],
    trackRevision: 7,
    session: null,
    ownerFacts: [],
    ...overrides,
  });
}

function fact(
  stepId: PropertySetupStepId,
  state: PropertySetupOwnerStepState,
): PropertySetupOwnerStepFact {
  return {
    organizationId,
    propertyId,
    stepId,
    state,
    sourceRevision: `${stepId}-r1`,
    blockers: [],
  };
}

function draft(stepId: PropertySetupStepId, dirtyFields: string[]): PropertySetupStepDraft {
  return {
    stepId,
    payload: Object.fromEntries(dirtyFields.map((field) => [field, "draft-value"])),
    dirtyFields,
    baseRevisions: {},
    piiClassification: "potential_incidental_pii",
    retentionExpiresAt: "2026-10-30T00:00:00.000Z",
    revision: 3,
    updatedAt: "2026-07-30T00:00:00.000Z",
  } as PropertySetupStepDraft;
}

function makeSession(overrides: Partial<PropertySetupSession> = {}): PropertySetupSession {
  return {
    contractVersion: PROPERTY_SETUP_DRAFT_CONTRACT_VERSION,
    sessionId: "33333333-3333-4333-8333-333333333333",
    organizationId,
    propertyId,
    selectedTracks: ["creator_marketplace"],
    trackRevision: 2,
    revision: 5,
    resumeStepId: null,
    completedStepIds: [],
    drafts: [],
    retentionExpiresAt: "2026-10-30T00:00:00.000Z",
    ...overrides,
  };
}
