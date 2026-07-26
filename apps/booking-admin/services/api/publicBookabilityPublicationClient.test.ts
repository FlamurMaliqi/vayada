import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "./client";
import {
  isPublicBookabilityReady,
  publicationReadinessSteps,
  publishPublicBookabilityProfile,
} from "./publicBookabilityPublicationClient";

const readyPublication = {
  propertyId: "property_1",
  canonicalSlug: "hotel-alpenrose",
  canonicalUrl: "https://hotel-alpenrose.booking.localhost/de",
  bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
  profileStatus: "public" as const,
  freshnessStatus: "fresh" as const,
  missingReadiness: [],
};

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

  it("accepts only a public, fresh, fully ready publication", () => {
    expect(isPublicBookabilityReady(readyPublication)).toBe(true);
    expect(
      isPublicBookabilityReady({
        ...readyPublication,
        freshnessStatus: "stale",
      }),
    ).toBe(false);
    expect(
      isPublicBookabilityReady({
        ...readyPublication,
        missingReadiness: ["availability"],
      }),
    ).toBe(false);
  });

  it("falls back to reviewing Booking settings for an unmapped readiness blocker", () => {
    expect(
      publicationReadinessSteps({
        ...readyPublication,
        missingReadiness: ["unexpected_readiness"],
      }),
    ).toEqual([
      {
        id: "booking",
        label: "Review the remaining Booking settings",
      },
    ]);
  });

  it("groups publication blockers into clear next steps", () => {
    expect(
      publicationReadinessSteps({
        propertyId: "property_1",
        canonicalSlug: "hotel-alpenrose",
        canonicalUrl: "https://hotel-alpenrose.booking.localhost/de",
        bookingBaseUrl: "https://hotel-alpenrose.booking.localhost",
        profileStatus: "incomplete",
        freshnessStatus: "unavailable",
        missingReadiness: [
          "availability_source",
          "sellable_availability",
          "freshness",
          "payment_method",
          "profile",
        ],
      }),
    ).toEqual([
      expect.objectContaining({ id: "pms" }),
      expect.objectContaining({ id: "payments" }),
      expect.objectContaining({ id: "profile" }),
    ]);
  });
});
