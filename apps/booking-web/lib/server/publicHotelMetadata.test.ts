import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, cache: <T extends (...args: never[]) => unknown>(fn: T) => fn };
});

import { toPublicHotelMetadata, type PublicHotelProfileResponse } from "./publicHotelMetadata";

describe("toPublicHotelMetadata", () => {
  it("keeps the branding hero separate from gallery images", () => {
    const metadata = toPublicHotelMetadata(profile(["gallery-1.webp", "gallery-2.webp"]));

    expect(metadata.heroImage).toBe("hero.webp");
    expect(metadata.images).toEqual(["gallery-1.webp", "gallery-2.webp"]);
  });

  it("keeps the branding hero when the gallery is empty", () => {
    const metadata = toPublicHotelMetadata(profile([]));

    expect(metadata.heroImage).toBe("hero.webp");
    expect(metadata.images).toEqual([]);
  });
});

function profile(images: string[]): PublicHotelProfileResponse {
  return {
    hotel: {
      slug: "hotel-alpenrose",
      name: "Hotel Alpenrose",
      canonicalUrl: "https://booking.vayada.com/hotel-alpenrose",
      bookingBaseUrl: "https://booking.vayada.com/hotel-alpenrose",
      customDomainUrl: null,
      location: { country: "DE", city: "Berlin" },
      branding: { heroImage: "hero.webp" },
      images: images.map((url) => ({ url })),
      policies: { checkInFrom: "15:00", checkOutUntil: "11:00" },
      supportedLocales: ["en", "de"],
    },
  };
}
