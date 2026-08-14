import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  resolvePropertyId: vi.fn(),
}));

vi.mock("../api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get, put: mocks.put },
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));

vi.mock("../api/pmsPropertyClient", () => ({
  getPmsPropertyProfile: vi.fn(),
  listPmsProperties: vi.fn(),
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
}));

vi.mock("../api/unsupported", () => ({ unsupportedPmsNextStackFeature: vi.fn() }));

import { settingsService } from ".";

describe("PMS booking acceptance settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolvePropertyId.mockResolvedValue("property-1");
  });

  it("reads and writes the typed target acceptance control", async () => {
    await settingsService.getBookingAcceptance();
    await settingsService.updateBookingAcceptance("request");

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/booking-acceptance",
      expect.any(Object),
    );
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/booking-acceptance",
      { acceptanceMode: "request" },
      expect.any(Object),
    );
  });
});
