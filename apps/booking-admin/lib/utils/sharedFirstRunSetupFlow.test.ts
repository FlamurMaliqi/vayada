import { describe, expect, it } from "vitest";

import {
  createSharedHotelSetupApi,
  isSafeSharedHotelSetupReturnTo,
  isSharedHotelSetupProductSelectable,
  resolveSharedFirstRunSetupView,
  type SharedHotelSetupStatus,
  type SharedSetupProperty,
} from "@vayada/product-onboarding";

describe("resolveSharedFirstRunSetupView", () => {
  it("rejects encoded backslash redirects that browsers normalize cross-origin", () => {
    expect(isSafeSharedHotelSetupReturnTo("/dashboard?tab=rooms")).toBe(true);
    expect(isSafeSharedHotelSetupReturnTo("/%5Cattacker.example")).toBe(false);
    expect(isSafeSharedHotelSetupReturnTo("/%255Cattacker.example")).toBe(false);
    expect(isSafeSharedHotelSetupReturnTo("//attacker.example")).toBe(false);
  });

  it("starts first-property users on the property profile form", () => {
    expect(resolveSharedFirstRunSetupView(status({ properties: [] }))).toMatchObject({
      screen: "property_profile",
      profileMode: "create",
      selectedPropertyId: null,
      title: "Add your first hotel",
    });
  });

  it("shows a property selector when the hotel group owns multiple properties", () => {
    expect(
      resolveSharedFirstRunSetupView(
        status({
          properties: [property("property-1"), property("property-2")],
          nextAction: { action: "select_property", reasonCodes: ["multiple_properties"] },
        }),
      ),
    ).toMatchObject({
      screen: "property_selection",
      profileMode: null,
      selectedPropertyId: null,
      title: "Choose property",
    });
  });

  it("routes incomplete shared profiles to the update form for the selected property", () => {
    expect(
      resolveSharedFirstRunSetupView(
        status({
          properties: [property("property-1", { displayName: "Alpenrose Munich" })],
          selectedPropertyId: "property-1",
          nextAction: {
            action: "complete_shared_profile",
            propertyId: "property-1",
            missingFields: ["media"],
            reasonCodes: ["shared_profile_incomplete"],
          },
        }),
      ),
    ).toMatchObject({
      screen: "property_profile",
      profileMode: "update",
      selectedPropertyId: "property-1",
      title: "Alpenrose Munich",
    });
  });

  it("can force add-property mode inside the current hotel group", () => {
    expect(
      resolveSharedFirstRunSetupView(
        status({
          properties: [property("property-1"), property("property-2")],
          nextAction: { action: "select_property", reasonCodes: ["multiple_properties"] },
        }),
        { forceCreateProperty: true },
      ),
    ).toMatchObject({
      screen: "property_profile",
      profileMode: "create",
      selectedPropertyId: null,
      title: "Add hotel",
    });
  });

  it("allows account selection despite one unavailable hotel but blocks suspended access", () => {
    const setupProperty = property("property-1");
    setupProperty.products.booking.status = "active";
    setupProperty.products.pms.status = "unavailable";
    setupProperty.products.marketplace.status = "suspended";

    expect(isSharedHotelSetupProductSelectable(setupProperty, "booking")).toBe(true);
    expect(isSharedHotelSetupProductSelectable(setupProperty, "pms")).toBe(true);
    expect(isSharedHotelSetupProductSelectable(setupProperty, "marketplace")).toBe(false);
  });

  it("keeps entry product, return path, and selected property on status reads", async () => {
    const endpoints: string[] = [];
    const api = createSharedHotelSetupApi({
      async get<T>(endpoint: string) {
        endpoints.push(endpoint);
        return status({ properties: [] }) as T;
      },
      async post() {
        throw new Error("post is not used by this test");
      },
      async put() {
        throw new Error("put is not used by this test");
      },
    });

    await api.getStatus({
      entryProduct: "pms",
      returnTo: "/dashboard?view=rooms",
      propertyId: "property-1",
    });

    expect(endpoints).toEqual([
      "/api/hotel-setup/status?entryProduct=pms&returnTo=%2Fdashboard%3Fview%3Drooms&propertyId=property-1",
    ]);
  });
});

function status(input: {
  properties: SharedSetupProperty[];
  selectedPropertyId?: string | null;
  nextAction?: SharedHotelSetupStatus["nextAction"];
}): SharedHotelSetupStatus {
  return {
    contractVersion: "shared-hotel-setup-status.v1",
    entry: { entryProduct: "booking", returnTo: "/dashboard" },
    hotelGroup: {
      organizationId: "org_1",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedProducts: ["booking"],
    },
    selection: {
      state:
        input.properties.length === 0
          ? "no_property"
          : input.properties.length === 1
            ? "single_property"
            : "multiple_properties",
      selectedPropertyId: input.selectedPropertyId ?? null,
    },
    properties: input.properties,
    nextAction: input.nextAction ?? { action: "create_property", reasonCodes: ["no_property"] },
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function property(
  propertyId: string,
  input: Partial<Pick<SharedSetupProperty, "displayName" | "locationSummary">> = {},
): SharedSetupProperty {
  return {
    propertyId,
    publicId: propertyId,
    displayName: input.displayName ?? propertyId,
    locationSummary: input.locationSummary ?? "Munich, DE",
    sharedProfile: {
      status: "incomplete",
      source: "canonical",
      completionPercent: 83,
      missingFields: ["media"],
    },
    products: {
      booking: {
        product: "booking",
        status: "not_selected",
        missingSteps: [],
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
  };
}
