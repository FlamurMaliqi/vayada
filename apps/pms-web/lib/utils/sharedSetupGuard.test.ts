import { describe, expect, it, vi } from "vitest";
import type { SharedHotelSetupStatus } from "@vayada/product-onboarding";

import { isPmsRoomSetupDecision, resolvePmsSetupGuard } from "./sharedSetupGuard";

describe("resolvePmsSetupGuard", () => {
  it("redirects incomplete setup to the shared wizard with the PMS entry product", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          nextAction: {
            action: "select_products",
            propertyId: "property-1",
            reasonCodes: ["products_not_selected"],
          },
        }),
      ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "property-1" });

    const decision = await resolvePmsSetupGuard("/dashboard?view=rooms", api, storage);

    expect(api.getStatus).toHaveBeenCalledWith({
      entryProduct: "pms",
      returnTo: "/dashboard?view=rooms",
      propertyId: "property-1",
    });
    expect(decision).toEqual({
      action: "redirect_to_setup",
      propertyId: "property-1",
      redirectPath:
        "/setup?entryProduct=pms&returnTo=%2Fdashboard%3Fview%3Drooms&propertyId=property-1",
      setupAction: "select_products",
      product: null,
      productStatus: null,
      missingSteps: [],
    });
  });

  it("persists the property id when PMS can enter the product", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          nextAction: {
            action: "enter_product",
            propertyId: "property-2",
            product: "pms",
            returnTo: "/dashboard",
            reasonCodes: ["ready"],
          },
        }),
      ),
    };
    const storage = memoryStorage();

    const decision = await resolvePmsSetupGuard("/dashboard", api, storage);

    expect(decision).toEqual({
      action: "enter_product",
      propertyId: "property-2",
      redirectPath: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-2");
  });

  it("allows the rooms area to own PMS room activation steps only", () => {
    expect(
      isPmsRoomSetupDecision({
        action: "redirect_to_setup",
        propertyId: "property-1",
        redirectPath: "/setup?entryProduct=pms",
        setupAction: "complete_product_activation",
        product: "pms",
        productStatus: "selected_incomplete",
        missingSteps: ["roomTypes", "rooms", "ratePlans"],
      }),
    ).toBe(true);
    expect(
      isPmsRoomSetupDecision({
        action: "redirect_to_setup",
        propertyId: "property-1",
        redirectPath: "/setup?entryProduct=pms",
        setupAction: "complete_product_activation",
        product: "pms",
        productStatus: "selected_incomplete",
        missingSteps: ["productEntitlement", "rooms"],
      }),
    ).toBe(false);
    expect(
      isPmsRoomSetupDecision({
        action: "redirect_to_setup",
        propertyId: "property-1",
        redirectPath: "/setup?entryProduct=pms&propertyId=property-1",
        setupAction: "complete_product_activation",
        product: "pms",
        productStatus: "unavailable",
        missingSteps: ["roomTypes", "rooms", "ratePlans"],
      }),
    ).toBe(false);
  });
});

function status(input: {
  nextAction: SharedHotelSetupStatus["nextAction"];
}): SharedHotelSetupStatus {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "pms", returnTo: "/dashboard" },
    hotelGroup: {
      organizationId: "org-1",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedProducts: ["pms"],
    },
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
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
