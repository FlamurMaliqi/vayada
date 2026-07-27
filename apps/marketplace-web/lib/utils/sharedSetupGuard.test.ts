import { describe, expect, it, vi } from "vitest";
import type { AdaptiveHotelSetupStatus } from "@vayada/product-onboarding";

import {
  marketplaceGuardRedirectPath,
  resolveMarketplaceActivationGuard,
  resolveMarketplaceSetupGuard,
} from "./sharedSetupGuard";

describe("Marketplace setup guards", () => {
  it("validates a task route against the property from the URL", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          propertyId: "property-from-url",
          decision: "enter",
          destinationRouteKey: "marketplace.workspace",
          withIncompleteTask: true,
        }),
      ),
    };

    await expect(
      resolveMarketplaceActivationGuard("/marketplace", " property-from-url ", { api }),
    ).resolves.toEqual({
      action: "enter_product",
      propertyId: "property-from-url",
      destinationRouteKey: "marketplace.workspace",
      redirectPath: null,
    });
    expect(api.getStatus).toHaveBeenCalledWith(
      {
        entryProduct: "marketplace",
        propertyId: "property-from-url",
      },
      { signal: undefined },
    );
  });

  it("routes setup_required decisions to the shared hub", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          decision: "setup_required",
          reasonCode: "product_access_pending",
        }),
      ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "property-1" });

    const decision = await resolveMarketplaceSetupGuard("/marketplace?tab=creators", api, storage);

    expect(decision).toEqual({
      action: "redirect_to_setup",
      propertyId: "property-1",
      redirectPath:
        "/setup?entryProduct=marketplace&returnTo=%2Fmarketplace%3Ftab%3Dcreators&propertyId=property-1",
      entryDecision: "setup_required",
      reasonCode: "product_access_pending",
    });
    expect(marketplaceGuardRedirectPath(decision)).toBe(decision.redirectPath);
  });

  it("enters Marketplace solely from the server entry decision despite incomplete tasks", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          propertyId: "property-2",
          decision: "enter",
          destinationRouteKey: "marketplace.workspace",
          withIncompleteTask: true,
        }),
      ),
    };
    const storage = memoryStorage();

    const decision = await resolveMarketplaceSetupGuard("/marketplace", api, storage);

    expect(decision).toEqual({
      action: "enter_product",
      propertyId: "property-2",
      destinationRouteKey: "marketplace.workspace",
      redirectPath: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-2");
    expect(marketplaceGuardRedirectPath(decision)).toBeNull();
  });

  it("clears a stale property selection before retrying the server decision", async () => {
    const api = {
      getStatus: vi
        .fn()
        .mockRejectedValueOnce({
          status: 403,
          data: { code: "missing_property_resource_link" },
        })
        .mockResolvedValueOnce(
          status({
            propertyId: "property-2",
            decision: "enter",
            destinationRouteKey: "marketplace.workspace",
          }),
        ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "stale-property" });

    await expect(resolveMarketplaceSetupGuard("/marketplace", api, storage)).resolves.toMatchObject(
      {
        action: "enter_product",
        propertyId: "property-2",
      },
    );
    expect(api.getStatus).toHaveBeenNthCalledWith(1, {
      entryProduct: "marketplace",
      propertyId: "stale-property",
    });
    expect(api.getStatus).toHaveBeenNthCalledWith(2, {
      entryProduct: "marketplace",
      propertyId: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-2");
  });

  it("does not enter Marketplace when the server marks it unavailable", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          decision: "unavailable",
          reasonCode: "track_unavailable",
        }),
      ),
    };

    await expect(
      resolveMarketplaceSetupGuard("/marketplace", api, memoryStorage()),
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
      selectedTracks: ["creator_marketplace"],
      trackRevision: 3,
      canManageTracks: true,
      tracks: [
        {
          track: "hotel_operations",
          provisioning: "not_selected",
          components: [
            { product: "pms", access: "absent" },
            { product: "booking", access: "absent" },
          ],
          allowedActions: ["add"],
        },
        {
          track: "creator_marketplace",
          provisioning: "active",
          components: [
            {
              product: "marketplace",
              access: input.decision === "unavailable" ? "unavailable" : "active",
            },
          ],
          allowedActions: ["manage_service"],
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
      requestedProduct: "marketplace",
      propertyId,
      decision: input.decision,
      destinationRouteKey: input.destinationRouteKey ?? null,
      reasonCode: input.reasonCode ?? null,
    },
    setupPlan: {
      propertyId,
      planRevision: "plan-3",
      tasks: input.withIncompleteTask
        ? [
            {
              taskId: "creator_offer",
              propertyId,
              track: "creator_marketplace",
              requirementOwnerDomain: "marketplace",
              destinationRouteKey: "marketplace.creator_offer",
              callerCapability: "allowed",
              ownerProgress: "in_progress",
              readiness: "actionable",
              actionableBy: "owner",
              reasonCodes: ["offer_missing"],
              sourceRevision: "offer-1",
              freshness: "fresh",
              evaluatedAt: "2026-07-26T10:00:00.000Z",
            },
          ]
        : [],
      recommendedTaskId: input.withIncompleteTask ? "creator_offer" : null,
      ownerProgress: { complete: 0, total: input.withIncompleteTask ? 1 : 0 },
      launchReadiness: {
        operationsUse: "not_applicable",
        directBookingPublish: "not_applicable",
        marketplacePublish: input.withIncompleteTask ? "blocked" : "ready",
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
