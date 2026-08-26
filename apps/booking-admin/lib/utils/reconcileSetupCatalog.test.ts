import { describe, expect, it, vi } from "vitest";

import type { BookingAddonItem } from "@/services/api/bookingAddonItemsClient";
import type { BookingPromoCode } from "@/services/api/bookingPromoCodesClient";
import { reconcileSetupAddons, reconcileSetupPromoCodes } from "./reconcileSetupCatalog";

const hotelId = "booking-hotel-1";

describe("reconcileSetupAddons", () => {
  it("updates a previously created add-on and creates only the missing one on retry", async () => {
    const existing = { addonItemId: "addon-1", name: "Breakfast" } as BookingAddonItem;
    const client = {
      list: vi.fn().mockResolvedValue([existing]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
    const breakfast = {
      name: "Breakfast",
      description: "Daily breakfast",
      price: "20.00",
      currency: "EUR",
      category: "dining" as const,
      pricingModel: "per_guest_night" as const,
      publicVisible: true,
      status: "active" as const,
      sortOrder: 0,
    };
    const transfer = {
      ...breakfast,
      name: "Airport transfer",
      category: "transport" as const,
      pricingModel: "per_stay" as const,
      sortOrder: 1,
    };

    await reconcileSetupAddons({ hotelId, addons: [breakfast, transfer] }, client);

    expect(client.update).toHaveBeenCalledWith({
      hotelId,
      addonItemId: "addon-1",
      body: breakfast,
    });
    expect(client.create).toHaveBeenCalledOnce();
    expect(client.create).toHaveBeenCalledWith({ hotelId, body: transfer });
  });
});

describe("reconcileSetupPromoCodes", () => {
  it("updates an existing code case-insensitively instead of posting a duplicate", async () => {
    const existing = { promoCodeId: "promo-1", code: "WELCOME" } as BookingPromoCode;
    const client = {
      list: vi.fn().mockResolvedValue([existing]),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
    const promoCode = {
      code: "welcome",
      discountType: "percentage" as const,
      discountValue: "10.00",
      validFrom: null,
      validUntil: null,
      isActive: true,
      maxUses: 999,
    };

    const failures = await reconcileSetupPromoCodes({ hotelId, promoCodes: [promoCode] }, client);

    expect(failures).toEqual([]);
    expect(client.create).not.toHaveBeenCalled();
    expect(client.update).toHaveBeenCalledWith({
      hotelId,
      promoCodeId: "promo-1",
      body: promoCode,
    });
  });

  it("does not risk duplicate posts when the current catalog cannot be read", async () => {
    const client = {
      list: vi.fn().mockRejectedValue(new Error("offline")),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
    const promoCode = {
      code: "WELCOME",
      discountType: "fixed" as const,
      discountValue: "20.00",
      validFrom: null,
      validUntil: null,
      isActive: true,
      maxUses: 999,
    };

    await expect(
      reconcileSetupPromoCodes({ hotelId, promoCodes: [promoCode] }, client),
    ).resolves.toEqual(["WELCOME"]);
    expect(client.create).not.toHaveBeenCalled();
  });
});
