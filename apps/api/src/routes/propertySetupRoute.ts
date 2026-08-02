import { UnauthorizedError, type RequestContext } from "@vayada/backend-auth";
import { AuthorizationError, hasPermission } from "@vayada/backend-authorization";
import {
  PROPERTY_SETUP_STEP_DEFINITIONS,
  SETUP_TRACKS,
  buildPropertySetupRoute,
  getActivePropertySetupStepIds,
  type PropertySetupOwnerDomain,
  type PropertySetupOwnerStepFact,
  type PropertySetupRouteReadModel,
  type PropertySetupSession,
  type PropertySetupStepId,
  type SetupTrack,
} from "@vayada/domain-hotels";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { HotelSetupTrackCommandRepository } from "../domains/hotelSetupTrackCommandRepository.js";
import { enforceRoutePolicy, type RouteAuthorizationPolicy } from "./policy.js";

const PROPERTY_SETUP_ROUTE_POLICY = {
  permission: "hotel_catalog.setup.read",
  resource: {
    product: "hotel_catalog",
    resourceType: "property",
    allowedRelationships: ["owner", "operator"],
  },
} as const;

export type PropertySetupRouteStateReadInput = Readonly<{
  organizationId: string;
  propertyId: string;
  actorUserId: string;
  selectedTracks: readonly SetupTrack[];
  expectedTrackRevision: number;
  authorizedDraftStepIds: readonly PropertySetupStepId[];
}>;

export type PropertySetupRouteOwnerStepFact = Readonly<
  PropertySetupOwnerStepFact & {
    /** Product and owner provenance for authorization at this aggregate boundary. */
    product: PropertySetupOwnerDomain;
    ownerDomain: PropertySetupOwnerDomain;
  }
>;

export type PropertySetupRouteStateReadResult =
  | Readonly<{
      outcome: "found";
      trackRevision: number;
      session: PropertySetupSession | null;
      /** Exactly one current owner fact for every active route step. */
      ownerFacts: readonly PropertySetupRouteOwnerStepFact[];
    }>
  | Readonly<{ outcome: "not_found" }>
  | Readonly<{ outcome: "track_revision_conflict"; currentRevision: number }>
  | Readonly<{ outcome: "provider_failure" }>;

export type PropertySetupRouteStateReadPort = {
  /**
   * Returns only the requested actor's active, unexpired drafts for
   * authorizedDraftStepIds plus a complete, current owner-fact snapshot for the
   * selected route. Owner facts describe setup progress/current revisions, not
   * product launch readiness; Review completion comes from lifecycle state.
   * Provider failures and track races must be explicit rather than represented
   * as missing facts.
   */
  getPropertySetupRouteState(
    input: PropertySetupRouteStateReadInput,
  ): Promise<PropertySetupRouteStateReadResult>;
};

export type PropertySetupRouteRoutesOptions = {
  routeStateReadPort: PropertySetupRouteStateReadPort;
  trackCommandRepository: Pick<HotelSetupTrackCommandRepository, "getTrackStatus">;
};

