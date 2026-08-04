import { SETUP_TRACKS, type SetupTrack } from "./adaptiveHotelSetup.js";
import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  getActivePropertySetupStepIds,
  isPropertySetupBaseRevisionManifest,
  type PropertySetupBaseRevisionManifest,
  type PropertySetupSession,
  type PropertySetupStepDraft,
  type PropertySetupStepId,
} from "./propertySetupDraft.js";

export const PROPERTY_SETUP_ROUTE_CONTRACT_VERSION = "property-setup-route.v2" as const;
export const PROPERTY_SETUP_ROUTE_STEP_STATES = [
  "not_started",
  "draft",
  "saved",
  "complete",
  "blocked",
] as const;

export type PropertySetupRouteStepState = (typeof PROPERTY_SETUP_ROUTE_STEP_STATES)[number];
export type PropertySetupOwnerStepState = Exclude<PropertySetupRouteStepState, "draft">;
export type PropertySetupBlockerKind = "user_fixable" | "external_pending" | "system_error";
export type PropertySetupOwnerDomain =
  | "hotel_catalog"
  | "marketplace"
  | "booking"
  | "pms"
  | "finance"
  | "distribution";

export type PropertySetupOwnerStepBlocker = {
  code: string;
  product: PropertySetupOwnerDomain;
  ownerDomain: PropertySetupOwnerDomain;
  owningStepId: PropertySetupStepId;
  affectedEntity?: { entityType: string; entityId: string };
  /** Safe to display to the hotel owner. */
  message: string;
  kind: PropertySetupBlockerKind;
  sourceRevision: string;
};

export type PropertySetupRouteBlocker = PropertySetupOwnerStepBlocker & {
  owningStepPosition: number;
};

export type PropertySetupOwnerStepFact = {
  organizationId: string;
  propertyId: string;
  stepId: PropertySetupStepId;
  state: PropertySetupOwnerStepState;
  sourceRevision: string;
  /** Exact current owner revisions for the step's draft dependency keys. */
  currentBaseRevisions: PropertySetupBaseRevisionManifest;
  blockers: PropertySetupOwnerStepBlocker[];
};

export type BuildPropertySetupRouteInput = {
  organizationId: string;
  propertyId: string;
  selectedTracks: readonly SetupTrack[];
  trackRevision: number;
  session: PropertySetupSession | null;
  ownerFacts: readonly PropertySetupOwnerStepFact[];
};

export type PropertySetupRouteReadModel = {
  contractVersion: typeof PROPERTY_SETUP_ROUTE_CONTRACT_VERSION;
  scope: { organizationId: string; propertyId: string };
  selectedTracks: SetupTrack[];
  trackRevision: number;
  sessionId: string | null;
  sessionRevision: number | null;
  resumeStepId: PropertySetupStepId | null;
  progress: { complete: number; total: number };
  steps: Array<{
    stepId: PropertySetupStepId;
    position: number;
    state: PropertySetupRouteStepState;
    sourceRevision: string;
    /** Current owner manifest for a first save; never replaces persisted draft history. */
    currentBaseRevisions: PropertySetupBaseRevisionManifest;
    /**
     * Rehydration data for this active step. Callers must supply a session
     * already filtered to the actor's authorized draft step IDs.
     */
    draft: PropertySetupStepDraft | null;
    blockers: PropertySetupRouteBlocker[];
  }>;
};

const STEP_IDS = new Set(PROPERTY_SETUP_STEP_DEFINITIONS.map(({ stepId }) => stepId));

