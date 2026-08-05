import { createHash } from "node:crypto";

import {
  BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION,
  createBookingDesignSourceRevision,
  parseBookingDesignRevision,
  parseBookingGuestPolicyCurrentSourceRevision,
  type BookingDesignReadPort,
  type BookingGuestPolicyCurrentOwnerEvidencePort,
} from "@vayada/domain-booking";
import {
  isPropertySetupBaseRevisionManifest,
  parseHotelCatalogStep1ReadModel,
} from "@vayada/domain-hotels";

import type { HotelCatalogStep1Repository } from "../domains/hotelCatalogStep1Repository.js";
import type {
  PropertySetupOwnerStateProviderPort,
  PropertySetupOwnerStateRequest,
  PropertySetupOwnerStateResult,
} from "./propertySetupRouteState.js";

export type PropertySetupBookingStateOptions = Readonly<{
  design: BookingDesignReadPort;
  catalog: Pick<HotelCatalogStep1Repository, "getState">;
  guestPolicy?: Pick<
    BookingGuestPolicyCurrentOwnerEvidencePort,
    "getCurrentGuestPolicyOwnerEvidence"
  >;
}>;

export function createPropertySetupBookingStateProvider(
  options: PropertySetupBookingStateOptions,
): PropertySetupOwnerStateProviderPort {
  return {
    async getOwnerState(request) {
      if (!validRequest(request)) return failure();
      try {
        const first = await readSnapshot(options, request);
        const confirmed = await readSnapshot(options, request);
        if (!first || !confirmed || first.identity !== confirmed.identity) return failure();
        const facts = request.stepIds.map((stepId) => {
          if (stepId === "booking_design") {
            return fact(
              request,
              stepId,
              first.designRevision === 0 ? "not_started" : "complete",
              `design:${first.designRevision}`,
              first.designBaseRevisions!,
            );
          }
          if (stepId !== "guest_experience") return null;
          return fact(
            request,
            stepId,
            first.guestPolicyState!,
            first.guestPolicyBaseRevisions!["booking.guest_experience"],
            first.guestPolicyBaseRevisions!,
          );
        });
        if (facts.some((item) => item === null)) return failure();
        return found(facts.filter((item) => item !== null));
      } catch {
        return failure();
      }
    },
  };
}

async function readSnapshot(
  options: PropertySetupBookingStateOptions,
  request: PropertySetupOwnerStateRequest,
) {
  const wantsDesign = request.stepIds.includes("booking_design");
  const wantsGuestPolicy = request.stepIds.includes("guest_experience");
  if (wantsGuestPolicy && !options.guestPolicy) return null;
  const [rawDesign, catalogState, guestPolicy] = await Promise.all([
    wantsDesign
      ? options.design.getCurrentDesign({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
        })
      : null,
    wantsDesign
      ? options.catalog.getState({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          actorUserId: request.actorUserId,
        })
      : null,
    wantsGuestPolicy
      ? options.guestPolicy!.getCurrentGuestPolicyOwnerEvidence({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
        })
      : null,
  ]);
  const design = rawDesign === null ? null : parseBookingDesignRevision(rawDesign);
  const catalog = catalogState && parseHotelCatalogStep1ReadModel(catalogState.readModel);
  const guestPolicySource =
    guestPolicy?.outcome === "available"
      ? parseBookingGuestPolicyCurrentSourceRevision(
          {
            ownerDomain: "booking",
            entityType: "guest_policy_revision",
            entityId: request.propertyId,
            revision: guestPolicy.currentBaseRevisions["booking.guest_experience"],
          },
          request.propertyId,
        )
      : null;
  if (
    (wantsDesign && rawDesign !== null && !design) ||
    (design && design.propertyId !== request.propertyId) ||
    (wantsDesign && (!catalog || catalog.propertyId !== request.propertyId)) ||
    (wantsGuestPolicy &&
      (!guestPolicy ||
        guestPolicy.outcome !== "available" ||
        guestPolicy.organizationId !== request.organizationId ||
        guestPolicy.propertyId !== request.propertyId ||
        !isPropertySetupBaseRevisionManifest(
          "guest_experience",
          guestPolicy.currentBaseRevisions,
        ) ||
        !guestPolicySource))
  ) {
    return null;
  }
  const designRevision = design?.revision ?? 0;
  const designSourceRevision = design
    ? createBookingDesignSourceRevision(request.propertyId, design.revision).revision
    : "design:0";
  const designBaseRevisions = wantsDesign
    ? Object.freeze({
        "booking.design": designSourceRevision,
        "hotel_catalog.profile": catalog!.baseRevisions["hotel_catalog.profile"],
        "hotel_catalog.media": catalog!.baseRevisions["hotel_catalog.media"],
      })
    : null;
  const guestPolicyBaseRevisions =
    guestPolicy?.outcome === "available"
      ? Object.freeze({ ...guestPolicy.currentBaseRevisions })
      : null;
  return Object.freeze({
    designRevision,
    designBaseRevisions,
    guestPolicyState:
      guestPolicySource?.revision === BOOKING_GUEST_POLICY_ABSENT_SOURCE_REVISION
        ? ("not_started" as const)
        : guestPolicySource
          ? ("complete" as const)
          : null,
    guestPolicyBaseRevisions,
    identity: digest({ designRevision, designBaseRevisions, guestPolicyBaseRevisions }),
  });
}

function fact(
  request: PropertySetupOwnerStateRequest,
  stepId: "booking_design" | "guest_experience",
  state: "not_started" | "complete",
  sourceRevision: string,
  currentBaseRevisions: Readonly<Record<string, string>>,
) {
  return Object.freeze({
    organizationId: request.organizationId,
    propertyId: request.propertyId,
    stepId,
    product: "booking" as const,
    ownerDomain: "booking" as const,
    state,
    sourceRevision,
    currentBaseRevisions,
    blockers: [],
  });
}

function validRequest(request: PropertySetupOwnerStateRequest): boolean {
  return (
    request.stepIds.length > 0 &&
    request.stepIds.every(
      (stepId) => stepId === "booking_design" || stepId === "guest_experience",
    ) &&
    new Set(request.stepIds).size === request.stepIds.length
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function found(
  facts: readonly Extract<PropertySetupOwnerStateResult, { outcome: "found" }>["facts"][number][],
): PropertySetupOwnerStateResult {
  return { outcome: "found", facts: Object.freeze([...facts]) };
}

function failure(): PropertySetupOwnerStateResult {
  return { outcome: "provider_failure" };
}
