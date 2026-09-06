import { describe, expect, it } from "vitest";
import { hostPolicyImpact } from "./bookingHostPolicyImpact.js";

describe("host date policy impact", () => {
  const impact = (policy: Record<string, unknown>, rate = {}) =>
    hostPolicyImpact(policy, rate, "2026-10-03", "2026-10-05", "Europe/Berlin");
  it("shifts the frozen deadline across month boundaries and preserves timezone", () => {
    expect(
      impact({
        type: "free_until_days_before_arrival",
        freeCancellationDeadlineDays: 7,
        afterDeadlinePenalty: "full_booking_amount",
        noShowPenalty: "full_booking_amount",
        description: "Frozen terms",
      }),
    ).toMatchObject({
      previousDeadline: "2026-09-26",
      newDeadline: "2026-09-28",
      timezone: "Europe/Berlin",
    });
  });
  it("retains nonrefundable terms without inventing a deadline", () => {
    expect(impact({}, { rateType: "non_refundable" })).toMatchObject({
      type: "non_refundable",
      previousDeadline: null,
      newDeadline: null,
    });
  });
  it("does not guess missing policy terms", () => {
    expect(impact({})).toBeNull();
  });
});