type PropertySetupRouteParams = {
  propertyId?: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TRACK_POLICIES = {
  creator_marketplace: [
    {
      permission: "marketplace.collaboration.read",
      entitlement: {
        product: "marketplace",
        key: "marketplace-hotel-profile",
        resource: { product: "marketplace", resourceType: "hotel_profile" },
      },
      resource: {
        product: "marketplace",
        resourceType: "hotel_profile",
        allowedRelationships: ["owner", "operator"],
      },
    },
  ],
  hotel_operations: [
    {
      permission: "booking.settings.read",
      entitlement: {
        product: "booking",
        key: "booking-engine",
        resource: { product: "booking", resourceType: "booking_hotel" },
      },
      resource: {
        product: "booking",
        resourceType: "booking_hotel",
        allowedRelationships: ["owner", "operator"],
      },
    },
    {
      permission: "pms.operations.read",
      entitlement: {
        product: "pms",
        key: "property-management",
        resource: { product: "pms", resourceType: "pms_property" },
      },
      resource: {
        product: "pms",
        resourceType: "pms_property",
        allowedRelationships: ["owner", "operator"],
      },
    },
  ],
} as const;

export async function registerPropertySetupRouteRoutes(
  app: FastifyInstance,
  options: PropertySetupRouteRoutesOptions,
): Promise<void> {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "private, no-store");
    return payload;
  });

  app.get<{ Params: PropertySetupRouteParams }>(
    "/properties/:propertyId/route",
    async (request, reply) => {
      let baseContext: RequestContext;
      try {
        baseContext = enforceRoutePolicy(request, {
          permission: PROPERTY_SETUP_ROUTE_POLICY.permission,
        });
      } catch (error) {
        return authorizationFailure(error, reply);
      }
      if (
        baseContext.selectedOrganization.kind !== "hotel_group" ||
        baseContext.selectedOrganization.status !== "active"
      ) {
        return reply.status(403).send({
          code: "invalid_organization_scope",
          detail: "Property setup is available only to an active hotel group.",
        });
      }

      const requestedPropertyId = request.params.propertyId;
      if (!requestedPropertyId || !UUID_PATTERN.test(requestedPropertyId)) {
        return reply.status(400).send({
          code: "invalid_property_id",
          detail: "propertyId must be a UUID.",
        });
      }
      const propertyId = requestedPropertyId.toLowerCase();

      let context: RequestContext;
      try {
        context = enforceRoutePolicy(request, {
          permission: PROPERTY_SETUP_ROUTE_POLICY.permission,
          resource: {
            ...PROPERTY_SETUP_ROUTE_POLICY.resource,
            resourceId: propertyId,
          },
        });
      } catch (error) {
        return authorizationFailure(error, reply);
      }

      let trackStatus;
      try {
        trackStatus = await options.trackCommandRepository.getTrackStatus({
          organizationId: context.selectedOrganization.organizationId,
        });
      } catch (error) {
        request.log.error({ err: error }, "Failed to load property setup track selection");
        return unavailable(reply);
      }
      const selectedTracks = SETUP_TRACKS.filter((track) =>
        trackStatus.selectedTracks.includes(track),
      );
      if (selectedTracks.length === 0) {
        return reply.status(409).send({
          code: "setup_track_selection_required",
          detail: "Select at least one Vayada service before loading property setup.",
        });
      }
      try {
        enforceSelectedTrackPolicies(request, propertyId, selectedTracks);
      } catch (error) {
        return authorizationFailure(error, reply);
      }
      const activeStepIds = getActivePropertySetupStepIds(selectedTracks);
      const authorizedDraftStepIds = authorizedDraftSteps(context, selectedTracks);

      try {
        const state = await options.routeStateReadPort.getPropertySetupRouteState(
          Object.freeze({
            organizationId: context.selectedOrganization.organizationId,
            propertyId,
            actorUserId: context.actor.internalUserId,
            selectedTracks: Object.freeze([...selectedTracks]),
            expectedTrackRevision: trackStatus.trackRevision,
            authorizedDraftStepIds: Object.freeze([...authorizedDraftStepIds]),
          }),
        );
        if (state.outcome === "not_found") {
          return reply.status(404).send({
            code: "property_setup_route_not_found",
            detail: "Property setup state was not found for the selected property.",
          });
        }
        if (state.outcome === "track_revision_conflict") {
          if (!isRevision(state.currentRevision)) return unavailable(reply);
          return reply.status(409).send({
            code: "setup_track_revision_conflict",
            currentRevision: state.currentRevision,
            detail: "The selected services changed. Reload property setup and try again.",
          });
        }
        if (state.outcome === "provider_failure") return unavailable(reply);
        if (state.outcome !== "found" || state.trackRevision !== trackStatus.trackRevision) {
          return unavailable(reply);
        }

        const session = state.session ? structuredClone(state.session) : null;
        const ownerFacts = structuredClone(state.ownerFacts);
        assertCompleteOwnerFacts(ownerFacts, activeStepIds);
        assertAuthorizedOwnerFacts(ownerFacts, selectedTracks);

        const route = buildPropertySetupRoute({
          organizationId: context.selectedOrganization.organizationId,
          propertyId,
          selectedTracks,
          trackRevision: trackStatus.trackRevision,
          session: filterSessionDrafts(session, authorizedDraftStepIds),
          ownerFacts,
        }) satisfies PropertySetupRouteReadModel;
        return reply.send(route);
      } catch (error) {
        request.log.error({ err: error }, "Failed to build property setup route");
        return unavailable(reply);
      }
    },
  );
}

