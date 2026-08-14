import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdaptiveHotelSetupStatus } from "@vayada/product-onboarding";

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getPropertyProfile: vi.fn(),
  updatePropertyProfile: vi.fn(),
}));

vi.mock("./sharedHotelSetupClient", () => ({
  sharedHotelSetupApi: {
    getStatus: mocks.getStatus,
    getPropertyProfile: mocks.getPropertyProfile,
    updatePropertyProfile: mocks.updatePropertyProfile,
  },
}));

import {
  getPmsPropertyProfile,
  resolveSelectedPmsPropertyId,
  updatePmsPropertyProfile,
} from "./pmsPropertyClient";

const propertyId = "property-1";
const storedValues = new Map<string, string>();
const status: AdaptiveHotelSetupStatus = {
  contractVersion: "adaptive-hotel-setup.v1",
  organization: {
    organizationId: "organization-1",
    displayName: "Berlin Hotels",
    websiteUrl: null,
    selectedTracks: ["hotel_operations"],
    trackRevision: 1,
    canManageTracks: true,
    tracks: [
      {
        track: "hotel_operations",
        provisioning: "active",
        components: [
          { product: "pms", access: "active" },
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
    selectedPropertyId: propertyId,
    availableProperties: [
      {
        propertyId,
        publicId: "berlin-house",
        displayName: "Berlin House",
        locationSummary: "Berlin, Germany",
      },
    ],
  },
  entryDecision: {
    requestedProduct: "pms",
    propertyId,
    decision: "enter",
    destinationRouteKey: "pms.workspace",
    reasonCode: "ready",
  },
  setupPlan: {
    propertyId,
    planRevision: "plan-1",
    tasks: [],
    recommendedTaskId: null,
    ownerProgress: { complete: 0, total: 0 },
    launchReadiness: {
      operationsUse: "ready",
      directBookingPublish: "pending",
      marketplacePublish: "not_applicable",
    },
  },
  updatedAt: "2026-07-22T10:00:00.000Z",
};

const profile = {
  propertyId,
  profileRevision: 4,
  profile: {
    displayName: "Berlin House",
    propertyType: "hotel",
    location: {
      countryCode: "DE",
      city: "Berlin",
      streetAddress: "Teststrasse 42",
      postalCode: "10115",
      timezone: "Europe/Berlin",
      latitude: 52.52,
      longitude: 13.405,
      localityPublic: true,
      geoPublic: true,
      mapDisplayMode: "exact" as const,
    },
    contacts: [
      {
        channelType: "email" as const,
        value: "hotel@example.com",
        purpose: "general" as const,
        isPublic: false,
      },
      {
        channelType: "phone" as const,
        value: "+4930123456",
        purpose: "general" as const,
        isPublic: false,
      },
    ],
  },
};

describe("PMS property profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storedValues.clear();
    storedValues.set("selectedHotelId", propertyId);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) => storedValues.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => storedValues.set(key, value)),
        removeItem: vi.fn((key: string) => storedValues.delete(key)),
      },
    });
    mocks.getStatus.mockResolvedValue(status);
    mocks.getPropertyProfile.mockResolvedValue(profile);
    mocks.updatePropertyProfile.mockImplementation(async (_id, request) => ({
      ...profile,
      profileRevision: profile.profileRevision + 1,
      profile: {
        ...profile.profile,
        location: {
          ...profile.profile.location,
          ...request.patch.location,
        },
      },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads country and timezone from the canonical shared hotel profile", async () => {
    await expect(getPmsPropertyProfile()).resolves.toMatchObject({
      id: propertyId,
      name: "Berlin House",
      country: "DE",
      timezone: "Europe/Berlin",
      location: "Berlin, DE",
    });
    expect(mocks.getPropertyProfile).toHaveBeenCalledWith(propertyId);
  });

  it("updates country and timezone through the canonical shared hotel profile", async () => {
    const result = await updatePmsPropertyProfile({ country: "at", timezone: "Europe/Vienna" });

    expect(mocks.updatePropertyProfile).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({
        expectedProfileRevision: 4,
        patch: {
          location: {
            countryCode: "AT",
            timezone: "Europe/Vienna",
          },
        },
      }),
    );
    expect(result).toMatchObject({ country: "AT", timezone: "Europe/Vienna" });
  });

  it("keeps unsupported booking acceptance fields behind their explicit gate", async () => {
    await expect(updatePmsPropertyProfile({ instantBook: true })).rejects.toThrow(
      "PMS booking acceptance settings is not available on PMS next-stack yet.",
    );
    expect(mocks.updatePropertyProfile).not.toHaveBeenCalled();
  });

  it("waits for property discovery when direct navigation starts without a stored selection", async () => {
    storedValues.clear();
    let finishDiscovery!: (value: AdaptiveHotelSetupStatus) => void;
    mocks.getStatus.mockReturnValueOnce(
      new Promise<AdaptiveHotelSetupStatus>((resolve) => {
        finishDiscovery = resolve;
      }),
    );

    const resolution = resolveSelectedPmsPropertyId("loading booking details");
    finishDiscovery(status);

    await expect(resolution).resolves.toBe(propertyId);
    expect(storedValues.get("selectedHotelId")).toBe(propertyId);
    expect(storedValues.get("selectedSharedPropertyId")).toBe(propertyId);
  });

  it("uses a property selected by another initializer while multi-property discovery is pending", async () => {
    storedValues.clear();
    const secondPropertyId = "property-2";
    let finishDiscovery!: (value: AdaptiveHotelSetupStatus) => void;
    mocks.getStatus.mockReturnValueOnce(
      new Promise<AdaptiveHotelSetupStatus>((resolve) => {
        finishDiscovery = resolve;
      }),
    );

    const resolution = resolveSelectedPmsPropertyId("loading booking details");
    storedValues.set("selectedSharedPropertyId", secondPropertyId);
    finishDiscovery({
      ...status,
      propertySelection: {
        state: "multiple_properties",
        selectedPropertyId: null,
        availableProperties: [
          ...status.propertySelection.availableProperties,
          {
            propertyId: secondPropertyId,
            publicId: "vienna-house",
            displayName: "Vienna House",
            locationSummary: "Vienna, Austria",
          },
        ],
      },
    });

    await expect(resolution).resolves.toBe(secondPropertyId);
    expect(storedValues.get("selectedHotelId")).toBe(secondPropertyId);
  });

  it("reports no selection only after discovery confirms there are no properties", async () => {
    storedValues.clear();
    mocks.getStatus.mockResolvedValueOnce({
      ...status,
      propertySelection: {
        state: "no_property",
        selectedPropertyId: null,
        availableProperties: [],
      },
    });

    await expect(resolveSelectedPmsPropertyId("loading booking details")).rejects.toThrow(
      "Select a PMS property before loading booking details.",
    );
  });
});
