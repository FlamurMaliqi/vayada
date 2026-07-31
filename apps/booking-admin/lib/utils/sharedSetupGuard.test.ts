import { describe, expect, it, vi } from "vitest";
import type { AdaptiveHotelSetupStatus } from "@vayada/product-onboarding";

import { resolveBookingSetupGuard } from "./sharedSetupGuard";

describe("resolveBookingSetupGuard", () => {
  it("routes setup_required decisions to the canonical Marketplace wizard", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          decision: "setup_required",
          reasonCode: "product_access_pending",
        }),
      ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "property-1" });

    await expect(
      resolveBookingSetupGuard(
        "/dashboard?tab=rooms",
        api,
        storage,
        "https://marketplace.localhost:1355",
      ),
    ).resolves.toEqual({
      action: "redirect_to_setup",
      propertyId: "property-1",
      redirectPath:
        "https://marketplace.localhost:1355/setup?entryProduct=booking&returnProduct=booking&returnTo=%2Fdashboard%3Ftab%3Drooms&propertyId=property-1",
      entryDecision: "setup_required",
      reasonCode: "product_access_pending",
    });
    expect(api.getStatus).toHaveBeenCalledWith({
      entryProduct: "booking",
      propertyId: "property-1",
    });
  });

  it("enters Booking solely from the server entry decision, regardless of launch tasks", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          propertyId: "property-2",
          decision: "enter",
          destinationRouteKey: "booking.workspace",
          withIncompleteTask: true,
        }),
      ),
    };
    const storage = memoryStorage();

    await expect(resolveBookingSetupGuard("/dashboard", api, storage)).resolves.toEqual({
      action: "enter_product",
      propertyId: "property-2",
      destinationRouteKey: "booking.workspace",
      redirectPath: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-2");
  });

  it("does not enter Booking when the server marks it unavailable", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          decision: "unavailable",
          reasonCode: "track_unavailable",
        }),
      ),
    };

    await expect(
      resolveBookingSetupGuard("/dashboard", api, memoryStorage()),
    ).resolves.toMatchObject({
      action: "redirect_to_setup",
      entryDecision: "unavailable",
      reasonCode: "track_unavailable",
    });
  });
});

function status(input: {
  propertyId?: string;
  decision: "enter" | "setup_required" | "unavailable";
  destinationRouteKey?: string;
  reasonCode?: string;
  withIncompleteTask?: boolean;
}): AdaptiveHotelSetupStatus {
  const propertyId = input.propertyId ?? "property-1";
  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: "org-1",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedTracks: ["hotel_operations"],
      trackRevision: 2,
      canManageTracks: true,
      tracks: [
        {
          track: "hotel_operations",
          provisioning: "active",
          components: [
            { product: "pms", access: "active" },
            {
              product: "booking",
              access: input.decision === "unavailable" ? "unavailable" : "active",
            },
          ],
          allowedActions: ["manage_service"],
        },
        {
          track: "creator_marketplace",
          provisioning: "not_selected",
          components: [{ product: "marketplace", access: "absent" }],
          allowedActions: ["add"],
        },
      ],
    },
    propertySelection: {
      state: "single_property",
      selectedPropertyId: propertyId,
      availableProperties: [
        {
          propertyId,
          publicId: propertyId,
          displayName: "Alpenrose",
          locationSummary: "Munich, DE",
        },
      ],
    },
    entryDecision: {
      requestedProduct: "booking",
      propertyId,
      decision: input.decision,
      destinationRouteKey: input.destinationRouteKey ?? null,
      reasonCode: input.reasonCode ?? null,
    },
    setupPlan: {
      propertyId,
      planRevision: "plan-2",
      tasks: input.withIncompleteTask
        ? [
            {
              taskId: "direct_booking_publication",
              propertyId,
              track: "hotel_operations",
              requirementOwnerDomain: "distribution",
              destinationRouteKey: "distribution.direct_booking_publication",
              callerCapability: "waiting",
              ownerProgress: "in_progress",
              readiness: "pending_sync",
              actionableBy: "system",
              reasonCodes: ["publication_pending"],
              sourceRevision: "publication-1",
              freshness: "fresh",
              evaluatedAt: "2026-07-26T10:00:00.000Z",
            },
          ]
        : [],
      recommendedTaskId: null,
      ownerProgress: { complete: 0, total: input.withIncompleteTask ? 1 : 0 },
      launchReadiness: {
        operationsUse: "ready",
        directBookingPublish: input.withIncompleteTask ? "pending" : "ready",
        marketplacePublish: "not_applicable",
      },
    },
    updatedAt: "2026-07-26T10:00:00.000Z",
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
