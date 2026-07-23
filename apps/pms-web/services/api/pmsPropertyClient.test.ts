import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedHotelSetupStatus, SharedPropertyProfile } from "@vayada/product-onboarding";

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
  isPmsPropertyReady,
  updatePmsPropertyProfile,
  type PmsPropertySummary,
} from "./pmsPropertyClient";

const propertyId = "property-1";
const status = {
  properties: [
    {
      propertyId,
      sharedProfile: {
        status: "complete" as const,
        source: "canonical" as const,
        completionPercent: 100,
        missingFields: [],
      },
      products: {
        pms: {
          status: "active" as const,
        },
      },
    },
  ],
} as unknown as SharedHotelSetupStatus;

const profile: SharedPropertyProfile = {
  propertyId,
  publicId: "berlin-house",
  displayName: "Berlin House",
  propertyType: "hotel",
  location: {
    countryCode: "DE",
    region: "Berlin",
    city: "Berlin",
    streetAddress: "Teststrasse 42",
    postalCode: "10115",
    rawMarketplaceLocation: "Berlin, Germany",
    timezone: "Europe/Berlin",
    latitude: 52.52,
    longitude: 13.405,
    addressPublic: true,
    mapDisplayMode: "exact" as const,
  },
  website: "https://berlin-house.example",
  contactEmail: "hotel@example.com",
  phone: "+4930123456",
  shortDescription: "A hotel in Berlin.",
  longDescription: "A centrally located hotel in Berlin.",
  media: [],
  sharedProfile: status.properties[0]!.sharedProfile,
  updatedAt: "2026-07-22T10:00:00.000Z",
};

describe("PMS property profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => propertyId),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
    mocks.getStatus.mockResolvedValue(status);
    mocks.getPropertyProfile.mockResolvedValue(profile);
    mocks.updatePropertyProfile.mockImplementation(async (_id, input) => ({
      ...profile,
      ...input,
      propertyId,
      publicId: profile.publicId,
      sharedProfile: profile.sharedProfile,
      updatedAt: "2026-07-22T11:00:00.000Z",
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
      location: "Berlin, Germany",
    });
    expect(mocks.getPropertyProfile).toHaveBeenCalledWith(propertyId);
  });

  it("updates country and timezone through the canonical shared hotel profile", async () => {
    const result = await updatePmsPropertyProfile({ country: "at", timezone: "Europe/Vienna" });

    expect(mocks.updatePropertyProfile).toHaveBeenCalledWith(
      propertyId,
      expect.objectContaining({
        displayName: "Berlin House",
        contactEmail: "hotel@example.com",
        expectedUpdatedAt: "2026-07-22T10:00:00.000Z",
        location: expect.objectContaining({
          countryCode: "AT",
          timezone: "Europe/Vienna",
          streetAddress: "Teststrasse 42",
        }),
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
});

describe("isPmsPropertyReady", () => {
  it.each([
    ["active", true],
    ["selected_incomplete", false],
    ["not_selected", false],
    ["suspended", false],
    ["unavailable", false],
  ] as const)("treats %s PMS access as ready: %s", (pmsStatus, expected) => {
    const property = { pmsStatus } as PmsPropertySummary;

    expect(isPmsPropertyReady(property)).toBe(expected);
  });
});
