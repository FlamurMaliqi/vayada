import { afterEach, describe, expect, it, vi } from "vitest";

const pmsOperationsClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));
const resolvePropertyMock = vi.hoisted(() => vi.fn());

vi.mock("./pmsOperationsClient", () => ({
  pmsOperationsClient: pmsOperationsClientMock,
  pmsOperationsRequestOptions: {
    headers: { "X-Vayada-Omit-Hotel-Context": "true" },
    cache: "no-store",
  },
}));

vi.mock("./pmsPropertyClient", () => ({
  resolveSelectedPmsPropertyId: resolvePropertyMock,
}));

describe("moduleActivationClient", () => {
  afterEach(() => {
    vi.resetModules();
    pmsOperationsClientMock.get.mockReset();
    pmsOperationsClientMock.patch.mockReset();
    resolvePropertyMock.mockReset();
  });

  it("lists and updates activations through the canonical property-scoped route", async () => {
    resolvePropertyMock.mockResolvedValue("pms_property_alpenrose");
    pmsOperationsClientMock.get.mockResolvedValue({
      hotelId: "pms_property_alpenrose",
      canManage: true,
      supportedModules: ["affiliates"],
      activeModules: ["affiliates"],
      activations: [],
    });
    pmsOperationsClientMock.patch.mockResolvedValue({
      moduleId: "affiliates",
      isActive: true,
      activatedAt: "2026-08-24T00:00:00.000Z",
      deactivatedAt: null,
      updatedAt: "2026-08-24T00:00:00.000Z",
    });

    const { moduleActivationClient } = await import("./moduleActivationClient");

    await expect(moduleActivationClient.list()).resolves.toMatchObject({
      hotelId: "pms_property_alpenrose",
      supportedModules: ["affiliates"],
      activeModules: ["affiliates"],
    });
    await expect(moduleActivationClient.update("affiliates", true)).resolves.toMatchObject({
      moduleId: "affiliates",
      isActive: true,
    });

    expect(resolvePropertyMock).toHaveBeenNthCalledWith(1, "loading module activations");
    expect(resolvePropertyMock).toHaveBeenNthCalledWith(2, "updating module activations");
    expect(pmsOperationsClientMock.get).toHaveBeenCalledWith(
      "/api/pms/properties/pms_property_alpenrose/module-activations",
      {
        headers: { "X-Vayada-Omit-Hotel-Context": "true" },
        cache: "no-store",
      },
    );
    expect(pmsOperationsClientMock.patch).toHaveBeenCalledWith(
      "/api/pms/properties/pms_property_alpenrose/module-activations/affiliates",
      { moduleId: "affiliates", isActive: true },
      {
        headers: { "X-Vayada-Omit-Hotel-Context": "true" },
        cache: "no-store",
      },
    );
  });
});
