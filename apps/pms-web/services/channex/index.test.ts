import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  resolvePropertyId: vi.fn().mockResolvedValue("property-1"),
}));

vi.mock("@/services/api/pmsOperationsClient", () => ({
  pmsOperationsClient: { get: mocks.get, post: mocks.post, put: mocks.put },
  pmsOperationsRequestOptions: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));
vi.mock("@/services/api/pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: mocks.resolvePropertyId,
}));

import { channexService } from ".";

describe("target PMS Channex client", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads the complete property-scoped management snapshot", async () => {
    const snapshot = { contractVersion: "pms-channex-management.v1", channels: [] };
    mocks.get.mockResolvedValue(snapshot);
    await expect(channexService.getSnapshot()).resolves.toBe(snapshot);
    expect(mocks.get).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/channex",
      expect.anything(),
    );
  });

  it.each([
    ["enable", channexService.enable],
    ["disable", channexService.disable],
    ["provision", channexService.provision],
    ["sync_ari", channexService.syncAri],
    ["sync_bookings", channexService.syncBookings],
    ["install_messaging", channexService.installMessagingApp],
  ] as const)("queues %s through the target command route", async (operationType, action) => {
    mocks.post.mockResolvedValue({ operationId: "operation-1" });
    await action();
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/channex/commands",
      expect.objectContaining({ operationType, commandId: expect.any(String) }),
      expect.anything(),
    );
  });

  it("converts UI markup percentages to the target contract", async () => {
    mocks.put.mockResolvedValue({ operationId: "operation-1" });
    await channexService.updateMarkups([{ channel: "airbnb", markupPct: 12.5 }]);
    expect(mocks.put).toHaveBeenCalledWith(
      "/api/pms/properties/property-1/channex/markups",
      expect.objectContaining({ markups: [{ channel: "airbnb", markupPercent: 12.5 }] }),
      expect.anything(),
    );
  });
});
