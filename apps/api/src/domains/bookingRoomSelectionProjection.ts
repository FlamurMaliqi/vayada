import { parseBookingRoomSelection } from "@vayada/domain-booking";

/** Booking-owned public projection: never forward internal availability/freshness evidence. */
export function projectBookingRoomSelection(value: unknown) {
  const snapshot = record(value);
  if (snapshot["roomSelection"] === undefined) return {};
  const roomSelection = parseBookingRoomSelection(snapshot["roomSelection"]);
  const saved = snapshot["roomLines"];
  if (!roomSelection || !Array.isArray(saved) || saved.length !== roomSelection.lines.length)
    throw new Error("Booking room selection evidence is unavailable.");
  return {
    roomSelection,
    roomLines: roomSelection.lines.map((line, index) => {
      const source = record(saved[index]);
      if (
        source["roomTypeId"] !== line.roomTypeId ||
        source["publicOfferKey"] !== line.publicOfferKey
      )
        throw new Error("Booking room selection evidence does not match.");
      const offer = record(source["offer"]);
      return {
        ...line,
        roomCount: line.guests.length,
        roomName: String(record(offer["roomSummary"])["name"] ?? line.roomTypeId),
        ratePlanId: offer["ratePlanId"],
        rateSummary: record(offer["rateSummary"]),
        policy: record(offer["publicPolicy"]),
        totals: record(source["totals"]),
      };
    }),
  };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
