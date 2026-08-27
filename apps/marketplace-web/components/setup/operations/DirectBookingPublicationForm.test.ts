import { describe, expect, it } from "vitest";

import {
  DIRECT_BOOKING_SUBTEXT_MAX_LENGTH,
  defaultDirectBookingSubtext,
  directBookingSubtextError,
} from "@/services/api/hotelOperationsSetupClient";

describe("direct-booking design defaults", () => {
  it("uses the property name for the resettable default subtext", () => {
    expect(defaultDirectBookingSubtext("Hotel One")).toBe(
      "Book direct for a memorable stay at Hotel One.",
    );
    expect(defaultDirectBookingSubtext("  ")).toBe(
      "Book direct for a memorable stay at your property.",
    );
    expect(defaultDirectBookingSubtext("H".repeat(300))).toHaveLength(
      DIRECT_BOOKING_SUBTEXT_MAX_LENGTH,
    );
  });

  it("blocks hydrated subtext that exceeds the editor limit", () => {
    expect(directBookingSubtextError("H".repeat(DIRECT_BOOKING_SUBTEXT_MAX_LENGTH))).toBeNull();
    expect(directBookingSubtextError("H".repeat(DIRECT_BOOKING_SUBTEXT_MAX_LENGTH + 1))).toBe(
      "Keep the booking page subtext within 200 characters.",
    );
  });
});
