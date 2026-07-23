import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "./client";
import {
  publicationReadinessError,
  publishPublicBookabilityProfile,
} from "./publicBookabilityPublicationClient";

describe("publishPublicBookabilityProfile", () => {
  it("publishes the selected Booking hotel without a legacy hotel header", async () => {
    const response = {
      propertyId: "property_1",
      canonicalSlug: "hotel-alpenrose",
      canonicalUrl: "https://hotel-alpenrose.booking.localhost/de",
      bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
      profileStatus: "public" as const,
      freshnessStatus: "unavailable" as const,
      missingReadiness: ["availability"],
    };
    const post = vi.fn(async () => response);
    const client = { post } as unknown as Pick<ApiClient, "post">;

    await expect(
      publishPublicBookabilityProfile(" booking/hotel 1 ", client),
    ).resolves.toMatchObject({ canonicalSlug: "hotel-alpenrose" });
    expect(post).toHaveBeenCalledWith(
      "/api/booking/hotels/booking%2Fhotel%201/public-bookability",
      undefined,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it("maps the backend readiness keys to concrete hotel-owner actions", () => {
    expect(
      publicationReadinessError({
        propertyId: "property_1",
        canonicalSlug: "hotel-alpenrose",
        canonicalUrl: "https://hotel-alpenrose.booking.localhost/de",
        bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
        profileStatus: "incomplete",
        freshnessStatus: "unavailable",
        missingReadiness: [
          "availability_source",
          "sellable_availability",
          "payment_method",
          "booking_settings",
          "default_currency",
          "freshness",
          "profile",
        ],
      }),
    ).toBe(
      "Your Booking settings were saved, but the booking page is not ready to go live. Please connect and configure the property's availability source in PMS, add future room inventory and rates in PMS, choose a usable payment method and finish its setup, complete the required Booking settings, set the property's default booking currency, refresh the PMS availability data, and complete the public hotel profile and Brand & Media details, then try again.",
    );
  });

  it("accepts only a public, fresh, fully ready publication", () => {
    expect(
      publicationReadinessError({
        propertyId: "property_1",
        canonicalSlug: "hotel-alpenrose",
        canonicalUrl: "https://hotel-alpenrose.booking.localhost/de",
        bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
        profileStatus: "public",
        freshnessStatus: "fresh",
        missingReadiness: [],
      }),
    ).toBeNull();
  });
});
