import { createHash } from "node:crypto";

import { SETUP_TRACKS, type SetupTrack } from "@vayada/domain-hotels";

import type {
  PropertySetupOwnerStateProviderPort,
  PropertySetupOwnerStateRequest,
  PropertySetupOwnerStateResult,
} from "./propertySetupRouteState.js";

export type PropertySetupLifecycleScope = Readonly<{
  organizationId: string;
  propertyId: string;
  actorUserId: string;
}>;

export const MARKETPLACE_SETUP_LIFECYCLE_PHASES = [
  "not_started",
  "pending_review",
  "changes_requested",
  "approved",
  "published",
  "rejected",
  "withdrawn",
  "suspended",
  "deactivated",
] as const;

export const BOOKING_SETUP_LIFECYCLE_PHASES = [
  "not_started",
  "publishing",
  "published",
  "source_content_changed",
  "publication_failed",
  "publication_unknown",
] as const;

export type MarketplaceSetupLifecyclePhase = (typeof MARKETPLACE_SETUP_LIFECYCLE_PHASES)[number];
export type BookingSetupLifecyclePhase = (typeof BOOKING_SETUP_LIFECYCLE_PHASES)[number];

type LifecycleStatus<
  TProduct extends "marketplace" | "booking",
  TPhase extends string,
> = PropertySetupLifecycleScope &
  Readonly<{
    product: TProduct;
    phase: TPhase;
    /** Opaque owner revision; it must change whenever the lifecycle projection changes. */
    sourceRevision: string;
  }>;

export type MarketplaceSetupLifecycleStatus = LifecycleStatus<
  "marketplace",
  MarketplaceSetupLifecyclePhase
>;
export type BookingSetupLifecycleStatus = LifecycleStatus<"booking", BookingSetupLifecyclePhase>;

export interface MarketplaceSetupLifecycleStatusPort {
  getMarketplaceSetupLifecycleStatus(
    scope: PropertySetupLifecycleScope,
  ): Promise<MarketplaceSetupLifecycleStatus>;
}

export interface BookingSetupLifecycleStatusPort {
  getBookingSetupLifecycleStatus(
    scope: PropertySetupLifecycleScope,
  ): Promise<BookingSetupLifecycleStatus>;
}

export type PropertySetupReviewLifecycleStateOptions = Readonly<{
  marketplace?: MarketplaceSetupLifecycleStatusPort;
  booking?: BookingSetupLifecycleStatusPort;
}>;

/**
 * Projects only submission/publication lifecycle progress for the Review step.
 * Product readiness groups remain owned by their product aggregates and never
 * enter this provider.
 */
export function createPropertySetupReviewLifecycleStateProvider(
  options: PropertySetupReviewLifecycleStateOptions,
): PropertySetupOwnerStateProviderPort {
  return {
    async getOwnerState(request) {
      try {
        if (!validReviewRequest(request)) return { outcome: "provider_failure" };
        const scope = Object.freeze({
          organizationId: request.organizationId,
          propertyId: request.propertyId,
          actorUserId: request.actorUserId,
        });
        const statuses = await Promise.all(
          request.selectedTracks.map(async (track) => {
            const expectedProduct = productForTrack(track);
            const status =
              expectedProduct === "marketplace"
                ? await readMarketplaceLifecycle(options, scope)
                : await readBookingLifecycle(options, scope);
            assertLifecycleStatus(status, scope);
            if (status.product !== expectedProduct) {
              throw new TypeError("Review lifecycle provider returned another product");
            }
            return status;
          }),
        );

        const blockers = statuses.flatMap(lifecycleBlockers);
        const state = reviewState(statuses, blockers.length > 0);
        const sourceRevision = aggregateReviewRevision(request.selectedTracks, statuses);

        return {
          outcome: "found",
          facts: [
            Object.freeze({
              organizationId: request.organizationId,
              propertyId: request.propertyId,
              stepId: "review",
              product: "hotel_catalog",
              ownerDomain: "hotel_catalog",
              state,
              sourceRevision,
              currentBaseRevisions: Object.freeze({}),
              blockers: blockers.map((blocker) => ({ ...blocker })),
            }),
          ],
        } satisfies PropertySetupOwnerStateResult;
      } catch {
        return { outcome: "provider_failure" };
      }
    },
  };
}

type ReviewLifecycleStatus = MarketplaceSetupLifecycleStatus | BookingSetupLifecycleStatus;

const PRODUCT_BY_TRACK = {
  hotel_operations: "booking",
  creator_marketplace: "marketplace",
} as const satisfies Record<SetupTrack, "marketplace" | "booking">;

function productForTrack(track: SetupTrack): "marketplace" | "booking" {
  const product = PRODUCT_BY_TRACK[track];
  if (!product) throw new TypeError("Review lifecycle track is unsupported");
  return product;
}

function readMarketplaceLifecycle(
  options: PropertySetupReviewLifecycleStateOptions,
  scope: PropertySetupLifecycleScope,
): Promise<MarketplaceSetupLifecycleStatus> {
  if (!options.marketplace) throw new Error("Marketplace lifecycle provider missing");
  return options.marketplace.getMarketplaceSetupLifecycleStatus(scope);
}

function readBookingLifecycle(
  options: PropertySetupReviewLifecycleStateOptions,
  scope: PropertySetupLifecycleScope,
): Promise<BookingSetupLifecycleStatus> {
  if (!options.booking) throw new Error("Booking lifecycle provider missing");
  return options.booking.getBookingSetupLifecycleStatus(scope);
}

