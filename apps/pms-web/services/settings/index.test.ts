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

  it("reads and idempotently updates the target same-day cutoff", async () => {
    await settingsService.getSameDayBooking();
    await settingsService.updateSameDayBooking(true, "17:30");

    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/same-day-booking",
      expect.any(Object),
    );
    const [, body] = mocks.put.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({
      commandId: expect.stringMatching(/^pms\.same-day-booking:/),
      idempotencyKey: body.commandId,
      enabled: true,
      cutoffLocalTime: "17:30",
    });
  });
});
