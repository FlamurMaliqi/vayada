import { createHash } from "node:crypto";
import type { PublicBookabilityOffer } from "@vayada/domain-distribution";
import type { findTargetRoomCombinationOffers } from "./bookingRoomCombinationOffers.js";
import { objectValue } from "./bookingWebPublic.js";

type Combination = Awaited<ReturnType<typeof findTargetRoomCombinationOffers>>["options"][number];

/** The public option ID binds identifiers and allocations, never a first-room fallback. */
export function publicRoomCombinationOffer(quote: Combination, bookingBaseUrl: string): PublicBookabilityOffer {
  const offerId = `selection-${createHash("sha256").update(JSON.stringify(quote.selection)).digest("hex").slice(0, 24)}`;
  const roomLines = quote.lines.map((line) => ({
    roomTypeId: line.roomTypeId, publicOfferKey: line.publicOfferKey, guests: line.guests,
    roomName: String(objectValue(line.offer.roomSummary)["name"] ?? line.roomTypeId),
    roomCount: line.guests.length, ratePlanId: line.offer.ratePlanId,
    rateSummary: objectValue(line.offer.rateSummary), policy: objectValue(line.offer.publicPolicy),
    totals: { ...line.totals, currency: quote.currency },
  }));
  const url = new URL(bookingBaseUrl);
  url.searchParams.set("room", offerId);
  url.searchParams.set("rooms", String(quote.party.rooms));
  return {
    offerId, roomTypeId: quote.lines[0]!.roomTypeId, ratePlanId: null,
    roomSelection: quote.selection, roomLines, expiresAt: quote.expiresAt,
    name: roomLines.map((line) => `${line.roomCount} × ${line.roomName}`).join(" + "),
    occupancy: { maxAdults: quote.party.adults, maxChildren: quote.party.children },
    availableRooms: quote.party.rooms,
    refundable: roomLines.every((line) => line.rateSummary["refundable"] === true),
    amenities: [],
    paymentOptions: quote.paymentOptions.filter((method): method is PublicBookabilityOffer["paymentOptions"][number] =>
      ["card", "pay_at_property", "bank_transfer", "paypal"].includes(method)),
    totals: {
      currency: quote.currency, roomTotal: Number(quote.totals.roomTotal),
      taxesAndFees: Number(quote.totals.taxesAndFees),
      discounts: Number(quote.totals.discounts) + Number(quote.totals.promotionDiscount),
      grandTotal: Number(quote.totals.totalAmount),
    },
    policies: {}, bookingUrl: url.toString(),
  };
}