function validReviewRequest(request: PropertySetupOwnerStateRequest): boolean {
  return (
    nonEmpty(request.organizationId) &&
    nonEmpty(request.propertyId) &&
    nonEmpty(request.actorUserId) &&
    request.stepIds.length === 1 &&
    request.stepIds[0] === "review" &&
    Number.isSafeInteger(request.expectedTrackRevision) &&
    request.expectedTrackRevision >= 0 &&
    request.selectedTracks.length > 0 &&
    new Set(request.selectedTracks).size === request.selectedTracks.length &&
    request.selectedTracks.every((track) => SETUP_TRACKS.includes(track)) &&
    SETUP_TRACKS.filter((track) => request.selectedTracks.includes(track)).every(
      (track, index) => request.selectedTracks[index] === track,
    )
  );
}

function assertLifecycleStatus(
  status: ReviewLifecycleStatus,
  scope: PropertySetupLifecycleScope,
): void {
  if (
    status.organizationId !== scope.organizationId ||
    status.propertyId !== scope.propertyId ||
    status.actorUserId !== scope.actorUserId ||
    !nonEmpty(status.sourceRevision)
  ) {
    throw new TypeError("Review lifecycle status is outside its authorized scope");
  }
  const validPhase =
    (status.product === "marketplace" &&
      MARKETPLACE_SETUP_LIFECYCLE_PHASES.includes(
        status.phase as MarketplaceSetupLifecyclePhase,
      )) ||
    (status.product === "booking" &&
      BOOKING_SETUP_LIFECYCLE_PHASES.includes(status.phase as BookingSetupLifecyclePhase));
  if (!validPhase) throw new TypeError("Review lifecycle status has an unsupported phase");
}

function reviewState(statuses: readonly ReviewLifecycleStatus[], blocked: boolean) {
  if (blocked) return "blocked" as const;
  if (statuses.every(({ phase }) => phase === "not_started")) return "not_started" as const;
  if (statuses.every(ownerLaunchActionComplete)) return "complete" as const;
  return "saved" as const;
}

function ownerLaunchActionComplete({ phase }: ReviewLifecycleStatus): boolean {
  return phase === "pending_review" || phase === "approved" || phase === "published";
}

function lifecycleBlockers(status: ReviewLifecycleStatus) {
  if (isMarketplaceStatus(status)) return marketplaceBlockers(status);
  return bookingBlockers(status);
}

function marketplaceBlockers(status: MarketplaceSetupLifecycleStatus) {
  const definitions = {
    changes_requested: {
      code: "marketplace_submission_changes_requested",
      message:
        "Marketplace requested changes to the submitted profile. Review it before resubmitting.",
      kind: "user_fixable",
    },
    rejected: {
      code: "marketplace_submission_rejected",
      message: "Marketplace did not approve the submitted profile. Review it before resubmitting.",
      kind: "user_fixable",
    },
    withdrawn: {
      code: "marketplace_submission_withdrawn",
      message: "The Marketplace submission was withdrawn. Submit it again when it is ready.",
      kind: "user_fixable",
    },
    suspended: {
      code: "marketplace_profile_suspended",
      message:
        "The Marketplace profile is suspended. Contact support for the available next action.",
      kind: "external_pending",
    },
    deactivated: {
      code: "marketplace_profile_deactivated",
      message:
        "The Marketplace profile is not active. Contact support for the available next action.",
      kind: "external_pending",
    },
  } as const;
  const definition = definitions[status.phase as keyof typeof definitions];
  return definition ? [blocker("marketplace", status.sourceRevision, definition)] : [];
}

function bookingBlockers(status: BookingSetupLifecycleStatus) {
  const definitions = {
    source_content_changed: {
      code: "booking_publication_source_changed",
      message: "Setup changed while the booking page was publishing. Review it and publish again.",
      kind: "user_fixable",
    },
    publication_failed: {
      code: "booking_publication_failed",
      message:
        "The booking page could not be published. Retry from Review when the service recovers.",
      kind: "system_error",
    },
    publication_unknown: {
      code: "booking_publication_status_unknown",
      message: "The booking page publication result is not confirmed yet. Retry its status.",
      kind: "system_error",
    },
  } as const;
  const definition = definitions[status.phase as keyof typeof definitions];
  return definition ? [blocker("booking", status.sourceRevision, definition)] : [];
}

function blocker(
  ownerDomain: "marketplace" | "booking",
  sourceRevision: string,
  definition: Readonly<{
    code: string;
    message: string;
    kind: "user_fixable" | "external_pending" | "system_error";
  }>,
) {
  return {
    ...definition,
    product: ownerDomain,
    ownerDomain,
    owningStepId: "review" as const,
    sourceRevision,
  };
}

function isMarketplaceStatus(
  status: ReviewLifecycleStatus,
): status is MarketplaceSetupLifecycleStatus {
  return status.product === "marketplace";
}

function aggregateReviewRevision(
  selectedTracks: readonly SetupTrack[],
  statuses: readonly ReviewLifecycleStatus[],
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        selectedTracks,
        sources: statuses.map(({ product, sourceRevision }) => ({ product, sourceRevision })),
      }),
    )
    .digest("hex");
  return `review-lifecycle:sha256:${digest}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
