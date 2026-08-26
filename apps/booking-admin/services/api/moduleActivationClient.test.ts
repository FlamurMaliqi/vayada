import { afterEach, describe, expect, it, vi } from "vitest";

const apiClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

const propertyLinkMock = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  apiClient: apiClientMock,
  omitHotelContext: { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
}));

vi.mock("./bookingHotelScope", () => ({
  getSelectedBookingHotelId: () => "booking_hotel_alpenrose",
}));

vi.mock("./bookingPropertyLinkClient", () => ({
  getBookingHotelPropertyLink: propertyLinkMock,
}));

describe("moduleActivationClient", () => {
  afterEach(() => {
    vi.resetModules();
    apiClientMock.get.mockReset();
    apiClientMock.patch.mockReset();
    propertyLinkMock.mockReset();
  });

  it("lists and updates module activations through the target PMS route", async () => {
    propertyLinkMock.mockResolvedValue({ propertyId: "pms_property_alpenrose" });
    apiClientMock.get.mockResolvedValue({
      hotelId: "pms_property_alpenrose",
      canManage: true,
      supportedModules: ["affiliates"],
      activeModules: ["affiliates"],
      activations: [],
    });
    apiClientMock.patch.mockResolvedValue({
      moduleId: "affiliates",
      isActive: true,
      activatedAt: null,
      deactivatedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const { moduleActivationClient } = await import("./moduleActivationClient");

    await expect(moduleActivationClient.list()).resolves.toMatchObject({
      hotelId: "pms_property_alpenrose",
      supportedModules: ["affiliates"],
    });
    await expect(moduleActivationClient.update("affiliates", true)).resolves.toMatchObject({
      moduleId: "affiliates",
      isActive: true,
    });

    expect(propertyLinkMock).toHaveBeenCalledWith({ hotelId: "booking_hotel_alpenrose" });
    expect(apiClientMock.get).toHaveBeenCalledWith(
      "/api/pms/properties/pms_property_alpenrose/module-activations",
      { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
    );
    expect(apiClientMock.patch).toHaveBeenCalledWith(
      "/api/pms/properties/pms_property_alpenrose/module-activations/affiliates",
      { moduleId: "affiliates", isActive: true },
      { headers: { "X-Vayada-Omit-Hotel-Context": "true" } },
    );
  });
});
