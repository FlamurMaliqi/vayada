import {
  PROPERTY_SETUP_ROUTE_STEP_STATES,
  SETUP_TRACKS,
  getActivePropertySetupStepIds,
  isPropertySetupBaseRevisionManifest,
  type PropertySetupOwnerDomain,
  type PropertySetupStepId,
  type SetupTrack,
} from "@vayada/domain-hotels";

import type { HotelSetupTrackCommandRepository } from "../domains/hotelSetupTrackCommandRepository.js";
import type { PropertySetupDraftRepository } from "../domains/propertySetupDraftRepository.js";
import type {
  PropertySetupRouteOwnerStepFact,
  PropertySetupRouteStateReadPort,
} from "../routes/propertySetupRoute.js";

export const PROPERTY_SETUP_STATE_PROVIDER_KEYS = [
  "hotel_catalog",
  "marketplace",
  "booking",
  "pms",
  "finance",
  "review_lifecycle",
] as const;

export type PropertySetupStateProviderKey = (typeof PROPERTY_SETUP_STATE_PROVIDER_KEYS)[number];

export type PropertySetupOwnerStateRequest = Readonly<{
  organizationId: string;
  propertyId: string;
  actorUserId: string;
  selectedTracks: readonly SetupTrack[];
  expectedTrackRevision: number;
  stepIds: readonly PropertySetupStepId[];
}>;

export type PropertySetupOwnerStateResult =
  | Readonly<{
      outcome: "found";
      facts: readonly PropertySetupRouteOwnerStepFact[];
    }>
  /** Only Hotel Catalog may establish that the canonical property is absent. */
  | Readonly<{ outcome: "not_found"; providerKey: "hotel_catalog" }>
  | Readonly<{ outcome: "provider_failure" }>;

/**
 * Reads actor-authorized, public-safe setup progress from one canonical owner.
 * Progress/current revisions are deliberately separate from launch readiness;
 * the lifecycle provider alone supplies the aggregate Review fact.
 */
export interface PropertySetupOwnerStateProviderPort {
  getOwnerState(request: PropertySetupOwnerStateRequest): Promise<PropertySetupOwnerStateResult>;
}

export type PropertySetupRouteStateOptions = {
  draftRepository: Pick<PropertySetupDraftRepository, "getActiveSession">;
  trackRepository: Pick<HotelSetupTrackCommandRepository, "getTrackStatus">;
  ownerStateProviders: Readonly<
    Partial<Record<PropertySetupStateProviderKey, PropertySetupOwnerStateProviderPort>>
  >;
};

/** Composes current owner progress with actor-authorized drafts without opening owner tables. */
export function createPropertySetupRouteStateReadPort(
  options: PropertySetupRouteStateOptions,
): PropertySetupRouteStateReadPort {
  return {
    async getPropertySetupRouteState(input) {
      try {
        const activeStepIds = getActivePropertySetupStepIds(input.selectedTracks);
        if (!validReadInput(input, activeStepIds)) return { outcome: "provider_failure" };
        const requests = ownerRequests(activeStepIds);

        const [draftResult, ...ownerResults] = await Promise.all([
          readDraft(options, input),
          ...requests.map(({ providerKey, stepIds }) => {
            const provider = options.ownerStateProviders[providerKey];
            return readOwnerState(
              provider,
              Object.freeze({
                organizationId: input.organizationId,
                propertyId: input.propertyId,
                actorUserId: input.actorUserId,
                selectedTracks: Object.freeze([...input.selectedTracks]),
                expectedTrackRevision: input.expectedTrackRevision,
                stepIds: Object.freeze([...stepIds]),
              }),
            );
          }),
        ]);

        // This is intentionally the final awaited read. A track change while
        // owner snapshots are loading wins over every provider outcome.
        const currentTrack = await options.trackRepository.getTrackStatus({
          organizationId: input.organizationId,
        });
        if (
          currentTrack.trackRevision !== input.expectedTrackRevision ||
          !sameTracks(currentTrack.selectedTracks, input.selectedTracks)
        ) {
          return {
            outcome: "track_revision_conflict",
            currentRevision: currentTrack.trackRevision,
          };
        }
        if (
          draftResult.outcome === "provider_failure" ||
          ownerResults.some((result) => result.outcome === "provider_failure")
        ) {
          return { outcome: "provider_failure" };
        }
        const unexpectedNotFound = ownerResults.some(
          (result, index) =>
            result.outcome === "not_found" &&
            (result.providerKey !== "hotel_catalog" ||
              requests[index]?.providerKey !== "hotel_catalog"),
        );
        if (unexpectedNotFound) return { outcome: "provider_failure" };
        if (ownerResults.some((result) => result.outcome === "not_found")) {
          return { outcome: "not_found" };
        }
        const foundOwnerResults = ownerResults.filter(
          (result): result is FoundOwnerResult => result.outcome === "found",
        );
        const ownerFacts = validateOwnerResults({
          organizationId: input.organizationId,
          propertyId: input.propertyId,
          selectedTracks: input.selectedTracks,
          activeStepIds,
          requests,
          results: foundOwnerResults,
        });

        return {
          outcome: "found",
          trackRevision: currentTrack.trackRevision,
          session: draftResult.session,
          ownerFacts,
        };
      } catch {
        return { outcome: "provider_failure" };
      }
    },
  };
}

