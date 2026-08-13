import { describe, expect, it } from "vitest";

import {
  acceptanceModeForLegacyHotel,
  addDays,
  bookingBrandingSettingsForLegacyHotel,
  bookingBaseUrlFor,
  firstDayOfUtcMonth,
  normalizeLegacyBookingFontPairing,
  normalizeLegacyBookingPrimaryColor,
  normalizeTimezone,
  occupancyForLegacyRoom,
} from "./bookingPublicBookabilityBackfill.js";

describe("booking public bookability backfill helpers", () => {
  it("normalizes the pilot date and URL fields used by the target constraints", () => {
    expect(firstDayOfUtcMonth(new Date("2026-06-20T14:00:00Z"))).toBe("2026-06-01");
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(normalizeTimezone("UTC")).toBe("Etc/UTC");
    expect(bookingBaseUrlFor("srijourneys", "https://next-booking.vayada.com")).toBe(
      "https://srijourneys.next-booking.vayada.com",
    );
    expect(occupancyForLegacyRoom({ maxOccupancy: 2, maxChildren: null })).toEqual({
      maxAdults: 2,
      maxOccupancy: 2,
    });
    expect(occupancyForLegacyRoom({ maxAdults: 3, maxChildren: null })).toEqual({
      maxAdults: 3,
      maxOccupancy: 3,
    });
  });

  it("preserves legacy branding without duplicating canonical hotel content", () => {
    expect(
      bookingBrandingSettingsForLegacyHotel({
        name: "Shared hotel name",
        description: "Shared hotel description",
        hero_image: "https://cdn.example.test/shared-hero.jpg",
        branding: {
          primaryColor: "#0f766e",
          fontPairing: "Inter / Merriweather",
        },
      }),
    ).toEqual({
      primaryColor: "#0F766E",
      fontPairing: "modern-minimalist",
    });
  });

  it("falls back for unsupported legacy branding", () => {
    expect(
      bookingBrandingSettingsForLegacyHotel({
        branding_primary_color: "not-a-color",
        branding_font_pairing: "Papyrus",
      }),
    ).toEqual({
      primaryColor: "#4F46E5",
      fontPairing: "high-end-serif",
    });
    expect(normalizeLegacyBookingPrimaryColor(" #336699 ")).toBe("#336699");
    expect(normalizeLegacyBookingFontPairing("Cormorant Garamond + Lato")).toBe("grand-classic");
  });

  it("preserves explicit legacy acceptance while keeping target-only rows instant", () => {
    expect(acceptanceModeForLegacyHotel({ instant_book: true })).toBe("instant");
    expect(acceptanceModeForLegacyHotel({ instant_book: false })).toBe("request");
    expect(acceptanceModeForLegacyHotel({})).toBe("instant");
  });
});
