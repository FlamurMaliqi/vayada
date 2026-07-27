import { describe, expect, it } from "vitest";

import { shouldCollectDirectBookingDescription } from "./DirectBookingPublicationForm";

describe("direct-booking public description", () => {
  it("reuses the canonical description when both onboarding tracks are selected", () => {
    expect(shouldCollectDirectBookingDescription(["hotel_operations", "creator_marketplace"])).toBe(
      false,
    );
  });

  it("collects the minimum canonical description for Operations-only onboarding", () => {
    expect(shouldCollectDirectBookingDescription(["hotel_operations"])).toBe(true);
  });
});
