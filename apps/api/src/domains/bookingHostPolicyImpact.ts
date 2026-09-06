import { parseBookingFlexibleCancellationTerms } from "@vayada/domain-booking";

export type HostPolicyImpact = {
  type: "non_refundable" | "flexible";
  previousDeadline: string | null;
  newDeadline: string | null;
  timezone: string;
  afterDeadlinePenalty: "full_booking_amount";
  noShowPenalty: "full_booking_amount";
};
export function hostPolicyImpact(
  policy: Record<string, unknown>,
  rate: Record<string, unknown>,
  checkIn: string,
  newCheckIn: string,
  timezone: string,
): HostPolicyImpact | null {
  const nonRefundable =
    ["non_refundable", "nonrefundable", "nrf"].includes(String(rate["rateType"])) ||
    rate["refundable"] === false;
  if (nonRefundable)
    return {
      type: "non_refundable",
      previousDeadline: null,
      newDeadline: null,
      timezone,
      afterDeadlinePenalty: "full_booking_amount",
      noShowPenalty: "full_booking_amount",
    };
  // Select canonical policy fields: snapshots may also contain descriptive copy.
  const terms = parseBookingFlexibleCancellationTerms(
    Object.fromEntries(
      [
        "type",
        "freeCancellationDeadlineDays",
        "afterDeadlinePenalty",
        "noShowPenalty",
        "flexibleCancellationType",
        "partialRefundTiers",
        "partialRefundCancelWindowDays",
        "partialRefundAmountPercent",
      ]
        .filter((key) => key in policy)
        .map((key) => [key, policy[key]]),
    ),
  );
  if (!terms || terms.flexibleCancellationType === "partial_refund") return null;
  const deadline = (date: string) =>
    new Date(Date.parse(`${date}T00:00:00Z`) - terms.freeCancellationDeadlineDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
  return {
    type: "flexible",
    previousDeadline: deadline(checkIn),
    newDeadline: deadline(newCheckIn),
    timezone,
    afterDeadlinePenalty: terms.afterDeadlinePenalty,
    noShowPenalty: terms.noShowPenalty,
  };
}
