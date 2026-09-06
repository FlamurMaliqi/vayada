import { describe, expect, it } from "vitest";
import { hostPolicyImpact, hostSelectionPolicyImpact, retainHostRoomPolicies } from "./bookingHostPolicyImpact.js";

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
  it("preserves each booked room's terms and previews distinct deadlines", () => {
    const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
    const lines = ids.map((roomTypeId) => ({ roomTypeId, publicOfferKey: roomTypeId, guests: [{ adults: 2, children: 0 }] }));
    const original = { roomSelection: { contractVersion: "booking-room-selection.v1", lines },
      roomLines: lines.map((line, index) => ({ ...line, offer: { roomSummary: { name: `Room ${index + 1}` },
        rateSummary: { refundable: true }, publicPolicy: { type: "free_until_days_before_arrival",
          freeCancellationDeadlineDays: index ? 7 : 3, afterDeadlinePenalty: "full_booking_amount", noShowPenalty: "full_booking_amount" } }, totals: { totalAmount: "100.00" } })) };
    expect(hostSelectionPolicyImpact(original, "2026-10-03", "2026-10-05", "Europe/Berlin"))
      .toMatchObject({ type: "mixed_room", lines: [
        { roomName: "Room 1", previousDeadline: "2026-09-30", newDeadline: "2026-10-02" },
        { roomName: "Room 2", previousDeadline: "2026-09-26", newDeadline: "2026-09-28" },
      ] });
    const next = structuredClone(original);
    next.roomLines[1]!.offer.publicPolicy.freeCancellationDeadlineDays = 1;
    next.roomLines[1]!.totals.totalAmount = "150.00";
    const preserved = retainHostRoomPolicies(original, next) as typeof next;
    expect(preserved.roomLines[1]!.offer.publicPolicy.freeCancellationDeadlineDays).toBe(7);
    expect(preserved.roomLines[1]!.totals.totalAmount).toBe("150.00");
    next.roomSelection.lines.pop();
    next.roomLines.pop();
    expect(() => retainHostRoomPolicies(original, next)).toThrow("complete room selection");
  });

});