type OwnerRequest = Readonly<{
  providerKey: PropertySetupStateProviderKey;
  stepIds: readonly PropertySetupStepId[];
}>;

type FoundOwnerResult = Extract<PropertySetupOwnerStateResult, { outcome: "found" }>;

type DraftReadResult =
  | Readonly<{
      outcome: "found";
      session: Awaited<ReturnType<PropertySetupDraftRepository["getActiveSession"]>>;
    }>
  | Readonly<{ outcome: "provider_failure" }>;

const PROVIDER_BY_STEP = {
  present_hotel: "hotel_catalog",
  marketplace_preferences: "marketplace",
  booking_design: "booking",
  rooms: "pms",
  pricing: "pms",
  calendar: "pms",
  guest_experience: "booking",
  payments: "finance",
  review: "review_lifecycle",
} as const satisfies Record<PropertySetupStepId, PropertySetupStateProviderKey>;

const PROVENANCE_BY_STEP = {
  present_hotel: { product: "hotel_catalog", ownerDomain: "hotel_catalog" },
  marketplace_preferences: { product: "marketplace", ownerDomain: "marketplace" },
  booking_design: { product: "booking", ownerDomain: "booking" },
  rooms: { product: "pms", ownerDomain: "pms" },
  pricing: { product: "pms", ownerDomain: "pms" },
  calendar: { product: "pms", ownerDomain: "pms" },
  guest_experience: { product: "booking", ownerDomain: "booking" },
  payments: { product: "finance", ownerDomain: "finance" },
  review: { product: "hotel_catalog", ownerDomain: "hotel_catalog" },
} as const satisfies Record<
  PropertySetupStepId,
  Pick<PropertySetupRouteOwnerStepFact, "product" | "ownerDomain">
>;

const OWNER_STATES = new Set(PROPERTY_SETUP_ROUTE_STEP_STATES.filter((state) => state !== "draft"));
const BLOCKER_KINDS = new Set(["user_fixable", "external_pending", "system_error"]);

async function readDraft(
  options: PropertySetupRouteStateOptions,
  input: Parameters<PropertySetupRouteStateReadPort["getPropertySetupRouteState"]>[0],
): Promise<DraftReadResult> {
  try {
    return {
      outcome: "found",
      session: await options.draftRepository.getActiveSession({
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        actorUserId: input.actorUserId,
        authorizedStepIds: input.authorizedDraftStepIds,
      }),
    };
  } catch {
    return { outcome: "provider_failure" };
  }
}

async function readOwnerState(
  provider: PropertySetupOwnerStateProviderPort | undefined,
  request: PropertySetupOwnerStateRequest,
): Promise<PropertySetupOwnerStateResult> {
  if (!provider) return { outcome: "provider_failure" };
  try {
    return await provider.getOwnerState(request);
  } catch {
    return { outcome: "provider_failure" };
  }
}

function ownerRequests(activeStepIds: readonly PropertySetupStepId[]): OwnerRequest[] {
  const stepsByProvider = new Map<PropertySetupStateProviderKey, PropertySetupStepId[]>();
  for (const stepId of activeStepIds) {
    const providerKey = PROVIDER_BY_STEP[stepId];
    const stepIds = stepsByProvider.get(providerKey) ?? [];
    stepIds.push(stepId);
    stepsByProvider.set(providerKey, stepIds);
  }
  return PROPERTY_SETUP_STATE_PROVIDER_KEYS.flatMap((providerKey) => {
    const stepIds = stepsByProvider.get(providerKey);
    return stepIds ? [{ providerKey, stepIds: Object.freeze(stepIds) }] : [];
  });
}

function validReadInput(
  input: Parameters<PropertySetupRouteStateReadPort["getPropertySetupRouteState"]>[0],
  activeStepIds: readonly PropertySetupStepId[],
): boolean {
  const active = new Set(activeStepIds);
  const authorized = new Set(input.authorizedDraftStepIds);
  return (
    nonEmpty(input.organizationId) &&
    nonEmpty(input.propertyId) &&
    nonEmpty(input.actorUserId) &&
    activeStepIds.length > 0 &&
    Number.isSafeInteger(input.expectedTrackRevision) &&
    input.expectedTrackRevision >= 0 &&
    authorized.size === input.authorizedDraftStepIds.length &&
    input.authorizedDraftStepIds.every((stepId) => active.has(stepId)) &&
    sameTracks(
      input.selectedTracks,
      SETUP_TRACKS.filter((track) => input.selectedTracks.includes(track)),
    )
  );
}

