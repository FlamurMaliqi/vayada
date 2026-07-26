import { describe, expect, it } from "vitest";

import { isBookingActivationBrandingReady } from "./bookingActivationBranding";

const readyBranding = {
  heroImage: "https://cdn.vayada.test/hotel/hero.jpg",
  heroHeading: "Welcome to Hotel Alpenrose",
  heroSubtext: "A quiet stay in the mountains.",
  primaryColor: "#2563EB",
  selectedFont: "modern-minimalist",
  supportedFontPairings: ["modern-minimalist", "grand-classic"],
  uploading: false,
};

describe("isBookingActivationBrandingReady", () => {
  it("requires public profile copy and media before Booking activation can continue", () => {
    expect(isBookingActivationBrandingReady(readyBranding)).toBe(true);
    expect(isBookingActivationBrandingReady({ ...readyBranding, heroImage: " " })).toBe(false);
    expect(isBookingActivationBrandingReady({ ...readyBranding, heroHeading: " " })).toBe(false);
    expect(isBookingActivationBrandingReady({ ...readyBranding, heroSubtext: " " })).toBe(false);
  });

  it("also keeps the existing upload, color, and font guards", () => {
    expect(isBookingActivationBrandingReady({ ...readyBranding, uploading: true })).toBe(false);
    expect(isBookingActivationBrandingReady({ ...readyBranding, primaryColor: "blue" })).toBe(
      false,
    );
    expect(isBookingActivationBrandingReady({ ...readyBranding, selectedFont: "unknown" })).toBe(
      false,
    );
  });
});
