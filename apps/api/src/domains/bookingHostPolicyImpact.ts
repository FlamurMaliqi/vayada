import { projectBookingRoomSelection } from "./bookingRoomSelectionProjection.js";
import { parseBookingFlexibleCancellationTerms } from "@vayada/domain-booking";

export type SingleHostPolicyImpact = {
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
): SingleHostPolicyImpact | null {
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

export type HostPolicyImpact =
  | SingleHostPolicyImpact
  | {
      type: "mixed_room";
      previousDeadline: null;
      newDeadline: null;
      timezone: string;
      lines: (SingleHostPolicyImpact & {
        roomTypeId: string;
        roomName: string;
        roomCount: number;
      })[];
    };

export function hostSelectionPolicyImpact(
  offer: Record<string, unknown>,
  checkIn: string,
  newCheckIn: string,
  timezone: string,
): HostPolicyImpact | null {
  const lines = projectBookingRoomSelection(offer).roomLines;
  if (!lines) return null;
  const impacts = [];
  for (const line of lines) {
    const impact = hostPolicyImpact(line.policy, line.rateSummary, checkIn, newCheckIn, timezone);
    if (!impact) return null;
    impacts.push({
      ...impact,
      roomTypeId: line.roomTypeId,
      roomName: line.roomName,
      roomCount: line.roomCount,
    });
  }
  return {
    type: "mixed_room",
    previousDeadline: null,
    newDeadline: null,
    timezone,
    lines: impacts,
  };
}

/** Host date changes preserve each booked policy, while refreshing its dated price. */
export function retainHostRoomPolicies(
  original: Record<string, unknown>,
  updated: Record<string, unknown>,
) {
  const previous = projectBookingRoomSelection(original).roomLines;
  if (!previous) return updated;
  const next = projectBookingRoomSelection(updated).roomLines;
  if (
    !next ||
    previous.length !== next.length ||
    previous.some(
      (line, index) =>
        line.roomTypeId !== next[index]!.roomTypeId ||
        line.publicOfferKey !== next[index]!.publicOfferKey ||
        JSON.stringify(line.guests) !== JSON.stringify(next[index]!.guests),
    )
  )
    throw new Error("Host date changes must retain the complete room selection.");
  const roomLines = (updated["roomLines"] as Record<string, unknown>[]).map((line, index) => ({
    ...line, totals: line["totals"],
    offer: { ...(line["offer"] as Record<string, unknown>),
      publicPolicy: previous[index]!.policy, rateSummary: previous[index]!.rateSummary },
  }));
  const publicPolicy = { type: "mixed_room", lines: roomLines.map((line, index) => ({
    roomTypeId: previous[index]!.roomTypeId, publicOfferKey: previous[index]!.publicOfferKey,
    roomCount: previous[index]!.roomCount, policy: previous[index]!.policy,
    rateSummary: previous[index]!.rateSummary, totals: line["totals"],
  })) };
  return { ...updated, roomLines, publicPolicy };
}
