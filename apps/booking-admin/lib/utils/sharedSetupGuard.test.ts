import { describe, expect, it, vi } from "vitest";
import type { SharedHotelSetupStatus } from "@vayada/product-onboarding";

import { resolveBookingSetupGuard } from "./sharedSetupGuard";

describe("resolveBookingSetupGuard", () => {
  it("redirects incomplete setup to the shared wizard with the booking entry product", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          nextAction: {
            action: "complete_shared_profile",
            propertyId: "property-1",
            missingFields: ["media"],
            reasonCodes: ["shared_profile_incomplete"],
          },
        }),
      ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "property-1" });

    const decision = await resolveBookingSetupGuard("/dashboard?tab=rooms", api, storage);

    expect(api.getStatus).toHaveBeenCalledWith({
      entryProduct: "booking",
      returnTo: "/dashboard?tab=rooms",
      propertyId: "property-1",
    });
    expect(decision).toEqual({
      action: "redirect_to_setup",
      propertyId: "property-1",
      redirectPath: "/setup?entryProduct=booking&returnTo=%2Fdashboard%3Ftab%3Drooms",
      setupAction: "complete_shared_profile",
      product: null,
      productStatus: null,
      missingSteps: [],
    });
  });

  it("persists the property id when booking can enter the product", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          nextAction: {
            action: "enter_product",
            propertyId: "property-2",
            product: "booking",
            returnTo: "/dashboard",
            reasonCodes: ["ready"],
          },
        }),
      ),
    };
    const storage = memoryStorage();

    const decision = await resolveBookingSetupGuard("/dashboard", api, storage);

    expect(decision).toEqual({
      action: "enter_product",
      propertyId: "property-2",
      redirectPath: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-2");
  });
});

function status(input: {
  nextAction: SharedHotelSetupStatus["nextAction"];
}): SharedHotelSetupStatus {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "booking", returnTo: "/dashboard" },
    hotelGroup: { organizationId: "org-1", displayName: "Alpenrose Hotel Group" },
    selection: { state: "single_property", selectedPropertyId: "property-1" },
    properties: [],
    nextAction: input.nextAction,
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
