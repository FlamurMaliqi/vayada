import {
  parseHotelCatalogStep1ReadModel,
  type HotelCatalogStep1ReadModel,
} from "@vayada/domain-hotels";
import {
  parseMarketplaceHotelCollaborationPreferencesReadModel,
  type MarketplaceHotelCollaborationPreferencesReadPort,
} from "@vayada/domain-marketplace";

import type { HotelCatalogStep1Repository } from "../domains/hotelCatalogStep1Repository.js";
import type {
  PropertySetupOwnerStateProviderPort,
  PropertySetupOwnerStateRequest,
  PropertySetupOwnerStateResult,
} from "./propertySetupRouteState.js";

export function createPropertySetupHotelCatalogStateProvider(
  repository: Pick<HotelCatalogStep1Repository, "getState">,
): PropertySetupOwnerStateProviderPort {
  return {
    async getOwnerState(request) {
      if (!validSingleStepRequest(request, "present_hotel")) return failure();
      try {
        const state = await repository.getState({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          actorUserId: request.actorUserId,
        });
        if (!state) return { outcome: "not_found", providerKey: "hotel_catalog" };
        const readModel = parseHotelCatalogStep1ReadModel(state.readModel);
        if (!readModel || readModel.propertyId !== request.propertyId) return failure();
        return found({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          stepId: "present_hotel",
          product: "hotel_catalog",
          ownerDomain: "hotel_catalog",
          state: presentHotelState(readModel),
          sourceRevision: readModel.baseRevisions["hotel_catalog.profile"],
          currentBaseRevisions: Object.freeze({ ...readModel.baseRevisions }),
          blockers: [],
        });
      } catch {
        return failure();
      }
    },
  };
}

export function createPropertySetupMarketplaceStateProvider(
  preferences: MarketplaceHotelCollaborationPreferencesReadPort,
): PropertySetupOwnerStateProviderPort {
  return {
    async getOwnerState(request) {
      if (!validSingleStepRequest(request, "marketplace_preferences")) return failure();
      try {
        const outcome = await preferences.getHotelCollaborationPreferences({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
        });
        if (outcome.outcome !== "available") return failure();
        const readModel = parseMarketplaceHotelCollaborationPreferencesReadModel(outcome.readModel);
        if (!readModel || readModel.propertyId !== request.propertyId) return failure();
        return found({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          stepId: "marketplace_preferences",
          product: "marketplace",
          ownerDomain: "marketplace",
          state: readModel.preferences === null ? "not_started" : "complete",
          sourceRevision: readModel.sourceRevision,
          currentBaseRevisions: Object.freeze({
            "marketplace.collaboration_preferences": readModel.sourceRevision,
          }),
          blockers: [],
        });
      } catch {
        return failure();
      }
    },
  };
}

function presentHotelState(readModel: HotelCatalogStep1ReadModel) {
  if (
    readModel.profile.shortDescription &&
    readModel.profile.publicSlug &&
    readModel.profile.amenities.reviewed
  ) {
    return "complete" as const;
  }
  const started =
    readModel.profile.shortDescription !== null ||
    readModel.profile.publicSlug !== null ||
    readModel.profile.amenities.reviewed ||
    readModel.profile.media.coverMediaObjectId !== null ||
    readModel.profile.media.galleryMediaObjectIds.length > 0;
  return started ? ("saved" as const) : ("not_started" as const);
}

function validSingleStepRequest(
  request: PropertySetupOwnerStateRequest,
  stepId: "present_hotel" | "marketplace_preferences",
): boolean {
  return (
    request.stepIds.length === 1 &&
    request.stepIds[0] === stepId &&
    request.organizationId.trim().length > 0 &&
    request.propertyId.trim().length > 0 &&
    request.actorUserId.trim().length > 0
  );
}

function found(
  fact: Extract<PropertySetupOwnerStateResult, { outcome: "found" }>["facts"][number],
): PropertySetupOwnerStateResult {
  return { outcome: "found", facts: Object.freeze([Object.freeze(fact)]) };
}

function failure(): PropertySetupOwnerStateResult {
  return { outcome: "provider_failure" };
}
