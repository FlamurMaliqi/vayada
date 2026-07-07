import { describe, expect, it, vi } from "vitest";
import {
  resolveSharedFirstRunSetupView,
  type SharedHotelSetupStatus,
} from "@vayada/product-onboarding";

import { isMarketplaceActivationDecision, resolveMarketplaceSetupGuard } from "./sharedSetupGuard";

describe("resolveMarketplaceSetupGuard", () => {
  it("redirects incomplete setup to the shared wizard with the marketplace entry product", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          properties: [marketplaceActivationProperty("property-1")],
          nextAction: {
            action: "complete_product_activation",
            propertyId: "property-1",
            product: "marketplace",
            missingSteps: [
              "creatorPitch",
              "collaborationOffer",
              "creatorRequirements",
              "marketplaceListing",
            ],
            reasonCodes: ["product_activation_incomplete"],
          },
        }),
      ),
    };
    const storage = memoryStorage({ selectedSharedPropertyId: "property-1" });

    const decision = await resolveMarketplaceSetupGuard("/marketplace?tab=creators", api, storage);

    expect(api.getStatus).toHaveBeenCalledWith({
      entryProduct: "marketplace",
      returnTo: "/marketplace?tab=creators",
      propertyId: "property-1",
    });
    expect(decision).toEqual({
      action: "redirect_to_setup",
      propertyId: "property-1",
      redirectPath: "/setup?entryProduct=marketplace&returnTo=%2Fmarketplace%3Ftab%3Dcreators",
      setupAction: "complete_product_activation",
      product: "marketplace",
      productStatus: "selected_incomplete",
      missingSteps: [
        "creatorPitch",
        "collaborationOffer",
        "creatorRequirements",
        "marketplaceListing",
      ],
    });
    expect(isMarketplaceActivationDecision(decision)).toBe(true);
  });

  it("persists the property id when marketplace can enter the product", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          nextAction: {
            action: "enter_product",
            propertyId: "property-2",
            product: "marketplace",
            returnTo: "/marketplace",
            reasonCodes: ["ready"],
          },
        }),
      ),
    };
    const storage = memoryStorage();

    const decision = await resolveMarketplaceSetupGuard("/marketplace", api, storage);

    expect(decision).toEqual({
      action: "enter_product",
      propertyId: "property-2",
      redirectPath: null,
    });
    expect(storage.getItem("selectedSharedPropertyId")).toBe("property-2");
  });

  it("does not treat suspended Marketplace activation as profile-editable", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          properties: [marketplaceActivationProperty("property-1", "suspended", [])],
          nextAction: {
            action: "complete_product_activation",
            propertyId: "property-1",
            product: "marketplace",
            missingSteps: [],
            reasonCodes: ["marketplace_suspended"],
          },
        }),
      ),
    };

    const decision = await resolveMarketplaceSetupGuard("/profile", api, memoryStorage());

    expect(decision).toMatchObject({
      action: "redirect_to_setup",
      product: "marketplace",
      productStatus: "suspended",
      missingSteps: [],
    });
    expect(isMarketplaceActivationDecision(decision)).toBe(false);
  });

  it("does not treat entitlement-only Marketplace activation as profile-editable", async () => {
    const api = {
      getStatus: vi.fn(async () =>
        status({
          properties: [
            marketplaceActivationProperty("property-1", "selected_incomplete", [
              "productEntitlement",
            ]),
          ],
          nextAction: {
            action: "complete_product_activation",
            propertyId: "property-1",
            product: "marketplace",
            missingSteps: ["productEntitlement"],
            reasonCodes: ["entry_product_activation_incomplete"],
          },
        }),
      ),
    };

    const decision = await resolveMarketplaceSetupGuard("/profile", api, memoryStorage());

    expect(decision).toMatchObject({
      action: "redirect_to_setup",
      product: "marketplace",
      productStatus: "selected_incomplete",
      missingSteps: ["productEntitlement"],
    });
    expect(isMarketplaceActivationDecision(decision)).toBe(false);
  });

  it("labels incomplete Marketplace activation for the selected shared property", () => {
    const setupStatus = status({
      properties: [marketplaceActivationProperty("property-1")],
      nextAction: {
        action: "complete_product_activation",
        propertyId: "property-1",
        product: "marketplace",
        missingSteps: [
          "creatorPitch",
          "collaborationOffer",
          "creatorRequirements",
          "marketplaceListing",
        ],
        reasonCodes: ["entry_product_activation_incomplete"],
      },
    });

    const view = resolveSharedFirstRunSetupView(setupStatus);

    expect(view).toMatchObject({
      screen: "product_activation",
      selectedPropertyId: "property-1",
      product: "marketplace",
      title: "Set up Marketplace for Alpenrose Munich",
    });
    expect(view.selectedProperty?.sharedProfile).toMatchObject({
      status: "complete",
      missingFields: [],
    });
  });
});

function status(input: {
  nextAction: SharedHotelSetupStatus["nextAction"];
  properties?: SharedHotelSetupStatus["properties"];
}): SharedHotelSetupStatus {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "marketplace", returnTo: "/marketplace" },
    hotelGroup: { organizationId: "org-1", displayName: "Alpenrose Hotel Group" },
    selection: { state: "single_property", selectedPropertyId: "property-1" },
    properties: input.properties ?? [],
    nextAction: input.nextAction,
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function marketplaceActivationProperty(
  propertyId: string,
  status:
    | "not_selected"
    | "selected_incomplete"
    | "active"
    | "suspended"
    | "unavailable" = "selected_incomplete",
  missingSteps: string[] = [
    "creatorPitch",
    "collaborationOffer",
    "creatorRequirements",
    "marketplaceListing",
  ],
): SharedHotelSetupStatus["properties"][number] {
  return {
    propertyId,
    publicId: "alpenrose-munich",
    displayName: "Alpenrose Munich",
    locationSummary: "Munich, DE",
    sharedProfile: {
      status: "complete",
      source: "canonical",
      completionPercent: 100,
      missingFields: [],
    },
    products: {
      booking: activation("booking", "active"),
      pms: activation("pms", "not_selected"),
      marketplace: activation("marketplace", status, missingSteps),
    },
  };
}

function activation<Product extends "booking" | "pms" | "marketplace">(
  product: Product,
  status: "not_selected" | "selected_incomplete" | "active" | "suspended" | "unavailable",
  missingSteps: string[] = [],
) {
  return {
    product,
    status,
    missingSteps,
    statusReasons: status === "selected_incomplete" ? [`${product}_activation_incomplete`] : [],
    updatedAt: status === "not_selected" ? null : "2026-06-30T00:00:00.000Z",
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
