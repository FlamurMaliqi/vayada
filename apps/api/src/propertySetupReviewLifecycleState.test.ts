import { describe, expect, it, vi } from "vitest";

import {
  createPropertySetupReviewLifecycleStateProvider,
  type BookingSetupLifecyclePhase,
  type MarketplaceSetupLifecyclePhase,
} from "./platform/propertySetupReviewLifecycleState.js";
import type { PropertySetupOwnerStateRequest } from "./platform/propertySetupRouteState.js";

const scope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  propertyId: "22222222-2222-4222-8222-222222222222",
  actorUserId: "33333333-3333-4333-8333-333333333333",
} as const;

describe("property setup Review lifecycle provider", () => {
  it("marks Marketplace owner work complete once its immutable submission is pending review", async () => {
    const marketplace = marketplacePort("pending_review", "marketplace:submission-2:pending");
    const booking = bookingPort("not_started", "booking:none");
    const provider = createPropertySetupReviewLifecycleStateProvider({ marketplace, booking });

    await expect(provider.getOwnerState(request(["creator_marketplace"]))).resolves.toMatchObject({
      outcome: "found",
      facts: [
        {
          stepId: "review",
          state: "complete",
          product: "hotel_catalog",
          ownerDomain: "hotel_catalog",
          blockers: [],
        },
      ],
    });
    expect(marketplace.getMarketplaceSetupLifecycleStatus).toHaveBeenCalledWith(scope);
    expect(booking.getBookingSetupLifecycleStatus).not.toHaveBeenCalled();
  });

  it("keeps an accepted Booking publication as saved until Distribution activates it", async () => {
    const provider = createPropertySetupReviewLifecycleStateProvider({
      booking: bookingPort("publishing", "booking:attempt-4:pending"),
    });

    await expect(provider.getOwnerState(request(["hotel_operations"]))).resolves.toMatchObject({
      outcome: "found",
      facts: [{ stepId: "review", state: "saved", blockers: [] }],
    });
  });

  it("distinguishes untouched, partial, and fully completed selected-product lifecycles", async () => {
    const cases = [
      {
        marketplacePhase: "not_started" as const,
        bookingPhase: "not_started" as const,
        expected: "not_started",
      },
      {
        marketplacePhase: "published" as const,
        bookingPhase: "not_started" as const,
        expected: "saved",
      },
      {
        marketplacePhase: "approved" as const,
        bookingPhase: "published" as const,
        expected: "complete",
      },
    ];

    for (const item of cases) {
      const provider = createPropertySetupReviewLifecycleStateProvider({
        marketplace: marketplacePort(item.marketplacePhase, `marketplace:${item.marketplacePhase}`),
        booking: bookingPort(item.bookingPhase, `booking:${item.bookingPhase}`),
      });
      const result = await provider.getOwnerState(
        request(["hotel_operations", "creator_marketplace"]),
      );
      expect(result).toMatchObject({
        outcome: "found",
        facts: [{ state: item.expected }],
      });
    }
  });

  it("returns structured Review-owned blockers", async () => {
    const provider = createPropertySetupReviewLifecycleStateProvider({
      marketplace: marketplacePort("changes_requested", "marketplace:submission-3:changes"),
      booking: bookingPort("publication_failed", "booking:attempt-8:failed"),
    });

    const result = await provider.getOwnerState(
      request(["hotel_operations", "creator_marketplace"]),
    );

    expect(result).toMatchObject({
      outcome: "found",
      facts: [
        {
          state: "blocked",
          blockers: [
            {
              code: "booking_publication_failed",
              product: "booking",
              ownerDomain: "booking",
              owningStepId: "review",
              kind: "system_error",
              sourceRevision: "booking:attempt-8:failed",
            },
            {
              code: "marketplace_submission_changes_requested",
              product: "marketplace",
              ownerDomain: "marketplace",
              owningStepId: "review",
              kind: "user_fixable",
              sourceRevision: "marketplace:submission-3:changes",
            },
          ],
        },
      ],
    });
  });

  it("binds the Review revision to selected tracks and exact owner lifecycle revisions", async () => {
    const first = createPropertySetupReviewLifecycleStateProvider({
      marketplace: marketplacePort("published", "marketplace:r2:active"),
      booking: bookingPort("published", "booking:r4:active"),
    });
    const equivalent = createPropertySetupReviewLifecycleStateProvider({
      marketplace: marketplacePort("published", "marketplace:r2:active"),
      booking: bookingPort("published", "booking:r4:active"),
    });
    const changed = createPropertySetupReviewLifecycleStateProvider({
      marketplace: marketplacePort("published", "marketplace:r3:active"),
      booking: bookingPort("published", "booking:r4:active"),
    });
    const combined = request(["hotel_operations", "creator_marketplace"]);

    const firstRevision = revision(await first.getOwnerState(combined));
    expect(revision(await equivalent.getOwnerState(combined))).toBe(firstRevision);
    expect(revision(await changed.getOwnerState(combined))).not.toBe(firstRevision);
    expect(firstRevision).toMatch(/^review-lifecycle:sha256:[0-9a-f]{64}$/);
  });

  it("fails closed for missing, rejected, or malformed lifecycle facts", async () => {
    const missing = createPropertySetupReviewLifecycleStateProvider({
      marketplace: marketplacePort("not_started", "marketplace:none"),
    });
    await expect(missing.getOwnerState(request(["hotel_operations"]))).resolves.toEqual({
      outcome: "provider_failure",
    });

    const rejected = createPropertySetupReviewLifecycleStateProvider({
      booking: {
        getBookingSetupLifecycleStatus: vi.fn(async () => {
          throw new Error("provider stack: connection refused");
        }),
      },
    });
    const rejectedResult = await rejected.getOwnerState(request(["hotel_operations"]));
    expect(rejectedResult).toEqual({
      outcome: "provider_failure",
    });
    expect(JSON.stringify(rejectedResult)).not.toContain("provider stack");

    const malformed = createPropertySetupReviewLifecycleStateProvider({
      booking: {
        getBookingSetupLifecycleStatus: vi.fn(async () => ({
          ...bookingStatus("published", "booking:r4:active"),
          propertyId: "another-property",
        })),
      },
    });
    await expect(malformed.getOwnerState(request(["hotel_operations"]))).resolves.toEqual({
      outcome: "provider_failure",
    });

    const wrongProduct = createPropertySetupReviewLifecycleStateProvider({
      booking: {
        getBookingSetupLifecycleStatus: vi.fn(async () => ({
          ...scope,
          product: "marketplace" as never,
          phase: "published" as const,
          sourceRevision: "marketplace:r4:active",
        })),
      },
    });
    await expect(wrongProduct.getOwnerState(request(["hotel_operations"]))).resolves.toEqual({
      outcome: "provider_failure",
    });
  });

  it("rejects a request for any step or track shape outside Review", async () => {
    const provider = createPropertySetupReviewLifecycleStateProvider({
      booking: bookingPort("published", "booking:r4:active"),
    });
    const invalid = [
      { ...request(["hotel_operations"]), stepIds: ["payments"] as const },
      {
        ...request(["hotel_operations"]),
        selectedTracks: ["hotel_operations", "hotel_operations"] as const,
      },
      request(["creator_marketplace", "hotel_operations"] as const),
      { ...request(["hotel_operations"]), expectedTrackRevision: -1 },
    ];

    for (const item of invalid) {
      await expect(provider.getOwnerState(item)).resolves.toEqual({
        outcome: "provider_failure",
      });
    }
  });
});

