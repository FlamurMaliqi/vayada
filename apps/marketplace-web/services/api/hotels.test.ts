import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("./client", () => ({
  apiClient: mocks,
}));

vi.mock("@vayada/marketplace-shared/api/discovery", () => ({
  getAllMarketplaceOffers: vi.fn(),
}));

vi.mock("@vayada/marketplace-shared/api/platformMedia", () => ({
  uploadPlatformMedia: vi.fn(),
}));

import { hotelService } from "./hotels";

describe("hotelService.getProfileStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads hotel profile status from the target marketplace route", async () => {
    const profileStatus = {
      profile_complete: true,
      missing_fields: [],
      has_defaults: { location: false },
      missing_offers: false,
      completion_steps: [],
    };
    mocks.get.mockResolvedValue(profileStatus);

    await expect(hotelService.getProfileStatus()).resolves.toBe(profileStatus);

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith("/api/marketplace/hotels/me/profile-status");
    expect(mocks.get).not.toHaveBeenCalledWith("/hotels/me/profile-status");
  });
});
