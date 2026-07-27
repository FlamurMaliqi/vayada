import type { AdaptiveHotelSetupStatus } from "@vayada/domain-hotels";
import { describe, expect, it } from "vitest";

import { resolveSharedHotelSetupGuardDecision } from "./sharedHotelSetupGuard";

describe("resolveSharedHotelSetupGuardDecision", () => {
  it("uses the entry decision instead of setup task completion", () => {
    const status = baseStatus();
    status.entryDecision = {
      requestedProduct: "booking",
      propertyId: "property-1",
      decision: "enter",
      destinationRouteKey: "booking.workspace",
      reasonCode: null,
    };

    expect(
      resolveSharedHotelSetupGuardDecision(status, {
        entryProduct: "booking",
        returnTo: "/dashboard",
      }),
    ).toEqual({
      action: "enter_product",
      propertyId: "property-1",
      destinationRouteKey: "booking.workspace",
      redirectPath: null,
    });
  });

  it("redirects setup-required entry without selecting a track", () => {
    const status = baseStatus();
    status.entryDecision = {
      requestedProduct: "booking",
      propertyId: null,
      decision: "setup_required",
      destinationRouteKey: "hotel_setup",
      reasonCode: "track_not_selected",
    };

    expect(
      resolveSharedHotelSetupGuardDecision(status, {
        entryProduct: "booking",
        returnTo: "/dashboard",
      }),
    ).toEqual({
      action: "redirect_to_setup",
      propertyId: null,
      redirectPath: "/setup?entryProduct=booking&returnTo=%2Fdashboard",
      entryDecision: "setup_required",
      reasonCode: "track_not_selected",
    });
    expect(status.organization.selectedTracks).toEqual([]);
  });
});

function baseStatus(): AdaptiveHotelSetupStatus {
  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: "organization-1",
      displayName: "Alpenrose Group",
      websiteUrl: null,
      selectedTracks: [],
      trackRevision: 0,
      canManageTracks: true,
      tracks: [],
    },
    propertySelection: {
      state: "no_property",
      selectedPropertyId: null,
      availableProperties: [],
    },
    entryDecision: null,
    setupPlan: null,
    updatedAt: "2026-07-26T12:00:00.000Z",
  };
}