function request(
  selectedTracks: PropertySetupOwnerStateRequest["selectedTracks"],
): PropertySetupOwnerStateRequest {
  return {
    ...scope,
    selectedTracks,
    expectedTrackRevision: 4,
    stepIds: ["review"],
  };
}

function marketplacePort(phase: MarketplaceSetupLifecyclePhase, sourceRevision: string) {
  return {
    getMarketplaceSetupLifecycleStatus: vi.fn(async () => ({
      ...scope,
      product: "marketplace" as const,
      phase,
      sourceRevision,
    })),
  };
}

function bookingPort(phase: BookingSetupLifecyclePhase, sourceRevision: string) {
  return {
    getBookingSetupLifecycleStatus: vi.fn(async () => bookingStatus(phase, sourceRevision)),
  };
}

function bookingStatus(phase: BookingSetupLifecyclePhase, sourceRevision: string) {
  return {
    ...scope,
    product: "booking" as const,
    phase,
    sourceRevision,
  };
}

function revision(
  result: Awaited<
    ReturnType<ReturnType<typeof createPropertySetupReviewLifecycleStateProvider>["getOwnerState"]>
  >,
) {
  if (result.outcome !== "found") throw new Error("Expected lifecycle fact");
  return result.facts[0]!.sourceRevision;
}
