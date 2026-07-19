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
      redirectPath:
        "/setup?entryProduct=booking&returnTo=%2Fdashboard%3Ftab%3Drooms&propertyId=property-1",
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

  it("opens Booking Admin when only downstream publish readiness remains", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          productStatus: "selected_incomplete",
          nextAction: {
            action: "complete_product_activation",
            propertyId: "property-3",
            product: "booking",
            missingSteps: ["publicBookability", "paymentReadiness"],
            reasonCodes: ["booking_activation_incomplete"],
          },
        }),
      ),
    };
    const storage = memoryStorage();

    const decision = await resolveBookingSetupGuard("/dashboard", api, storage);

    expect(decision).toEqual({
      action: "enter_product",
      propertyId: "property-3",
      redirectPath: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-3");
  });

  it("opens Booking Admin for an additive requirement it does not own yet", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          productStatus: "selected_incomplete",
          nextAction: {
            action: "complete_product_activation",
            propertyId: "property-3",
            product: "booking",
            missingSteps: ["futureBookingRequirement"],
            reasonCodes: ["booking_activation_incomplete"],
          },
        }),
      ),
    };

    await expect(resolveBookingSetupGuard("/dashboard", api, memoryStorage())).resolves.toEqual({
      action: "enter_product",
      propertyId: "property-3",
      redirectPath: null,
    });
  });

  it("does not bypass an unavailable Booking activation", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          productStatus: "unavailable",
          nextAction: {
            action: "complete_product_activation",
            propertyId: "property-3",
            product: "booking",
            missingSteps: ["publicBookability", "paymentReadiness"],
            reasonCodes: ["booking_unavailable"],
          },
        }),
      ),
    };

    const decision = await resolveBookingSetupGuard("/dashboard", api, memoryStorage());

    expect(decision).toMatchObject({
      action: "redirect_to_setup",
      propertyId: "property-3",
      productStatus: "unavailable",
    });
  });
});

function status(input: {
  nextAction: SharedHotelSetupStatus["nextAction"];
  productStatus?: "selected_incomplete" | "unavailable";
}): SharedHotelSetupStatus {
  const propertyId = "propertyId" in input.nextAction ? input.nextAction.propertyId : "property-1";
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "booking", returnTo: "/dashboard" },
    hotelGroup: {
      organizationId: "org-1",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedProducts: ["booking"],
    },
    selection: { state: "single_property", selectedPropertyId: "property-1" },
    properties: input.productStatus
      ? [
          {
            propertyId,
            publicId: propertyId,
            displayName: "Alpenrose",
            locationSummary: "Munich, DE",
            sharedProfile: {
              status: "complete",
              source: "canonical",
              completionPercent: 100,
              missingFields: [],
            },
            products: {
              booking: {
                product: "booking",
                status: input.productStatus,
                missingSteps:
                  "missingSteps" in input.nextAction ? input.nextAction.missingSteps : [],
                statusReasons: [],
                updatedAt: null,
              },
              pms: {
                product: "pms",
                status: "not_selected",
                missingSteps: [],
                statusReasons: [],
                updatedAt: null,
              },
              marketplace: {
                product: "marketplace",
                status: "not_selected",
                missingSteps: [],
                statusReasons: [],
                updatedAt: null,
              },
            },
          },
        ]
      : [],
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
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
