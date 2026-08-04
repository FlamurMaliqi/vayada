import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";

const propertyId = "123e4567-e89b-42d3-a456-426614174000";

describe("adaptive property setup production mounts", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("registers every canonical protected route without invoking an owner port before auth", async () => {
    const ownerPort = vi.fn();
    const close = vi.fn(async () => undefined);
    app = buildApp({
      logger: false,
      hotelSetupTrackCommandRepository: { getTrackStatus: ownerPort } as never,
      propertySetupRouteStateReadPort: { getPropertySetupRouteState: ownerPort },
      hotelCatalogStep1: {
        repository: { getState: ownerPort, close } as never,
        mediaCommands: { replacePresentation: ownerPort } as never,
      },
      marketplaceHotelCollaborationPreferences: {
        commandPort: { replaceHotelCollaborationPreferences: ownerPort },
        readPort: { getHotelCollaborationPreferences: ownerPort },
      },
      bookingDesign: {
        commandPort: { upsertDesign: ownerPort },
        readPort: { getCurrentDesign: ownerPort },
      },
      bookingDesignReadiness: {
        readinessPort: { getBookingDesignReadiness: ownerPort },
      },
    });

    for (const url of [
      `/api/hotel-setup/properties/${propertyId}/route`,
      `/api/hotel-setup/properties/${propertyId}/steps/present-hotel`,
      `/api/marketplace/properties/${propertyId}/hotel-collaboration-preferences`,
      `/api/booking/properties/${propertyId}/booking-design`,
      `/api/booking/properties/${propertyId}/booking-design/readiness`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
    expect(ownerPort).not.toHaveBeenCalled();
  });
});
