import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "./client";
import {
  getPropertyRetirementImpact,
  provisionProperty,
  retireProperty,
  updatePropertyStatus,
} from "./growthDashboard";

vi.mock("./client", () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

describe("platform property lifecycle client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the target impact route", async () => {
    vi.mocked(apiClient.get).mockResolvedValue({});
    await getPropertyRetirementImpact("property-1");
    expect(apiClient.get).toHaveBeenCalledWith(
      "/api/platform/admin/properties/property-1/retirement-impact",
    );
  });

  it("sends revision-guarded status and confirmed retirement commands", async () => {
    vi.mocked(apiClient.patch).mockResolvedValue({});
    vi.mocked(apiClient.post).mockResolvedValue({});

    await updatePropertyStatus("property-1", {
      expectedLifecycleRevision: 4,
      status: "suspended",
      reason: "Safety hold",
    });
    expect(apiClient.patch).toHaveBeenCalledWith(
      "/api/platform/admin/properties/property-1/status",
      { expectedLifecycleRevision: 4, status: "suspended", reason: "Safety hold" },
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }),
      }),
    );

    await retireProperty("property-1", {
      expectedLifecycleRevision: 5,
      reason: "Account closed",
    });
    expect(apiClient.post).toHaveBeenCalledWith(
      "/api/platform/admin/properties/property-1/retire",
      { expectedLifecycleRevision: 5, reason: "Account closed", confirmation: "RETIRE" },
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }),
      }),
    );
  });

  it("provisions with the canonical profile and a stable caller reference", async () => {
    vi.mocked(apiClient.post).mockResolvedValue({});
    const request = {
      accountUserId: "account-1",
      provisioningReference: "support-case-1",
      reason: "Hotel owner requested platform setup",
      profile: {
        displayName: "Hotel Target",
        propertyType: "hotel",
        location: {
          streetAddress: "1 Main Street",
          postalCode: "10000",
          city: "Athens",
          countryCode: "GR",
          timezone: "Europe/Athens",
          latitude: null,
          longitude: null,
          localityPublic: true,
          geoPublic: false,
          mapDisplayMode: "approximate" as const,
        },
        contacts: [
          {
            channelType: "email" as const,
            value: "hotel@example.com",
            purpose: "general" as const,
            isPublic: true,
          },
        ],
      },
    };
    await provisionProperty(request);
    expect(apiClient.post).toHaveBeenCalledWith(
      "/api/platform/admin/properties/provision",
      request,
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }),
      }),
    );
  });
});
