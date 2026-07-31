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
        returnProduct: "booking",
        returnTo: "/dashboard",
        setupBaseUrl: "https://marketplace.localhost:1355",
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
        returnProduct: "booking",
        returnTo: "/dashboard",
        setupBaseUrl: "https://marketplace.localhost:1355",
      }),
    ).toEqual({
      action: "redirect_to_setup",
      propertyId: null,
      redirectPath:
        "https://marketplace.localhost:1355/setup?entryProduct=booking&returnProduct=booking&returnTo=%2Fdashboard",
      entryDecision: "setup_required",
      reasonCode: "track_not_selected",
    });
    expect(status.organization.selectedTracks).toEqual([]);
  });

  it("preserves the selected property and safe product return path on the canonical origin", () => {
    const status = baseStatus();
    status.propertySelection = {
      state: "single_property",
      selectedPropertyId: " property-1 ",
      availableProperties: [],
    };

    expect(
      resolveSharedHotelSetupGuardDecision(status, {
        entryProduct: "pms",
        returnProduct: "booking",
        returnTo: "/settings?section=booking",
        setupBaseUrl: "https://marketplace.localhost:1355",
      }),
    ).toMatchObject({
      redirectPath:
        "https://marketplace.localhost:1355/setup?entryProduct=pms&returnProduct=booking&returnTo=%2Fsettings%3Fsection%3Dbooking&propertyId=property-1",
    });
  });

  it("drops unsafe return paths from the canonical redirect", () => {
    const status = baseStatus();

    expect(
      resolveSharedHotelSetupGuardDecision(status, {
        entryProduct: "booking",
        returnProduct: "booking",
        returnTo: "https://attacker.example/dashboard",
        setupBaseUrl: "https://marketplace.localhost:1355",
      }),
    ).toMatchObject({
      redirectPath:
        "https://marketplace.localhost:1355/setup?entryProduct=booking&returnProduct=booking",
    });
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