export function buildPropertySetupRoute(
  input: BuildPropertySetupRouteInput,
): PropertySetupRouteReadModel {
  const selectedTracks = normalizeTracks(input.selectedTracks);
  if (!Number.isSafeInteger(input.trackRevision) || input.trackRevision < 0) {
    throw new TypeError("Property setup track revision must be a non-negative safe integer.");
  }
  if (
    input.session &&
    (input.session.organizationId !== input.organizationId ||
      input.session.propertyId !== input.propertyId)
  ) {
    throw new TypeError("Property setup session is outside the requested scope.");
  }
  // Drafts and completion intentionally survive track changes. The active
  // projection below hides out-of-route state until its track is restored.

  const facts = indexOwnerFacts(input);
  const activeStepIds = getActivePropertySetupStepIds(selectedTracks);
  const activePositions = new Map(activeStepIds.map((stepId, index) => [stepId, index + 1]));
  const drafts = indexSessionDrafts(input.session);
  const completed = new Set(input.session?.completedStepIds ?? []);

  const steps = activeStepIds.map((stepId, index) => {
    const fact = facts.get(stepId);
    if (!fact) {
      throw new TypeError(`Missing property setup owner fact for active step "${stepId}".`);
    }
    const draft = drafts.get(stepId);
    const blockers = fact.blockers.map((blocker) => {
      const owningStepPosition = activePositions.get(blocker.owningStepId);
      if (owningStepPosition === undefined) {
        // Exposed blockers must always navigate to an active owning step.
        throw new TypeError(
          `Active property setup fact "${stepId}" has a blocker for inactive step "${blocker.owningStepId}".`,
        );
      }
      return {
        ...blocker,
        owningStepPosition,
      };
    });
    const state = mergeStepState(fact.state, completed.has(stepId), draft !== undefined);

    return {
      stepId,
      position: index + 1,
      state,
      sourceRevision: fact.sourceRevision,
      currentBaseRevisions: structuredClone(fact.currentBaseRevisions),
      draft: draft ? structuredClone(draft) : null,
      blockers,
    };
  });

  return {
    contractVersion: PROPERTY_SETUP_ROUTE_CONTRACT_VERSION,
    scope: { organizationId: input.organizationId, propertyId: input.propertyId },
    selectedTracks,
    trackRevision: input.trackRevision,
    sessionId: input.session?.sessionId ?? null,
    sessionRevision: input.session?.revision ?? null,
    resumeStepId:
      input.session?.resumeStepId && activePositions.has(input.session.resumeStepId)
        ? input.session.resumeStepId
        : null,
    progress: {
      complete: steps.filter(({ state }) => state === "complete").length,
      total: steps.length,
    },
    steps,
  };
}

function indexSessionDrafts(
  session: PropertySetupSession | null,
): Map<PropertySetupStepId, PropertySetupStepDraft> {
  const drafts = new Map<PropertySetupStepId, PropertySetupStepDraft>();
  for (const draft of session?.drafts ?? []) {
    if (drafts.has(draft.stepId)) {
      throw new TypeError(`Duplicate property setup draft for step "${draft.stepId}".`);
    }
    drafts.set(draft.stepId, draft);
  }
  return drafts;
}

function normalizeTracks(selectedTracks: readonly SetupTrack[]): SetupTrack[] {
  const selected = new Set(selectedTracks);
  if (
    selectedTracks.length === 0 ||
    selected.size !== selectedTracks.length ||
    selectedTracks.some((track) => !SETUP_TRACKS.includes(track))
  ) {
    throw new TypeError("Property setup route requires unique supported tracks.");
  }
  return SETUP_TRACKS.filter((track) => selected.has(track));
}

function indexOwnerFacts(
  input: Pick<BuildPropertySetupRouteInput, "organizationId" | "propertyId" | "ownerFacts">,
): Map<PropertySetupStepId, PropertySetupOwnerStepFact> {
  const facts = new Map<PropertySetupStepId, PropertySetupOwnerStepFact>();
  for (const fact of input.ownerFacts) {
    if (fact.organizationId !== input.organizationId || fact.propertyId !== input.propertyId) {
      throw new TypeError("Property setup owner fact is outside the requested scope.");
    }
    if (!STEP_IDS.has(fact.stepId)) {
      throw new TypeError(`Unknown property setup step fact "${String(fact.stepId)}".`);
    }
    if (facts.has(fact.stepId)) {
      throw new TypeError(`Duplicate property setup owner fact for step "${fact.stepId}".`);
    }
    if ((fact.state === "blocked") !== fact.blockers.length > 0) {
      throw new TypeError(
        `Property setup owner fact "${fact.stepId}" must pair blocked state with blockers.`,
      );
    }
    if (!isPropertySetupBaseRevisionManifest(fact.stepId, fact.currentBaseRevisions)) {
      throw new TypeError(
        `Property setup owner fact "${fact.stepId}" has an invalid current base-revision manifest.`,
      );
    }
    const unknownBlocker = fact.blockers.find(({ owningStepId }) => !STEP_IDS.has(owningStepId));
    if (unknownBlocker) {
      throw new TypeError(
        `Property setup owner fact "${fact.stepId}" has an unknown blocker step "${String(unknownBlocker.owningStepId)}".`,
      );
    }
    facts.set(fact.stepId, fact);
  }
  return facts;
}

function mergeStepState(
  ownerState: PropertySetupOwnerStepState | undefined,
  sessionComplete: boolean,
  hasDraft: boolean,
): PropertySetupRouteStepState {
  if (ownerState === "blocked") return "blocked";
  if (ownerState === "complete") return "complete";
  if (ownerState === "saved") return "saved";
  // Canonical owner facts win; session completion is a fallback only until an
  // owner projection exists for the step.
  if (ownerState === undefined && sessionComplete) return "complete";
  return hasDraft ? "draft" : "not_started";
}