function validateOwnerResults(input: {
  organizationId: string;
  propertyId: string;
  selectedTracks: readonly SetupTrack[];
  activeStepIds: readonly PropertySetupStepId[];
  requests: readonly OwnerRequest[];
  results: readonly FoundOwnerResult[];
}): PropertySetupRouteOwnerStepFact[] {
  if (input.results.length !== input.requests.length) {
    throw new TypeError("Property setup owner result count does not match its requests");
  }
  const active = new Set(input.activeStepIds);
  const allowedDomains = allowedOwnerDomains(input.selectedTracks);
  const byStep = new Map<PropertySetupStepId, PropertySetupRouteOwnerStepFact>();

  input.requests.forEach((request, index) => {
    const result = input.results[index];
    if (!result || result.outcome !== "found") {
      throw new TypeError("Property setup owner result is not a found snapshot");
    }
    const facts = structuredClone(result.facts);
    if (facts.length !== request.stepIds.length) {
      throw new TypeError("Property setup owner snapshot has incomplete step coverage");
    }
    const requested = new Set(request.stepIds);
    for (const fact of facts) {
      validateOwnerFact(fact, {
        organizationId: input.organizationId,
        propertyId: input.propertyId,
        requested,
        active,
        allowedDomains,
      });
      if (byStep.has(fact.stepId)) {
        throw new TypeError("Property setup owner snapshots contain a duplicate step");
      }
      byStep.set(fact.stepId, fact);
    }
  });

  if (
    byStep.size !== input.activeStepIds.length ||
    input.activeStepIds.some((stepId) => !byStep.has(stepId))
  ) {
    throw new TypeError("Property setup owner snapshots are incomplete for the active route");
  }
  return input.activeStepIds.map((stepId) => byStep.get(stepId)!);
}

function validateOwnerFact(
  fact: PropertySetupRouteOwnerStepFact,
  scope: {
    organizationId: string;
    propertyId: string;
    requested: ReadonlySet<PropertySetupStepId>;
    active: ReadonlySet<PropertySetupStepId>;
    allowedDomains: ReadonlySet<PropertySetupOwnerDomain>;
  },
): void {
  if (
    fact.organizationId !== scope.organizationId ||
    fact.propertyId !== scope.propertyId ||
    !scope.requested.has(fact.stepId)
  ) {
    throw new TypeError("Property setup owner fact is outside its requested scope");
  }
  const provenance = PROVENANCE_BY_STEP[fact.stepId];
  if (fact.product !== provenance.product || fact.ownerDomain !== provenance.ownerDomain) {
    throw new TypeError("Property setup owner fact has invalid provenance");
  }
  if (
    !OWNER_STATES.has(fact.state) ||
    !nonEmpty(fact.sourceRevision) ||
    !isPropertySetupBaseRevisionManifest(fact.stepId, fact.currentBaseRevisions)
  ) {
    throw new TypeError("Property setup owner fact has invalid progress or revision");
  }
  if (!Array.isArray(fact.blockers) || (fact.state === "blocked") !== fact.blockers.length > 0) {
    throw new TypeError("Property setup owner fact has inconsistent blockers");
  }
  for (const blocker of fact.blockers) {
    if (
      !nonEmpty(blocker.code) ||
      !nonEmpty(blocker.message) ||
      !nonEmpty(blocker.sourceRevision) ||
      !BLOCKER_KINDS.has(blocker.kind) ||
      !scope.active.has(blocker.owningStepId) ||
      !scope.allowedDomains.has(blocker.product) ||
      !scope.allowedDomains.has(blocker.ownerDomain) ||
      (blocker.affectedEntity !== undefined &&
        (!nonEmpty(blocker.affectedEntity.entityType) ||
          !nonEmpty(blocker.affectedEntity.entityId)))
    ) {
      throw new TypeError("Property setup owner fact contains an unsafe blocker");
    }
  }
}

function allowedOwnerDomains(selectedTracks: readonly SetupTrack[]): Set<PropertySetupOwnerDomain> {
  const domains = new Set<PropertySetupOwnerDomain>(["hotel_catalog"]);
  if (selectedTracks.includes("creator_marketplace")) domains.add("marketplace");
  if (selectedTracks.includes("hotel_operations")) {
    for (const domain of ["booking", "pms", "finance", "distribution"] as const) {
      domains.add(domain);
    }
  }
  return domains;
}

function sameTracks(left: readonly SetupTrack[], right: readonly SetupTrack[]): boolean {
  const normalizedLeft = SETUP_TRACKS.filter((track) => left.includes(track));
  const normalizedRight = SETUP_TRACKS.filter((track) => right.includes(track));
  return (
    normalizedLeft.length === left.length &&
    normalizedRight.length === right.length &&
    normalizedLeft.every((track, index) => track === normalizedRight[index])
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
