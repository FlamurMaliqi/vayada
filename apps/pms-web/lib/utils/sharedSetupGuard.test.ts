import { describe, expect, it, vi } from "vitest";
import type { AdaptiveHotelSetupStatus } from "@vayada/product-onboarding";

import { resolvePmsSetupGuard } from "./sharedSetupGuard";

describe("resolvePmsSetupGuard", () => {
  it("routes setup_required decisions to the shared hub", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          product: "pms",
          propertyId: "property-1",
          decision: "setup_required",
          reasonCode: "product_access_pending",
        }),
      ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "property-1" });

    await expect(resolvePmsSetupGuard("/dashboard?view=rooms", api, storage)).resolves.toEqual({
      action: "redirect_to_setup",
      propertyId: "property-1",
      redirectPath:
        "/setup?entryProduct=pms&returnTo=%2Fdashboard%3Fview%3Drooms&propertyId=property-1",
      entryDecision: "setup_required",
      reasonCode: "product_access_pending",
    });
    expect(api.getStatus).toHaveBeenCalledWith({
      entryProduct: "pms",
      propertyId: "property-1",
    });
  });

  it("enters PMS solely from the server entry decision, regardless of setup tasks", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          product: "pms",
          propertyId: "property-2",
          decision: "enter",
          destinationRouteKey: "pms.workspace",
          withIncompleteTask: true,
        }),
      ),
    };
    const storage = memoryStorage();

    await expect(resolvePmsSetupGuard("/dashboard", api, storage)).resolves.toEqual({
      action: "enter_product",
      propertyId: "property-2",
      destinationRouteKey: "pms.workspace",
      redirectPath: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-2");
  });

  it("does not enter PMS when the server marks it unavailable", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          product: "pms",
          propertyId: "property-1",
          decision: "unavailable",
          reasonCode: "track_unavailable",
        }),
      ),
    };

    await expect(resolvePmsSetupGuard("/dashboard", api, memoryStorage())).resolves.toMatchObject({
      action: "redirect_to_setup",
      entryDecision: "unavailable",
      reasonCode: "track_unavailable",
    });
  });
});

function status(input: {
  product: "pms";
  propertyId: string;
  decision: "enter" | "setup_required" | "unavailable";
  destinationRouteKey?: string;
  reasonCode?: string;
  withIncompleteTask?: boolean;
}): AdaptiveHotelSetupStatus {
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
            { product: "pms", access: input.decision === "unavailable" ? "unavailable" : "active" },
            { product: "booking", access: "active" },
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
      selectedPropertyId: input.propertyId,
      availableProperties: [
        {
          propertyId: input.propertyId,
          publicId: input.propertyId,
          displayName: "Alpenrose",
          locationSummary: "Munich, DE",
        },
      ],
    },
    entryDecision: {
      requestedProduct: input.product,
      propertyId: input.propertyId,
      decision: input.decision,
      destinationRouteKey: input.destinationRouteKey ?? null,
      reasonCode: input.reasonCode ?? null,
    },
    setupPlan: {
      propertyId: input.propertyId,
      planRevision: "plan-2",
      tasks: input.withIncompleteTask
        ? [
            {
              taskId: "rooms_rates_availability",
              propertyId: input.propertyId,
              track: "hotel_operations",
              requirementOwnerDomain: "pms",
              destinationRouteKey: "pms.rooms_rates_availability",
              callerCapability: "allowed",
              ownerProgress: "in_progress",
              readiness: "actionable",
              actionableBy: "owner",
              reasonCodes: ["rooms_missing"],
              sourceRevision: "rooms-1",
              freshness: "fresh",
              evaluatedAt: "2026-07-26T10:00:00.000Z",
            },
          ]
        : [],
      recommendedTaskId: input.withIncompleteTask ? "rooms_rates_availability" : null,
      ownerProgress: { complete: 0, total: input.withIncompleteTask ? 1 : 0 },
      launchReadiness: {
        operationsUse: input.withIncompleteTask ? "blocked" : "ready",
        directBookingPublish: "pending",
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
