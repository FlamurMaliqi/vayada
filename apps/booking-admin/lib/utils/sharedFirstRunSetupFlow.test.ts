import { describe, expect, it } from "vitest";

import {
  createSharedHotelSetupApi,
  isSafeSharedHotelSetupReturnTo,
  resolveSharedFirstRunSetupView,
  type AdaptiveHotelSetupStatus,
  type SetupTask,
  type SetupTrack,
  type SharedSetupProperty,
} from "@vayada/product-onboarding";

describe("adaptive shared first-run setup", () => {
  it("rejects encoded backslash redirects that browsers normalize cross-origin", () => {
    expect(isSafeSharedHotelSetupReturnTo("/dashboard?tab=rooms")).toBe(true);
    expect(isSafeSharedHotelSetupReturnTo("/%5Cattacker.example")).toBe(false);
    expect(isSafeSharedHotelSetupReturnTo("/%255Cattacker.example")).toBe(false);
    expect(isSafeSharedHotelSetupReturnTo("//attacker.example")).toBe(false);
  });

  it("asks for a setup track before collecting property details", () => {
    expect(
      resolveSharedFirstRunSetupView(status({ selectedTracks: [], properties: [] })),
    ).toMatchObject({
      screen: "track_selection",
      title: "Choose how you’ll use vayada",
    });
  });

  it("starts first-property users on the shared property profile", () => {
    expect(resolveSharedFirstRunSetupView(status({ properties: [] }))).toMatchObject({
      screen: "property_profile",
      profileMode: "create",
      selectedPropertyId: null,
      title: "Let’s get to know your hotel",
    });
  });

  it("shows a property selector when multiple properties have no active selection", () => {
    expect(
      resolveSharedFirstRunSetupView(
        status({ properties: [property("property-1"), property("property-2")] }),
      ),
    ).toMatchObject({
      screen: "property_selection",
      profileMode: null,
      selectedPropertyId: null,
      title: "Choose hotel",
    });
  });

  it("routes an actionable shared-identity task to the property update form", () => {
    expect(
      resolveSharedFirstRunSetupView(
        status({
          properties: [property("property-1", { displayName: "Alpenrose Munich" })],
          selectedPropertyId: "property-1",
          sharedIdentityIncomplete: true,
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
        }),
        { forceCreateProperty: true },
      ),
    ).toMatchObject({
      screen: "property_profile",
      profileMode: "create",
      selectedPropertyId: null,
      title: "Let’s get to know this hotel",
    });
  });

  it("keeps entry product and property on status reads without sending UI return paths", async () => {
    const endpoints: string[] = [];
    const api = createSharedHotelSetupApi({
      async get<T>(endpoint: string) {
        endpoints.push(endpoint);
        return status({
          entryProduct: "pms",
          properties: [property("property-1")],
          selectedPropertyId: "property-1",
        }) as T;
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
      propertyId: "property-1",
    });

    expect(endpoints).toEqual(["/api/hotel-setup/status?entryProduct=pms&propertyId=property-1"]);
  });

  it("reads property types from the adaptive setup catalog endpoint", async () => {
    const endpoints: string[] = [];
    const api = createSharedHotelSetupApi({
      async get<T>(endpoint: string) {
        endpoints.push(endpoint);
        return {
          contractVersion: "adaptive-hotel-property-types.v1",
          propertyTypes: [{ value: "hotel", label: "Hotel from API" }],
        } as T;
      },
      async post() {
        throw new Error("post is not used by this test");
      },
      async put() {
        throw new Error("put is not used by this test");
      },
    });

    await expect(api.getPropertyTypes()).resolves.toEqual({
      contractVersion: "adaptive-hotel-property-types.v1",
      propertyTypes: [{ value: "hotel", label: "Hotel from API" }],
    });
    expect(endpoints).toEqual(["/api/hotel-setup/property-types"]);
  });
});

function status(input: {
  properties: SharedSetupProperty[];
  selectedTracks?: AdaptiveHotelSetupStatus["organization"]["selectedTracks"];
  selectedPropertyId?: string | null;
  sharedIdentityIncomplete?: boolean;
  entryProduct?: "booking" | "pms" | "marketplace";
}): AdaptiveHotelSetupStatus {
  const selectedTracks = input.selectedTracks ?? ["hotel_operations"];
  const selectedPropertyId =
    input.selectedPropertyId ??
    (input.properties.length === 1 ? input.properties[0]!.propertyId : null);
  const tasks = selectedPropertyId
    ? setupTasks(selectedPropertyId, selectedTracks, input.sharedIdentityIncomplete === true)
    : [];
  const completeTasks = tasks.filter(
    ({ ownerProgress }) => ownerProgress === "owner_complete",
  ).length;

  return {
    contractVersion: "adaptive-hotel-setup.v1",
    organization: {
      organizationId: "org_1",
      displayName: "Alpenrose Hotel Group",
      websiteUrl: null,
      selectedTracks,
      trackRevision: selectedTracks.length,
      canManageTracks: true,
      tracks: [
        {
          track: "hotel_operations",
          provisioning: selectedTracks.includes("hotel_operations") ? "active" : "not_selected",
          components: [
            {
              product: "pms",
              access: selectedTracks.includes("hotel_operations") ? "active" : "absent",
            },
            {
              product: "booking",
              access: selectedTracks.includes("hotel_operations") ? "active" : "absent",
            },
          ],
          allowedActions: selectedTracks.includes("hotel_operations")
            ? ["manage_service"]
            : ["add"],
        },
        {
          track: "creator_marketplace",
          provisioning: selectedTracks.includes("creator_marketplace") ? "active" : "not_selected",
          components: [
            {
              product: "marketplace",
              access: selectedTracks.includes("creator_marketplace") ? "active" : "absent",
            },
          ],
          allowedActions: selectedTracks.includes("creator_marketplace")
            ? ["manage_service"]
            : ["add"],
        },
      ],
    },
    propertySelection: {
      state:
        input.properties.length === 0
          ? "no_property"
          : input.properties.length === 1
            ? "single_property"
            : "multiple_properties",
      selectedPropertyId,
      availableProperties: input.properties,
    },
    entryDecision:
      selectedPropertyId && selectedTracks.includes("hotel_operations")
        ? {
            requestedProduct: input.entryProduct ?? "booking",
            propertyId: selectedPropertyId,
            decision: "enter",
            destinationRouteKey: `${input.entryProduct ?? "booking"}.workspace`,
            reasonCode: null,
          }
        : {
            requestedProduct: input.entryProduct ?? "booking",
            propertyId: selectedPropertyId,
            decision: "setup_required",
            destinationRouteKey: "hotel_setup",
            reasonCode: selectedPropertyId ? "track_not_selected" : "property_selection_required",
          },
    setupPlan: selectedPropertyId
      ? {
          propertyId: selectedPropertyId,
          planRevision: "plan-1",
          tasks,
          recommendedTaskId: input.sharedIdentityIncomplete ? "shared_identity" : null,
          ownerProgress: { complete: completeTasks, total: tasks.length },
          launchReadiness: {
            operationsUse: selectedTracks.includes("hotel_operations")
              ? input.sharedIdentityIncomplete
                ? "pending"
                : "ready"
              : "not_applicable",
            directBookingPublish: selectedTracks.includes("hotel_operations")
              ? input.sharedIdentityIncomplete
                ? "pending"
                : "ready"
              : "not_applicable",
            marketplacePublish: selectedTracks.includes("creator_marketplace")
              ? input.sharedIdentityIncomplete
                ? "pending"
                : "ready"
              : "not_applicable",
          },
        }
      : null,
    updatedAt: "2026-07-26T10:00:00.000Z",
  };
}

function setupTasks(
  propertyId: string,
  selectedTracks: SetupTrack[],
  sharedIdentityIncomplete: boolean,
): SetupTask[] {
  const definitions: Array<
    Pick<SetupTask, "taskId" | "track" | "requirementOwnerDomain" | "destinationRouteKey">
  > = [
    {
      taskId: "shared_identity",
      track: "shared",
      requirementOwnerDomain: "hotel_catalog",
      destinationRouteKey: "hotel_catalog.shared_identity",
    },
    {
      taskId: "public_profile",
      track: "creator_marketplace",
      requirementOwnerDomain: "hotel_catalog",
      destinationRouteKey: "hotel_catalog.public_profile",
    },
    {
      taskId: "creator_offer",
      track: "creator_marketplace",
      requirementOwnerDomain: "marketplace",
      destinationRouteKey: "marketplace.creator_offer",
    },
    {
      taskId: "rooms_rates_availability",
      track: "hotel_operations",
      requirementOwnerDomain: "pms",
      destinationRouteKey: "pms.rooms_rates_availability",
    },
    {
      taskId: "guest_settings_policies",
      track: "hotel_operations",
      requirementOwnerDomain: "booking",
      destinationRouteKey: "booking.guest_settings_policies",
    },
    {
      taskId: "billing_plan",
      track: "hotel_operations",
      requirementOwnerDomain: "finance",
      destinationRouteKey: "finance.billing_plan",
    },
    {
      taskId: "payment",
      track: "hotel_operations",
      requirementOwnerDomain: "finance",
      destinationRouteKey: "finance.payment",
    },
    {
      taskId: "direct_booking_publication",
      track: "hotel_operations",
      requirementOwnerDomain: "distribution",
      destinationRouteKey: "distribution.direct_booking_publication",
    },
  ];

  return definitions
    .filter(
      ({ track }) =>
        (track === "shared" && selectedTracks.length > 0) ||
        (track !== "shared" && selectedTracks.includes(track)),
    )
    .map((definition) => {
      const incomplete = definition.taskId === "shared_identity" && sharedIdentityIncomplete;
      return {
        ...definition,
        propertyId,
        callerCapability: "allowed",
        ownerProgress: incomplete ? "in_progress" : "owner_complete",
        readiness: incomplete ? "actionable" : "complete",
        actionableBy: incomplete ? "owner" : null,
        reasonCodes: incomplete ? ["profile_incomplete"] : [],
        sourceRevision: `${definition.taskId}-1`,
        freshness: "fresh",
        evaluatedAt: "2026-07-26T10:00:00.000Z",
      };
    });
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
  };
}