function assertCompleteOwnerFacts(
  ownerFacts: readonly PropertySetupRouteOwnerStepFact[],
  activeStepIds: readonly PropertySetupStepId[],
): void {
  const factStepIds = new Set(ownerFacts.map(({ stepId }) => stepId));
  if (
    factStepIds.size !== ownerFacts.length ||
    ownerFacts.length !== activeStepIds.length ||
    activeStepIds.some((stepId) => !factStepIds.has(stepId))
  ) {
    throw new TypeError("Property setup owner facts are incomplete for the active route.");
  }
}

function assertAuthorizedOwnerFacts(
  ownerFacts: readonly PropertySetupRouteOwnerStepFact[],
  selectedTracks: readonly SetupTrack[],
): void {
  const allowedDomains = new Set<PropertySetupOwnerDomain>(["hotel_catalog"]);
  if (selectedTracks.includes("creator_marketplace")) allowedDomains.add("marketplace");
  if (selectedTracks.includes("hotel_operations")) {
    for (const domain of ["booking", "pms", "finance", "distribution"] as const) {
      allowedDomains.add(domain);
    }
  }
  for (const fact of ownerFacts) {
    if (!allowedDomains.has(fact.product) || !allowedDomains.has(fact.ownerDomain)) {
      throw new TypeError("Property setup owner facts contain an unauthorized product fact.");
    }
    for (const blocker of fact.blockers) {
      if (!allowedDomains.has(blocker.product) || !allowedDomains.has(blocker.ownerDomain)) {
        throw new TypeError("Property setup owner facts contain an unauthorized product blocker.");
      }
    }
  }
}

function authorizationFailure(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof UnauthorizedError) {
    return reply.status(401).send({
      code: "unauthenticated",
      detail: "A valid access token is required.",
    });
  }
  if (error instanceof AuthorizationError) {
    return reply.status(403).send({
      code: "access_denied",
      detail: "You do not have access to this property setup route.",
    });
  }
  throw error;
}

function isRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function enforceSelectedTrackPolicies(
  request: Parameters<typeof enforceRoutePolicy>[0],
  propertyId: string,
  selectedTracks: SetupTrack[],
): void {
  for (const track of selectedTracks) {
    for (const definition of TRACK_POLICIES[track]) {
      enforceRoutePolicy(request, policyForProperty(definition, propertyId));
    }
  }
}

function policyForProperty(
  definition: (typeof TRACK_POLICIES)[SetupTrack][number],
  propertyId: string,
): RouteAuthorizationPolicy {
  return {
    permission: definition.permission,
    entitlement: {
      ...definition.entitlement,
      resource: { ...definition.entitlement.resource, resourceId: propertyId },
    },
    resource: { ...definition.resource, resourceId: propertyId },
  };
}

function authorizedDraftSteps(
  context: RequestContext,
  selectedTracks: SetupTrack[],
): PropertySetupStepId[] {
  const active = new Set(getActivePropertySetupStepIds(selectedTracks));
  return PROPERTY_SETUP_STEP_DEFINITIONS.filter(
    ({ stepId, permission }) => active.has(stepId) && hasPermission(context, permission),
  ).map(({ stepId }) => stepId);
}

function filterSessionDrafts(
  session: PropertySetupSession | null,
  authorizedDraftStepIds: PropertySetupStepId[],
): PropertySetupSession | null {
  if (!session) return null;
  const allowed = new Set(authorizedDraftStepIds);
  return {
    ...session,
    drafts: session.drafts.filter(({ stepId }) => allowed.has(stepId)),
  };
}

function unavailable(reply: FastifyReply) {
  return reply.status(503).send({
    code: "property_setup_route_unavailable",
    detail: "Property setup is temporarily unavailable.",
  });
}
